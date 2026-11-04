// Dokumentationen för en internationell publik: README.md (svenska) och README.en.md (engelska) får inte glida isär.
// Varje miljövariabel i README.md:s tabell finns i README.en.md:s tabell (och tvärtom) och används i koden
// (server/, docker/, Dockerfile eller Unraid-mallarna). Länkarna mellan språken, integritetsavsnitten och
// GitHub-filerna för buggrapporter, säkerhet och bidrag finns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

/** Variabelnamnen i första kolumnen av tabellen under rubriken (t.ex. "| `PORT` / `HTTPS_PORT` | …") */
function envTable(file, heading) {
  const s = read(file);
  const at = s.indexOf(`\n## ${heading}\n`);
  assert.ok(at >= 0, `${file}: rubriken "## ${heading}" saknas`);
  const sec = s.slice(at + 1).split(/\n## /)[0];
  const names = new Set();
  for (const line of sec.split('\n')) {
    if (!line.startsWith('| `')) continue;
    for (const m of line.split('|')[1].matchAll(/`([A-Z][A-Z0-9_]+)`/g)) names.add(m[1]);
  }
  assert.ok(names.size > 50, `${file}: för få variabler i tabellen (${names.size})`);
  return names;
}

test('miljövariablerna i README.md finns i README.en.md (och tvärtom) och i koden', () => {
  const sv = envTable('README.md', 'Miljövariabler'), en = envTable('README.en.md', 'Environment variables');
  assert.deepEqual([...sv].filter(v => !en.has(v)), [], 'dokumenterade i README.md men saknas i README.en.md');
  assert.deepEqual([...en].filter(v => !sv.has(v)), [], 'dokumenterade i README.en.md men saknas i README.md');
  const code = [];
  for (const f of fs.readdirSync(path.join(REPO, 'server'), { recursive: true }).filter(f => f.endsWith('.js'))) code.push(read(path.join('server', f)));
  for (const f of fs.readdirSync(path.join(REPO, 'docker'))) code.push(read(path.join('docker', f)));
  for (const f of ['Dockerfile', ...fs.readdirSync(REPO).filter(f => /^braxhn-tv.*\.xml$/.test(f))]) code.push(read(f));
  const all = code.join('\n');
  assert.deepEqual([...sv].filter(v => !new RegExp(`\\b${v}\\b`).test(all)), [], 'dokumenterade variabler som koden inte läser');
});

test('README: länkar mellan språken, integritet och GitHub-filerna för en internationell publik', () => {
  const sv = read('README.md'), en = read('README.en.md');
  assert.match(sv.split('\n').slice(0, 5).join('\n'), /\[English: README\.en\.md\]\(README\.en\.md\)/);
  assert.match(en.split('\n').slice(0, 5).join('\n'), /\[Svenska\]\(README\.md\)/);
  assert.match(sv, /\n## Integritet\n[\s\S]*Ingen telemetri/);
  assert.match(en, /\n## Privacy\n[\s\S]*No telemetry/);
  for (const f of ['SECURITY.md', 'CONTRIBUTING.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml']) assert.ok(fs.existsSync(path.join(REPO, f)), f);
  // Buggrapporten ber om det supporten behöver
  const bug = read('.github/ISSUE_TEMPLATE/bug_report.yml');
  for (const w of [/diagnostics bundle/i, /BraXhn TV version/i, /Unraid version/i, /hardware/i, /diagnostikpaket/i]) assert.match(bug, w);
  // Lokala länkar i README.en.md pekar på filer som finns
  for (const m of en.matchAll(/\]\(((?!https?:|#)[^)]+)\)/g)) assert.ok(fs.existsSync(path.join(REPO, m[1].split('#')[0])), `README.en.md länkar till ${m[1]}`);
});
