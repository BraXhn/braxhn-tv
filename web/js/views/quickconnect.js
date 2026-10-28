// Snabbinloggning med kod (för TV-webbläsare och TV-appar): visa en sexsiffrig kod som godkänns från en inloggad
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
// telefon/dator, och vyn #/quickconnect(/<kod>) där den inloggade godkänner. Servern: /api/quickconnect i server/routes/auth.js.
import { $, act, api, esc, later, main, me, onLeave, pageAfterLogin, toast, views, t } from '../core.js';
import { boot } from '../router.js';
import { openDialog } from '../ui/dialog.js';

/** QR-generatorn (web/vendor/qrcode.min.js) laddas först när den behövs. */
export function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  return new Promise((ok, no) => { const s = document.createElement('script'); s.src = new URL('../../vendor/qrcode.min.js', import.meta.url).href; s.onload = () => ok(window.qrcode); s.onerror = no; document.head.append(s); });
}
/** Ritar en QR-kod som SVG i elementet (tyst om skriptet inte kunde laddas). */
export function drawQr(el, text, cellSize = 5) {
  return loadQr().then(q => { if (!el.isConnected) return; const qr = q(0, 'M'); qr.addData(text); qr.make(); el.innerHTML = qr.createSvgTag({ cellSize, margin: 0 }); })
    .catch(() => { el.hidden = true; });
}
// Koden visas som "123 456" – lättare att läsa på avstånd
const spaced = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;
// Enhetens namn i godkännandet: webbläsare och system ur user agent
function deviceName() {
  const ua = navigator.userAgent;
  const tv = /SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|AFT|Android TV|GoogleTV|CrKey|HbbTV/i.test(ua);
  const b = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : t('Webbläsare');
  return `${b}${tv ? t(' på TV') : ''}`;
}

/**
 * Inloggning med kod i webben: visar koden stort med en QR-kod till godkännandesidan och pollar var 3:e sekund.
 * Loggar in (kaka från servern) när koden godkänts. onCancel visar inloggningsformuläret igen.
 */
export async function codeLogin({ remember = true, onCancel } = {}) {
  let stop = false, tm = null;
  const cancel = () => { stop = true; tm?.(); };
  onLeave(cancel);
  const show = (html) => {
    main.innerHTML = `<div class="auth qc-login">
      <div class="brand"><img class="logo-full" src="/brand/logo.svg" alt="BraXhn TV"></div>${html}
      <button type="button" class="ghost" id="qcback">${t('Logga in med lösenord i stället')}</button></div>`;
    $('#qcback').onclick = () => { cancel(); onCancel?.(); };
  };
  const begin = async () => {
    show(t('<p>Hämtar kod…</p>'));
    let r;
    try {
      const res = await fetch('/api/quickconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: deviceName(), device: t('Webbläsare'), remember }) });
      r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error ? t(r.error) : t('Fel {status}', { status: res.status }));
    } catch (e) {
      show(`<p class="err">${esc(e.message)}</p><button type="button" class="primary" id="qcnew">${t('Försök igen')}</button>`);
      $('#qcnew').onclick = begin; return;
    }
    if (stop) return;
    const link = `${location.origin}/#/quickconnect/${r.code}`;
    show(`<p>${t('Logga in på din telefon eller dator och ange koden under <b>Godkänn inloggning på TV</b> i menyn – eller skanna QR-koden.')}</p>
      <div class="qc-code" aria-label="Kod ${esc(r.code.split('').join(' '))}">${esc(spaced(r.code))}</div>
      <div class="qc-qr" id="qcqr" aria-hidden="true"></div>
      <p class="muted small qc-link">${esc(location.origin)}/#/quickconnect</p>
      <p class="muted small" id="qcst" role="status">${t('Väntar på godkännande… Koden gäller i 5 minuter.')}</p>`);
    drawQr($('#qcqr'), link, 6);
    const poll = async () => {
      if (stop) return;
      let d;
      try {
        const res = await fetch('/api/quickconnect/' + r.secret, { headers: { 'X-Requested-With': 'BraXhnTV' } });
        d = await res.json().catch(() => ({}));
        if (!res.ok) { stop = true; show(`<p class="err">${esc(d.error ? t(d.error) : t('Fel {status}', { status: res.status }))}</p><button type="button" class="primary" id="qcnew">${t('Ny kod')}</button>`); $('#qcnew').onclick = () => { stop = false; begin(); }; return; }
      } catch { d = { status: 'pending' }; } // tillfälligt nätverksfel: fortsätt försöka
      if (stop) return;
      if (d.status === 'approved') {
        stop = true;
        await boot();
        location.hash = pageAfterLogin();
        return;
      }
      if (d.status === 'expired') {
        show(t('<p>Koden har gått ut.</p><button type="button" class="primary" id="qcnew">Visa en ny kod</button>'));
        $('#qcnew').onclick = begin; $('#qcnew').focus(); return;
      }
      tm = later(poll, 3000);
    };
    tm = later(poll, 3000);
  };
  await begin();
}

