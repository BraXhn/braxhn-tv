// Kön i reläets tunnel (server/relay.js). Tunneln är EN TCP-anslutning, och hemmets uppladdning är nästan alltid
// den smalaste länken. Allt som hemservern lämnat till anslutningen ligger i en enda kö (operativsystemets buffert,
// routern, nätet): ett litet svar (sidans JSON, ett omslag, en modul) kommer fram först när allt före det skickats.
// HTTP/2:s fönster (4 MB per ström) bestämmer bara hur mycket som FÅR ligga där, och med en film, en ljudbok eller
// hastighetsprovet i gång låg det upp till 4 MB före varje litet svar – 2–6 s på 10 Mbit/s (ärende #2).
//
// Här håller hemservern själv kön kort, utan att reläet behöver ändras (bara vanliga HTTP/2-PING):
//  - Varje svar får skicka en liten mängd direkt (FREE, påfylls i FREE_RATE): sidor, omslag, moduler och SSE går
//    alltid förbi.
//  - Resten (stora strömmar) skickas bara medan det som är på väg är mindre än `cap()`, och den som skickat minst
//    hittills går först. Det som väntar ligger kvar i hemservern, där ett nytt litet svar kan gå före.
//  - Vad som är på väg mäts med PING: TCP håller ordningen, så när svaret på en PING kommer har allt som skickats
//    före den kommit fram till reläet. Samma svar ger takten (det som kom fram per tidsenhet) och svarstiden.
//  - cap = takten × max(TARGET_MS, minsta svarstiden + EXTRA_MS): kön blir ungefär TARGET_MS lång, och en snabb
//    uppkoppling (där mer än så behövs för full fart) får större cap av sig själv – den växer med takten.
// Bara den tid ett litet svar väntar ändras; takten för stora strömmar blir densamma (testat i tunnelq.test.js).

export const FREE = 128 * 1024;     // byte som ett svar får skicka direkt …
export const FREE_RATE = 32 * 1024; // … påfyllt med så här många byte per sekund (SSE och små svar i en lång ström)
export const SLICE = 32 * 1024;     // stora strömmar skickas i bitar om högst så här mycket
export const FLOOR = 256 * 1024;    // minsta cap (innan takten är mätt, och på mycket långsamma uppkopplingar)
export const TARGET_MS = 200;
export const EXTRA_MS = 100;
const RATE_WINDOW = 1500;           // takten = största mätningen de senaste 1,5 s …
const RATE_SPAN = 100;              // … över minst 100 ms
const PING_EVERY = 8;               // en PING per åttondel av cap som skrivits …
const MAX_PINGS = 12;               // … och högst tolv obesvarade (relay.js tillåter 20; hjärtslaget använder en)
const STALE = 500;                  // en bit som inte lämnat Node på 0,5 s står still (klienten läser inte) och räknas inte
const STUCK = 1000;                 // inget PING-svar på 1 s: släpp en bit i taget i stället för att stå still

