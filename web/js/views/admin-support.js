// Administration – Support: ärenden från Feedback-knappen. Det som väntar på granskning står först. Administratören
// öppnar ett ärende, ser exakt det som skulle lämna servern, kan ändra texten och välja bort den tekniska
// informationen, och godkänner (då kan teamet hämta det med en API-nyckel), avslår eller tar bort. Svar från
// användare på teamets frågor granskas på samma sätt. Ett åtgärdat eller avslaget ärende kan öppnas igen (reopen). Servern: server/support.js, server/routes/support.js.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, toast, t } from '../core.js';
import { refreshFeedback } from '../feedback.js';
import { confirmDialog, openDialog, promptDialog } from '../ui/dialog.js';
import { AREA, KIND, contextHtml, statusBadge, threadHtml } from './support.js';

const refresh = () => { refreshFeedback().catch(() => {}); adminSupport().catch(() => {}); };
const WHO = () => ({ team: t('Teamet'), admin: t('Administratören'), user: t('Användaren') });
const first = (s) => { const l = String(s).split('\n')[0]; return l.length > 90 ? l.slice(0, 90) + '…' : l; };

/** Öppna ett avslutat ärende igen: till teamet direkt eller tillbaka till granskning */
function reopenDialog(k, parent) {
  const opt = (v, title, sub) => `<label class="fbopt"><input type="radio" name="asto" value="${v}"${(k.status === 'fixed') === (v === 'approved') ? ' checked' : ''}><span><b>${title}</b><small>${sub}</small></span></label>`;
  openDialog({
    title: t('Öppna ärende #{id} igen', { id: k.id }), form: true, className: 'fbdlg',
    body: `<p class="muted small">${t('T.ex. när felet kom tillbaka eller när avslaget var fel. Den som skickade ärendet ser den nya statusen under Mina ärenden.')}</p>
      <fieldset class="fbkind"><legend class="sr-only">${t('Vart ska ärendet?')}</legend>
        ${opt('approved', t('Skicka till teamet igen'), t('Ärendet syns för teamet direkt, med förklaringen nedan.'))}
        ${opt('pending', t('Tillbaka till granskning'), t('Teamet ser inget förrän du har godkänt ärendet igen. Förklaringen stannar på servern.'))}</fieldset>
      <div class="field"><label for="asnote">${t('Förklaring (valfri)')}</label><textarea id="asnote" rows="3" maxlength="4000" placeholder="${t('T.ex. Felet kom tillbaka i version 1.3.2.')}"></textarea></div>`,
    actions: [{ label: t('Avbryt'), kind: 'ghost' }, { label: t('Öppna igen'), kind: 'primary', submit: true, onClick: async (d) => {
      const to = d.$('[name=asto]:checked')?.value || 'pending';
      await api(`/admin/support/${k.id}/reopen`, { method: 'POST', bg: true, body: { to, note: d.$('#asnote').value } });
      toast(to === 'approved' ? t('Ärendet är öppnat igen och syns för teamet') : t('Ärendet är öppnat igen och väntar på granskning'));
      parent.close(); refresh();
    } }]
  });
}

