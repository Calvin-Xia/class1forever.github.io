import { buildClearedSessionCookie } from '../../_lib/auth.mjs';
import { jsonResponse } from '../../_lib/http.mjs';

export const onRequestPost = async () => {
    return jsonResponse(
        {
            authenticated: false
        },
        {
            headers: {
                'Set-Cookie': buildClearedSessionCookie()
            }
        }
    );
};
