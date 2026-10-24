// Musikmetadata från nätet i webben: artistsidan (bild, biografi, fakta, album per typ, relaterade artister, länkar),
// albumets beskrivning, "Fel artist?" och inställningarna i administrationen. Servern: server/musicmeta.js.
// Körs inget när modulen laddas utom definitioner (cirkulär import med views/music.js).
import { $, $$, act, api, coverImg, esc, fmtDay, hue, heroUrl, me, routeGen, toast, toastErr } from './core.js';
import { cover } from './views/music.js';
import { openDialog } from './ui/dialog.js';
import { emptyState, errorState, loadingState } from './ui/states.js';

/** Artistens bild: fotot från nätet (eller artist.jpg) om det finns, annars senaste albumomslaget, annars en platta */
export function artistArt(a, cls = '') {
  if (a.image) {
    const h = hue(String(a.id));
    return `<div class="cover ${cls}" style="--h1:hsl(${h} 40% 30%);--h2:hsl(${(h + 60) % 360} 45% 16%)">♪${coverImg(`/api/music/artists/${+a.id}/image`, cls)}</div>`;
  }
  return cover(a.cover_album || a.id, !!a.cover_album, cls);
}
export const artistCard = (x, sub) => `<a class="card mcard" href="#/artist/${+x.id}">${artistArt(x, 'round')}<div class="t">${esc(x.name)}</div><div class="s">${esc(sub ?? `${x.albums} album`)}</div></a>`;

const COUNTRY = { SE: 'Sverige', NO: 'Norge', DK: 'Danmark', FI: 'Finland', IS: 'Island', GB: 'Storbritannien', US: 'USA', DE: 'Tyskland', FR: 'Frankrike',
  IE: 'Irland', CA: 'Kanada', AU: 'Australien', NL: 'Nederländerna', BE: 'Belgien', ES: 'Spanien', IT: 'Italien', JP: 'Japan', KR: 'Sydkorea', JM: 'Jamaica', NZ: 'Nya Zeeland' };
const day = (d) => !d ? '' : /^\d{4}$/.test(d) ? d : /^\d{4}-\d{2}$/.test(d) ? d.slice(0, 4) : fmtDay(d);
const yearsBetween = (a, b) => { const y = (s) => parseInt(String(s || '').slice(0, 4)); return y(a) && y(b || new Date().toISOString()) ? y(b || new Date().toISOString()) - y(a) : null; };
/** Fakta under namnet: "Grupp · Bildad 1990 i Eskilstuna · Upplöst 2016" eller "Född 7 juni 1979 (47 år) · Stockholm" */
export function facts(i) {
  if (!i) return [];
  const person = i.type === 'Person' || i.type === 'Character';
  const out = [];
  if (i.type && !person) out.push({ Group: 'Grupp', Orchestra: 'Orkester', Choir: 'Kör' }[i.type] || '');
  if (i.begin) {
    const age = person && !i.end ? yearsBetween(i.begin) : null;
    out.push(`${person ? 'Född' : 'Bildad'} ${day(i.begin)}${age && /^\d{4}-\d{2}-\d{2}$/.test(i.begin) ? ` (${age} år)` : ''}${i.beginArea ? ` i ${i.beginArea}` : ''}`);
  } else if (i.beginArea) out.push(`Från ${i.beginArea}`);
  if (i.end || (i.ended && !person)) out.push(`${person ? 'Död' : 'Upplöst'}${i.end ? ' ' + day(i.end) : ''}`);
  const origin = [i.area && i.area !== i.beginArea ? i.area : '', COUNTRY[i.country] && COUNTRY[i.country] !== i.area ? COUNTRY[i.country] : ''].filter(Boolean).join(', ');
  if (origin) out.push(origin);
  return out.filter(Boolean);
}
const safeUrl = (u) => /^https?:\/\//i.test(String(u || '')) ? String(u) : null;
export const linksHtml = (links = []) => {
  const ok = links.map(l => ({ ...l, url: safeUrl(l.url) })).filter(l => l.url);
  return ok.length ? `<section class="section"><h2>Länkar</h2><div class="row arlinks">${ok.map(l => `<a class="btn ghost small" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join('')}</div></section>` : '';
};
/** Biografi/beskrivning som fälls ut: kort först, "Visa mer" bara när texten är längre än rutan */
export function bioHtml(text, lang, url, id = 'arbio') {
  if (!text) return '';
  const src = url && safeUrl(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Wikipedia${lang === 'en' ? ' (engelska)' : ''} ↗</a>` : 'Wikipedia';
  return `<div class="arbio"><p class="overview bio clamp" id="${id}">${esc(text)}</p><div class="row"><button class="ghost small" id="${id}more" hidden aria-controls="${id}" aria-expanded="false">Visa mer</button><span class="muted small">Från ${src}</span></div></div>`;
}
export function bindBio(id = 'arbio') {
  const bio = $('#' + id), btn = $('#' + id + 'more');
  if (!bio || !btn) return;
  if (bio.scrollHeight > bio.clientHeight + 4) {
    btn.hidden = false;
    btn.onclick = () => { const closed = bio.classList.toggle('clamp'); btn.textContent = closed ? 'Visa mer' : 'Visa mindre'; btn.setAttribute('aria-expanded', String(!closed)); };
  }
}

