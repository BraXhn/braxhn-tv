// Återanvändbara kort och hyllor: titlar, säsonger, samlingar och personer
import { esc, hue, me, sxe, imgSrc, cardW, routeGen } from '../core.js';

// ---------- kort ----------
// Titlarna bakom korten som visas just nu – kortens meny (⋮) behöver hela titeln, inte bara id:t
const ITEMS = new Map();
/** Titeln bakom ett kort (för kortmenyn), eller undefined */
export const cardItem = (id) => ITEMS.get(+id);
/** Sparar en uppdaterad titel (efter en snabbåtgärd) */
export const setCardItem = (it) => ITEMS.set(it.id, it);
// Säsongskorten ("Nyligen tillagda" i seriebibliotek): show:säsong -> grupp från /api/home
const SEASONS = new Map();
/** Säsongsgruppen bakom ett säsongskort, eller undefined */
export const seasonItem = (show, season) => SEASONS.get(`${+show}:${+season}`);

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
// Platshållaren: bildens medelfärg från servern (ph, '#rrggbb') medan bilden laddas – som Jellyfins BlurHash –
// annars en färgplatta med titeln (också när bilden inte går att hämta, se .ph.c i style.css)
const HEX = /^#[0-9a-f]{6}$/i;
const placeholder = (text, color) => {
  if (color && HEX.test(color)) return `<div class="ph c" aria-hidden="true" style="background:${color}">${esc(text)}</div>`;
  const h = hue(text);
  return `<div class="ph" aria-hidden="true" style="--h1:hsl(${h} 30% 30%);--h2:hsl(${(h + 50) % 360} 30% 16%)">${esc(text)}</div>`;
};
// De första korten efter en navigering (första hyllan/raden, det man ser direkt) hämtas genast och med hög
// prioritet; resten laddas när de närmar sig skärmen
const EAGER = 8;
let eagerGen = -1, eagerLeft = 0;
const loadAttr = () => {
  if (eagerGen !== routeGen) { eagerGen = routeGen; eagerLeft = EAGER; }
  return eagerLeft-- > 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
};
/** Färgen för bilden ett kort visar (pick = poster/thumb/backdrop, own = titelns egen bild, inte seriens) */
const phOf = (it, pick, own) => !own ? (pick === 'poster' ? it.showPh : null)
  : pick === 'poster' ? it.ph : pick === 'thumb' ? it.phThumb : pick === 'backdrop' ? it.phBackdrop : null;
/** Märket uppe till höger: antal osedda avsnitt (mörk ruta) eller ✓ när allt är sett */
const countBadge = (n) => `<span class="badge" aria-hidden="true">${n}</span>`;
const seenBadge = () => `<span class="seen" title="Sedd" aria-hidden="true">✓</span>`;
const progressBar = (pos, dur) => `<div class="bar" aria-hidden="true"><i style="width:${Math.min(100, pos / dur * 100)}%"></i></div>`;

/** Bilden på ett kort: färgplatta med titeln som reserv, affisch/miniatyr ovanpå, märken och framsteg.
 *  css = bildens ungefärliga bredd i pixlar (standard: kortbredden), styr vilken storlek som hämtas */
