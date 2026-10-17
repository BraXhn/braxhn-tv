// Vyer: inloggning, första kontot och profilval ("Vem tittar?")
import { $, $$, act, api, esc, hue, main, me, safeColor, toast, views } from '../core.js';
import { stopAudio } from '../audio.js';
import { passkeyLogin, passkeyOk } from '../passkeys.js';
import { boot } from '../router.js';

views.login = async () => {
  const st = await api('/status');
  const setup = st.needsSetup;
  $('#top').hidden = true;
  main.innerHTML = `<form class="auth" id="f">
    <div class="brand"><img class="logo-full" src="/brand/logo.svg" alt="BraXhn TV"></div>
    <p>${setup ? 'Välkommen! Skapa administratörskontot.' : 'Logga in'}</p>
    <label for="n">Användarnamn</label><input id="n" autocomplete="username" required maxlength="64">
    <label for="p">Lösenord</label><input id="p" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 10 : 1}">
    ${setup ? '<p class="muted small" style="text-align:left;margin-top:6px">Minst 10 tecken med blandade tecken, eller minst 14 tecken.</p>' : ''}
    <div id="codebox" hidden><label for="code">Kod från autentiseringsappen (eller reservkod)</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12"></div>
    <div class="err" id="e"></div>
    <button class="primary">${setup ? 'Skapa konto' : 'Logga in'}</button>
    ${!setup && passkeyOk() ? '<button type="button" class="ghost" id="pkl" style="width:100%;margin-top:10px">Logga in med passkey</button>' : ''}</form>`;
  if ($('#pkl')) $('#pkl').onclick = async () => {
    try { await passkeyLogin(); await boot(); location.hash = me.profiles > 1 ? '#/profiles' : '#/'; }
    catch (e) { $('#e').textContent = e.name === 'NotAllowedError' ? 'Avbrutet' : e.message; }
  };
  $('#n').focus();
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { name: $('#n').value, password: $('#p').value };
    if (!$('#codebox').hidden) body.code = $('#code').value.trim();
    try {
      const r = await fetch('/api' + (setup ? '/setup' : '/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (d.need2fa) { $('#codebox').hidden = false; $('#code').focus(); $('#e').textContent = body.code ? d.error : ''; return; }
      if (!r.ok) throw new Error(d.error || 'Fel ' + r.status);
      await boot();
      if (d.weakPassword) { toast('Ditt lösenord är svagt – byt det under Mitt konto'); location.hash = '#/account'; }
      else location.hash = setup ? '#/admin' : me.profiles > 1 ? '#/profiles' : '#/';
    } catch (e) { $('#e').textContent = e.message; }
  };
};

// ---------- Profiler: "Vem tittar?" ----------
views.profiles = async () => {
  const d = await api('/profiles');
  $('#top').hidden = true;
  main.innerHTML = `<div class="profiles"><h1>Vem tittar?</h1><div class="plist">${d.profiles.map(p => {
    const h = hue(p.name);
    return `<button class="pcard" data-pid="${p.id}" data-pin="${p.hasPin ? 1 : 0}" data-kid="${p.kid ? 1 : 0}">
      <span class="pav" style="background:${esc(safeColor(p.color)) || `hsl(${h} 55% 45%)`}">${esc(p.name.slice(0, 1).toUpperCase())}</span>
      <span>${esc(p.name)}</span>${p.kid ? `<small class="muted">Barn · max ${p.maxAge} år</small>` : p.hasPin ? '<small class="muted">🔒 PIN</small>' : ''}</button>`;
  }).join('')}</div>
  <div class="row" style="justify-content:center;margin-top:30px"><button class="ghost" id="pdone">Fortsätt som ${esc(me.name)}</button></div></div>`;
  $('#pdone').onclick = () => { $('#top').hidden = false; location.hash = '#/'; };
  $$('[data-pid]').forEach(b => b.onclick = async () => {
    const id = +b.dataset.pid;
    if (id === me.id) { $('#top').hidden = false; location.hash = '#/'; return; }
    const body = { id };
    const attempt = async () => {
      const r = await fetch('/api/profiles/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (j.needPin) { const pin = prompt(body.pin ? 'Fel PIN – försök igen:' : 'Ange PIN för profilen:'); if (!pin) return; body.pin = pin; return attempt(); }
      if (j.needPassword) { const pw = prompt('Ange huvudkontots lösenord:'); if (!pw) return; body.password = pw; return attempt(); }
      if (!r.ok) return toast(j.error || 'Kunde inte byta profil');
      stopAudio(); // framsteg ska inte sparas på den nya profilen
      await boot(); location.hash = '#/';
    };
    act(attempt)();
  });
};
