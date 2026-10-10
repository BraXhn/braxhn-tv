// Titta tillsammans: synkad uppspelning mellan flera tittare (även i olika hem).
// Varje tittare strömmar själv; servern synkar bara play/paus/position och en enkel chatt via Server-Sent Events.
import crypto from 'node:crypto';

const rooms = new Map();
const now = () => Date.now();

export function createRoom(user, itemId) {
  // Max 3 aktiva rum per användare
  const mine = [...rooms.values()].filter(r => r.host === user.id);
  if (mine.length >= 3) for (const r of mine.slice(0, mine.length - 2)) closeRoom(r.id);
  const id = crypto.randomBytes(9).toString('base64url');
  rooms.set(id, { id, host: user.id, hostName: user.name, itemId, created: now(), state: { playing: false, position: 0, at: now(), by: user.name },
    members: new Map(), clients: new Set(), chat: [], empty: now() });
  return id;
}
export const getRoom = (id) => rooms.get(String(id));

function info(r) {
  return { id: r.id, itemId: r.itemId, host: r.hostName, state: r.state,
    members: [...r.members.values()].map(m => ({ name: m.name, id: m.id })), chat: r.chat.slice(-30) };
}
function broadcast(r, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of r.clients) { try { c.res.write(msg); } catch {} }
}

export function subscribe(r, user, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const client = { res, user };
  r.clients.add(client);
  const m = r.members.get(user.id) || { id: user.id, name: user.name, conns: 0 };
  m.conns++; r.members.set(user.id, m);
  res.write(`event: hello\ndata: ${JSON.stringify(info(r))}\n\n`);
  broadcast(r, 'members', info(r).members);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(hb);
    r.clients.delete(client);
    m.conns--; if (m.conns <= 0) r.members.delete(user.id);
    if (!r.clients.size) r.empty = now();
    broadcast(r, 'members', info(r).members);
  });
}

export function setState(r, user, { playing, position, itemId }) {
  r.state = { playing: !!playing, position: Math.max(0, +position || 0), at: now(), by: user.name };
  if (itemId && +itemId !== r.itemId) { r.itemId = +itemId; broadcast(r, 'item', { itemId: r.itemId, by: user.name }); }
  broadcast(r, 'state', r.state);
}
export function chat(r, user, text) {
  const t = String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
  if (!t) return;
  const msg = { name: user.name, text: t, at: now() };
  r.chat.push(msg); if (r.chat.length > 100) r.chat.shift();
  broadcast(r, 'chat', msg);
}
export function closeRoom(id) {
  const r = rooms.get(id); if (!r) return;
  broadcast(r, 'closed', {});
  for (const c of r.clients) { try { c.res.end(); } catch {} }
  rooms.delete(id);
}
export const roomInfo = info;

// Tomma rum stängs efter 10 minuter, alla rum efter 12 timmar
setInterval(() => {
  for (const r of rooms.values()) if ((!r.clients.size && now() - r.empty > 600e3) || now() - r.created > 12 * 3600e3) closeRoom(r.id);
}, 60e3).unref();
