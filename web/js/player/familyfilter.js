// Familjefiltret i videospelaren (server/familyfilter.js levererar planen i /playback → filter):
// - mute: [[start, slut]] – ljudet tystas (video.muted) exakt i intervallen. Nästa gräns schemaläggs med en timer
//   räknad på uppspelningshastigheten och kontrolleras nära gränsen bildruta för bildruta (requestVideoFrameCallback);
//   timeupdate, seeking, play och ratechange räknar om. server = true: strömmen är redan tystad av servern, spelaren
//   visar bara indikatorn.
// - skip: [{ start, end }] – läget "tysta + hoppa över": spelaren hoppar till scenens slut.
// - Vuxna profiler kan markera scener under ⚙ (för sig själva, hushållet eller – administratören – alla).
// Undertexterna maskeras av servern (*** i stället för ordet).
import { $, $$, api, esc, fmtTime, me, toast, toastErr, t } from '../core.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';

const LEAD = 0.03;   // tysta så här mycket före intervallet (s) – timern kan komma några ms sent
const NEAR = 0.6;    // närmare gränsen än så: kontroll varje bildruta
const SCOPE = { me: t('Bara jag'), household: t('Hushållet'), all: t('Alla på servern') };

/** Intervallet som tiden t ligger i ([a, b]) eller null – list är sorterad */
export function inside(list, t, lead = 0) {
  for (const [a, b] of list) { if (t < a - lead) return null; if (t < b) return [a, b]; }
  return null;
}
/** Nästa gräns efter t (start − lead eller slut) */
export function nextEdge(list, t, lead = 0) {
  for (const [a, b] of list) { if (t < a - lead) return a - lead; if (t < b) return b; }
  return Infinity;
}

/** Gruppen i spelarens inställningar och indikatorn – en gång per spelare */
export function initFilter(cur, v) {
  const el = cur.el, setp = $('#setp', el);
  const ff = cur.ff = { plan: null, muted: false, user: false, timer: 0, frame: 0, markStart: null, v };
  const badge = document.createElement('div');
  badge.className = 'ffbadge'; badge.id = 'ffbadge'; badge.hidden = true; badge.setAttribute('role', 'status');
  el.append(badge);
  if (setp && !me?.kid) {
    const g = document.createElement('div');
    g.className = 'setgrp'; g.id = 'ffgrp';
    g.innerHTML = `<b>${t('Familjefilter')}</b><span class="muted small" id="ffstate"></span>
      <div class="row" style="gap:6px;margin-top:4px"><button type="button" class="ghost small" id="ffmark">${t('Markera scen att hoppa över')}</button>
      <button type="button" class="ghost small" id="fflist">${t('Markerade scener')}</button></div>`;
    setp.append(g);
    $('#ffmark', g).onclick = () => markScene(cur, v);
    $('#fflist', g).onclick = () => listScenes(cur, v);
  }
  const tick = () => check(cur);
  for (const ev of ['timeupdate', 'seeking', 'seeked', 'play', 'playing', 'pause', 'ratechange', 'loadedmetadata']) v.addEventListener(ev, tick);
  // Någon slår på ljudet (tangenten m, volymreglaget) mitt i ett tystat intervall: det gäller efter intervallet
  v.addEventListener('volumechange', () => { if (ff.muted && !v.muted) { ff.user = false; v.muted = true; } });
}
/** Ny plan efter varje /playback (även kvalitets- och ljudbyte) */
export function applyFilter(cur, v, pb) {
  const ff = cur.ff; if (!ff) return;
  const f = pb?.filter || null;
  ff.plan = f ? { ...f, mute: [...(f.mute || [])].sort((a, b) => a[0] - b[0]), skip: [...(f.skip || [])].sort((a, b) => a.start - b.start) } : null;
  ff.item = f?.item || pb?.version || cur.it.id;
  const st = $('#ffstate', cur.el);
  if (st) st.textContent = !f ? t(' Av för din profil – markerade scener gäller profiler med filtret på')
    : ` ${f.mode === 'skip' ? t('Tystar svordomar och hoppar över markerade scener') : t('Tystar svordomar')}${f.ready ? ` ${t('({muteN} ställen)', { muteN: f.mute.length })}` : t(' – undertexterna läses fortfarande in')}`;
  if (!f) setMute(cur, false);
  check(cur);
}
export function stopFilter(cur) {
  const ff = cur?.ff; if (!ff) return;
  clearTimeout(ff.timer); ff.timer = 0;
  if (ff.frame && ff.v.cancelVideoFrameCallback) ff.v.cancelVideoFrameCallback(ff.frame);
  ff.frame = 0;
  if (ff.muted) { ff.muted = false; ff.v.muted = ff.user; }
  ff.plan = null;
}

