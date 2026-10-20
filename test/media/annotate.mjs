// Gör om misslyckade test i en TAP-fil till GitHub-anteckningar (::error), högst 10 st.
// Kända brister (# TODO) hoppas över. Med felet följer listan under "actual:" (testsamlingens fel per källa).
import fs from 'node:fs';
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const clean = (x) => x.replace(/\r?\n/g, ' ').replace(/::/g, ': ');
let n = 0;
for (let i = 0; i < lines.length && n < 10; i++) {
  const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m || /# TODO/.test(m[1])) continue;
  const block = [];
  for (let k = i + 1; k < lines.length && !/^\s*(not )?ok \d+/.test(lines[k]); k++) block.push(lines[k]);
  const err = (block.find(l => /^\s*error:/.test(l)) || '').replace(/^\s*error:\s*['"|-]*/, '').replace(/['"]$/, '');
  // "actual:"-listan: en rad per fel ("- 'text'")
  const a = block.findIndex(l => /^\s*actual:/.test(l));
  const items = [];
  if (a >= 0) for (let k = a + 1; k < block.length && /^\s+(- |\d+:)/.test(block[k]); k++) items.push(block[k].trim().replace(/^(- |\d+:\s*)/, '').replace(/^['"]|['"]$/g, ''));
  const title = m[1].replace(/[:,\r\n]/g, ' ').slice(0, 120);
  console.log(`::error title=${title}::${clean(err).slice(0, 200)}${items.length ? ' | ' + clean(items.join(' | ')).slice(0, 1800) : ''}`);
  n++;
}
