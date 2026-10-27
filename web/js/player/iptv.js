// IPTV i spelaren: kanalbyte (▲/▼, Page Up/Down, Channel Up/Down på fjärrkontrollen, sifferknappar), favorit per profil,
// automatisk återanslutning när strömmen står still, förstart av nästa kanal (snabbt kanalbyte), och en spelare för
// catch-up och filmer/avsnitt (HLS-session med egen tidslinje: spolning utanför det som hunnit skrivas startar om
// sessionen från den tidpunkten). Påminnelser visas som toast medan sidan är öppen.
// Laddas med vyerna live/epg/vod (inte vid start).
import { $, act, api, esc, fmtTime, hhmm, me, toast, toastErr } from '../core.js';
import { M, musicSession, videoSession } from '../audio.js';
import { overlayOpen } from './overlay.js';
import { closeAllPlayers, loadHls } from './video.js';
import { LP, liveHooks, playLive, setRec, closeRec, RP } from './live.js';
import { screenPing } from '../screentime.js';
import { iconButton, setIconButton } from '../ui/buttons.js';

// ---------- kanallistan för kanalbyte ----------
let zap = [], zapAt = 0;
/** Ordningen för ▲/▼ (TV-guidens filtrerade lista). Utan lista: alla kanaler. */
export function setZapList(list) { zap = list.slice(); zapAt = Date.now(); }
async function zapList() {
  if (zap.length && Date.now() - zapAt < 600e3) return zap;
  try { const d = await api('/iptv/channels', { bg: true }); zap = d.channels; zapAt = Date.now(); } catch {}
  return zap;
}
export const zapCached = () => zap;
async function zapTo(dir) {
  const cur = LP?.ch; if (!cur) return;
  const l = await zapList(); if (!l.length) return;
  const i = l.findIndex(c => c.id === cur.id);
  const next = l[((i < 0 ? 0 : i + dir) % l.length + l.length) % l.length];
  if (next && next.id !== cur.id) playLive(next);
}
async function zapNumber(n) {
  const l = await zapList();
  const ch = l.find(c => String(c.number) === n) || l[+n - 1];
  if (ch) playLive(ch); else toast('Kanal ' + n + ' finns inte');
}

