// Vy: Mitt konto – lösenord, uppspelningsval, tvåstegsverifiering, passkeys, profiler, Trakt, scrobbling, enheter, följda serier och nedladdning i appen
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, later, main, me, toast, views, toastErr } from '../core.js';
import { renderListenPrefs } from '../audio.js';
import { renderThemePrefs } from '../ui/thememusic.js';
import { passkeyOk, passkeyRegister } from '../passkeys.js';
import { route } from '../router.js';
import { screenDialog } from '../screentime.js';
import { confirmDialog, formDialog, openDialog, promptDialog } from '../ui/dialog.js';
import { loadingState } from '../ui/states.js';
import { calendarFeedPanel } from './calendar.js';
import { loadQr } from './quickconnect.js';
import { renderCinemaPrefs } from '../player/cinema.js';
import { renderPlaybackPrefs } from '../player/playprefs.js';
import { openHomeCustomizer } from './homecustom.js';
import { applySubStyle, audioFx, bindSubStyleFields, setAudioFx, subStyleFields, webAudioFx } from '../player/comfort.js';

export const EVENTS = { login_ok: 'Inloggning', login_fail: 'Misslyckad inloggning', login_locked: 'Spärrad inloggning', login_denied: 'Nekad inloggning',
  setup: 'Server konfigurerad', password_changed: 'Lösenord bytt', '2fa_enabled': '2FA aktiverad', '2fa_disabled': '2FA avstängd',
  '2fa_recovery_used': 'Reservkod använd', '2fa_recovery_regenerated': 'Nya reservkoder', session_revoked: 'Enhet utloggad', sessions_revoked_all: 'Alla enheter utloggade',
  user_created: 'Användare skapad', user_updated: 'Användare ändrad', user_deleted: 'Användare borttagen', settings_changed: 'Inställningar ändrade',
  admin_denied: 'Admin nekad (utifrån)', passkey_added: 'Passkey tillagd', passkey_removed: 'Passkey borttagen', passkey_add_fail: 'Passkey misslyckades', acme_obtain: 'Certifikat begärt', quickconnect_approved: 'Inloggning med kod godkänd', quickconnect_fail: 'Fel kod för TV-inloggning', quickconnect_denied: 'TV-inloggning nekad', library_added: 'Bibliotek tillagt', library_removed: 'Bibliotek borttaget' };
