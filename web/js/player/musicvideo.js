// Musikvideor (server/musicvideos.js) i helskärmsspelaren #player: samma ruta som inspelningar (setRec i live.js), så
// att Bakåt, Escape, stäng-alla och mini-läget fungerar som för andra spelare. Filen spelas direkt; klarar webbläsaren
// den inte görs den om till fragmenterad MP4 på servern (?mp4=1). Kön = artistens videor: nästa startar när en slutar.
import { $, api, esc, fmtTime, imgSrc, t, toast, toastErr } from '../core.js';
import { M, musicSession, videoSession } from '../audio.js';
import { overlayOpen } from './overlay.js';
import { closeAllPlayers } from './video.js';
import { RP, closeRec, setRec } from './live.js';
import { screenPing } from '../screentime.js';
import { iconButton } from '../ui/buttons.js';

/** Typen som text (Plex-suffixen) */
export const kindLabel = (k) => ({ live: t('Live'), lyrics: t('Textvideo'), concert: t('Konsert'), interview: t('Intervju'), behindthescenes: t('Bakom kulisserna'), other: t('Övrigt') })[k] || t('Musikvideo');

/** Kort för en musikvideo (artist- och albumsidan). Knapp med data-mv – bindVideoCards() startar spelaren. */
export function videoCard(v) {
  const img = v.thumb ? `<img loading="lazy" decoding="async" ${imgSrc(`/api/music/videos/${+v.id}/thumb`, 360, 640)} alt="" data-fb="1">` : '';
  return `<button type="button" class="card land mvcard" data-mv="${+v.id}"><div class="art"><div class="ph">▶</div>${img}${v.duration ? `<span class="mvdur">${fmtTime(v.duration)}</span>` : ''}</div>
    <div class="t">${esc(v.title)}</div><div class="s">${esc(kindLabel(v.kind))}</div></button>`;
}
/** Hylla med musikvideor (tom sträng utan videor) */
export function videosShelf(list, id = 'mvh') {
  if (!list?.length) return '';
  return `<section class="section mvideos" aria-labelledby="${id}"><h2 id="${id}">${t('Musikvideor')} <span class="muted small">${list.length}</span></h2><div class="shelf wide">${list.map(videoCard).join('')}</div></section>`;
}
export function bindVideoCards(root, list) {
  root.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => playVideo(+b.dataset.mv, { list, opener: b }));
}

/**
 * Spelar musikvideon id. list = kön (videorna i den ordning de visas); utan lista hämtas artistens övriga videor.
 */
export async function playVideo(id, { list = null, opener = null } = {}) {
  let info, src;
  if (opener) opener.disabled = true;
  try { [info, src] = await Promise.all([api(`/music/videos/${+id}`, { bg: true }), api(`/music/videos/${+id}/play`, { bg: true })]); }
  catch (e) { toastErr(e); return; }
  finally { if (opener) opener.disabled = false; }
  const queue = list?.length ? list : [info, ...(info.more || [])];
  const at = Math.max(0, queue.findIndex(v => v.id === info.id));
  closeAllPlayers();
  if (M.audio && !M.audio.paused) M.audio.pause();
  const el = $('#player');
  const prev = queue[at - 1], next = queue[at + 1];
  el.innerHTML = `<video id="mvvid" controls autoplay playsinline src="${esc(src.url)}"></video>
    <div class="pbar"><button class="ghost small" id="mvclose">${t('← Tillbaka')}</button><span class="title">${esc(info.title)}${info.artist ? ` <span class="muted">· ${esc(info.artist)}</span>` : ''}</span>
      <span class="muted small" id="mvkind">${esc(kindLabel(info.kind))}</span>
      ${iconButton({ icon: '⏮', label: t('Föregående video'), id: 'mvprev', cls: 'ghost small', disabled: !prev })}
      ${iconButton({ icon: '⏭', label: next ? t('Nästa video: {title}', { title: next.title }) : t('Nästa video'), id: 'mvnext', cls: 'ghost small', disabled: !next })}
      ${info.track ? `<a class="btn ghost small" id="mvalbum" href="#/album/${+info.track.albumId}">${t('Till albumet')}</a>` : ''}</div>`;
  overlayOpen(el);
  const v = $('#mvvid', el);
  const rp = { el, v, hls: null, mv: info.id };
  setRec(rp);
  const alive = () => RP === rp;
  rp.onClose = () => { v.onerror = null; v.onended = null; musicSession(); };
  videoSession(v);
  screenPing(v, 'mv:' + info.id, alive, () => closeRec(rp));
  let tried = false;
  v.onerror = () => {
    if (!alive()) return;
    if (!tried) { tried = true; v.src = src.mp4; v.play().catch(() => {}); return; }
    toast(t('Videon kan inte spelas i webbläsaren (filformatet stöds inte)'), { error: true });
  };
  v.onended = () => { if (alive() && next) playVideo(next.id, { list: queue }); };
  $('#mvclose', el).onclick = () => closeRec(rp);
  $('#mvalbum', el)?.addEventListener('click', () => closeRec(rp));
  if (prev) $('#mvprev', el).onclick = () => playVideo(prev.id, { list: queue });
  if (next) $('#mvnext', el).onclick = () => playVideo(next.id, { list: queue });
}
