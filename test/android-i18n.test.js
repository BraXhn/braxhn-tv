// Android-appen (apps/automotive) på engelska och svenska: texterna ligger i res/values/strings.xml (engelska, standard)
// och res/values-sv/strings.xml (svenska). Statiska kontroller utan Android SDK:
// - inga svenska texter i Kotlin-koden (strängar med å/ä/ö eller vanliga svenska ord utanför kommentarer), med
//   uttryckliga undantag nedan
// - båda filerna har samma namn, samma platshållare (%1$s, %1$d …) och samma pluralformer, apostrofer och citattecken
//   är escapade och engelskan saknar å/ä/ö
// - varje R.string/R.plurals och @string i koden och manifestet finns, och varje text används
// - manifestets etiketter (appnamnet) kommer från strings.xml
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.join(import.meta.dirname, '..', 'apps', 'automotive', 'app', 'src', 'main');
const RES = path.join(APP, 'res');
const read = (f) => fs.readFileSync(f, 'utf8');
const ktFiles = () => fs.readdirSync(path.join(APP, 'java'), { recursive: true }).filter(f => f.endsWith('.kt')).map(f => path.join(APP, 'java', f));

// ---------- Kotlin: strängliteraler utanför kommentarer ----------

/** Alla strängliteraler i Kotlin-källan: { line, text }. Mallar (${…}) blir \0 och deras egna strängar räknas för sig. */
function kotlinStrings(src) {
  const out = [];
  const stack = [{ mode: 'code', depth: 0 }];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i], n = src[i + 1], m = stack[stack.length - 1];
    if (m.mode === 'code') {
      if (c === '\n') { line++; i++; continue; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { // blockkommentarer kan vara nästlade i Kotlin
        let d = 1; i += 2;
        while (i < src.length && d) {
          if (src[i] === '\n') line++;
          if (src.startsWith('/*', i)) { d++; i += 2; } else if (src.startsWith('*/', i)) { d--; i += 2; } else i++;
        }
        continue;
      }
      if (c === '"') { const raw = src.startsWith('"""', i); stack.push({ mode: raw ? 'raw' : 'str', text: '', line }); i += raw ? 3 : 1; continue; }
      if (c === "'") { i += src[i + 1] === '\\' ? 3 : 2; while (i < src.length && src[i] !== "'") i++; i++; continue; }
      if (c === '{') m.depth++;
      if (c === '}' && stack.length > 1) { if (m.depth === 0) { stack.pop(); i++; continue; } m.depth--; }
      i++; continue;
    }
    if (c === '\n') line++;
    if (m.mode === 'str' && c === '\\') { m.text += src.slice(i, i + 2); i += 2; continue; }
    if (c === '$' && n === '{') { m.text += '\0'; stack.push({ mode: 'code', depth: 0 }); i += 2; continue; }
    if ((m.mode === 'str' && c === '"') || (m.mode === 'raw' && src.startsWith('"""', i))) {
      out.push({ line: m.line, text: m.text }); stack.pop(); i += m.mode === 'raw' ? 3 : 1; continue;
    }
    m.text += c; i++;
  }
  return out;
}

// Vanliga svenska ord utan å/ä/ö (inga som också är engelska, t.ex. "till")
const SV_WORDS = ['och', 'inte', 'eller', 'inga', 'ingen', 'inget', 'finns', 'visa', 'spela', 'spelat', 'spara', 'avbryt', 'avboka', 'alla', 'nytt',
  'nya', 'ska', 'efter', 'filmer', 'serie', 'serier', 'musik', 'ljud', 'ljudbok', 'avsnitt', 'titlar', 'titel', 'sedd', 'osedd', 'kanal', 'kanaler',
  'profil', 'profiler', 'logga', 'kommande', 'titta', 'lyssna', 'lyssnad', 'senaste', 'tidigare', 'senare', 'poddar', 'podd', 'mitt', 'nedladdat',
  'inspelningar', 'inspelat', 'undertext', 'undertexter', 'kvalitet', 'idag', 'imorgon', 'bara', 'hemma', 'hemmet', 'servern', 'hoppa', 'serien',
  'filmen', 'betyg', 'markera', 'ladda', 'igen', 'tillbaka', 'favorit', 'favoriter', 'artister', 'spellistor', 'stationer', 'nyligen', 'regi',
  'medverkande', 'barn', 'byt', 'bil', 'hem', 'kod', 'koden', 'nattläge', 'synka', 'kunde', 'automatisk'];
