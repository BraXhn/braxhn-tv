// Vad klarar den här webbläsaren? Video- och ljudformat som skickas till servern
// ---------- uppspelning: vad klarar den här webbläsaren? ----------
let CAPS = null;
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
  return new URLSearchParams({ ...CAPS, ...extra }).toString();
}
export const canAirPlay = () => !!window.WebKitPlaybackTargetAvailabilityEvent;

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
