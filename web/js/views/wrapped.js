// Vy: årssammanfattning
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, api, esc, main, me, views, t, locale } from '../core.js';
import { art } from '../ui/cards.js';
import { emptyState } from '../ui/states.js';

// ---------- Årssammanfattning ----------
const MONTHS = [t('jan'), t('feb'), t('mar'), t('apr'), t('maj'), t('jun'), t('jul'), t('aug'), t('sep'), t('okt'), t('nov'), t('dec')];
views.wrapped = async (year, uid) => {
  year = parseInt(year) || new Date().getFullYear();
  const w = await api(`/wrapped/${year}${uid ? '?user=' + encodeURIComponent(uid) : ''}`);
  const h = (x) => (x || 0).toLocaleString(locale, { maximumFractionDigits: 1 });
  const yrs = [...new Set([year, new Date().getFullYear(), ...w.years])].sort((a, b) => b - a);
  const other = w.user.id !== me.id;
  const maxM = Math.max(1, ...w.video.months);
  const empty = !w.video.plays && !w.music.plays && !w.books.list.length;
  const rows = (list, f) => list.length ? `<table>${list.map((x, i) => `<tr><td class="muted">${i + 1}</td>${f(x)}</tr>`).join('')}</table>` : '<p class="muted">–</p>';
  main.innerHTML = `<div class="toolbar"><h1>${other ? t('Året för ') + esc(w.user.name) : t('Ditt år')} – ${year}</h1>
    <select id="wy" aria-label="${t('År')}">${yrs.map(y => `<option value="${y}"${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select>
    ${w.users ? `<select id="wu" aria-label="${t('Användare')}">${w.users.map(u => `<option value="${+u.id}"${u.id === w.user.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}</div>
    ${empty ? emptyState({ icon: '📊', title: t('Ingen statistik för {year}', { year }), text: t('Titta på film och serier eller lyssna på musik och ljudböcker så fylls sammanfattningen på.') }) : `
    <p class="wrap-hero">${t('{v} tittade och lyssnade i <b>{hours} timmar</b> under {year}{v2}.', { v: other ? esc(w.user.name) : t('Du'), hours: h(w.hours), year, v2: w.topGenre ? ` ${t('– favoritgenren var <b>{topGenre}</b>', { topGenre: esc(w.topGenre) })}` : '' })}</p>
    <div class="tiles">
      <div class="tile"><b>${h(w.video.hours)} h</b><span>${t('film och tv')}</span></div>
      <div class="tile"><b>${w.video.movies}</b><span>${t('filmer')}</span></div>
      <div class="tile"><b>${w.video.episodes}</b><span>${t('avsnitt')}</span></div>
      <div class="tile"><b>${h(w.music.hours)} h</b><span>${t('musik ({plays} spelningar)', { plays: w.music.plays })}</span></div>
      <div class="tile"><b>${h(w.books.hours)} h</b><span>${t('ljudböcker')}</span></div>
      <div class="tile"><b>${esc(w.topGenre || '–')}</b><span>${t('favoritgenre')}</span></div>
    </div>
    ${w.video.titles.length ? `<section class="section"><h2>${t('Mest sett')}</h2><div class="shelf">${w.video.titles.map((tt, i) =>
      `<a class="card" href="#/item/${+tt.id}">${art({ id: tt.id, title: tt.title, kind: 'movie', poster: true })}<div class="t">${i + 1}. ${esc(tt.title)}</div>
      <div class="s">${tt.plays} ${tt.plays === 1 ? t('gång') : t('gånger')}</div></a>`).join('')}</div></section>` : ''}
    ${w.video.plays ? `<div class="panel"><h2>${t('Uppspelningar per månad')}</h2><div class="bars">${w.video.months.map((n, i) =>
      `<div class="bar" title="${MONTHS[i]}: ${n}"><i style="height:${Math.max(2, n / maxM * 100)}%"></i><span>${MONTHS[i]}</span></div>`).join('')}</div></div>` : ''}
    <div class="grid2">
      <div class="panel"><h2>${t('Genrer')}</h2>${rows(w.video.genres, g => `<td>${esc(g.name)}</td><td class="r">${g.plays}</td>`)}</div>
      <div class="panel"><h2>${t('Mest spelade artister')}</h2>${rows(w.music.artists, a => `<td><a href="#/artist/${+a.id}">${esc(a.name)}</a></td><td class="r">${a.plays} ggr</td>`)}</div>
      <div class="panel"><h2>${t('Mest spelade låtar')}</h2>${rows(w.music.tracks, t => `<td>${t.album ? `<a href="#/album/${+t.album}">${esc(t.title)}</a>` : esc(t.title)}<div class="muted small">${esc(t.artist || '')}</div></td><td class="r">${t.plays} ggr</td>`)}</div>
      <div class="panel"><h2>${t('Ljudböcker')}</h2>${rows(w.books.list, b => `<td><a href="#/book/${+b.id}">${esc(b.title)}</a><div class="muted small">${esc(b.author || '')}</div></td><td class="r">${b.finished ? t('Utläst') : t('Påbörjad')}</td>`)}</div>
    </div>`}`;
  const go = () => { const u = $('#wu')?.value; location.hash = `#/wrapped/${$('#wy').value}${u && +u !== me.id ? '/' + u : ''}`; };
  $('#wy').onchange = go;
  if ($('#wu')) $('#wu').onchange = go;
};
