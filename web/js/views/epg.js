// TV-guiden i rutnät (som TiviMate): kanaler i en kolumn som står still, tidslinje överst, linje för nu, ett dygn i taget
// (bakåt så långt som kanalernas catch-up räcker). Bara raderna som syns ritas – tusentals kanaler går bra – och
// programmen hämtas för 40 kanaler åt gången när de kommer fram. Fungerar med piltangenter/fjärrkontroll (rutnät med
// "roving tabindex": ←/→ föregående/nästa program, ↑/↓ samma tid i kanalen ovanför/under, Page Up/Down en skärm,
// Home = nu, Enter = programmet, ← från första programmet = kanalen) och med touch/mus (vanlig skrollning i båda led).
// @lazy – laddas vid behov (LAZY i js/router.js)
import { $, $$, act, api, dayName, esc, hhmm, main, me, onLeave, store, toast, toastErr, views } from '../core.js';
import { playLive } from '../player/live.js';
import { playCatchup, setZapList } from '../player/iptv.js';
import { openDialog, choiceDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';
import { tabsHtml, bindTabs } from '../ui/tabs.js';
import { contextMenu, openMenu } from '../ui/menu.js';
import { chLogo } from '../ui/cards.js';

const BLOCK = 40;
const phone = () => matchMedia('(max-width: 640px)').matches;
const dims = () => phone() ? { px: 3.2, rowH: 54, chW: 84, head: 34 } : { px: 5, rowH: 58, chW: 190, head: 34 }; // px per minut
const nowS = () => Date.now() / 1000;
const dayStart = (off) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return Math.floor(d / 1000); };

