export function jsonResponse(body, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json; charset=utf-8');
    }
    if (!headers.has('Cache-Control')) {
        headers.set('Cache-Control', 'no-store');
    }

    return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers
    });
}

export function errorResponse(status, code, message, extras = {}, init = {}) {
    return jsonResponse(
        {
            error: code,
            message,
            ...extras
        },
        {
            status,
            headers: init.headers
        }
    );
}
