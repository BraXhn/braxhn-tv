// Administration – Fjärråtkomst via BraXhn Relay: parning med reläets engångskod, status (ansluten, senaste fel,
// trafik) och bortkoppling. Servern: server/relay.js och server/routes/relay.js. Reläet: relay/server.js.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, act, api, esc, later, toast, t, locale } from '../core.js';
import { confirmDialog } from '../ui/dialog.js';

const fmtBytes = (b) => b >= 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.round(b / 1e3) + ' kB';
const when = (ms) => ms ? new Date(ms).toLocaleString(locale) : '';

export function relayHtml(R) {
  const badge = !R.paired ? '' : R.connected ? t('<span class="ok-badge">Ansluten</span>') : t('<span class="warn-badge">Frånkopplad</span>');
  const intro = `<p class="muted small">${t('Nå BraXhn TV utanför hemmet utan portöppning, VPN eller omvänd proxy: servern ansluter själv ut till ett relä som du kör på en server som nås från internet (t.ex. en VPS), och appar och webbläsare ansluter till reläets adress. Allt som kommer via reläet räknas som <b>utanför hemmet</b> – administration kräver fortfarande hemnätet. Se README → <i>Fjärråtkomst via BraXhn Relay</i>.')}</p>`;
  if (!R.paired) return `<h2>${t('Fjärråtkomst via relä')}</h2>${intro}
    <form id="rlform"><div class="row"><div style="flex:2;min-width:200px"><label for="rlurl">${t('Reläets adress')}</label><input id="rlurl" type="url" required placeholder="https://tv.example.com" autocomplete="off"></div>
      <div style="flex:1;min-width:200px"><label for="rlcode">${t('Parningskod')}</label><input id="rlcode" required placeholder="ABCD-EFGH-JKLM-NPQR" autocomplete="off" spellcheck="false" style="text-transform:uppercase"></div></div>
      <p class="muted small">${t('Koden visas i reläets logg när det startar (<code>docker logs braxhn-relay</code>) eller på reläets adminsida <code>/_relay/admin</code>. Den gäller i 15 minuter och bara en gång.')}</p>
      <div class="row"><button class="primary">${t('Para')}</button></div></form>`;
  const status = R.connected
    ? t('Ansluten sedan {v}.', { v: esc(when(R.since)) })
    : R.connecting ? t('Ansluter…') : R.nextRetryAt ? t('Försöker igen {v}.', { v: esc(new Date(R.nextRetryAt).toLocaleTimeString(locale)) }) : '';
  return `<h2>${t('Fjärråtkomst via relä {v}', { v: badge })}</h2>${intro}
    <p class="small">${t('Nås utifrån på <a href="{v}" target="_blank" rel="noopener">{v}</a>', { v: esc(R.publicUrl) })} · ${t('relä {v}', { v: `<code>${esc(R.url)}</code>` })}</p>
    ${R.insecure ? `<p class="err small">${t('Reläet nås med okrypterad http:// – trafiken (även inloggningar) kan avlyssnas. Använd https:// (Caddy i exemplet i README ordnar certifikatet).')}</p>` : ''}
    <p class="small" role="status">${status}</p>
    ${R.lastError && !R.connected ? `<p class="err small">${t('Senaste fel ({v}): {v2}', { v: esc(when(R.lastErrorAt)), v2: esc(R.lastError) })}</p>` : ''}
    <div class="tiles"><div class="tile"><b>${+R.requests}</b><span>${t('förfrågningar')}</span></div><div class="tile"><b>${+R.active}</b><span>${t('pågående')}</span></div>
      <div class="tile"><b>${esc(fmtBytes(R.bytesOut))}</b><span>${t('skickat')}</span></div><div class="tile"><b>${esc(fmtBytes(R.bytesIn))}</b><span>${t('mottaget')}</span></div>
      <div class="tile"><b>${+R.reconnects}</b><span>${t('återanslutningar')}</span></div></div>
    <div class="row" style="margin-top:12px"><button type="button" class="ghost" id="rlnow">${t('Anslut nu')}</button><button type="button" class="danger" id="rloff">${t('Koppla bort')}</button></div>`;
}

export async function adminRelay() {
  const el = $('#adm-relay'); if (!el) return;
  const R = await api('/relay');
  if (!el.isConnected) return;
  el.innerHTML = relayHtml(R);
  const again = () => adminRelay().catch(() => {});
  if ($('#rlform', el)) $('#rlform', el).onsubmit = act(async (e) => {
    e.preventDefault();
    const r = await api('/relay/pair', { method: 'POST', body: { url: $('#rlurl', el).value.trim(), code: $('#rlcode', el).value.trim() } });
    toast(t('Parad med reläet – nås på {v}', { v: r.publicUrl }));
    later(again, 1500);
  });
  if ($('#rlnow', el)) $('#rlnow', el).onclick = act(async () => { await api('/relay/reconnect', { method: 'POST' }); later(again, 1500); });
  if ($('#rloff', el)) $('#rloff', el).onclick = act(async () => {
    if (!await confirmDialog(t('Koppla bort från reläet? BraXhn TV går då inte att nå via reläets adress förrän du parar igen.'), { okLabel: t('Koppla bort'), danger: true })) return;
    const r = await api('/relay', { method: 'DELETE' });
    toast(r.relayForgot ? t('Bortkopplad') : t('Bortkopplad här – reläet kunde inte nås, ta bort servern på reläets adminsida'));
    again();
  });
  // Statusen uppdateras medan avsnittet visas
  if (R.paired) later(again, R.connected ? 15000 : 4000);
}

// Hemma via den publika adressen (server/localaddr.js): adresserna som apparna provar och webbens knapp i Mitt konto
// öppnar. Servern hittar den själv när en administratör öppnat servern direkt på IP-adressen hemma; i Docker med
// bridge ser servern inte sin egen adress, så den kan anges här.
export function adminLocal(S) {
  const el = $('#adm-local'); if (!el) return;
  const list = (S.localAddrs || []).map(a => `<code>${esc(a)}</code>`).join(', ');
  el.innerHTML = `<h2>${t('Hemadressen')}</h2>
    <p class="muted small">${t('Hemma men via den publika adressen? Apparna provar serverns adress på hemnätet och går direkt dit när den svarar (snabbare start, full kvalitet, ingen omväg via reläet). I webben finns knappen <i>Öppna hemadressen</i> under Mitt konto. Ingen räknas som hemma av det här – det avgörs som förut av vilket nät förfrågan kommer från.')}</p>
    <p class="small">${list ? t('Klienterna provar: {v}', { v: list }) : t('Servern känner inte till någon adress på hemnätet än. Öppna servern en gång på dess IP-adress hemma (t.ex. http://192.168.1.10:8420) eller ange den här.')}</p>
    <form id="lcform"><label for="lcurl">${t('Hemadress (valfri)')}</label><input id="lcurl" placeholder="http://192.168.1.10:8420" value="${esc(S.localUrl || '')}" autocomplete="off" spellcheck="false">
      <div class="row" style="margin-top:12px"><button class="ghost">${t('Spara')}</button></div></form>`;
  $('#lcform', el).onsubmit = act(async (e) => {
    e.preventDefault();
    await api('/settings', { method: 'PUT', body: { localUrl: $('#lcurl', el).value.trim() } });
    toast(t('Sparat'));
    adminLocal(await api('/settings'));
  });
}
