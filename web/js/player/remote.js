// "Spela på…": fjärrstyrning mellan inloggade webbläsare (servern: server/remote.js).
// Varje inloggad webbläsare är både mottagare och fjärrkontroll över en och samma SSE-anslutning:
//   mottagare  – tar emot kommandon och styr videospelaren (video.js) eller ljudspelaren (audio.js),
//                rapporterar sitt läge till servern (oftare när någon bevakar)
//   styrande   – "Spela på…" på titelsidan och i spelaren, och fjärrkontrollpanelen längst ner (#rbar)
// Webbläsare får inte spela upp med ljud utan ett tryck på sidan: nekas play() visas "Tryck för att starta".
import { $, api, esc, fmtTime, me, store, toast, toastErr, t } from '../core.js';
import { M, applyVolume, seekTo, spokenPos, stopAudio } from '../audio.js';
import { P, closePlayer, play } from './video.js';
import { promptDialog } from '../ui/dialog.js';
import { iconButton, setIconButton } from '../ui/buttons.js';
import { ICON } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { provide } from '../lazy.js';
import * as self from './remote.js';
provide('remote', self); // fasaderna i lazy.js når modulen härifrån

const R = { es: null, uid: null, id: null, name: '', hidden: false, timer: null, last: null, force: false, sentAt: 0, sending: false, watched: false,
  replaced: false, retry: null, tap: null, ctlName: '', ctlAt: 0, ctl: null, ptimer: null };