// ---------- tillägg i livespelaren ----------
liveHooks.add((lp) => {
  const bar = $('.pbar', lp.el), stat = $('#lstat', lp.el);
  if (!bar) return;
  const known = zap.find(c => c.id === lp.ch.id);
  const fav = known ? known.favorite : !!lp.ch.favorite;
  const box = document.createElement('span');
  box.className = 'iptvbar';
  box.innerHTML = iconButton({ icon: '▲', label: 'Föregående kanal (Page Up)', id: 'lzu' }) + iconButton({ icon: '▼', label: 'Nästa kanal (Page Down)', id: 'lzd' })
    + iconButton({ icon: fav ? '★' : '☆', label: 'Favorit', id: 'lfav', pressed: fav })
    + `<a class="btn ghost small" href="#/epg" id="lguide">TV-guide</a>`;
  bar.insertBefore(box, stat);
  $('#lzu', box).onclick = () => zapTo(-1);
  $('#lzd', box).onclick = () => zapTo(1);
  const fb = $('#lfav', box);
  fb.onclick = act(async () => {
    const on = fb.getAttribute('aria-pressed') !== 'true';
    await api('/iptv/favorites/' + lp.ch.id, { method: 'PUT', body: { on }, bg: true });
    fb.setAttribute('aria-pressed', String(on)); setIconButton(fb, on ? '★' : '☆', 'Favorit');
    const z = zap.find(c => c.id === lp.ch.id); if (z) z.favorite = on;
    toast(on ? `${lp.ch.name} är en favorit` : `${lp.ch.name} är inte längre en favorit`);
  });
  // Återanslutning: står bilden still i 10 s trots att den ska spela laddas strömmen om
  let lastT = -1, still = 0, tries = 0;
  const watch = setInterval(() => {
    if (LP !== lp) return clearInterval(watch);
    const v = lp.v;
    if (v.paused || v.seeking || v.readyState === 0 && !lp.hls) { still = 0; lastT = v.currentTime; return; }
    if (Math.abs(v.currentTime - lastT) < 0.05) still += 2; else { still = 0; tries = 0; }
    lastT = v.currentTime;
    if (still >= 10 && tries < 5) {
      still = 0; tries++;
      if (stat) stat.textContent = 'Återansluter…';
      if (lp.hls) { const u = lp.hls.url; try { lp.hls.stopLoad(); lp.hls.loadSource(u); lp.hls.startLoad(); } catch {} }
      else if (v.src) { const u = v.src; v.src = u; v.play().catch(() => {}); }
      v.addEventListener('playing', () => { if (LP === lp && stat) stat.textContent = ''; }, { once: true });
    }
  }, 2000);
  // Förstart av nästa kanal efter en stund (servern gör det bara när källan har en anslutning över)
  setTimeout(async () => {
    if (LP !== lp) return;
    const l = await zapList(); const i = l.findIndex(c => c.id === lp.ch.id);
    const next = i >= 0 ? l[(i + 1) % l.length] : null;
    if (next && next.id !== lp.ch.id && LP === lp) api(`/iptv/channels/${next.id}/prestart`, { method: 'POST', bg: true }).catch(() => {});
  }, 8000);
});
let digits = '', digitTimer = 0;
document.addEventListener('keydown', (e) => {
  if (!LP || document.querySelector('dialog[open]') || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if (typing) return;
  const free = !t || t === document.body || t === LP.el || t.id === 'lvid';
  if (e.key === 'PageUp' || e.key === 'ChannelUp' || (e.key === 'ArrowUp' && free && t?.id !== 'lvid')) { e.preventDefault(); zapTo(-1); }
  else if (e.key === 'PageDown' || e.key === 'ChannelDown' || (e.key === 'ArrowDown' && free && t?.id !== 'lvid')) { e.preventDefault(); zapTo(1); }
  else if (/^[0-9]$/.test(e.key) && free) {
    digits = (digits + e.key).slice(-4);
    const stat = $('#lstat', LP.el); if (stat) stat.textContent = 'Kanal ' + digits + '…';
    clearTimeout(digitTimer);
    digitTimer = setTimeout(() => { const n = digits; digits = ''; zapNumber(n); }, 1500);
  }
});

// ---------- catch-up och VOD ----------
/**
 * Spelare för en HLS-session eller en direkt fil. o:
 *  title, sub, kind ('catchup' | 'movie' | 'episode'), key (skärmtid), duration (hela längden, s),
 *  open(ss) → Promise<svar från /play eller /catchup> (url, offset, direct, sid, hls),
 *  position (fortsätt från), save(pos, dur) (framsteg), live (kanal: knappen "Live" för pågående program)
 */
export async function playSession(o) {
  let r = await o.open(Math.max(0, o.position || 0));
  closeAllPlayers();
  if (M.audio && !M.audio.paused) M.audio.pause();
  const el = $('#player');
  el.innerHTML = `<video id="svid" autoplay playsinline></video>
    <div class="pbar"><button class="ghost small" id="sclose">← Tillbaka</button><span class="title">${esc(o.title)}${o.sub ? ` <span class="muted small">${esc(o.sub)}</span>` : ''}</span>
      <span class="muted small" id="sstat">Startar…</span>${o.live ? '<button class="small liveind" id="slive">● Till live</button>' : ''}</div>
    <div class="sbar">${iconButton({ icon: '↺', label: 'Bakåt 30 sekunder', id: 'sb30' })}${iconButton({ icon: 'pause', label: 'Pausa', id: 'spp' })}${iconButton({ icon: '↻', label: 'Framåt 30 sekunder', id: 'sf30' })}
      <span class="small" id="stime">0:00</span><input type="range" id="sseek" min="0" max="${Math.max(1, Math.round(o.duration || 1))}" step="1" value="0" aria-label="Tidslinje">
      <span class="small" id="sdur">${o.duration ? fmtTime(o.duration) : ''}</span>${iconButton({ icon: 'full', label: 'Helskärm', id: 'sfull' })}</div>`;
  overlayOpen(el);
  const v = $('#svid', el), stat = $('#sstat', el), seek = $('#sseek', el);
  const rp = { el, v, hls: null, sid: null, offset: 0, direct: false, closed: false };
  setRec(rp);
  const cur = () => RP === rp && !rp.closed;
  const setStat = (t) => { if (cur()) stat.textContent = t; };
  videoSession(v);
  const pos = () => rp.offset + (v.currentTime || 0);
  const total = () => o.duration || (rp.direct && isFinite(v.duration) ? v.duration : 0);
  const stopSession = () => { if (rp.sid) { const sid = rp.sid; rp.sid = null; api(`/iptv/play/${sid}/stop`, { method: 'POST', bg: true }).catch(() => {}); } };
  rp.onClose = () => {
    rp.closed = true; clearInterval(rp.tick);
    if (o.save && pos() > 5) o.save(pos(), total());
    if (rp.hls) { rp.hls.destroy(); rp.hls = null; }
    stopSession();
    musicSession();
  };
  $('#sclose', el).onclick = () => closeRec(rp);
  const load = async (res, startAt = 0) => {
    if (rp.hls) { rp.hls.destroy(); rp.hls = null; }
    stopSession();
    rp.sid = res.sid || null; rp.offset = res.direct ? 0 : (res.offset || 0); rp.direct = !!res.direct;
    if (!o.duration && res.duration) o.duration = res.duration;
    setStat('Startar…');
    if (res.direct || (v.canPlayType('application/vnd.apple.mpegurl') && !window.MediaSource)) {
      v.src = res.url;
      if (res.direct && startAt > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = startAt; }, { once: true });
    } else {
      const Hls = await loadHls();
      if (!cur()) return;
      const hls = rp.hls = new Hls({ backBufferLength: 120, enableWorker: false, xhrSetup: (x) => { x.withCredentials = true; } });
      let recovers = 0;
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal || rp.hls !== hls || !cur()) return;
        // Bilden/ljudet går inte att avkoda här: försök ett par gånger, sedan ett tydligt besked (inte en evig slinga)
        if (d.type === 'mediaError' && ++recovers > 3) { setStat('Formatet kan inte spelas i den här webbläsaren'); hls.destroy(); rp.hls = null; return; }
        if (d.response?.code === 409) { setStat('Alla anslutningar till källan används'); hls.destroy(); rp.hls = null; }
        else if (d.response?.code >= 400 && d.response?.code < 600 && d.details === 'manifestLoadError') { setStat('Kunde inte startas'); hls.destroy(); rp.hls = null; }
        else if (d.type === 'networkError') setTimeout(() => { if (rp.hls === hls) hls.startLoad(); }, 1500);
        else if (d.type === 'mediaError') hls.recoverMediaError();
      });
      hls.loadSource(res.url); hls.attachMedia(v);
    }
    v.play().catch(() => {});
  };
  // Direktspelad fil som webbläsaren inte kan avkoda (t.ex. HEVC i MP4): samma film via servern (HLS)
  v.addEventListener('error', act(async () => {
    if (!cur() || !rp.direct || !o.openHls) return;
    const at = v.currentTime || o.position || 0;
    setStat('Formatet stöds inte direkt – startar via servern…');
    await load(await o.openHls(at));
  }));
  v.addEventListener('playing', () => setStat(''));
  v.addEventListener('waiting', () => setStat('Laddar…'));
  // Spola: inom det som hunnit skrivas lokalt, annars en ny session från den tidpunkten
  let seekGen = 0;
  const seekTo = act(async (t) => {
    const len = total();
    t = Math.max(0, len ? Math.min(len - 3, t) : t);
    const sk = v.seekable, end = sk.length ? sk.end(sk.length - 1) : 0;
    if (rp.direct || (t >= rp.offset && t - rp.offset <= end - 1)) { v.currentTime = t - rp.offset; return; }
    const g = ++seekGen;
    setStat('Spolar…');
    const res = await o.open(Math.floor(t));
    if (g !== seekGen || !cur()) return;
    await load(res);
  });
  $('#sb30', el).onclick = () => seekTo(pos() - 30);
  $('#sf30', el).onclick = () => seekTo(pos() + 30);
  const pp = $('#spp', el);
  pp.onclick = () => { v.paused ? v.play().catch(() => {}) : v.pause(); };
  v.addEventListener('click', () => pp.click());
  v.addEventListener('play', () => setIconButton(pp, 'pause', 'Pausa'));
  v.addEventListener('pause', () => setIconButton(pp, 'play', 'Spela'));
  $('#sfull', el).onclick = () => { document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : el.requestFullscreen?.().catch(() => {}); };
  let dragging = false;
  seek.addEventListener('input', () => { dragging = true; $('#stime', el).textContent = fmtTime(+seek.value); });
  seek.addEventListener('change', () => { dragging = false; seekTo(+seek.value); });
  if (o.live) $('#slive', el).onclick = () => playLive(o.live);
  if (o.key) screenPing(v, o.key, cur, () => closeRec(rp));
  let lastSave = Date.now();
  rp.tick = setInterval(() => {
    if (!cur()) return clearInterval(rp.tick);
    const len = total();
    if (len && +seek.max !== Math.round(len)) { seek.max = Math.round(len); $('#sdur', el).textContent = fmtTime(len); }
    if (!dragging) { seek.value = Math.round(pos()); $('#stime', el).textContent = fmtTime(pos()); }
    if (o.save && !v.paused && Date.now() - lastSave > 10000) { lastSave = Date.now(); o.save(pos(), len); }
  }, 1000);
  el.addEventListener('keydown', (e) => {
    if (e.target === seek || e.target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); pp.click(); }
    else if (e.key === 'ArrowLeft' || e.key === 'j') { e.preventDefault(); seekTo(pos() - 10); }
    else if (e.key === 'ArrowRight' || e.key === 'l') { e.preventDefault(); seekTo(pos() + 10); }
  });
  await load(r, o.position || 0);
  pp.focus();
  return rp;
}

