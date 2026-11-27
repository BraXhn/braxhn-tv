// Språket i appen: svenska eller engelska, som webben (web/js/core.js). Svenska är källspråket: den svenska texten ÄR
// nyckeln, t('Spela') ger 'Spela' på svenska och 'Play' på engelska ur i18n-en.ts. Saknas en översättning visas
// svenskan. Variabler: t('Visa {n} titlar', { n }). Plural: tn(n, '1 avsnitt', '{n} avsnitt').
// Telefonens språk avgör (svenska → svenska, allt annat → engelska, som Android-appen), om man inte valt själv under
// Konto. Ett byte ritar om hela appen (App.tsx lyssnar på onLangChange), så t() får användas var som helst.
// Ingen import av react-native: modulen används också av offlinecore.ts, som testas i Node.
import EN from './i18n-en';

export type Lang = 'sv' | 'en';
/** Valet under Konto: '' = telefonens språk */
export type LangChoice = '' | Lang;

/** Telefonens språk i ordning (webbläget: webbläsarens lista) */
function deviceLocales(): string[] {
  const nav: any = (globalThis as any).navigator;
  const list: string[] = [];
  if (Array.isArray(nav?.languages)) list.push(...nav.languages);
  if (typeof nav?.language === 'string') list.push(nav.language);
  try { list.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch {}
  return list.filter((x) => typeof x === 'string' && x);
}
/** Svenska om det första språket är svenska, annars engelska */
export function langOfLocales(list: string[]): Lang {
  return /^sv\b/i.test(list[0] || '') ? 'sv' : 'en';
}
// Engelska: telefonens egen engelska variant (en-US ger 12-timmarsklocka och månad först), annars en-GB (24 timmar,
// dag först – närmast svenskan). Som englishLocale i web/js/core.js.
function englishLocale(list: string[]): string {
  for (const x of list) {
    if (!/^en[-_][a-z]{2,3}$/i.test(x)) continue;
    try { const c = Intl.getCanonicalLocales(x.replace('_', '-'))[0]; if (Intl.DateTimeFormat.supportedLocalesOf([c]).length) return c; } catch {}
  }
  return 'en-GB';
}

let choice: LangChoice = '';
/** Språket som används just nu */
export let lang: Lang = langOfLocales(deviceLocales());
/** Locale för Intl (datum, tid och tal) */
export let locale = lang === 'en' ? englishLocale(deviceLocales()) : 'sv-SE';
const listeners = new Set<() => void>();

export const langChoice = () => choice;
/** Väljer språk ('' = telefonens). Ritar om appen om språket ändras. */
export function setLangChoice(c: LangChoice) {
  choice = c === 'sv' || c === 'en' ? c : '';
  const dev = deviceLocales();
  const next: Lang = choice || langOfLocales(dev);
  const loc = next === 'en' ? englishLocale(dev) : 'sv-SE';
  if (next === lang && loc === locale) return;
  lang = next; locale = loc;
  listeners.forEach((fn) => fn());
}
export function onLangChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
/** Accept-Language till servern: den översätter sina fel och hyllnamn efter det (server/i18n.js acceptLang) */
export const acceptLanguage = () => (lang === 'en' ? 'en' : 'sv');

const fill = (s: string, v?: Record<string, unknown>) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s);
/** Översätter en svensk text (nyckeln) och fyller i {variabler} */
export function t(s: string, v?: Record<string, unknown>): string {
  if (lang === 'en') { const r = EN[s]; if (typeof r === 'string') s = r; }
  return fill(s, v);
}
/** Plural: tn(n, '{n} låt', '{n} låtar') – formen väljs med Intl.PluralRules för språket, {n} fylls i med talet */
export function tn(n: number, one: string, other: string, v?: Record<string, unknown>): string {
  let k: string;
  try { k = new Intl.PluralRules(locale).select(n); } catch { k = n === 1 ? 'one' : 'other'; }
  return t(k === 'one' ? one : other, { n: fmtNum(n), ...v });
}
/** Talet med språkets decimaltecken och tusentalsavgränsare */
export const fmtNum = (n: number, o?: Intl.NumberFormatOptions) => {
  try { return Number(n).toLocaleString(locale, o); } catch { return String(n); }
};
