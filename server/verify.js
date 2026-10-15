// Integritetskontroll av programfilerna.
//   node server/verify.js             kontrollerar inbäddade tredjepartsfiler mot web/vendor/checksums.json
//   node server/verify.js --manifest  skriver integrity.json (SHA-256 för alla filer i server/ och web/) – körs i Docker-bygget
// Servern jämför filerna mot integrity.json vid start och i säkerhetskontrollen, så att ändrade filer i en
// körande container upptäcks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = path.join(ROOT, 'integrity.json');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p); else if (e.isFile()) yield p;
  }
}

export function checkVendor() {
  const dir = path.join(ROOT, 'web', 'vendor');
  const want = JSON.parse(fs.readFileSync(path.join(dir, 'checksums.json'), 'utf8'));
  const bad = Object.entries(want).filter(([f, h]) => !fs.existsSync(path.join(dir, f)) || sha(path.join(dir, f)) !== h).map(([f]) => f);
  return bad;
}

export function buildManifest() {
  const out = {};
  for (const d of ['server', 'web']) for (const f of files(path.join(ROOT, d))) out[path.relative(ROOT, f).split(path.sep).join('/')] = sha(f);
  out['package.json'] = sha(path.join(ROOT, 'package.json'));
  return out;
}

/** Jämför filerna med integrity.json. Returnerar null om manifest saknas (t.ex. vid utveckling). */
export function checkManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  const want = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).files || {};
  const have = buildManifest();
  const changed = Object.keys(want).filter(f => have[f] !== want[f]);
  const added = Object.keys(have).filter(f => !(f in want));
  return { ok: !changed.length && !added.length, changed, added, files: Object.keys(want).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bad = checkVendor();
  if (bad.length) { console.error('Fel checksumma för inbäddade filer:', bad.join(', ')); process.exit(1); }
  console.log('Inbäddade tredjepartsfiler: checksummor OK');
  if (process.argv.includes('--manifest')) {
    const files = buildManifest();
    fs.writeFileSync(MANIFEST, JSON.stringify({ created: new Date().toISOString(), files }, null, 1));
    console.log(`integrity.json skriven (${Object.keys(files).length} filer)`);
  }
}
