// Expo-appens mätning av uppkopplingen utanför hemmet (apps/expo/src/bwcore.ts): bw till /playback bara utanför
// hemmet, en mätning gäller i tio minuter, förvärmningen och uppspelningen skickar samma bw, och uppspelningen väntar
// högst 1,5 s på en mätning. Provet (sample) körs mot en lokal server som skickar med en bestämd takt (som en strypt
// anslutning) genom en liten XMLHttpRequest på node:http – telefonens egen XMLHttpRequest provas inte här.
// Node 22.18+ läser TypeScript utan byggsteg.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const skip = process.features?.typescript ? false : 'Node utan TypeScript-stöd';
const c = skip ? null : await import('../apps/expo/src/bwcore.ts');

test('mäter bara utanför hemmet', { skip }, async () => {
  assert.equal(c.away({ savedIsLocal: false, viaHome: false, here: false }), true);
  assert.equal(c.away({ savedIsLocal: false, viaHome: false, here: null }), true, 'okänt räknas som utanför (publik adress)');
  assert.equal(c.away({ savedIsLocal: false, viaHome: true, here: false }), false, 'hemadressen används');
  assert.equal(c.away({ savedIsLocal: false, viaHome: false, here: true }), false, 'servern ser förfrågan som hemma');
  assert.equal(c.away({ savedIsLocal: true, viaHome: false, here: null }), false, 'sparad adress i hemnätet');
  // Hemma: ingen mätning och inget bw, varken till förvärmningen eller uppspelningen
  let asked = 0;
  assert.equal(await c.forPlay(false, null, 0, async () => { asked++; return 5000; }), null);
  assert.equal(c.forWarm(false, 5000, 5000), null);
  assert.equal(asked, 0);
  // Utanför hemmet utan färsk mätning: uppspelningen mäter (och förvärmningen väntar på nästa gång)
  assert.equal(await c.forPlay(true, null, 0, async () => { asked++; return 5000; }), 5000);
  assert.equal(asked, 1);
  assert.equal(c.forWarm(true, null, 0), null);
});

test('takten räknas efter första tredjedelen', { skip }, () => {
  const marks = [[0, 0], ...Array.from({ length: 11 }, (_, i) => [300 + i * 100, i * 100000])];
  assert.equal(c.rateOf(marks), 8000);
  assert.equal(c.rateOf([[0, 0]]), 0);
  assert.equal(c.rateOf([[0, 0], [100, 10000]]), 800, 'allt i en bit: hela provet');
});

test('en mätning gäller i tio minuter', { skip }, () => {
  const m = new c.Meter();
  assert.equal(m.fresh(0), 0);
  m.note(4000, 1000);
  assert.equal(m.fresh(1000 + c.FRESH_MS - 1), 4000);
  assert.equal(m.fresh(1000 + c.FRESH_MS), 0);
  m.note(0, 2000); m.note(NaN, 2000);
  assert.equal(m.fresh(2000), 4000);
  m.clear();
  assert.equal(m.fresh(2000), 0);
});

test('förvärmningen och uppspelningen skickar samma bw', { skip }, async () => {
  const m = new c.Meter(), pairs = new c.Pairs();
  m.note(6000, 0);
  const key = c.pairKey(7, 30.4);
  const warm = c.forWarm(true, pairs.get(key, 0), m.fresh(0));
  assert.equal(warm, 6000); pairs.put(key, warm, 0);
  m.note(9000, 5000); // en ny mätning under tiden
  assert.equal(await c.forPlay(true, pairs.get(c.pairKey(7, 30), 10000), m.fresh(10000), async () => 1), 6000);
  assert.equal(c.forWarm(true, pairs.get(key, 15000), m.fresh(15000)), 6000, 'nästa förvärmning ändrar inte frågan');
  assert.equal(await c.forPlay(true, pairs.get(key, 40000), m.fresh(40000), async () => 1), 9000, 'långt senare: färsk mätning');
});

