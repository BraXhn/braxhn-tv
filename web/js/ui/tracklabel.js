// @lazy
// Undertextspårens namn så som de visas (titelsidan, spelarens inställningar, Ögonblick): servern skickar etiketter
// byggda av filens språkkod – "sv (fil)", "Kommentar · eng", "swe (bild)". Här blir koden språkets namn på det
// valda språket ("Svenska (fil)", "Swedish (file)") och tilläggen översätts. Importerar bara core.js.
import { lang, t } from '../core.js';

const names = new Map();
/** Språkets namn (Intl.DisplayNames) med stor bokstav; okänd kod eller ingen Intl: koden som den är */
export function langName(code, loc = lang) {
  if (!code || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(code)) return code || '';
  try {
    if (!names.has(loc)) names.set(loc, new Intl.DisplayNames([loc], { type: 'language' }));
    const n = names.get(loc).of(code);
    if (n && n.toLowerCase() !== code.toLowerCase()) return n[0].toUpperCase() + n.slice(1);
  } catch {}
  return code;
}
// Tillägg i externa filers namn (Film.sv.forced.srt) – övriga visas som de är
const FLAGS = { forced: () => t('tvingad'), sdh: () => 'SDH', hi: () => 'SDH', cc: () => 'CC' };
// Servern skriver etiketten på profilens språk (server/i18n.js subLabel) – båda formerna känns igen
const SUFFIX = { fil: () => t('(fil)'), bild: () => t('(bild)'), nedladdad: () => t('(nedladdad)'), file: () => t('(fil)'), image: () => t('(bild)'), downloaded: () => t('(nedladdad)') };

/**
 * Ljudspårets namn för visning: "Svenska · Kommentar · opus · 2ch" i stället för "swe · Kommentar · opus · 2ch".
 * Utan språk (eller "und") heter spåret Ljud. Står språket redan i spårets titel visas det en gång.
 * @param {{ lang?: string|null, title?: string|null, codec?: string|null, channels?: number|null }} a  spåret som servern skickar det (item.audio)
 * @param {{ title?: boolean, loc?: string }} [o]  title: false = utan spårets titel (titelsidans korta rad)
 */
export function audioLabel(a, { title = true, loc = lang } = {}) {
  const name = a?.lang && a.lang !== 'und' ? langName(a.lang, loc) : t('Ljud');
  const tt = title && a?.title && !String(a.title).toLowerCase().includes(name.toLowerCase()) ? a.title : '';
  return [name, tt, a?.codec, a?.channels ? a.channels + 'ch' : ''].filter(Boolean).join(' · ');
}

/**
 * Undertextspårets namn för visning.
 * @param {{ label?: string, lang?: string|null, source?: string }} s  spåret som servern skickar det (item.subtitles)
 */
export function subLabel(s, loc = lang) {
  const m = /^(.*?)(?: \((fil|bild|nedladdad|file|image|downloaded)\))?$/.exec(String(s?.label ?? ''));
  let body = m[1];
  const suffix = m[2] ? ' ' + SUFFIX[m[2]]() : '';
  const track = /^(?:Spår|Track) (\d+)$/.exec(body);
  if (track) body = t('Spår {n}', { n: track[1] });
  else if (s.source === 'external' || s.source === 'downloaded') {
    // Filnamnets tillägg: första delen är språket (rättat språk i s.lang går före), resten t.ex. forced/sdh
    // (Film.forced.srt har inget språk: "forced" är ett tillägg, inte en språkkod)
    const parts = body.split(/[._-]+/).filter(Boolean);
    const flag = (x) => FLAGS[x.toLowerCase()]?.() || x;
    const first = parts[0] || '';
    const name = (first === 'Extern' || first === 'External') && !s.lang ? t('Extern') : ['forced', 'sdh', 'cc'].includes(first.toLowerCase()) ? flag(first) : langName(s.lang || first, loc);
    body = [name, ...parts.slice(1).map(flag)].join(' · ');
  } else {
    // Inbäddat spår: "titel · språkkod" eller bara en av dem. Titeln behålls, koden blir språkets namn – och står
    // språket redan i titeln ("Svenska · swe") visas det en gång.
    const parts = body.split(' · ');
    if (s.lang && parts[parts.length - 1] === s.lang) {
      const name = langName(s.lang, loc);
      parts.pop();
      if (!parts.some(p => p.toLowerCase().includes(name.toLowerCase()))) parts.push(name);
    }
    body = parts.join(' · ');
  }
  return body + suffix;
}
