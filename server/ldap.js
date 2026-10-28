// Minimal LDAP-klient (LDAPv3, RFC 4511) över node:net/node:tls – bara det som inloggning behöver:
// BindRequest (enkel inloggning), SearchRequest, StartTLS (ExtendedRequest) och UnbindRequest, med BER-kodning
// för hand. Filter skrivs som text (RFC 4515) och tolkas här till BER; värden från användaren sätts alltid in med
// escapeFilter (\2a, \28, \29, \5c, \00), så ett användarnamn som "*)(uid=*" blir ett vanligt likhetsvärde och kan
// aldrig ändra filtrets form (LDAP-injektion). Alla anrop har tidsgränser och svaren en storleksgräns.
// Används av server/sso.js; importerar inget från resten av servern.
import net from 'node:net';
import tls from 'node:tls';

// ---------- BER (X.690, bara de former LDAP använder) ----------
const lenBytes = (n) => n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : n < 0x10000 ? Buffer.from([0x82, n >> 8, n & 255])
  : Buffer.from([0x83, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
/** Tagg + längd + innehåll (delar: Buffer eller text i UTF-8) */
export function tlv(tag, ...parts) {
  const v = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8')));
  return Buffer.concat([Buffer.from([tag]), lenBytes(v.length), v]);
}
/** Icke-negativt heltal (INTEGER 0x02 eller ENUMERATED 0x0a) */
export function berInt(n, tag = 0x02) {
  const b = [];
  n = Math.max(0, Math.floor(n));
  do { b.unshift(n & 255); n = Math.floor(n / 256); } while (n > 0);
  if (b[0] & 0x80) b.unshift(0);
  return tlv(tag, Buffer.from(b));
}
export const berStr = (s) => tlv(0x04, Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8'));
const berBool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
/** Läser en TLV i buf från off. null = inte hela elementet ännu; kastar vid ogiltig längd. */
export function readTlv(buf, off = 0) {
  if (off + 2 > buf.length) return null;
  const tag = buf[off];
  let len = buf[off + 1], p = off + 2;
  if (len & 0x80) {
    const k = len & 0x7f;
    if (k === 0 || k > 4) throw new Error('Ogiltig BER-längd');
    if (p + k > buf.length) return null;
    len = 0;
    for (let i = 0; i < k; i++) len = len * 256 + buf[p++];
  }
  if (p + len > buf.length) return null;
  return { tag, value: buf.subarray(p, p + len), next: p + len };
}
/** Alla element i ett konstruerat värde */
export function berChildren(v) {
  const out = [];
  for (let o = 0; o < v.length;) {
    const t = readTlv(v, o);
    if (!t) throw new Error('Trasigt LDAP-svar');
    out.push(t); o = t.next;
  }
  return out;
}
const berToInt = (v) => { let n = 0; for (const b of v) n = n * 256 + b; return n; };

// ---------- filter (RFC 4515) ----------
/** Escapar ett värde för att sättas in i ett filter (RFC 4515 avsnitt 3) */
export const escapeFilter = (s) => String(s).replace(/[\\*()\u0000]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
/** Fyller i {namn} i en filtermall med escapade värden – okända platshållare lämnas orörda (och ger fel vid tolkningen) */
export const fillFilter = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => k in vars ? escapeFilter(vars[k]) : m);

const ATTR = /^[A-Za-z][A-Za-z0-9-]*(;[A-Za-z0-9-]+)*$|^\d+(\.\d+)*$/;
/** Tolkar ett filter i textform till BER. Kastar Error med begriplig text vid fel. */
export function parseFilter(s) {
  s = String(s || '').trim();
  let i = 0;
  const bad = (why) => { throw new Error(`Ogiltigt LDAP-filter (${why})`); };
  // Ett värde: \XX ger en byte, *, ( och ) får inte stå oescapade (* hanteras av anroparen för delsträngar)
  const value = (raw) => {
    const out = [];
    for (let k = 0; k < raw.length; k++) {
      const c = raw[k];
      if (c === '\\') {
        const h = raw.slice(k + 1, k + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) bad('felaktig escape');
        out.push(parseInt(h, 16)); k += 2;
      } else if (c === '(' || c === ')' || c === '\u0000') bad('oescapat tecken');
      else out.push(...Buffer.from(c, 'utf8'));
    }
    return Buffer.from(out);
  };
  const item = (body) => {
    const m = /^([^=~<>()]+?)(~=|>=|<=|=)([\s\S]*)$/.exec(body);
    if (!m) bad('saknar =');
    const [, attr, op, raw] = m;
    if (attr.includes(':')) bad('utökad matchning stöds inte');
    if (!ATTR.test(attr)) bad('ogiltigt attribut');
    if (op === '=' && raw === '*') return tlv(0x87, attr);
    if (op === '=' && raw.includes('*')) {
      const parts = raw.split('*');
      const subs = [];
      parts.forEach((p, k) => {
        if (!p) return;
        subs.push(tlv(k === 0 ? 0x80 : k === parts.length - 1 ? 0x82 : 0x81, value(p)));
      });
      return tlv(0xa4, berStr(attr), tlv(0x30, ...subs));
    }
    const tag = { '=': 0xa3, '>=': 0xa5, '<=': 0xa6, '~=': 0xa8 }[op];
    return tlv(tag, berStr(attr), berStr(value(raw)));
  };
  const filter = (depth) => {
    if (depth > 20) bad('för djupt');
    if (s[i] !== '(') bad('saknar (');
    i++;
    const c = s[i];
    let out;
    if (c === '&' || c === '|') {
      i++;
      const list = [];
      while (s[i] === '(') list.push(filter(depth + 1));
      if (!list.length) bad('tom lista');
      out = tlv(c === '&' ? 0xa0 : 0xa1, ...list);
    } else if (c === '!') {
      i++; out = tlv(0xa2, filter(depth + 1));
    } else {
      // Värdet slutar vid första oescapade ) – \29 är ett escapat tecken och avslutar inte
      let j = i;
      while (j < s.length && s[j] !== ')') { if (s[j] === '(') bad('oescapat tecken'); j += s[j] === '\\' ? 3 : 1; }
      if (j >= s.length) bad('saknar )');
      out = item(s.slice(i, j));
      i = j;
    }
    if (s[i] !== ')') bad('saknar )');
    i++;
    return out;
  };
  const f = filter(0);
  if (i !== s.length) bad('text efter filtret');
  return f;
}

// ---------- anslutning ----------
const OP = { bindReq: 0x60, bindRes: 0x61, unbind: 0x42, searchReq: 0x63, entry: 0x64, done: 0x65, ref: 0x73, extReq: 0x77, extRes: 0x78 };
const MAX_BUF = 4 * 1024 * 1024;
export const CODES = { 0: 'success', 4: 'sizeLimitExceeded', 32: 'noSuchObject', 34: 'invalidDNSyntax', 49: 'invalidCredentials', 50: 'insufficientAccessRights', 53: 'unwillingToPerform' };
const err = (msg, code) => Object.assign(new Error(msg), { ldap: code || 'net' });

/** Adressen ldap://värd:port eller ldaps://värd:port */
export function parseUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { throw err('Ogiltig LDAP-adress', 'config'); }
  if (!['ldap:', 'ldaps:'].includes(url.protocol)) throw err('LDAP-adressen ska börja med ldap:// eller ldaps://', 'config');
  if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search) throw err('Ange bara värd och port i LDAP-adressen', 'config');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw err('Ogiltig LDAP-adress', 'config');
  return { host, port: +url.port || (url.protocol === 'ldaps:' ? 636 : 389), secure: url.protocol === 'ldaps:' };
}

class Conn {
  constructor(sock, timeout) {
    this.sock = sock; this.timeout = timeout; this.id = 0; this.buf = Buffer.alloc(0); this.wait = new Map(); this.dead = null;
    this.attach(sock);
  }
  attach(sock) {
    this.sock = sock;
    this.onData = (d) => this.data(d);
    this.onEnd = () => this.fail(err('LDAP-servern stängde anslutningen'));
    this.onErr = (e) => this.fail(err(e.code === 'ECONNREFUSED' ? 'LDAP-servern svarar inte' : /certificate|self[- ]signed|CERT_/i.test(e.message + (e.code || '')) ? 'LDAP-serverns certifikat godtas inte' : 'LDAP-anslutningen misslyckades: ' + (e.code || e.message)));
    sock.on('data', this.onData); sock.on('end', this.onEnd); sock.on('close', this.onEnd); sock.on('error', this.onErr);
  }
  detach() { const s = this.sock; s.off('data', this.onData); s.off('end', this.onEnd); s.off('close', this.onEnd); s.off('error', this.onErr); }
  fail(e) {
    if (this.dead) return;
    this.dead = e;
    for (const w of this.wait.values()) { clearTimeout(w.timer); w.reject(e); }
    this.wait.clear();
    try { this.sock.destroy(); } catch {}
  }
  data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > MAX_BUF) return this.fail(err('För stort svar från LDAP-servern'));
    try {
      for (;;) {
        const m = readTlv(this.buf, 0);
        if (!m) break;
        this.buf = this.buf.subarray(m.next);
        if (m.tag !== 0x30) throw new Error('Oväntat svar från LDAP-servern');
        const [id, op] = berChildren(m.value);
        if (!id || id.tag !== 0x02 || !op) throw new Error('Oväntat svar från LDAP-servern');
        const w = this.wait.get(berToInt(id.value));
        if (!w) continue; // t.ex. Notice of Disconnection (id 0)
        w.got(op);
      }
    } catch (e) { this.fail(err(e.message)); }
  }
  /** Skickar en operation och samlar svaren tills det avslutande (bind/sök klar/utökat) */
  request(op) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const entries = [];
      const w = {
        reject,
        timer: setTimeout(() => { this.wait.delete(id); reject(err('LDAP-servern svarade inte i tid')); this.fail(err('Tidsgränsen överskreds')); }, this.timeout),
        got: (o) => {
          if (o.tag === OP.entry) { if (entries.length < 1000) entries.push(o); return; }
          if (o.tag === OP.ref) return;
          clearTimeout(w.timer); this.wait.delete(id);
          const [code, matched, diag] = berChildren(o.value);
          resolve({ tag: o.tag, code: code ? berToInt(code.value) : -1, diag: diag ? diag.value.toString('utf8').slice(0, 200) : '', entries, op: o, matched });
        }
      };
      this.wait.set(id, w);
      this.sock.write(tlv(0x30, berInt(id), op));
    });
  }
  bind(dn, password) { return this.request(tlv(OP.bindReq, berInt(3), berStr(dn), tlv(0x80, Buffer.from(String(password), 'utf8')))); }
  async search(base, filter, attrs, { sizeLimit = 0, timeLimit = 10 } = {}) {
    const r = await this.request(tlv(OP.searchReq, berStr(base), berInt(2, 0x0a), berInt(0, 0x0a), berInt(sizeLimit), berInt(timeLimit), berBool(false),
      parseFilter(filter), tlv(0x30, ...attrs.map(berStr))));
    if (r.code !== 0 && !(r.code === 4 && r.entries.length)) throw err(r.code === 32 ? 'Sökbasen finns inte i katalogen' : r.code === 50 ? 'Tjänstekontot får inte söka i katalogen' : `LDAP-sökningen misslyckades (kod ${r.code})`, r.code === 32 || r.code === 50 ? 'config' : 'search');
    return r.entries.map(parseEntry);
  }
  async startTls(opts) {
    const r = await this.request(tlv(OP.extReq, tlv(0x80, '1.3.6.1.4.1.1466.20037')));
    if (r.code !== 0) throw err('LDAP-servern stöder inte StartTLS', 'config');
    this.detach();
    const raw = this.sock;
    const s = await new Promise((ok, no) => {
      const t = tls.connect({ ...opts, socket: raw });
      const timer = setTimeout(() => { t.destroy(); no(err('TLS-förhandlingen tog för lång tid')); }, this.timeout);
      t.once('secureConnect', () => { clearTimeout(timer); ok(t); });
      t.once('error', (e) => { clearTimeout(timer); no(err(/certificate|self[- ]signed|CERT_|altnames/i.test(e.message + (e.code || '')) ? 'LDAP-serverns certifikat godtas inte' : 'TLS misslyckades: ' + (e.code || e.message))); });
    });
    this.attach(s);
  }
  close() {
    if (this.dead) return;
    try { this.sock.write(tlv(0x30, berInt(++this.id), Buffer.from([OP.unbind, 0]))); } catch {}
    this.dead = err('stängd');
    for (const w of this.wait.values()) clearTimeout(w.timer);
    this.wait.clear();
    try { this.sock.end(); setTimeout(() => this.sock.destroy(), 200).unref(); } catch {}
  }
}
function parseEntry(o) {
  const [dn, attrs] = berChildren(o.value);
  const out = { dn: dn.value.toString('utf8'), attrs: {} };
  for (const a of attrs ? berChildren(attrs.value) : []) {
    const [type, vals] = berChildren(a.value);
    out.attrs[type.value.toString('utf8').toLowerCase()] = vals ? berChildren(vals.value).map(v => Buffer.from(v.value)) : [];
  }
  return out;
}

