// Vy: inspelningar (DVR) – kommande, pågående (titta medan den spelas in), inspelat, serieinspelningar med regler
// och konflikter i förväg med alternativa sändningar. Diskutrymme överst. Regeldialogen används även från TV-guiden.
// @lazy – laddas vid behov (LAZY i js/router.js)
import { $, $$, act, api, dayName, esc, fmtDur, fmtSize, hhmm, later, main, me, onLeave, toast, toastErr, views } from '../core.js';
import { playRec, RP } from '../player/live.js';
import { route } from '../router.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';
import { tabsHtml } from '../ui/tabs.js';

const DAYS = [[1, 'mån'], [2, 'tis'], [3, 'ons'], [4, 'tor'], [5, 'fre'], [6, 'lör'], [0, 'sön']];
const PRIOS = [[-2, 'Låg'], [0, 'Normal'], [3, 'Hög'], [6, 'Högst']];
const prioName = (p) => p > 4 ? 'högst' : p > 0 ? 'hög' : p < 0 ? 'låg' : '';
const hm = (m) => m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const when = (r) => `${dayName(r.start)} ${hhmm(r.start)}–${hhmm(r.stop)}`;
const GB = (b) => b == null ? '–' : fmtSize(b);
const PLAN = { late: 'Börjar sent', cut: 'Avbryts', missed: 'Spelas inte in' };
const fmtLabel = { '': 'Standard', mp4: 'MP4 (spelas överallt)', mkv: 'MKV (alla ljudspår och undertexter)', ts: 'TS (orörd)' };
const tcLabel = { '': 'Standard', auto: 'Bara vid behov', always: 'Alltid (mindre filer)', never: 'Aldrig' };
const opts = (o, cur) => Object.entries(o).map(([v, l]) => `<option value="${esc(v)}"${String(cur ?? '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('');

/** Sammanfattning av en regel: kanal, dagar, tid, bara nya, behåll … */
function ruleSummary(r) {
  const d = r.days ? DAYS.filter(([n]) => r.days & (1 << n)).map(([, l]) => l).join(', ') : '';
  return [r.channel_name || 'Alla kanaler', d, r.time_from != null && r.time_to != null ? `${hm(r.time_from)}–${hm(r.time_to)}` : '',
    r.new_only ? 'bara nya' : 'alla sändningar', r.skip_library && r.new_only ? 'hoppar över det som finns i biblioteket' : '',
    r.keep ? `sparar ${r.keep} senaste` : '', prioName(r.priority) ? `prioritet ${prioName(r.priority)}` : '',
    r.pad_before != null || r.pad_after != null ? `marginal ${Math.round((r.pad_before ?? 0) / 60)}/${Math.round((r.pad_after ?? 0) / 60)} min` : '',
    r.format ? r.format.toUpperCase() : '', r.enabled ? '' : 'pausad'].filter(Boolean).join(' · ');
}

/**
 * Dialog för en serieinspelning: ny (från ett program i guiden eller en titel) eller ändra en befintlig regel.
 * o = { rule } | { program: { id, title, channel_id, channel_name } } | {}. Returnerar true om något sparades.
 */
export async function ruleDialog(o = {}) {
  const r = o.rule || {};
  const p = o.program || null;
  let chans = [];
  try { chans = (await api('/live/channels', { bg: true })).channels || []; } catch {}
  const title = r.title || p?.title || '';
  const ch = r.id ? r.channel_id : p?.channel_id ?? null;
  const days = r.days || 0;
  const body = `<div class="field"><label for="rdt">Titel i TV-guiden</label><input id="rdt" value="${esc(title)}" required ${p || r.id ? 'readonly' : ''}></div>
    <div class="field"><label for="rdc">Kanal</label><select id="rdc"><option value="">Alla kanaler</option>${chans.map(c => `<option value="${c.id}"${c.id === ch ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <label class="small dvrchk"><input type="checkbox" id="rdn" ${r.id ? (r.new_only ? 'checked' : '') : 'checked'}> Bara nya avsnitt (hoppa över repriser och det som redan spelats in)</label>
    <label class="small dvrchk"><input type="checkbox" id="rdl" ${r.id ? (r.skip_library ? 'checked' : '') : 'checked'}> Hoppa över avsnitt som redan finns i biblioteket</label>
    <fieldset class="field" style="border:0;padding:0;margin:12px 0 0"><legend class="small">Veckodagar (inga valda = alla)</legend><div class="row" style="gap:6px;flex-wrap:wrap">
      ${DAYS.map(([n, l]) => `<label class="small"><input type="checkbox" data-day="${n}" ${days & (1 << n) ? 'checked' : ''}> ${l}</label>`).join('')}</div></fieldset>
    <div class="row" style="gap:12px;flex-wrap:wrap;margin-top:8px">
      <div class="field"><label for="rdf">Börjar tidigast</label><input id="rdf" type="time" value="${hm(r.time_from)}"></div>
      <div class="field"><label for="rdto">Börjar senast</label><input id="rdto" type="time" value="${hm(r.time_to)}"></div>
      <div class="field"><label for="rdk">Behåll senaste (0 = alla)</label><input id="rdk" type="number" min="0" max="1000" value="${r.keep || 0}" style="width:90px"></div>
      <div class="field"><label for="rdp">Prioritet</label><select id="rdp">${PRIOS.map(([v, l]) => `<option value="${v}"${(r.priority || 0) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <details><summary class="small">Marginaler och format</summary><div class="row" style="gap:12px;flex-wrap:wrap;margin-top:8px">
      <div class="field"><label for="rdb">Starta före (min)</label><input id="rdb" type="number" min="0" max="30" placeholder="standard" value="${r.pad_before != null ? Math.round(r.pad_before / 60) : ''}" style="width:90px"></div>
      <div class="field"><label for="rda">Sluta efter (min)</label><input id="rda" type="number" min="0" max="60" placeholder="standard" value="${r.pad_after != null ? Math.round(r.pad_after / 60) : ''}" style="width:90px"></div>
      <div class="field"><label for="rdfm">Format</label><select id="rdfm">${opts(fmtLabel, r.format)}</select></div>
      <div class="field"><label for="rdtc">Omkodning</label><select id="rdtc">${opts(tcLabel, r.transcode)}</select></div></div></details>
    ${r.id ? `<label class="small"><input type="checkbox" id="rde" ${r.enabled ? 'checked' : ''}> Aktiv (avmarkera för att pausa)</label>` : ''}
    <h3 class="small" style="margin:14px 0 4px">Kommande sändningar</h3><div id="rdpv" class="small muted">…</div>`;
  const values = (h) => ({
    title: h.$('#rdt').value.trim(), channelId: h.$('#rdc').value ? +h.$('#rdc').value : null, newOnly: h.$('#rdn').checked, skipLibrary: h.$('#rdl').checked,
    days: $$('[data-day]', h.el).filter(x => x.checked).map(x => +x.dataset.day), timeFrom: h.$('#rdf').value, timeTo: h.$('#rdto').value,
    keep: +h.$('#rdk').value || 0, priority: +h.$('#rdp').value, padBefore: h.$('#rdb').value === '' ? null : +h.$('#rdb').value * 60,
    padAfter: h.$('#rda').value === '' ? null : +h.$('#rda').value * 60, format: h.$('#rdfm').value || null, transcode: h.$('#rdtc').value || null,
    ...(h.$('#rde') ? { enabled: h.$('#rde').checked } : {})
  });
  const h = openDialog({ title: r.id ? 'Ändra serieinspelning' : 'Spela in serien', size: 'wide', form: true, body, actions: [{ label: 'Avbryt', value: false },
    { label: r.id ? 'Spara' : 'Spela in serien', kind: 'primary', submit: true, onClick: async (h) => {
      const b = values(h);
      if (!b.title) throw new Error('Ange en titel');
      if (r.id) await api('/dvr/rules/' + r.id, { method: 'PUT', body: b });
      else if (p) await api('/dvr/program', { method: 'POST', body: { ...b, programId: p.id, series: true, anyChannel: !b.channelId } });
      else await api('/dvr/rules', { method: 'POST', body: b });
      toast(r.id ? 'Serieinspelningen ändrad' : 'Serieinspelning skapad');
      return true;
    } }] });
  // Förhandsvisning: vad regeln skulle spela in, uppdateras när man ändrar något
  let timer = null, seq = 0;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const n = ++seq, b = values(h), box = h.$('#rdpv');
      if (!b.title || !box) return;
      try {
        const { airings } = await api('/dvr/rules/preview', { method: 'POST', body: b, bg: true });
        if (n !== seq || !box.isConnected) return;
        box.innerHTML = airings.length ? `<ul class="dvrpv">${airings.slice(0, 12).map(a => `<li>${dayName(a.start)} ${hhmm(a.start)} · ${esc(a.channel)}
          ${a.season != null ? ` · S${a.season}E${a.episode}` : ''}${a.subtitle ? ' ' + esc(a.subtitle) : ''}${a.isNew ? ' <span class="ok-badge">Nytt</span>' : ''}
          ${a.record ? ' <span class="ok-badge">Spelas in</span>' : ` <span class="muted">– ${esc(a.reason || '')}</span>`}</li>`).join('')}</ul>`
          : 'Inga sändningar i guiden just nu – regeln bokar när de dyker upp.';
      } catch (e) { if (box.isConnected) box.textContent = e.message; }
    }, 250);
  };
  h.el.addEventListener('input', preview); h.el.addEventListener('change', preview);
  preview();
  return !!(await h.closed);
}

/** Ändra en bokning: prioritet, marginaler, format */
async function editRecording(r) {
  const sched = r.status === 'scheduled';
  const h = openDialog({ title: r.title, form: true, body: `<p class="muted small">${esc(r.channel_name || '')} · ${when(r)}</p>
    <div class="row" style="gap:12px;flex-wrap:wrap"><div class="field"><label for="erp">Prioritet</label><select id="erp">${PRIOS.map(([v, l]) => `<option value="${v}"${(r.priority || 0) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    ${sched ? `<div class="field"><label for="erb">Starta före (min)</label><input id="erb" type="number" min="0" max="30" placeholder="standard" value="${r.pad_before != null ? Math.round(r.pad_before / 60) : ''}" style="width:90px"></div>` : ''}
    <div class="field"><label for="era">Sluta efter (min)</label><input id="era" type="number" min="0" max="60" placeholder="standard" value="${r.pad_after != null ? Math.round(r.pad_after / 60) : ''}" style="width:90px"></div>
    ${sched ? `<div class="field"><label for="erf">Format</label><select id="erf">${opts(fmtLabel, r.format)}</select></div>` : ''}</div>
    <p class="muted small">Högre prioritet vinner när tunrarna inte räcker – en inspelning med lägre prioritet avbryts då (det inspelade sparas).</p>`,
    actions: [{ label: 'Avbryt', value: false }, { label: 'Spara', kind: 'primary', submit: true, onClick: async (h) => {
      const v = (s) => h.$(s) && h.$(s).value !== '' ? +h.$(s).value * 60 : null;
      const b = { priority: +h.$('#erp').value, padAfter: v('#era') };
      if (sched) Object.assign(b, { padBefore: v('#erb'), format: h.$('#erf').value || null });
      const res = await api('/dvr/recordings/' + r.id, { method: 'PUT', body: b });
      toast(res.plan && res.plan !== 'ok' ? 'Sparat – men ' + PLAN[res.plan].toLowerCase() : 'Sparat');
      return true;
    } }] });
  return !!(await h.closed);
}

function diskBar(d) {
  if (!d) return '';
  const pct = d.total ? Math.round((1 - d.free / d.total) * 100) : null;
  const tight = d.free != null && d.upcoming > d.free * 0.9;
  return `<div class="dvrdisk" role="group" aria-label="Diskutrymme för inspelningar">
    ${pct != null ? `<div class="dvrdisk-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Använt utrymme"><i style="width:${pct}%"></i></div>` : ''}
    <div class="small"><b>${GB(d.free)}</b> ledigt${d.total ? ` av ${GB(d.total)}` : ''} · inspelningar tar ${GB(d.used)} · kommande vecka ≈ ${GB(d.upcoming)}
      <span class="muted">(${GB(d.bytesPerHour)}/timme)</span>${tight ? ' · <span class="warn-badge">Utrymmet kan ta slut</span>' : ''}</div></div>`;
}

views.dvr = async (tab) => {
  const D = await api('/dvr');
  const rec = D.scheduled.filter(r => r.status === 'recording'), proc = D.done.filter(r => r.status === 'processing');
  const sched = D.scheduled.filter(r => r.status === 'scheduled'), done = D.done.filter(r => r.status === 'done'), failed = D.done.filter(r => r.status === 'failed');
  const items = [{ key: 'upcoming', label: `Kommande (${sched.length})` }, { key: 'now', label: `Pågår (${rec.length + proc.length})` },
    { key: 'done', label: `Inspelat (${done.length})` }, { key: 'rules', label: `Serier (${D.rules.length})` }, { key: 'conflicts', label: `Konflikter (${D.conflicts || 0})` }];
  if (!items.some(t => t.key === tab)) tab = rec.length ? 'now' : sched.length || !done.length ? 'upcoming' : 'done';
  main.innerHTML = `<div class="toolbar"><h1>Inspelningar</h1><div class="row" style="margin-left:auto;flex-wrap:wrap"><a class="btn ghost" href="#/guide">📅 TV-guide</a><a class="btn ghost" href="#/live">Live-TV</a>
      <button class="ghost" id="dvrnew">⏺⏺ Ny serieinspelning</button></div></div>
    ${diskBar(D.disk)}
    ${D.conflicts && tab !== 'conflicts' ? `<p class="dvrwarn" role="status">⚠ ${D.conflicts === 1 ? 'En bokning' : D.conflicts + ' bokningar'} får inte plats på tunrarna. <a href="#/dvr/conflicts">Visa konflikter och förslag</a></p>` : ''}
    ${tabsHtml({ label: 'Inspelningar', items: items.map(t => ({ ...t, href: '#/dvr/' + t.key })), current: tab, panel: 'dvrpanel' })}
    <div id="dvrpanel" role="tabpanel" class="section"></div>
    ${D.dir ? `<p class="muted small">Inspelningar sparas i <code>${esc(D.dir)}</code> som <i>Serie/Season 01/Serie - S01E02 - Titel</i> med NFO – lägg till mappen i seriebiblioteket så hamnar de under rätt serie.</p>` : ''}`;
  const P = $('#dvrpanel');
  $('#dvrnew').onclick = act(async () => { if (await ruleDialog()) route(); });
  const row = (r, actions, extra = '') => `<div class="rec"><div><b>${esc(r.title)}</b>${r.subtitle ? ' – ' + esc(r.subtitle) : ''}${r.season != null && r.episode != null ? ` <span class="muted small">S${r.season}E${r.episode}</span>` : ''}
      <div class="muted small">${esc(r.channel_name || '')} · ${when(r)}${r.rule_id ? ' · serie' : ''}${prioName(r.priority) ? ' · prioritet ' + prioName(r.priority) : ''}${extra}</div></div><div class="row">${actions}</div></div>`;
  if (tab === 'upcoming') {
    P.innerHTML = sched.length ? `<div class="reclist">${sched.map(r => row(r, `<button class="ghost small" data-redit="${r.id}">Ändra</button><button class="ghost small" data-rdel="${r.id}">Avboka</button>`,
      `${r.plan !== 'ok' ? ` · <span class="warn-badge" title="${esc(r.planText || '')}">${PLAN[r.plan] || ''}</span>` : ''}${r.error ? ' · ' + esc(r.error) : ''}`)).join('')}</div>`
      : emptyState({ icon: '⏺', title: 'Inga bokade inspelningar', text: 'Välj ett program i TV-guiden, eller skapa en serieinspelning.', action: { label: 'Till TV-guiden', href: '#/guide' }, compact: true });
  } else if (tab === 'now') {
    P.innerHTML = rec.length + proc.length ? `<div class="reclist">${rec.map(r => row(r, `<button class="primary small" data-rwatch="${r.id}">▶ Titta</button><button class="ghost small" data-rstop="${r.id}">Stoppa</button>`,
      ` · <span class="liveind on small">⏺ Spelar in</span>`)).join('')}${proc.map(r => row(r, '', ' · Bearbetas…')).join('')}</div>`
      : emptyState({ icon: '⏺', title: 'Inget spelas in just nu', compact: true });
  } else if (tab === 'done') {
    P.innerHTML = (done.length ? `<div class="reclist">${done.map(r => row(r, `<button class="primary small" data-rplay="${r.id}">▶ Spela</button>
        <label class="small" title="Tas aldrig bort av Behåll senaste N"><input type="checkbox" data-rkeep="${r.id}" ${r.keep_forever ? 'checked' : ''}> Behåll alltid</label>
        ${me.adminHere && D.comskip?.enabled ? `<button class="ghost small" data-rcs="${r.id}" title="Analysera reklamavbrott igen">Leta reklam</button>` : ''}<button class="ghost small" data-rdel="${r.id}">Ta bort</button>`,
      ` · ${fmtDur(r.stop - r.start)}${r.size ? ' · ' + fmtSize(r.size) : ''}${r.file ? ' · ' + esc(r.file.split('.').pop().toUpperCase()) : ''}${r.commercials?.length ? ` · ${r.commercials.length} reklamavbrott` : ''}${['pending', 'running'].includes(r.commercials_status) ? ' · letar reklam…' : ''}${r.error ? ' · ' + esc(r.error) : ''}`)).join('')}</div>`
      : emptyState({ icon: '🎞', title: 'Inget inspelat ännu', compact: true }))
      + (failed.length ? `<h2 style="margin-top:20px">Misslyckade</h2><div class="reclist">${failed.map(r => row(r, `<button class="ghost small" data-rdel="${r.id}">Ta bort</button>`, ` · <span class="err">${esc(r.error || 'Misslyckades')}</span>`)).join('')}</div>` : '');
  } else if (tab === 'rules') {
    P.innerHTML = D.rules.length ? `<div class="reclist">${D.rules.map(r => `<div class="rec"><div><b>${esc(r.title)}</b><div class="muted small">${esc(ruleSummary(r))}</div>
      <div class="small">${r.upcoming} kommande · ${r.recorded} inspelade</div></div><div class="row"><button class="ghost small" data-rule-edit="${r.id}">Ändra</button><button class="ghost small" data-rule="${r.id}">Ta bort</button></div></div>`).join('')}</div>`
      : emptyState({ icon: '⏺⏺', title: 'Inga serieinspelningar', text: 'Öppna ett program i TV-guiden och välj Spela in serien, eller skapa en här.', compact: true });
  } else {
    P.innerHTML = '<p class="muted">Räknar …</p>';
    const { conflicts } = await api('/dvr/conflicts');
    if (!P.isConnected) return;
    P.innerHTML = conflicts.length ? `<p class="muted small">Så här räcker tunrarna med nuvarande bokningar. Flytta till en annan sändning eller ändra prioritet.</p><div class="reclist">${conflicts.map(c => {
      const r = c.recording;
      return `<div class="rec"><div><b>${esc(r.title)}</b>${r.subtitle ? ' – ' + esc(r.subtitle) : ''}<div class="muted small">${esc(r.channel_name || '')} · ${when(r)}</div>
        <div class="small"><span class="warn-badge">${PLAN[c.outcome]}</span> ${c.outcome === 'late' && c.from ? `från ${hhmm(c.from)}` : c.outcome === 'cut' && c.to ? `vid ${hhmm(c.to)}` : ''}
          ${c.with.length ? ` – krockar med ${c.with.map(w => `<b>${esc(w.title)}</b> (${esc(w.channel_name || '')} ${hhmm(w.start)})`).join(', ')}` : ''}</div>
        ${c.alternatives.length ? `<div class="row" style="margin-top:6px;flex-wrap:wrap"><span class="small">Annan sändning:</span>${c.alternatives.map(a => `<button class="ghost small" data-swap="${r.id}" data-pid="${a.programId}">${dayName(a.start)} ${hhmm(a.start)} · ${esc(a.channel)}</button>`).join('')}</div>` : ''}</div>
        <div class="row">${r.status === 'scheduled' ? `<button class="ghost small" data-rprio="${r.id}" data-to="${Math.min(10, Math.max(0, ...c.with.map(w => w.priority || 0)) + 1)}">Prioritera</button><button class="ghost small" data-rdel="${r.id}">Avboka</button>` : ''}</div></div>`;
    }).join('')}</div>` : emptyState({ icon: '✓', title: 'Inga konflikter', text: 'Alla bokningar får en tuner.', compact: true });
  }
  const all = [...D.scheduled, ...D.done];
  const byId = (id) => all.find(x => x.id === +id);
  $$('[data-rdel]', P).forEach(b => b.onclick = act(async () => {
    const r = byId(b.dataset.rdel);
    if (await confirmDialog(r ? `${b.textContent.trim()} ”${r.title}”?` : 'Ta bort inspelningen?', { okLabel: b.textContent.trim() || 'Ta bort', danger: true })) { await api('/dvr/recordings/' + b.dataset.rdel, { method: 'DELETE' }); route(); }
  }));
  $$('[data-redit]', P).forEach(b => b.onclick = act(async () => { if (await editRecording(byId(b.dataset.redit))) route(); }));
  $$('[data-rprio]', P).forEach(b => b.onclick = act(async () => { await api('/dvr/recordings/' + b.dataset.rprio, { method: 'PUT', body: { priority: +b.dataset.to } }); toast('Prioriterad'); route(); }));
  $$('[data-swap]', P).forEach(b => b.onclick = act(async () => {
    const r = await api(`/dvr/recordings/${b.dataset.swap}/swap`, { method: 'POST', body: { programId: +b.dataset.pid } });
    toast(r.plan === 'ok' ? 'Flyttad – får en tuner' : 'Flyttad'); route();
  }));
  $$('[data-rstop]', P).forEach(b => b.onclick = act(async () => { await api(`/dvr/recordings/${b.dataset.rstop}/stop`, { method: 'POST' }); toast('Stoppad – sparas'); later(route, 1500); }));
  $$('[data-rcs]', P).forEach(b => b.onclick = act(async () => { await api(`/dvr/recordings/${b.dataset.rcs}/commercials`, { method: 'POST' }); toast('Letar reklamavbrott i bakgrunden'); later(route, 1500); }));
  $$('[data-rkeep]', P).forEach(b => b.onchange = async () => { try { await api('/dvr/recordings/' + b.dataset.rkeep, { method: 'PUT', body: { keepForever: b.checked } }); toast(b.checked ? 'Behålls alltid' : 'Följer regelns Behåll senaste'); } catch (e) { b.checked = !b.checked; toastErr(e); } });
  $$('[data-rule]', P).forEach(b => b.onclick = act(async () => { if (await confirmDialog('Ta bort serieinspelningen och dess bokningar? Det som redan spelats in finns kvar.', { okLabel: 'Ta bort', danger: true })) { await api('/dvr/rules/' + b.dataset.rule, { method: 'DELETE' }); route(); } }));
  $$('[data-rule-edit]', P).forEach(b => b.onclick = act(async () => { if (await ruleDialog({ rule: D.rules.find(r => r.id === +b.dataset.ruleEdit) })) route(); }));
  const play = (b, id) => act(async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await playRec(byId(id), D.comskip || {}); } finally { b.disabled = false; }
  });
  $$('[data-rplay]', P).forEach(b => b.onclick = play(b, b.dataset.rplay));
  $$('[data-rwatch]', P).forEach(b => b.onclick = play(b, b.dataset.rwatch));
  // Pågående inspelningar och bearbetning: uppdatera listan medan man tittar på den
  if (tab === 'now' && rec.length + proc.length) { const t = setInterval(() => { if (!document.querySelector('dialog[open]') && !RP) route(); }, 30000); onLeave(() => clearInterval(t)); }
};
