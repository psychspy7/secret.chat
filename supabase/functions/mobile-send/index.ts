import { preflight, body, identify, rpc, broadcast, uuid, json, errorResponse } from '../_shared/mobile.ts';
Deno.serve(async (req: Request) => {
  const response = preflight(req); if (response) return response;
  try {
    const { authorization } = await identify(req);
    const input = await body(req);
    const roomId = uuid(input.room_id);
    const envelope = await rpc('mobile_send_message', {
      p_room_id: roomId, p_message_id: uuid(input.message_id), p_payload: input.payload,
    }, authorization);
    // REST Broadcast is ephemeral. Using realtime.send for chats would archive
    // encrypted payloads in realtime.messages for three days, so do not use it.
    await broadcast(roomId, envelope);
    return json(req, envelope);
  } catch (error) { return errorResponse(req, error); }
});
