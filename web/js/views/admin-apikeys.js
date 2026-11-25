// Administration – API-nycklar: dela ut åtkomst till Nu spelas och biblioteket åt andra system (väggskärm, Home
// Assistant, Homepage …) och – med behörigheten Support – låt utvecklarteamet läsa godkända felrapporter och svara på dem.
// Nyckeln visas en gång; namn, behörigheter och hemnätet kan ändras efteråt (Ändra) utan att nyckeln visas igen. Servern: server/apikeys.js, server/routes/apikeys.js.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, toast, t } from '../core.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';

const SCOPE_LABEL = () => ({ nowplaying: t('Vad som spelas just nu (titel, vem, enhet och hur långt)'), library: t('Biblioteket: antal titlar och nyligen tillagt'),
  support: t('Support: läsa felrapporter som du har godkänt och svara på dem (det enda en nyckel kan skriva)') });

function keyDialog(k) {
  openDialog({
    title: t('API-nyckel – {name}', { name: k.name }),
    body: `<p>${t('Skicka nyckeln i rubriken <code>X-Api-Key</code>. <b>Nyckeln visas bara nu</b> – kopiera den och klistra in den där den ska användas.')}</p>
      <p class="whsecret">${esc(k.key)}</p>
      <p class="muted small">${t('Exempel: <code>curl -H "X-Api-Key: …" {url}/api/v1/now-playing</code>', { url: esc(location.origin) })}</p>`,
    actions: [{ label: t('Kopiera'), kind: 'ghost', onClick: async () => { try { await navigator.clipboard.writeText(k.key); toast(t('Kopierad')); } catch { toast(t('Markera och kopiera nyckeln själv')); } return false; } },
      { label: t('Klar'), kind: 'primary' }]
  });
}

/** Behörigheterna och hemnätet som kryssrutor (samma i Skapa och Ändra) */
const scopeBoxes = (K, L, k) => Object.keys(K.scopes).map(s => `<label class="switch"><input type="checkbox" name="akscope" value="${esc(s)}" ${(k ? k.scopes.includes(s) : s === 'nowplaying') ? 'checked' : ''}> ${esc(L[s] || K.scopes[s])}</label>`).join('')
  + `<label class="switch"><input type="checkbox" name="akhome" ${!k || k.homeOnly ? 'checked' : ''}> ${t('Bara från hemnätet')} <span class="muted">${t('(rekommenderas – stäng av bara om systemet finns utanför hemmet)')}</span></label>`;

function editDialog(k, K, L) {
  openDialog({
    title: t('Ändra nyckeln {name}', { name: k.name }), form: true,
    body: `<p class="muted small">${t('Själva nyckeln ändras inte och visas inte igen. Det som använder den fortsätter fungera med de nya behörigheterna.')}</p>
      <label for="akename">${t('Namn (var nyckeln används)')}</label><input id="akename" maxlength="60" required value="${esc(k.name)}">
      ${scopeBoxes(K, L, k)}`,
    actions: [{ label: t('Avbryt'), kind: 'ghost' }, { label: t('Spara'), kind: 'primary', submit: true, onClick: async (d) => {
      const scopes = $$('[name=akscope]', d.el).filter(x => x.checked).map(x => x.value);
      await api('/apikeys/' + k.id, { method: 'PUT', bg: true, body: { name: d.$('#akename').value, scopes, homeOnly: d.$('[name=akhome]').checked } });
      toast(t('Nyckeln är ändrad'));
      adminApiKeys().catch(() => {});
    } }]
  });
}

export async function adminApiKeys() {
  const el = $('#adm-apikeys'); if (!el) return;
  const K = await api('/apikeys');
  if (!el.isConnected) return;
  const L = SCOPE_LABEL();
  el.innerHTML = `<h2>${t('API-nycklar')}</h2>
    <p class="muted small">${t('Låt andra system läsa vad som spelas eller vad som finns i biblioteket, t.ex. en väggskärm eller Home Assistant. Nycklarna kan bara läsa och aldrig strömma något. Enda undantaget är behörigheten Support. Se <i>docs/api.md</i> för adresserna.')}</p>
    <p class="muted small">${t('<b>Support</b> är för utvecklarteamet: nyckeln kan läsa de felrapporter du har godkänt under Support här ovanför (aldrig väntande eller avslagna, och aldrig namn på användare) och sätta status och svar på dem. Den kan inte läsa eller ändra något annat. Finns teamet utanför hemmet: stäng av <i>Bara från hemnätet</i> för den nyckeln.')}</p>
    ${K.keys.length ? `<table>${K.keys.map(k => `<tr><td><b>${esc(k.name)}</b> <code class="muted small">${esc(k.prefix)}…</code>
      <div class="muted small">${k.scopes.map(s => esc(L[s] || s)).join(' · ')}${k.homeOnly ? ' · ' + t('bara hemnätet') : ' · ' + t('även utanför hemmet')}</div>
      <div class="muted small">${k.lastUsed ? t('Senast använd {v} från {ip}', { v: fmtDate(k.lastUsed), ip: esc(k.lastIp || '–') }) : t('Inte använd än')}</div></td>
      <td class="r"><button class="ghost small" data-kedit="${k.id}">${t('Ändra')}</button> <button class="ghost small" data-kdel="${k.id}">${t('Ta bort')}</button></td></tr>`).join('')}</table>` : `<p class="muted small">${t('Inga nycklar än.')}</p>`}
    <form id="akform" style="margin-top:12px"><label for="akname">${t('Namn (var nyckeln används)')}</label><input id="akname" maxlength="60" required placeholder="${t('t.ex. Väggskärmen i köket')}">
      ${scopeBoxes(K, L)}
      <div class="row" style="margin-top:12px"><button class="primary">${t('Skapa nyckel')}</button></div></form>`;
  $('#akform', el).onsubmit = act(async (e) => {
    e.preventDefault();
    const f = $('#akform', el);
    const scopes = $$('[name=akscope]', f).filter(x => x.checked).map(x => x.value);
    const k = await api('/apikeys', { method: 'POST', body: { name: $('#akname', el).value, scopes, homeOnly: $('[name=akhome]', f).checked } });
    keyDialog(k);
    adminApiKeys().catch(() => {});
  });
  $$('[data-kedit]', el).forEach(b => b.onclick = act(() => editDialog(K.keys.find(x => x.id === +b.dataset.kedit), K, L)));
  $$('[data-kdel]', el).forEach(b => b.onclick = act(async () => {
    const k = K.keys.find(x => x.id === +b.dataset.kdel);
    if (!await confirmDialog(t('Ta bort nyckeln {name}? Det som använder den slutar fungera direkt.', { name: k?.name || '' }), { okLabel: t('Ta bort'), danger: true })) return;
    await api('/apikeys/' + b.dataset.kdel, { method: 'DELETE' });
    toast(t('Nyckeln är borttagen'));
    adminApiKeys().catch(() => {});
  }));
}