// ---------- enhetens namn och nyckel ----------
/** Standardnamn från webbläsare och system (som Mitt konto → Enheter), t.ex. "Chrome på Windows" */
export function defaultName(ua = navigator.userAgent) {
  if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|NetCast|BRAVIA|AFT[A-Z]|GoogleTV|Android TV|CrKey|HbbTV/i.test(ua)) return t('TV-webbläsare');
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : t('Webbläsare');
  const o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${o ? t(' på ') + o : ''}`;
}
function devKey() {
  let k = store.get('remote.key', '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(k)) {
    const b = crypto.getRandomValues(new Uint8Array(18));
    k = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    store.set('remote.key', k);
  }
  return k;
}

// ---------- anslutningen ----------
/** Startar efter inloggning (boot). Byte av profil ger en ny anslutning med den nya profilen. */
export function startRemote() {
  if (!me || !window.EventSource) return;
  if (R.es && R.uid === me.id) return;
  stopRemote();
  R.uid = me.id; R.replaced = false;
  R.name = store.get('remote.name', '') || defaultName(); R.hidden = !!store.get('remote.hidden', false);
  const q = new URLSearchParams({ key: devKey(), name: R.name }); if (R.hidden) q.set('hidden', '1');
  const es = R.es = new EventSource('/api/remote/events?' + q);
  const on = (ev, fn) => es.addEventListener(ev, (e) => { if (R.es !== es) return; let d = {}; try { d = JSON.parse(e.data); } catch {} fn(d); });
  on('hello', (d) => { R.id = d.id; R.name = d.name; R.hidden = !!d.hidden; R.force = true; });
  on('command', (d) => onCommand(d));
  on('status', (d) => onStatus(d));
  on('watched', () => { R.force = true; });
  // Samma webbläsare har öppnat BraXhn TV i en annan flik – den tar över (den här ansluter igen när den får fokus)
  on('replaced', () => { es.close(); R.es = null; R.id = null; R.replaced = true; });
  on('closed', () => { es.close(); R.es = null; R.id = null; });
  es.onerror = () => {
    // Nekad (t.ex. utloggad) eller servern borta länge: försök igen om en stund i stället för att ge upp
    if (es.readyState !== 2 || R.es !== es) return;
    R.es = null; R.id = null; clearTimeout(R.retry);
    R.retry = setTimeout(() => { if (me && !R.es && !R.replaced) { R.uid = null; startRemote(); } }, 15000);
  };
  clearInterval(R.timer); R.timer = setInterval(tick, 1000);
}
/** Utloggning: koppla ner och stäng fjärrkontrollen */
export function stopRemote() {
  if (R.es) R.es.close();
  R.es = null; R.id = null; R.uid = null; R.last = null;
  clearInterval(R.timer); R.timer = null; clearTimeout(R.retry);
  closePanel(false); hideTap();
}
window.addEventListener('focus', () => { if (R.replaced && me) { R.replaced = false; R.uid = null; startRemote(); } });

// ---------- mottagare: läget ----------
const trackLabel = (a) => [a.lang || t('Ljud'), a.title, a.codec, a.channels ? a.channels + 'ch' : ''].filter(Boolean).join(' · ');
function snapshot() {
  if (P) {
    const v = $('#vid', P.el); if (!v) return null;
    const it = P.it;
    return { media: 'video', itemId: it.id, position: v.currentTime || 0, duration: it.duration || (isFinite(v.duration) ? v.duration : 0), paused: v.paused,
      blocked: !!R.tap, volume: v.volume, muted: v.muted, audio: P.audio || '', sub: P.sub || '', hasNext: !!it.nextId,
      audios: (it.audio || []).map(a => ({ id: String(a.index), label: trackLabel(a) })), subs: (it.subtitles || []).map(s => ({ id: s.id, label: s.label })) };
  }
  const a = M.audio, bar = $('#mbar');
  if (a && M.cur && bar && !bar.hidden) {
    return { media: 'audio', title: M.cur.title || '', artist: (M.spoken ? M.spoken.sub : M.cur.artist) || '',
      position: M.spoken ? spokenPos() : a.currentTime + (M.offset || 0), duration: M.spoken?.duration || M.cur.duration || (isFinite(a.duration) ? a.duration : 0),
      paused: a.paused, blocked: !!R.tap, volume: +store.get('mvol', 1), muted: a.muted, hasNext: !M.spoken && M.idx + 1 < M.queue.length };
  }
  return null;
}
function changed(a, b) {
  if (!a || !b) return a !== b;
  for (const k of ['media', 'itemId', 'title', 'paused', 'blocked', 'audio', 'sub', 'muted', 'hasNext']) if (a[k] !== b[k]) return true;
  if (Math.abs(a.volume - b.volume) > 0.01) return true;
  const expect = b.position + (b.paused ? 0 : (Date.now() - b.at) / 1000);
  return Math.abs(a.position - expect) > 3; // spolat (eller hackat)
}
function tick() {
  if (!R.id || !R.es || R.sending) return;
  const s = snapshot(), t = Date.now();
  // Bevakad: var 5:e sekund medan något spelas (styrpanelens förlopp), annars bara vid ändring och var 30:e
  const due = s && !s.paused && t - R.sentAt > (R.watched ? 5000 : 30000);
  if (!R.force && !due && !changed(s, R.last)) return;
  R.force = false; R.sending = true; R.sentAt = t; R.last = s && { ...s, at: t };
  api('/remote/state', { method: 'POST', body: { device: R.id, state: s }, bg: true })
    .then(r => { R.watched = !!r?.watched; })
    .catch(() => { R.force = true; }) // skickas igen vid nästa tick (annars kan ett missat "stoppad" stå kvar)
    .finally(() => { R.sending = false; });
}
const reportSoon = () => setTimeout(() => { R.force = true; tick(); }, 400);

// ---------- mottagare: kommandon ----------
const mediaEl = () => P ? $('#vid', P.el) : (M.audio && M.cur ? M.audio : null);
function setSelect(sel, val) {
  const s = P && $(sel, P.el);
  if (!s || ![...s.options].some(o => o.value === String(val)) || s.value === String(val)) return;
  s.value = String(val); s.dispatchEvent(new Event('change'));
}
/** Spela – och om webbläsaren kräver ett tryck först: stor knapp mitt på skärmen */
function tryPlay(el) {
  if (!el) return;
  const p = el.play();
  if (p?.then) p.then(hideTap).catch((e) => { if (e?.name === 'NotAllowedError') showTap(el); });
}
function showTap(el) {
  hideTap();
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'rtap'; b.className = 'rtap';
  b.innerHTML = `${ICON.play}<b>${t('Tryck för att starta')}</b><span>${t('{v}Webbläsaren kräver ett tryck innan något får spelas upp med ljud.', { v: esc(R.ctlName ? `${t('Startad från {ctlName}.', { ctlName: R.ctlName })} ` : '') })}</span>`;
  b.onclick = (e) => { e.stopPropagation(); hideTap(); el.play().catch(() => {}); reportSoon(); };
  (P && el === $('#vid', P.el) ? P.el : document.body).append(b);
  R.tap = b; b.focus({ preventScroll: true });
  el.addEventListener('playing', hideTap, { once: true });
  reportSoon();
}
function hideTap() { if (R.tap) { R.tap.remove(); R.tap = null; } }
function badge() {
  if (!P || !R.ctlName) return;
  let b = $('#rbadge', P.el);
  if (!b) { b = document.createElement('span'); b.id = 'rbadge'; b.className = 'rbadge small'; $('.pbar', P.el)?.append(b); }
  b.textContent = t('Styrs från {ctlName}', { ctlName: R.ctlName });
}
function noteController(name, always) {
  if (always || name !== R.ctlName || Date.now() - R.ctlAt > 600e3) toast(t('Styrs från {name}', { name }));
  R.ctlName = name; R.ctlAt = Date.now();
}
async function onCommand(c) {
  noteController(c.from?.name || t('en annan enhet'), c.cmd === 'play');
  try {
    const el = mediaEl();
    switch (c.cmd) {
      case 'play': {
        await play(c.item, c.position || 0);
        if (!P || P.it.id !== c.item) break;
        if (c.audio) setSelect('#pa', c.audio);
        if (c.sub != null) setSelect('#ps', c.sub);
        tryPlay($('#vid', P.el));
        break;
      }
      case 'pause': el?.pause(); break;
      case 'resume': tryPlay(el); break;
      case 'seek': {
        if (!el) break;
        if (P) { const d = P.it.duration || el.duration || Infinity; el.currentTime = Math.max(0, Math.min(d, c.position ?? el.currentTime + c.delta)); }
        else { const pos = M.spoken ? spokenPos() : el.currentTime + (M.offset || 0); seekTo(Math.max(0, c.position ?? pos + c.delta)); }
        break;
      }
      case 'volume': {
        if (!el) break;
        if (c.level != null) {
          if (P) { el.volume = c.level; el.muted = c.level === 0; store.set('pvol', c.level); }
          else { store.set('mvol', c.level); const s = $('#mvol'); if (s) s.value = c.level; applyVolume(); }
        }
        if (c.muted != null) el.muted = c.muted;
        break;
      }
      case 'audio': setSelect('#pa', c.id); break;
      case 'sub': setSelect('#ps', c.id); break;
      case 'next': if (P) $('#pnext', P.el)?.click(); else if (M.cur) $('#mnext')?.click(); break;
      case 'stop': hideTap(); if (P) closePlayer(); else if (M.cur) stopAudio(); break;
    }
  } catch (e) { toastErr(e); }
  badge();
  reportSoon();
}

// ---------- styrande: välj enhet ----------
const devLabel = (d) => d.mine ? d.name : `${d.name} (${d.user})`;
const devHint = (d) => d.playing ? `${d.playing.paused ? t('Pausad') : t('Spelar')}: ${d.playing.title}` : '';
/**
 * "Spela på…": lista över hushållets anslutna webbläsare.
 * @param {HTMLElement} anchor
 * @param {{ item?: number, position?: number, audio?: string, sub?: string, fromPlayer?: boolean }} [o]
 *   item = titeln som ska spelas där (utan: bara fjärrkontrollen); fromPlayer = stäng den egna spelaren efteråt
 */
export async function openRemotePicker(anchor, o = {}) {
  if (!R.es) startRemote();
  let list;
  try { list = (await api('/remote/devices?me=' + encodeURIComponent(R.id || ''), { bg: true })).devices; }
  catch (e) { return toastErr(e); }
  const others = list.filter(d => !d.self);
  const items = others.map(d => {
    const go = () => o.item ? sendPlay(d, o) : controlDevice(d);
    if (o.item && d.playing) return { label: devLabel(d), hint: devHint(d), icon: '📺', submenu: [
      { label: t('Spela här i stället'), icon: '▶', onSelect: go }, { label: t('Visa fjärrkontrollen'), icon: '⏯', onSelect: () => controlDevice(d) }] };
    return { label: devLabel(d), hint: devHint(d), icon: '📺', onSelect: go };
  });
  if (!items.length) items.push({ label: t('Inga andra enheter är anslutna'), hint: t('Öppna BraXhn TV i webbläsaren på TV:n eller datorn'), disabled: true });
  items.push('separator',
    { label: t('Den här enheten: {v}', { v: R.name || defaultName() }), hint: t('Byt namn'), icon: '✎', onSelect: rename },
    { label: R.hidden ? t('Låt andra enheter spela här') : t('Dölj den här enheten för andra'), icon: R.hidden ? '👁' : '⊘', onSelect: toggleHidden });
  openMenu(anchor, items, { title: o.item ? t('Spela på…') : t('Styr en annan enhet'), label: t('Spela på en annan enhet') });
}
async function rename() {
  const n = await promptDialog(t('Namn på den här enheten'), { title: t('Byt namn'), value: R.name || defaultName(), maxlength: 40, hint: t('T.ex. "Vardagsrums-TV" eller "Jobbdatorn". Syns för de andra i hushållet.') });
  if (n == null || !String(n).trim()) return;
  store.set('remote.name', String(n).trim());
  if (R.id) { try { const r = await api('/remote/devices/' + encodeURIComponent(R.id), { method: 'PUT', body: { name: String(n).trim() }, bg: true }); R.name = r.name; } catch (e) { return toastErr(e); } }
  else R.name = String(n).trim();
  toast(t('Namnet är sparat'));
}
async function toggleHidden() {
  const h = !R.hidden;
  store.set('remote.hidden', h);
  if (R.id) { try { await api('/remote/devices/' + encodeURIComponent(R.id), { method: 'PUT', body: { hidden: h }, bg: true }); } catch (e) { return toastErr(e); } }
  R.hidden = h;
  toast(h ? t('Den här enheten syns inte längre för andra') : t('Andra enheter kan nu spela här'));
}
const sendCmd = (id, body) => api(`/remote/devices/${encodeURIComponent(id)}/command`, { method: 'POST', body: { ...body, from: R.id }, bg: true });
async function sendPlay(d, o) {
  const pl = { item: o.item, position: Math.max(0, o.position || 0) };
  if (o.audio) pl.audio = String(o.audio);
  if (o.sub != null) pl.sub = String(o.sub);
  try { await sendCmd(d.id, { play: pl }); } catch (e) { return toastErr(e); }
  toast(t('Spelas på {name}', { name: d.name }));
  if (o.fromPlayer && P) closePlayer(false);
  controlDevice(d);
}

// ---------- styrande: fjärrkontrollpanelen ----------
function controlDevice(d) {
  if (R.ctl && R.ctl.id !== d.id) closePanel();
  R.ctl = { id: d.id, name: d.name, status: null, at: 0, opts: '' };
  renderPanel();
  if (R.id) api(`/remote/devices/${encodeURIComponent(d.id)}/watch`, { method: 'POST', body: { from: R.id }, bg: true }).catch(toastErr);
}
function onStatus(s) {
  if (!R.ctl || s.id !== R.ctl.id) return;
  R.ctl.status = s; R.ctl.at = Date.now(); R.ctl.name = s.name;
  renderPanel();
}
function closePanel(unwatch = true) {
  const c = R.ctl; R.ctl = null;
  clearInterval(R.ptimer); R.ptimer = null;
  $('#rbar')?.remove(); document.body.classList.remove('hasrbar');
  if (c && unwatch && R.id) api(`/remote/devices/${encodeURIComponent(c.id)}/watch?from=${encodeURIComponent(R.id)}`, { method: 'DELETE', bg: true }).catch(() => {});
}
const ctlPos = () => {
  const st = R.ctl?.status?.state; if (!st) return 0;
  const p = st.position + (st.paused || st.blocked ? 0 : (Date.now() - R.ctl.at) / 1000);
  return st.duration ? Math.min(st.duration, p) : p;
};
function ensurePanel() {
  let bar = $('#rbar');
  if (bar) return bar;
  bar = document.createElement('div'); bar.id = 'rbar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', t('Fjärrkontroll'));
  bar.innerHTML = `<div class="rleft"><span class="ricon">${ICON.remote}</span><div class="rtxt"><b id="rtitle"></b><span class="rsub" id="rdev"></span></div></div>
    <div class="rmid"><div class="row rctl">
        ${iconButton({ icon: 'back10', label: t('10 s bakåt'), id: 'rback' })}
        ${iconButton({ icon: 'play', label: t('Spela'), id: 'rplay', cls: 'primary' })}
        ${iconButton({ icon: 'fwd10', label: t('10 s framåt'), id: 'rfwd' })}
        ${iconButton({ icon: 'next', label: t('Nästa'), id: 'rnext' })}
        ${iconButton({ icon: 'stop', label: t('Stoppa'), id: 'rstop' })}</div>
      <div class="rseek"><span id="rcur" class="rsub">0:00</span><div class="track" id="rtrack" role="slider" tabindex="0" aria-label="Position" aria-valuemin="0"><i id="rfill"></i></div><span id="rdur" class="rsub">0:00</span></div></div>
    <div class="rright"><select id="ra" aria-label="${t('Ljudspår')}" hidden></select><select id="rs" aria-label="${t('Undertexter')}" hidden></select>
      <input type="range" id="rvol" min="0" max="1" step="0.05" aria-label="${t('Volym')}">
      <button type="button" class="ghost small" id="rhere" title="${t('Fortsätt här på den här enheten från samma position')}">${t('Flytta hit')}</button>
