// Vy: Nedladdat – det som sparats offline i webbläsaren (js/offline.js), med en egen enkel spelare som fungerar helt
// utan servern. Startar appen utan kontakt med servern (app.js → offlineStart) visas den senast inloggade profilens
// nedladdningar; i övrigt kräver vyn inloggning som alla andra.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, esc, fmtDur, fmtSize, fmtTime, main, me, onLeave, routeGen, sxe, toast, views, t } from '../core.js';
import * as off from '../offline.js';
import { iconButton } from '../ui/buttons.js';
import { confirmDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';

let offlineMode = false;
/** app.js: servern svarade inte vid start – visa Nedladdat för den senast inloggade profilen */
export function offlineStart() {
  offlineMode = true;
  if (location.hash !== '#/downloads') location.hash = '#/downloads';
  else import('../router.js').then(m => m.route());
}
const posters = new Map(); // nyckel -> blob:-adress (släpps när vyn lämnas)
const GROUPS = [['movie', t('Filmer')], ['episode', t('Serier')], ['album', t('Musik')], ['book', t('Ljudböcker')]];

views.downloads = async () => {
  if (!me && !offlineMode) { location.hash = '#/login'; return; }
  const who = me || off.lastProfile();
  if (!who) {
    main.innerHTML = emptyState({ icon: '⤓', title: t('Ingen kontakt med servern'), text: t('Logga in när servern svarar igen för att se det du sparat offline.'), action: { label: t('Försök igen'), id: 'reconn', kind: 'primary' } });
    $('#reconn')?.addEventListener('click', () => location.reload());
    return;
  }
  const draw = () => render(who);
  const onChange = () => { if (!$('.dlplayer')) draw(); };
  const onProgress = (ev) => {
    const r = $(`[data-dl="${CSS.escape(ev.detail.key)}"] [data-prog]`);
    if (r) r.textContent = progressText(off.find(ev.detail.key), ev.detail.got);
    const bar = $(`[data-dl="${CSS.escape(ev.detail.key)}"] progress`);
    if (bar && ev.detail.size) bar.value = ev.detail.got / ev.detail.size;
  };
  off.bus.addEventListener('change', onChange); off.bus.addEventListener('progress', onProgress);
  onLeave(() => { off.bus.removeEventListener('change', onChange); off.bus.removeEventListener('progress', onProgress); closePlayer(false); for (const u of posters.values()) URL.revokeObjectURL(u); posters.clear(); });
  await draw();
  if (me) { off.pump(); off.syncPositions(); }
};

function progressText(e, got = e?.got || 0) {
  if (!e) return '';
  if (e.state === 'preparing') return t('Förbereds på servern{v}', { v: e.prep ? ` · ${e.prep} %` : '' });
  if (e.state === 'queued') return t('I kön');
  if (e.state === 'paused') return t('Pausad{v}', { v: got ? ' · ' + fmtSize(got) + (e.size ? ' av ' + fmtSize(e.size) : '') : '' });
  if (e.state === 'error') return e.error || t('Något gick fel');
  if (e.state === 'downloading') {
    const parts = e.parts?.length > 1 ? ` ${t('· {v} av {partsN}', { v: e.parts.filter(p => p.done).length, partsN: e.parts.length })}` : '';
    return t('Laddar ned · {got}{v}{parts}', { got: fmtSize(got), v: e.size ? ' av ' + fmtSize(e.size) : '', parts });
  }
  return [e.size ? fmtSize(e.size) : '', e.q ? qLabel(e.q) : '', e.duration ? fmtDur(e.duration) : ''].filter(Boolean).join(' · ');
}
const qLabel = (q) => ({ src: 'original', orig: t('full upplösning'), '1080': '1080p', '720': '720p', '480': '480p' }[q] || q);
const titleOf = (e) => e.kind === 'episode' ? `${e.season != null ? sxe(e) + ' · ' : ''}${e.title}` : e.title;
const leftOf = (e) => e.position > 30 && e.duration && !e.finished ? ` ${t('· {v} kvar', { v: fmtTime(Math.max(0, e.duration - e.position)) })}` : '';

async function render(who) {
  const g = routeGen;
  const l = off.list();
  const s = await off.storageInfo();
  if (g !== routeGen) return; // användaren har gått vidare
  const offline = !me || navigator.onLine === false;
  const pend = off.pendingCount();
  const head = `<div class="toolbar"><h1>${t('Nedladdat')}</h1><span class="muted">${l.length ? `${l.length} ${l.length === 1 ? t('sparad') : t('sparade')}` : ''}</span>
    ${l.length ? t('<button class="ghost small" id="dlclear">Ta bort allt</button>') : ''}</div>
    ${!me ? `<div class="dlbanner" role="status">${t('<b>Ingen kontakt med servern.</b> Här är det {name} har sparat offline.', { name: esc(who.name) })} <button class="ghost small" id="reconn">${t('Försök ansluta igen')}</button></div>` : ''}
    <p class="muted small" id="dlspace">${s.quota ? t('Använder {usage} av {quota} i webbläsaren', { usage: fmtSize(s.usage), quota: fmtSize(s.quota) }) : ''}${s.quota && !s.persisted ? t(' · webbläsaren kan rensa nedladdningarna om utrymmet tar slut') : ''}${pend ? ` ${t('· {pend} {v} skickas till servern{v2}', { pend, v: pend === 1 ? 'position' : t('positioner'), v2: offline ? t(' när den svarar') : '' })}` : ''}</p>`;
  if (!off.supported()) {
    main.innerHTML = head + emptyState({ icon: '⤓', title: t('Inte tillgängligt här'), text: t('Att spara offline kräver att BraXhn TV öppnas via HTTPS (eller på den här datorn).') });
    return;
  }
  if (!l.length) {
    main.innerHTML = head + emptyState({ icon: '⤓', title: t('Inget sparat offline ännu'), text: t('Välj ”Spara offline” på en film, ett avsnitt, ett album eller en ljudbok – den kan sedan spelas här utan nät.') });
    bindHead();
    return;
  }
  let html = head;
  for (const [kind, label] of GROUPS) {
    const items = l.filter(e => e.kind === kind);
    if (!items.length) continue;
    if (kind === 'episode') {
      // Serierna i bokstavsordning, avsnitten i ordning
      const shows = new Map();
      for (const e of items.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))) {
        const k = e.show?.id ?? e.sub; if (!shows.has(k)) shows.set(k, { title: e.show?.title || e.sub || t('Serie'), eps: [] }); shows.get(k).eps.push(e);
      }
      html += `<section class="section"><h2>${label}</h2>${[...shows.values()].sort((a, b) => a.title.localeCompare(b.title, 'sv')).map(sh => `<h3 class="dlshow">${esc(sh.title)}</h3><div class="dllist">${sh.eps.map(row).join('')}</div>`).join('')}</section>`;
    } else html += `<section class="section"><h2>${label}</h2><div class="dllist">${items.sort((a, b) => b.added - a.added).map(row).join('')}</div></section>`;
  }
  main.innerHTML = html;
  bindHead();
  for (const el of $$('[data-dl]')) {
    const key = el.dataset.dl;
    el.querySelector('[data-a=play]')?.addEventListener('click', () => openPlayer(off.find(key)));
    el.querySelector('[data-a=pause]')?.addEventListener('click', () => off.pause(key));
    el.querySelector('[data-a=resume]')?.addEventListener('click', () => { if (!me) return toast(t('Fortsätter när servern svarar')); off.resumeEntry(key); });
    el.querySelector('[data-a=del]')?.addEventListener('click', () => off.removeEntry(key, true));
    const img = el.querySelector('img[data-poster]');
    if (img) {
      const set = (u) => { if (u) { img.src = u; img.hidden = false; } };
      if (posters.has(key)) set(posters.get(key));
      else off.posterUrl(off.find(key)).then(u => { if (u) { posters.set(key, u); set(u); } });
    }
  }
}
function bindHead() {
  $('#reconn')?.addEventListener('click', () => location.reload());
  $('#dlclear')?.addEventListener('click', async () => {
    if (!await confirmDialog(t('Ta bort allt som sparats offline i den här webbläsaren?'), { okLabel: t('Ta bort allt'), danger: true })) return;
    await off.removeAll(); toast(t('Nedladdningarna är borttagna'));
  });
}
function row(e) {
  const done = e.state === 'done', active = ['queued', 'preparing', 'downloading'].includes(e.state);
  const tm = titleOf(e);
  const sub = e.kind === 'episode' ? '' : e.sub;
  const frac = e.size ? (e.got || 0) / e.size : 0;
  return `<div class="dlrow${done ? '' : ' pending'}" data-dl="${esc(e.key)}">
    <div class="dlart ${e.kind === 'album' || e.kind === 'book' ? 'sq' : e.kind === 'episode' ? 'land' : ''}"><img data-poster alt="" hidden></div>
    <div class="dlinfo"><b>${esc(tm)}</b>${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}
      <div class="muted small" data-prog${e.state === 'error' ? ' role="alert"' : ''}>${esc(progressText(e))}${done ? esc(leftOf(e)) : ''}</div>
      ${active && e.state === 'downloading' ? `<progress max="1" value="${frac}" aria-label="${t('Nedladdat av {v}', { v: esc(tm) })}"></progress>` : ''}
      ${done && e.position > 30 && e.duration && !e.finished ? `<div class="pbar" aria-hidden="true"><i style="width:${Math.min(100, e.position / e.duration * 100).toFixed(1)}%"></i></div>` : ''}</div>
    <div class="dlacts">
      ${done ? `<button class="primary small" data-a="play">${e.position > 30 && !e.finished ? t('▶ Fortsätt') : t('▶ Spela')}</button>` : ''}
      ${active ? iconButton({ icon: '⏸', label: t('Pausa nedladdningen av {v}', { v: tm }), data: { a: 'pause' } }) : ''}
      ${e.state === 'paused' || e.state === 'error' ? `<button class="ghost small" data-a="resume">${e.state === 'error' ? t('Försök igen') : t('Fortsätt')}</button>` : ''}
      ${iconButton({ icon: '✕', label: t('Ta bort {v} från Nedladdat', { v: tm }), data: { a: 'del' } })}
    </div></div>`;
}

