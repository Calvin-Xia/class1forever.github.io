const encoder = new TextEncoder();

export const COOKIE_NAME = 'detail_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX_ATTEMPTS = 10;

function bytesToBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stringToBase64Url(value) {
    return bytesToBase64Url(encoder.encode(value));
}

function base64UrlToString(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return atob(padded);
}

function safeEqual(left, right) {
    const maxLength = Math.max(left.length, right.length);
    let mismatch = left.length === right.length ? 0 : 1;

    for (let index = 0; index < maxLength; index += 1) {
        const leftCode = index < left.length ? left.charCodeAt(index) : 0;
        const rightCode = index < right.length ? right.charCodeAt(index) : 0;
        mismatch |= leftCode ^ rightCode;
    }

    return mismatch === 0;
}

async function signValue(secret, value) {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
    return bytesToBase64Url(new Uint8Array(signature));
}

export function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) {
        return cookies;
    }

    for (const segment of cookieHeader.split(/;\s*/)) {
        const separatorIndex = segment.indexOf('=');
        if (separatorIndex <= 0) {
            continue;
        }

        const name = segment.slice(0, separatorIndex);
        const value = segment.slice(separatorIndex + 1);
        cookies[name] = value;
    }

    return cookies;
}

export async function createSessionToken(secret) {
    const payload = {
        exp: Date.now() + SESSION_TTL_MS
    };
    const encodedPayload = stringToBase64Url(JSON.stringify(payload));
    const signature = await signValue(secret, encodedPayload);
    return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(secret, token) {
    if (!token || !token.includes('.')) {
        return null;
    }

    const [encodedPayload, signature] = token.split('.');
    if (!encodedPayload || !signature) {
        return null;
    }

    const expectedSignature = await signValue(secret, encodedPayload);
    if (!safeEqual(signature, expectedSignature)) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(base64UrlToString(encodedPayload));
    } catch (_error) {
        return null;
    }

    if (!payload || typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
        return null;
    }

    return payload;
}

export async function hasValidSession(request, secret) {
    const cookies = parseCookies(request.headers.get('Cookie'));
    return Boolean(await verifySessionToken(secret, cookies[COOKIE_NAME]));
}

export function buildSessionCookie(token) {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function buildClearedSessionCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function getClientIp(request) {
    return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function getRateLimitKey(ipAddress) {
    const bucket = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
    return `auth:rate:${ipAddress}:${bucket}`;
}

export async function getRateLimitCount(env, request) {
    const key = getRateLimitKey(getClientIp(request));
    const count = await env.CLASS_MAP_DATA.get(key);
    return {
        key,
        count: Number.parseInt(count || '0', 10) || 0
    };
}

export async function recordFailedAttempt(env, request) {
    const { key, count } = await getRateLimitCount(env, request);
    await env.CLASS_MAP_DATA.put(key, String(count + 1), {
        expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
    });
}

export async function clearFailedAttempts(env, request) {
    const { key } = await getRateLimitCount(env, request);
    await env.CLASS_MAP_DATA.delete(key);
}

export function constantTimeCompare(left, right) {
    return safeEqual(String(left), String(right));
}
