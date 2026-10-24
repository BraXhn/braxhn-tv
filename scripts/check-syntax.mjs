// Syntaxkontroll av all JavaScript i server/, web/ och test/ (körs i CI före testerna)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const bad = [];
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && e.name !== 'vendor') yield* walk(p); else if (/\.(m?js)$/.test(e.name)) yield p; } }
let n = 0;
for (const d of ['server', 'web', 'test', 'scripts']) for (const f of walk(d)) { n++; try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad.push(f + '\n' + e.stderr); } }
// Stilmallar: varje { måste stängas. Ett glömt } i ett @media-block gör att allt efter det bara gäller på den skärmbredden
// (hände när två funktioner lade regler sist i style.css) – webbläsaren säger inget om det.
for (const f of ['web/style.css']) {
  const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/"[^"\n]*"|'[^'\n]*'/g, '""');
  let depth = 0, open = 0;
  css.split('\n').forEach((l, i) => {
    for (const c of l) { if (c === '{') { if (!depth) open = i + 1; depth++; } else if (c === '}') depth--; }
    if (depth < 0) { bad.push(`${f}:${i + 1}: } utan {`); depth = 0; }
  });
  if (depth) bad.push(`${f}: ${depth} block stängs aldrig (det yttersta börjar på rad ${open})`);
  n++;
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log(`Syntax OK (${n} filer)`);