/** TLS-alternativ: kontrollera certifikatet (standard) och ev. en egen CA (PEM) */
function tlsOpts(cfg, host) {
  const o = { host, rejectUnauthorized: cfg.tlsVerify !== false, minVersion: 'TLSv1.2' };
  if (!net.isIP(host)) o.servername = host;
  if (cfg.ca && /BEGIN CERTIFICATE/.test(cfg.ca)) o.ca = cfg.ca;
  return o;
}
/** Öppnar en anslutning (ldaps:// direkt med TLS, annars TCP och ev. StartTLS) */
export async function connect(cfg) {
  const { host, port, secure } = parseUrl(cfg.url);
  const timeout = Math.max(1, Math.min(60, +cfg.timeout || 8)) * 1000;
  const sock = await new Promise((ok, no) => {
    const s = secure ? tls.connect({ ...tlsOpts(cfg, host), port }) : net.connect({ host, port });
    const timer = setTimeout(() => { s.destroy(); no(err('LDAP-servern svarade inte i tid')); }, timeout);
    s.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); ok(s); });
    s.once('error', (e) => { clearTimeout(timer); no(err(e.code === 'ECONNREFUSED' ? 'LDAP-servern svarar inte' : e.code === 'ENOTFOUND' ? 'LDAP-servern hittades inte' : /certificate|self[- ]signed|CERT_|altnames/i.test(e.message + (e.code || '')) ? 'LDAP-serverns certifikat godtas inte' : 'LDAP-anslutningen misslyckades: ' + (e.code || e.message))); });
  });
  sock.setNoDelay?.(true);
  const c = new Conn(sock, timeout);
  try { if (!secure && cfg.startTls) await c.startTls(tlsOpts(cfg, host)); }
  catch (e) { c.fail(e); throw e; }
  return c;
}

