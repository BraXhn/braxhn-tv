// Administration – API-nycklar: dela ut skrivskyddad åtkomst till Nu spelas och biblioteket åt andra system
// (väggskärm, Home Assistant, Homepage …). Nyckeln visas en gång. Servern: server/apikeys.js, server/routes/apikeys.js.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, toast, t } from '../core.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';

const SCOPE_LABEL = () => ({ nowplaying: t('Vad som spelas just nu (titel, vem, enhet och hur långt)'), library: t('Biblioteket: antal titlar och nyligen tillagt') });

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

export async function adminApiKeys() {
  const el = $('#adm-apikeys'); if (!el) return;
  const K = await api('/apikeys');
  if (!el.isConnected) return;
  const L = SCOPE_LABEL();
  el.innerHTML = `<h2>${t('API-nycklar')}</h2>
    <p class="muted small">${t('Låt andra system läsa vad som spelas eller vad som finns i biblioteket, t.ex. en väggskärm eller Home Assistant. Nycklarna kan bara läsa – aldrig strömma eller ändra något. Se <i>docs/api.md</i> för adresserna.')}</p>
    ${K.keys.length ? `<table>${K.keys.map(k => `<tr><td><b>${esc(k.name)}</b> <code class="muted small">${esc(k.prefix)}…</code>
      <div class="muted small">${k.scopes.map(s => esc(L[s] || s)).join(' · ')}${k.homeOnly ? ' · ' + t('bara hemnätet') : ' · ' + t('även utanför hemmet')}</div>
      <div class="muted small">${k.lastUsed ? t('Senast använd {v} från {ip}', { v: fmtDate(k.lastUsed), ip: esc(k.lastIp || '–') }) : t('Inte använd än')}</div></td>
      <td class="r"><button class="ghost small" data-kdel="${k.id}">${t('Ta bort')}</button></td></tr>`).join('')}</table>` : `<p class="muted small">${t('Inga nycklar än.')}</p>`}
    <form id="akform" style="margin-top:12px"><label for="akname">${t('Namn (var nyckeln används)')}</label><input id="akname" maxlength="60" required placeholder="${t('t.ex. Väggskärmen i köket')}">
      ${Object.keys(K.scopes).map(s => `<label class="switch"><input type="checkbox" name="akscope" value="${esc(s)}" ${s === 'nowplaying' ? 'checked' : ''}> ${esc(L[s] || K.scopes[s])}</label>`).join('')}
      <label class="switch"><input type="checkbox" id="akhome" checked> ${t('Bara från hemnätet')} <span class="muted">${t('(rekommenderas – stäng av bara om systemet finns utanför hemmet)')}</span></label>
      <div class="row" style="margin-top:12px"><button class="primary">${t('Skapa nyckel')}</button></div></form>`;
  $('#akform', el).onsubmit = act(async (e) => {
    e.preventDefault();
    const scopes = $$('[name=akscope]', el).filter(x => x.checked).map(x => x.value);
    const k = await api('/apikeys', { method: 'POST', body: { name: $('#akname', el).value, scopes, homeOnly: $('#akhome', el).checked } });
    keyDialog(k);
    adminApiKeys().catch(() => {});
  });
  $$('[data-kdel]', el).forEach(b => b.onclick = act(async () => {
    const k = K.keys.find(x => x.id === +b.dataset.kdel);
    if (!await confirmDialog(t('Ta bort nyckeln {name}? Det som använder den slutar fungera direkt.', { name: k?.name || '' }), { okLabel: t('Ta bort'), danger: true })) return;
    await api('/apikeys/' + b.dataset.kdel, { method: 'DELETE' });
    toast(t('Nyckeln är borttagen'));
    adminApiKeys().catch(() => {});
  }));
}
