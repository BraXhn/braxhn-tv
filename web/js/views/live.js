// Vyer: live-TV och programguide (inspelningarna finns i views/dvr.js)
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, dayName, esc, hhmm, keyClick, main, me, toast, toastErr, views, t } from '../core.js';
import { playLive } from '../player/live.js';
import { openDialog } from '../ui/dialog.js';
import { need } from '../lazy.js';
import { emptyState } from '../ui/states.js';

import { chLogo } from '../ui/cards.js';
import '../player/iptv.js'; // kanalbyte, favoriter och återanslutning i livespelaren
export { chLogo };
function loadLogos() {}
views.live = async () => {
  const D = await api('/live/channels');
  main.innerHTML = `<div class="toolbar"><h1>${t('Live-TV')}</h1><a class="btn ghost" href="#/epg">📅 ${t('TV-guide')}</a><a class="btn ghost" href="#/dvr">${t('⏺ Inspelningar')}</a>${me.iptvVod ? t('<a class="btn ghost" href="#/vod">🎬 Filmer &amp; serier</a>') : ''}</div>
    ${D.channels.length ? `<div class="chgrid">${D.channels.map((c, i) => `<button class="chcard" data-ch="${i}">${chLogo(c)}<div class="chinfo"><b>${esc(c.name)}</b>
      ${c.now ? `<div class="small">${esc(c.now.title)}</div><div class="prog"><i style="width:${Math.min(100, (Date.now() / 1000 - c.now.start) / (c.now.stop - c.now.start) * 100)}%"></i></div>` : t('<div class="small muted">Ingen guide</div>')}
      ${c.next ? `<div class="small muted">${hhmm(c.next.start)} ${esc(c.next.title)}</div>` : ''}</div></button>`).join('')}</div>`
    : emptyState({ icon: '📺', title: t('Inga kanaler ännu'), text: me.adminHere ? t('Lägg till en HDHomeRun eller en IPTV-lista under Administration → Live-TV.') : t('En administratör behöver lägga till en TV-källa.'),
      action: me.adminHere ? { label: t('Till Administration'), href: '#/admin' } : null })}`;
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
  main.innerHTML = `<div class="toolbar"><h1>${t('TV-guide')}</h1><span class="muted">${dayName(G.from)}</span>
    <div class="row" style="margin-left:auto">${t('{v}<a class="btn ghost small" href="#/guide">Nu</a><a class="btn ghost small" href="#/guide/{v2}">Senare →</a><a class="btn ghost small" href="#/dvr">⏺ Inspelningar</a>', { v: start - 21600 >= Date.now() / 1000 - 25 * 3600 ? `${t('<a class="btn ghost small" href="#/guide/{v}">← Tidigare</a>', { v: (+dayOffset || 0) - 0.25 })}` : '', v2: (+dayOffset || 0) + 0.25 })}</div></div>
    <form id="gsearch" class="row" style="margin-bottom:12px"><input id="gq" placeholder="${t('Sök program…')}" style="max-width:320px"><button class="ghost">${t('Sök')}</button></form><div id="gres"></div>
    <div class="guide"><div class="gch">${'<div class="gtime-pad"></div>' + G.channels.map(c => `<div class="grow-h">${chLogo(c, 'small')}<span>${esc(c.name)}</span></div>`).join('')}</div>
      <div class="gscroll"><div style="width:${W}px;position:relative">
        <div class="gtimes">${ticks.map(t => `<span style="left:${x(t)}px">${hhmm(t)}</span>`).join('')}</div>
        ${nowX > 0 && nowX < W ? `<div class="gnow" style="left:${nowX}px"></div>` : ''}
        ${G.channels.map(c => `<div class="grow">${c.programs.map(p => { const l = x(p.start), w = Math.max(2, x(p.stop) - l - 2);
          return `<button class="gp${p.start <= Date.now() / 1000 && p.stop > Date.now() / 1000 ? ' on' : ''}" style="left:${l}px;width:${w}px" data-pid="${p.id}" title="${esc(p.title)}"><b>${esc(p.title)}</b><span>${hhmm(p.start)}${p.subtitle ? ' · ' + esc(p.subtitle) : ''}</span></button>`; }).join('')}</div>`).join('')}
      </div></div></div>
    ${G.guide.error ? `<p class="err small">${t('Guiden kunde inte uppdateras: {error}', { error: esc(G.guide.error) })}</p>` : ''}`;
  $$('[data-pid]').forEach(b => b.onclick = () => programDialog(+b.dataset.pid));
  if (nowX > 200) $('.gscroll').scrollLeft = nowX - 200;
  $('#gsearch').onsubmit = act(async (e) => {
    e.preventDefault(); const q = $('#gq').value.trim(); if (!q) return;
    const r = await api('/live/search?q=' + encodeURIComponent(q));
    if (!$('#gres')) return;
    $('#gres').innerHTML = `<table>${r.map(p => `<tr data-pid2="${p.id}" style="cursor:pointer"><td>${dayName(p.start)} ${hhmm(p.start)}</td><td><b>${esc(p.title)}</b>${p.subtitle ? ' – ' + esc(p.subtitle) : ''}</td><td class="muted">${esc(p.channel)}</td></tr>`).join('') || t('<tr><td class="muted">Inga träffar</td></tr>')}</table>`;
    $$('[data-pid2]').forEach(r2 => keyClick(r2).onclick = () => programDialog(+r2.dataset.pid2));
  });
  loadLogos();
};
export async function programDialog(id) {
  let p;
  try { p = await api('/live/programs/' + id); } catch (e) { toastErr(e); return; }
  const nowT = Date.now() / 1000, onNow = p.start <= nowT && p.stop > nowT;
  const h = openDialog({ title: p.title, actions: [{ label: t('Stäng') }], body: `
    <p class="muted">${esc(p.channel_name)} · ${dayName(p.start)} ${hhmm(p.start)}–${hhmm(p.stop)}${p.season ? ` · S${p.season}${p.episode ? 'E' + p.episode : ''}` : ''}${p.is_new ? t(' · Nytt') : ''}${p.category ? ' · ' + esc(p.category) : ''}</p>
    ${p.subtitle ? `<p><b>${esc(p.subtitle)}</b></p>` : ''}${p.description ? `<p>${esc(p.description)}</p>` : ''}
    ${p.recording ? `<p class="ok-badge" style="display:inline-block">${{ scheduled: t('Inspelning bokad'), recording: t('Spelas in nu'), processing: t('Bearbetas'), done: t('Inspelad') }[p.recording.status]}</p>` : ''}
    ${p.airings.length ? `<details><summary class="muted small">${t('Fler sändningar ({airingsN})', { airingsN: p.airings.length })}</summary><table>${p.airings.map(a => `<tr><td>${dayName(a.start)} ${hhmm(a.start)}</td><td class="muted">${esc(a.channel)}</td></tr>`).join('')}</table></details>` : ''}
    <div class="row" style="margin-top:16px;flex-wrap:wrap">
      ${onNow ? t('<button class="primary" id="pdw">▶ Titta</button>') : ''}
      ${p.recording ? (p.recording.status === 'scheduled' ? t('<button class="ghost" id="pdc">Avboka</button>') : '') : t('<button class="ghost" id="pdr">⏺ Spela in</button>')}
      ${p.rule ? t('<span class="muted small">Serieinspelning aktiv</span>') : t('<button class="ghost" id="pds">⏺⏺ Spela in serien</button>')}</div>` });
  const d = h.el, close = () => h.close();
  if ($('#pdw', d)) $('#pdw', d).focus();
  if ($('#pdw', d)) $('#pdw', d).onclick = act(async () => { close(); const D = await api('/live/channels'); const ch = D.channels.find(c => c.id === p.channel_id); if (ch) playLive(ch); });
  if ($('#pdr', d)) $('#pdr', d).onclick = async () => { try { const r = await api('/dvr/program', { method: 'POST', body: { programId: id }, bg: true }); toast(r.plan && r.plan !== 'ok' ? t('Bokad – men tunrarna räcker inte då. Se Inspelningar → Konflikter för förslag.') : r.conflict ? t('Bokad – men alla tuners är upptagna då. Inspelningen väntar på en ledig tuner.') : t('Inspelning bokad')); close(); } catch (e) { toastErr(e); } };
  if ($('#pdc', d)) $('#pdc', d).onclick = act(async () => { await api('/dvr/recordings/' + p.recording.id, { method: 'DELETE' }); toast(t('Avbokad')); close(); });
  // Serieinspelning: regeldialogen (kanal, dagar, tidsfönster, bara nya, behåll, prioritet) i views/dvr.js
  if ($('#pds', d)) $('#pds', d).onclick = act(async () => {
    const m = await need('views/dvr.js');
    if (await m.ruleDialog({ program: { id, title: p.title, channel_id: p.channel_id, channel_name: p.channel_name } })) close();
  });
}
