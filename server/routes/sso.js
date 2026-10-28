// Enkel inloggning (server/sso.js, oidc.js, ldap.js): "Logga in med …" (OIDC), bekräftad koppling till befintliga
// konton, kopplingar under Mitt konto och administratörens inställningar (betrott nät). LDAP-inloggningen går via
// det vanliga lösenordsformuläret (/api/login i routes/auth.js).
//
// OIDC-flödet: GET /api/sso/oidc/:id/start sätter kakan bxsso (slumpad, HttpOnly, 10 min) och skickar webbläsaren till
// leverantören med state, nonce och PKCE (S256). Leverantören skickar tillbaka till den vitlistade redirect-URI:n
// (/api/sso/oidc/:id/callback på adressen administratören angett); state är engångs och bundet till kakan – en kod
// som någon annan fått (inloggnings-CSRF) godtas inte i en annan webbläsare. Resultatet blir en kaka för webben och en
// omdirigering till #/login/done, #/login/link/<biljett> (bekräfta koppling) eller #/login/sso/<felkod>.
import crypto from 'node:crypto';
import { get, run, getSetting } from '../db.js';
import { send, fail, readJson, clientIp, isHttps, isPrivate, cookies, clean } from '../util.js';
import { audit, cookieHeader, createSession, hashPw, checkPw, ipBlocked, noteFail, clearFails, require2faRemote, verifyTotp, useRecoveryCode, ipKey } from '../auth.js';
import * as sso from '../sso.js';
import * as oidc from '../oidc.js';
import { route, pub, user, admin, isTrusted, has2fa } from '../http/router.js';
import { ctx } from '../http/context.js';

