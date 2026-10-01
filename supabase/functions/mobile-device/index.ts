import { preflight, body, identify, rpc, serviceRpc, observedIp, pushConfigured, json, errorResponse } from '../_shared/mobile.ts';
Deno.serve(async (req: Request) => {
  const response = preflight(req); if (response) return response;
  try {
    const { userId, authorization } = await identify(req);
    const input = await body(req, 5000);
    // Rechecks the live session, identity, Google provider and disabled state.
    await rpc('mobile_profile', { p_display_name: null }, authorization);
    if (input.token != null && (typeof input.token !== 'string' || input.token.length < 20 || input.token.length > 4096)) throw new Error('Invalid device token.');
    const observation = observedIp(req);
    const result = await serviceRpc('mobile_edge_device', {
      p_user_id: userId, p_token: input.token ?? null, p_remove: input.remove === true,
      p_ip: observation.ip, p_ip_source: observation.source,
    });
    return json(req, { ...result, push_configured: pushConfigured() });
  } catch (error) { return errorResponse(req, error); }
});