const first = (e, a) => a && e.attrs[String(a).toLowerCase()]?.[0];
const text = (b) => b ? b.toString('utf8') : null;
/** Gruppnamnet ur en DN (cn=Admins,ou=groups,… → Admins) */
export const cnOf = (dn) => { const m = /^\s*(?:cn|ou)=((?:\\.|[^,+])*)/i.exec(String(dn)); return m ? m[1].replace(/\\([0-9a-fA-F]{2}|.)/g, (x, y) => y.length === 2 ? String.fromCharCode(parseInt(y, 16)) : y).trim() : null; };

/**
 * Loggar in en användare: (tjänstekontot binder) → söker användaren med userFilter → binder som användaren med lösenordet
 * → läser grupper (memberOf och/eller gruppfiltret). Returnerar null vid fel namn/lösenord (också okänd eller tvetydig
 * användare), annars { subject, dn, username, email, displayName, groups }. Kastar Error med e.ldap vid fel på servern.
 * withPassword = false (administratörens test): letar bara upp användaren och grupperna.
 */
export async function authenticate(cfg, username, password, { withPassword = true } = {}) {
  username = String(username ?? '');
  // Tomt lösenord = "unauthenticated bind" som många servrar godkänner – får aldrig räknas som inloggning
  if (withPassword && !String(password ?? '')) return null;
  if (!username || username.length > 128 || /[\u0000-\u001f\u007f]/.test(username)) return null;
  if (!cfg.baseDn) throw err('Sökbas saknas i LDAP-inställningarna', 'config');
  const c = await connect(cfg);
  try {
    const service = async () => {
      if (!cfg.bindDn) return;
      const r = await c.bind(cfg.bindDn, cfg.bindPassword || '');
      if (r.code !== 0) throw err('Tjänstekontot kunde inte logga in mot LDAP-servern', 'config');
    };
    await service();
    const uAttr = cfg.usernameAttr || 'uid', mAttr = cfg.emailAttr || 'mail', nAttr = cfg.nameAttr || 'displayName', moAttr = cfg.memberOfAttr ?? 'memberOf';
    const attrs = [...new Set([uAttr, mAttr, nAttr, 'cn', 'entryUUID', 'objectGUID', moAttr].filter(Boolean))];
    const filter = fillFilter(cfg.userFilter || '(&(objectClass=person)(uid={user}))', { user: username });
    const found = await c.search(cfg.baseDn, filter, attrs, { sizeLimit: 2, timeLimit: Math.ceil(c.timeout / 1000) });
    if (found.length !== 1) return null; // okänd eller tvetydig – samma svar som fel lösenord
    const e = found[0];
    if (withPassword) {
      const r = await c.bind(e.dn, password);
      if (r.code === 49 || r.code === 53) return null;
      if (r.code !== 0) throw err(`LDAP-inloggningen misslyckades (kod ${r.code})`, 'bind');
    }
    const groups = new Set();
    for (const g of (moAttr && e.attrs[moAttr.toLowerCase()]) || []) { const dn = text(g); groups.add(dn); const cn = cnOf(dn); if (cn) groups.add(cn); }
    if (cfg.groupFilter && (cfg.groupBaseDn || cfg.baseDn)) {
      // Grupperna söks som tjänstekontot (användaren får ofta inte läsa grupperna)
      if (withPassword) await service();
      const gAttr = cfg.groupAttr || 'cn';
      const gf = fillFilter(cfg.groupFilter, { dn: e.dn, user: username });
      for (const g of await c.search(cfg.groupBaseDn || cfg.baseDn, gf, [gAttr], { sizeLimit: 500, timeLimit: Math.ceil(c.timeout / 1000) })) {
        const n = text(first(g, gAttr)); if (n) groups.add(n);
        groups.add(g.dn);
      }
    }
    const uuid = first(e, 'entryUUID'), guid = first(e, 'objectGUID');
    return {
      subject: uuid ? 'uuid:' + text(uuid).toLowerCase() : guid ? 'guid:' + guid.toString('hex') : 'dn:' + e.dn.toLowerCase(),
      dn: e.dn, username: text(first(e, uAttr)) || username, email: text(first(e, mAttr)), displayName: text(first(e, nAttr)) || text(first(e, 'cn')),
      groups: [...groups].filter(Boolean).slice(0, 500)
    };
  } finally { c.close(); }
}