views.epg = async () => {
  const D = await api('/iptv/channels');
  if (!D.channels.length) {
    main.innerHTML = `<div class="toolbar"><h1>TV-guide</h1></div>` + emptyState({ icon: '📺', title: 'Inga kanaler ännu',
      text: me.adminHere ? 'Lägg till en IPTV-lista, ett Xtream-konto eller en HDHomeRun under Administration.' : 'En administratör behöver lägga till en TV-källa.',
      action: me.adminHere ? { label: 'Lägg till källa', href: '#/iptvadmin' } : null });
    return;
  }
  const maxBack = Math.min(7, Math.max(0, ...D.channels.map(c => c.catchup || 0)));
  const S = { all: D.channels, list: [], group: store.get('epg.group', ''), day: 0, ...dims(), from: 0, to: 0, prog: new Map(), loading: new Map(), rows: new Map(),
    focus: { row: 0, pid: null, t: nowS() }, gen: 0 };
  const groups = D.groups.filter(g => g.name);
  const favs = D.channels.filter(c => c.favorite).length;
  if (S.group === '★' && !favs) S.group = '';
  if (S.group && S.group !== '★' && !groups.some(g => g.name === S.group)) S.group = '';
  const days = [];
  for (let d = -maxBack; d <= 6; d++) days.push(d);
  main.innerHTML = `<div class="toolbar epgbar"><h1>TV-guide</h1>
      <select id="eday" aria-label="Dag">${days.map(d => `<option value="${d}"${d === 0 ? ' selected' : ''}>${esc(d === -1 ? 'Igår' : dayName(dayStart(d) + 43200))}</option>`).join('')}</select>
      <button class="ghost small" id="enow">Nu</button>
      <form id="esearch" role="search" class="row"><input id="eq" type="search" placeholder="Sök program…" aria-label="Sök program" autocomplete="off"></form>
      <span class="row epglinks"><a class="btn ghost small" href="#/live">Kanaler</a><a class="btn ghost small" href="#/dvr">⏺ Inspelningar</a>${D.vod ? '<a class="btn ghost small" href="#/vod">🎬 Filmer &amp; serier</a>' : ''}${me.adminHere ? '<a class="btn ghost small" href="#/iptvadmin">Hantera</a>' : ''}</span></div>
    <div id="egroups" class="epggroups">${tabsHtml({ id: 'egtabs', label: 'Kanalgrupper', current: S.group, items: [{ key: '', label: `Alla (${D.channels.length})` },
      ...(favs ? [{ key: '★', label: `★ Favoriter (${favs})` }] : []), ...groups.map(g => ({ key: g.name, label: `${g.name} (${g.count})` }))] })}</div>
    <div class="epginfo" id="einfo" aria-live="polite"></div>
    <div class="epg" id="egrid" role="grid" aria-label="TV-guide" tabindex="-1"><div class="epgcanvas" id="ecanvas"></div></div>
`;
  const grid = $('#egrid'), canvas = $('#ecanvas'), info = $('#einfo');
  // Rutnätet fyller fönstret ner till flikraden (telefon) – det skrollar själv i båda led
  const fit = () => {
    const tb = $('#tabbar'), bottom = tb && !tb.hidden && getComputedStyle(tb).display !== 'none' ? tb.getBoundingClientRect().height : 0;
    grid.style.height = Math.max(300, Math.round(innerHeight - grid.getBoundingClientRect().top - bottom - 16)) + 'px';
  };
  fit();
  addEventListener('resize', fit);
  onLeave(() => removeEventListener('resize', fit));
  const x = (t) => (t - S.from) / 60 * S.px;

  // ---------- data ----------
  const filtered = () => S.group === '★' ? S.all.filter(c => c.favorite) : S.group ? S.all.filter(c => c.group === S.group) : S.all;
  const fetchBlock = (b) => {
    const k = `${S.from}:${b}`;
    if (S.loading.has(k)) return;
    const ids = S.list.slice(b * BLOCK, (b + 1) * BLOCK).map(c => c.id).filter(id => !S.prog.has(id));
    if (!ids.length) return;
    const gen = S.gen;
    S.loading.set(k, api(`/iptv/epg?ids=${ids.join(',')}&from=${S.from}&to=${S.to}`).then(d => {
      if (gen !== S.gen) return;
      for (const id of ids) S.prog.set(id, (d.programs[id] || []));
      for (let i = b * BLOCK; i < Math.min(S.list.length, (b + 1) * BLOCK); i++) { const r = S.rows.get(i); if (r) fillRow(r, i); }
      if (S.pendingFocus) { const f = S.pendingFocus; S.pendingFocus = null; focusCell(f.row, f.pick); }
    }).catch(e => { if (!e.aborted) S.loading.delete(k); }));
  };

  // ---------- ritning ----------
  const W = () => x(S.to);
  function layout() {
    S.list = filtered();
    setZapList(S.list);
    S.rows.clear();
    const n = S.list.length;
    grid.setAttribute('aria-rowcount', String(n + 1));
    grid.style.setProperty('--chw', S.chW + 'px'); grid.style.setProperty('--rowh', S.rowH + 'px'); grid.style.setProperty('--head', S.head + 'px');
    const ticks = [];
    for (let t = S.from; t < S.to; t += 1800) ticks.push(t);
    canvas.style.width = (S.chW + W()) + 'px';
    canvas.innerHTML = `<div class="epghead" role="row"><div class="epgcorner" role="columnheader">${esc(dayName(S.from + 43200))}</div>
      <div class="epgtimes" style="width:${W()}px">${ticks.map(t => `<span style="left:${x(t)}px"${new Date(t * 1000).getMinutes() ? ' class="half"' : ''}>${hhmm(t)}</span>`).join('')}</div></div>
      <div class="epgbody" id="ebody" style="height:${n * S.rowH}px"></div><div class="epgnow" id="enowl" hidden></div>`;
    if (!n) $('#ebody').innerHTML = `<div class="epgempty">${S.group === '★' ? 'Inga favoriter – håll inne (eller högerklicka) på en kanal för att lägga till den.' : 'Inga kanaler i gruppen.'}</div>`;
    nowLine();
    draw();
  }
  function nowLine() {
    const l = $('#enowl'); if (!l) return;
    const t = nowS();
    l.hidden = !(t > S.from && t < S.to);
    l.style.left = (S.chW + x(t)) + 'px';
  }
  function rowHtml(c, i) {
    return `<div class="epgch-wrap"><button type="button" class="epgch" role="rowheader" tabindex="-1" data-row="${i}" title="${esc(c.name)}">${chLogo(c, 'small')}
      <span class="epgchn">${c.logo && c.number ? `<b>${esc(c.number)}</b> ` : ''}${esc(c.name)}</span>${c.favorite ? '<i class="epgfav" aria-label="Favorit">★</i>' : ''}${c.catchup ? '<i class="epgcu" title="Catch-up">⟲</i>' : ''}</button></div>
      <div class="epgtrack" style="width:${W()}px"></div>`;
  }
  function fillRow(r, i) {
    const c = S.list[i], track = r.lastElementChild;
    const progs = S.prog.get(c.id);
    if (!progs) { track.innerHTML = '<span class="epgload"></span>'; return; }
    const t = nowS();
    track.innerHTML = progs.length ? progs.map(p => {
      const l = Math.max(0, x(p.start)), w = Math.max(3, Math.min(W(), x(p.stop)) - l - 2);
      const on = p.start <= t && p.stop > t, past = p.stop <= t;
      return `<button type="button" class="epgp${on ? ' on' : ''}${past ? ' past' : ''}${p.catchup ? ' cu' : ''}" role="gridcell" tabindex="-1" data-pid="${p.id}" data-row="${i}"
        style="left:${l}px;width:${w}px" aria-label="${esc(`${p.title}, ${hhmm(p.start)}–${hhmm(p.stop)}${p.catchup ? ', finns i arkivet' : ''}${p.reminder ? ', påminnelse' : ''}`)}">
        <b>${p.reminder ? '🔔 ' : ''}${esc(p.title)}</b><span>${hhmm(p.start)}${p.subtitle ? ' · ' + esc(p.subtitle) : p.season ? ` · S${p.season}${p.episode ? 'E' + p.episode : ''}` : ''}</span>${on ? `<i class="epgpr" style="width:${Math.round((t - p.start) / (p.stop - p.start) * 100)}%"></i>` : ''}</button>`;
    }).join('') : '<span class="epgnone">Ingen guide</span>';
    padTitles(track);
  }
  // Långa program som börjat till vänster om det synliga: titeln flyttas in så att den syns
  function padTitles(scope) {
    const left = grid.scrollLeft;
    for (const b of (scope || $('#ebody')).querySelectorAll('.epgp')) {
      const l = parseFloat(b.style.left), w = parseFloat(b.style.width);
      b.style.paddingLeft = (l < left && l + w > left + 60 ? Math.min(left - l, w - 80) + 8 : 8) + 'px';
    }
  }
  function draw() {
    const body = $('#ebody'); if (!body || !S.list.length) return;
    const top = Math.max(0, grid.scrollTop - S.head), h = grid.clientHeight;
    const a = Math.max(0, Math.floor(top / S.rowH) - 6), b = Math.min(S.list.length - 1, Math.ceil((top + h) / S.rowH) + 6);
    for (const [i, r] of S.rows) if (i < a || i > b) { if (!r.contains(document.activeElement)) { r.remove(); S.rows.delete(i); } }
    for (let i = a; i <= b; i++) {
      if (S.rows.has(i)) continue;
      const r = document.createElement('div');
      r.className = 'epgrow'; r.setAttribute('role', 'row'); r.setAttribute('aria-rowindex', String(i + 2));
      r.style.top = (i * S.rowH) + 'px';
      r.innerHTML = rowHtml(S.list[i], i);
      body.append(r);
      S.rows.set(i, r);
      fillRow(r, i);
    }
    for (let blk = Math.floor(a / BLOCK); blk <= Math.floor(b / BLOCK); blk++) fetchBlock(blk);
    roving();
  }
  let raf = 0, padT = 0;
  grid.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
    clearTimeout(padT); padT = setTimeout(() => padTitles(), 80);
  }, { passive: true });
  const ro = new ResizeObserver(() => {
    const d = dims();
    if (d.px !== S.px) { const t = S.from + (grid.scrollLeft) / S.px * 60; Object.assign(S, d); layout(); grid.scrollLeft = x(t); }
    else draw();
  });
  ro.observe(grid);
  onLeave(() => { ro.disconnect(); clearInterval(tick); });
  const tick = setInterval(() => {
    nowLine();
    const t = nowS();
    for (const b of $$('.epgp', canvas)) {
      const p = progOf(+b.dataset.row, +b.dataset.pid); if (!p) continue;
      b.classList.toggle('on', p.start <= t && p.stop > t); b.classList.toggle('past', p.stop <= t);
    }
  }, 30000);

  // ---------- fokus och tangentbord ----------
  const progOf = (row, pid) => (S.prog.get(S.list[row]?.id) || []).find(p => p.id === pid);
  const cellEl = (row, pid) => pid == null ? $(`.epgch[data-row="${row}"]`, canvas) : $(`.epgp[data-row="${row}"][data-pid="${pid}"]`, canvas);
  function roving() {
    const f = S.focus;
    const want = cellEl(f.row, f.pid) || cellEl(f.row, null);
    for (const b of $$('[tabindex="0"]', canvas)) if (b !== want) b.tabIndex = -1;
    if (want) want.tabIndex = 0;
  }
  function scrollInto(row, p) {
    const visH = grid.clientHeight - S.head, y = row * S.rowH;
    if (y < grid.scrollTop) grid.scrollTop = y;
    else if (y + S.rowH > grid.scrollTop + visH) grid.scrollTop = y + S.rowH - visH;
    if (p) {
      const visW = grid.clientWidth - S.chW, l = Math.max(0, x(p.start)), r = Math.min(W(), x(p.stop));
      if (l < grid.scrollLeft) grid.scrollLeft = Math.max(0, l - 20);
      else if (r > grid.scrollLeft + visW) grid.scrollLeft = Math.min(l - 20, r - visW + 20);
    }
  }
  const viewTime = () => S.from + grid.scrollLeft / S.px * 60;
  function pick(row, t) {
    const l = S.prog.get(S.list[row]?.id);
    if (!l?.length) return null;
    return l.find(p => p.start <= t && p.stop > t) || l.find(p => p.start >= t) || l[l.length - 1];
  }
  function focusCell(row, choose) {
    row = Math.max(0, Math.min(S.list.length - 1, row));
    const c = S.list[row]; if (!c) return;
    let p = null;
    if (choose !== 'channel') {
      if (!S.prog.has(c.id)) { S.pendingFocus = { row, pick: choose }; scrollInto(row, null); draw(); fetchBlock(Math.floor(row / BLOCK)); return; }
      p = typeof choose === 'object' && choose ? choose : pick(row, Math.max(S.focus.t, viewTime()));
    }
    S.focus = { row, pid: p ? p.id : null, t: p ? Math.max(p.start, Math.min(S.focus.t, p.stop - 60)) : S.focus.t };
    scrollInto(row, p);
    draw();
    const el = cellEl(row, S.focus.pid);
    if (el) { roving(); el.focus({ preventScroll: true }); }
    showInfo(c, p);
  }
  function showInfo(c, p) {
    info.innerHTML = p ? `<b>${esc(p.title)}</b> <span class="muted">${esc(c.name)} · ${esc(dayName(p.start))} ${hhmm(p.start)}–${hhmm(p.stop)}${p.subtitle ? ' · ' + esc(p.subtitle) : ''}${p.category ? ' · ' + esc(p.category) : ''}${p.catchup ? (p.stop > nowS() ? ' · ⟲ kan ses från början' : ' · ⟲ i arkivet') : ''}</span>`
      : `<b>${esc(c.number ? c.number + ' · ' : '')}${esc(c.name)}</b> <span class="muted">${c.now ? 'Nu: ' + esc(c.now.title) : ''} – Enter för att titta</span>`;
  }
  grid.addEventListener('focusin', (e) => {
    const b = e.target.closest('[data-row]'); if (!b) return;
    const row = +b.dataset.row, pid = b.dataset.pid ? +b.dataset.pid : null;
    if (S.focus.row !== row || S.focus.pid !== pid) {
      const p = pid != null ? progOf(row, pid) : null;
      S.focus = { row, pid, t: p ? Math.max(p.start, Math.min(S.focus.t, p.stop - 60)) : S.focus.t };
      roving(); showInfo(S.list[row], p);
    }
  });
  grid.addEventListener('keydown', (e) => {
    const b = e.target.closest('[data-row]'); if (!b) return;
    const f = S.focus, row = f.row, list = S.prog.get(S.list[row]?.id) || [];
    const i = f.pid == null ? -1 : list.findIndex(p => p.id === f.pid);
    const page = Math.max(1, Math.floor((grid.clientHeight - S.head) / S.rowH) - 1);
    const k = e.key;
    let done = true;
    if (k === 'ArrowRight') { if (f.pid == null) focusCell(row, pick(row, Math.max(viewTime(), Math.min(nowS(), S.to)))); else if (list[i + 1]) focusCell(row, list[i + 1]); }
    else if (k === 'ArrowLeft') { if (f.pid != null && i > 0) focusCell(row, list[i - 1]); else if (f.pid != null) focusCell(row, 'channel'); else done = false; }
    else if (k === 'ArrowDown') focusCell(row + 1, f.pid == null ? 'channel' : undefined);
    else if (k === 'ArrowUp') { if (row === 0) { $('#egtabs [aria-selected=true]')?.focus(); } else focusCell(row - 1, f.pid == null ? 'channel' : undefined); }
    else if (k === 'PageDown') focusCell(row + page, f.pid == null ? 'channel' : undefined);
    else if (k === 'PageUp') focusCell(row - page, f.pid == null ? 'channel' : undefined);
    else if (k === 'Home') { S.focus.t = nowS(); toNow(); focusCell(row); }
    else if (k === 'End') focusCell(S.list.length - 1, f.pid == null ? 'channel' : undefined);
    else done = false;
    if (done) e.preventDefault();
  });
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-row]'); if (!b) return;
    const row = +b.dataset.row, c = S.list[row];
    if (b.dataset.pid) programDialog(+b.dataset.pid, c);
    else if (c) playLive(c);
  });
  contextMenu(grid, '.epgch', (el, point) => {
    const c = S.list[+el.dataset.row]; if (!c) return;
    openMenu(el, [
      { icon: '▶', label: 'Titta', onSelect: () => playLive(c) },
      { icon: c.favorite ? '☆' : '★', label: c.favorite ? 'Ta bort från favoriter' : 'Lägg till i favoriter', onSelect: () => toggleFav(c) },
    ], { point, title: c.name });
  });
  async function toggleFav(c) {
    try {
      await api('/iptv/favorites/' + c.id, { method: 'PUT', body: { on: !c.favorite } });
      c.favorite = !c.favorite;
      toast(c.favorite ? `${c.name} är en favorit` : `${c.name} är inte längre en favorit`);
      const i = S.list.indexOf(c), r = S.rows.get(i);
      if (S.group === '★') layout(); else if (r) { r.innerHTML = rowHtml(c, i); fillRow(r, i); }
    } catch (e) { toastErr(e); }
  }

  // ---------- dag, nu, grupper ----------
  function setDay(d) {
    S.day = d; S.gen++;
    S.from = dayStart(d); S.to = S.from + 26 * 3600;
    S.prog.clear(); S.loading.clear();
    layout();
  }
  function toNow() {
    if (S.day !== 0) { $('#eday').value = '0'; setDay(0); }
    grid.scrollLeft = Math.max(0, x(nowS() - 1800));
  }
  $('#eday').onchange = () => { const d = +$('#eday').value; const keep = grid.scrollLeft; setDay(d); grid.scrollLeft = d === 0 ? Math.max(0, x(nowS() - 1800)) : keep; draw(); };
  $('#enow').onclick = () => { S.focus.t = nowS(); toNow(); focusCell(S.focus.row); };
  $('#egtabs').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && S.list.length) { e.preventDefault(); focusCell(Math.min(S.focus.row, S.list.length - 1)); } });
  bindTabs($('#egtabs'), (key) => { S.group = key; store.set('epg.group', key); S.focus = { row: 0, pid: null, t: nowS() }; grid.scrollTop = 0; layout(); });
  $('#esearch').onsubmit = act(async (e) => {
    e.preventDefault();
    const q = $('#eq').value.trim(); if (!q) return;
    const r = await api('/iptv/search?q=' + encodeURIComponent(q));
    const h = openDialog({ title: `Sök: ${q}`, actions: [{ label: 'Stäng' }], body: r.length ? `<div class="srows">${r.map(p => `<button type="button" class="srow" data-sp="${p.id}">
        <b>${esc(p.title)}${p.subtitle ? ' – ' + esc(p.subtitle) : ''}</b><span class="muted small">${esc(dayName(p.start))} ${hhmm(p.start)} · ${esc(p.channel)}</span></button>`).join('')}</div>` : '<p class="muted">Inga program hittades.</p>' });
    for (const b of $$('[data-sp]', h.el)) b.onclick = () => { h.close(); programDialog(+b.dataset.sp); };
  });

  setDay(0);
  toNow();
  // Fokus på det som går nu i första kanalen (piltangenterna fungerar direkt på TV)
  S.focus = { row: 0, pid: null, t: nowS() };
  if (matchMedia('(hover: none)').matches === false || !phone()) setTimeout(() => { if (document.activeElement === document.body || !document.activeElement) focusCell(0); }, 50);

  // ---------- programrutan ----------
  async function programDialog(pid, chHint) {
    let p;
    try { p = await api('/iptv/programs/' + pid); } catch (e) { toastErr(e); return; }
    const ch = S.all.find(c => c.id === p.channelId) || chHint || p.channel;
    const t = nowS(), future = p.start > t, past = p.stop <= t;
    const status = { scheduled: 'Inspelning bokad', recording: 'Spelas in nu', processing: 'Bearbetas', done: 'Inspelad' }[p.recording?.status];
    const btns = [];
    if (p.live) btns.push('<button class="primary" id="pdw">▶ Titta</button>');
    if (p.catchup) btns.push(`<button class="${p.live ? 'ghost' : 'primary'}" id="pdc">${p.live ? '⏮ Från början' : '▶ Spela'}</button>`);
    if (future) btns.push(`<button class="ghost" id="pdrem">${p.reminder ? '🔕 Ta bort påminnelsen' : '🔔 Påminn mig'}</button>`);
    if (!past) {
      if (!p.recording) btns.push('<button class="ghost" id="pdr">⏺ Spela in</button>');
      else if (p.recording.status === 'scheduled') btns.push('<button class="ghost" id="pdx">Avboka inspelningen</button>');
      if (!p.rule) btns.push('<button class="ghost" id="pds">⏺⏺ Spela in serien</button>');
    }
    const h = openDialog({ title: p.title, actions: [{ label: 'Stäng' }], body: `
      <p class="muted">${esc(ch?.name || '')} · ${esc(dayName(p.start))} ${hhmm(p.start)}–${hhmm(p.stop)}${p.season ? ` · S${p.season}${p.episode ? 'E' + p.episode : ''}` : ''}${p.isNew ? ' · Nytt' : ''}${p.category ? ' · ' + esc(p.category) : ''}</p>
      ${p.subtitle ? `<p><b>${esc(p.subtitle)}</b></p>` : ''}${p.description ? `<p>${esc(p.description)}</p>` : ''}
      ${status ? `<p class="ok-badge" style="display:inline-block">${status}</p>` : ''}${p.rule ? ' <span class="muted small">Serieinspelning aktiv</span>' : ''}
      ${past && !p.catchup ? '<p class="muted small">Programmet har sänts och finns inte i kanalens arkiv.</p>' : ''}
      ${p.airings.length ? `<details><summary class="muted small">Fler sändningar (${p.airings.length})</summary><table>${p.airings.map(a => `<tr><td>${esc(dayName(a.start))} ${hhmm(a.start)}</td><td class="muted">${esc(a.channel)}</td></tr>`).join('')}</table></details>` : ''}
      <div class="row" style="margin-top:16px;flex-wrap:wrap">${btns.join('')}</div>` });
    const d = h.el, $d = (s) => $(s, d);
    ($d('#pdw') || $d('#pdc') || $d('#pdrem'))?.focus();
    if ($d('#pdw')) $d('#pdw').onclick = () => { h.close(); if (ch) playLive(ch); };
    if ($d('#pdc')) $d('#pdc').onclick = () => { h.close(); playCatchup(p); };
    if ($d('#pdrem')) $d('#pdrem').onclick = act(async () => {
      await api(`/iptv/programs/${p.id}/reminder`, { method: p.reminder ? 'DELETE' : 'POST' });
      toast(p.reminder ? 'Påminnelsen är borttagen' : `Du får en påminnelse när ${p.title} börjar`);
      const l = S.prog.get(p.channelId)?.find(x => x.id === p.id); if (l) l.reminder = !p.reminder;
      const i = S.list.findIndex(c => c.id === p.channelId), r = S.rows.get(i); if (r) fillRow(r, i);
      h.close();
    });
    if ($d('#pdr')) $d('#pdr').onclick = act(async () => { const r = await api('/dvr/program', { method: 'POST', body: { programId: p.id } }); toast(r.conflict ? 'Bokad – men alla tuners är upptagna då. Inspelningen väntar på en ledig tuner.' : 'Inspelning bokad'); h.close(); });
    if ($d('#pdx')) $d('#pdx').onclick = act(async () => { await api('/dvr/recordings/' + p.recording.id, { method: 'DELETE' }); toast('Avbokad'); h.close(); });
    if ($d('#pds')) $d('#pds').onclick = act(async () => {
      const any = await choiceDialog('Spela in serien', [{ label: `Bara ${ch?.name || 'den här kanalen'}`, value: false }, { label: 'Alla kanaler', value: true }],
        { text: `Nya avsnitt av ${p.title} spelas in automatiskt. Från vilka kanaler?` });
      if (any === null) return;
      await api('/dvr/program' + (any ? '?anyChannel=1' : ''), { method: 'POST', body: { programId: p.id, series: true, newOnly: true } });
      toast('Serieinspelning skapad – bara nya avsnitt spelas in'); h.close();
    });
  }
};
