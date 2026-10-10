// Kryptering av säkerhetskopior (utan databasberoende, så att restore.js kan köras fristående)
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('BXTV1');
const deriveKey = (pass, salt) => crypto.scryptSync(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 });

/** Komprimera + kryptera en fil. Format: "BXTV1" | salt(16) | iv(12) | data | tag(16) */
export async function encryptFile(src, dst, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  const out = fs.createWriteStream(dst, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), cipher, out, { end: false }).catch(e => { out.destroy(); throw e; });
  await new Promise((res, rej) => out.end(cipher.getAuthTag(), (e) => e ? rej(e) : res()));
}

/** Dekryptera en .bxtv-fil till en SQLite-databas (används vid återställning) */
export async function decryptFile(src, dst, pass) {
  const fd = fs.openSync(src, 'r');
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(33), tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 33, 0); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
  if (!head.subarray(0, 5).equals(MAGIC)) throw new Error('Inte en BraXhn TV-säkerhetskopia');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, head.subarray(5, 21)), head.subarray(21, 33));
  decipher.setAuthTag(tag);
  const tmp = dst + '.part';
  try {
    await pipeline(fs.createReadStream(src, { start: 33, end: size - 17 }), decipher, zlib.createGunzip(), fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(/auth|unsupported state/i.test(e.message) ? 'Fel lösenfras eller skadad fil' : e.message);
  }
  fs.renameSync(tmp, dst);
}

