export function alertKey(type, event, roomId) {
  return type === 'room_join' ? `join:${roomId}:${event.actor_id || event.user_id}` : `${type}:${event.event_id || event.id}`;
}
export function acceptAlert(seen, type, event, roomId, now = Date.now()) {
  const key = alertKey(type, event, roomId), ttl = type === 'room_join' ? 90000 : 300000;
  if (!key || key.endsWith(':undefined') || now-(seen.get(key) || 0)<ttl) return false;
  seen.set(key, now);
  for (const [item, at] of seen) if (now-at>300000) seen.delete(item);
  // A bounded window prevents a busy room from growing memory indefinitely.
  while (seen.size>600) seen.delete(seen.keys().next().value);
  return true;
}
