// Tunnelns kö (server/tunnelq.js), simulerad: hemmets uppladdning är en FIFO-länk med C byte/ms och fördröjning d
// åt varje håll; en PING-markör går genom samma FIFO och besvaras d ms efter att den kommit fram. Mäter i byte och
// ordning (inte väggklocka): hur mycket av en stor ström som ligger FÖRE ett litet svar, hur mycket ett avbrutet
// hastighetsprov hunnit lägga i länken, och att den stora strömmen ändå får (nästan) hela länken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TunnelQueue, SLICE, FREE } from '../server/tunnelq.js';

/** Simulerad tunnel. mbit = uppladdning, d = fördröjning åt varje håll (ms). queue=false: som före 1.4.1 (allt direkt, 4 MB fönster) */
function sim({ mbit, d, queue = true }) {
  const C = mbit * 125;               // byte per ms
  let now = 0;
  const fifo = [];                    // { n, id, ping }
  const events = [];                  // [t, fn]
  const delivered = new Map();        // id → byte framme
  const q = queue ? new TunnelQueue({ now: () => now, ping: (cb) => { fifo.push({ n: 0, ping: cb }); return true; } }) : null;
  const streams = [];
  const ahead = (id) => fifo.reduce((s, x) => s + (x.id !== id ? x.n : 0), 0);
  function push(id, n) { fifo.push({ n, id }); }
  // En ström som vill skicka `total` byte (Infinity = film) så fort den får
  function stream(id, total) {
    const s = { id, total, sent: 0, waiting: false, done: false, aborted: false, qs: q?.stream() };
    streams.push(s);
    s.pump = () => {
      while (!s.aborted && s.sent < s.total && !s.waiting) {
        const n = Math.min(SLICE, s.total - s.sent);
        if (!q) {
          // Före: HTTP/2-fönstret (4 MB per ström) är enda gränsen
          if (s.sent - (delivered.get(id) || 0) + n > 4 << 20) return;
          s.sent += n; push(id, n); continue;
        }
        const go = () => { s.waiting = false; if (s.aborted) return; const tok = q.begin(s.qs, n); s.sent += n; push(id, n); q.done(tok); };
        if (q.free(s.qs, n)) go(); else { s.waiting = true; q.wait(s.qs, () => { go(); s.pump(); }); }
      }
    };
    s.pump();
    return s;
  }
  function step(ms) {
    for (let i = 0; i < ms; i++) {
      now++;
      let budget = C;
      while (fifo.length && (budget > 0 || fifo[0].n === 0)) {
        const x = fifo[0];
        if (x.ping) { fifo.shift(); const cb = x.ping; events.push([now + 2 * d, () => cb(null)]); continue; }
        const k = Math.min(x.n, budget); x.n -= k; budget -= k;
        delivered.set(x.id, (delivered.get(x.id) || 0) + k);
        if (!x.n) fifo.shift();
      }
      // Länken framme → reläet; reläets svar på PING är d ms till på väg tillbaka
      for (const e of events.filter(e => e[0] <= now)) { events.splice(events.indexOf(e), 1); e[1](); }
      for (const s of streams) if (!s.waiting) s.pump();
    }
  }
  const abort = (s) => { s.aborted = true; for (const x of fifo) if (x.id === s.id) x.n = 0; };
  return { q, stream, step, ahead, delivered, abort, inLink: (id) => fifo.reduce((s, x) => s + (x.id === id ? x.n : 0), 0), close: () => { for (const x of streams) x.aborted = true; q?.close(); }, C };
}

test('en film i tunneln: ett litet svar har högst ~0,3 s av filmen framför sig – före: hela fönstret (4 MB)', () => {
  for (const [mbit, d] of [[10, 0], [10, 20], [50, 20]]) {
    const res = {};
    for (const queue of [false, true]) {
      const s = sim({ mbit, d, queue });
      s.stream('film', Infinity);
      s.step(5000);
      const before = s.delivered.get('film');
      s.step(3000);
      const rate = (s.delivered.get('film') - before) / 3000;
      // Ett litet svar (en sida) kommer nu: hur mycket av filmen ligger före det i länken?
      s.stream('sida', 20000);
      res[queue ? 'efter' : 'före'] = { ahead: s.ahead('sida'), rate };
      s.close();
    }
    const msAhead = res.efter.ahead / (mbit * 125);
    assert.ok(res.före.ahead > 3 << 20, `${mbit} Mbit/s: före låg ${res.före.ahead} byte framför (som i ärende #2)`);
    assert.ok(msAhead < 350, `${mbit} Mbit/s, ${2 * d} ms: ${res.efter.ahead} byte (${Math.round(msAhead)} ms) framför sidan`);
    assert.ok(res.efter.rate > 0.95 * mbit * 125, `${mbit} Mbit/s: filmen fick ${(res.efter.rate / 125).toFixed(1)} Mbit/s`);
  }
});

test('snabb uppkoppling med lång svarstid: takten blir inte lägre med kön', () => {
  for (const [mbit, d] of [[100, 20], [500, 40], [1000, 5]]) {
    const s = sim({ mbit, d });
    s.stream('film', Infinity);
    s.step(3000);
    const b = s.delivered.get('film');
    s.step(3000);
    const rate = (s.delivered.get('film') - b) / 3000 / 125;
    assert.ok(rate > 0.9 * mbit, `${mbit} Mbit/s, ${2 * d} ms: ${rate.toFixed(0)} Mbit/s`);
    s.close();
  }
});

test('hastighetsprovet (4 MB, avbryts efter 1 s): högst ~0,3 s av det ligger kvar i tunneln, och provet mäter rätt takt', () => {
  for (const queue of [false, true]) {
    const s = sim({ mbit: 10, d: 15, queue });
    const sp = s.stream('prov', 4 << 20);
    s.step(60); // svaret börjar komma
    const at = s.delivered.get('prov') || 0;
    s.step(1000);
    const got = s.delivered.get('prov') - at;
    const left = s.inLink('prov') + 0;
    if (!queue) assert.ok(left > 2 << 20, `före: ${left} byte kvar i tunneln när provet avbröts`);
    else {
      assert.ok(left < 0.35 * 1250 * 1000 / 1, `efter: ${left} byte kvar i tunneln`);
      assert.ok(got / 1000 > 0.9 * 1250, `provet fick ${(got / 1000 / 125).toFixed(1)} Mbit/s av 10`);
    }
    s.abort(sp);
    s.close();
  }
});

test('små svar går före: varje svars första FREE byte väntar inte, och den som skickat minst släpps först', () => {
  const s = sim({ mbit: 10, d: 10 });
  s.stream('film', Infinity);
  s.step(4000);
  const json = s.stream('stor-json', 300000);
  assert.ok(json.sent >= FREE, 'de första byten skickades direkt');
  s.step(500);
  // Resten av det stora svaret gick före filmen: klart inom ~0,5 s trots att filmen har ~0,25 s i länken
  assert.equal(s.delivered.get('stor-json'), 300000);
  s.close();
});

test('en ström som står still (klienten läser inte) stoppar inte de andra', () => {
  let now = 0;
  const q = new TunnelQueue({ now: () => now, ping: () => true });
  const a = q.stream(), b = q.stream();
  // a lämnade 256 kB som aldrig skrivs (HTTP/2-fönstret är fullt)
  for (let i = 0; i < 8; i++) q.begin(a, SLICE);
  let ran = false;
  now += 600; // efter STALE räknas de inte längre
  q.free(b, FREE); // b:s hink tom
  q.wait(b, () => { ran = true; });
  assert.equal(ran, true);
  q.close();
});
