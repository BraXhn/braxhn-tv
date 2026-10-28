// Enkel inloggning (administratör på betrott nät): leverantörer för OpenID Connect (Authentik, Authelia, Keycloak,
// Google …) och LDAP, grupper → roll och bibliotek, automatiska konton, kopplade konton och om andra än administratörer
// får logga in med lösenord. Servern: server/sso.js, oidc.js, ldap.js, routes/sso.js. Hemligheter visas aldrig –
// ett tomt fält behåller den sparade. #/sso, #/sso/new-oidc, #/sso/new-ldap, #/sso/<id>.
// @lazy – laddas vid behov (LAZY i js/router.js)
import { $, $$, act, api, esc, fmtDate, libs, main, me, toast, toastErr, views, t } from '../core.js';
import { confirmDialog, formDialog, openDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';

const kindName = (k) => k === 'ldap' ? 'LDAP' : 'OpenID Connect';
const roleName = (r) => ({ admin: t('Administratör'), user: t('Vanlig användare'), kid: t('Barn') }[r] || t('Får inte logga in'));
const hint = (id, text) => `<p class="muted small" id="${id}-h" style="margin:4px 0 0">${text}</p>`;
function inp(id, label, val, { type = 'text', help, ph, req, auto } = {}) {
  return `<label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(val ?? '')}"${ph ? ` placeholder="${esc(ph)}"` : ''}${req ? ' required' : ''}${auto ? ` autocomplete="${auto}"` : ''}${help ? ` aria-describedby="${id}-h"` : ''}>${help ? hint(id, help) : ''}`;
}
const chk = (id, label, on, help) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}${help ? ` aria-describedby="${id}-h"` : ''}> ${label}</label>${help ? hint(id, help) : ''}`;
const joinList = (a) => (a || []).join(', ');
const splitList = (s) => String(s || '').split(/[,\n]+/).map(x => x.trim()).filter(Boolean);

views.sso = async (arg) => {
  if (!me.adminHere) { main.innerHTML = emptyState({ icon: '🔒', title: t('Bara för administratörer på hemnätet') }); return; }
  const d = await api('/sso');
  if (arg === 'new-oidc' || arg === 'new-ldap') return editView({ kind: arg.slice(4), enabled: true, groups: {}, libraries: [] }, d);
  if (arg) { const p = d.providers.find(x => String(x.id) === String(arg)); if (p) return editView(p, d); }
  main.innerHTML = `<div class="toolbar"><h1>${t('Enkel inloggning')}</h1><a class="btn ghost small" href="#/admin">Administration</a></div>
    <div class="panel"><p class="muted small">${t('Låt familjen eller organisationen logga in med kontot de redan har: OpenID Connect (Authentik, Authelia, Keycloak, Google, Microsoft …) eller LDAP (lldap, OpenLDAP, Active Directory, FreeIPA). Lokala konton fungerar som förut.')}</p>
      ${d.providers.length ? `<table><tr><th>${t('Namn')}</th><th>${t('Typ')}</th><th>${t('Kopplade konton')}</th><th></th></tr>
        ${d.providers.map(p => `<tr><td>${esc(p.name)} ${p.enabled ? '' : `<span class="warn-badge">${t('Avstängd')}</span>`}${p.insecure ? ` <span class="warn-badge">${t('Okrypterat')}</span>` : ''}</td>
          <td class="muted">${kindName(p.kind)}</td><td class="muted">${p.links}</td><td class="r"><a class="btn ghost small" href="#/sso/${+p.id}">${t('Ändra')}</a></td></tr>`).join('')}</table>`
        : `<p>${t('Ingen enkel inloggning är inställd.')}</p>`}
      <div class="row" style="margin-top:12px"><a class="btn primary" href="#/sso/new-oidc">${t('Lägg till OpenID Connect')}</a><a class="btn" href="#/sso/new-ldap">${t('Lägg till LDAP')}</a></div></div>
    <div class="panel"><h2>${t('Lösenordsinloggning')}</h2><form id="llf">
      <fieldset style="border:0;padding:0;margin:0"><legend class="sr-only">${t('Vilka får logga in med lösenord?')}</legend>
      <label class="switch"><input type="radio" name="ll" value="all" ${d.localLogin !== 'admin' ? 'checked' : ''}> ${t('Alla lokala konton (som förut)')}</label>
      <label class="switch"><input type="radio" name="ll" value="admin" ${d.localLogin === 'admin' ? 'checked' : ''}> ${t('Bara administratörer – andra loggar in med enkel inloggning')}</label></fieldset>
      ${hint('ll', t('Administratörernas lösenord fungerar alltid, så att du kommer in även när leverantören är nere (reservinloggning). LDAP-användare loggar in med katalogens lösenord i samma formulär.'))}
      <div class="row" style="margin-top:12px"><button class="primary">${t('Spara')}</button></div></form></div>
    <div class="panel"><h2>${t('Så här kommer du igång')}</h2>
      <p class="muted small">${t('Authentik: skapa en OAuth2/OpenID-leverantör och en applikation. Utfärdaren är https://auth.example.com/application/o/braxhn/ (applikationens slug sist).')}</p>
      <p class="muted small">${t('Authelia: lägg till en klient under identity_providers.oidc.clients med den redirect-URI som visas när du sparat. Utfärdaren är Authelias adress.')}</p>
      <p class="muted small">${t('Keycloak: utfärdaren är https://keycloak.example.com/realms/hemma (realmens namn sist). Lägg till en mapper för grupper (claim "groups").')}</p>
      <p class="muted small">${t('Google: utfärdaren är https://accounts.google.com. Google skickar inga grupper – ange tillåtna e-postadresser eller en domän.')}</p></div>`;
  $('#llf').onsubmit = act(async (e) => {
    e.preventDefault();
    await api('/sso/settings', { method: 'PUT', body: { localLogin: $('[name=ll]:checked').value } });
    toast(t('Sparat'));
  });
};

function editView(p, d) {
  const oidc = p.kind === 'oidc', isNew = !p.id;
  const libGroups = (lid) => (p.libraries || []).filter(r => r.ids.includes(lid)).map(r => r.group);
  const g = p.groups || {};
  const redirect = p.redirectUri || `${p.redirectBase || d.suggestedBase}/api/sso/oidc/<id>/callback`;
  main.innerHTML = `<div class="toolbar"><h1>${isNew ? t('Ny inloggning: {kind}', { kind: kindName(p.kind) }) : esc(p.name)}</h1><a class="btn ghost small" href="#/sso">${t('Tillbaka')}</a></div>
  <form id="pf">
  <div class="panel"><h2>${t('Allmänt')}</h2>
    ${inp('pname', t('Namn (visas på knappen "Logga in med …")'), p.name, { req: true, ph: oidc ? 'Authentik' : t('Katalogen') })}
    ${chk('pen', t('Påslagen'), p.enabled !== false)}
  </div>
  ${oidc ? `<div class="panel"><h2>OpenID Connect</h2>
    ${inp('iss', t('Utfärdare (issuer)'), p.issuer, { req: true, type: 'url', ph: 'https://auth.example.com/application/o/braxhn/', help: t('Servern hämtar resten (/.well-known/openid-configuration) och kontrollerar att utfärdaren stämmer exakt.') })}
    ${inp('cid', t('Klient-id (client ID)'), p.clientId, { req: true, auto: 'off' })}
    ${inp('csec', t('Klienthemlighet (client secret)'), '', { type: 'password', auto: 'new-password', ph: p.hasSecret ? t('Sparad – lämna tomt för att behålla') : t('Tomt för en publik klient (bara PKCE)') })}
    ${p.hasSecret ? chk('cclr', t('Ta bort den sparade hemligheten'), false) : ''}
    ${inp('rbase', t('Serverns adress för återkomsten'), p.redirectBase || d.suggestedBase, { type: 'url', req: true, help: t('Den enda adress leverantören får skicka tillbaka till. Ange den här redirect-URI:n hos leverantören:') + ` <code id="ruri">${esc(redirect)}</code>` })}
    ${inp('scopes', 'Scopes', p.scopes || 'openid profile email', { help: t('Lägg till t.ex. "groups" om leverantören kräver det för att skicka grupperna.') })}
    <div class="row"><div style="flex:1;min-width:160px">${inp('gclaim', t('Claim med grupper'), p.groupsClaim || 'groups', { help: t('Keycloak-roller: realm_access.roles') })}</div>
      <div style="flex:1;min-width:160px">${inp('uclaim', t('Claim med användarnamn'), p.usernameClaim || 'preferred_username')}</div></div>
    <label for="prompt">${t('Fråga vid inloggning')}</label><select id="prompt">
      ${[['', t('Leverantörens standard')], ['login', t('Logga in varje gång')], ['select_account', t('Välj konto')], ['consent', t('Godkänn varje gång')]].map(([v, l]) => `<option value="${v}" ${(p.prompt || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
  </div>` : `<div class="panel"><h2>LDAP</h2>
    ${inp('lurl', t('Server'), p.url, { req: true, ph: 'ldaps://ldap.example.com:636', help: t('ldaps:// (krypterat) eller ldap:// med StartTLS. Okrypterat ldap:// skickar lösenorden i klartext på nätet.') })}
    ${chk('lstls', t('StartTLS (kryptera en ldap://-anslutning)'), p.startTls)}
    ${chk('lverify', t('Kontrollera serverns certifikat'), p.tlsVerify !== false, t('Stäng bara av för att felsöka. Ett eget certifikat (egen CA) klistras in nedan i stället.'))}
    <label for="lca">${t('Egen CA (PEM, valfri)')}</label><textarea id="lca" rows="3" placeholder="-----BEGIN CERTIFICATE-----">${esc(p.ca || '')}</textarea>
    <div class="row"><div style="flex:1;min-width:200px">${inp('lbind', t('Tjänstekonto (bind DN)'), p.bindDn, { ph: 'cn=braxhn,ou=services,dc=example,dc=com', auto: 'off', help: t('Tomt = anonym sökning.') })}</div>
      <div style="flex:1;min-width:200px">${inp('lbpw', t('Tjänstekontots lösenord'), '', { type: 'password', auto: 'new-password', ph: p.hasSecret ? t('Sparad – lämna tomt för att behålla') : '' })}</div></div>
    ${p.hasSecret ? chk('cclr', t('Ta bort det sparade lösenordet'), false) : ''}
    ${inp('lbase', t('Sökbas för användare (base DN)'), p.baseDn, { req: true, ph: 'ou=people,dc=example,dc=com' })}
    ${inp('lufilter', t('Användarfilter'), p.userFilter || '(&(objectClass=person)(uid={user}))', { help: t('{user} ersätts med användarnamnet (specialtecken escapas, RFC 4515). Active Directory: (&(objectClass=user)(sAMAccountName={user})).') })}
    <div class="row"><div style="flex:1;min-width:120px">${inp('luattr', t('Attribut för användarnamn'), p.usernameAttr || 'uid')}</div>
      <div style="flex:1;min-width:120px">${inp('lmattr', t('Attribut för e-post'), p.emailAttr || 'mail')}</div>
      <div style="flex:1;min-width:120px">${inp('lnattr', t('Attribut för namn'), p.nameAttr || 'displayName')}</div></div>
    ${inp('lmemberof', t('Attribut med grupper på användaren'), p.memberOfAttr ?? 'memberOf', { help: t('memberOf i Active Directory, lldap och OpenLDAP med overlay. Tomt = använd bara gruppfiltret.') })}
    <div class="row"><div style="flex:1;min-width:200px">${inp('lgbase', t('Sökbas för grupper (valfri)'), p.groupBaseDn, { ph: 'ou=groups,dc=example,dc=com' })}</div>
      <div style="flex:1;min-width:200px">${inp('lgfilter', t('Gruppfilter (valfritt)'), p.groupFilter, { ph: '(&(objectClass=groupOfNames)(member={dn}))', help: t('{dn} = användarens DN, {user} = användarnamnet.') })}</div></div>
    <div class="row"><div style="flex:1;min-width:120px">${inp('lgattr', t('Attribut för gruppnamn'), p.groupAttr || 'cn')}</div>
      <div style="flex:1;min-width:120px">${inp('ltimeout', t('Tidsgräns (sekunder)'), p.timeout || 8, { type: 'number' })}</div></div>
  </div>`}
  <div class="panel"><h2>${t('Grupper och roller')}</h2>
    <p class="muted small">${t('Gruppnamn separerade med komma. Är alla tre tomma får alla som loggar in vara vanliga användare. Annars krävs att man är med i någon av grupperna. Ordning: administratör, barn, vanlig.')}</p>
    ${inp('gadmin', t('Administratörer'), joinList(g.admin), { ph: 'braxhn-admins' })}
    ${inp('guser', t('Vanliga användare'), joinList(g.user), { ph: 'braxhn-users' })}
    <div class="row"><div style="flex:3;min-width:200px">${inp('gkid', t('Barn'), joinList(g.kid), { ph: 'braxhn-kids' })}</div>
      <div style="flex:1;min-width:110px">${inp('kidage', t('Barnens åldersgräns'), p.kidAge ?? 11, { type: 'number' })}</div></div>
    <h3 style="font-size:.9375rem;margin:16px 0 4px">${t('Bibliotek per grupp')}</h3>
    <p class="muted small">${t('Tomt överallt = alla bibliotek. Annars får kontot biblioteken för sina grupper. Administratörer ser alltid allt.')}</p>
    ${libs.map(l => inp('lib' + l.id, t('Grupper som ser {name}', { name: esc(l.name) }), joinList(libGroups(l.id)))).join('')}
    <label for="libdef">${t('Konton utan någon av grupperna ovan')}</label><select id="libdef"><option value="all" ${p.libDefault !== 'none' ? 'selected' : ''}>${t('Ser alla bibliotek')}</option><option value="none" ${p.libDefault === 'none' ? 'selected' : ''}>${t('Ser inga bibliotek')}</option></select>
    <p class="muted small">${t('Roll och bibliotek följer grupperna vid varje inloggning för konton som inloggningen skapat. Befintliga konton som kopplats behåller sina rättigheter.')}</p>
  </div>
  <div class="panel"><h2>${t('Konton')}</h2>
    ${chk('auto', t('Skapa konto automatiskt vid första inloggningen'), p.autoCreate, t('Finns redan ett konto med samma namn eller e-post kopplas det bara om användaren anger det kontots lösenord.'))}
    <label for="emails">${t('Tillåtna e-postadresser eller domäner (valfritt)')}</label><textarea id="emails" rows="2" aria-describedby="emails-h" placeholder="anna@example.com, @example.com">${esc(joinList(p.allowEmails))}</textarea>
    ${hint('emails', t('Krävs för automatiska konton när leverantören inte skickar grupper (t.ex. Google).'))}
    ${chk('remote', t('Får titta utanför hemmet'), p.remoteAllowed !== false)}
    ${oidc ? chk('mfa', t('Leverantören sköter tvåstegsverifieringen'), p.trustMfa, t('Räknas som tvåstegsverifiering när servern kräver det utanför hemmet. Slå bara på om leverantören alltid kräver det.')) : ''}
  </div>
  <div class="row" style="margin:0 0 20px"><button class="primary">${t('Spara')}</button>
    ${isNew ? '' : `<button type="button" class="ghost" id="ptest">${t('Testa')}</button><button type="button" class="danger" id="pdel">${t('Ta bort')}</button>`}</div>
  </form>
  ${isNew ? '' : `<div class="panel" id="plinks"><h2>${t('Kopplade konton')}</h2><div id="plist"></div></div>`}`;

  $('#pf').onsubmit = act(async (e) => {
    e.preventDefault();
    const v = (id) => $('#' + id)?.value ?? '';
    const map = new Map();
    for (const l of libs) for (const gr of splitList(v('lib' + l.id))) { if (!map.has(gr)) map.set(gr, []); map.get(gr).push(l.id); }
    const body = { kind: p.kind, name: v('pname'), enabled: $('#pen').checked, autoCreate: $('#auto').checked, remoteAllowed: $('#remote').checked,
      groups: { admin: splitList(v('gadmin')), user: splitList(v('guser')), kid: splitList(v('gkid')) }, kidAge: +v('kidage'),
      libraries: [...map].map(([group, ids]) => ({ group, ids })), libDefault: v('libdef'), allowEmails: splitList(v('emails')), clearSecret: !!$('#cclr')?.checked };
    if (oidc) Object.assign(body, { issuer: v('iss'), clientId: v('cid'), clientSecret: v('csec'), redirectBase: v('rbase'), scopes: v('scopes'), groupsClaim: v('gclaim'),
      usernameClaim: v('uclaim'), prompt: v('prompt'), trustMfa: $('#mfa').checked });
    else Object.assign(body, { url: v('lurl'), startTls: $('#lstls').checked, tlsVerify: $('#lverify').checked, ca: v('lca'), bindDn: v('lbind'), bindPassword: v('lbpw'),
      baseDn: v('lbase'), userFilter: v('lufilter'), usernameAttr: v('luattr'), emailAttr: v('lmattr'), nameAttr: v('lnattr'), memberOfAttr: v('lmemberof'),
      groupBaseDn: v('lgbase'), groupFilter: v('lgfilter'), groupAttr: v('lgattr'), timeout: +v('ltimeout') });
    try {
      const r = await api(isNew ? '/sso/providers' : `/sso/providers/${p.id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast(t('Sparat'));
      if (isNew) location.hash = '#/sso/' + r.provider.id; else views.sso(String(p.id));
    } catch (er) { toastErr(er); }
  });
  if (isNew) return;
  $('#pdel').onclick = act(async () => {
    if (!await confirmDialog(t('Konton som inloggningen skapat finns kvar, men kan inte logga in förrän du ger dem ett lösenord under Användare.'), { title: t('Ta bort {name}?', { name: p.name }), okLabel: t('Ta bort'), danger: true })) return;
    await api(`/sso/providers/${p.id}`, { method: 'DELETE' });
    toast(t('Borttagen')); location.hash = '#/sso';
  });
  $('#ptest').onclick = act(async () => {
    let body = {};
    if (!oidc) {
      const f = await formDialog({ title: t('Testa LDAP'), text: t('Utan användarnamn provas bara anslutningen och tjänstekontot. Med användarnamn letas användaren och grupperna upp – med lösenord provas även inloggningen.'), okLabel: t('Testa'), fields: [
        { name: 'username', label: t('Användarnamn (valfritt)'), autocomplete: 'off' }, { name: 'password', label: t('Lösenord (valfritt)'), type: 'password', autocomplete: 'off' }] });
      if (!f) return;
      body = f;
    }
    const r = await api(`/sso/providers/${p.id}/test`, { method: 'POST', body });
    const rows = !r.ok ? `<p class="err">${esc(t(r.error || 'Fel'))}</p>`
      : oidc ? `<p class="ok-badge">${t('Leverantören svarar')}</p><table>
          <tr><th>${t('Utfärdare')}</th><td>${esc(r.issuer)}</td></tr><tr><th>${t('Inloggning')}</th><td>${esc(r.authorization)}</td></tr>
          <tr><th>Token</th><td>${esc(r.token)}</td></tr><tr><th>PKCE (S256)</th><td>${r.pkce === false ? t('Stöds inte enligt leverantören') : t('Ja')}</td></tr>
          <tr><th>${t('Signering')}</th><td>${esc(r.algs.join(', ') || t('Ingen som stöds (RS256 eller ES256 krävs)'))}</td></tr><tr><th>Redirect URI</th><td><code>${esc(r.redirectUri)}</code></td></tr></table>`
      : r.user ? `<p class="ok-badge">${t('Användaren hittades')}</p><table><tr><th>DN</th><td>${esc(r.user.dn)}</td></tr><tr><th>${t('Namn')}</th><td>${esc(r.user.username)}${r.user.displayName ? ' – ' + esc(r.user.displayName) : ''}</td></tr>
          <tr><th>${t('E-post')}</th><td>${esc(r.user.email || '–')}</td></tr><tr><th>${t('Grupper')}</th><td>${esc(r.user.groups.join(', ') || '–')}</td></tr><tr><th>${t('Roll')}</th><td>${esc(roleName(r.user.role))}</td></tr></table>`
      : body.username ? `<p class="err">${t('Användaren hittades inte (eller fel lösenord).')}</p>` : `<p class="ok-badge">${t('Anslutningen och tjänstekontot fungerar')}</p>`;
    openDialog({ title: t('Test av {name}', { name: p.name }), body: rows, size: 'wide', actions: [{ label: t('Stäng') }] });
  });
  loadLinks(p);
}
async function loadLinks(p) {
  const el = $('#plist');
  if (!el) return;
  const list = await api(`/sso/providers/${p.id}/links`).catch(e => { toastErr(e); return []; });
  if (!$('#plist')) return;
  el.innerHTML = list.length ? `<table><tr><th>${t('Konto')}</th><th>${t('Hos leverantören')}</th><th>${t('Senast inloggad')}</th><th></th></tr>
    ${list.map(l => `<tr><td>${esc(l.user)}${l.managed ? ` <span class="muted small">${t('(skapat av inloggningen)')}</span>` : ''}</td><td class="muted">${esc(l.username || l.email || '–')}</td>
      <td class="muted">${l.last_login ? fmtDate(l.last_login) : '–'}</td><td class="r"><button class="ghost small" data-unlink="${+l.user_id}">${t('Koppla bort')}</button></td></tr>`).join('')}</table>`
    : `<p class="muted">${t('Inga konton är kopplade än.')}</p>`;
  $$('[data-unlink]', el).forEach(b => b.onclick = act(async () => {
    if (!await confirmDialog(t('Kontot kan sedan inte logga in med {name} förrän det kopplas igen.', { name: p.name }), { title: t('Koppla bort kontot?'), okLabel: t('Koppla bort'), danger: true })) return;
    await api(`/sso/providers/${p.id}/links/${b.dataset.unlink}`, { method: 'DELETE' });
    loadLinks(p);
  }));
}