const SWEDISH = new RegExp(`[åäöÅÄÖ]|(?<![\\p{L}\\d])(${SV_WORDS.join('|')})(?![\\p{L}\\d])`, 'iu');

/** Svenska som får stå kvar i Kotlin-koden: inget användaren ser. Varje undantag måste fortfarande behövas. */
const ALLOWED = [
  { file: 'Offline.kt', text: 'Automatisk synk misslyckades: \0', why: 'loggrad (Log.w), syns inte för användaren' },
];

test('Kotlin-tolken: hittar strängar, hoppar över kommentarer och delar upp mallar', () => {
  const src = 'val a = "Hej ${if (x) "på" else "dig"}" // "kommentar"\n/* "block /* nästlad */ \'"\' */ val b = \'"\'; val c = """rå "text""" + "\\"x\\""';
  assert.deepEqual(kotlinStrings(src).map(s => s.text), ['på', 'dig', 'Hej \0', 'rå "text', '\\"x\\"']);
  assert.equal(kotlinStrings('x\n\n"a"')[0].line, 3);
});

test('Android-appen: inga svenska texter i Kotlin-koden (de ligger i res/values-sv/strings.xml)', () => {
  const found = [], used = new Set();
  for (const f of ktFiles()) {
    const name = path.basename(f);
    for (const s of kotlinStrings(read(f))) {
      if (!SWEDISH.test(s.text)) continue;
      const ok = ALLOWED.find(a => a.file === name && a.text === s.text);
      if (ok) { used.add(ok); continue; }
      found.push(`${name}:${s.line}: "${s.text.replace(/\0/g, '${…}')}"`);
    }
  }
  assert.deepEqual(found, [], `svensk text i Kotlin-koden – lägg den i res/values/strings.xml (engelska) och res/values-sv/strings.xml (svenska):\n${found.join('\n')}`);
  const stale = ALLOWED.filter(a => !used.has(a)).map(a => `${a.file}: ${a.text}`);
  assert.deepEqual(stale, [], 'undantag som inte längre behövs');
});

