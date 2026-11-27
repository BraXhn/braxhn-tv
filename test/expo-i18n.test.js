// Expo-appen (apps/expo) på svenska och engelska: texterna står på svenska i t('…') och den engelska översättningen i
// src/i18n-en.ts. Statiska kontroller (som test/android-i18n.test.js för Android-appen):
// - inga svenska texter i .ts/.tsx utanför t()/tn() – strängar och JSX-text – med uttryckliga undantag nedan
// - varje t()-nyckel finns i i18n-en.ts, varje rad där används, platshållarna är desamma och engelskan saknar å/ä/ö
// - en text som också finns i webben (web/i18n/en.js) har exakt samma engelska, så att appen och webben säger samma sak
// Och i Node (22.18+ läser TypeScript): språkvalet efter telefonens språk, t(), tn() (plural) och tal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.join(import.meta.dirname, '..', 'apps', 'expo');
const read = (f) => fs.readFileSync(f, 'utf8');
/** Appens källfiler (relativt apps/expo), utan i18n-modulen själv */
const sources = () => ['App.tsx', 'index.ts', ...fs.readdirSync(path.join(APP, 'src'), { recursive: true }).map((f) => 'src/' + f.split(path.sep).join('/'))]
  .filter((f) => /\.tsx?$/.test(f) && f !== 'src/i18n.ts' && f !== 'src/i18n-en.ts');

// ---------- TypeScript/TSX: strängar och JSX-text ----------

/**
 * Delar upp källan i strängliteraler och kod utanför strängar och kommentarer.
 * strings: { line, text, key } – key = direkt argument till t( eller tn( ; mallars ${…} blir \0 och deras egna strängar
 * räknas för sig. code: kodbitarna (där JSX-texten finns). Regex-literaler hoppas över.
 */
function tsScan(src) {
  const strings = [], code = [];
  const stack = [{ mode: 'code', br: [] }];
  let i = 0, line = 1, last = '', buf = '', bufLine = 1;
  const flush = () => { if (buf.trim()) code.push({ line: bufLine, text: buf }); buf = ''; bufLine = line; };
  const REGEX_BEFORE = '(,=:[!&|?{};+-*%~^';
  while (i < src.length) {
    const c = src[i], n = src[i + 1], m = stack[stack.length - 1];
    if (m.mode === 'code') {
      if (c === '\n') { line++; buf += c; i++; continue; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < src.length && !src.startsWith('*/', i)) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
      if (c === '/' && (last === '' || REGEX_BEFORE.includes(last) || /\b(return|typeof|case)$/.test(buf.trimEnd()))) {
        i++; let cls = false;
        while (i < src.length && src[i] !== '\n') { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; i++; }
        i++; while (/[a-z]/.test(src[i] || '')) i++;
        last = 'x'; buf += ' /re/ '; continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        const top = m.br[m.br.length - 1];
        flush();
        stack.push({ mode: c === '`' ? 'tpl' : 'str', q: c, text: '', line, key: !!top?.t, subs: false });
        i++; continue;
      }
      if (c === '(') m.br.push({ t: /(?<![\w$.])tn?\s*$/.test(buf) });
      else if (c === '[' || c === '{') m.br.push({ t: false });
      else if (c === ')' || c === ']') m.br.pop();
      else if (c === '}') {
        if (!m.br.length && stack.length > 1) { flush(); stack.pop(); last = ''; i++; continue; }
        m.br.pop();
      }
      if (!/\s/.test(c)) last = c;
      buf += c; i++; continue;
    }
    if (c === '\n') line++;
    if (c === '\\') { m.text += src.slice(i, i + 2); i += 2; continue; }
    if (m.mode === 'tpl' && c === '$' && n === '{') { m.text += '\0'; m.subs = true; stack.push({ mode: 'code', br: [] }); i += 2; continue; }
    if (c === m.q) { strings.push({ line: m.line, text: m.text, key: m.key, subs: m.subs }); stack.pop(); last = 'x'; i++; bufLine = line; continue; }
    m.text += c; i++;
  }
  flush();
  return { strings, code };
}
/** JSX-text i en kodbit: det som står mellan > eller } och nästa < eller { (inte "}, nyckel: {" i ett objekt) */
const jsxText = (code) => [...code.matchAll(/[>}]([^<>{}]*)(?=[<{])/g)].map((x) => x[1]).filter((x) => /\p{L}/u.test(x) && !/^\s*[,;)\]]/.test(x));

