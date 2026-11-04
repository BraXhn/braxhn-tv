// Ledig port för testservrar. En slumpad port (t.ex. 32000 + slump) kan redan vara upptagen: av en server från
// en annan testfil som inte hunnit stänga, av en annan körning på samma dator eller – över 32767 – av en utgående
// anslutning (Linux tilldelar dem portar i 32768–60999). Porten väljs därför under det intervallet och kontrolleras:
// både PORT och PORT+1 (testerna sätter HTTPS_PORT = PORT + 1) måste gå att binda. Samma port lämnas aldrig ut två
// gånger i samma process.
import net from 'node:net';

const given = new Set();
const canBind = (port) => new Promise((ok) => {
  const s = net.createServer();
  s.once('error', () => ok(false));
  // Samma adress som servern (alla gränssnitt, IPv6 med IPv4)
  s.listen(port, () => s.close(() => ok(true)));
});

/** Första porten i ett ledigt block om n portar (standard: PORT och PORT+1) */
export async function freePort(n = 2, lo = 20000, hi = 32700) {
  for (let i = 0; i < 500; i++) {
    const p = lo + Math.floor(Math.random() * (hi - lo - n));
    let ok = true;
    for (let k = 0; k < n && ok; k++) ok = !given.has(p + k) && await canBind(p + k);
    if (!ok) continue;
    for (let k = 0; k < n; k++) given.add(p + k);
    return p;
  }
  throw new Error('Hittade ingen ledig port för testservern');
}