// ---------- spelaren ----------
// En egen, enkel spelare (webbläsarens kontroller): den behöver inget från servern. Video: film/avsnitt med sparade
// undertexter; ljud: album (låtlista) och ljudböcker (filer i följd, kapitel, hastighet).
let P = null; // { e, el, media, urls[], part, save() }
function closePlayer(redraw = true) {
  if (!P) return;
  const p = P; P = null;
  try { p.save?.(true); } catch {}
  p.media.pause(); p.media.removeAttribute('src'); p.media.load?.();
  for (const u of p.urls) URL.revokeObjectURL(u);
  document.removeEventListener('keydown', p.key);
  p.el.remove();
  document.documentElement.classList.remove('dlplaying');
  p.opener?.focus?.({ preventScroll: true });
  if (redraw && document.querySelector('[data-dl]')) render(me || off.lastProfile());
}
async function openPlayer(e) {
  if (!e) return;
  closePlayer(false);
  const video = e.kind === 'movie' || e.kind === 'episode';
  const el = document.createElement('div');
  el.className = 'dlplayer' + (video ? ' video' : ' audio');
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', t('Spelar {e}', { e: titleOf(e) }));
  el.innerHTML = `<div class="dlbar"><b>${esc(titleOf(e))}</b><span class="muted small">${esc(e.kind === 'episode' ? e.show?.title || '' : e.sub || '')}</span>
    ${e.kind === 'book' ? `<label class="small muted">${t('Hastighet')} <select id="dlspeed">${[0.75, 1, 1.25, 1.5, 1.75, 2].map(v => `<option value="${v}"${v === (e.speed || 1) ? ' selected' : ''}>${String(v).replace('.', ',')}×</option>`).join('')}</select></label>` : ''}
    ${iconButton({ icon: '✕', label: t('Stäng spelaren (Esc)'), id: 'dlclose' })}</div>
    ${video ? '<video id="dlmedia" controls playsinline autoplay preload="auto"></video>' : `<div class="dlaudio"><img id="dlcover" alt="" hidden><audio id="dlmedia" controls autoplay preload="auto"></audio><ol class="dltracks" id="dltracks"></ol></div>`}
    <p class="muted small" id="dlmsg" role="status"></p>`;
  document.body.append(el);
  document.documentElement.classList.add('dlplaying');
  const media = el.querySelector('#dlmedia');
  P = { e, el, media, urls: [], part: 0, opener: document.activeElement };
  P.key = (ev) => { if (ev.key === 'Escape' && !document.querySelector('dialog[open]')) { ev.preventDefault(); closePlayer(); } };
  document.addEventListener('keydown', P.key);
  el.querySelector('#dlclose').onclick = () => closePlayer();
  el.querySelector('#dlclose').focus();
  const msg = (t) => { const m = el.querySelector('#dlmsg'); if (m) m.textContent = t; };
  media.addEventListener('error', () => msg(video ? t('Webbläsaren kan inte spela filen. Ta bort den och ladda ned igen i en lägre kvalitet (omkodad MP4).') : t('Webbläsaren kan inte spela filen.')));
  try {
    if (video) await playVideo(P);
    else if (e.kind === 'book') await playBook(P);
    else await playAlbum(P);
  } catch (err) { msg(err.message || String(err)); }
}
const blobUrl = async (p, i) => { const u = URL.createObjectURL(await off.partBlob(p.e, i)); p.urls.push(u); return u; };
function saver(p, posOf) {
  let last = 0;
  const save = (force = false, done = false) => {
    if (P !== p && !force) return;
    const pos = posOf();
    if (!force && Math.abs(pos - last) < 10) return;
    last = pos; off.savePosition(p.e.key, pos, done);
  };
  p.save = (force) => { if (!p.ended) save(force); };
  p.media.addEventListener('timeupdate', () => save());
  p.media.addEventListener('pause', () => save(true));
  return save;
}
async function playVideo(p) {
  const { e, media } = p;
  media.src = await blobUrl(p, 0);
  for (const s of await off.subUrls(e)) {
    p.urls.push(s.url);
    const tm = document.createElement('track');
    Object.assign(tm, { kind: 'subtitles', src: s.url, label: s.label || s.lang || t('Undertext'), srclang: (s.lang || '').slice(0, 3) });
    if (e.defSub && s.id === e.defSub) tm.default = true;
    media.append(tm);
  }
  const start = e.position > 30 && !e.finished ? e.position : 0;
  if (start) media.addEventListener('loadedmetadata', () => { media.currentTime = start; }, { once: true });
  const save = saver(p, () => media.currentTime);
  media.addEventListener('ended', () => {
    p.ended = true; save(true, true);
    // Nästa nedladdade avsnitt i samma serie
    const next = e.kind === 'episode' && off.list().filter(x => x.kind === 'episode' && x.state === 'done' && (x.show?.id ?? x.sub) === (e.show?.id ?? e.sub))
      .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))
      .find(x => (x.season ?? 0) > (e.season ?? 0) || ((x.season ?? 0) === (e.season ?? 0) && (x.episode ?? 0) > (e.episode ?? 0)));
    if (next) { toast(t('Nästa: {next}', { next: titleOf(next) })); openPlayer(next); }
  });
}
async function playBook(p) {
  const { e, media, el } = p;
  const cover = await off.posterUrl(e);
  if (cover) { p.urls.push(cover); const img = el.querySelector('#dlcover'); img.src = cover; img.hidden = false; }
  const parts = e.parts;
  const posNow = () => (parts[p.part]?.offset || 0) + (media.currentTime || 0);
  const load = async (pos) => {
    let i = parts.findIndex((x, j) => pos < (x.offset || 0) + (x.duration || 0) || j === parts.length - 1);
    if (i < 0) i = 0;
    p.part = i;
    media.src = await blobUrl(p, i);
    const at = Math.max(0, pos - (parts[i].offset || 0));
    media.addEventListener('loadedmetadata', () => { if (at > 0.5) media.currentTime = at; media.playbackRate = +(el.querySelector('#dlspeed')?.value || e.speed || 1); }, { once: true });
  };
  const ch = e.chapters?.length ? e.chapters : parts.map((x, i) => ({ title: t('Del {v}', { v: i + 1 }), start: x.offset || 0, end: (x.offset || 0) + (x.duration || 0) }));
  el.querySelector('#dltracks').innerHTML = ch.map((c, i) => `<li><button class="ghost small" data-ch="${i}">${esc(c.title || t('Kapitel {v}', { v: i + 1 }))} <span class="muted">${fmtTime(c.start)}</span></button></li>`).join('');
  el.querySelectorAll('[data-ch]').forEach(b => b.onclick = () => load(ch[+b.dataset.ch].start + 0.01).then(() => media.play().catch(() => {})));
  el.querySelector('#dlspeed').onchange = (ev) => { media.playbackRate = +ev.target.value; };
  const save = saver(p, posNow);
  media.addEventListener('ended', async () => {
    if (p.part < parts.length - 1) { await load((parts[p.part + 1].offset || 0) + 0.01); media.play().catch(() => {}); }
    else { p.ended = true; save(true, true); }
  });
  await load(e.position > 30 && !e.finished ? e.position : 0);
}
async function playAlbum(p) {
  const { e, media, el } = p;
  const cover = await off.posterUrl(e);
  if (cover) { p.urls.push(cover); const img = el.querySelector('#dlcover'); img.src = cover; img.hidden = false; }
  const list = el.querySelector('#dltracks');
  list.innerHTML = e.parts.map((t, i) => `<li><button class="ghost small" data-t="${i}" aria-current="false">${t.track ? `<span class="muted">${+t.track}.</span> ` : ''}${esc(t.title)} <span class="muted">${fmtTime(t.duration || 0)}</span></button></li>`).join('');
  let urlNow = null;
  const play = async (i) => {
    p.part = i;
    if (urlNow) { URL.revokeObjectURL(urlNow); p.urls = p.urls.filter(u => u !== urlNow); }
    media.src = urlNow = await blobUrl(p, i);
    list.querySelectorAll('[data-t]').forEach(b => b.setAttribute('aria-current', String(+b.dataset.t === i)));
    media.play().catch(() => {});
  };
  list.querySelectorAll('[data-t]').forEach(b => b.onclick = () => play(+b.dataset.t));
  media.addEventListener('ended', () => { if (p.part < e.parts.length - 1) play(p.part + 1); });
  await play(0);
}