// Vanliga svenska ord utan å/ä/ö (inga som också är engelska, t.ex. "till" eller "film")
const SV_WORDS = ['och', 'inte', 'eller', 'inga', 'ingen', 'inget', 'finns', 'visa', 'spela', 'spelas', 'spara', 'avbryt', 'alla', 'nytt', 'nya', 'ska',
  'efter', 'filmer', 'serie', 'serier', 'musik', 'ljud', 'ljudbok', 'avsnitt', 'titlar', 'titel', 'sedd', 'osedd', 'profil', 'profiler', 'logga', 'titta',
  'lyssna', 'lyssnat', 'senaste', 'tidigare', 'senare', 'poddar', 'podd', 'mitt', 'nedladdat', 'undertext', 'undertexter', 'kvalitet', 'idag', 'bara',
  'hemma', 'servern', 'hoppa', 'serien', 'filmen', 'markera', 'ladda', 'laddar', 'igen', 'tillbaka', 'favoriter', 'artister', 'spellistor', 'spellista',
  'nyligen', 'byt', 'kunde', 'kvar', 'av', 'om', 'stoppades', 'misslyckades', 'konto', 'boken', 'listan', 'sidan', 'telefonen', 'gick', 'sekunder',
  'tom', 'klar', 'hem', 'mina', 'skicka', 'bibliotek', 'biblioteket', 'kapitel', 'blanda', 'omslag', 'utan', 'med', 'vid', 'svenska', 'uppspelning',
  'uppspelningen', 'spelaren', 'titelsidan', 'lista', 'sida'];
const SWEDISH = new RegExp(`[åäöÅÄÖ]|(?<![\\p{L}\\d_$.-])(${SV_WORDS.join('|')})(?![\\p{L}\\d_$-])`, 'iu');

/** Svenska som får stå kvar utanför t(): inget användaren läser som text. Varje undantag måste fortfarande behövas. */
const ALLOWED = [
  { file: 'src/screens/Main.tsx', texts: ['Svenska'], why: 'språkets namn på sitt eget språk i språkvalet (English står bredvid)' },
  { file: 'src/offline.ts', texts: ['[offline] kunde inte spara listan'], why: 'loggrad (console.warn), syns inte för användaren' },
  { file: 'src/feedback.ts', texts: ['Bibliotek', 'Titelsidan', 'Spelaren', 'Spellista', 'Ljudbok', 'Podd', 'Nedladdat', 'Hem', 'Sök', 'Musik', 'Min lista', 'Uppspelningen: \0'],
    why: 'sidans namn och felet i den tekniska informationen till utvecklarna – skickas alltid på svenska' },
  { file: 'src/feedback.ts', texts: ['musik', 'ljud', 'uppspelning'], why: 'områdenas nycklar i API:t (AREAS i server/support.js), namnen står i t()' },
  { file: 'src/screens/Player.tsx', texts: ['uppspelning'], why: 'områdets nyckel i API:t (förval i Feedback)' },
];

test('TSX-tolken: strängar, t()-nycklar, mallar, kommentarer, regex och JSX-text', () => {
  const src = "const a = t('Hej {n}', { n }); // 'kommentar'\n/* \"block\" */ const r = /'\"/g; const b = `x ${y ? 'ja' : t('nej')} z`; f(tn(2, 'en', 'två'));\n<Text style={s}>Lös text</Text>";
  const { strings, code } = tsScan(src);
  assert.deepEqual(strings.map((s) => [s.text, s.key]), [['Hej {n}', true], ['ja', false], ['nej', true], ['x \0 z', false], ['en', true], ['två', true]]);
  assert.equal(strings.at(-1).line, 2);
  assert.deepEqual(code.flatMap((c) => jsxText(c.text)), ['Lös text']);
  assert.equal(tsScan("x.t('a')").strings[0].key, false, 'en metod som heter t räknas inte');
  assert.ok(SWEDISH.test('Spela') && SWEDISH.test('Lägg till') && !SWEDISH.test('st.av') && !SWEDISH.test('Play') && !SWEDISH.test('server-outline'));
});