test('uppspelningen väntar högst waitMs på en mätning', { skip }, async () => {
  assert.equal(await c.forPlay(true, null, 0, () => new Promise((r) => setTimeout(() => r(3000), 30)), 1000), 3000);
  const t0 = Date.now();
  assert.equal(await c.forPlay(true, null, 0, () => new Promise(() => {}), 200), null);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await c.forPlay(true, null, 0, async () => { throw new Error('nät'); }, 200), null, 'fel i mätningen');
});

/** XMLHttpRequest på node:http – det sample() använder (open, headers, readyState 2, progress, load, abort) */
function nodeXhr() {
  const x = { readyState: 0, status: 0, responseType: '', onprogress: null, onreadystatechange: null, onload: null, onerror: null, ontimeout: null,
    _h: {}, _url: '', _req: null, aborted: false, got: 0,
    open(_m, url) { this._url = url; this.readyState = 1; },
    setRequestHeader(k, v) { this._h[k] = v; },
    abort() { this.aborted = true; this._req?.destroy(); },
    send() {
      this._req = http.get(this._url, { headers: this._h }, (res) => {
        this.status = res.statusCode; this.readyState = 2; this.onreadystatechange?.();
        res.on('data', (d) => { this.got += d.length; this.readyState = 3; this.onprogress?.({ loaded: this.got }); });
        res.on('end', () => { this.readyState = 4; this.onreadystatechange?.(); this.onload?.(); });
        res.on('error', () => {});
      });
      this._req.on('error', () => { if (!this.aborted) this.onerror?.(); });
    } };
  return x;
}

/** En lokal server som skickar provet med en bestämd takt och 150 ms svarstid; auth = rubriken som krävs */
async function throttled(kbps, auth) {
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== auth) { res.writeHead(401); res.end(); return; }
    const total = 4096 * 1024, chunk = Buffer.alloc(8192);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': total });
      const t0 = Date.now();
      let sent = 0;
      const pump = () => {
        if (res.destroyed) return;
        while (sent < total && sent * 8 / kbps <= Date.now() - t0) { res.write(chunk); sent += chunk.length; }
        if (sent >= total) res.end(); else setTimeout(pump, 4);
      };
      pump();
    }, 150);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/api/speedtest?kb=4096`, close: () => { srv.closeAllConnections(); srv.close(); } };
}

test('provet mot en strypt server ger ungefär dess takt på ungefär en sekund', { skip, timeout: 30000 }, async () => {
  for (const kbps of [2000, 5000, 20000]) {
    const s = await throttled(kbps, 'Bearer abc');
    let made = null;
    const t0 = Date.now();
    const k = await c.sample(s.url, { Authorization: 'Bearer abc' }, { xhr: () => (made = nodeXhr()) });
    const ms = Date.now() - t0;
    s.close();
    console.log(`strypt till ${kbps} kbit/s: mätt ${k} kbit/s på ${ms} ms`);
    assert.ok(k > kbps * 0.8 && k < kbps * 1.25, `${kbps} kbit/s mättes som ${k}`);
    assert.ok(ms < 1700, `provet tog ${ms} ms`);
    assert.ok(made.aborted || made.got >= 4096 * 1024, 'resten av provet hämtas inte');
  }
});

test('provet ger 0 när servern nekar eller inte svarar', { skip, timeout: 10000 }, async () => {
  const s = await throttled(5000, 'Bearer rätt');
  assert.equal(await c.sample(s.url, { Authorization: 'Bearer fel' }, { xhr: nodeXhr }), 0);
  s.close();
  assert.equal(await c.sample('http://127.0.0.1:9/api/speedtest', {}, { xhr: nodeXhr }), 0);
  // Svarar aldrig: ger upp efter limitMs
  const hang = http.createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  assert.equal(await c.sample(`http://127.0.0.1:${hang.address().port}/x`, {}, { xhr: nodeXhr, limitMs: 300 }), 0);
  assert.ok(Date.now() - t0 < 1500);
  hang.closeAllConnections(); hang.close();
});
