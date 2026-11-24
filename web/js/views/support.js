// Feedback och felrapporter: dialogen bakom knappen Feedback (openFeedback) och vyn Mina ärenden (#/support).
// Vanliga användares ärenden granskas av en administratör innan de skickas till utvecklarna; administratörens egna
// skickas direkt. All text från användare och team visas med esc() och radbrytningar via CSS – aldrig som HTML.
// Servern: server/support.js, server/routes/support.js. Knappen: js/feedback.js. Granskningen: views/admin-support.js.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, lang, main, me, routeGen, toast, toastErr, views, t } from '../core.js';
import { curPlayer } from '../lazy.js';
import { feedbackCounts, refreshFeedback } from '../feedback.js';
import { openDialog } from '../ui/dialog.js';
import { emptyState, errorState, bindRetry } from '../ui/states.js';

export const KIND = () => ({ idea: t('Förslag eller synpunkt'), bug: t('Något fungerar inte') });
export const AREA = () => ({ film: t('Film och serier'), musik: t('Musik'), ljud: t('Ljudböcker och poddar'), livetv: t('Live-TV'), uppspelning: t('Uppspelning'),
  appen: t('Appen i allmänhet'), annat: t('Annat') });
const STATUS = () => ({ pending: [t('Väntar på granskning'), 'warn-badge'], approved: [t('Godkänt – skickat till teamet'), 'ok-badge hb-info'], working: [t('Åtgärdas'), 'ok-badge hb-info'],
  needinfo: [t('Behöver mer information'), 'warn-badge'], fixed: [t('Åtgärdat'), 'ok-badge'], rejected: [t('Avslaget'), 'warn-badge hb-err'] });
/** Statusmärket för ett ärende ("Åtgärdat i version 1.2.3") */
export function statusBadge(k) {
  const [label, cls] = STATUS()[k.status] || [k.status, ''];
  return `<span class="${cls}">${esc(k.status === 'fixed' && k.version ? t('Åtgärdat i version {v}', { v: k.version }) : label)}</span>`;
}
const refresh = () => { refreshFeedback().catch(() => {}); };

// ---------- den tekniska informationen ----------
// Vad sidan handlar om, efter första delen av adressen (förval i "Gäller")
const AREA_OF = { item: 'film', lib: 'film', person: 'film', collection: 'film', collections: 'film', ucollection: 'film', watchlist: 'film', streaming: 'film', vod: 'film',
  music: 'musik', album: 'musik', artist: 'musik', playlist: 'musik', smart: 'musik', books: 'ljud', book: 'ljud', podcasts: 'ljud', podcast: 'ljud',
  live: 'livetv', guide: 'livetv', epg: 'livetv', dvr: 'livetv', iptvadmin: 'livetv' };
