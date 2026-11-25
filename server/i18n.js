// Serverns texter på engelska: samma katalog som webben (web/i18n/en.js), så att webben och servern inte glider isär.
// Svenska är källspråket: nyckeln är den svenska texten, värdet den engelska. Saknas en nyckel blir texten svensk.
//
// Språket för ett svar (langOf): profilens val (users.lang) om det finns, annars kakan bxlang som webben sätter
// (inloggningssidan), annars Accept-Language (apparna skickar telefonens språk) och annars svenska som förut.
// Webbens egna inloggningar utan sparat val får svenska, precis som sidan (pageLang i http/router.js), så att fel
// och sida har samma språk. router.js sätter req[LANG] när inloggningen är klar; fail() och send() läser det.
//
// Vad som översätts här:
// - felmeddelanden i fail() och { error } i svar med felkod (util.js send) – exakt nyckel, eller en nyckel med
//   platshållare ("Högst {n} samlingar per profil") som matchas mot den färdiga svenska texten (matchTemplate)
// - "Avsnitt N" som titel på avsnitt utan namn (sparas på svenska i databasen; skrivs om när svaret byggs)
// - texter som routerna själva bygger med tr(lang, …): hyllnamn, skärmtid, spåretiketter, notiser m.m.
// Det som sparas i databasen ändras aldrig – översättningen sker när svaret byggs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const FILE = path.join(import.meta.dirname, '..', 'web', 'i18n', 'en.js');
let EN = {};
try { const ctx = { self: {} }; vm.runInNewContext(fs.readFileSync(FILE, 'utf8'), ctx, { timeout: 2000 }); EN = ctx.self.BX_I18N || {}; }
catch (e) { console.warn('[i18n] kunde inte läsa web/i18n/en.js – servern svarar på svenska:', e.message); }
/** Katalogen (svensk text → engelsk) */
export const catalog = () => EN;

export const LANG = Symbol('språk');
/** Accept-Language → 'sv' | 'en': nordiska språk → svenska, engelska och alla andra språk → engelska, ingen header → svenska */
export function acceptLang(h) {
  const list = String(h || '').split(',').map((p, i) => { const [tag, ...o] = p.trim().toLowerCase().split(';'); const q = o.map(x => /^\s*q=([\d.]+)/.exec(x)?.[1]).find(Boolean); return { tag, q: q ? +q : 1, i }; })
    .filter(x => x.tag).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of list) {
    if (/^(sv|nb|nn|no|da)\b/.test(tag)) return 'sv';
    if (/^en\b/.test(tag)) return 'en';
  }
  return list.some(x => x.tag !== '*') ? 'en' : 'sv';
}
/** Språket för förfrågan: profilen, sedan kakan bxlang, sedan Accept-Language, sedan svenska (se överst) */
export function langOf(req, user) {
  if (user?.lang === 'en' || user?.lang === 'sv') return user.lang;
  if (user && user.kind === 'web') return 'sv';
  const ck = /(?:^|;\s*)bxlang=(sv|en)(?:;|$)/.exec(req?.headers?.cookie || '')?.[1];
  return ck || acceptLang(req?.headers?.['accept-language']);
}
/** Språket som redan valts för förfrågan (router.js), annars utan inloggning (kaka och Accept-Language) */
export const reqLang = (req) => req?.[LANG] || (req?.headers ? langOf(req, null) : 'sv');

const fill = (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => k in v ? String(v[k]) : m) : s;
/** Översätter en svensk text (nyckeln) till språket och fyller i {variabler}. Okänd nyckel: svenska. */
export function tr(lang, s, v) {
  if (lang === 'en' && typeof s === 'string') { const r = EN[s]; if (typeof r === 'string') s = r; }
  return fill(s, v);
}