// Album per typ i den ordning Apple Music/Plexamp visar dem
const KINDS = [['album', 'Album'], ['ep', 'EP'], ['single', 'Singlar'], ['live', 'Livealbum'], ['compilation', 'Samlingar'], ['soundtrack', 'Soundtrack'], ['remix', 'Remixer'], ['other', 'Övrigt']];
export const KIND_LABEL = { album: 'Album', ep: 'EP', single: 'Singel', live: 'Livealbum', compilation: 'Samling', soundtrack: 'Soundtrack', remix: 'Remixer', other: 'Övrigt' };
export function albumGroups(albums, albumCard) {
  const by = new Map();
  for (const a of albums) { const k = KIND_LABEL[a.type] ? a.type : 'album'; if (!by.has(k)) by.set(k, []); by.get(k).push(a); }
  // Bara en typ: en enda rubrik "Album" (som förut)
  if (by.size <= 1) return `<section class="section"><h2>Album</h2><div class="grid">${albums.map(albumCard).join('')}</div></section>`;
  return KINDS.filter(([k]) => by.has(k)).map(([k, label]) => `<section class="section"><h2>${label} <span class="muted small">${by.get(k).length}</span></h2><div class="grid">${by.get(k).map(albumCard).join('')}</div></section>`).join('');
}
/** Relaterade artister från MusicBrainz/Last.fm (bara de som finns i biblioteket) */
export const relatedHtml = (list = []) => list.length ? `<section class="section"><h2>Relaterade artister <span class="muted small">från MusicBrainz${list.some(x => x.source === 'lastfm') ? ' och Last.fm' : ''}</span></h2>
  <div class="shelf">${list.map(x => artistCard(x, x.relation || `${x.albums} album`)).join('')}</div></section>` : '';

/** Stora bilden överst: bakgrund (Fanart.tv) bakom en toning om den finns */
export const heroBg = (a) => a.backdrop ? `<img class="arbg" alt="" decoding="async" src="${esc(heroUrl(`/api/music/artists/${+a.id}/backdrop`))}" data-fb="1">` : '';

/** "Fel artist?": sök i MusicBrainz och välj rätt – matchningen låses. Även "Hämta igen", "Lås upp" och "Ingen av dem". */
export function matchArtist(a, onDone) {
  let changed = false;
  const h = openDialog({ title: 'Välj rätt artist', size: 'wide', onClose: () => { if (changed) onDone?.(); },
    body: `<form id="maf" class="row" style="align-items:flex-end"><div style="flex:1;min-width:200px"><label for="maq">Artistens namn</label><input id="maq" value="${esc(a.name)}"></div><button class="primary">Sök</button></form>
    <div id="mares" class="matchgrid" aria-live="polite">${loadingState({ kind: 'inline', label: 'Söker i MusicBrainz…' })}</div>
    <p class="muted small" id="malock">${a.info?.mbid ? `Matchad mot ${esc(a.info.name || a.name)} i MusicBrainz${a.info.locked ? ' (låst – ändras inte automatiskt)' : ''}.` : a.info?.state === 2 ? 'Ingen säker träff hittades automatiskt.' : ''}</p>`,
    actions: [
      { label: 'Hämta igen', id: 'marefresh', onClick: async () => { const r = await api(`/music/artists/${a.id}/match`, { method: 'POST', body: { refresh: true }, bg: true }); changed = true; toast(r.matched ? 'Hämtat' : 'Ingen säker träff – välj artist i listan'); } },
      { label: 'Lås upp (automatisk matchning)', id: 'maunlock', onClick: async () => { await api(`/music/artists/${a.id}/match`, { method: 'POST', body: { unlock: true }, bg: true }); changed = true; toast('Upplåst – matchas automatiskt i bakgrunden'); } },
      { label: 'Ingen av dem', id: 'manone', onClick: async () => { await api(`/music/artists/${a.id}/match`, { method: 'POST', body: { none: true }, bg: true }); changed = true; toast('Metadata från nätet borttagen för artisten'); } },
      { label: 'Stäng' }] });
  const d = h.el;
  $('#maunlock', d).hidden = !a.info?.locked;
  $('#marefresh', d).hidden = !a.info?.mbid;
  const search = async () => {
    $('#mares', d).innerHTML = loadingState({ kind: 'inline', label: 'Söker i MusicBrainz…' });
    try {
      const r = await api(`/music/artists/${a.id}/match?q=${encodeURIComponent($('#maq', d).value)}`, { bg: true });
      if (!d.isConnected) return;
      $('#maunlock', d).hidden = !r.locked;
      $('#mares', d).innerHTML = r.results.map((x, i) => `<button class="mcard${r.current?.mbid === x.mbid ? ' on' : ''}" data-mai="${i}">
        <div><b>${esc(x.name)}</b>${x.disambiguation ? ` <span class="muted">(${esc(x.disambiguation)})</span>` : ''}
        <div class="small">${esc([{ Person: 'Person', Group: 'Grupp', Orchestra: 'Orkester', Choir: 'Kör' }[x.type] || x.type, x.begin ? x.begin.slice(0, 4) : '', x.area || COUNTRY[x.country] || x.country].filter(Boolean).join(' · '))}</div>
        <div class="small muted">MusicBrainz · ${+x.score} % träff</div></div></button>`).join('') || emptyState({ compact: true, title: 'Inga träffar', text: 'Prova en annan stavning eller artistens namn på originalspråket.' });
      $$('[data-mai]', d).forEach(el => el.onclick = async () => {
        const x = r.results[+el.dataset.mai]; el.disabled = true;
        try { await api(`/music/artists/${a.id}/match`, { method: 'POST', body: { mbid: x.mbid }, bg: true }); changed = true; toast('Matchat'); h.close(); }
        catch (e) { toastErr(e); el.disabled = false; }
      });
    } catch (e) { if (d.isConnected) $('#mares', d).innerHTML = errorState(e, { compact: true }); }
  };
  $('#maf', d).onsubmit = (e) => { e.preventDefault(); search(); };
  search();
  return h;
}
export const isAdmin = () => !!me?.is_admin;