function setMute(cur, on, server = false) {
  const ff = cur.ff, v = ff.v;
  if (!server && on !== ff.muted) {
    if (on) { ff.user = v.muted; ff.muted = true; v.muted = true; }
    else { ff.muted = false; v.muted = ff.user; }
  }
  badge(cur, on ? t('Tystat av familjefiltret') : '');
}
let badgeTimer = 0;
function badge(cur, text, ms = 0) {
  const b = $('#ffbadge', cur.el); if (!b) return;
  if (!text && b.dataset.hold === '1') return;
  clearTimeout(badgeTimer);
  b.textContent = text ? '🔇 ' + text : ''; b.hidden = !text;
  b.dataset.hold = ms ? '1' : '';
  if (ms) badgeTimer = setTimeout(() => { b.dataset.hold = ''; b.hidden = true; }, ms);
}

/** Läget vid tiden t (videons tid, eller bildrutans mediaTime) – tystar, hoppar och schemalägger nästa kontroll */
function check(cur, at = null) {
  const ff = cur.ff; if (!ff) return;
  const v = ff.v, p = ff.plan;
  clearTimeout(ff.timer); ff.timer = 0;
  if (!p || !v.isConnected) return;
  const tt = at ?? v.currentTime;
  if (p.mode === 'skip' && p.skip.length && !v.seeking) {
    const k = p.skip.find(x => tt >= x.start - LEAD && tt < x.end - 0.25);
    if (k) {
      v.currentTime = k.end;
      badge(cur, t('Hoppade över en scen{v}', { v: k.label ? ' (' + k.label + ')' : '' }), 2500);
      return;
    }
  }
  setMute(cur, !!inside(p.mute, tt, LEAD), p.server);
  if (v.paused || v.seeking) return;
  // Nästa gräns: tysta-intervallens kanter och nästa scen att hoppa över
  let edge = nextEdge(p.mute, tt, LEAD);
  if (p.mode === 'skip') { const k = p.skip.find(x => x.start - LEAD > tt); if (k) edge = Math.min(edge, k.start - LEAD); }
  const dt = (edge - tt) / (v.playbackRate || 1);
  if (!isFinite(dt)) return;
  if (dt > NEAR) ff.timer = setTimeout(() => check(cur), Math.min(5000, (dt - NEAR / 2) * 1000));
  else {
    // Nära gränsen: exakt timer + kontroll per bildruta (mediaTime = bildens tid)
    ff.timer = setTimeout(() => check(cur), Math.max(0, dt * 1000 - 4));
    if (v.requestVideoFrameCallback && !ff.frame) ff.frame = v.requestVideoFrameCallback((_, md) => { ff.frame = 0; if (cur.ff === ff && ff.plan) check(cur, Math.max(md.mediaTime, v.currentTime)); });
  }
}

