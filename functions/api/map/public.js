import { loadPublicDataset } from '../../_lib/data.mjs';
import { hasValidSession } from '../../_lib/auth.mjs';
import { errorResponse, jsonResponse } from '../../_lib/http.mjs';

export const onRequestGet = async ({ env, request }) => {
    try {
        const dataset = await loadPublicDataset(env);
        const detailAccess = env.DETAILS_SESSION_SECRET
            ? await hasValidSession(request, env.DETAILS_SESSION_SECRET)
            : false;

        return jsonResponse(
            {
                ...dataset,
                detailAccess,
                detailModeAvailable: Boolean(env.DETAILS_PASSPHRASE && env.DETAILS_SESSION_SECRET),
                detailsHint: env.DETAILS_HINT || ''
            },
            {
                headers: {
                    'Vary': 'Cookie'
                }
            }
        );
    } catch (error) {
        console.error('Failed to load public map dataset:', error);
        return errorResponse(
            503,
            'public_data_unavailable',
            '地图数据还没准备好，请稍后再试。'
        );
    }
};


