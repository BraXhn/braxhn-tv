// Återanvändbara kort och hyllor: titlar, samlingar och personer
import { esc, hue, sxe } from '../core.js';

// ---------- kort ----------
export function art(it, land) {
  const pick = land ? (it.thumb ? 'thumb' : it.backdrop ? 'backdrop' : it.poster ? 'poster' : null)
    : (it.poster ? 'poster' : it.thumb ? 'thumb' : null);
  const imgId = land && !it.thumb && it.kind === 'episode' && it.show ? null : it.id;
  const h = hue(it.title);
  let html = `<div class="ph" style="--h1:hsl(${h} 45% 32%);--h2:hsl(${(h + 50) % 360} 50% 18%)">${esc(it.showTitle || it.title)}</div>`;
  if (pick && imgId) html += `<img loading="lazy" src="/api/image/${imgId}/${pick}" alt="" data-fb="1">`;
  if (it.kind === 'show') {
    const left = (it.episodes || 0) - (it.watchedEpisodes || 0);
    if (it.watched) html += `<span class="seen" title="Sedd">✓</span>`;
    else if (left > 0 && it.watchedEpisodes > 0) html += `<span class="badge" title="Osedda avsnitt">${left}</span>`;
  } else {
    if (it.watched) html += `<span class="seen" title="Sedd">✓</span>`;
    if (it.position > 0 && it.duration) html += `<div class="bar"><i style="width:${Math.min(100, it.position / it.duration * 100)}%"></i></div>`;
  }
  return `<div class="art">${html}</div>`;
}
export function card(it, land = false) {
  let t = it.title, s = it.year || '';
  if (it.kind === 'episode') { t = land && it.showTitle ? it.showTitle : it.title; s = `${sxe(it)}${land && it.showTitle ? ' · ' + esc(it.title) : ''}`; }
  if (it.kind === 'show') s = [it.year, it.episodes ? `${it.episodes} avsnitt` : ''].filter(Boolean).join(' · ');
  const href = it.kind === 'episode' && !land ? `#/item/${it.show}` : `#/item/${it.id}`;
  return `<a class="card${land ? ' land' : ''}" href="${href}" data-id="${it.id}">${art(it, land)}<div class="t">${esc(t)}</div><div class="s">${s}</div></a>`;
}

export function shelf(title, items, land = false, more = '') {
  return items?.length ? `<section class="section"><h2>${esc(title)} ${more}</h2><div class="shelf${land ? ' wide' : ''}">${items.map(i => card(i, land)).join('')}</div></section>` : '';
}
export function colCard(c) {
  const h = hue(c.name);
  return `<a class="card" href="#/collection/${c.id}"><div class="art"><div class="ph" style="--h1:hsl(${h} 45% 32%);--h2:hsl(${(h + 50) % 360} 50% 18%)">${esc(c.name)}</div>
    ${c.poster ? `<img loading="lazy" src="/api/collection-image/${c.id}/poster" alt="" data-fb="1">` : ''}<span class="badge">${c.count}</span></div>
    <div class="t">${esc(c.name)}</div><div class="s">${c.years?.[0] || ''}${c.years?.[1] && c.years[1] !== c.years[0] ? '–' + c.years[1] : ''}</div></a>`;
}

// ---------- Skådespelare och personsidor ----------
export const ROLE_NAME = { director: 'Regi', creator: 'Skapare' };
const initials = (n) => String(n || '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
export function personArt(p) {
  const h = hue(p.name);
  return `<div class="art"><div class="ph" style="--h1:hsl(${h} 30% 34%);--h2:hsl(${(h + 40) % 360} 35% 18%)">${esc(initials(p.name))}</div>
    ${p.image ? `<img loading="lazy" src="/api/people/${+p.id}/image" alt="" data-fb="1">` : ''}</div>`;
}
export const personCard = (p, sub = '') => `<a class="card pcard" href="#/person/${+p.id}">${personArt(p)}<div class="t">${esc(p.name)}</div><div class="s">${esc(sub)}</div></a>`;
export function castShelf(it) {
  if (!it.cast?.length) return '';
  return `<section class="section"><h2>Rollista</h2><div class="shelf people">${it.cast.map(p => personCard(p, p.role === 'cast' ? p.character || '' : ROLE_NAME[p.role] || '')).join('')}</div></section>`;
}
