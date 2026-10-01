import { preflight, body, identify, rpc, uuid, pushConfigured, json, errorResponse } from '../_shared/mobile.ts';
import { dispatchPresence } from '../_shared/push.ts';
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
Deno.serve(async (req: Request) => {
  const response = preflight(req); if (response) return response;
  try {
    const { userId, authorization } = await identify(req);
    const input = await body(req, 500);
    const roomId = uuid(input.room_id);
    const online = await rpc('mobile_heartbeat', { p_room_id: roomId }, authorization);
    EdgeRuntime.waitUntil(dispatchPresence(userId, roomId).catch(() => {
      // Operational signal only: no tokens, IPs, room IDs, names or message content.
      console.warn('mobile_presence_push_retry');
    }));
    return json(req, { online, push_configured: pushConfigured() });
  } catch (error) { return errorResponse(req, error); }
});
