import {
    RATE_LIMIT_MAX_ATTEMPTS,
    buildSessionCookie,
    clearFailedAttempts,
    constantTimeCompare,
    createSessionToken,
    getRateLimitCount,
    recordFailedAttempt
} from '../../_lib/auth.mjs';
import { errorResponse, jsonResponse } from '../../_lib/http.mjs';

export const onRequestPost = async ({ env, request }) => {
    if (!env.DETAILS_PASSPHRASE || !env.DETAILS_SESSION_SECRET) {
        return errorResponse(503, 'detail_auth_not_configured', '暂时无法查看详情，请稍后再试。');
    }

    let body;
    try {
        body = await request.json();
    } catch (_error) {
        return errorResponse(400, 'invalid_request_body', '请求有误，请重试。');
    }

    const passphrase = typeof body?.passphrase === 'string' ? body.passphrase : '';
    if (!passphrase) {
        return errorResponse(400, 'passphrase_required', '请输入口令。');
    }

    const rateLimit = await getRateLimitCount(env, request);
    if (rateLimit.count >= RATE_LIMIT_MAX_ATTEMPTS) {
        return errorResponse(429, 'too_many_attempts', '尝试次数太多，请 15 分钟后再试。');
    }

    if (!constantTimeCompare(passphrase, env.DETAILS_PASSPHRASE)) {
        await recordFailedAttempt(env, request);
        return errorResponse(401, 'invalid_passphrase', '口令不对，请重试。', {
            remainingAttempts: Math.max(0, RATE_LIMIT_MAX_ATTEMPTS - rateLimit.count - 1)
        });
    }

    await clearFailedAttempts(env, request);
    const token = await createSessionToken(env.DETAILS_SESSION_SECRET);

    return jsonResponse(
        {
            authenticated: true
        },
        {
            headers: {
                'Set-Cookie': buildSessionCookie(token)
            }
        }
    );
};