function openTicket(k) {
  const pending = k.status === 'pending';
  const reply = k.thread.find(m => m.pending);
  const sender = k.byAdmin ? t('en administratör') : t('en användare');
  const body = `<p class="muted small">${t('Från {name} · {date}', { name: `<b>${esc(k.user || '–')}</b>`, date: fmtDate(k.created) })} · ${esc(KIND()[k.kind] || '')} · ${esc(AREA()[k.area] || '')} ${statusBadge(k)}</p>
    ${pending ? `<p class="muted small">${t('Användarens text:')}</p>${k.title ? `<p><b>${esc(k.title)}</b></p>` : ''}<p class="fbtxt fbquote">${esc(k.text)}</p>
      <h3>${t('Det här skickas till teamet')}</h3>
      <p class="muted small">${t('Namnet skickas aldrig – teamet ser bara att ärendet kommer från {sender}. Ändra texten om den innehåller något som inte ska lämna servern.', { sender })}</p>
      <div class="field"><label for="astitle">${t('Rubrik (valfri)')}</label><input id="astitle" maxlength="120" value="${esc(k.outgoing.title || '')}"></div>
      <div class="field"><label for="astext">${t('Meddelande')}</label><textarea id="astext" rows="6" maxlength="4000" required>${esc(k.outgoing.text)}</textarea></div>
      ${k.context ? `<label class="switch"><input type="checkbox" id="asctx" checked> <span>${t('Skicka med den tekniska informationen nedan')}</span></label>` : ''}
      ${contextHtml(k.context)}`
    : `<h3>${k.status === 'rejected' ? t('Ärendet (lämnade aldrig servern)') : t('Det här har skickats till teamet')}</h3>
      ${k.outgoing.title ? `<p><b>${esc(k.outgoing.title)}</b></p>` : ''}<p class="fbtxt fbquote">${esc(k.outgoing.text)}</p>
      ${threadHtml(k, WHO())}
      ${reply ? `<h3>${t('Svar som väntar på granskning')}</h3><p class="muted small">${t('Svaret skickas till teamet först när du godkänt det.')}</p>
        <div class="field"><label for="asreply">${t('Svaret')}</label><textarea id="asreply" rows="4" maxlength="4000" required>${esc(reply.text)}</textarea></div>` : ''}
      ${!reply && k.status === 'needinfo' ? `<div class="field"><label for="asown">${t('Svara teamet själv')}</label><textarea id="asown" rows="3" maxlength="4000"></textarea></div>` : ''}
      <details class="muted small"><summary>${t('Teknisk information som bifogades')}</summary>${contextHtml(k.context)}</details>`}`;
  const call = (path, o) => async (d) => { await api(`/admin/support/${k.id}${path}`, { bg: true, ...o(d) }); refresh(); };
  const actions = [{ label: t('Stäng'), kind: 'ghost' },
    { label: t('Ta bort'), kind: 'danger', onClick: async () => {
      if (!await confirmDialog(t('Ta bort ärende #{id}? Det försvinner även för den som skickade det.', { id: k.id }), { okLabel: t('Ta bort'), danger: true })) return false;
      await api('/admin/support/' + k.id, { method: 'DELETE', bg: true }); toast(t('Ärendet är borttaget')); refresh();
    } }];
  if (k.status === 'fixed' || k.status === 'rejected') actions.push({ label: t('Öppna igen'), kind: 'primary', onClick: (d) => { reopenDialog(k, d); return false; } });
  if (pending) actions.push(
    { label: t('Avslå'), kind: 'ghost', onClick: async () => {
      const note = await promptDialog(t('Förklaring till användaren (valfri)'), { title: t('Avslå ärendet'), text: t('Ärendet skickas inte till teamet. Förklaringen syns bara för den som skickade ärendet.'), type: 'textarea', maxlength: 4000, okLabel: t('Avslå') });
      if (note == null) return false;
      await api(`/admin/support/${k.id}/reject`, { method: 'POST', bg: true, body: { note } }); toast(t('Ärendet är avslaget')); refresh();
    } },
    { label: t('Godkänn och skicka'), kind: 'primary', onClick: async (d) => {
      if (!d.$('#astext').value.trim()) { d.$('#astext').focus(); return false; }
      await api(`/admin/support/${k.id}/approve`, { method: 'POST', bg: true, body: { title: d.$('#astitle').value, text: d.$('#astext').value, withContext: d.$('#asctx') ? d.$('#asctx').checked : true } });
      toast(t('Godkänt – teamet kan nu hämta ärendet')); refresh();
    } });
  if (reply) actions.push(
    { label: t('Avslå svaret'), kind: 'ghost', onClick: call('/reply/reject', () => ({ method: 'POST' })) },
    { label: t('Godkänn svaret'), kind: 'primary', onClick: call('/reply/approve', (d) => ({ method: 'POST', body: { text: d.$('#asreply').value } })) });
  if (!reply && k.status === 'needinfo') actions.push({ label: t('Skicka svaret'), kind: 'primary', onClick: async (d) => {
    if (!d.$('#asown').value.trim()) { d.$('#asown').focus(); return false; }
    await api(`/admin/support/${k.id}/reply`, { method: 'POST', bg: true, body: { text: d.$('#asown').value } }); refresh();
  } });
  openDialog({ title: t('Ärende #{id}', { id: k.id }), body, size: 'wide', className: 'fbdlg', actions });
}

export async function adminSupport() {
  const el = $('#adm-support'); if (!el) return;
  const S = await api('/admin/support');
  if (!el.isConnected) return;
  const row = (k) => `<tr><td><b>#${k.id}</b> ${statusBadge(k)}${k.pendingReply ? ` <span class="warn-badge">${t('Svar väntar på granskning')}</span>` : ''}
      <div>${esc(first(k.outgoing.title || k.outgoing.text))}</div>
      <div class="muted small">${esc(KIND()[k.kind] || '')} · ${esc(AREA()[k.area] || '')} · ${esc(k.user || '–')} · ${fmtDate(k.created)}</div></td>
    <td class="r"><button class="${k.status === 'pending' || k.pendingReply ? 'primary' : 'ghost'} small" data-sopen="${k.id}">${k.status === 'pending' || k.pendingReply ? t('Granska') : t('Öppna')}</button></td></tr>`;
  el.innerHTML = `<h2>Support ${S.review ? `<span class="warn-badge">${t('{n} väntar på granskning', { n: S.review })}</span>` : ''}</h2>
    <p class="muted small">${t('Feedback och felrapporter från knappen Feedback. Inget lämnar servern förrän du har granskat och godkänt det – dina egna ärenden är godkända direkt. Teamet hämtar godkända ärenden med en API-nyckel som har behörigheten Support (se API-nycklar nedan) och ser aldrig vem som skrev.')}</p>
    ${S.tickets.length ? `<table>${S.tickets.map(row).join('')}</table>` : `<p class="muted small">${t('Inga ärenden än.')}</p>`}`;
  $$('[data-sopen]', el).forEach(b => b.onclick = act(() => openTicket(S.tickets.find(k => k.id === +b.dataset.sopen))));
  // Länken från Feedback-dialogen och kontomenyn (#/admin?support) går hit
  if (/[?&]support\b/.test(location.hash) && !el.dataset.shown) { el.dataset.shown = '1'; el.scrollIntoView({ block: 'start' }); }
}
