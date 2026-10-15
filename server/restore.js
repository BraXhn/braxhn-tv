#!/usr/bin/env node
// Återställ en krypterad säkerhetskopia från kommandoraden:
//   docker exec -it braxhn-tv node server/restore.js /backup/braxhn-tv-2026-10-10-0300.bxtv
// Lösenfrasen läses från BACKUP_PASSPHRASE eller frågas efter. Databasen byts vid nästa omstart.
import path from 'node:path';
import readline from 'node:readline';
import { decryptFile } from './backupcrypt.js';

const file = process.argv[2];
if (!file) { console.log('Användning: node server/restore.js <fil.bxtv> [utfil.db]'); process.exit(1); }
const CONFIG = process.env.CONFIG_DIR || '/config';
const out = process.argv[3] || path.join(CONFIG, 'restore.db');
let pass = process.env.BACKUP_PASSPHRASE;
if (!pass) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  pass = await new Promise(r => rl.question('Lösenfras: ', a => { rl.close(); r(a); }));
}
try {
  await decryptFile(file, out, pass);
  console.log(process.argv[3] ? `Klart: ${out}` : `Klart. Starta om containern så används säkerhetskopian (den nuvarande databasen sparas).`);
} catch (e) { console.error('Misslyckades:', e.message); process.exit(1); }