</div>
    ${iconButton({ icon: '✕', label: t('Stäng fjärrkontrollen'), id: 'rx' })}`;
  document.body.append(bar); document.body.classList.add('hasrbar');
  const q = (s) => $(s, bar);
  const send = (body) => R.ctl && sendCmd(R.ctl.id, body).catch(toastErr);
  q('#rback').onclick = () => send({ seek: { delta: -10 } });
  q('#rfwd').onclick = () => send({ seek: { delta: 10 } });
  q('#rplay').onclick = () => { const st = R.ctl?.status?.state; send(st && !st.paused && !st.blocked ? { pause: true } : { resume: true }); };
  q('#rnext').onclick = () => send({ next: true });
  q('#rstop').onclick = () => send({ stop: true });
  const seekAt = (x) => { const st = R.ctl?.status?.state, r = q('#rtrack').getBoundingClientRect(); if (st?.duration) send({ seek: Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * st.duration) }); };
  q('#rtrack').onclick = (e) => seekAt(e.clientX);
  q('#rtrack').onkeydown = (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); send({ seek: { delta: e.key === 'ArrowLeft' ? -10 : 10 } }); } };
  let vt; q('#rvol').oninput = (e) => { clearTimeout(vt); vt = setTimeout(() => send({ volume: +e.target.value }), 150); };
  q('#ra').onchange = (e) => send({ audio: e.target.value });
  q('#rs').onchange = (e) => send({ sub: e.target.value });
  q('#rhere').onclick = moveHere;
  q('#rx').onclick = () => closePanel();
  clearInterval(R.ptimer); R.ptimer = setInterval(progress, 1000);
  return bar;
}
function progress() {
  const bar = $('#rbar'), st = R.ctl?.status?.state; if (!bar) return;
  const p = ctlPos(), d = st?.duration || 0;
  $('#rcur', bar).textContent = fmtTime(p); $('#rdur', bar).textContent = fmtTime(d);
  $('#rfill', bar).style.width = d ? Math.min(100, p / d * 100) + '%' : '0';
  $('#rtrack', bar).setAttribute('aria-valuemax', String(Math.round(d))); $('#rtrack', bar).setAttribute('aria-valuenow', String(Math.round(p)));
}
function renderPanel() {
  const c = R.ctl; if (!c) return;
  const bar = ensurePanel(), q = (s) => $(s, bar);
  const s = c.status, st = s?.state, online = !s || s.online;
  q('#rtitle').textContent = !online ? t('{name} är inte ansluten', { name: c.name }) : st ? (st.title || t('Spelar')) + (st.artist ? ` – ${st.artist}` : '') : s ? t('Inget spelas') : t('Ansluter…');
  q('#rdev').textContent = !online ? t('Öppna BraXhn TV på enheten igen') : st?.blocked ? t('Väntar – tryck på skärmen på {name}', { name: c.name }) : t('På {name}{v}', { name: c.name, v: st?.paused ? t(' · pausad') : '' });
  const has = online && !!st;
  for (const id of ['#rback', '#rfwd', '#rplay', '#rstop', '#rvol', '#ra', '#rs']) q(id).disabled = !has;
  q('#rnext').disabled = !has || !st.hasNext;
  setIconButton(q('#rplay'), has && !st.paused && !st.blocked ? 'pause' : 'play', has && !st.paused && !st.blocked ? t('Pausa') : t('Spela'));
  q('#rhere').hidden = !(has && st.media === 'video' && st.itemId);
  if (has && document.activeElement !== q('#rvol')) q('#rvol').value = st.muted ? 0 : st.volume;
  // Spårlistorna byggs bara om när de ändras (annars hoppar valet medan man väljer)
  const opts = has && st.media === 'video' ? JSON.stringify([st.audios, st.subs]) : '';
  if (opts !== c.opts) {
    c.opts = opts;
    const auds = has ? st.audios || [] : [], subs = has ? st.subs || [] : [];
    q('#ra').innerHTML = auds.map(a => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
    q('#ra').hidden = auds.length < 2;
    q('#rs').innerHTML = `<option value="">${t('Inga undertexter')}</option>` + subs.map(x => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
    q('#rs').hidden = !subs.length;
  }
  if (has && st.media === 'video') { if (document.activeElement !== q('#ra')) q('#ra').value = st.audio; if (document.activeElement !== q('#rs')) q('#rs').value = st.sub; }
  progress();
}
/** Flytta hit: stoppa på den andra enheten och fortsätt här från samma position och med samma spår */
async function moveHere() {
  const c = R.ctl, st = c?.status?.state;
  if (!st || st.media !== 'video' || !st.itemId) return;
  const pos = ctlPos(), { itemId, audio, sub } = st;
  try { await sendCmd(c.id, { stop: true }); } catch (e) { toastErr(e); }
  closePanel();
  await play(itemId, pos);
  if (!P || P.it.id !== itemId) return;
  if (audio) setSelect('#pa', audio);
  setSelect('#ps', sub || '');
}
/** Knapp för "Spela på…" (titelsidan, spelaren) */