const device = (ua) => {
  ua = ua || '';
  if (/BraXhnTV-Android|Android.*Automotive/i.test(ua)) return 'Android-app';
  if (/CFNetwork|Darwin|BraXhnTV/i.test(ua)) return 'iPhone/iPad/Apple TV-app';
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Okänd';
  const o = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${o ? ' på ' + o : ''}`;
};
function showCodes(codes) {
  openDialog({
    title: 'Dina reservkoder',
    body: `<p class="muted">Spara dem säkert (t.ex. i en lösenordshanterare). Varje kod kan användas <b>en gång</b> om du tappar telefonen. De visas bara nu.</p>
      <pre class="codes">${codes.map(esc).join('\n')}</pre>`,
    actions: [{ label: 'Kopiera', onClick: () => { navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Kopierat')); return false; } },
      { label: 'Jag har sparat dem', kind: 'primary' }],
    onClose: (v) => { if (v !== 'route') route(); }
  });
}

views.account = async () => {
  const [tfa, sess, pks, TR] = await Promise.all([api('/me/2fa'), api('/me/sessions'), api('/me/passkeys'), api('/me/trakt')]);
  main.innerHTML = `
  <div class="panel"><h2>Mitt konto – ${esc(me.name)}</h2>
    <h3 style="font-size:15px;margin:0 0 4px">Byt lösenord</h3>
    <form id="pw"><label>Nuvarande lösenord</label><input type="password" id="c" autocomplete="current-password" required>
    <label>Nytt lösenord</label><input type="password" id="n1" autocomplete="new-password" minlength="10" required>
    <p class="muted small" style="margin:6px 0 0">Minst 10 tecken med tre olika teckentyper, eller en lösenfras på minst 14 tecken. Andra enheter loggas ut och lösenord för musikappar återkallas.</p>
    <div class="row" style="margin-top:12px"><button class="primary">Byt lösenord</button></div></form>
  </div>
  <div class="panel"><h2>Logga in på TV med kod</h2>
    <p class="muted small">Slipp skriva lösenord med fjärrkontrollen: välj <b>Logga in med kod</b> på TV:n eller i TV-appen och godkänn koden här. TV:n loggas in på den profil du använder nu.</p>
    <div class="row"><a class="btn primary" href="#/quickconnect">Godkänn inloggning på TV</a></div></div>
  <div class="panel"><h2>Årssammanfattning</h2>
    <p class="muted small">Det du har sett och lyssnat på mest under året: titlar, timmar, favoritgenre, musik och ljudböcker.</p>
    <div class="row"><a class="btn" href="#/wrapped/${new Date().getFullYear()}">Visa ${new Date().getFullYear()}</a></div></div>
  <div class="panel"><h2>Startsidan</h2>
    <p class="muted small">Välj vilka hyllor som visas, i vilken ordning, och om Utvalt ska synas överst. Gäller ditt konto på alla enheter.</p>
    <div class="row"><button type="button" class="ghost" id="homecust">Anpassa startsidan</button></div></div>
  <div class="panel"><h2>Min historik</h2>
    <p class="muted small">Allt du har tittat på, med datum – sökbart${me.kid ? '' : ', och du kan ta bort enskilda rader'}.</p>
    <div class="row"><a class="btn" href="#/history">Visa min historik</a>${me.kid ? '' : '<a class="btn" href="#/webhooks">Webhooks</a>'}</div></div>
  <div class="panel"><h2>Undertexter och ljud i spelaren</h2>
    <p class="muted small">Gäller filmer och serier i webbläsaren på den här enheten och sparas för ditt konto. Du kan också ändra det under ⚙ medan du tittar.</p>
    <div class="subprev" id="subprev"><div class="subtxt"><div><span>Så här ser undertexten ut.</span></div></div></div>
    <div class="row substyle">${subStyleFields('ast')}</div>
    <div class="row" style="margin-top:10px;gap:18px">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="anight"> Nattläge – jämnare ljud, svaga ljud lyfts</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="adialog"> Tydligare dialog – rösterna förstärks</label></div>
    ${webAudioFx ? '' : '<p class="muted small">I Safari görs nattläge och tydligare dialog av servern: ljudet omkodas, bilden kopieras.</p>'}</div>
  <div class="panel" id="pbprefs"></div>
  <div class="panel" id="cinemaprefs"></div>
  <div class="panel" id="themeprefs"></div>
  <div class="panel"><h2>Tvåstegsverifiering ${tfa.enabled ? '<span class="ok-badge">På</span>' : '<span class="warn-badge">Av</span>'}</h2>
    ${tfa.enabled ? `<p class="muted">Inloggning kräver en kod från din autentiseringsapp. Reservkoder kvar: <b>${tfa.recoveryLeft}</b>.</p>
      <div class="row"><button class="ghost" id="newrc">Skapa nya reservkoder</button><button class="danger" id="off">Stäng av</button></div>`
    : `<p class="muted">Skyddar kontot även om lösenordet läcker. Fungerar med t.ex. Google Authenticator, Microsoft Authenticator, 1Password eller Bitwarden.${tfa.required ? ' <b>Krävs för att logga in utanför hemmet.</b>' : ''}</p>
      <div id="tfasetup"><button class="primary" id="on">Aktivera tvåstegsverifiering</button></div>`}
  </div>
  ${!me.kid ? `<div class="panel"><h2>Passkeys</h2>
    <p class="muted small">Logga in med Face ID, Touch ID, Windows Hello eller en säkerhetsnyckel i stället för lösenord. En passkey räknas som tvåstegsverifiering och kan inte nätfiskas. Kräver HTTPS och att du når servern via ett domännamn (inte en IP-adress).</p>
    ${pks.length ? `<table>${pks.map(k => `<tr><td>${esc(k.name || 'Passkey')}</td><td class="muted small">Skapad ${fmtDate(k.created)} · senast använd ${fmtDate(k.last_used)}</td>
      <td class="r"><button class="danger small" data-pkdel="${esc(k.id)}">Ta bort</button></td></tr>`).join('')}</table>` : ''}
    <div class="row" style="margin-top:12px">${passkeyOk() ? '<button class="primary" id="pkadd">Lägg till passkey</button>' : '<span class="muted">Passkeys kräver HTTPS (eller localhost) i den här webbläsaren.</span>'}</div></div>` : ''}
  ${!me.kid ? `<div class="panel"><h2>Profiler i hushållet</h2>
    <p class="muted small">Profiler delar inloggning men har egen tittarhistorik och Min lista. Barnprofiler ser bara titlar upp till sin åldersgräns. Med PIN kan barnen inte byta till vuxnas profiler.</p>
    <div id="proflist">${loadingState({ kind: 'inline' })}</div>
    <form id="addprof" class="row" style="margin-top:12px;align-items:flex-end">
      <div style="flex:1;min-width:140px"><label>Namn</label><input id="pn" required maxlength="40"></div>
      <div><label>Åldersgräns</label><select id="pa"><option value="">Vuxen (ingen)</option><option value="0">Barntillåten</option><option value="7">7 år</option><option value="11">11 år</option><option value="13">13 år</option><option value="15">15 år</option></select></div>
      <div><label>PIN (valfri)</label><input id="pp" inputmode="numeric" maxlength="8" style="width:110px"></div>
      <button class="primary">Lägg till profil</button></form></div>` : ''}
  ${TR.enabled ? `<div class="panel"><h2>Trakt ${TR.connected ? '<span class="ok-badge">Kopplat</span>' : ''}</h2>
    ${TR.connected ? `<p class="muted small">Kopplat till <b>${esc(TR.username || '')}</b>. Det du ser markeras på Trakt och det du sett på andra ställen markeras här. Dina betyg (stjärnor) skickas till Trakt. Synkas var 6:e timme${TR.last_sync ? ', senast ' + fmtDate(TR.last_sync) : ''}.${TR.sync_error ? ' <span class="err">' + esc(TR.sync_error) + '</span>' : ''}</p>
      <div class="row"><button class="ghost" id="trsync">Synka nu</button><button class="danger" id="troff">Koppla från</button></div>`
    : `<p class="muted small">Synka vad du sett med Trakt.tv – åt båda hållen.</p><div id="trbox"><button class="primary" id="tron">Koppla Trakt</button></div>`}</div>` : ''}
  <div class="panel" id="scrobble" hidden></div>
  <div class="panel" id="subsonic" hidden></div>
  <div class="panel" id="listenprefs"></div>
  <div class="panel" id="calfeed"></div>
  <div class="panel"><h2>Inloggade enheter</h2>
    <table><tr><th>Enhet</th><th>IP</th><th>Senast aktiv</th><th></th></tr>
    ${sess.map(s => `<tr><td>${esc(device(s.ua))}${s.current ? ' <span class="ok-badge">Den här</span>' : ''}</td><td class="muted">${esc(s.ip || '–')}</td><td class="muted">${fmtDate(s.last_seen)}</td>
      <td class="r">${s.current ? '' : `<button class="ghost small" data-rev="${s.id}">Logga ut</button>`}</td></tr>`).join('')}</table>
    <div class="row" style="margin-top:12px"><button class="ghost" id="revall">Logga ut alla andra enheter</button></div>
  </div>`;
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/me/password', { method: 'POST', body: { current: $('#c').value, password: $('#n1').value } }); toast('Lösenordet är bytt – andra enheter är utloggade'); route(); }
    catch (er) { toastErr(er); }
  };
  $$('[data-rev]').forEach(b => b.onclick = act(async () => { await api('/me/sessions/' + b.dataset.rev, { method: 'DELETE' }); route(); }));
  renderListenPrefs($('#listenprefs')).catch(e => { if (!e?.aborted) $('#listenprefs').hidden = true; });
  renderScrobble($('#scrobble')).catch(e => { if (!e?.aborted && $('#scrobble')) $('#scrobble').hidden = true; });
  renderSubsonic($('#subsonic')).catch(e => { if (!e?.aborted && $('#subsonic')) $('#subsonic').hidden = true; });
  calendarFeedPanel($('#calfeed')).catch(() => {});
  renderPlaybackPrefs($('#pbprefs')).catch(e => { if (!e?.aborted && $('#pbprefs')) $('#pbprefs').hidden = true; });
  renderCinemaPrefs($('#cinemaprefs')).catch(e => { if (!e?.aborted && $('#cinemaprefs')) $('#cinemaprefs').hidden = true; });
  renderThemePrefs($('#themeprefs')).catch(e => { if (!e?.aborted && $('#themeprefs')) $('#themeprefs').hidden = true; });
  if ($('#tron')) $('#tron').onclick = async () => {
    try {
      const r = await api('/me/trakt/connect', { method: 'POST' });
      $('#trbox').innerHTML = `<p>Gå till <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a> och ange koden:</p><p style="font-size:32px;letter-spacing:6px;font-weight:800">${esc(r.userCode)}</p><p class="muted small" id="trst">Väntar…</p>`;
      const tick = async () => {
        const p = await api('/me/trakt/poll', { method: 'POST' }).catch(e => { if (e.aborted) throw e; return { status: 'pending' }; });
        if (p.status === 'connected') { toast('Trakt kopplat – synkar'); route(); }
        else if (p.status === 'pending') later(tick, (r.interval || 5) * 1000);
        else if ($('#trst')) $('#trst').textContent = p.status === 'denied' ? 'Nekades på Trakt.' : 'Koden gick ut – försök igen.';
      };
      later(tick, (r.interval || 5) * 1000);
    } catch (e) { toastErr(e); }
  };
  if ($('#trsync')) $('#trsync').onclick = async () => { try { const r = await api('/me/trakt/sync', { method: 'POST' }); toast(`Synkat: ${r.imported} markerade här, ${r.exported} skickade till Trakt${r.ratings ? `, ${r.ratings} betyg` : ''}`); route(); } catch (e) { toastErr(e); } };
  if ($('#troff')) $('#troff').onclick = act(async () => { if (await confirmDialog('Koppla från Trakt?', { okLabel: 'Koppla från', danger: true })) { await api('/me/trakt', { method: 'DELETE' }); route(); } });
  $$('[data-pkdel]').forEach(b => b.onclick = act(async () => { if (await confirmDialog('Ta bort passkeyn?', { okLabel: 'Ta bort', danger: true })) { await api('/me/passkeys/' + encodeURIComponent(b.dataset.pkdel), { method: 'DELETE' }); route(); } }));
  if ($('#pkadd')) $('#pkadd').onclick = async () => {
    // Med tvåstegsverifiering krävs även en kod (en passkey loggar in utan den)
    const f = await formDialog({ title: 'Lägg till passkey', okLabel: 'Fortsätt', fields: [
      { name: 'password', label: 'Ditt lösenord', type: 'password', required: true },
      ...(me?.totp ? [{ name: 'code', label: 'Kod från autentiseringsappen', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, required: true }] : []),
      { name: 'name', label: 'Namn på passkeyn', value: device(navigator.userAgent), hint: 'T.ex. "iPhone" eller "Jobbdator".', maxlength: 60 }] });
    if (!f) return;
    const { password } = f, code = me?.totp ? f.code : undefined, name = f.name.trim() || 'Passkey';
    try { await passkeyRegister(password, name, code); toast('Passkey tillagd'); route(); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Avbrutet' : e.name === 'InvalidStateError' ? 'Den här enheten har redan en passkey för kontot' : e.message); }
  };
  if ($('#proflist')) {
    const P2 = await api('/profiles');
    $('#proflist').innerHTML = `<table>${P2.profiles.map(p => `<tr><td>${esc(p.name)}${p.owner ? ' <span class="muted small">(huvudkonto)</span>' : ''}</td>
      <td class="muted small">${p.kid ? (p.maxAge === 0 ? 'Barntillåten' : 'max ' + p.maxAge + ' år') : 'Vuxen'}${p.hasPin ? ' · PIN' : ''}</td>
      <td class="r">${p.owner ? '' : `<button class="ghost small" data-pst="${p.id}">Skärmtid</button>`}<button class="ghost small" data-ppin="${p.id}">${p.hasPin ? 'Byt/ta bort PIN' : 'Sätt PIN'}</button>
      ${p.owner ? '' : `<button class="danger small" data-pdel="${p.id}">Ta bort</button>`}</td></tr>`).join('')}</table>`;
    $$('[data-ppin]').forEach(b => b.onclick = async () => {
      const pin = await promptDialog('Ny PIN (4–8 siffror)', { type: 'pin', hint: 'Lämna tomt för att ta bort PIN.', pattern: '[0-9]{4,8}', maxlength: 8, okLabel: 'Spara' }); if (pin === null) return;
      try { await api('/profiles/' + b.dataset.ppin, { method: 'PUT', body: { pin } }); toast('Sparat'); route(); } catch (e) { toastErr(e); }
    });
    $$('[data-pst]').forEach(b => b.onclick = act(() => screenDialog(P2.profiles.find(p => p.id === +b.dataset.pst))));
    $$('[data-pdel]').forEach(b => b.onclick = act(async () => { if (await confirmDialog('Ta bort profilen och dess tittarhistorik?', { okLabel: 'Ta bort', danger: true })) { await api('/profiles/' + b.dataset.pdel, { method: 'DELETE' }); route(); } }));
    $('#addprof').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/profiles', { method: 'POST', body: { name: $('#pn').value, maxAge: $('#pa').value, pin: $('#pp').value } }); toast('Profil skapad'); route(); }
      catch (er) { toastErr(er); }
    };
  }
  $('#revall').onclick = act(async () => { if (await confirmDialog('Logga ut alla andra enheter, inklusive appar?', { okLabel: 'Logga ut' })) { await api('/me/sessions/revoke-others', { method: 'POST' }); toast('Utloggade'); route(); } });
  if ($('#on')) $('#on').onclick = act(async () => {
    const r = await api('/me/2fa/setup', { method: 'POST' });
    $('#tfasetup').innerHTML = `<ol style="padding-left:18px;line-height:1.7">
      <li>Skanna QR-koden med din autentiseringsapp<div id="qr" style="background:#fff;display:inline-block;padding:10px;border-radius:8px;margin:8px 0"></div></li>
      <li>Eller ange nyckeln manuellt: <code style="user-select:all;word-break:break-all">${esc(r.secret.replace(/(.{4})/g, '$1 ').trim())}</code></li>
      <li>Skriv in den sexsiffriga koden som visas i appen:</li></ol>
      <div class="row"><input id="tc" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="max-width:160px;font-size:20px;letter-spacing:4px">
      <input id="tpw" type="password" autocomplete="current-password" placeholder="Ditt lösenord" style="max-width:220px"><button class="primary" id="tcok">Bekräfta</button></div>`;
    loadQr().then(q => { const el = $('#qr'); if (!el) return; const qr = q(0, 'M'); qr.addData(r.uri); qr.make(); el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0 }); })
      .catch(() => { const el = $('#qr'); if (el) el.outerHTML = '<span class="muted">(QR-koden kunde inte laddas – använd nyckeln nedan)</span>'; });
    $('#tc').focus();
    $('#tcok').onclick = async () => {
      try { const res = await api('/me/2fa/enable', { method: 'POST', body: { code: $('#tc').value, password: $('#tpw').value } }); showCodes(res.recoveryCodes); }
      catch (e) { toastErr(e); }
    };
  });
  if ($('#off')) $('#off').onclick = async () => {
    const f = await formDialog({ title: 'Stäng av tvåstegsverifiering', okLabel: 'Stäng av', danger: true, fields: [
      { name: 'password', label: 'Ditt lösenord', type: 'password', required: true },
      { name: 'code', label: 'Kod från autentiseringsappen (eller en reservkod)', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, required: true }] });
    if (!f) return;
    const { password, code } = f;
    try { await api('/me/2fa/disable', { method: 'POST', body: { password, code } }); toast('Tvåstegsverifiering avstängd'); route(); } catch (e) { toastErr(e); }
  };
  if ($('#newrc')) $('#newrc').onclick = async () => {
    const password = await promptDialog('Ditt lösenord', { title: 'Skapa nya reservkoder', type: 'password', required: true, okLabel: 'Skapa' }); if (!password) return;
    try { const r = await api('/me/2fa/recovery', { method: 'POST', body: { password } }); showCodes(r.recoveryCodes); } catch (e) { toastErr(e); }
  };
  $('#homecust').onclick = () => openHomeCustomizer();
  const prev = $('#subprev');
  applySubStyle(prev); bindSubStyleFields(main, () => applySubStyle(prev));
  const fx = audioFx(); $('#anight').checked = fx.night; $('#adialog').checked = fx.dialog;
  $('#anight').onchange = $('#adialog').onchange = () => setAudioFx({ night: $('#anight').checked, dialog: $('#adialog').checked });
  await accountExtras();
};

// ---------- scrobbling av musik (ListenBrainz och Last.fm) ----------
async function renderScrobble(el, data) {
  const S = data || await api('/me/scrobble');
  if (!el.isConnected || !S.allowed) return;
  const LB = S.listenbrainz, LF = S.lastfm;
  const status = (x) => `${x.error ? ` <span class="err">${esc(x.error)}</span>` : ''}${x.queued ? ` <span class="muted">${x.queued} ${x.queued === 1 ? 'lyssning väntar' : 'lyssningar väntar'} på att skickas.</span>` : ''}`;
  const badge = (x) => x.connected ? (x.error ? ' <span class="warn-badge">Fel</span>' : ' <span class="ok-badge">Kopplat</span>') : '';
  el.hidden = false;
  el.innerHTML = `<h2>Scrobbling</h2>
    <p class="muted small">Skicka det du lyssnar på i musiken till ListenBrainz eller Last.fm – från webben och apparna. En låt räknas när du lyssnat på halva den (eller 4 minuter); låtar under 30 sekunder räknas inte. Kopplingen gäller bara den här profilen.</p>
    <h3 style="font-size:15px;margin:12px 0 4px">ListenBrainz${badge(LB)}</h3>
    ${LB.connected ? `<p class="muted small">Kopplat som <b>${esc(LB.username || '')}</b>${LB.lastSent ? ', senast skickat ' + fmtDate(LB.lastSent) : ''}.${status(LB)}</p>
      <div class="row"><button class="danger" id="lboff">Koppla från</button></div>`
    : `<p class="muted small">Kopiera din användartoken från <a href="https://listenbrainz.org/settings/" target="_blank" rel="noopener">listenbrainz.org/settings</a>.</p>
      <form id="lbform" class="row" style="align-items:flex-end"><div style="flex:1;min-width:200px"><label for="lbtok">Användartoken</label><input id="lbtok" type="password" autocomplete="off" required maxlength="200"></div>
      <button class="primary">Koppla ListenBrainz</button></form>`}
    <h3 style="font-size:15px;margin:18px 0 4px">Last.fm${badge(LF)}</h3>
    ${!LF.available ? '<p class="muted small">Kräver API-nyckel (se README) – administratören anger den under Administration → Sonarr, Radarr och Trakt.</p>'
    : LF.connected ? `<p class="muted small">Kopplat som <b>${esc(LF.username || '')}</b>${LF.lastSent ? ', senast skickat ' + fmtDate(LF.lastSent) : ''}.${status(LF)}</p>
      <div class="row"><button class="danger" id="lfoff">Koppla från</button></div>`
    : `<div id="lfbox"><p class="muted small">Du loggar in på last.fm och godkänner BraXhn TV.</p><div class="row"><button class="primary" id="lfon">Koppla Last.fm</button></div></div>`}`;
  const again = (d) => renderScrobble(el, d).catch(() => {});
  const off = (svc, name) => act(async () => {
    if (await confirmDialog(`Koppla från ${name}?`, { okLabel: 'Koppla från', danger: true })) again(await api('/me/scrobble/' + svc, { method: 'DELETE' }));
  });
  if ($('#lboff', el)) $('#lboff', el).onclick = off('listenbrainz', 'ListenBrainz');
  if ($('#lfoff', el)) $('#lfoff', el).onclick = off('lastfm', 'Last.fm');
  if ($('#lbform', el)) $('#lbform', el).onsubmit = async (e) => {
    e.preventDefault();
    try { const d = await api('/me/scrobble/listenbrainz', { method: 'PUT', body: { token: $('#lbtok', el).value } }); toast('ListenBrainz kopplat'); again(d); } catch (er) { toastErr(er); }
  };
  if ($('#lfon', el)) $('#lfon', el).onclick = act(async () => {
    const r = await api('/me/scrobble/lastfm/connect', { method: 'POST' });
    $('#lfbox', el).innerHTML = `<p><a class="btn primary" href="${esc(r.url)}" target="_blank" rel="noopener">Öppna Last.fm och godkänn</a></p><p class="muted small" id="lfst" role="status">Väntar på att du godkänner på last.fm…</p>`;
    const tick = async () => {
      const p = await api('/me/scrobble/lastfm/poll', { method: 'POST' }).catch(e => { if (e.aborted) throw e; return { status: 'pending' }; });
      if (!el.isConnected) return;
      if (p.status === 'connected') { toast('Last.fm kopplat'); again(); }
      else if (p.status === 'pending') later(tick, 3000);
      else if ($('#lfst', el)) $('#lfst', el).textContent = 'Inloggningen gick ut – försök igen.';
    };
    later(tick, 3000);
  });
}

// ---------- musikappar (Subsonic): eget app-lösenord ----------
Object.assign(EVENTS, { subsonic_password_created: 'Lösenord för musikappar skapat', subsonic_password_revoked: 'Lösenord för musikappar återkallat',
  subsonic_login_fail: 'Fel lösenord från musikapp', subsonic_denied: 'Musikapp nekad' });
async function renderSubsonic(el, data) {
  const S = data || await api('/me/subsonic');
  if (!el.isConnected || !S.enabled) return;
  const fmt = (t) => t ? fmtDate(t) : 'aldrig';
  const server = `${location.origin}`;
  el.hidden = false;
  el.innerHTML = `<h2>Musikappar ${S.active ? '<span class="ok-badge">På</span>' : ''}</h2>
    <p class="muted small">Lyssna på musiken i färdiga musikappar som Symfonium (Android, Android Auto), Amperfy och play:Sub (iPhone och CarPlay), Feishin och Supersonic (dator) eller Sonos via Music Assistant. Apparna använder ett eget lösenord som bara ger tillgång till musiken – inte filmer, serier eller ditt konto.</p>
    <table><tr><td>Server</td><td><code style="user-select:all">${esc(server)}</code></td></tr>
      <tr><td>Användarnamn</td><td><code style="user-select:all">${esc(S.username)}</code></td></tr></table>
    ${S.screenTimeAudio ? '<p class="small"><span class="warn-badge">Obs</span> Profilen har skärmtid för ljud. Musikappar kan inte följa skärmtiden och nekas därför – lyssna i BraXhn TV i stället.</p>' : ''}
    ${S.active ? `<p class="muted small" style="margin-top:8px">Lösenordet skapades ${fmt(S.created)}${S.createdAtHome ? ' hemifrån' : ''} · senast använt ${fmt(S.lastUsed)}${S.client ? ' av ' + esc(S.client) : ''}. Det visas bara när det skapas – skapa ett nytt om du behöver det igen (det gamla slutar då fungera i alla musikappar).</p>` : ''}
    <div class="row" style="margin-top:12px"><button class="primary" id="subnew">${S.active ? 'Skapa nytt lösenord' : 'Skapa lösenord för musikappar'}</button>${S.active ? '<button class="danger" id="suboff">Återkalla</button>' : ''}</div>`;
  const again = (d) => renderSubsonic(el, d).catch(() => {});
  $('#subnew', el).onclick = async () => {
    const remote = !S.atHome;
    const f = await formDialog({ title: S.active ? 'Nytt lösenord för musikappar' : 'Lösenord för musikappar', okLabel: 'Skapa', fields: [
      { name: 'password', label: S.profile ? 'Huvudkontots lösenord' : 'Ditt lösenord', type: 'password', required: true },
      ...(remote ? [{ name: 'code', label: 'Kod från autentiseringsappen', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, required: true,
        hint: 'Utanför hemmet krävs tvåstegsverifiering för att skapa lösenordet.' }] : [])] });
    if (!f) return;
    let r;
    try { r = await api('/me/subsonic', { method: 'POST', body: { password: f.password, code: f.code } }); } catch (e) { toastErr(e); return; }
    openDialog({
      title: 'Ditt lösenord för musikappar',
      body: `<p class="muted small">Lägg till en Subsonic-server i musikappen (i Symfonium: Lägg till mediaserver → Subsonic) med uppgifterna nedan. Lösenordet visas bara nu – spara det i appen eller i en lösenordshanterare.</p>
        <label>Serveradress</label><input readonly value="${esc(server)}" class="subcopy" style="font-family:ui-monospace,monospace">
        <label>Användarnamn</label><input readonly value="${esc(r.username)}" class="subcopy" style="font-family:ui-monospace,monospace">
        <label>Lösenord</label><input readonly value="${esc(r.password)}" class="subcopy" id="subpw" style="font-family:ui-monospace,monospace">
        <p class="muted small" style="margin-top:8px">Vissa appar vill ha adressen med <code>/rest</code> på slutet. Utanför hemmet fungerar appen bara om ditt konto får användas utifrån${r.has2fa ? '' : ' (och om administratören kräver tvåstegsverifiering utifrån måste du aktivera den)'}.</p>`,
      actions: [{ label: 'Kopiera lösenordet', onClick: () => { navigator.clipboard?.writeText(r.password).then(() => toast('Kopierat'), () => toastErr(new Error('Kunde inte kopiera – markera lösenordet och kopiera det själv'))); return false; } },
        { label: 'Klar', kind: 'primary' }],
      onClose: () => again()
    });
    for (const i of $$('.subcopy')) i.onfocus = () => i.select();
  };
  if ($('#suboff', el)) $('#suboff', el).onclick = act(async () => {
    if (!await confirmDialog('Återkalla lösenordet för musikappar? Alla musikappar som använder det slutar fungera.', { okLabel: 'Återkalla', danger: true })) return;
    again(await api('/me/subsonic', { method: 'DELETE' })); toast('Lösenordet för musikappar är återkallat');
  });
}

// ---------- skärmtid, följda serier och automatisk nedladdning ----------
Object.assign(EVENTS, { screentime_changed: 'Skärmtid ändrad', screentime_extra: 'Extra skärmtid', history_imported: 'Tittarhistorik importerad' });
/** Paneler under Mitt konto: följda serier, personliga notiser och automatisk nedladdning i appen */
async function accountExtras() {
  let N, S, F;
  try { [N, S, F] = await Promise.all([api('/me/notify'), api('/me/offline-sync'), api('/follows')]); }
  catch (e) { if (e.aborted) throw e; return; }
  main.insertAdjacentHTML('beforeend', `
  <div class="panel"><h2>Serier jag följer</h2>
    <p class="muted small">Nya avsnitt av serier du följer visas under <b>Nytt för dig</b> på startsidan. Du följer en serie med knappen Följ på serien, och automatiskt när du lägger den i Min lista eller ser klart ett avsnitt. Slutar du följa en serie följs den inte automatiskt igen.</p>
    ${F.length ? `<table>${F.map(f => `<tr><td><a href="#/item/${f.id}">${esc(f.title)}</a></td><td class="muted small">${f.sync == null ? '' : f.sync === 0 ? 'Laddas inte ner i appen' : `Håll ${f.sync} nedladdade i appen`}</td>
      <td class="r"><button class="ghost small" data-unf="${f.id}">Sluta följa</button></td></tr>`).join('')}</table>` : '<p class="muted">Du följer inga serier ännu.</p>'}</div>
  ${N.allowed ? `<div class="panel"><h2>Notiser om nya avsnitt</h2>
    <p class="muted small">Få en notis i mobilen när nya avsnitt av serier du följer kommer – flera avsnitt samlas i en notis. Använd t.ex. appen <b>ntfy</b> (adress som https://ntfy.sh/ett-hemligt-ämne) eller en egen webhook som tar emot JSON. Adressen måste gå att nå via internet; adresser i hemnätet tillåts inte.</p>
    <div class="row" style="align-items:flex-end"><div><label>Typ</label><select id="nk"><option value="none">Av</option><option value="ntfy">ntfy</option><option value="webhook">Webhook (JSON)</option></select></div>
      <div style="flex:1;min-width:220px"><label>Adress</label><input id="nu" value="${esc(N.url)}" placeholder="https://ntfy.sh/mitt-hemliga-amne" maxlength="500"></div>
      <div><label>Token (valfri)</label><input id="nt" type="password" autocomplete="off" placeholder="${N.hasToken ? '(sparad)' : ''}"></div></div>
    <div class="row" style="margin-top:12px"><button class="primary" id="nsave">Spara</button><button class="ghost" id="ntest" ${N.kind === 'none' ? 'disabled' : ''}>Skicka testnotis</button></div></div>` : ''}
  <div class="panel"><h2>Automatisk nedladdning i appen</h2>
    <p class="muted small">iPhone/iPad- och Android-appen håller de närmaste osedda avsnitten nedladdade, så att de finns när du saknar nät. Appen synkar när den öppnas och tar bort avsnitt som den själv laddat ner när du har sett dem. Per serie kan du ändra antalet på seriens sida.</p>
    <div class="row" style="align-items:flex-end">
      <div><label>Avsnitt per serie</label><select id="sc"><option value="0">Av</option>${[1, 2, 3, 5, 10].map(n => `<option value="${n}">${n}</option>`).join('')}</select></div>
      <div><label>Vilka serier</label><select id="ss"><option value="follows">Serier jag följer</option><option value="continue">Fortsätt titta (senaste 30 dagarna)</option></select></div>
      <div><label>Kvalitet</label><select id="sq"><option value="480">480p (minst)</option><option value="720">720p</option><option value="1080">1080p</option><option value="orig">Original</option></select></div>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="sw"> Bara på Wi-Fi</label></div>
    <div class="row" style="margin-top:12px"><button class="primary" id="ssave">Spara</button></div></div>`);
  $$('[data-unf]').forEach(b => b.onclick = act(async () => { await api(`/items/${b.dataset.unf}/follow`, { method: 'POST', body: { follow: false } }); route(); }));
  if ($('#nk')) {
    $('#nk').value = N.kind;
    $('#nsave').onclick = act(async () => {
      const t = $('#nt').value;
      const r = await api('/me/notify', { method: 'PUT', body: { kind: $('#nk').value, url: $('#nu').value, ...(t ? { token: t } : {}) } });
      $('#ntest').disabled = r.kind === 'none'; $('#nt').value = ''; $('#nt').placeholder = r.hasToken ? '(sparad)' : ''; toast('Sparat');
    });
    $('#ntest').onclick = act(async () => { await api('/me/notify/test', { method: 'POST' }); toast('Testnotisen skickades'); });
  }
  $('#sc').value = String(S.count); $('#ss').value = S.scope; $('#sq').value = S.quality; $('#sw').checked = S.wifiOnly;
  $('#ssave').onclick = act(async () => {
    await api('/me/offline-sync', { method: 'PUT', body: { count: +$('#sc').value, scope: $('#ss').value, quality: $('#sq').value, wifiOnly: $('#sw').checked } });
    toast('Sparat – appen synkar nästa gång den öppnas');
  });
}