const randomPass = () => hashPw(crypto.randomBytes(24).toString('hex')); // konton från leverantören har inget användbart lösenord
const hostOf = (req) => String((isPrivate(req.socket.remoteAddress) && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
const redirect = (c, to, headers = {}) => send(c.res, 302, '', { Location: to, ...headers });
const CLEAR = 'bxsso=; Path=/api/sso/; Max-Age=0; HttpOnly; SameSite=Lax';
const TOO_MANY = 'För många försök – vänta en stund och försök igen';

/** Varför kontot inte får logga in från förfrågans nät (samma regler som /api/login och routern), annars null */
function remoteWhy(req, u) {
  if (isTrusted(req)) return null;
  if (!u.remote_allowed) return { code: 'remote', msg: 'Ditt konto får bara användas på hemnätverket' };
  if (require2faRemote() && !has2fa(u)) return { code: '2fa', msg: 'Tvåstegsverifiering krävs för inloggning utanför hemmet. Aktivera den under Mitt konto från hemnätet.' };
  return null;
}
/** Skapar sessionen. Returnerar { headers, body } eller { deny } */
function session(c, uid, { remember = true, app = false, via }) {
  const ip = clientIp(c.req);
  const u = get('SELECT * FROM users WHERE id=?', uid);
  if (!u || u.parent_id) return { deny: { code: 'noaccount', msg: 'Kontot finns inte' } };
  const why = remoteWhy(c.req, u);
  if (why) { audit('login_denied', { ip, user: u, detail: `${via}: ${why.msg}` }); return { deny: why }; }
  clearFails(u.name);
  audit('login_ok', { ip, user: u, detail: `${app ? 'app' : 'webb'}, ${via}` });
  const meta = { ua: c.req.headers['user-agent'], ip };
  if (app) return { body: { ok: true, token: createSession(u.id, 'app', meta), user: { id: u.id, name: u.name, is_admin: u.is_admin } } };
  return { body: { ok: true }, headers: { 'Set-Cookie': cookieHeader(createSession(u.id, 'web', { ...meta, remember }), isHttps(c.req), remember) } };
}

// ---------- inloggningssidan ----------
route('GET', '/api/sso/providers', pub, (c) => {
  const list = sso.providers({ enabled: true });
  send(c.res, 200, { providers: list.filter(p => p.kind === 'oidc' && p.redirectBase).map(p => ({ id: p.id, name: p.name, kind: p.kind })),
    ldap: list.filter(p => p.kind === 'ldap').map(p => p.name), localLogin: sso.localLogin() });
});

const startRate = new Map(); // ip → antal starter senaste minuten
setInterval(() => startRate.clear(), 60e3).unref();
route('GET', '/api/sso/oidc/:id/start', pub, async (c) => {
  const ip = clientIp(c.req), k = ipKey(ip);
  const p = sso.provider(c.p.id);
  if (!p || p.kind !== 'oidc' || !p.enabled || !p.redirectBase) return redirect(c, '/#/login/sso/disabled');
  const base = new URL(p.redirectBase);
  // Webbläsaren ska vara på samma adress som återkomsten, annars skickas inte kakan med tillbaka
  if (hostOf(c.req).toLowerCase() !== base.host.toLowerCase()) return redirect(c, `${base.origin}/api/sso/oidc/${p.id}/start?${new URLSearchParams({ remember: c.q.get('remember') === '0' ? '0' : '1' })}`);
  if (!startRate.has(k) && startRate.size >= 10000) startRate.clear();
  const n = (startRate.get(k) || 0) + 1; startRate.set(k, n);
  if (n > 30 || ipBlocked(ip)) return redirect(c, '/#/login/sso/blocked');
  // Koppla till det inloggade kontot (Mitt konto): bara med webbens kaka och på huvudkontot
  const link = c.q.get('link') === '1';
  if (link && (!c.user || c.user.kind !== 'web' || c.user.parent_id)) return redirect(c, '/#/login/sso/state');
  let doc;
  try { doc = await oidc.discover(p.issuer); }
  catch (e) { audit('sso_error', { ip, detail: `${p.name}: ${e.message}` }); return redirect(c, '/#/login/sso/provider'); }
  const nonce = oidc.randomToken(), verifier = oidc.randomToken(48), bind = crypto.randomBytes(32).toString('hex');
  const state = sso.newState({ pid: p.id, nonce, verifier, bind: sso.bindHash(bind), linkUid: link ? c.user.id : null, remember: c.q.get('remember') !== '0' });
  redirect(c, oidc.authUrl(doc, { clientId: p.clientId, redirectUri: sso.redirectUri(p), scopes: p.scopes, state, nonce, verifier, prompt: p.prompt || (link ? 'login' : '') }),
    { 'Set-Cookie': `bxsso=${bind}; Path=/api/sso/; HttpOnly; SameSite=Lax; Max-Age=600${isHttps(c.req) ? '; Secure' : ''}` });
});

route('GET', '/api/sso/oidc/:id/callback', pub, async (c) => {
  const ip = clientIp(c.req);
  const back = (code) => redirect(c, '/#/login/sso/' + code, { 'Set-Cookie': CLEAR });
  if (ipBlocked(ip)) return back('blocked');
  const st = sso.takeState(c.q.get('state'));
  const bind = cookies(c.req).bxsso;
  if (!st || st.pid !== +c.p.id || !bind || !/^[a-f0-9]{64}$/.test(bind) || sso.bindHash(bind) !== st.bind) {
    audit('login_fail', { ip, detail: 'enkel inloggning: ogiltig eller utgången inloggning (state)' });
    return back('state');
  }
  const p = sso.provider(st.pid);
  if (!p?.enabled) return back('disabled');
  const err = c.q.get('error');
  if (err) { audit('login_fail', { ip, detail: `${p.name}: leverantören avbröt (${clean(err, 40).replace(/[^\w.-]/g, '')})` }); return back('denied'); }
  const code = c.q.get('code');
  if (!code || code.length > 4096) return back('state');
  let claims;
  try { claims = await oidc.exchange({ issuer: p.issuer, clientId: p.clientId, clientSecret: p.clientSecret, redirectUri: sso.redirectUri(p), groupsClaim: p.groupsClaim }, { code, verifier: st.verifier, nonce: st.nonce }); }
  catch (e) {
    if (e.oidc === 'token') noteFail(ip);
    audit(e.oidc === 'token' ? 'login_fail' : 'sso_error', { ip, detail: `${p.name}: ${e.oidc ? e.message : 'internt fel'}` });
    if (!e.oidc) console.error(e);
    return back(e.oidc === 'token' ? 'token' : 'provider');
  }
  const uname = oidc.claimAt(claims, p.usernameClaim);
  const id = { subject: claims.sub, username: typeof uname === 'string' ? uname : claims.preferred_username, email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: claims.email_verified === false || claims.email_verified === 'false' ? false : claims.email_verified == null ? null : true,
    displayName: typeof claims.name === 'string' ? claims.name : null, groups: oidc.groupsOf(claims, p.groupsClaim) };
  // Koppling från Mitt konto: samma webbläsare måste fortfarande vara inloggad på kontot som startade kopplingen
  if (st.linkUid && c.user?.id !== st.linkUid) return back('state');
  const r = await sso.resolve(p, id, { hashPw: randomPass, linkUid: st.linkUid, remember: st.remember });
  if (r.deny) { audit('login_denied', { ip, user: { name: clean(id.username || id.email || id.subject, 64) }, detail: `${p.name}: ${r.deny}` }); return back(r.code); }
  if (r.ticket) { audit('sso_link_pending', { ip, user: { name: r.account }, detail: p.name }); return redirect(c, '/#/login/link/' + r.ticket, { 'Set-Cookie': CLEAR }); }
  if (r.linked) { audit('sso_linked', { ip, user: c.user, detail: p.name }); return redirect(c, '/#/account', { 'Set-Cookie': CLEAR }); }
  if (r.created) audit('sso_user_created', { ip, user: get('SELECT id, name FROM users WHERE id=?', r.uid), detail: p.name });
  const s = session(c, r.uid, { remember: st.remember, via: p.name });
  if (s.deny) return back(s.deny.code);
  redirect(c, '/#/login/done', { 'Set-Cookie': [CLEAR, s.headers['Set-Cookie']] });
});

// ---------- bekräfta koppling till ett befintligt konto ----------
route('GET', '/api/sso/link/:ticket', pub, (c) => {
  const r = sso.ticket(c.p.ticket);
  if (!r) return fail(c.res, 404, 'Länken har gått ut – logga in igen');
  const p = sso.provider(r.pid), u = get('SELECT name, totp_enabled FROM users WHERE id=?', r.uid);
  if (!p || !u) return fail(c.res, 404, 'Länken har gått ut – logga in igen');
  send(c.res, 200, { provider: p.name, account: u.name, canCreate: !!p.autoCreate, need2fa: !!u.totp_enabled, expires: r.expires });
});
route('POST', '/api/sso/link/:ticket', pub, async (c) => {
  const ip = clientIp(c.req);
  if (ipBlocked(ip)) return fail(c.res, 429, TOO_MANY);
  const t = c.p.ticket, r = sso.ticket(t);
  if (!r) return fail(c.res, 404, 'Länken har gått ut – logga in igen');
  const p = sso.provider(r.pid);
  if (!p?.enabled) return fail(c.res, 404, 'Länken har gått ut – logga in igen');
  const b = await readJson(c.req);
  let uid;
  if (b.create === true) {
    const res = await sso.createFromTicket(t, randomPass);
    if (!res) return fail(c.res, 404, 'Länken har gått ut – logga in igen');
    if (res.deny) return fail(c.res, 403, res.deny);
    uid = res.uid;
    audit('sso_user_created', { ip, user: get('SELECT id, name FROM users WHERE id=?', uid), detail: p.name });
  } else {
    const u = get('SELECT * FROM users WHERE id=?', r.uid);
    if (!u) return fail(c.res, 404, 'Länken har gått ut – logga in igen');
    if (!await checkPw(String(b.password || ''), u.pass)) {
      noteFail(ip, u.name); sso.ticketFail(t);
      audit('login_fail', { ip, user: u, detail: `koppling till ${p.name}: fel lösenord` });
      return fail(c.res, 401, 'Fel lösenord');
    }
    if (u.totp_enabled) {
      if (!b.code) return send(c.res, 401, { error: 'Ange koden från din autentiseringsapp', need2fa: true });
      const fresh = get('SELECT totp_secret, totp_last, recovery FROM users WHERE id=?', u.id);
      const step = verifyTotp(fresh.totp_secret, b.code, fresh.totp_last);
      if (step > 0) run('UPDATE users SET totp_last=? WHERE id=?', step, u.id);
      else if (!useRecoveryCode({ ...u, ...fresh }, b.code)) { noteFail(ip, u.name); sso.ticketFail(t); return send(c.res, 401, { error: 'Fel kod', need2fa: true }); }
    }
    if (!sso.ticket(t)) return fail(c.res, 404, 'Länken har gått ut – logga in igen'); // två samtidiga bekräftelser
    uid = sso.confirmTicket(t);
    audit('sso_linked', { ip, user: u, detail: p.name });
  }
  const s = session(c, uid, { remember: r.remember, app: r.app, via: p.name });
  if (s.deny) return fail(c.res, 403, s.deny.msg);
  send(c.res, 200, s.body, s.headers || {});
});

// ---------- Mitt konto ----------
route('GET', '/api/me/sso', user, (c) => {
  const mine = new Map(sso.linksOfUser(c.user.id).map(l => [l.provider_id, l]));
  send(c.res, 200, { providers: sso.providers({ enabled: true }).filter(p => p.kind === 'ldap' ? mine.has(p.id) : !!p.redirectBase)
    .map(p => ({ id: p.id, name: p.name, kind: p.kind, linked: mine.has(p.id), managed: !!mine.get(p.id)?.managed, lastLogin: mine.get(p.id)?.last_login || null })),
    profile: !!c.user.parent_id });
});
route('DELETE', '/api/me/sso/:pid', user, (c) => {
  const l = sso.linksOfUser(c.user.id).find(x => x.provider_id === +c.p.pid);
  if (!l) return fail(c.res, 404, 'Finns inte');
  // Ett konto som leverantören skapat har inget eget lösenord – utan kopplingen går det inte att logga in
  if (l.managed) return fail(c.res, 400, 'Kontot skapades av inloggningen och kan inte kopplas bort – be administratören');
  sso.unlink(l.provider_id, c.user.id);
  audit('sso_unlinked', { ...ctx(c), detail: l.name });
  send(c.res, 200, { ok: true });
});

// ---------- administration (betrott nät) ----------
function suggestedBase(c) {
  const pub = getSetting('public_url', process.env.PUBLIC_URL || '');
  try { if (pub) return new URL(pub).origin; } catch {}
  const h = hostOf(c.req);
  return h ? `${isHttps(c.req) ? 'https' : 'http'}://${h}` : '';
}
route('GET', '/api/sso', admin, (c) => send(c.res, 200, { providers: sso.providers().map(sso.publicOut), localLogin: sso.localLogin(), suggestedBase: suggestedBase(c),
  skew: oidc.SKEW() }));
route('PUT', '/api/sso/settings', admin, async (c) => {
  const b = await readJson(c.req);
  if (b.localLogin !== undefined) {
    if (!['all', 'admin'].includes(b.localLogin)) return fail(c.res, 400, 'Ogiltigt val');
    sso.setLocalLogin(b.localLogin);
  }
  audit('settings_changed', { ...ctx(c), detail: `enkel inloggning: lösenord för ${sso.localLogin() === 'admin' ? 'bara administratörer' : 'alla'}` });
  send(c.res, 200, { ok: true, localLogin: sso.localLogin() });
});
route('POST', '/api/sso/providers', admin, async (c) => {
  const b = await readJson(c.req, 64 * 1024);
  const id = sso.save(null, b, { base: suggestedBase(c) });
  audit('settings_changed', { ...ctx(c), detail: `enkel inloggning: ${sso.provider(id).name} tillagd` });
  send(c.res, 200, { ok: true, provider: sso.publicOut(sso.provider(id)) });
});
route('PUT', '/api/sso/providers/:id', admin, async (c) => {
  const b = await readJson(c.req, 64 * 1024);
  sso.save(+c.p.id, b, { base: suggestedBase(c) });
  oidc.clearCaches();
  audit('settings_changed', { ...ctx(c), detail: `enkel inloggning: ${sso.provider(+c.p.id).name} ändrad` });
  send(c.res, 200, { ok: true, provider: sso.publicOut(sso.provider(+c.p.id)) });
});
route('DELETE', '/api/sso/providers/:id', admin, (c) => {
  const p = sso.provider(c.p.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  // Konton som leverantören skapat finns kvar men kan inte logga in förrän administratören ger dem ett lösenord
  sso.remove(p.id);
  audit('settings_changed', { ...ctx(c), detail: `enkel inloggning: ${p.name} borttagen` });
  send(c.res, 200, { ok: true });
});
route('POST', '/api/sso/providers/:id/test', admin, async (c) => {
  const p = sso.provider(c.p.id);
  if (!p) return fail(c.res, 404, 'Finns inte');
  const b = await readJson(c.req);
  try {
    if (p.kind === 'oidc') {
      const d = await oidc.discover(p.issuer, { fresh: true });
      return send(c.res, 200, { ok: true, issuer: d.issuer, authorization: d.authorization_endpoint, token: d.token_endpoint, userinfo: d.userinfo_endpoint,
        pkce: d.pkce, algs: d.algs.filter(a => ['RS256', 'ES256'].includes(a)), redirectUri: sso.redirectUri(p) });
    }
    send(c.res, 200, await sso.ldapTest(p, String(b.username || '').slice(0, 128), b.password ? String(b.password) : ''));
  } catch (e) {
    if (!e.oidc && !e.ldap) { console.error(e); return fail(c.res, 500, 'Internt fel'); }
    send(c.res, 200, { ok: false, error: e.message });
  }
});
route('GET', '/api/sso/providers/:id/links', admin, (c) => {
  if (!sso.provider(c.p.id)) return fail(c.res, 404, 'Finns inte');
  send(c.res, 200, sso.linksOfProvider(+c.p.id));
});
route('DELETE', '/api/sso/providers/:id/links/:uid', admin, (c) => {
  const p = sso.provider(c.p.id);
  if (!p || !sso.unlink(p.id, +c.p.uid)) return fail(c.res, 404, 'Finns inte');
  audit('sso_unlinked', { ...ctx(c), detail: `${p.name}: konto ${+c.p.uid}` });
  send(c.res, 200, { ok: true });
});
