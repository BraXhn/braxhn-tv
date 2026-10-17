// Återanvändbara kort och hyllor: titlar, samlingar och personer
import { esc, hue, sxe } from '../core.js';

// ---------- kort ----------
// Titlarna bakom korten som visas just nu – kortens meny (⋮) behöver hela titeln, inte bara id:t
const ITEMS = new Map();
/** Titeln bakom ett kort (för kortmenyn), eller undefined */
export const cardItem = (id) => ITEMS.get(+id);
/** Sparar en uppdaterad titel (efter en snabbåtgärd) */
export const setCardItem = (it) => ITEMS.set(it.id, it);

/** Bilden på ett kort: färgplatta med titeln som reserv, affisch/miniatyr ovanpå, märken och framsteg */
export function art(it, land) {
  const pick = land ? (it.thumb ? 'thumb' : it.backdrop ? 'backdrop' : it.poster ? 'poster' : null)
    : (it.poster ? 'poster' : it.thumb ? 'thumb' : null);
  const imgId = land && !it.thumb && it.kind === 'episode' && it.show ? null : it.id;
  const h = hue(it.title);
  let html = `<div class="ph" aria-hidden="true" style="--h1:hsl(${h} 45% 32%);--h2:hsl(${(h + 50) % 360} 50% 18%)">${esc(it.showTitle || it.title)}</div>`;
  // width/height ger bildens proportioner i förväg (ingen layoutförskjutning); data-fb tar bort trasiga bilder så att plattan syns
  if (pick && imgId) html += `<img loading="lazy" decoding="async" src="/api/image/${imgId}/${pick}" alt="" width="${land ? 480 : 300}" height="${land ? 270 : 450}" data-fb="1">`;
  if (it.kind === 'show') {
    const left = (it.episodes || 0) - (it.watchedEpisodes || 0);
    if (it.watched) html += `<span class="seen" title="Sedd" aria-hidden="true">✓</span>`;
    else if (left > 0 && it.watchedEpisodes > 0) html += `<span class="badge" title="Osedda avsnitt" aria-hidden="true">${left}</span>`;
  } else {
    if (it.watched) html += `<span class="seen" title="Sedd" aria-hidden="true">✓</span>`;
    if (it.position > 0 && it.duration) html += `<div class="bar" aria-hidden="true"><i style="width:${Math.min(100, it.position / it.duration * 100)}%"></i></div>`;
  }
  return `<div class="art">${html}</div>`;
}
/** Kortets namn för skärmläsare: titel, undertitel och läge i en mening */
function cardLabel(it, t, s) {
  const st = it.kind === 'show'
    ? (it.watched ? 'sedd' : it.watchedEpisodes > 0 ? `${(it.episodes || 0) - it.watchedEpisodes} osedda avsnitt` : '')
    : it.watched ? 'sedd' : it.position > 0 && it.duration ? `${Math.round(it.position / it.duration * 100)} % sett` : '';
  return [t, s, st].filter(Boolean).join(', ');
}
/**
 * Kort för en film, serie eller ett avsnitt: en länk till titeln och en menyknapp (⋮) med snabbåtgärder.
 * @param {object} it      Titel från servern (listItems)
 * @param {boolean} [land] Liggande bild (avsnitt, Fortsätt titta)
 * @param {{ menu?: boolean }} [o]  menu: false = utan menyknapp
 */
export function card(it, land = false, { menu = true } = {}) {
  ITEMS.set(it.id, it);
  let t = it.title, s = it.year ? String(it.year) : '';
  if (it.kind === 'episode') { t = land && it.showTitle ? it.showTitle : it.title; s = `${sxe(it)}${land && it.showTitle ? ' · ' + it.title : ''}`; }
  if (it.kind === 'show') s = [it.year, it.episodes ? `${it.episodes} avsnitt` : ''].filter(Boolean).join(' · ');
  const href = it.kind === 'episode' && !land ? `#/item/${it.show}` : `#/item/${it.id}`;
  return `<div class="card${land ? ' land' : ''}" data-id="${+it.id}"><a class="clink" href="${href}" aria-label="${esc(cardLabel(it, t, s))}">${art(it, land)}<div class="t">${esc(t)}</div><div class="s">${esc(s)}</div></a>`
    + (menu ? `<button type="button" class="cmenu" data-cmenu="${+it.id}" aria-haspopup="menu" aria-expanded="false" aria-label="Fler åtgärder för ${esc(t)}" title="Fler åtgärder"><span aria-hidden="true">⋮</span></button>` : '')
    + '</div>';
}

/** Rubrik och vågrät rad med kort. row = namn på raden (data-row) för kortmenyns val, t.ex. 'watchlist'. */
export function shelf(title, items, land = false, more = '', row = '') {
  return items?.length ? `<section class="section"><h2>${esc(title)} ${more}</h2><div class="shelf${land ? ' wide' : ''}"${row ? ` data-row="${esc(row)}"` : ''}>${items.map(i => card(i, land)).join('')}</div></section>` : '';
}
export function colCard(c) {
  const h = hue(c.name);
  return `<a class="card" href="#/collection/${c.id}"><div class="art"><div class="ph" aria-hidden="true" style="--h1:hsl(${h} 45% 32%);--h2:hsl(${(h + 50) % 360} 50% 18%)">${esc(c.name)}</div>
    ${c.poster ? `<img loading="lazy" src="/api/collection-image/${c.id}/poster" alt="" data-fb="1">` : ''}<span class="badge">${c.count}</span></div>
    <div class="t">${esc(c.name)}</div><div class="s">${c.years?.[0] || ''}${c.years?.[1] && c.years[1] !== c.years[0] ? '–' + c.years[1] : ''}</div></a>`;
}

// ---------- Skådespelare och personsidor ----------
export const ROLE_NAME = { director: 'Regi', creator: 'Skapare' };
const initials = (n) => String(n || '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
export function personArt(p) {
  const h = hue(p.name);
  return `<div class="art"><div class="ph" aria-hidden="true" style="--h1:hsl(${h} 30% 34%);--h2:hsl(${(h + 40) % 360} 35% 18%)">${esc(initials(p.name))}</div>
    ${p.image ? `<img loading="lazy" src="/api/people/${+p.id}/image" alt="" data-fb="1">` : ''}</div>`;
}
export const personCard = (p, sub = '') => `<a class="card pcard" href="#/person/${+p.id}">${personArt(p)}<div class="t">${esc(p.name)}</div><div class="s">${esc(sub)}</div></a>`;
export function castShelf(it) {
  if (!it.cast?.length) return '';
  return `<section class="section"><h2>Rollista</h2><div class="shelf people">${it.cast.map(p => personCard(p, p.role === 'cast' ? p.character || '' : ROLE_NAME[p.role] || '')).join('')}</div></section>`;
}