// ---------- färdiga svenska texter med variabler ----------
// Nycklar med platshållare blir mönster: "Högst {n} samlingar per profil" → /^Högst (.+?) samlingar per profil$/.
// Bara nycklar med minst 10 tecken fast text räknas (inte "{a} och {b}"), och den med mest fast text vinner.
let TEMPLATES = null;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function templates() {
  if (TEMPLATES) return TEMPLATES;
  TEMPLATES = [];
  for (const [k, v] of Object.entries(EN)) {
    if (typeof v !== 'string' || !/\{\w+\}/.test(k) || /</.test(k)) continue;
    const parts = k.split(/\{(\w+)\}/);
    const fixed = parts.filter((_, i) => i % 2 === 0).join('');
    if (fixed.replace(/\s/g, '').length < 10) continue;
    const names = parts.filter((_, i) => i % 2 === 1);
    if (new Set(names).size !== names.length) continue;
    const re = new RegExp('^' + parts.map((p, i) => i % 2 ? '([\\s\\S]+?)' : esc(p)).join('') + '$');
    TEMPLATES.push({ re, names, v, w: fixed.length });
  }
  TEMPLATES.sort((a, b) => b.w - a.w);
  return TEMPLATES;
}
/** En färdig svensk text (t.ex. ett felmeddelande byggt med ${…}) på engelska, eller null om ingen nyckel passar */
export function matchTemplate(s) {
  if (typeof s !== 'string' || s.length > 2000) return null;
  for (const t of templates()) {
    const m = t.re.exec(s);
    if (m) return fill(t.v, Object.fromEntries(t.names.map((n, i) => [n, m[i + 1]])));
  }
  return null;
}
/** Ett felmeddelande (svensk text) på språket: exakt nyckel, annars ett mönster, annars oförändrat */
export function trMessage(lang, s) {
  if (lang !== 'en' || typeof s !== 'string' || !s) return s;
  const r = EN[s];
  if (typeof r === 'string') return r;
  return matchTemplate(s) ?? s;
}

// ---------- avsnitt utan namn ----------
// Skannern sparar "Avsnitt N" när filen och TMDB saknar titel (och flera ställen känner igen just den formen).
// På engelska skrivs den om i JSON-svaret, i fälten som bär en titel.
const EP_RE = /"(title|epTitle|nextTitle|episodeTitle)":"Avsnitt (\d{1,5})"/g;
export const localizeJson = (lang, body) => lang === 'en' && typeof body === 'string' && body.includes('"Avsnitt ') ? body.replace(EP_RE, (_, k, n) => `"${k}":${JSON.stringify(tr('en', 'Avsnitt {n}', { n }))}`) : body;

// ---------- spårens etiketter ----------
// stream.js subtitlesOf bygger etiketterna på svenska ("Spår 3", "swe (bild)", "Extern (fil)", "sv (nedladdad)") och
// webben tolkar dem (web/js/ui/tracklabel.js, som förstår båda språken). Översätts när svaret byggs.
export function subLabel(lang, label) {
  if (lang !== 'en' || typeof label !== 'string') return label;
  return label.replace(/^Spår (\d+)( \(bild\))?$/, (_, n, b) => tr(lang, 'Spår {n}', { n }) + (b || ''))
    .replace(/^Extern(?= \(fil\)$)/, () => tr(lang, 'Extern'))
    .replace(/ \((fil|bild|nedladdad)\)$/, (_, x) => ' ' + tr(lang, `(${x})`));
}
/** Undertextspåren ({ label, … }) med etiketterna på språket */
export const subsIn = (lang, list) => lang === 'en' && Array.isArray(list) ? list.map(s => s && typeof s.label === 'string' ? { ...s, label: subLabel(lang, s.label) } : s) : list;

// ---------- texter som översätts när mottagaren är känd (notiser) ----------
const MSG = Symbol('text');
/** En text att översätta senare: msg('Konto spärrat'), msg('{n} nya avsnitt', { n }) – värdena kan själva vara msg() */
export const msg = (key, vars) => ({ [MSG]: true, key, vars });
/** msg() eller en färdig svensk text på språket */
export function resolve(lang, x) {
  if (x && x[MSG]) return tr(lang, x.key, x.vars && Object.fromEntries(Object.entries(x.vars).map(([k, v]) => [k, resolve(lang, v)])));
  return typeof x === 'string' ? trMessage(lang, x) : x;
}