export function art(it, land, css) {
  let pick = land ? (it.thumb ? 'thumb' : it.backdrop ? 'backdrop' : it.poster ? 'poster' : null)
    : (it.poster ? 'poster' : it.thumb ? 'thumb' : null);
  let imgId = land && !it.thumb && it.kind === 'episode' && it.show ? null : it.id;
  // Stående avsnittskort (Fortsätt titta): seriens affisch, som i Plex
  if (!land && it.kind === 'episode' && it.show && !it.poster && (it.showPoster || it.showThumb)) { imgId = it.show; pick = it.showPoster ? 'poster' : 'thumb'; }
  const show = pick && imgId;
  let html = placeholder(it.showTitle || it.title, show ? phOf(it, pick, imgId === it.id) : null);
  // width/height ger bildens proportioner i förväg (ingen layoutförskjutning); data-fb tar bort trasiga bilder så att plattan syns.
  // Storleken följer kortet (liggande kort är 1,9 kort breda); rutnätets kort kan bli något bredare än --cw (× 1,2).
  if (show) html += `<img ${loadAttr()} decoding="async" ${imgSrc(`/api/image/${imgId}/${pick}`, css || cardW() * (land ? 1.9 : 1.2))} alt="" width="${land ? 480 : 300}" height="${land ? 270 : 450}" data-fb="1">`;
  if (it.kind === 'show') {
    const left = (it.episodes || 0) - (it.watchedEpisodes || 0);
    if (it.watched) html += seenBadge();
    else if (left > 0) html += countBadge(left);
  } else {
    if (it.watched) html += seenBadge();
    if (it.position > 0 && it.duration) html += progressBar(it.position, it.duration);
  }
  return `<div class="art">${html}</div>`;
}
/** Kortets namn för skärmläsare: titel, undertitel och läge i en mening */
function cardLabel(it, parts) {
  const left = (it.episodes || 0) - (it.watchedEpisodes || 0);
  const st = it.kind === 'show'
    ? (it.watched ? 'sedd' : left > 0 ? `${left} osedda avsnitt` : '')
    : it.watched ? 'sedd' : it.position > 0 && it.duration ? `${Math.round(it.position / it.duration * 100)} % sett` : '';
  return [...parts, st].filter(Boolean).join(', ');
}
const se = (season, episode) => `S${season} · A${episode}`;
/** Rad 1–3 under bilden. Stående: titel, sedan år/avsnittstitel/säsonger och "S3 · A23" för avsnitt. */
function lines(it, land) {
  if (it.kind === 'episode') {
    if (land) return [land && it.showTitle ? it.showTitle : it.title, `${sxe(it)}${land && it.showTitle ? ' · ' + it.title : ''}`, ''];
    return [it.showTitle || it.title, it.showTitle ? it.title : '', se(it.season, it.episode)];
  }
  if (it.kind === 'show') return [it.title, it.seasons > 1 ? `${it.seasons} säsonger` : it.seasons === 1 ? '1 säsong' : it.year ? String(it.year) : '', ''];
  return [it.title, it.year ? String(it.year) : '', ''];
}
/** Knapparna ovanpå bilden: ▶ i mitten, ✎ nere till vänster (administratörer) och ⋮ nere till höger */
function overlay({ id, name, play, edit, menu, data = '' }) {
  let h = '';
  if (play) h += `<button type="button" class="cplay" ${data || `data-cplay="${+id}"`} aria-label="Spela ${esc(name)}" title="Spela">${PLAY_SVG}</button>`;
  if (edit) h += `<button type="button" class="cedit" data-cedit="${+edit}" aria-label="Redigera ${esc(name)}" title="Redigera"><span aria-hidden="true">✎</span></button>`;
  if (menu) h += `<button type="button" class="cmenu" data-cmenu="${+id}" aria-haspopup="menu" aria-expanded="false" aria-label="Fler åtgärder för ${esc(name)}" title="Fler åtgärder"><span aria-hidden="true">⋮</span></button>`;
  return h ? `<div class="ov">${h}</div>` : '';
}
const textLines = (t, s, s2) => `<div class="t">${esc(t)}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}${s2 ? `<div class="s s2">${esc(s2)}</div>` : ''}`;

/**
 * Kort för en film, serie eller ett avsnitt: en länk till titeln (ett namn för skärmläsare) och knappar ovanpå
 * bilden – ▶ spela direkt, ✎ redigera (administratörer) och ⋮ med snabbåtgärder.
 * @param {object} it      Titel från servern (listItems)
 * @param {boolean} [land] Liggande bild (avsnittslistor)
 * @param {{ menu?: boolean }} [o]  menu: false = utan knappar (bara länken)
 */
export function card(it, land = false, { menu = true } = {}) {
  ITEMS.set(it.id, it);
  const [t, s, s2] = lines(it, land);
  const href = it.kind === 'episode' && !land ? `#/item/${it.show}` : `#/item/${it.id}`;
  const name = it.kind === 'episode' && !land && it.showTitle ? `${it.showTitle} ${sxe(it)}` : t;
  return `<div class="card${land ? ' land' : ''}" data-id="${+it.id}"><a class="clink" href="${href}" aria-label="${esc(cardLabel(it, [t, s, s2]))}">${art(it, land)}${textLines(t, s, s2)}</a>`
    + (menu ? overlay({ id: it.id, name, play: true, edit: me?.adminHere ? it.id : 0, menu: true }) : '')
    + '</div>';
}

/**
 * Säsongskort för "Nyligen tillagda" i ett seriebibliotek: ett kort per serie och säsong med de nya avsnitten.
 * @param {{ show: number, showTitle: string, showPoster?: boolean, showThumb?: boolean, season: number, count: number, unwatched: number,
 *   latest?: { id: number, title: string, season: number, episode: number }, next?: { id: number, position: number } }} g
 */
