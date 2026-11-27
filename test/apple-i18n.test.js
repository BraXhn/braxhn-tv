// iOS/tvOS-appen (apps/apple) på engelska: svenskan är nyckeln i koden (L("…") och SwiftUI-texter som Text("…")) och
// översättningen ligger i Shared/Resources/en.lproj/Localizable.strings. Saknas en rad visar appen svenska för
// engelska användare. Statiska kontroller utan Xcode:
// - filen går att läsa (varje rad är "nyckel" = "värde"; eller en kommentar), inga dubbletter, samma platshållare
//   (%@, %d …) i samma ordning och ingen svenska (å/ä/ö) i engelskan
// - varje L("…") och varje text i Text/Button/Label/Section/navigationTitle/LabeledContent/TextField finns i filen
// - Feedbacks områden och typer är samma som serverns (AREAS och KINDS i server/support.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SHARED = path.join(ROOT, 'apps', 'apple', 'Shared');
const STRINGS = path.join(SHARED, 'Resources', 'en.lproj', 'Localizable.strings');
const swiftFiles = () => fs.readdirSync(SHARED).filter(f => f.endsWith('.swift')).map(f => path.join(SHARED, f));

/** Localizable.strings → { entries: [{ key, value, line }], bad: [rader som inte går att läsa] } */
function parseStrings(src) {
  const entries = [], bad = [];
  // Blockkommentarer kan gå över flera rader
  const lines = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, '')).split('\n');
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t || t.startsWith('//')) return;
    const m = /^"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)";$/.exec(t);
    if (m) entries.push({ key: m[1], value: m[2], line: i + 1 }); else bad.push(`${i + 1}: ${t}`);
  });
  return { entries, bad };
}
const specifiers = (s) => (s.match(/%(?:\d+\$)?(?:ll|l)?[@dfsu]/g) || []).map(x => x.replace(/^%\d+\$/, '%'));

test('Localizable.strings: går att läsa, inga dubbletter, samma platshållare och ingen svenska i engelskan', () => {
  const { entries, bad } = parseStrings(fs.readFileSync(STRINGS, 'utf8'));
  assert.deepEqual(bad, [], 'rader som inte är "nyckel" = "värde";');
  const seen = new Map(), dup = [], spec = [], sv = [];
  for (const e of entries) {
    if (seen.has(e.key)) dup.push(`${e.key} (rad ${seen.get(e.key)} och ${e.line})`); else seen.set(e.key, e.line);
    if (specifiers(e.key).join() !== specifiers(e.value).join()) spec.push(`rad ${e.line}: ${e.key}`);
    if (/[åäöÅÄÖ]/.test(e.value)) sv.push(`rad ${e.line}: ${e.value}`);
  }
  assert.deepEqual(dup, [], 'samma nyckel två gånger');
  assert.deepEqual(spec, [], 'olika platshållare i nyckel och översättning');
  assert.deepEqual(sv, [], 'svenska tecken i den engelska översättningen');
});

test('varje svensk text i appen har en engelsk översättning', () => {
  const keys = new Set(parseStrings(fs.readFileSync(STRINGS, 'utf8')).entries.map(e => e.key));
  const missing = [];
  for (const f of swiftFiles()) {
    // Kommentarer bort (radkommentarer utanför strängar räcker – koden har inga // i texterna)
    const src = fs.readFileSync(f, 'utf8').split('\n').map(l => l.replace(/(^|[^:"])\/\/.*$/, '$1')).join('\n');
    const found = [
      ...[...src.matchAll(/\bL\("((?:[^"\\]|\\.)*)"\)/g)].map(m => m[1]),
      // SwiftUI översätter en strängliteral av sig själv (LocalizedStringKey); texter med \(…) räknas inte
      ...[...src.matchAll(/\b(?:Text|Button|Label|Section|navigationTitle|LabeledContent|TextField)\("((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).filter(k => !k.includes('\\(')),
    ];
    for (const k of found) if (k && !keys.has(k)) missing.push(`${path.basename(f)}: ${k}`);
  }
  assert.deepEqual([...new Set(missing)], [], 'saknas i en.lproj/Localizable.strings');
});

test('Feedback: samma områden och typer som servern', () => {
  const swift = fs.readFileSync(path.join(SHARED, 'Feedback.swift'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server', 'support.js'), 'utf8');
  const list = (re, src) => [...(re.exec(src)?.[1] || '').matchAll(/"([a-z]+)"/g)].map(m => m[1]);
  const areas = list(/static let areas = \[([^\]]*)\]/, swift);
  const kinds = list(/static let kinds = \[([^\]]*)\]/, swift);
  const serverAreas = [...(/export const AREAS = \{([^}]*)\}/.exec(server)?.[1] || '').matchAll(/(\w+):/g)].map(m => m[1]);
  const serverKinds = [...(/export const KINDS = \[([^\]]*)\]/.exec(server)?.[1] || '').matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.ok(serverAreas.length && areas.length, 'hittar inte områdena');
  assert.deepEqual(areas, serverAreas, 'områdena (samma ordning som webben)');
  assert.deepEqual([...kinds].sort(), [...serverKinds].sort(), 'typerna');
  // Varje sida som Feedback förvalt efter ska gälla ett område som finns
  const pageAreas = [...(/static let pageAreas: \[String: String\] = \[([\s\S]*?)\]/.exec(swift)?.[1] || '').matchAll(/"[^"]+": "(\w+)"/g)].map(m => m[1]);
  assert.ok(pageAreas.length, 'hittar inte sidorna');
  for (const a of pageAreas) assert.ok(serverAreas.includes(a), `okänt område ${a}`);
});