test('Expo-appen: inga svenska texter utanför t() (de översätts i src/i18n-en.ts)', () => {
  const found = [], used = new Set();
  for (const f of sources()) {
    const { strings, code } = tsScan(read(path.join(APP, f)));
    const bad = (text, line, what) => {
      const ok = ALLOWED.find((a) => a.file === f && a.texts.includes(text));
      if (ok) { used.add(ok.file + '|' + text); return; }
      found.push(`${f}:${line}: ${what} "${text.replace(/\0/g, '${…}').trim()}"`);
    };
    for (const s of strings) {
      if (s.key && !s.subs) continue;
      if (s.key && s.subs) { found.push(`${f}:${s.line}: mall med \${…} i t() – använd t('… {namn} …', { namn })`); continue; }
      if (SWEDISH.test(s.text)) bad(s.text, s.line, 'sträng');
    }
    for (const c of code) for (const text of jsxText(c.text)) if (SWEDISH.test(text)) bad(text, c.line, 'JSX-text');
  }
  assert.deepEqual(found, [], `svensk text utanför t() – skriv t('…') och lägg den engelska raden i apps/expo/src/i18n-en.ts:\n${found.join('\n')}`);
  const stale = ALLOWED.flatMap((a) => a.texts.filter((x) => !used.has(a.file + '|' + x)).map((x) => `${a.file}: ${x}`));
  assert.deepEqual(stale, [], 'undantag som inte längre behövs');
});

// ---------- katalogen ----------

/** Objektet i en fil som bara innehåller ett objekt med strängar: { svensk: engelsk } */
function catalog(file, start) {
  const src = read(file);
  const body = src.slice(src.indexOf('{', src.indexOf(start)), src.lastIndexOf('}') + 1);
  return new Function(`return (${body});`)();
}
const appEn = () => catalog(path.join(APP, 'src', 'i18n-en.ts'), 'const EN');
const webEn = () => { const self = {}; new Function('self', read(path.join(APP, '..', '..', 'web', 'i18n', 'en.js')))(self); return self.BX_I18N; };
const vars = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');

test('i18n-en.ts: varje t() har en engelsk rad, varje rad används, samma platshållare och ingen svenska', () => {
  const en = appEn();
  const keys = new Set();
  for (const f of sources()) for (const s of tsScan(read(path.join(APP, f))).strings) if (s.key && !s.subs) keys.add(s.text);
  assert.ok(keys.size > 300, `för få texter: ${keys.size}`);
  const missing = [...keys].filter((k) => typeof en[k] !== 'string');
  assert.deepEqual(missing, [], 'används i t() men saknar engelsk rad i i18n-en.ts');
  const unused = Object.keys(en).filter((k) => !keys.has(k));
  assert.deepEqual(unused, [], 'rader i i18n-en.ts som inte används');
  const bad = [];
  for (const [k, v] of Object.entries(en)) {
    // Pluralformen för 1 ("1 avsnitt") behöver inte {n}: talet står redan i texten
    if (vars(k) !== vars(v)) bad.push(`${k}: platshållare {${vars(k)}} ≠ {${vars(v)}}`);
    if (/[åäöÅÄÖ]/.test(v)) bad.push(`${k}: svenska i engelskan: ${v}`);
    if (!v.trim()) bad.push(`${k}: tom översättning`);
  }
  assert.deepEqual(bad, []);
});

test('i18n-en.ts: texter som också finns i webben har samma engelska som web/i18n/en.js', () => {
  const en = appEn(), web = webEn();
  const differ = Object.keys(en).filter((k) => typeof web[k] === 'string' && web[k] !== en[k]).map((k) => `${k}: appen "${en[k]}", webben "${web[k]}"`);
  assert.deepEqual(differ, []);
  const shared = Object.keys(en).filter((k) => typeof web[k] === 'string').length;
  assert.ok(shared >= 140, `bara ${shared} texter delas med webben`);
});