const pageName = () => location.hash.slice(2).split('?')[0].split('/')[0];
// Token och koder i adresser ska aldrig följa med (servern maskerar en gång till)
const scrub = (s) => String(s).replace(/([?&](?:t|kt|token|key|code|sig|pid)=)[^&\s"')]+/gi, '$1…').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '…');
/** Det webben bifogar: sidan, webbläsaren, skärmen, språket, titeln man står på och de senaste felen på sidan */
function clientContext() {
  const [name, arg] = location.hash.slice(2).split('?')[0].split('/');
  const dpr = Math.round((window.devicePixelRatio || 1) * 10) / 10;
  const c = { route: scrub(location.hash.split('?')[0] || '#/'), ua: navigator.userAgent, screen: `${window.innerWidth}×${window.innerHeight}${dpr !== 1 ? ` @${dpr}` : ''}`, lang,
    errors: (self.bxErrors || []).map(scrub) };
  const playing = curPlayer()?.it?.id;
  const id = name === 'item' && /^\d+$/.test(arg || '') ? +arg : playing;
  if (id) c.itemId = id;
  if (window.matchMedia?.('(display-mode: standalone)').matches) c.app = true;
  return c;
}
const dur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
/** Den tekniska informationen som en lista (det servern sparar och – efter godkännande – skickar) */
export function contextHtml(c) {
  if (!c) return `<p class="muted small">${t('Ingen teknisk information bifogas.')}</p>`;
  const rows = [];
  const add = (k, v) => { if (v != null && v !== '') rows.push(`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`); };
  add(t('Appversion'), c.version);
  add(t('Sida'), c.page);
  add(t('Webbläsare och enhet'), c.browser);
  add(t('Skärmstorlek'), c.screen);
  add(t('Språk'), c.lang);
  if (c.installed) add(t('Installerad som app'), t('Ja'));
  if (c.title) add(t('Titel'), `#${c.title.id} ${c.title.name}${c.title.year ? ` (${c.title.year})` : ''}${c.title.format ? ` – ${c.title.format}` : ''}`);
  const p = c.lastPlayback;
  if (p) add(t('Senaste uppspelningen'), [`#${p.item} ${p.name}`, p.format, p.mode, p.quality, p.position != null ? `${dur(p.position)}${p.duration ? ' / ' + dur(p.duration) : ''}` : '',
    p.remote ? t('utanför hemmet') : t('hemma'), t('för {n} min sedan', { n: p.minutesAgo })].filter(Boolean).join(' · '));
  for (const e of c.pageErrors || []) add(t('Fel på sidan'), e);
  return `<dl class="fbctx">${rows.join('')}</dl>`;
}

// ---------- dialogen ----------
let open = false;
/** Öppnar "Feedback och felrapporter" */
export function openFeedback() {
  if (open || !me) return;
  open = true;
  const K = KIND(), A = AREA();
  const hasErrors = !!(self.bxErrors || []).length;
  const area = curPlayer() ? 'uppspelning' : AREA_OF[pageName()] || 'appen';
  const opt = (v, sub, on) => `<label class="fbopt"><input type="radio" name="fbkind" value="${v}"${on ? ' checked' : ''}><span><b>${esc(K[v])}</b><small>${esc(sub)}</small></span></label>`;
  const review = me.is_admin ? t('Du är administratör: ärendet skickas direkt till utvecklarna.')
    : t('En administratör läser ärendet först. Det skickas till utvecklarna bara om administratören godkänner det.');
  const d = openDialog({
    title: t('Feedback och felrapporter'), form: true, className: 'fbdlg',
    body: `<fieldset class="fbkind"><legend class="sr-only">${t('Vad vill du göra?')}</legend>
        ${opt('idea', t('Idéer, önskemål och beröm'), !hasErrors)}${opt('bug', t('Rapportera ett fel'), hasErrors)}</fieldset>
      <div class="field"><label for="fbarea">${t('Gäller')}</label><select id="fbarea">${Object.entries(A).map(([k, v]) => `<option value="${k}"${k === area ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      <div class="field"><label for="fbtext">${t('Meddelande')}</label>
        <textarea id="fbtext" rows="5" maxlength="4000" required aria-describedby="fbhint" placeholder="${t('T.ex. Tryckte på Spela på en film. Bilden frös efter en minut.')}"></textarea>
        <p class="hint" id="fbhint">${t('Vad gjorde du, vad hände och vad hade du väntat dig?')}</p></div>
      <label class="switch fbtech"><input type="checkbox" id="fbtech" checked> <span>${t('Skicka med teknisk information (sida, webbläsare, skärmstorlek och fel som uppstått på sidan)')}</span></label>
      <details id="fbdet"><summary>${t('Visa vad som skickas med')}</summary><div id="fbctx" aria-live="polite"></div></details>
      <p class="muted small fbnote">${esc(review)} ${t('Svaret syns under <a href="#/support">Mina ärenden</a>.')}</p>
      ${me.adminHere && feedbackCounts().review ? `<p class="small fbnote"><a href="#/admin?support">${t('{n} väntar på din granskning under Administration → Support', { n: feedbackCounts().review })}</a></p>` : ''}`,
    actions: [{ label: t('Stäng'), kind: 'ghost', value: null }, { label: t('Skicka'), kind: 'primary', submit: true, onClick: send }],
    onClose: () => { open = false; }
  });
  const kind = () => d.$('[name=fbkind]:checked')?.value || 'bug';
  // "Visa vad som skickas med": servern svarar med exakt det som skulle sparas (samma funktion som vid Skicka)
  let seq = 0;
  async function preview() {
    const box = d.$('#fbctx'), det = d.$('#fbdet');
    det.hidden = !d.$('#fbtech').checked;
    if (det.hidden || !det.open) return;
    const n = ++seq;
    try {
      const r = await api('/support/context', { method: 'POST', bg: true, body: { kind: kind(), context: clientContext() } });
      if (n === seq && box.isConnected) box.innerHTML = contextHtml(r.context);
    } catch (e) { if (n === seq && box.isConnected) box.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
  }
  d.$('#fbdet').addEventListener('toggle', preview);
  d.$('#fbtech').onchange = preview;
  $$('[name=fbkind]', d.el).forEach(r => r.onchange = preview);
  async function send() {
    const tech = d.$('#fbtech').checked;
    const r = await api('/support', { method: 'POST', bg: true, body: { kind: kind(), area: d.$('#fbarea').value, text: d.$('#fbtext').value, tech, context: tech ? clientContext() : null } });
    d.close();
    refresh();
    const sent = r.status === 'approved';
    openDialog({
      title: sent ? t('Tack – ärendet är skickat') : t('Tack – ärendet är mottaget'),
      body: `<p>${sent ? t('Ärendet är skickat till teamet.') : t('Ärendet är mottaget och väntar på granskning.')}</p>
        <p class="muted small">${t('Svaret syns under <a href="#/support">Mina ärenden</a>.')}</p>`,
      actions: [{ label: t('Klar'), kind: 'primary' }]
    });
    // Står man på Mina ärenden: visa det nya direkt
    if (pageName() === 'support') views.support().catch(() => {});
    return false;
  }
}

// ---------- Mina ärenden ----------
const FROM = () => ({ team: t('Teamet'), admin: t('Administratören'), user: t('Du') });
/** Svaren i ett ärende. who = namn per avsändare (administratörens vy visar "Användaren" i stället för "Du") */
export function threadHtml(k, who = FROM()) {
  return k.thread.map(m => `<div class="fbmsg${m.from === 'team' ? ' team' : ''}"><div class="muted small"><b>${esc(who[m.from] || m.from)}</b> · ${fmtDate(m.created)}${m.pending ? ` · <span class="warn-badge">${t('Väntar på granskning')}</span>` : ''}</div>
    ${m.text ? `<p class="fbtxt">${esc(m.text)}</p>` : `<p class="muted small">${esc(STATUS()[m.status]?.[0] || '')}</p>`}</div>`).join('');
}
function ticketHtml(k) {
  const K = KIND(), A = AREA();
  return `<div class="panel fbticket" id="fbt${k.id}"><div class="row fbhead"><b>#${k.id}</b> ${statusBadge(k)}<span class="muted small">${esc(K[k.kind] || '')} · ${esc(A[k.area] || '')} · ${fmtDate(k.created)}</span></div>
    ${k.title ? `<h2>${esc(k.title)}</h2>` : ''}<p class="fbtxt">${esc(k.text)}</p>
    ${k.sentText || k.sentTitle ? `<details class="muted small"><summary>${t('Administratören ändrade texten innan den skickades')}</summary>${k.sentTitle ? `<p><b>${esc(k.sentTitle)}</b></p>` : ''}<p class="fbtxt">${esc(k.sentText || k.text)}</p></details>` : ''}
    ${threadHtml(k)}
    ${k.canReply ? `<form class="fbreply" data-reply="${k.id}"><label for="fbr${k.id}">${t('Ditt svar till teamet')}</label><textarea id="fbr${k.id}" rows="3" maxlength="4000" required></textarea>
      <p class="hint muted small">${me.is_admin ? t('Svaret skickas direkt till teamet.') : t('Svaret granskas av en administratör innan det skickas vidare.')}</p>
      <div class="row"><button class="primary">${t('Skicka svaret')}</button></div></form>` : ''}
    <details class="muted small"><summary>${t('Teknisk information som bifogades')}</summary>${contextHtml(k.context)}</details></div>`;
}
views.support = async (focusId) => {
  if (!me) { location.hash = '#/login'; return; }
  const g = routeGen;
  let R;
  try { R = await api('/support'); } catch (e) { if (g !== routeGen || e?.aborted) return; main.innerHTML = errorState(e, { retry: true }); bindRetry(main, () => views.support(focusId)); return; }
  if (g !== routeGen) return;
  main.innerHTML = `<section class="fbmine"><div class="toolbar"><h1>${t('Mina ärenden')}</h1><button type="button" class="primary" id="fbnew">${t('Nytt ärende')}</button></div>
    <p class="muted">${t('Här ser du det du har skickat in, vad som händer med det och teamets svar. Bara du ser dina ärenden.')}</p>
    ${R.tickets.length ? R.tickets.map(ticketHtml).join('') : emptyState({ icon: '💬', title: t('Inga ärenden än'), text: t('Har du en idé eller är det något som inte fungerar? Tryck på Feedback.') })}</section>`;
  $('#fbnew').onclick = openFeedback;
  $$('[data-reply]', main).forEach(f => f.onsubmit = act(async (e) => {
    e.preventDefault();
    const b = $('button', f); b.disabled = true;
    try {
      await api(`/support/${f.dataset.reply}/reply`, { method: 'POST', body: { text: $('textarea', f).value } });
      toast(me.is_admin ? t('Svaret är skickat till teamet') : t('Svaret är mottaget och väntar på granskning'));
      refresh();
      await views.support();
    } catch (err) { b.disabled = false; toastErr(err); }
  }));
};
