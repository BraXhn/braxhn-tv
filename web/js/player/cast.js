// Chromecast
import { $$, api, status, sxe, toast } from '../core.js';
import { P, closePlayer } from './video.js';

// ---------- Chromecast ----------
export let castReady = false;
export function initCast() {
  if (!window.chrome || !window.isSecureContext || document.getElementById('castsdk')) return;
  window.__onGCastApiAvailable = (ok) => {
    if (!ok || !window.cast?.framework) return;
    cast.framework.CastContext.getInstance().setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    castReady = true;
    $$('.castbtn').forEach(b => b.hidden = false);
  };
  const s = document.createElement('script'); s.id = 'castsdk';
  s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
  document.head.append(s);
}
export async function castItem(it, position) {
  if (!castReady) return toast('Chromecast kräver Chrome och att servern nås via HTTPS');
  const ctx = cast.framework.CastContext.getInstance();
  try { await ctx.requestSession(); } catch { return; }
  const sess = ctx.getCurrentSession(); if (!sess) return;
  // Default Media Receiver: H.264/VP8/VP9 + AAC/MP3/Opus i MP4/WebM eller HLS
  const p = await api(`/items/${it.id}/playback?` + new URLSearchParams({ c: 'mp4,webm', v: 'h264,vp8,vp9', a: 'aac,mp3,opus,flac', hdr: '0', cast: '1', audio: P?.audio || '', q: P?.q === 'auto' ? '' : (P?.q || ''),
    ...(it.version ? { version: it.version } : {}) }), { bg: true });
  const origin = status.publicUrl || location.origin;
  const mi = new chrome.cast.media.MediaInfo(origin + p.url, p.mime);
  mi.streamType = chrome.cast.media.StreamType.BUFFERED;
  if (p.mode !== 'direct') { mi.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.TS; mi.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS; }
  mi.metadata = new chrome.cast.media.GenericMediaMetadata();
  mi.metadata.title = it.kind === 'episode' ? `${it.showTitle} – ${sxe(it)} ${it.title}` : it.title;
  if (it.thumb || it.poster) mi.metadata.images = [new chrome.cast.Image(`${origin}/api/image/${p.version || it.id}/${it.poster ? 'poster' : 'thumb'}?t=${p.token}`)];
  mi.tracks = p.subtitles.map((s, i) => {
    const t = new chrome.cast.media.Track(i + 1, chrome.cast.media.TrackType.TEXT);
    t.trackContentId = origin + s.url; t.trackContentType = 'text/vtt'; t.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
    t.name = s.label; t.language = s.lang || 'und'; return t;
  });
  const req = new chrome.cast.media.LoadRequest(mi);
  req.currentTime = position || 0;
  const subIdx = P?.sub ? p.subtitles.findIndex(s => s.id === P.sub) : -1;
  if (subIdx >= 0) req.activeTrackIds = [subIdx + 1];
  try { await sess.loadMedia(req); toast('Spelas på ' + sess.getCastDevice().friendlyName); if (P) closePlayer(false); }
  catch (e) { toast('Kunde inte casta: ' + (e?.code || e)); }
}