// ---------- strings.xml ----------

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** { strings: Map(namn → { text, translatable }), plurals: Map(namn → { quantity → text }), problems: [] } */
function resources(file) {
  const xml = read(file);
  const strings = new Map(), plurals = new Map(), problems = [];
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  assert.match(body, /^\s*<\?xml version="1.0" encoding="utf-8"\?>\s*<resources>[\s\S]*<\/resources>\s*$/, `${file}: inte en resursfil`);
  const check = (name, raw) => {
    if (/(^|[^\\])['"]/.test(raw)) problems.push(`${name}: apostrof eller citattecken utan \\`);
    if (/&(?!(amp|lt|gt|quot|apos);)/.test(raw) || /[<>]/.test(raw)) problems.push(`${name}: & < > ska skrivas &amp; &lt; &gt;`);
  };
  for (const m of body.matchAll(/<string\s+([^>]*)>([^<]*)<\/string>/g)) {
    const name = /name="(\w+)"/.exec(m[1])?.[1];
    if (strings.has(name)) problems.push(`${name}: finns två gånger`);
    check(name, m[2]);
    strings.set(name, { text: unescape(m[2]), translatable: !/translatable="false"/.test(m[1]), formatted: !/formatted="false"/.test(m[1]) });
  }
  for (const m of body.matchAll(/<plurals\s+name="(\w+)">([\s\S]*?)<\/plurals>/g)) {
    if (plurals.has(m[1])) problems.push(`${m[1]}: finns två gånger`);
    const q = {};
    for (const it of m[2].matchAll(/<item quantity="(\w+)">([^<]*)<\/item>/g)) { check(m[1], it[2]); q[it[1]] = unescape(it[2]); }
    if (!q.one || !q.other) problems.push(`${m[1]}: pluralformen saknar one eller other`);
    plurals.set(m[1], q);
  }
  // Inget annat än string och plurals (allt annat skulle missas av kontrollerna)
  const rest = body.replace(/<string\s[^>]*>[^<]*<\/string>/g, '').replace(/<plurals\s[\s\S]*?<\/plurals>/g, '');
  if (/<(?!\?xml|\/?resources)/.test(rest)) problems.push('okänd tagg i filen');
  return { strings, plurals, problems };
}
/** Platshållarna i en text: ["1$s", "2$d"] i ordning efter nummer (%% räknas inte) */
const placeholders = (s) => [...s.replace(/%%/g, '').matchAll(/%(\d+\$)?[-#+ 0,(]*\d*(?:\.\d+)?([a-zA-Z])/g)].map(m => (m[1] || '?$') + m[2]).sort();

const EN = path.join(RES, 'values', 'strings.xml'), SV = path.join(RES, 'values-sv', 'strings.xml');

test('strings.xml: engelska och svenska har samma texter, platshållare och pluralformer', () => {
  const en = resources(EN), sv = resources(SV);
  assert.deepEqual(en.problems, [], 'values/strings.xml');
  assert.deepEqual(sv.problems, [], 'values-sv/strings.xml');
  assert.ok(en.strings.size > 200, 'för få texter');
  const bad = [];
  for (const [n, e] of en.strings) {
    const s = sv.strings.get(n);
    if (!e.translatable) { if (s) bad.push(`${n}: translatable="false" men finns i values-sv`); continue; }
    if (!s) { bad.push(`${n}: saknas i values-sv`); continue; }
    if (placeholders(e.text).join() !== placeholders(s.text).join()) bad.push(`${n}: platshållare ${placeholders(e.text)} ≠ ${placeholders(s.text)}`);
    if (placeholders(e.text).some(p => p.startsWith('?')) && placeholders(e.text).length > 1) bad.push(`${n}: flera platshållare utan nummer (%1$s, %2$s)`);
    if (e.formatted !== s.formatted) bad.push(`${n}: formatted skiljer`);
  }
  for (const n of sv.strings.keys()) if (!en.strings.has(n)) bad.push(`${n}: finns bara i values-sv`);
  for (const [n, e] of en.plurals) {
    const s = sv.plurals.get(n);
    if (!s) { bad.push(`${n}: pluralformen saknas i values-sv`); continue; }
    for (const q of ['one', 'other']) if (placeholders(e[q]).join() !== placeholders(s[q]).join()) bad.push(`${n} (${q}): platshållare skiljer`);
  }
  for (const n of sv.plurals.keys()) if (!en.plurals.has(n)) bad.push(`${n}: pluralformen finns bara i values-sv`);
  for (const [n, e] of en.strings) if (/[åäöÅÄÖ]/.test(e.text)) bad.push(`${n}: svenska i den engelska filen: ${e.text}`);
  for (const [n, e] of en.plurals) if (/[åäöÅÄÖ]/.test(e.one + e.other)) bad.push(`${n}: svenska i den engelska filen`);
  assert.deepEqual(bad, []);
});

test('strings.xml: varje text som koden använder finns, och varje text används', () => {
  const en = resources(EN);
  const used = { string: new Set(), plurals: new Set() };
  const sources = [...ktFiles(), path.join(APP, 'AndroidManifest.xml'),
    ...fs.readdirSync(RES, { recursive: true }).filter(f => f.endsWith('.xml') && !/strings\.xml$/.test(f)).map(f => path.join(RES, f))];
  for (const f of sources) {
    const src = read(f);
    for (const m of src.matchAll(/\bR\.(string|plurals)\.(\w+)/g)) used[m[1]].add(m[2]);
    for (const m of src.matchAll(/@(string|plurals)\/(\w+)/g)) used[m[1]].add(m[2]);
  }
  const missing = [...used.string].filter(n => !en.strings.has(n)).map(n => 'R.string.' + n)
    .concat([...used.plurals].filter(n => !en.plurals.has(n)).map(n => 'R.plurals.' + n));
  assert.deepEqual(missing, [], 'används men finns inte i values/strings.xml');
  const unused = [...en.strings.keys()].filter(n => !used.string.has(n)).concat([...en.plurals.keys()].filter(n => !used.plurals.has(n)));
  assert.deepEqual(unused, [], 'texter som inte används');
});

test('AndroidManifest: appnamnet och etiketterna kommer från strings.xml', () => {
  const man = read(path.join(APP, 'AndroidManifest.xml'));
  const literal = [...man.matchAll(/android:(label|description)="([^"]*)"/g)].filter(m => !m[2].startsWith('@string/')).map(m => m[0]);
  assert.deepEqual(literal, []);
  assert.match(man, /<application[^>]*android:label="@string\/app_name"/);
});
