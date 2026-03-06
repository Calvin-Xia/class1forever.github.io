import { buildDetailsPayload } from '../../_lib/data.mjs';
import { hasValidSession } from '../../_lib/auth.mjs';
import { errorResponse, jsonResponse } from '../../_lib/http.mjs';

export const onRequestGet = async ({ env, request }) => {
    if (!env.DETAILS_SESSION_SECRET) {
        return errorResponse(503, 'detail_auth_not_configured', '暂时无法查看详情，请稍后再试。');
    }

    const detailAccess = await hasValidSession(request, env.DETAILS_SESSION_SECRET);
    if (!detailAccess) {
        return errorResponse(401, 'detail_auth_required', '请先输入口令。');
    }

    const url = new URL(request.url);
    const province = url.searchParams.get('province');
    const city = url.searchParams.get('city');

    if (!province) {
        return errorResponse(400, 'province_required', '缺少地区信息，请重新选择。');
    }

    try {
        const payload = await buildDetailsPayload(env, {
            province,
            city
        });

        return jsonResponse(payload);
    } catch (error) {
        console.error('Failed to load detail map data:', error);

        if (error instanceof TypeError || error instanceof Error) {
            return errorResponse(400, 'invalid_region_query', error.message);
        }

        return errorResponse(503, 'detail_data_unavailable', '这个地区暂时打不开，请稍后再试。');
    }
};


