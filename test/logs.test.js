// Serverloggen: maskering av hemligheter, nivåfilter och felrapporter från webbappen
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-logs-'));
const logs = await import('../server/logs.js');

test('loggen maskerar nycklar, token och lösenord i adresser', () => {
  const s = logs.mask('hämtar https://api.themoviedb.org/3/movie?api_key=abcdef123456 och http://anna:hemligt@nas:8096/x token=xyz Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc X-Plex-Token: qwerty 0123456789abcdef0123456789abcdef');
  for (const bad of ['abcdef123456', 'hemligt', 'xyz', 'eyJhbGci', 'qwerty', '0123456789abcdef0123456789abcdef']) assert.ok(!s.includes(bad), `${bad} syns: ${s}`);
  assert.ok(s.includes('api.themoviedb.org') && s.includes('nas:8096'));
});

test('loggen: console.* sparas med nivå, filtreras och kan hämtas från en viss rad', () => {
  console.log('[test] vanlig rad');
  console.warn('[test] varning');
  console.error('[test] fel', new Error('boom').message);
  const all = logs.lines({ q: '[test]' });
  assert.deepEqual(all.map(l => l.level), ['info', 'warn', 'error']);
  assert.deepEqual(logs.lines({ q: '[test]', level: 'warn' }).map(l => l.level), ['warn', 'error']);
  assert.equal(logs.lines({ q: '[test]', level: 'error' })[0].msg, '[test] fel boom');
  assert.equal(logs.lines({ q: '[test]', after: all[1].id }).length, 1);
  const f = path.join(process.env.CONFIG_DIR, 'logs', `braxhn-${new Date().toLocaleDateString('sv-SE')}.log`);
  return new Promise(r => setTimeout(r, 100)).then(() => assert.match(fs.readFileSync(f, 'utf8'), /WARN  \[test\] varning/));
});