/** Inställningar och förlopp i administrationen */
export async function musicMetaAdmin(box) {
  const gen = routeGen;
  let s;
  try { s = await api('/music/meta'); } catch (e) { if (box.isConnected) box.innerHTML = `<h2>Musikmetadata och låttexter</h2>${errorState(e, { compact: true })}`; return; }
  if (gen !== routeGen || !box.isConnected) return;
  const st = s.status || {};
  box.innerHTML = `<h2>Musikmetadata och låttexter</h2>
    <p class="muted small" style="margin:0 0 8px">Artistbilder, biografier (svenska Wikipedia först), född/bildad, ursprung, genrer, länkar och albumtyper hämtas från MusicBrainz, Wikidata och Wikipedia i bakgrunden efter musikskanningen – högst ett anrop per sekund till MusicBrainz. Synkade låttexter hämtas från LRCLIB när en låt saknar egen .lrc-fil eller texttagg.</p>
    <p class="small"><b>${s.matched} av ${s.artists} artister matchade</b> <span class="muted">· ${s.bios} biografier · ${s.images} bilder${s.locked ? ` · ${s.locked} låsta` : ''}${s.unmatched ? ` · ${s.unmatched} utan säker träff (använd <i>Fel artist?</i> på artistens sida)` : ''} · ${s.lyricsFound} låttexter hämtade</span></p>
    <p class="small" role="status">${st.running ? `Pågår: ${esc(st.library || '')} ${st.done}/${st.total}` : 'Väntar på nästa skanning'}${st.error ? ` <span class="muted">· senaste fel: ${esc(st.error)}</span>` : ''}</p>
    <form id="mmform">
    <label class="switch"><input type="checkbox" id="mmen" ${s.enabled ? 'checked' : ''}> Hämta artist- och albuminformation från nätet</label>
    <label class="switch"><input type="checkbox" id="mmly" ${s.lyricsOnline ? 'checked' : ''}> Hämta låttexter från LRCLIB när de öppnas</label>
    <label class="switch"><input type="checkbox" id="mmlb" ${s.lyricsBackground ? 'checked' : ''}> … och i förväg i bakgrunden (för musikappar och bilen)</label>
    <div class="row"><div style="flex:1;min-width:220px"><label for="mmct">Kontaktadress till MusicBrainz (valfri, e-post eller webbadress)</label><input id="mmct" maxlength="200" value="${esc(s.contact || '')}" placeholder="du@exempel.se"></div>
    <div style="flex:1;min-width:220px"><label for="mmfa">Fanart.tv-nyckel (valfri, bättre artistbilder och bakgrunder)</label><input id="mmfa" autocomplete="off" placeholder="${s.fanartKeySet ? (s.fanartFromEnv ? 'Satt med FANART_API_KEY' : '•••••••• (sparad)') : 'Personlig nyckel från fanart.tv'}"></div></div>
    <p class="muted small" style="margin:4px 0 0">Skickas som: <code>${esc(s.userAgent)}</code>${s.lastfm ? ' · Last.fm-nyckeln (scrobbling) används för liknande artister' : ''}</p>
    <div class="row" style="margin-top:10px"><button class="primary">Spara</button><button type="button" class="ghost" id="mmre">Hämta om allt</button></div></form>`;
  $('#mmform', box).onsubmit = act(async (e) => {
    e.preventDefault();
    const body = { enabled: $('#mmen', box).checked, lyricsOnline: $('#mmly', box).checked, lyricsBackground: $('#mmlb', box).checked, contact: $('#mmct', box).value };
    if ($('#mmfa', box).value.trim()) body.fanartKey = $('#mmfa', box).value.trim();
    await api('/music/meta', { method: 'PUT', body }); toast('Sparat'); musicMetaAdmin(box);
  });
  $('#mmre', box).onclick = act(async () => { await api('/music/meta', { method: 'PUT', body: { refetchAll: true } }); toast('Hämtar om i bakgrunden'); musicMetaAdmin(box); });
}
