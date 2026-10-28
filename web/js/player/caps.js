// Vad klarar den här webbläsaren? Video- och ljudformat som skickas till servern
// ---------- uppspelning: vad klarar den här webbläsaren? ----------
import { t } from '../core.js';
let CAPS = null;
// AV1 som omkodningsmål bara när webbläsaren avkodar det jämnt (ofta hårdvara) – mäts i bakgrunden när modulen
// laddas; tills svaret kommit (eller utan Media Capabilities) blir det HEVC eller H.264
let av1Smooth = false;
try {
  navigator.mediaCapabilities?.decodingInfo({ type: 'media-source', video: { contentType: 'video/mp4; codecs="av01.0.08M.08"', width: 1920, height: 1080, bitrate: 4e6, framerate: 30 } })
    .then(r => { av1Smooth = !!(r.supported && r.smooth); }).catch(() => {});
} catch {}
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
async function sample(kb) {
  const t0 = performance.now();
  const r = await fetch(`/api/speedtest?kb=${kb}&n=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
  if (!r.ok) throw new Error();
  const b = await r.arrayBuffer();
  return { bytes: b.byteLength, ms: Math.max(1, performance.now() - t0) };
}
export function measureBandwidth() {
  if (lastBandwidth()) return Promise.resolve(net.kbps);
  if (net.running) return net.running;
  net.running = (async () => {
    try {
      // Litet prov först (svarstiden väger tungt); går det snabbt mäts ett större för ett säkrare värde
      let s = await sample(256);
      if (s.ms < 600) s = await sample(2048);
      net.kbps = Math.round(s.bytes * 8 / s.ms); // byte/ms × 8 = kbit/s
      net.at = Date.now();
    } catch { net.kbps = 0; }
    return net.kbps;
  })().finally(() => { net.running = null; });
  return net.running;
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
