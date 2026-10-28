// Vyer: inloggning, första kontot och profilval ("Vem tittar?")
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, hue, main, me, pageAfterLogin, safeColor, store, toast, views, t, locale } from '../core.js';
import { closeAllPlayers, stopAudio } from '../lazy.js';
import { passkeyLogin, passkeyOk } from '../passkeys.js';
import { boot } from '../router.js';
import { promptDialog } from '../ui/dialog.js';
import { codeLogin } from './quickconnect.js';

views.login = async () => {
  const st = await api('/status');
  const setup = st.needsSetup;
  $('#top').hidden = true;
  main.innerHTML = `<form class="auth" id="f">
    <div class="brand"><img class="logo-full" src="/brand/logo.svg" alt="BraXhn TV"></div>
    <p>${setup ? t('Välkommen! Börja med att skapa administratörskontot – sedan hjälper en kort guide dig att komma igång.') : t('Logga in')}</p>
    <label for="n">${t('Användarnamn')}</label><input id="n" autocomplete="username" required maxlength="64">
    <label for="p">${t('Lösenord')}</label><input id="p" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 10 : 1}">
    ${setup ? t('<p class="muted small" style="text-align:left;margin-top:6px">Minst 10 tecken med blandade tecken, eller minst 14 tecken.</p>') : ''}
    <div id="codebox" hidden><label for="code">${t('Kod från autentiseringsappen (eller reservkod)')}</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12"></div>
    <div class="err" id="e"></div>
    ${setup ? '' : `<label class="remember"><input type="checkbox" id="rem" ${store.get('remember', '1') === '1' ? 'checked' : ''}> ${t('Håll mig inloggad i 30 dagar')}</label>`}
    <button class="primary">${setup ? t('Skapa konto') : t('Logga in')}</button>
    ${!setup && passkeyOk() ? t('<button type="button" class="ghost" id="pkl" style="width:100%;margin-top:10px">Logga in med passkey</button>') : ''}
    ${!setup && st.quickConnect ? t('<button type="button" class="ghost" id="qcl" style="width:100%;margin-top:10px">Logga in med kod</button><p class="muted small" style="margin-top:6px">Bra på TV: godkänn en kod från telefonen i stället för att skriva lösenord.</p>') : ''}</form>`;
  if ($('#qcl')) $('#qcl').onclick = () => codeLogin({ remember: remember(), onCancel: () => views.login() });
  if ($('#pkl')) $('#pkl').onclick = async () => {
    try { await passkeyLogin(remember()); await boot(); location.hash = me.profiles > 1 ? '#/profiles' : pageAfterLogin(); }
    catch (e) { $('#e').textContent = e.name === 'NotAllowedError' ? t('Avbrutet') : e.message; }
  };
  // "Håll mig inloggad": valet sparas till nästa gång. Utan det glömmer webbläsaren inloggningen när den stängs.
  const remember = () => { const r = $('#rem'); if (!r) return true; store.set('remember', r.checked ? '1' : '0'); return r.checked; };
  $('#n').focus();
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { name: $('#n').value, password: $('#p').value, remember: remember() };
    if (!$('#codebox').hidden) body.code = $('#code').value.trim();
    try {
      const r = await fetch('/api' + (setup ? '/setup' : '/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (d.need2fa) { $('#codebox').hidden = false; $('#code').focus(); $('#e').textContent = body.code ? t(d.error || '') : ''; return; }
      if (!r.ok) throw new Error(d.error ? t(d.error) : t('Fel {status}', { status: r.status }));
      await boot();
      if (d.weakPassword) { toast(t('Ditt lösenord är svagt – byt det under Mitt konto')); location.hash = '#/account'; }
      else location.hash = setup ? '#/setup/welcome' : me.profiles > 1 ? '#/profiles' : pageAfterLogin();
    } catch (e) { $('#e').textContent = e.message; }
  };
};

// ---------- Inbjudan (#/invite/<token>): mottagaren skapar ett eget konto ----------
// Rättigheterna (bibliotek, nedladdning …) har administratören valt i inbjudan; servern kontrollerar allt (server/invites.js).
views.invite = async (token) => {
  $('#top').hidden = true;
  const tm = /^[a-f0-9]{64}$/.test(token || '') ? token : '';
  const r = tm ? await fetch('/api/invite/' + tm).catch(() => null) : null;
  const d = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok) {
    main.innerHTML = `<div class="auth"><div class="brand"><img class="logo-full" src="/brand/logo.svg" alt="BraXhn TV"></div>
      <p>${esc(d.error ? t(d.error) : t('Inbjudan är ogiltig, redan använd eller har gått ut'))}</p>
      <p class="muted small">${t('Be den som skickade länken om en ny.')}</p><a class="btn ghost" href="#/login">${t('Till inloggningen')}</a></div>`;
    return;
  }
  main.innerHTML = `<form class="auth" id="f">
    <div class="brand"><img class="logo-full" src="/brand/logo.svg" alt="BraXhn TV"></div>
    <p>${t('Du har bjudits in till {v}. Välj ett namn och ett lösenord för ditt konto.', { v: esc(d.name || 'BraXhn TV') })}</p>
    ${me ? `<p class="muted small">${t('Du är inloggad som {name}. Skapar du ett konto loggas du in på det i stället.', { name: esc(me.name) })}</p>` : ''}
    ${d.homeOnly && !d.atHome ? t('<p class="err">Den här inbjudan gäller bara hemnätverket – öppna länken hemma.</p>') : ''}
    <label for="n">${t('Användarnamn')}</label><input id="n" autocomplete="username" required maxlength="64">
    <label for="p">${t('Lösenord')}</label><input id="p" type="password" autocomplete="new-password" required minlength="10">
    <p class="muted small" style="text-align:left;margin-top:6px">${t('Minst 10 tecken med blandade tecken, eller minst 14 tecken.')}</p>
    <div class="err" id="e"></div>
    <label class="remember"><input type="checkbox" id="rem" ${store.get('remember', '1') === '1' ? 'checked' : ''}> ${t('Håll mig inloggad i 30 dagar')}</label>
    <button class="primary">${t('Skapa konto')}</button>
    <p class="muted small" style="margin-top:10px">${t('Giltig till {v}. Länken fungerar en gång.', { v: esc(new Date(d.expires * 1000).toLocaleDateString(locale)) })}</p></form>`;
  $('#n').focus();
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const remember = $('#rem').checked;
    store.set('remember', remember ? '1' : '0');
    try {
      const res = await fetch('/api/invite/' + tm, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#n').value, password: $('#p').value, remember }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ? t(j.error) : t('Fel {status}', { status: res.status }));
      await boot();
      toast(t('Välkommen! Ditt konto är skapat'));
      location.hash = '#/';
    } catch (e) { $('#e').textContent = e.message; }
  };
};

