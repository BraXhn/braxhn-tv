// Expo-appens spolning i en omkodad ström (apps/expo/src/seekcore.ts): när spelaren startar om strömmen vid målet
// (/playback med start= och prev=) i stället för att vänta på ett helt 6 s-segment. Samma regler som webbens
// seekRestart (test/fast-resume.test.js); här också hur appen märker en spolning och gissar vad servern har klart.
// Telefonens spelare (expo-video) provas inte här. Node 22.18+ läser TypeScript utan byggsteg.
import test from 'node:test';
import assert from 'node:assert/strict';

const skip = process.features?.typescript ? false : 'Node utan TypeScript-stöd';
const c = skip ? null : await import('../apps/expo/src/seekcore.ts');
// Spellistan som servern ger med processorn (transcodeStarts med h1 i server/stream.js, docs/arkitektur.md punkt 41):
// 0, 1, 2, 4, 6, 12 … och med hs (≥ 6) … G, B, B+1, B+2, B+4, B+6, B+12 … där B = hs nedåt till jämn sekund
function fragsOf(dur, hs = 0) {
  const head = (b) => [b, b + 1, b + 2, b + 4];
  const starts = head(0);
  const B = hs >= 6 ? Math.floor(hs / 2) * 2 : 0;
  if (!B) for (let t = 6; t < dur - 0.5; t += 6) starts.push(t);
  else {
    for (let t = 6; t < B; t += 6) starts.push(t);
    starts.push(...head(B));
    for (let t = B + 6; t < dur - 0.5; t += 6) starts.push(t);
  }
  return starts.map((t, i) => ({ start: t, duration: (starts[i + 1] ?? dur) - t }));
}
const m3u8 = (frags) => '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n' + frags.map((f, i) => `#EXTINF:${f.duration.toFixed(6)},\nseg-${i}.ts?pid=abcd1234\n`).join('') + '#EXT-X-ENDLIST\n';

test('spellistan: segmentens start och längd ur #EXTINF', { skip }, () => {
  const f = fragsOf(600);
  const p = c.parseFrags(m3u8(f));
  assert.equal(p.length, f.length);
  for (let i = 0; i < f.length; i++) { assert.ok(Math.abs(p[i].start - f[i].start) < 1e-3); assert.ok(Math.abs(p[i].duration - f[i].duration) < 1e-3); }
  assert.deepEqual(c.parseFrags(''), []);
  assert.deepEqual(c.parseFrags('#EXTM3U\n#EXTINF:0,\nx.ts\n'), [], 'segment utan längd räknas inte');
  assert.equal(c.fragAt(p, 0), 0);
  assert.equal(c.fragAt(p, 6), c.fragAt(p, 6.5));
  assert.equal(c.fragAt(p, 601), -1);
  assert.equal(c.fragAt(p, NaN), -1);
});

test('adresser: medialistan bakom mastern och strömmens pid', { skip }, () => {
  assert.equal(c.indexUrl('/api/stream/7/hls/master.m3u8?mode=transcode&pid=0a1b2c3d&t=x'), '/api/stream/7/hls/index.m3u8?mode=transcode&pid=0a1b2c3d&t=x');
  assert.equal(c.pidOf('/api/stream/7/hls/master.m3u8?mode=transcode&pid=0a1b2c3d&t=x'), '0a1b2c3d');
  assert.equal(c.pidOf('/api/stream/7/hls/master.m3u8?pid=0a1b2c3d'), '0a1b2c3d');
  assert.equal(c.pidOf('/api/stream/7/hls/master.m3u8?xpid=0a1b2c3d'), '', 'bara parametern pid');
  assert.equal(c.pidOf('/api/stream/7/direct?t=abc'), '', 'direktuppspelning har ingen pid');
  assert.equal(c.pidOf(null), '');
});

test('omstart: samma regler som webben (seekRestart)', { skip }, async () => {
  const web = await import('../web/js/player/hlsconfig.js');
  const frags = fragsOf(3600);
  // Fall: [buffrat, t, ready]
  const cases = [
    [[[0, 30]], 1200, null, true, 'långt fram, utanför bufferten'],
    [[[0, 30]], 20, null, false, 'inom bufferten'],
    [[[0, 30]], 31, [0, 7], false, 'nästa segment efter det servern har (kodas just nu)'],
    [[[0, 30]], 60, [0, 7], true, 'längre fram än servern har kodat'],
    [[[0, 30]], 3, null, false, 'segmentet är redan kort (början av filen)'],
    [[[0, 30]], 3598, null, false, 'nära slutet'],
    [[], 1200, [190, 205], false, 'servern har segmentet klart'],
    [[], NaN, null, false, 'ingen position'],
  ];
  for (const [b, t, ready, want, why] of cases) {
    assert.equal(c.seekRestart(b, t, { frags, ready }), want, why);
    assert.equal(web.seekRestart(b, t, { frags, ready }), want, 'webben: ' + why);
  }
  assert.equal(c.seekRestart([], 1200, { frags, started: false }), false, 'ingen bild visad än (spelarens egna hopp vid starten)');
  assert.equal(c.seekRestart([], 1200, { frags: [] }), false, 'spellistan inte hämtad än');
  // Efter en omstart vid 1200: korta segment där, så en liten spolning vidare startar inte om igen
  const after = fragsOf(3600, 1200);
  assert.equal(c.seekRestart([], 1201.5, { frags: after }), false, 'kort segment vid förra omstarten');
  assert.equal(c.seekRestart([], 1500, { frags: after }), true, 'långt därifrån igen');
});

