// Vyer: live-TV, programguide och inspelningar (DVR)
import { $, $$, act, api, dayName, esc, fmtDur, hhmm, keyClick, later, main, me, toast, toastErr, views } from '../core.js';
import { playLive, playRec } from '../player/live.js';
import { route } from '../router.js';
import { choiceDialog, confirmDialog, openDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';

export const chLogo = (c, cls = '') => `<span class="chlogo ${cls}">${c.logo ? `<img src="/api/live/logo/${c.id}" alt="" loading="lazy" data-fb="1">` : ''}<i>${esc(c.number || c.name.slice(0, 3))}</i></span>`;
function loadLogos() {}
views.live = async () => {
  const D = await api('/live/channels');
  main.innerHTML = `<div class="toolbar"><h1>Live-TV</h1><a class="btn ghost" href="#/guide">📅 TV-guide</a><a class="btn ghost" href="#/dvr">⏺ Inspelningar</a></div>
    ${D.channels.length ? `<div class="chgrid">${D.channels.map((c, i) => `<button class="chcard" data-ch="${i}">${chLogo(c)}<div class="chinfo"><b>${esc(c.name)}</b>
      ${c.now ? `<div class="small">${esc(c.now.title)}</div><div class="prog"><i style="width:${Math.min(100, (Date.now() / 1000 - c.now.start) / (c.now.stop - c.now.start) * 100)}%"></i></div>` : '<div class="small muted">Ingen guide</div>'}
      ${c.next ? `<div class="small muted">${hhmm(c.next.start)} ${esc(c.next.title)}</div>` : ''}</div></button>`).join('')}</div>`
    : emptyState({ icon: '📺', title: 'Inga kanaler ännu', text: me.adminHere ? 'Lägg till en HDHomeRun eller en IPTV-lista under Administration → Live-TV.' : 'En administratör behöver lägga till en TV-källa.',
      action: me.adminHere ? { label: 'Till Administration', href: '#/admin' } : null })}`;
  $$('[data-ch]').forEach(b => b.onclick = () => playLive(D.channels[+b.dataset.ch]));
  loadLogos();
};
views.guide = async (dayOffset) => {
  const start = Math.floor(Date.now() / 1000 / 1800) * 1800 - 1800 + (+dayOffset || 0) * 86400;
  const G = await api(`/live/guide?from=${start}&hours=6`);
  const PX = 4; // px per minut
  const W = (G.to - G.from) / 60 * PX;
  const x = (t) => Math.max(0, (t - G.from) / 60 * PX);
  const nowX = x(Date.now() / 1000);
  const ticks = []; for (let t = G.from; t < G.to; t += 1800) ticks.push(t);
  main.innerHTML = `<div class="toolbar"><h1>TV-guide</h1><span class="muted">${dayName(G.from)}</span>
    <div class="row" style="margin-left:auto">${start - 21600 >= Date.now() / 1000 - 25 * 3600 ? `<a class="btn ghost small" href="#/guide/${(+dayOffset || 0) - 0.25}">← Tidigare</a>` : ''}<a class="btn ghost small" href="#/guide">Nu</a><a class="btn ghost small" href="#/guide/${(+dayOffset || 0) + 0.25}">Senare →</a><a class="btn ghost small" href="#/dvr">⏺ Inspelningar</a></div></div>
    <form id="gsearch" class="row" style="margin-bottom:12px"><input id="gq" placeholder="Sök program…" style="max-width:320px"><button class="ghost">Sök</button></form><div id="gres"></div>
    <div class="guide"><div class="gch">${'<div class="gtime-pad"></div>' + G.channels.map(c => `<div class="grow-h">${chLogo(c, 'small')}<span>${esc(c.name)}</span></div>`).join('')}</div>
      <div class="gscroll"><div style="width:${W}px;position:relative">
        <div class="gtimes">${ticks.map(t => `<span style="left:${x(t)}px">${hhmm(t)}</span>`).join('')}</div>
        ${nowX > 0 && nowX < W ? `<div class="gnow" style="left:${nowX}px"></div>` : ''}
        ${G.channels.map(c => `<div class="grow">${c.programs.map(p => { const l = x(p.start), w = Math.max(2, x(p.stop) - l - 2);
          return `<button class="gp${p.start <= Date.now() / 1000 && p.stop > Date.now() / 1000 ? ' on' : ''}" style="left:${l}px;width:${w}px" data-pid="${p.id}" title="${esc(p.title)}"><b>${esc(p.title)}</b><span>${hhmm(p.start)}${p.subtitle ? ' · ' + esc(p.subtitle) : ''}</span></button>`; }).join('')}</div>`).join('')}
      </div></div></div>
    ${G.guide.error ? `<p class="err small">Guiden kunde inte uppdateras: ${esc(G.guide.error)}</p>` : ''}`;
  $$('[data-pid]').forEach(b => b.onclick = () => programDialog(+b.dataset.pid));
  if (nowX > 200) $('.gscroll').scrollLeft = nowX - 200;
  $('#gsearch').onsubmit = act(async (e) => {
    e.preventDefault(); const q = $('#gq').value.trim(); if (!q) return;
    const r = await api('/live/search?q=' + encodeURIComponent(q));
    if (!$('#gres')) return;
    $('#gres').innerHTML = `<table>${r.map(p => `<tr data-pid2="${p.id}" style="cursor:pointer"><td>${dayName(p.start)} ${hhmm(p.start)}</td><td><b>${esc(p.title)}</b>${p.subtitle ? ' – ' + esc(p.subtitle) : ''}</td><td class="muted">${esc(p.channel)}</td></tr>`).join('') || '<tr><td class="muted">Inga träffar</td></tr>'}</table>`;
    $$('[data-pid2]').forEach(r2 => keyClick(r2).onclick = () => programDialog(+r2.dataset.pid2));
  });
  loadLogos();
};
export async function programDialog(id) {
  let p;
  try { p = await api('/live/programs/' + id); } catch (e) { toastErr(e); return; }
  const nowT = Date.now() / 1000, onNow = p.start <= nowT && p.stop > nowT;
  const h = openDialog({ title: p.title, actions: [{ label: 'Stäng' }], body: `
    <p class="muted">${esc(p.channel_name)} · ${dayName(p.start)} ${hhmm(p.start)}–${hhmm(p.stop)}${p.season ? ` · S${p.season}${p.episode ? 'E' + p.episode : ''}` : ''}${p.is_new ? ' · Nytt' : ''}${p.category ? ' · ' + esc(p.category) : ''}</p>
    ${p.subtitle ? `<p><b>${esc(p.subtitle)}</b></p>` : ''}${p.description ? `<p>${esc(p.description)}</p>` : ''}
    ${p.recording ? `<p class="ok-badge" style="display:inline-block">${{ scheduled: 'Inspelning bokad', recording: 'Spelas in nu', processing: 'Bearbetas', done: 'Inspelad' }[p.recording.status]}</p>` : ''}
    ${p.airings.length ? `<details><summary class="muted small">Fler sändningar (${p.airings.length})</summary><table>${p.airings.map(a => `<tr><td>${dayName(a.start)} ${hhmm(a.start)}</td><td class="muted">${esc(a.channel)}</td></tr>`).join('')}</table></details>` : ''}
    <div class="row" style="margin-top:16px;flex-wrap:wrap">
      ${onNow ? '<button class="primary" id="pdw">▶ Titta</button>' : ''}
      ${p.recording ? (p.recording.status === 'scheduled' ? '<button class="ghost" id="pdc">Avboka</button>' : '') : '<button class="ghost" id="pdr">⏺ Spela in</button>'}
      ${p.rule ? '<span class="muted small">Serieinspelning aktiv</span>' : '<button class="ghost" id="pds">⏺⏺ Spela in serien</button>'}</div>` });
  const d = h.el, close = () => h.close();
  if ($('#pdw', d)) $('#pdw', d).focus();
  if ($('#pdw', d)) $('#pdw', d).onclick = act(async () => { close(); const D = await api('/live/channels'); const ch = D.channels.find(c => c.id === p.channel_id); if (ch) playLive(ch); });
  if ($('#pdr', d)) $('#pdr', d).onclick = async () => { try { const r = await api('/dvr/program', { method: 'POST', body: { programId: id }, bg: true }); toast(r.conflict ? 'Bokad – men alla tuners är upptagna då. Inspelningen väntar på en ledig tuner.' : 'Inspelning bokad'); close(); } catch (e) { toastErr(e); } };
  if ($('#pdc', d)) $('#pdc', d).onclick = act(async () => { await api('/dvr/recordings/' + p.recording.id, { method: 'DELETE' }); toast('Avbokad'); close(); });
  // Serieinspelning: två tydliga val (tidigare confirm(), där Avbryt betydde "bara den här kanalen")
  const series = async (any) => {
    try { await api('/dvr/program' + (any ? '?anyChannel=1' : ''), { method: 'POST', body: { programId: id, series: true, newOnly: true }, bg: true }); toast('Serieinspelning skapad – bara nya avsnitt spelas in'); close(); } catch (e) { toastErr(e); }
  };
  if ($('#pds', d)) $('#pds', d).onclick = async () => {
    const any = await choiceDialog('Spela in serien', [{ label: `Bara ${p.channel_name}`, value: false }, { label: 'Alla kanaler', value: true }],
      { text: `Nya avsnitt av ${p.title} spelas in automatiskt. Från vilka kanaler?` });
    if (any !== null) series(any);
  };
}
views.dvr = async () => {
  const D = await api('/dvr');
  const st = { scheduled: 'Bokad', recording: '⏺ Spelar in', processing: 'Bearbetas…', done: '', failed: 'Misslyckades' };
  main.innerHTML = `<div class="toolbar"><h1>Inspelningar</h1><a class="btn ghost" href="#/guide">📅 TV-guide</a><a class="btn ghost" href="#/live">Live-TV</a></div>
    ${D.done.filter(r => r.status === 'done').length ? `<section class="section"><h2>Inspelat</h2><div class="reclist">${D.done.filter(r => r.status === 'done').map(r => `<div class="rec">
      <div><b>${esc(r.title)}</b>${r.subtitle ? ' – ' + esc(r.subtitle) : ''}<div class="muted small">${esc(r.channel_name || '')} · ${dayName(r.start)} ${hhmm(r.start)} · ${fmtDur(r.stop - r.start)}${r.size ? ' · ' + (r.size / 1e9).toFixed(1) + ' GB' : ''}${r.commercials?.length ? ` · ${r.commercials.length} reklamavbrott` : ''}${['pending', 'running'].includes(r.commercials_status) ? ' · letar reklam…' : ''}${r.error ? ' · ' + esc(r.error) : ''}</div></div>
      <div class="row"><button class="primary small" data-rplay="${r.id}">▶ Spela</button>${me.adminHere && D.comskip?.enabled ? `<button class="ghost small" data-rcs="${r.id}" title="Analysera reklamavbrott igen">Leta reklam</button>` : ''}<button class="ghost small" data-rdel="${r.id}">Ta bort</button></div></div>`).join('')}</div></section>` : ''}
    <section class="section"><h2>Kommande</h2>${D.scheduled.length ? `<table>${D.scheduled.map(r => `<tr><td>${dayName(r.start)} ${hhmm(r.start)}–${hhmm(r.stop)}</td><td><b>${esc(r.title)}</b>${r.subtitle ? ' – ' + esc(r.subtitle) : ''}</td><td class="muted">${esc(r.channel_name || '')}</td>
      <td>${st[r.status]}</td><td class="r">${r.status === 'recording' ? `<button class="ghost small" data-rstop="${r.id}">Stoppa</button>` : `<button class="ghost small" data-rdel="${r.id}">Avboka</button>`}</td></tr>`).join('')}</table>` : '<p class="muted">Inga bokade inspelningar. Välj ett program i TV-guiden.</p>'}</section>
    ${D.rules.length ? `<section class="section"><h2>Serieinspelningar</h2><table>${D.rules.map(r => `<tr><td><b>${esc(r.title)}</b></td><td class="muted">${esc(r.channel_name || 'Alla kanaler')}${r.new_only ? ' · bara nya' : ''}${r.keep ? ` · sparar ${r.keep}` : ''}</td><td>${r.upcoming} kommande</td><td class="r"><button class="ghost small" data-rule="${r.id}">Ta bort</button></td></tr>`).join('')}</table></section>` : ''}
    ${D.done.filter(r => r.status !== 'done').length ? `<section class="section"><h2>Pågående och misslyckade</h2><table>${D.done.filter(r => r.status !== 'done').map(r => `<tr><td>${dayName(r.start)} ${hhmm(r.start)}</td><td>${esc(r.title)}</td><td>${st[r.status]}</td><td class="muted small">${esc(r.error || '')}</td><td class="r"><button class="ghost small" data-rdel="${r.id}">Ta bort</button></td></tr>`).join('')}</table></section>` : ''}
    ${D.dir ? `<p class="muted small">Inspelningar sparas i <code>${esc(D.dir)}</code>.</p>` : ''}`;
  $$('[data-rdel]').forEach(b => b.onclick = act(async () => {
    const r = [...D.done, ...D.scheduled].find(x => x.id === +b.dataset.rdel);
    if (await confirmDialog(r ? `Ta bort ”${r.title}”?` : 'Ta bort inspelningen?', { okLabel: b.textContent.trim() || 'Ta bort', danger: true })) { await api('/dvr/recordings/' + b.dataset.rdel, { method: 'DELETE' }); route(); }
  }));
  $$('[data-rstop]').forEach(b => b.onclick = act(async () => { await api(`/dvr/recordings/${b.dataset.rstop}/stop`, { method: 'POST' }); toast('Stoppad – sparas'); later(route, 1500); }));
  $$('[data-rcs]').forEach(b => b.onclick = act(async () => { await api(`/dvr/recordings/${b.dataset.rcs}/commercials`, { method: 'POST' }); toast('Letar reklamavbrott i bakgrunden'); later(route, 1500); }));
  $$('[data-rule]').forEach(b => b.onclick = act(async () => { if (await confirmDialog('Ta bort serieinspelningen och dess bokningar?', { okLabel: 'Ta bort', danger: true })) { await api('/dvr/rules/' + b.dataset.rule, { method: 'DELETE' }); route(); } }));
  $$('[data-rplay]').forEach(b => b.onclick = act(async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await playRec(D.done.find(x => x.id === +b.dataset.rplay), D.comskip || {}); } finally { b.disabled = false; }
  }));
};
