// Spolning i Safaris egen HLS-spelare (iPhone, iPad, Mac: caps.js nativeHls, strömmen i v.src) i en omkodning.
// Safari spolar annars inom den gamla spellistan och väntar på hela 6 s-segmentet med målet (3–4,5 s). Som med
// hls.js (video.js seekRestarts) och i apparna startas strömmen i stället om vid målet: /playback med start= och prev=
// ger en ny ström med korta segment där och EXT-X-START (xs), så att Safari börjar på målet.
// Safari har ingen händelse före spolningen och visar inga svarshuvuden (X-Seg-Ready): spolningen märks på seeking,
// bufferten läses ur v.buffered, segmenten ur spellistan (index.m3u8, samma gränser i alla kvalitetssteg) och vad
// servern har klart frågas i förväg med /hls/ready medan filmen spelar (som Expo, apps/expo/src/seekcore.ts).
// Importerar bara hlsconfig.js (inget DOM utöver videoelementet) – testas i Node med en låtsad video
// (test/fast-resume.test.js) och i Chrome med Safaris användaragent (test/web-chrome-playback.test.js).
import { freshReady, parseFrags, seekRestart } from './hlsconfig.js';

/** Medialistan och /hls/ready för en ström (mastern) – samma frågesträng (pid, t) */
export const indexUrl = (master) => String(master).replace('/hls/master.m3u8', '/hls/index.m3u8');
export const readyUrl = (master) => String(master).replace('/hls/master.m3u8', '/hls/ready');
/** Hur ofta servern frågas medan filmen spelar, och hur gammalt svaret får vara vid en spolning (ms) */
export const READY_EVERY_MS = 4000, READY_FRESH_MS = 8000;

const bufferedOf = (v) => { const b = []; for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i), v.buffered.end(i)]); return b; };

/**
 * Bevakar spolningar i videon v (strömmen url = mastern). Spolning utanför bufferten, när servern inte har målet
 * klart (seekRestart i hlsconfig.js), anropar onRestart(t) – spelaren startar då om strömmen vid t. Spolningar
 * innan filmen har visat bild räknas inte (startpositionen, spelarens egen inställning efter en omstart).
 * own() = är strömmen fortfarande spelarens? Ger funktionen som slutar bevaka.
 */
export function watchNativeSeeks(v, { url, onRestart, own = () => true, fetchFn = globalThis.fetch, now = () => Date.now(), every = READY_EVERY_MS }) {
  let frags = [], known = null, started = false, stopped = false, seq = 0;
  const get = (u) => fetchFn(u, { credentials: 'same-origin', cache: 'no-store' });
  get(indexUrl(url)).then(r => r.ok ? r.text() : '').then(t => { if (!stopped) frags = parseFrags(t); }).catch(() => {});
  const poll = () => {
    if (stopped) return;
    if (!own()) return stop(); // spelaren stängd eller strömmen ersatt: sluta fråga
    if (!started || v.paused) return;
    const at = now(), mine = seq;
    get(readyUrl(url)).then(r => r.ok ? r.json() : null).then(j => {
      // Ett svar som kommer efter en spolning gäller inte längre (Safari kan redan ha bett om målet i den gamla strömmen)
      if (!stopped && j && mine === seq) known = { segs: Array.isArray(j.segs) ? j.segs : null, at };
    }).catch(() => {});
  };
  const timer = setInterval(poll, every);
  const onData = () => { if (!started) { started = true; poll(); } };
  const onSeek = () => {
    if (stopped || !started || !own()) return;
    const t = v.currentTime, ready = freshReady(known, now(), READY_FRESH_MS);
    // Efter spolningen kan servern ha börjat koda om vid målet: svaret från före spolningen gäller inte längre
    seq++; known = null;
    if (seekRestart(bufferedOf(v), t, { frags, ready })) onRestart(t);
  };
  v.addEventListener('loadeddata', onData); v.addEventListener('playing', onData);
  v.addEventListener('seeking', onSeek);
  function stop() {
    stopped = true; clearInterval(timer);
    v.removeEventListener('loadeddata', onData); v.removeEventListener('playing', onData); v.removeEventListener('seeking', onSeek);
  }
  return stop;
}