export class TunnelQueue {
  /** ping(cb): skicka en HTTP/2-PING, cb(err) när svaret kommer; false om den inte kunde skickas. now(): ms */
  constructor({ ping, now = () => performance.now() }) {
    this.ping = ping; this.now = now;
    this.sent = 0;            // byte som lämnat Node (skrivna till anslutningen)
    this.acked = 0;           // byte som bevisligen kommit fram (före den senast besvarade PING)
    this.pending = new Set(); // bitar som lämnats till HTTP/2 men inte skrivits än: { n, t }
    this.pings = [];          // obesvarade: { w, t }
    this.lastPingW = 0; this.lastAck = 0;
    this.acks = [];           // [t, w] för takten
    this.rates = [];          // [t, byte/s]
    this.minRtt = Infinity;
    this.waiters = [];        // { s, fn, t }
    this.closed = false; this.kicking = false;
    this.timer = null;
  }
  get rate() { const t = this.now(); while (this.rates.length && t - this.rates[0][0] > RATE_WINDOW) this.rates.shift(); return this.rates.reduce((m, r) => Math.max(m, r[1]), 0); }
  cap() { return Math.max(FLOOR, this.rate * Math.max(TARGET_MS, (Number.isFinite(this.minRtt) ? this.minRtt : 0) + EXTRA_MS) / 1000); }
  /** Byte som är på väg: skrivna men inte bekräftade, plus det som just lämnats till HTTP/2 */
  outstanding() {
    const t = this.now(); let p = 0;
    for (const x of this.pending) if (t - x.t < STALE) p += x.n;
    return this.sent - this.acked + p;
  }
  /** Ny ström: { sent, credit, t } */
  stream() { return { sent: 0, credit: FREE, t: this.now() }; }
  /** Får strömmen skicka n byte direkt? (dess egen lilla hink) */
  free(s, n) {
    const t = this.now();
    s.credit = Math.min(FREE, s.credit + (t - s.t) * FREE_RATE / 1000); s.t = t;
    if (this.closed || s.credit < n) return false;
    s.credit -= n; return true;
  }
  /** En bit lämnas till HTTP/2; done(tok) när den skrivits */
  begin(s, n) { s.sent += n; const tok = { n, t: this.now() }; this.pending.add(tok); return tok; }
  done(tok) {
    if (!this.pending.delete(tok)) return;
    this.sent += tok.n;
    this.maybePing();
  }
  /** Bit som aldrig skrivs (strömmen stängdes) */
  drop(tok) { this.pending.delete(tok); }
  /** Strömmen stängdes: den väntar inte längre */
  cancel(s) { this.waiters = this.waiters.filter(w => w.s !== s); }
  /** Vänta på plats i kön; fn() anropas en gång */
  wait(s, fn) {
    if (this.closed) return fn();
    this.waiters.push({ s, fn, t: this.now() });
    this.kick();
    if (this.waiters.length && !this.timer) { this.timer = setInterval(() => this.watch(), 250); this.timer.unref?.(); }
  }
  kick() {
    if (this.kicking) return; // en släppt bit som genast väntar igen tas av loopen nedan (ingen rekursion)
    this.kicking = true;
    try { while (this.waiters.length && (this.closed || this.outstanding() < this.cap())) this.release(); }
    finally { this.kicking = false; }
    if (!this.waiters.length && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  // Den som skickat minst hittills går först: ett stort svar (en sida med många träffar) före filmen
  release() {
    let k = 0;
    for (let i = 1; i < this.waiters.length; i++) if (this.waiters[i].s.sent < this.waiters[k].s.sent) k = i;
    const [w] = this.waiters.splice(k, 1);
    w.fn();
  }
  maybePing() {
    if (this.closed || this.sent <= this.lastPingW) return;
    if (this.pings.length && (this.sent - this.lastPingW < Math.max(SLICE, this.cap() / PING_EVERY) || this.pings.length >= MAX_PINGS)) return;
    const p = { w: this.sent, t: this.now() };
    let ok = false;
    try { ok = this.ping((err) => this.onAck(p, err)); } catch { ok = false; }
    if (!ok) return;
    this.pings.push(p); this.lastPingW = p.w;
  }
  onAck(p, err) {
    const i = this.pings.indexOf(p);
    if (i < 0) return;
    this.pings.splice(0, i + 1); // svaren kommer i ordning
    if (err) { this.kick(); return; }
    const t = this.now();
    this.lastAck = t;
    this.acked = Math.max(this.acked, p.w);
    this.minRtt = Math.min(this.minRtt, t - p.t);
    this.acks.push([t, p.w]);
    while (this.acks.length > 2 && t - this.acks[1][0] > RATE_WINDOW) this.acks.shift();
    let j = -1;
    for (let k = this.acks.length - 2; k >= 0; k--) if (t - this.acks[k][0] >= RATE_SPAN) { j = k; break; }
    if (j >= 0 && p.w > this.acks[j][1]) this.rates.push([t, (p.w - this.acks[j][1]) / ((t - this.acks[j][0]) / 1000)]);
    this.kick();
    this.maybePing();
  }
  // Skydd: kommer inga PING-svar (eller ett fel här) står inget still – en bit släpps var 250:e ms
  watch() {
    const t = this.now();
    if (!this.waiters.length) return this.kick();
    if (t - Math.max(this.lastAck, this.waiters[0].t) > STUCK) { this.release(); this.maybePing(); }
    this.kick();
  }
  close() { this.closed = true; this.kick(); if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