test('api.ts skickar Accept-Language efter appens språk', () => {
  const src = read(path.join(APP, 'src', 'api.ts'));
  assert.match(src, /'Accept-Language': acceptLanguage\(\)/);
});

// ---------- i18n.ts i Node ----------

const skip = process.features?.typescript ? false : 'Node utan TypeScript-stöd';
let I = null, core = null;
if (!skip) {
  const { register } = await import('node:module');
  register('./helpers/expo-loader.mjs', import.meta.url);
  I = await import('../apps/expo/src/i18n.ts');
  core = await import('../apps/expo/src/offlinecore.ts');
}

test('språket efter telefonen: svenska ger svenska, allt annat engelska', { skip }, () => {
  assert.equal(I.langOfLocales(['sv-SE']), 'sv');
  assert.equal(I.langOfLocales(['sv']), 'sv');
  assert.equal(I.langOfLocales(['sv-FI', 'fi-FI']), 'sv');
  assert.equal(I.langOfLocales(['en-US']), 'en');
  assert.equal(I.langOfLocales(['fi-FI', 'sv-SE']), 'en', 'det första språket avgör');
  assert.equal(I.langOfLocales(['nb-NO']), 'en', 'som Android-appen: bara svenska ger svenska');
  assert.equal(I.langOfLocales(['de-DE']), 'en');
  assert.equal(I.langOfLocales([]), 'en');
});

test('valt språk: t(), tn(), tal och Accept-Language', { skip }, (t) => {
  t.after(() => I.setLangChoice(''));
  let changed = 0;
  const off = I.onLangChange(() => changed++);
  I.setLangChoice('sv');
  assert.equal(I.lang, 'sv'); assert.equal(I.locale, 'sv-SE'); assert.equal(I.acceptLanguage(), 'sv');
  assert.equal(I.t('Spela'), 'Spela');
  assert.equal(I.t('Säsong {n}', { n: 2 }), 'Säsong 2');
  assert.equal(I.tn(1, '1 avsnitt', '{n} avsnitt'), '1 avsnitt');
  assert.equal(I.tn(3, '1 avsnitt', '{n} avsnitt'), '3 avsnitt');
  assert.equal(core.fmtSize(1.234e9), '1,2 GB');
  I.setLangChoice('en');
  assert.equal(I.lang, 'en'); assert.equal(I.acceptLanguage(), 'en');
  assert.match(I.locale, /^en-/);
  assert.equal(I.t('Spela'), 'Play');
  assert.equal(I.t('Säsong {n}', { n: 2 }), 'Season 2');
  assert.equal(I.t('Inga träffar på "{q}".', { q: 'x' }), 'No results for "x".');
  assert.equal(I.t('Ingen sådan text {v}', { v: 1 }), 'Ingen sådan text 1', 'okänd nyckel: svenskan');
  assert.equal(I.tn(1, '1 avsnitt', '{n} avsnitt'), '1 episode');
  assert.equal(I.tn(3, '1 avsnitt', '{n} avsnitt'), '3 episodes');
  assert.equal(I.tn(1200, '{n} låt', '{n} låtar'), '1,200 songs');
  assert.equal(core.fmtSize(1.234e9), '1.2 GB');
  assert.equal(core.qualityLabel('orig'), 'Full resolution');
  assert.equal(core.progressOf({ state: 'paused', files: [{}], size: 2e9, got: 1e9 }).text, 'Paused · 1.0 GB of 2.0 GB');
  assert.equal(core.videoEntry({ id: 1, kind: 'episode', title: 'x', showTitle: 'Serien', season: 1, episode: 3 }, '480').sub, 'Serien · S1 · E3');
  assert.match(core.screenGate({ status: { limited: true, day: '2026-11-27', remaining: 0 } }, new Date(2026, 10, 27, 12)).message, /^Time is up for today/);
  assert.ok(changed >= 2, 'appen ritas om när språket byts');
  const before = changed; I.setLangChoice('en'); assert.equal(changed, before, 'samma språk igen: ingen omritning');
  off();
});
