// Syntaxkontroll av all JavaScript i server/, web/ och test/ (körs i CI före testerna)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const bad = [];
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && e.name !== 'vendor') yield* walk(p); else if (/\.(m?js)$/.test(e.name)) yield p; } }
let n = 0;
for (const d of ['server', 'web', 'test', 'scripts']) for (const f of walk(d)) { n++; try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad.push(f + '\n' + e.stderr); } }
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log(`Syntax OK (${n} filer)`);
