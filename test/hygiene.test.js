// Testerna själva: de ska gå likadant som root lokalt och som vanlig användare i GitHub Actions (där bygget av
// Docker-imagen kör hela sviten före publicering) och aldrig falla av slumpen.
//  - Ingen testfil får använda den riktiga /config: db.js och logs.js vägrar starta utan CONFIG_DIR under node --test.
//  - Testservrar får sina portar från helpers/port.js (kontrollerat lediga, under Linux portintervall för utgående
//    anslutningar) – inte "20000 + slump", som kan krocka med en annan server eller en utgående anslutning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.join(import.meta.dirname, '..');
const TESTS = fs.readdirSync(import.meta.dirname).filter(f => f.endsWith('.test.js'));

test('servermoduler vägrar /config under node --test när CONFIG_DIR saknas', () => {
  for (const mod of ['server/db.js', 'server/logs.js']) {
    const env = { ...process.env, NODE_TEST_CONTEXT: 'child' }; delete env.CONFIG_DIR;
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `await import(${JSON.stringify(path.join(REPO, mod))})`],
      { env, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(r.status, 0, `${mod} startade utan CONFIG_DIR`);
    assert.match(r.stderr, /CONFIG_DIR saknas i testet/, mod);
  }
});

test('testfilerna sätter CONFIG_DIR före dynamisk import av servermoduler som når databasen', () => {
  // Statiska importer körs före all annan kod i filen – de får bara gälla moduler utan databas (rena funktioner)
  const reaches = new Map();
  const dbFree = (f, seen = new Set()) => {
    if (reaches.has(f)) return reaches.get(f);
    if (seen.has(f)) return true;
    seen.add(f);
    if (/server\/(db|logs)\.js$/.test(f)) return false;
    const src = fs.readFileSync(f, 'utf8');
    const ok = [...src.matchAll(/^import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)].every(m => dbFree(path.resolve(path.dirname(f), m[1]), seen));
    reaches.set(f, ok);
    return ok;
  };
  const bad = [];
  for (const t of TESTS) {
    const src = fs.readFileSync(path.join(import.meta.dirname, t), 'utf8');
    for (const m of src.matchAll(/^import\s[^'"]*['"](\.\.\/server\/[^'"]+)['"]/gm)) {
      if (!dbFree(path.resolve(import.meta.dirname, m[1]))) bad.push(`${t}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], 'statisk import som laddar databasen före CONFIG_DIR – använd await import() efter process.env.CONFIG_DIR = …');
});

test('ingen top-level await efter första test(): node:test kan då köra after() innan de sista testerna', () => {
  // Hände med "const PORT = await freePort()" mitt i search.test.js: after() stoppade inte servern (den fanns inte
  // än), servern startades sedan av nästa test och testfilen avslutades aldrig.
  const bad = [];
  for (const t of TESTS) {
    const src = fs.readFileSync(path.join(import.meta.dirname, t), 'utf8'), lines = src.split('\n');
    // test( eller ett eget alias (const t = (name, fn) => test(…))
    const names = ['test', ...[...src.matchAll(/^const (\w+) = \([^)]*\) => test\(/gm)].map(m => m[1])];
    const first = lines.findIndex(l => new RegExp(`^(${names.join('|')})\\(\\s*['"\`]`).test(l));
    if (first < 0) continue;
    lines.forEach((l, i) => { if (i > first && /^(const|let|var|await)\b/.test(l) && /\bawait\b/.test(l) && !/\basync\b/.test(l)) bad.push(`${t}:${i + 1}`); });
  }
  assert.deepEqual(bad, [], 'flytta raden före första test()');
});

test('testservrarnas portar kommer från helpers/port.js', () => {
  const bad = TESTS.filter(t => /\b(PORT|port)\s*=\s*\d+\s*\+\s*Math\.floor\(Math\.random\(\)/.test(fs.readFileSync(path.join(import.meta.dirname, t), 'utf8')));
  assert.deepEqual(bad, [], 'slumpad port – använd freePort() från ./helpers/port.js');
});
