// Gör om misslyckade test i en TAP-fil till GitHub-anteckningar (::error), högst 10 st
import fs from 'node:fs';
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n');
let n = 0;
for (let i = 0; i < lines.length && n < 10; i++) {
  const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  // Felet står i YAML-blocket efter raden: error: '…' eller error: |- följt av indragna rader
  let err = '';
  for (let k = i + 1; k < Math.min(lines.length, i + 40) && !/^\s*(not )?ok \d+/.test(lines[k]); k++) {
    const e = /^\s*error: (.*)$/.exec(lines[k]);
    if (e) {
      err = e[1].replace(/^['"|-]+|['"]$/g, '');
      for (let j = k + 1; j < lines.length && /^\s{6,}\S/.test(lines[j]) && err.length < 600; j++) err += ' ' + lines[j].trim();
      break;
    }
  }
  console.log(`::error title=${m[1].replace(/[:,\r\n]/g, ' ').slice(0, 120)}::${(err || 'se loggen').replace(/\r?\n/g, ' ').slice(0, 700)}`);
  n++;
}