// ---------- Profiler: "Vem tittar?" ----------
views.profiles = async () => {
  const d = await api('/profiles');
  $('#top').hidden = true;
  main.innerHTML = `<div class="profiles"><h1>${t('Vem tittar?')}</h1><div class="plist">${d.profiles.map(p => {
    const h = hue(p.name);
    return `<button class="pcard" data-pid="${p.id}" data-pin="${p.hasPin ? 1 : 0}" data-kid="${p.kid ? 1 : 0}">
      <span class="pav" aria-hidden="true" style="background:${esc(safeColor(p.color)) || `hsl(${h} 55% 45%)`}">${esc(p.name.slice(0, 1).toUpperCase())}</span>
      <span>${esc(p.name)}</span>${p.kid ? `${t('<small class="muted">Barn · max {maxAge} år</small>', { maxAge: p.maxAge })}` : p.hasPin ? '<small class="muted"><span aria-hidden="true">🔒 </span>PIN</small>' : ''}</button>`;
  }).join('')}</div>
  <div class="row" style="justify-content:center;margin-top:30px"><button class="ghost" id="pdone">${t('Fortsätt som {name}', { name: esc(me.name) })}</button></div></div>`;
  $('#pdone').onclick = () => { $('#top').hidden = false; location.hash = '#/'; };
  $$('[data-pid]').forEach(b => b.onclick = async () => {
    const id = +b.dataset.pid;
    if (id === me.id) { $('#top').hidden = false; location.hash = '#/'; return; }
    const body = { id };
    const attempt = async () => {
      const r = await fetch('/api/profiles/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      const name = b.querySelector('span:not(.pav)')?.textContent || t('profilen');
      if (j.needPin) {
        const pin = await promptDialog('PIN', { title: t('PIN för {name}', { name }), text: body.pin ? t('Fel PIN – försök igen.') : '', type: 'pin', autocomplete: 'off', required: true, maxlength: 8, okLabel: t('Byt profil') });
        if (!pin) return; body.pin = pin; return attempt();
      }
      if (j.needPassword) {
        const pw = await promptDialog(t('Huvudkontots lösenord'), { title: t('Byt till {name}', { name }), type: 'password', required: true, okLabel: t('Byt profil') });
        if (!pw) return; body.password = pw; return attempt();
      }
      if (!r.ok) return toast(j.error || t('Kunde inte byta profil'));
      stopAudio(); closeAllPlayers(); // framsteg ska inte sparas på den nya profilen (och spelaren inte fortsätta)
      await boot(); location.hash = '#/';
    };
    act(attempt)();
  });
};
