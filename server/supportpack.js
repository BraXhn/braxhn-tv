// Diagnostikpaketets rena delar (inga databas- eller nätberoenden, testas i test/diagnostics.test.js):
//   maskSupport() – tar bort det som inte ska följa med när en användare skickar paketet till supporten: token,
//                   nycklar, lösenord, kakor, e-postadresser, IP-adresser och (om användaren inte valt annat)
//                   fil- och mappnamn under mediamapparna. Bygger på logs.mask() och lägger till mer.
//   tarGz()       – ett vanligt tar-arkiv (ustar) packat med node:zlib – inga npm-beroenden (testat mot systemets
//                   tar; 7-Zip och Windows 11 läser också formatet).
import zlib from 'node:zlib';
import { mask } from './logs.js';

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?![\\w.]*\\w)`, 'g');
// IPv6: minst tre grupper med kolon. Klockslag (12:34:56) och tidskoder har bara siffror och färre grupper – en
// adress måste ha "::" eller minst fyra grupper med någon bokstav a–f.
const IPV6 = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%\w+)?(?![\w:])/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Privat (hemnät), loopback eller annat – för att supporten ska se vilken sorts adress det var */
function ipKind(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 127 || ip === '0.0.0.0') return null; // loopback och "alla gränssnitt" säger inget om användaren
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return '<lan-ip>';
  if (a === 100 && b >= 64 && b <= 127) return '<vpn-ip>';
  if (a === 169 && b === 254) return '<link-local-ip>';
  return '<ip>';
}

/**
 * Maskerar text för diagnostikpaketet.
 * @param {string} text
 * @param {{ names?: boolean, roots?: string[], words?: [string, string][] }} [o] names: behåll fil- och mappnamn;
 *   roots: mediamapparna (bibliotekens mappar och MEDIA_ROOT) – utan names blir allt under dem "<rot>/…";
 *   words: [namn, ersättning] som byts ut utan names (bibliotekens namn – ofta samma som mappen)
 */
export function maskSupport(text, { names = false, roots = [], words = [] } = {}) {
  let s = mask(String(text ?? ''));
  s = s
    // Token och lösenord i adresser (?t=, Subsonic u/t/s/p, kakan kt) och rubriker
    .replace(/([?&;](?:t|kt|u|p|s|pw|token|access_token|refresh_token|code|state|nonce|api_key|apikey|key|x-plex-token|sig)=)[^&\s"'<>]+/gi, '$1***')
    .replace(/\b(Bearer|Basic|Digest|MediaBrowser|Token)\s+(?!\*\*\*)[^\s"',;]+/g, '$1 ***')
    .replace(/\b(cookie|set-cookie|authorization|x-api-key|x-emby-token|x-mediabrowser-token)(["']?\s*[:=]\s*)[^\n]+/gi, '$1$2***')
    .replace(/\b(lösenord|lösenfras|passphrase|password|passwd|pwd|secret|hemlighet|pin|totp|otp|kt)(["']?\s*[=:]\s*["']?)(?!\*\*\*)[^\s"'&,;]+/gi, '$1$2***')
    // Långa slumpsträngar (sessioner, mediatoken, API-nycklar) som inte står efter ett nyckelord
    .replace(/\b[a-f0-9]{24,}\b/gi, '***')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '***')
    .replace(EMAIL, '***@***')
    .replace(IPV4, (ip) => ipKind(ip) || ip)
    .replace(IPV6, (m) => (m === '::1' || m === '::' || !(m.includes('::') || (m.split(':').length >= 5 && /[a-f]/i.test(m)))) ? m : '<ipv6>');
  if (!names) {
    // Fil- och mappnamn under mediamapparna (längsta roten först, så att /media/Filmer går före /media)
    const rs = [...new Set(roots.filter(r => r && r.length > 1).map(r => r.replace(/\/+$/, '')))].sort((a, b) => b.length - a.length);
    // En gemensam regex: alternativen prövas i ordning, så den längsta roten vinner och inget maskeras två gånger
    if (rs.length) s = s.replace(new RegExp(`(${rs.map(escRe).join('|')})/[^\\n"'|<>]*?(?=["'|<>]|\\s[–-]\\s|:\\s|,\\s|\\s\\[|\\s\\(\\d+(?:[.,]\\d+)?\\s?[a-zA-Z%]+\\)|$)`, 'gm'), '$1/…');
    for (const [w, to] of [...words].filter(([w]) => w && w.trim().length >= 3).sort((a, b) => b[0].length - a[0].length))
      s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escRe(w.trim())}(?![\\p{L}\\p{N}])`, 'giu'), to);
  }
  return s;
}

/** Miljövariablernas värden: hemligheter och personliga adresser visas bara som "(satt)" */
const SECRET_ENV = /KEY|SECRET|TOKEN|PASS|PASSWORD|PASSPHRASE|CREDENTIAL|COOKIE|PRIVATE|AUTH|EMAIL|CONTACT|^PUBLIC_URL$|DOMAIN|^HOSTNAME$|^HOST_HOSTNAME$|^S3_ENDPOINT$|^S3_BUCKET$|^NOTIFY_URL$|^NOTIFY_USER$/i;
// Systemets egna variabler som inte säger något om installationen
const SKIP_ENV = /^(PATH|HOME|PWD|OLDPWD|SHLVL|TERM|_|LS_COLORS|NODE_TEST_CONTEXT|NODE_OPTIONS|INIT_CWD|LANGUAGE|LC_\w+|SSH_\w+|DISPLAY|XDG_\w+|npm_\w+|GPG_KEY|YARN_VERSION)$/;
/** allow: bara de här namnen (diagnostikpaketet: variablerna som servern läser) – annars alla utom systemets egna */
export function safeEnv(env = process.env, allow = null) {
  const out = {};
  for (const k of Object.keys(env).sort()) {
    if (SKIP_ENV.test(k) || !/^[A-Z][A-Z0-9_]*$/.test(k) || (allow && !allow.has(k))) continue;
    const v = String(env[k] ?? '');
    out[k] = SECRET_ENV.test(k) ? (v ? '(satt)' : '(tom)') : maskSupport(v, { names: true }).slice(0, 300);
  }
  return out;
}

// ---------- tar (ustar) ----------
function header(name, size, mtime) {
  const h = Buffer.alloc(512, 0);
  const put = (s, off, len) => h.write(String(s).slice(0, len), off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(mtime, 12), 136, 12);
  h.fill(0x20, 148, 156); // kontrollsumman räknas med blanksteg i sitt eget fält
  put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2); put('braxhn', 265, 32); put('braxhn', 297, 32);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
/** files: [{ name, text|data }] → Buffer (tar.gz). Namnen ska vara korta ASCII-namn (högst 100 tecken). */
export function tarGz(files, mtime = Math.floor(Date.now() / 1000)) {
  const parts = [];
  for (const f of files) {
    if (!/^[\w./-]{1,100}$/.test(f.name) || f.name.includes('..')) throw new Error(`ogiltigt filnamn i arkivet: ${f.name}`);
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.text ?? ''), 'utf8');
    parts.push(header(f.name, data.length, mtime), data);
    if (data.length % 512) parts.push(Buffer.alloc(512 - (data.length % 512), 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

/** Läser ett tar.gz från tarGz() (för förhandsvisning i testerna) → [{ name, text }] */
export function untarGz(buf) {
  const tar = zlib.gunzipSync(buf), out = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    out.push({ name, text: tar.subarray(off + 512, off + 512 + size).toString('utf8') });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
