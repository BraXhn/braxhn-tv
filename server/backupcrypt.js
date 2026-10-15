// Kryptering av säkerhetskopior (utan databasberoende, så att restore.js kan köras fristående)
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('BXTV1');
const deriveKey = (pass, salt) => crypto.scryptSync(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 });

/** Komprimera + kryptera en fil. Format: "BXTV1" | salt(16) | iv(12) | data | tag(16). Vid fel tas den halvfärdiga filen bort. */
export async function encryptFile(src, dst, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  let out;
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
    out = fs.createWriteStream(dst, { mode: 0o600 });
    out.write(Buffer.concat([MAGIC, salt, iv]));
    await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), cipher, out, { end: false });
    await new Promise((res, rej) => out.end(cipher.getAuthTag(), (e) => e ? rej(e) : res()));
  } catch (e) {
    out?.destroy();
    fs.rmSync(dst, { force: true });
    throw e;
  }
}

const BAD = 'Fel lösenfras eller skadad fil';
/** Dekryptera en .bxtv-fil till en SQLite-databas (används vid återställning). Allt dekrypteras och autentiseras (GCM-taggen)
 *  innan något packas upp – fel lösenfras ger då ett tydligt fel i stället för ett obegripligt zlib-fel. */
export async function decryptFile(src, dst, pass) {
  const fd = fs.openSync(src, 'r');
  let size, head, tag;
  try {
    size = fs.fstatSync(fd).size;
    head = Buffer.alloc(33); tag = Buffer.alloc(16);
    if (size < 33 + 16) throw new Error('Inte en BraXhn TV-säkerhetskopia');
    fs.readSync(fd, head, 0, 33, 0); fs.readSync(fd, tag, 0, 16, size - 16);
  } finally { fs.closeSync(fd); }
  if (!head.subarray(0, 5).equals(MAGIC)) throw new Error('Inte en BraXhn TV-säkerhetskopia');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, head.subarray(5, 21)), head.subarray(21, 33));
  decipher.setAuthTag(tag);
  const gz = dst + '.gz.part', tmp = dst + '.part';
  try {
    // 1) dekryptera till en tillfällig fil – final() kontrollerar taggen i slutet av strömmen
    try {
      await pipeline(size > 49 ? fs.createReadStream(src, { start: 33, end: size - 17 }) : (async function* () {})(), decipher, fs.createWriteStream(gz, { mode: 0o600 }));
    } catch (e) { throw new Error(/auth|unsupported state|bad decrypt/i.test(e.message) ? BAD : e.message); }
    // 2) först nu, med äkta data, packa upp
    try { await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(tmp, { mode: 0o600 })); }
    catch (e) { throw new Error(e.code?.startsWith?.('Z_') || /header check|unexpected end|invalid/i.test(e.message) ? BAD : e.message); }
    fs.renameSync(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally { fs.rmSync(gz, { force: true }); }
}