export function seasonCard(g) {
  SEASONS.set(`${+g.show}:${+g.season}`, g);
  const t = g.showTitle, sn = g.season === 0 ? 'Specialavsnitt' : `Säsong ${g.season}`;
  const s = g.latest?.title || sn, s2 = g.latest ? se(g.season, g.latest.episode) : '';
  const st = g.unwatched > 0 ? `${g.unwatched} ${g.unwatched === 1 ? 'nytt osett avsnitt' : 'nya osedda avsnitt'}` : 'sedd';
  const label = [t, sn, g.latest ? `senaste avsnitt ${g.latest.episode}: ${g.latest.title}` : '', st].filter(Boolean).join(', ');
  const pick = g.showPoster ? 'poster' : g.showThumb ? 'thumb' : '';
  const img = pick ? `<img ${loadAttr()} decoding="async" ${imgSrc(`/api/image/${+g.show}/${pick}`, cardW() * 1.2)} alt="" width="300" height="450" data-fb="1">` : '';
  const badge = g.unwatched > 0 ? countBadge(g.unwatched) : seenBadge();
  return `<div class="card scard" data-show="${+g.show}" data-season="${+g.season}"><a class="clink" href="#/item/${+g.show}/${+g.season}" aria-label="${esc(label)}">`
    + `<div class="art">${placeholder(t, pick === 'poster' ? g.showPh : null)}${img}${badge}</div>${textLines(t, s, s2)}</a>`
    + overlay({ id: g.show, name: `${t} ${sn}`, play: !!g.next, data: g.next ? `data-cplay="${+g.next.id}" data-pos="${+g.next.position || 0}"` : '', edit: me?.adminHere ? g.show : 0, menu: true })
    + '</div>';
}

/** Rubrik och vågrät rad med kort. row = namn på raden (data-row) för kortmenyns val, t.ex. 'watchlist'. */
export function shelf(title, items, land = false, more = '', row = '') {
  return items?.length ? shelfHtml(title, items.map(i => card(i, land)).join(''), { land, more, row }) : '';
}
/**
 * En hylla med färdiga kort: rubrik till vänster, ‹ › till höger (läggs till av ui/shelves.js) och en rad som skrollar i sidled.
 * @param {string} title  Rubrik (escapas)
 * @param {string} cardsHtml
 * @param {{ land?: boolean, more?: string, row?: string, extra?: string }} [o]  more/extra = HTML efter rubriken
 */
export function shelfHtml(title, cardsHtml, { land = false, more = '', row = '', extra = '' } = {}) {
  return `<section class="section"><h2>${esc(title)}${extra ? ' ' + extra : ''}${more ? ' ' + more : ''}</h2><div class="shelf${land ? ' wide' : ''}"${row ? ` data-row="${esc(row)}"` : ''}>${cardsHtml}</div></section>`;
}
/** Kort för en samling: TMDB-samling eller egen samling (kind 'custom', omslaget är första titelns affisch) */
export function colCard(c) {
  const own = c.kind === 'custom';
  const src = own ? (c.cover ? `/api/image/${+c.cover}/poster` : '') : c.poster ? `/api/collection-image/${+c.id}/poster` : '';
  return `<a class="card${own ? ' ucol' : ''}" href="#/${own ? 'ucollection' : 'collection'}/${+c.id}"><div class="art">${placeholder(c.name)}
    ${src ? `<img ${loadAttr()} decoding="async" ${imgSrc(src, cardW() * 1.2)} alt="" width="300" height="450" data-fb="1">` : ''}<span class="badge">${+c.count}</span></div>
    <div class="t">${esc(c.name)}</div><div class="s">${c.years?.[0] || ''}${c.years?.[1] && c.years[1] !== c.years[0] ? '–' + c.years[1] : ''}</div></a>`;
}

// ---------- Skådespelare och personsidor ----------
export const ROLE_NAME = { director: 'Regi', creator: 'Skapare' };
const initials = (n) => String(n || '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
export function personArt(p, css) {
  const h = hue(p.name);
  return `<div class="art"><div class="ph" aria-hidden="true" style="--h1:hsl(${h} 30% 34%);--h2:hsl(${(h + 40) % 360} 35% 18%)">${esc(initials(p.name))}</div>
    ${p.image ? `<img loading="lazy" decoding="async" ${imgSrc(`/api/people/${+p.id}/image`, css || cardW(), 240)} alt="" width="185" height="185" data-fb="1">` : ''}</div>`;
}
export const personCard = (p, sub = '') => `<a class="card pcard" href="#/person/${+p.id}">${personArt(p)}<div class="t">${esc(p.name)}</div><div class="s">${esc(sub)}</div></a>`;
export function castShelf(it) {
  if (!it.cast?.length) return '';
  return `<section class="section"><h2>Rollista</h2><div class="shelf people">${it.cast.map(p => personCard(p, p.role === 'cast' ? p.character || '' : ROLE_NAME[p.role] || '')).join('')}</div></section>`;
}

/** Kanallogga (live-TV) med kanalnummer som reserv – används av live-vyerna och sökningen */
export const chLogo = (c, cls = '') => `<span class="chlogo ${cls}">${c.logo ? `<img src="/api/live/logo/${c.id}" alt="" loading="lazy" data-fb="1">` : ''}<i>${esc(c.number || c.name.slice(0, 3))}</i></span>`;
