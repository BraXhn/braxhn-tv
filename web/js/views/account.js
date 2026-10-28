// Vy: Mitt konto – lösenord, uppspelningsval, tvåstegsverifiering, passkeys, profiler, Trakt, scrobbling, enheter, följda serier och nedladdning i appen
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, later, main, me, toast, views, toastErr, t, lang, setLang } from '../core.js';
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
import { familyProfileDialog, renderFamilyPrefs } from '../familyprefs.js';
import { applySubStyle, audioFx, bindSubStyleFields, setAudioFx, subStyleFields, webAudioFx } from '../player/comfort.js';

export const EVENTS = { login_ok: t('Inloggning'), login_fail: t('Misslyckad inloggning'), login_locked: t('Spärrad inloggning'), login_denied: t('Nekad inloggning'),
  setup: t('Server konfigurerad'), password_changed: t('Lösenord bytt'), '2fa_enabled': t('2FA aktiverad'), '2fa_disabled': t('2FA avstängd'),
  '2fa_recovery_used': t('Reservkod använd'), '2fa_recovery_regenerated': t('Nya reservkoder'), session_revoked: t('Enhet utloggad'), sessions_revoked_all: t('Alla enheter utloggade'),
  user_created: t('Användare skapad'), user_updated: t('Användare ändrad'), user_deleted: t('Användare borttagen'), settings_changed: t('Inställningar ändrade'),
  admin_denied: t('Admin nekad (utifrån)'), passkey_added: t('Passkey tillagd'), passkey_removed: t('Passkey borttagen'), passkey_add_fail: t('Passkey misslyckades'), acme_obtain: t('Certifikat begärt'), quickconnect_approved: t('Inloggning med kod godkänd'), quickconnect_fail: t('Fel kod för TV-inloggning'), quickconnect_denied: t('TV-inloggning nekad'), library_added: t('Bibliotek tillagt'), library_removed: t('Bibliotek borttaget') };