/** Spela ett redan sänt (eller pågående) program från början via kanalens catch-up */
export function playCatchup(p, { offset = 0 } = {}) {
  const ch = zap.find(c => c.id === p.channelId) || p.channel || { id: p.channelId, name: '' };
  return playSession({
    title: p.title, sub: `${ch.name ? ch.name + ' · ' : ''}${hhmm(p.start)}–${hhmm(p.stop)}`, kind: 'catchup', key: 'c:' + p.id, duration: p.stop - p.start, position: offset,
    open: (ss) => api(`/iptv/programs/${p.id}/catchup?offset=${Math.floor(ss)}`, { method: 'POST', bg: true }),
    live: p.stop > Date.now() / 1000 ? { ...ch, id: p.channelId } : null,
  }).catch(toastErr);
}
/** Film eller avsnitt från en Xtream-källa (fortsätter där man var) */
export function playVod(kind, id, { title = '', sub = '', duration = null, position = 0 } = {}) {
  const base = kind === 'episode' ? `/iptv/episodes/${id}/play` : `/iptv/vod/${id}/play`;
  return playSession({
    title, sub, kind, key: (kind === 'episode' ? 'e:' : 'v:') + id, duration, position,
    open: (ss) => api(`${base}?ss=${Math.floor(ss)}`, { method: 'POST', bg: true }),
    openHls: (ss) => api(`${base}?hls=1&ss=${Math.floor(ss)}`, { method: 'POST', bg: true }),
    save: (pos, dur) => api('/iptv/progress', { method: 'POST', body: { kind, id, position: Math.round(pos), duration: dur ? Math.round(dur) : null }, bg: true }).catch(() => {}),
  }).catch(toastErr);
}

// ---------- påminnelser ----------
const shown = new Set();
async function checkReminders() {
  if (!me || document.hidden) return;
  try {
    const d = await api('/iptv/reminders?due=1', { bg: true });
    for (const r of d.reminders) {
      const k = r.channelId + ':' + r.start;
      if (shown.has(k)) continue;
      shown.add(k);
      const mins = Math.round((r.start - Date.now() / 1000) / 60);
      toast(`${r.title} börjar ${mins > 0 ? `om ${mins} min` : 'nu'} på ${r.channel}`, { action: { label: 'Titta', onClick: () => playLive({ id: r.channelId, name: r.channel, number: r.number }) } });
    }
  } catch {}
}
setInterval(checkReminders, 30000);
setTimeout(checkReminders, 3000);
