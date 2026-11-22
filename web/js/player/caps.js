// Vad klarar den här webbläsaren? Video- och ljudformat som skickas till servern
// ---------- uppspelning: vad klarar den här webbläsaren? ----------
import { t } from '../core.js';
import { rateOf } from './hlsconfig.js';
let CAPS = null;
// AV1 som omkodningsmål bara när webbläsaren avkodar det jämnt (ofta hårdvara) – mäts i bakgrunden när modulen
// laddas; tills svaret kommit (eller utan Media Capabilities) blir det HEVC eller H.264
let av1Smooth = false;
try {
  navigator.mediaCapabilities?.decodingInfo({ type: 'media-source', video: { contentType: 'video/mp4; codecs="av01.0.08M.08"', width: 1920, height: 1080, bitrate: 4e6, framerate: 30 } })
    .then(r => { av1Smooth = !!(r.supported && r.smooth); }).catch(() => {});
} catch {}
/**
 * Ska webbläsarens egen HLS-spelare användas? Bara i Safari (och på enheter utan Media Source, som äldre iPhone).
 * Chrome svarar numera också ja på frågan om den kan spela HLS, men dess inbyggda spelare klarar inte våra
 * remux-segment (öppen GOP: bufferten töms och bilden fryser) – där ska hls.js användas, som strömmarna är provade med.
 */
export function nativeHls(v = document.createElement('video')) {
  if (!v.canPlayType('application/vnd.apple.mpegurl')) return false;
  if (!window.MediaSource && !window.ManagedMediaSource) return true;
  const ua = navigator.userAgent || '';
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua);
}
export function capsQuery(extra = {}) {
  if (!CAPS) {
    const v = document.createElement('video');
    const ok = (t) => { try { return !!(v.canPlayType(t) || (window.MediaSource && MediaSource.isTypeSupported(t))); } catch { return false; } };
    const vc = ['h264'], ac = ['aac', 'mp3'], cont = ['mp4'];
    if (ok('video/mp4; codecs="hvc1.1.6.L120.90"') || ok('video/mp4; codecs="hev1.1.6.L120.90"')) vc.push('hevc');
    if (ok('video/webm; codecs="vp9"')) { vc.push('vp9'); cont.push('webm'); }
    if (ok('video/webm; codecs="vp8"')) vc.push('vp8');
    if (ok('video/mp4; codecs="av01.0.08M.08"')) vc.push('av1');
    if (ok('audio/webm; codecs="opus"') || ok('audio/mp4; codecs="opus"')) ac.push('opus');
    if (ok('audio/webm; codecs="vorbis"')) ac.push('vorbis');
    if (ok('audio/mp4; codecs="flac"') || ok('audio/flac')) ac.push('flac');
    if (ok('audio/mp4; codecs="ac-3"')) ac.push('ac3');
    if (ok('audio/mp4; codecs="ec-3"')) ac.push('eac3');
    const hdr = !!(window.matchMedia && matchMedia('(dynamic-range: high)').matches) && vc.includes('hevc');
    CAPS = { c: cont.join(','), v: vc.join(','), a: ac.join(','), hdr: hdr ? '1' : '0' };
  }
  // Omkodning till HEVC/AV1 i fMP4 (tc): det webbläsaren kan avkoda. Safaris egen HLS-spelare bara HEVC.
  // extra.tc = '' (efter ett avkodningsfel) ger H.264.
  const v = CAPS.v.split(',');
  const tc = [v.includes('hevc') && 'hevc', v.includes('av1') && av1Smooth && extra.nhls !== '1' && 'av1'].filter(Boolean);
  return new URLSearchParams({ ...CAPS, ...(tc.length ? { tc: tc.join(',') } : {}), ...extra }).toString();
}
export const canAirPlay = () => !!window.WebKitPlaybackTargetAvailabilityEvent;

// ---------- uppkopplingen utanför hemmet ----------
// Spelaren mäter hur snabbt servern kan skicka hit (hemmets uppladdning × mobilnätet) och servern väljer
// kvalitet och startsteg efter det. Mätningen sparas i 10 minuter; den görs bara utanför hemmet.
const net = { kbps: 0, at: 0, running: null };
export const lastBandwidth = () => (Date.now() - net.at < 10 * 60e3 ? net.kbps : 0);
export const saveData = () => !!navigator.connection?.saveData;
// Takten räknas på det som kommer EFTER den första tredjedelen av provet. Svarstiden och anslutningens uppstart
// (TCP börjar långsamt) hör inte till uppkopplingens takt: med hela provets tid mättes en snabb uppkoppling med
// 100 ms svarstid till ~3 Mbit/s, och filmen började på 480p. Provet avbryts efter SAMPLE_MS – på en långsam
// uppkoppling räcker det som hunnit komma.
const SAMPLE_KB = 4096, SAMPLE_MS = 1000;
async function sample() {
  const ctl = new AbortController();
  const r = await fetch(`/api/speedtest?kb=${SAMPLE_KB}&n=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
  if (!r.ok) throw new Error();
  const rd = r.body?.getReader?.();
  if (!rd) { const t0 = performance.now(); const b = await r.arrayBuffer(); return Math.round(b.byteLength * 8 / Math.max(1, performance.now() - t0)); }
  const marks = [[performance.now(), 0]]; // första märket: när svaret började komma
  let got = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    got += value.length;
    const now = performance.now();
    marks.push([now, got]);
    if (now - marks[0][0] > SAMPLE_MS) { ctl.abort(); break; }
  }
  return rateOf(marks);
}
export function measureBandwidth() {
  if (lastBandwidth()) return Promise.resolve(net.kbps);
  if (net.running) return net.running;
  net.running = (async () => {
    try { net.kbps = await sample(); net.at = Date.now(); } catch { net.kbps = 0; }
    return net.kbps;
  })().finally(() => { net.running = null; });
  return net.running;
}
/** Takten som spelaren själv mäter på riktiga segment (hls.js) – färskare och säkrare än provet */
export function noteBandwidth(kbps) {
  if (kbps > 0 && Number.isFinite(kbps)) { net.kbps = Math.round(kbps); net.at = Date.now(); }
}

// ================= MUSIK =================
let ACAPS = null;
export function audioCaps() {
  if (ACAPS) return ACAPS;
  const a = document.createElement('audio'), ok = (t) => { try { return !!a.canPlayType(t); } catch { return false; } };
  const c = ['mp3'];
  if (ok('audio/mp4; codecs="mp4a.40.2"')) c.push('aac');
  if (ok('audio/flac')) c.push('flac');
  if (ok('audio/ogg; codecs="opus"') || ok('audio/webm; codecs="opus"')) c.push('opus');
  if (ok('audio/ogg; codecs="vorbis"')) c.push('vorbis');
  if (ok('audio/mp4; codecs="alac"')) c.push('alac');
  return (ACAPS = c.join(','));
}