const device = (ua) => {
  ua = ua || '';
  if (/BraXhnTV-Android|Android.*Automotive/i.test(ua)) return 'Android-app';
  if (/CFNetwork|Darwin|BraXhnTV/i.test(ua)) return 'iPhone/iPad/Apple TV-app';
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : t('Okänd');
  const o = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${o ? t(' på ') + o : ''}`;
};
function showCodes(codes) {
  openDialog({
    title: t('Dina reservkoder'),
    body: `<p class="muted">${t('Spara dem säkert (t.ex. i en lösenordshanterare). Varje kod kan användas <b>en gång</b> om du tappar telefonen. De visas bara nu.')}</p>
      <pre class="codes">${codes.map(esc).join('\n')}</pre>`,
    actions: [{ label: t('Kopiera'), onClick: () => { navigator.clipboard?.writeText(codes.join('\n')).then(() => toast(t('Kopierat'))); return false; } },
      { label: t('Jag har sparat dem'), kind: 'primary' }],
    onClose: (v) => { if (v !== 'route') route(); }
  });
}

// Visningsval per enhet (web/start.js lägger på dem vid start): textstorlek i procent av webbläsarens egen,
// minska rörelse och hög kontrast (klasser på <html>, se style.css)
const A11Y_KEY = 'braxhn-tv.a11y';
function a11yPrefs() { try { return JSON.parse(localStorage.getItem(A11Y_KEY) || 'null') || {}; } catch { return {}; } }
function applyA11y(a) {
  const r = document.documentElement, t = Math.max(100, Math.min(200, +a.text || 100));
  r.style.fontSize = t === 100 ? '' : t + '%';
  r.classList.toggle('reduce-motion', a.motion === 'reduce');
  r.classList.toggle('more-contrast', a.contrast === 'more');
  r.classList.toggle('bigtext', t >= 130); // menyraden: sidflikarna får inte plats (finns i Mer/användarmenyn)
}
function bindA11yPrefs() {
  const a = a11yPrefs();
  $('#a11ytext').value = String(+a.text || 100); $('#a11ymotion').value = a.motion || ''; $('#a11ycontrast').value = a.contrast || '';
  const save = () => {
    const n = { text: +$('#a11ytext').value, motion: $('#a11ymotion').value, contrast: $('#a11ycontrast').value };
    try { localStorage.setItem(A11Y_KEY, JSON.stringify(n)); } catch {}
    applyA11y(n);
  };
  for (const id of ['#a11ytext', '#a11ymotion', '#a11ycontrast']) $(id).onchange = save;
}

views.account = async () => {
  const [tfa, sess, pks, TR] = await Promise.all([api('/me/2fa'), api('/me/sessions'), api('/me/passkeys'), api('/me/trakt')]);
  main.innerHTML = `
  <div class="panel"><h2>${t('Mitt konto – {name}', { name: esc(me.name) })}</h2>
    <h3 style="font-size:.9375rem;margin:0 0 4px">${t('Byt lösenord')}</h3>
    <form id="pw"><label for="c">${t('Nuvarande lösenord')}</label><input type="password" id="c" autocomplete="current-password" required>
    <label for="n1">${t('Nytt lösenord')}</label><input type="password" id="n1" autocomplete="new-password" minlength="10" required>
    <p class="muted small" style="margin:6px 0 0">${t('Minst 10 tecken med tre olika teckentyper, eller en lösenfras på minst 14 tecken. Andra enheter loggas ut och lösenord för musikappar återkallas.')}</p>
    <div class="row" style="margin-top:12px"><button class="primary">${t('Byt lösenord')}</button></div></form>
  </div>
  <div class="panel"><h2>${t('Logga in på TV med kod')}</h2>
    <p class="muted small">${t('Slipp skriva lösenord med fjärrkontrollen: välj <b>Logga in med kod</b> på TV:n eller i TV-appen och godkänn koden här. TV:n loggas in på den profil du använder nu.')}</p>
    <div class="row"><a class="btn primary" href="#/quickconnect">${t('Godkänn inloggning på TV')}</a></div></div>
  <div class="panel"><h2>${t('Årssammanfattning')}</h2>
    <p class="muted small">${t('Det du har sett och lyssnat på mest under året: titlar, timmar, favoritgenre, musik och ljudböcker.')}</p>
    <div class="row">${t('<a class="btn" href="#/wrapped/{v}">Visa {v}</a>', { v: new Date().getFullYear() })}</div></div>
  <div class="panel"><h2>${t('Startsidan')}</h2>
    <p class="muted small">${t('Välj vilka hyllor som visas, i vilken ordning, och om Utvalt ska synas överst. Gäller ditt konto på alla enheter.')}</p>
    <div class="row"><button type="button" class="ghost" id="homecust">${t('Anpassa startsidan')}</button></div></div>
  <div class="panel"><h2>${t('Min historik')}</h2>
    <p class="muted small">${t('Allt du har tittat på, med datum – sökbart{v}.', { v: me.kid ? '' : t(', och du kan ta bort enskilda rader') })}</p>
    <div class="row"><a class="btn" href="#/history">${t('Visa min historik')}</a>${me.kid ? '' : '<a class="btn" href="#/webhooks">Webhooks</a>'}</div></div>
  <div class="panel" id="langprefs"><h2>${t('Språk')} <span class="muted small" lang="${lang === 'en' ? 'sv' : 'en'}">${lang === 'en' ? 'Språk' : 'Language'}</span></h2>
    <p class="muted small">${t('Språket i BraXhn TV för din profil – på alla enheter där du loggar in i webbläsaren. Titlar och beskrivningar från biblioteket påverkas inte (det väljs under Administration).')}</p>
    <div class="row"><label for="uilang" class="sr-only">${t('Språk')}</label><select id="uilang"><option value="sv" lang="sv"${lang === 'sv' ? ' selected' : ''}>Svenska</option><option value="en" lang="en"${lang === 'en' ? ' selected' : ''}>English</option></select></div></div>
  <div class="panel" id="a11yprefs"><h2>${t('Tillgänglighet')}</h2>
    <p class="muted small">${t('Gäller den här enheten. Webbläsarens och systemets egna val (zoom, minska rörelse, hög kontrast) gäller också.')}</p>
    <div class="row ppgrid">
      <div><label for="a11ytext">${t('Textstorlek')}</label><select id="a11ytext">${[100, 115, 130, 150, 175, 200].map(n => `<option value="${n}">${n} %${n === 100 ? ` (${t('standard')})` : ''}</option>`).join('')}</select></div>
      <div><label for="a11ymotion">${t('Rörelse')}</label><select id="a11ymotion"><option value="">${t('Som i systemet')}</option><option value="reduce">${t('Minska rörelse')}</option></select></div>
      <div><label for="a11ycontrast">${t('Kontrast')}</label><select id="a11ycontrast"><option value="">${t('Som i systemet')}</option><option value="more">${t('Hög kontrast')}</option></select></div></div>
    <p class="muted small">${t('Tryck <kbd>?</kbd> för alla kortkommandon. Syntolkning väljer du under Uppspelning nedan.')}</p></div>
  <div class="panel"><h2>${t('Undertexter och ljud i spelaren')}</h2>
    <p class="muted small">${t('Gäller filmer och serier i webbläsaren på den här enheten och sparas för ditt konto. Du kan också ändra det under ⚙ medan du tittar.')}</p>
    <div class="subprev" id="subprev"><div class="subtxt"><div><span>${t('Så här ser undertexten ut.')}</span></div></div></div>
    <div class="row substyle">${subStyleFields('ast')}</div>
    <div class="row" style="margin-top:10px;gap:18px">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="anight"> ${t('Nattläge – jämnare ljud, svaga ljud lyfts')}</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="adialog"> ${t('Tydligare dialog – rösterna förstärks')}</label></div>
    ${webAudioFx ? '' : t('<p class="muted small">I Safari görs nattläge och tydligare dialog av servern: ljudet omkodas, bilden kopieras.</p>')}</div>
  <div class="panel" id="pbprefs"></div>
  <div class="panel" id="cinemaprefs"></div>
  <div class="panel" id="familyprefs"></div>
  <div class="panel" id="themeprefs"></div>
  <div class="panel"><h2>${t('Tvåstegsverifiering {v}', { v: tfa.enabled ? t('<span class="ok-badge">På</span>') : t('<span class="warn-badge">Av</span>') })}</h2>
    ${tfa.enabled ? `<p class="muted">${t('Inloggning kräver en kod från din autentiseringsapp. Reservkoder kvar: <b>{recoveryLeft}</b>.', { recoveryLeft: tfa.recoveryLeft })}</p>
      <div class="row"><button class="ghost" id="newrc">${t('Skapa nya reservkoder')}</button><button class="danger" id="off">${t('Stäng av')}</button></div>`
    : `<p class="muted">${t('Skyddar kontot även om lösenordet läcker. Fungerar med t.ex. Google Authenticator, Microsoft Authenticator, 1Password eller Bitwarden.{v}', { v: tfa.required ? t(' <b>Krävs för att logga in utanför hemmet.</b>') : '' })}</p>
      <div id="tfasetup"><button class="primary" id="on">${t('Aktivera tvåstegsverifiering')}</button></div>`}
  </div>
  ${!me.kid ? `<div class="panel"><h2>Passkeys</h2>
    <p class="muted small">${t('Logga in med Face ID, Touch ID, Windows Hello eller en säkerhetsnyckel i stället för lösenord. En passkey räknas som tvåstegsverifiering och kan inte nätfiskas. Kräver HTTPS och att du når servern via ett domännamn (inte en IP-adress).')}</p>
    ${pks.length ? `<table>${pks.map(k => `<tr><td>${esc(k.name || 'Passkey')}</td><td class="muted small">${t('Skapad {created} · senast använd {last_used}', { created: fmtDate(k.created), last_used: fmtDate(k.last_used) })}</td>
      <td class="r"><button class="danger small" data-pkdel="${esc(k.id)}">${t('Ta bort')}</button></td></tr>`).join('')}</table>` : ''}
    <div class="row" style="margin-top:12px">${passkeyOk() ? t('<button class="primary" id="pkadd">Lägg till passkey</button>') : t('<span class="muted">Passkeys kräver HTTPS (eller localhost) i den här webbläsaren.</span>')}</div></div>` : ''}
  ${!me.kid ? `<div class="panel"><h2>${t('Profiler i hushållet')}</h2>
    <p class="muted small">${t('Profiler delar inloggning men har egen tittarhistorik och Min lista. Barnprofiler ser bara titlar upp till sin åldersgräns. Med PIN kan barnen inte byta till vuxnas profiler.')}</p>
    <div id="proflist">${loadingState({ kind: 'inline' })}</div>
    <form id="addprof" class="row" style="margin-top:12px;align-items:flex-end">
      <div style="flex:1;min-width:140px"><label for="pn">${t('Namn')}</label><input id="pn" required maxlength="40"></div>
      <div><label for="pa">${t('Åldersgräns')}</label><select id="pa"><option value="">${t('Vuxen (ingen)')}</option><option value="0">${t('Barntillåten')}</option><option value="7">${t('7 år')}</option><option value="11">${t('11 år')}</option><option value="13">${t('13 år')}</option><option value="15">${t('15 år')}</option></select></div>
      <div><label for="pp">${t('PIN (valfri)')}</label><input id="pp" inputmode="numeric" maxlength="8" style="width:110px"></div>
      <button class="primary">${t('Lägg till profil')}</button></form></div>` : ''}
  ${TR.enabled ? `<div class="panel"><h2>Trakt ${TR.connected ? t('<span class="ok-badge">Kopplat</span>') : ''}</h2>
    ${TR.connected ? `<p class="muted small">${t('Kopplat till <b>{v}</b>. Det du ser markeras på Trakt och det du sett på andra ställen markeras här. Dina betyg (stjärnor) skickas till Trakt. Synkas var 6:e timme{v2}.{v3}', { v: esc(TR.username || ''), v2: TR.last_sync ? t(', senast ') + fmtDate(TR.last_sync) : '', v3: TR.sync_error ? ' <span class="err">' + esc(TR.sync_error) + '</span>' : '' })}</p>
      <div class="row"><button class="ghost" id="trsync">${t('Synka nu')}</button><button class="danger" id="troff">${t('Koppla från')}</button></div>`
    : `<p class="muted small">${t('Synka vad du sett med Trakt.tv – åt båda hållen.')}</p><div id="trbox"><button class="primary" id="tron">${t('Koppla Trakt')}</button></div>`}</div>` : ''}
  <div class="panel" id="scrobble" hidden></div>
  <div class="panel" id="subsonic" hidden></div>
  <div class="panel" id="listenprefs"></div>
  <div class="panel" id="calfeed"></div>
  <div class="panel"><h2>${t('Inloggade enheter')}</h2>
    <table><tr><th>${t('Enhet')}</th><th>IP</th><th>${t('Senast aktiv')}</th><th></th></tr>
    ${sess.map(s => `<tr><td>${esc(device(s.ua))}${s.current ? t(' <span class="ok-badge">Den här</span>') : ''}</td><td class="muted">${esc(s.ip || '–')}</td><td class="muted">${fmtDate(s.last_seen)}</td>
      <td class="r">${s.current ? '' : `<button class="ghost small" data-rev="${s.id}">${t('Logga ut')}</button>`}</td></tr>`).join('')}</table>
    <div class="row" style="margin-top:12px"><button class="ghost" id="revall">${t('Logga ut alla andra enheter')}</button></div>
  </div>`;
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/me/password', { method: 'POST', body: { current: $('#c').value, password: $('#n1').value } }); toast(t('Lösenordet är bytt – andra enheter är utloggade')); route(); }
    catch (er) { toastErr(er); }
  };
  $$('[data-rev]').forEach(b => b.onclick = act(async () => { await api('/me/sessions/' + b.dataset.rev, { method: 'DELETE' }); route(); }));
  renderListenPrefs($('#listenprefs')).catch(e => { if (!e?.aborted) $('#listenprefs').hidden = true; });
  renderScrobble($('#scrobble')).catch(e => { if (!e?.aborted && $('#scrobble')) $('#scrobble').hidden = true; });
  renderSubsonic($('#subsonic')).catch(e => { if (!e?.aborted && $('#subsonic')) $('#subsonic').hidden = true; });
  calendarFeedPanel($('#calfeed')).catch(() => {});
  renderPlaybackPrefs($('#pbprefs')).catch(e => { if (!e?.aborted && $('#pbprefs')) $('#pbprefs').hidden = true; });
  renderFamilyPrefs($('#familyprefs')).catch(e => { if (!e?.aborted && $('#familyprefs')) $('#familyprefs').hidden = true; });
  renderCinemaPrefs($('#cinemaprefs')).catch(e => { if (!e?.aborted && $('#cinemaprefs')) $('#cinemaprefs').hidden = true; });
  renderThemePrefs($('#themeprefs')).catch(e => { if (!e?.aborted && $('#themeprefs')) $('#themeprefs').hidden = true; });
  if ($('#tron')) $('#tron').onclick = async () => {
    try {
      const r = await api('/me/trakt/connect', { method: 'POST' });
      $('#trbox').innerHTML = `<p>${t('Gå till <a href="{url}" target="_blank" rel="noopener">{url}</a> och ange koden:', { url: esc(r.url) })}</p><p style="font-size:2rem;letter-spacing:6px;font-weight:800">${esc(r.userCode)}</p><p class="muted small" id="trst">${t('Väntar…')}</p>`;
      const tick = async () => {
        const p = await api('/me/trakt/poll', { method: 'POST' }).catch(e => { if (e.aborted) throw e; return { status: 'pending' }; });
        if (p.status === 'connected') { toast(t('Trakt kopplat – synkar')); route(); }
        else if (p.status === 'pending') later(tick, (r.interval || 5) * 1000);
        else if ($('#trst')) $('#trst').textContent = p.status === 'denied' ? t('Nekades på Trakt.') : t('Koden gick ut – försök igen.');
      };
      later(tick, (r.interval || 5) * 1000);
    } catch (e) { toastErr(e); }
  };
  if ($('#trsync')) $('#trsync').onclick = async () => { try { const r = await api('/me/trakt/sync', { method: 'POST' }); toast(t('Synkat: {imported} markerade här, {exported} skickade till Trakt{v}', { imported: r.imported, exported: r.exported, v: r.ratings ? t(', {ratings} betyg', { ratings: r.ratings }) : '' })); route(); } catch (e) { toastErr(e); } };
  if ($('#troff')) $('#troff').onclick = act(async () => { if (await confirmDialog(t('Koppla från Trakt?'), { okLabel: t('Koppla från'), danger: true })) { await api('/me/trakt', { method: 'DELETE' }); route(); } });
  $$('[data-pkdel]').forEach(b => b.onclick = act(async () => { if (await confirmDialog(t('Ta bort passkeyn?'), { okLabel: t('Ta bort'), danger: true })) { await api('/me/passkeys/' + encodeURIComponent(b.dataset.pkdel), { method: 'DELETE' }); route(); } }));
  if ($('#pkadd')) $('#pkadd').onclick = async () => {
    // Med tvåstegsverifiering krävs även en kod (en passkey loggar in utan den)
    const f = await formDialog({ title: t('Lägg till passkey'), okLabel: t('Fortsätt'), fields: [
      { name: 'password', label: t('Ditt lösenord'), type: 'password', required: true },
      ...(me?.totp ? [{ name: 'code', label: t('Kod från autentiseringsappen'), inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, required: true }] : []),
      { name: 'name', label: t('Namn på passkeyn'), value: device(navigator.userAgent), hint: t('T.ex. "iPhone" eller "Jobbdator".'), maxlength: 60 }] });
    if (!f) return;
    const { password } = f, code = me?.totp ? f.code : undefined, name = f.name.trim() || 'Passkey';
    try { await passkeyRegister(password, name, code); toast(t('Passkey tillagd')); route(); }
    catch (e) { toast(e.name === 'NotAllowedError' ? t('Avbrutet') : e.name === 'InvalidStateError' ? t('Den här enheten har redan en passkey för kontot') : e.message); }
  };
  if ($('#proflist')) {
    const P2 = await api('/profiles');
    $('#proflist').innerHTML = `<table>${P2.profiles.map(p => `<tr><td>${esc(p.name)}${p.owner ? t(' <span class="muted small">(huvudkonto)</span>') : ''}</td>
      <td class="muted small">${p.kid ? (p.maxAge === 0 ? t('Barntillåten') : 'max ' + p.maxAge + t(' år')) : t('Vuxen')}${p.hasPin ? ' · PIN' : ''}${p.familyMode && p.familyMode !== 'off' ? t(' · familjefilter') : ''}</td>
      <td class="r">${p.owner ? '' : `<button class="ghost small" data-pst="${p.id}">${t('Skärmtid')}</button>`}<button class="ghost small" data-pff="${p.id}">${t('Familjefilter')}</button><button class="ghost small" data-ppin="${p.id}">${p.hasPin ? t('Byt/ta bort PIN') : t('Sätt PIN')}</button>
      ${p.owner ? '' : `<button class="danger small" data-pdel="${p.id}">${t('Ta bort')}</button>`}</td></tr>`).join('')}</table>`;
    $$('[data-ppin]').forEach(b => b.onclick = async () => {
      const pin = await promptDialog(t('Ny PIN (4–8 siffror)'), { type: 'pin', hint: t('Lämna tomt för att ta bort PIN.'), pattern: '[0-9]{4,8}', maxlength: 8, okLabel: t('Spara') }); if (pin === null) return;
      try { await api('/profiles/' + b.dataset.ppin, { method: 'PUT', body: { pin } }); toast(t('Sparat')); route(); } catch (e) { toastErr(e); }
    });
    $$('[data-pst]').forEach(b => b.onclick = act(() => screenDialog(P2.profiles.find(p => p.id === +b.dataset.pst))));
    $$('[data-pff]').forEach(b => b.onclick = act(() => familyProfileDialog(P2.profiles.find(p => p.id === +b.dataset.pff), () => route())));
    $$('[data-pdel]').forEach(b => b.onclick = act(async () => { if (await confirmDialog(t('Ta bort profilen och dess tittarhistorik?'), { okLabel: t('Ta bort'), danger: true })) { await api('/profiles/' + b.dataset.pdel, { method: 'DELETE' }); route(); } }));
    $('#addprof').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/profiles', { method: 'POST', body: { name: $('#pn').value, maxAge: $('#pa').value, pin: $('#pp').value } }); toast(t('Profil skapad')); route(); }
      catch (er) { toastErr(er); }
    };
  }
  $('#revall').onclick = act(async () => { if (await confirmDialog(t('Logga ut alla andra enheter, inklusive appar?'), { okLabel: t('Logga ut') })) { await api('/me/sessions/revoke-others', { method: 'POST' }); toast(t('Utloggade')); route(); } });
  if ($('#on')) $('#on').onclick = act(async () => {
    const r = await api('/me/2fa/setup', { method: 'POST' });
    $('#tfasetup').innerHTML = `<ol style="padding-left:18px;line-height:1.7">
      <li>${t('Skanna QR-koden med din autentiseringsapp')}<div id="qr" style="background:#fff;display:inline-block;padding:10px;border-radius:8px;margin:8px 0"></div></li>
      <li>${t('Eller ange nyckeln manuellt: <code style="user-select:all;word-break:break-all">{v}</code>', { v: esc(r.secret.replace(/(.{4})/g, '$1 ').trim()) })}</li>
      <li>${t('Skriv in den sexsiffriga koden som visas i appen:')}</li></ol>
      <div class="row"><input id="tc" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="max-width:160px;font-size:1.25rem;letter-spacing:4px">
      <input id="tpw" type="password" autocomplete="current-password" placeholder="${t('Ditt lösenord')}" style="max-width:220px"><button class="primary" id="tcok">${t('Bekräfta')}</button></div>`;
    loadQr().then(q => { const el = $('#qr'); if (!el) return; const qr = q(0, 'M'); qr.addData(r.uri); qr.make(); el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0 }); })
      .catch(() => { const el = $('#qr'); if (el) el.outerHTML = t('<span class="muted">(QR-koden kunde inte laddas – använd nyckeln nedan)</span>'); });
    $('#tc').focus();
    $('#tcok').onclick = async () => {
      try { const res = await api('/me/2fa/enable', { method: 'POST', body: { code: $('#tc').value, password: $('#tpw').value } }); showCodes(res.recoveryCodes); }
      catch (e) { toastErr(e); }
    };
  });
  if ($('#off')) $('#off').onclick = async () => {
    const f = await formDialog({ title: t('Stäng av tvåstegsverifiering'), okLabel: t('Stäng av'), danger: true, fields: [
      { name: 'password', label: t('Ditt lösenord'), type: 'password', required: true },
      { name: 'code', label: t('Kod från autentiseringsappen (eller en reservkod)'), inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, required: true }] });
    if (!f) return;
    const { password, code } = f;
    try { await api('/me/2fa/disable', { method: 'POST', body: { password, code } }); toast(t('Tvåstegsverifiering avstängd')); route(); } catch (e) { toastErr(e); }
  };
  if ($('#newrc')) $('#newrc').onclick = async () => {
    const password = await promptDialog(t('Ditt lösenord'), { title: t('Skapa nya reservkoder'), type: 'password', required: true, okLabel: t('Skapa') }); if (!password) return;
    try { const r = await api('/me/2fa/recovery', { method: 'POST', body: { password } }); showCodes(r.recoveryCodes); } catch (e) { toastErr(e); }
  };
  $('#homecust').onclick = () => openHomeCustomizer();
  bindA11yPrefs();
  $('#uilang').onchange = act(async (e) => { await setLang(e.target.value); });
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
  const status = (x) => `${x.error ? ` <span class="err">${esc(x.error)}</span>` : ''}${x.queued ? ` <span class="muted">${t('{queued} {v} på att skickas.', { queued: x.queued, v: x.queued === 1 ? t('lyssning väntar') : t('lyssningar väntar') })}</span>` : ''}`;
  const badge = (x) => x.connected ? (x.error ? t(' <span class="warn-badge">Fel</span>') : t(' <span class="ok-badge">Kopplat</span>')) : '';
  el.hidden = false;
  el.innerHTML = `<h2>Scrobbling</h2>
    <p class="muted small">${t('Skicka det du lyssnar på i musiken till ListenBrainz eller Last.fm – från webben och apparna. En låt räknas när du lyssnat på halva den (eller 4 minuter); låtar under 30 sekunder räknas inte. Kopplingen gäller bara den här profilen.')}</p>
    <h3 style="font-size:.9375rem;margin:12px 0 4px">ListenBrainz${badge(LB)}</h3>
    ${LB.connected ? `<p class="muted small">${t('Kopplat som <b>{v}</b>{v2}.{LB}', { v: esc(LB.username || ''), v2: LB.lastSent ? t(', senast skickat ') + fmtDate(LB.lastSent) : '', LB: status(LB) })}</p>
      <div class="row"><button class="danger" id="lboff">${t('Koppla från')}</button></div>`
    : `<p class="muted small">${t('Kopiera din användartoken från <a href="https://listenbrainz.org/settings/" target="_blank" rel="noopener">listenbrainz.org/settings</a>.')}</p>
      <form id="lbform" class="row" style="align-items:flex-end"><div style="flex:1;min-width:200px"><label for="lbtok">${t('Användartoken')}</label><input id="lbtok" type="password" autocomplete="off" required maxlength="200"></div>
      <button class="primary">${t('Koppla ListenBrainz')}</button></form>`}
    <h3 style="font-size:.9375rem;margin:18px 0 4px">Last.fm${badge(LF)}</h3>
    ${!LF.available ? t('<p class="muted small">Kräver API-nyckel (se README) – administratören anger den under Administration → Sonarr, Radarr och Trakt.</p>')
    : LF.connected ? `<p class="muted small">${t('Kopplat som <b>{v}</b>{v2}.{LF}', { v: esc(LF.username || ''), v2: LF.lastSent ? t(', senast skickat ') + fmtDate(LF.lastSent) : '', LF: status(LF) })}</p>
      <div class="row"><button class="danger" id="lfoff">${t('Koppla från')}</button></div>`
    : `<div id="lfbox"><p class="muted small">${t('Du loggar in på last.fm och godkänner BraXhn TV.')}</p><div class="row"><button class="primary" id="lfon">${t('Koppla Last.fm')}</button></div></div>`}`;
  const again = (d) => renderScrobble(el, d).catch(() => {});
  const off = (svc, name) => act(async () => {
    if (await confirmDialog(t('Koppla från {name}?', { name }), { okLabel: t('Koppla från'), danger: true })) again(await api('/me/scrobble/' + svc, { method: 'DELETE' }));
  });
  if ($('#lboff', el)) $('#lboff', el).onclick = off('listenbrainz', 'ListenBrainz');
  if ($('#lfoff', el)) $('#lfoff', el).onclick = off('lastfm', 'Last.fm');
  if ($('#lbform', el)) $('#lbform', el).onsubmit = async (e) => {
    e.preventDefault();
    try { const d = await api('/me/scrobble/listenbrainz', { method: 'PUT', body: { token: $('#lbtok', el).value } }); toast(t('ListenBrainz kopplat')); again(d); } catch (er) { toastErr(er); }
  };
  if ($('#lfon', el)) $('#lfon', el).onclick = act(async () => {
    const r = await api('/me/scrobble/lastfm/connect', { method: 'POST' });
    $('#lfbox', el).innerHTML = `<p>${t('<a class="btn primary" href="{url}" target="_blank" rel="noopener">Öppna Last.fm och godkänn</a>', { url: esc(r.url) })}</p><p class="muted small" id="lfst" role="status">${t('Väntar på att du godkänner på last.fm…')}</p>`;
    const tick = async () => {
      const p = await api('/me/scrobble/lastfm/poll', { method: 'POST' }).catch(e => { if (e.aborted) throw e; return { status: 'pending' }; });
      if (!el.isConnected) return;
      if (p.status === 'connected') { toast(t('Last.fm kopplat')); again(); }
      else if (p.status === 'pending') later(tick, 3000);
      else if ($('#lfst', el)) $('#lfst', el).textContent = t('Inloggningen gick ut – försök igen.');
    };
    later(tick, 3000);
  });
}

// ---------- musikappar (Subsonic): eget app-lösenord ----------
Object.assign(EVENTS, { subsonic_password_created: t('Lösenord för musikappar skapat'), subsonic_password_revoked: t('Lösenord för musikappar återkallat'),
  subsonic_login_fail: t('Fel lösenord från musikapp'), subsonic_denied: t('Musikapp nekad') });
async function renderSubsonic(el, data) {
  const S = data || await api('/me/subsonic');
  if (!el.isConnected || !S.enabled) return;
  const fmt = (tm) => tm ? fmtDate(tm) : t('aldrig');
  const server = `${location.origin}`;
  el.hidden = false;
  el.innerHTML = `<h2>${t('Musikappar {v}', { v: S.active ? t('<span class="ok-badge">På</span>') : '' })}</h2>
    <p class="muted small">${t('Lyssna på musiken i färdiga musikappar som Symfonium (Android, Android Auto), Amperfy och play:Sub (iPhone och CarPlay), Feishin och Supersonic (dator) eller Sonos via Music Assistant. Apparna använder ett eget lösenord som bara ger tillgång till musiken – inte filmer, serier eller ditt konto.')}</p>
    <table><tr><td>Server</td><td><code style="user-select:all">${esc(server)}</code></td></tr>
      <tr><td>${t('Användarnamn')}</td><td><code style="user-select:all">${esc(S.username)}</code></td></tr></table>
    ${S.screenTimeAudio ? t('<p class="small"><span class="warn-badge">Obs</span> Profilen har skärmtid för ljud. Musikappar kan inte följa skärmtiden och nekas därför – lyssna i BraXhn TV i stället.</p>') : ''}
    ${S.active ? `<p class="muted small" style="margin-top:8px">${t('Lösenordet skapades {created}{v} · senast använt {lastUsed}{v2}. Det visas bara när det skapas – skapa ett nytt om du behöver det igen (det gamla slutar då fungera i alla musikappar).', { created: fmt(S.created), v: S.createdAtHome ? t(' hemifrån') : '', lastUsed: fmt(S.lastUsed), v2: S.client ? ' av ' + esc(S.client) : '' })}</p>` : ''}
    <div class="row" style="margin-top:12px"><button class="primary" id="subnew">${S.active ? t('Skapa nytt lösenord') : t('Skapa lösenord för musikappar')}</button>${S.active ? t('<button class="danger" id="suboff">Återkalla</button>') : ''}</div>`;
  const again = (d) => renderSubsonic(el, d).catch(() => {});
  $('#subnew', el).onclick = async () => {
    const remote = !S.atHome;
    const f = await formDialog({ title: S.active ? t('Nytt lösenord för musikappar') : t('Lösenord för musikappar'), okLabel: t('Skapa'), fields: [
      { name: 'password', label: S.profile ? t('Huvudkontots lösenord') : t('Ditt lösenord'), type: 'password', required: true },
      ...(remote ? [{ name: 'code', label: t('Kod från autentiseringsappen'), inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, required: true,
        hint: t('Utanför hemmet krävs tvåstegsverifiering för att skapa lösenordet.') }] : [])] });
    if (!f) return;
    let r;
    try { r = await api('/me/subsonic', { method: 'POST', body: { password: f.password, code: f.code } }); } catch (e) { toastErr(e); return; }
    openDialog({
      title: t('Ditt lösenord för musikappar'),
      body: `<p class="muted small">${t('Lägg till en Subsonic-server i musikappen (i Symfonium: Lägg till mediaserver → Subsonic) med uppgifterna nedan. Lösenordet visas bara nu – spara det i appen eller i en lösenordshanterare.')}</p>
        <label>${t('Serveradress')}</label><input readonly value="${esc(server)}" class="subcopy" style="font-family:ui-monospace,monospace">
        <label>${t('Användarnamn')}</label><input readonly value="${esc(r.username)}" class="subcopy" style="font-family:ui-monospace,monospace">
        <label for="subpw">${t('Lösenord')}</label><input readonly value="${esc(r.password)}" class="subcopy" id="subpw" style="font-family:ui-monospace,monospace">
        <p class="muted small" style="margin-top:8px">${t('Vissa appar vill ha adressen med <code>/rest</code> på slutet. Utanför hemmet fungerar appen bara om ditt konto får användas utifrån{v}.', { v: r.has2fa ? '' : t(' (och om administratören kräver tvåstegsverifiering utifrån måste du aktivera den)') })}</p>`,
      actions: [{ label: t('Kopiera lösenordet'), onClick: () => { navigator.clipboard?.writeText(r.password).then(() => toast(t('Kopierat')), () => toastErr(new Error(t('Kunde inte kopiera – markera lösenordet och kopiera det själv')))); return false; } },
        { label: t('Klar'), kind: 'primary' }],
      onClose: () => again()
    });
    for (const i of $$('.subcopy')) i.onfocus = () => i.select();
  };
  if ($('#suboff', el)) $('#suboff', el).onclick = act(async () => {
    if (!await confirmDialog(t('Återkalla lösenordet för musikappar? Alla musikappar som använder det slutar fungera.'), { okLabel: t('Återkalla'), danger: true })) return;
    again(await api('/me/subsonic', { method: 'DELETE' })); toast(t('Lösenordet för musikappar är återkallat'));
  });
}

// ---------- skärmtid, följda serier och automatisk nedladdning ----------
Object.assign(EVENTS, { screentime_changed: t('Skärmtid ändrad'), screentime_extra: t('Extra skärmtid'), history_imported: t('Tittarhistorik importerad') });
/** Paneler under Mitt konto: följda serier, personliga notiser och automatisk nedladdning i appen */
async function accountExtras() {
  let N, S, F;
  try { [N, S, F] = await Promise.all([api('/me/notify'), api('/me/offline-sync'), api('/follows')]); }
  catch (e) { if (e.aborted) throw e; return; }
  main.insertAdjacentHTML('beforeend', `
  <div class="panel"><h2>${t('Serier jag följer')}</h2>
    <p class="muted small">${t('Nya avsnitt av serier du följer visas under <b>Nytt för dig</b> på startsidan. Du följer en serie med knappen Följ på serien, och automatiskt när du lägger den i Min lista eller ser klart ett avsnitt. Slutar du följa en serie följs den inte automatiskt igen.')}</p>
    ${F.length ? `<table>${F.map(f => `<tr><td><a href="#/item/${f.id}">${esc(f.title)}</a></td><td class="muted small">${f.sync == null ? '' : f.sync === 0 ? t('Laddas inte ner i appen') : t('Håll {sync} nedladdade i appen', { sync: f.sync })}</td>
      <td class="r"><button class="ghost small" data-unf="${f.id}">${t('Sluta följa')}</button></td></tr>`).join('')}</table>` : t('<p class="muted">Du följer inga serier ännu.</p>')}</div>
  ${N.allowed ? `<div class="panel"><h2>${t('Notiser om nya avsnitt')}</h2>
    <p class="muted small">${t('Få en notis i mobilen när nya avsnitt av serier du följer kommer – flera avsnitt samlas i en notis. Använd t.ex. appen <b>ntfy</b> (adress som https://ntfy.sh/ett-hemligt-ämne) eller en egen webhook som tar emot JSON. Adressen måste gå att nå via internet; adresser i hemnätet tillåts inte.')}</p>
    <div class="row" style="align-items:flex-end"><div><label for="nk">${t('Typ')}</label><select id="nk"><option value="none">${t('Av')}</option><option value="ntfy">ntfy</option><option value="webhook">Webhook (JSON)</option></select></div>
      <div style="flex:1;min-width:220px"><label for="nu">${t('Adress')}</label><input id="nu" value="${esc(N.url)}" placeholder="${t('https://ntfy.sh/mitt-hemliga-amne')}" maxlength="500"></div>
      <div><label for="nt">${t('Token (valfri)')}</label><input id="nt" type="password" autocomplete="off" placeholder="${N.hasToken ? t('(sparad)') : ''}"></div></div>
    <div class="row" style="margin-top:12px"><button class="primary" id="nsave">${t('Spara')}</button><button class="ghost" id="ntest" ${N.kind === 'none' ? 'disabled' : ''}>${t('Skicka testnotis')}</button></div></div>` : ''}
  <div class="panel"><h2>${t('Automatisk nedladdning i appen')}</h2>
    <p class="muted small">${t('iPhone/iPad- och Android-appen håller de närmaste osedda avsnitten nedladdade, så att de finns när du saknar nät. Appen synkar när den öppnas och tar bort avsnitt som den själv laddat ner när du har sett dem. Per serie kan du ändra antalet på seriens sida.')}</p>
    <div class="row" style="align-items:flex-end">
      <div><label for="sc">${t('Avsnitt per serie')}</label><select id="sc"><option value="0">${t('Av')}</option>${[1, 2, 3, 5, 10].map(n => `<option value="${n}">${n}</option>`).join('')}</select></div>
      <div><label for="ss">${t('Vilka serier')}</label><select id="ss"><option value="follows">${t('Serier jag följer')}</option><option value="continue">${t('Fortsätt titta (senaste 30 dagarna)')}</option></select></div>
      <div><label for="sq">${t('Kvalitet')}</label><select id="sq"><option value="480">${t('480p (minst)')}</option><option value="720">720p</option><option value="1080">1080p</option><option value="orig">Original</option></select></div>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="sw"> ${t('Bara på Wi-Fi')}</label></div>
    <div class="row" style="margin-top:12px"><button class="primary" id="ssave">${t('Spara')}</button></div></div>`);
  $$('[data-unf]').forEach(b => b.onclick = act(async () => { await api(`/items/${b.dataset.unf}/follow`, { method: 'POST', body: { follow: false } }); route(); }));
  if ($('#nk')) {
    $('#nk').value = N.kind;
    $('#nsave').onclick = act(async () => {
      const tm = $('#nt').value;
      const r = await api('/me/notify', { method: 'PUT', body: { kind: $('#nk').value, url: $('#nu').value, ...(tm ? { token: tm } : {}) } });
      $('#ntest').disabled = r.kind === 'none'; $('#nt').value = ''; $('#nt').placeholder = r.hasToken ? t('(sparad)') : ''; toast(t('Sparat'));
    });
    $('#ntest').onclick = act(async () => { await api('/me/notify/test', { method: 'POST' }); toast(t('Testnotisen skickades')); });
  }
  $('#sc').value = String(S.count); $('#ss').value = S.scope; $('#sq').value = S.quality; $('#sw').checked = S.wifiOnly;
  $('#ssave').onclick = act(async () => {
    await api('/me/offline-sync', { method: 'PUT', body: { count: +$('#sc').value, scope: $('#ss').value, quality: $('#sq').value, wifiOnly: $('#sw').checked } });
    toast(t('Sparat – appen synkar nästa gång den öppnas'));
  });
}