// ---------- markera scener ----------
async function markScene(cur, v) {
  const ff = cur.ff, b = $('#ffmark', cur.el);
  if (ff.markStart == null) {
    ff.markStart = v.currentTime;
    b.textContent = t('Scenen slutar här (start {markStart})', { markStart: fmtTime(ff.markStart) });
    toast(t('Spela fram till där scenen slutar och tryck igen'));
    return;
  }
  const start = ff.markStart, end = v.currentTime;
  ff.markStart = null; b.textContent = t('Markera scen att hoppa över');
  if (end - start < 0.5) return toast(t('Scenen slutar före den börjar – markera igen'));
  const wasPlaying = !v.paused; v.pause();
  const scopes = me?.is_admin ? ['me', 'household', 'all'] : ['me', 'household'];
  const d = openDialog({
    title: t('Hoppa över scenen'), form: true,
    body: `<p class="muted">${t('{start} – {end} ({v} s). Profiler med läget <i>Tysta + hoppa över</i> hoppar över den.', { start: fmtTime(start), end: fmtTime(end), v: Math.round(end - start) })}</p>
      <div class="field"><label for="ffl">${t('Beskrivning (valfri)')}</label><input id="ffl" maxlength="80" placeholder="${t('T.ex. våld, skräck')}"></div>
      <div class="field"><label for="ffs">${t('Gäller')}</label><select id="ffs">${scopes.map(s => `<option value="${s}" ${s === 'household' ? 'selected' : ''}>${SCOPE[s]}</option>`).join('')}</select></div>`,
    actions: [{ label: t('Avbryt'), value: null }, { label: t('Spara'), kind: 'primary', submit: true,
      onClick: async (h) => {
        const r = await api(`/items/${ff.item || cur.it.id}/skips`, { method: 'POST', body: { start, end, label: h.$('#ffl').value, scope: h.$('#ffs').value } });
        return r;
      } }]
  });
  const r = await d.closed;
  if (r && typeof r === 'object') { toast(t('Scenen är markerad')); refreshSkips(cur, r.skips); }
  if (wasPlaying && cur.ff === ff) v.play().catch(() => {});
}
function refreshSkips(cur, list) {
  const p = cur.ff?.plan;
  if (p && p.mode === 'skip') { p.skip = list.map(({ id, start, end, label }) => ({ id, start, end, label })).sort((a, b) => a.start - b.start); check(cur); }
}
async function listScenes(cur, v) {
  const ff = cur.ff;
  let r; try { r = await api(`/items/${ff.item || cur.it.id}/skips`); } catch (e) { return toastErr(e); }
  const row = (k) => `<tr><td><button type="button" class="ghost small" data-ffgo="${+k.start}">${fmtTime(k.start)} – ${fmtTime(k.end)}</button></td>
    <td>${esc(k.label || '')}<div class="muted small">${esc(SCOPE[k.scope] || '')}${k.by && !k.mine ? ' · ' + esc(k.by) : ''}</div></td>
    <td class="r">${k.canDelete ? `<button type="button" class="danger small" data-ffdel="${+k.id}">${t('Ta bort')}</button>` : ''}</td></tr>`;
  const d = openDialog({ title: t('Markerade scener'), size: 'wide',
    body: r.skips.length ? `<table>${r.skips.map(row).join('')}</table>` : t('<p class="muted">Inga scener är markerade för den här titeln.</p>') });
  $$('[data-ffgo]', d.el).forEach(b => b.onclick = () => { ff.markStart = null; d.close(); v.currentTime = +b.dataset.ffgo; });
  $$('[data-ffdel]', d.el).forEach(b => b.onclick = async () => {
    if (!await confirmDialog(t('Ta bort markeringen?'), { okLabel: t('Ta bort'), danger: true })) return;
    try {
      await api('/skips/' + b.dataset.ffdel, { method: 'DELETE' });
      b.closest('tr').remove(); toast(t('Borttagen'));
      const n = await api(`/items/${ff.item || cur.it.id}/skips`); refreshSkips(cur, n.skips);
    } catch (e) { toastErr(e); }
  });
}