test('spolning: hopp i positionen, inte buffring eller vanlig uppspelning', { skip }, () => {
  const s = (pos, at, playing = true, rate = 1, buf = pos + 20) => ({ pos, buf, at, playing, rate });
  assert.equal(c.seekJump(s(100, 0), s(100.25, 250)), false, 'spelar som vanligt');
  assert.equal(c.seekJump(s(100, 0), s(101, 1000)), false, 'en sekund senare');
  assert.equal(c.seekJump(s(100, 0), s(100, 5000)), false, 'buffrar: positionen står still medan klockan går');
  assert.equal(c.seekJump(s(100, 0), s(110, 250)), true, 'framåt 10 s (fjärrkontrollens steg)');
  assert.equal(c.seekJump(s(100, 0), s(90, 250)), true, 'bakåt 10 s');
  assert.equal(c.seekJump(s(100, 0), s(99, 250)), false, 'en sekund bakåt räknas inte');
  assert.equal(c.seekJump(s(100, 0, false), s(104, 5000, false)), true, 'pausad: positionen flyttades');
  assert.equal(c.seekJump(s(100, 0, false), s(100, 5000, false)), false, 'pausad, ingen ändring');
  assert.equal(c.seekJump(s(100, 0, true, 2), s(107, 3000)), false, 'dubbel hastighet: 6 s på 3 s är ingen spolning');
  assert.equal(c.seekJump(s(100, 0, true, 2), s(112, 3000)), true);
  assert.equal(c.seekJump(s(NaN, 0), s(100, 250)), false);
});

test('vad servern har klart: från körningens start till buffertens slut, högst 30 segment bakåt', { skip }, () => {
  const frags = fragsOf(3600);
  const n = (t) => c.fragAt(frags, t);
  assert.deepEqual(c.readyGuess(frags, n(0), 40), [0, n(40)]);
  assert.deepEqual(c.readyGuess(frags, n(1200), 1261), [n(1200), n(1261)]);
  assert.deepEqual(c.readyGuess(frags, n(1200), 1260), [n(1200), n(1259)], 'bufferten slutar på en gräns: segmentet efter är inte hämtat');
  assert.deepEqual(c.readyGuess(frags, n(0), 1801), [n(1801) - 29, n(1801)], 'servern har tagit bort det som ligger långt bakom');
  assert.deepEqual(c.readyGuess(frags, n(1200), 1000), [n(1200), n(1200)], 'bufferten före körningen räknas inte');
  assert.deepEqual(c.readyGuess(frags, n(0), 4000), [frags.length - 30, frags.length - 1], 'till slutet');
  assert.equal(c.readyGuess([], 0, 10), null);
  assert.equal(c.readyGuess(frags, -1, 10), null, 'okänd start');
});

test('beslutet efter en spolning i appen', { skip }, () => {
  const frags = fragsOf(3600, 600);
  const st = { frags, runSeg: c.fragAt(frags, 600), started: true };
  const at = (pos, buf, playing = true) => ({ pos, buf, at: 0, playing, rate: 1 });
  assert.equal(c.decideSeek(at(700, 760), 2000, st), true, 'långt fram');
  assert.equal(c.decideSeek(at(700, 760), 750, st), false, 'inom bufferten');
  assert.equal(c.decideSeek(at(700, 760), 765, st), false, 'segmentet efter bufferten (servern kodar det)');
  assert.equal(c.decideSeek(at(700, 760), 640, st), false, 'bakåt inom körningen: servern har segmentet');
  assert.equal(c.decideSeek(at(700, 760), 300, st), true, 'bakåt före körningens start');
  assert.equal(c.decideSeek(at(700, 760), 601, st), false, 'kort segment vid starten');
  assert.equal(c.decideSeek(at(700, 760), 2000, { ...st, started: false }), false, 'ingen bild visad än');
  // Ingen omstart (t.ex. nära slutet): servern börjar koda om vid målet om det låg utanför
  assert.equal(c.runAfterSeek(at(700, 760), 3598, st), c.fragAt(frags, 3598));
  assert.equal(c.runAfterSeek(at(700, 760), 640, st), st.runSeg, 'inom det servern har: samma körning');
  assert.equal(c.runAfterSeek(at(700, 760), 99999, st), st.runSeg, 'utanför filmen');
});