// ---------- Godkänn inloggning på TV (#/quickconnect och #/quickconnect/<kod> från QR-koden) ----------
views.quickconnect = async (pre) => {
  const code0 = String(pre || '').replace(/\D/g, '').slice(0, 6);
  main.innerHTML = `<div class="panel qc-approve"><h2>${t('Godkänn inloggning på TV')}</h2>
    <p class="muted">${t('Välj <b>Logga in med kod</b> på TV:n eller i TV-appen och skriv in koden som visas där. TV:n loggas in som <b>{name}</b>{v}.', { name: esc(me.name), v: me.kid ? ` ${t('(barnprofil, max {maxAge} år)', { maxAge: esc(me.maxAge) })}` : '' })}</p>
    <form id="qcf" class="row" style="align-items:flex-end">
      <div><label for="qcc">Kod</label><input id="qcc" class="qc-input" inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="\\d{3} ?\\d{3}" required value="${esc(code0)}" placeholder="123456"></div>
      <button class="primary">${t('Fortsätt')}</button></form>
    <div class="err" id="qce" role="alert"></div></div>`;
  const input = $('#qcc');
  input.focus();
  $('#qcf').onsubmit = act(async (ev) => {
    ev.preventDefault();
    const code = input.value.replace(/\D/g, '');
    $('#qce').textContent = '';
    if (code.length !== 6) { $('#qce').textContent = t('Koden har sex siffror'); return; }
    let info;
    try { info = await api('/quickconnect/approve', { method: 'POST', body: { code } }); }
    catch (e) { $('#qce').textContent = e.message; return; }
    const where = [info.name, info.device && info.device !== info.name ? info.device : null].filter(Boolean).join(' · ') || t('Okänd enhet');
    const d = openDialog({ title: t('Godkänn inloggning'),
      body: `<table class="qc-info"><tr><th>${t('Enhet')}</th><td>${esc(where)}</td></tr><tr><th>${t('IP-adress')}</th><td>${esc(info.ip)}</td></tr>
        <tr><th>${t('Loggas in som')}</th><td>${esc(info.profile)}</td></tr></table>
        <p class="muted small">${t('Godkänn bara om du själv ser koden på din TV. Enheten syns sedan under Mitt konto → Inloggade enheter.')}</p>`,
      actions: [{ label: t('Avbryt'), value: false }, { label: t('Godkänn'), kind: 'primary', value: true }] });
    d.$('.dlg-actions .primary')?.focus();
    if (await d.closed !== true) return;
    try { await api('/quickconnect/approve', { method: 'POST', body: { code, confirm: true } }); }
    catch (e) { $('#qce').textContent = e.message; return; }
    toast(t('Klart – TV:n loggas in om några sekunder'));
    input.value = '';
    if (location.hash !== '#/quickconnect') location.hash = '#/quickconnect';
  });
};
