// Ljudanalysen i webben: låtens ⋮-meny (låtradio, liknande låtar, ljudresa), stationerna på musikhemmet,
// liknande artister och förloppet i administrationen. Servern: server/sonic.js.
// Körs inget när modulen laddas utom definitioner (cirkulär import med views/music.js och audio.js).
import { $, $$, act, api, esc, fmtDur, libs, routeGen, toast } from './core.js';
import { playQueue, startRadio } from './audio.js';
import { addToPlaylist, bindTracks, cover, trackRows } from './views/music.js';
import { confirmDialog, openDialog } from './ui/dialog.js';
import { openMenu } from './ui/menu.js';
import { emptyState, errorState, loadingState } from './ui/states.js';

/** Låtens ⋮-meny (från låtlistorna). t = spåret i musik-API:ts format. */
export function trackMenu(anchor, t, point = null) {
  openMenu(anchor, [
    { icon: '📻', label: 'Starta låtradio', onSelect: act(() => startRadio({ trackId: t.id }, t.title)) },
    { icon: '≈', label: 'Liknande låtar', onSelect: act(() => similarDialog(t)) },
    { icon: '↝', label: 'Ljudresa härifrån…', onSelect: () => journeyDialog(t) },
    'separator',
    { icon: '+', label: 'Lägg till i spellista', onSelect: act(() => addToPlaylist([t.id])) },
    { label: 'Gå till albumet', href: `#/album/${+t.albumId}`, hidden: !t.albumId },
    { label: 'Gå till artisten', href: `#/artist/${+t.artistId}`, hidden: !t.artistId }
  ], { title: t.title, point });
}

const profileText = (p) => p ? [p.bpm ? `${Math.round(p.bpm)} BPM` : '', p.energy != null ? `energi ${Math.round(p.energy)} %` : '', p.key ? `tonart ${p.key}` : '',
  p.speech >= 30 ? `tal ${p.speech} %` : ''].filter(Boolean).join(' · ') : '';
/** Dialog med låtar som låter som t, och en knapp för att spela dem som radio. */
export async function similarDialog(t) {
  const h = openDialog({ title: `Liknande ${t.title}`, closeOnRoute: true, size: 'wide', body: loadingState({ kind: 'list', count: 6 }) });
  let r;
  try { r = await api(`/music/tracks/${+t.id}/similar?limit=30`, { bg: true }); }
  catch (e) { setBody(h, errorState(e, { compact: true })); return; }
  if (!r.analyzed || !r.trackList.length) {
    setBody(h, emptyState({ compact: true, icon: '≈', title: 'Inte analyserad än', text: 'Ljudanalysen går igenom biblioteket i bakgrunden. Prova igen om en stund – eller starta en låtradio, som då väljer efter artist och genre.' }));
    return;
  }
  setBody(h, `${r.profile ? `<p class="muted small">${esc(profileText(r.profile))}</p>` : ''}
    <div class="row" style="margin-bottom:10px"><button class="primary" id="simplay">▶ Spela</button><button class="ghost" id="simradio">📻 Starta låtradio</button></div>
    <div class="scrollbox tall">${trackRows(r.trackList, { showCover: true })}</div>`);
  bindTracks(r.trackList, h.el);
  $('#simplay', h.el).onclick = () => { playQueue([t, ...r.trackList], 0); h.close(); };
  $('#simradio', h.el).onclick = act(async () => { await startRadio({ trackId: t.id }, t.title); h.close(); });
}
const setBody = (h, html) => { const b = h.$('.dlg-body'); if (b) b.innerHTML = html; };

/** Ljudresa: välj en mållåt (sök), antal låtar, och spela listan som glider från t till målet. */
export function journeyDialog(t) {
  const lid = libs.find(l => l.type === 'music')?.id;
  const h = openDialog({ title: 'Ljudresa', closeOnRoute: true, body: `<p class="muted small">Från <b>${esc(t.title)}</b>${t.artist ? ' – ' + esc(t.artist) : ''}. Välj en låt att resa till – spellistan glider gradvis från den ena till den andra.</p>
    <div class="row"><input id="jq" placeholder="Sök mållåt…" aria-label="Sök mållåt" style="flex:1;min-width:160px">
    <label class="small" for="jn">Antal</label><select id="jn" aria-label="Antal låtar">${[10, 15, 20, 30, 40].map(n => `<option value="${n}"${n === 20 ? ' selected' : ''}>${n} låtar</option>`).join('')}</select></div>
    <div id="jres" class="plpick" role="list" style="margin-top:10px"></div>` });
  const d = h.el;
  let seq = 0;
  const search = act(async () => {
    const q = $('#jq', d).value.trim(), my = ++seq;
    if (!q || !lid) { $('#jres', d).innerHTML = ''; return; }
    const r = await api(`/music/${+lid}/search?q=${encodeURIComponent(q)}`, { bg: true });
    if (my !== seq) return;
    const list = r.tracks.filter(x => x.id !== t.id).slice(0, 12);
    $('#jres', d).innerHTML = list.map(x => `<button class="ghost" role="listitem" data-jt="${x.id}">${esc(x.title)} <span class="muted small">${esc(x.artist || '')}</span></button>`).join('')
      || '<p class="muted small">Inga låtar hittades.</p>';
    $$('[data-jt]', d).forEach(b => b.onclick = act(async () => {
      const r2 = await api('/music/journey', { method: 'POST', body: { from: t.id, to: +b.dataset.jt, count: +$('#jn', d).value } });
      playQueue(r2.trackList, 0);
      toast(`Ljudresa: ${r2.trackList.length} låtar · ${fmtDur(r2.trackList.reduce((s, x) => s + (x.duration || 0), 0))}`);
      h.close();
    }));
  });
  let timer = null;
  $('#jq', d).oninput = () => { clearTimeout(timer); timer = setTimeout(search, 300); };
  $('#jq', d).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(); } };
  $('#jq', d).focus();
}

/** Stationerna på musikhemmet (de smarta listor som kommer från ljudanalysen) och analysens läge. */
export function stationsHtml(lid, smart = [], st = null) {
  const list = smart.filter(s => s.station);
  const note = st && st.total && st.analyzed < st.total ? `<p class="muted small">Ljudanalys: ${st.analyzed} av ${st.total} låtar${st.ready ? '' : ' – stationerna visas när minst 20 låtar är analyserade'}.</p>` : '';
  if (!list.length) return note ? `<section class="section"><h2>Stationer</h2>${note}</section>` : '';
  return `<section class="section"><h2>Stationer</h2>${note}<div class="shelf">${list.map(s => `<a class="card mcard station" href="#/smart/${+lid}/${encodeURIComponent(s.id)}">
    <div class="cover stationcover" data-st="${esc(s.id)}"><span aria-hidden="true">${esc(s.icon || '📻')}</span></div><div class="t">${esc(s.name)}</div><div class="s">${esc(s.text || '')}</div></a>`).join('')}</div></section>`;
}

/** Liknande artister (efter ljud) längst ner på artistsidan – laddas efter att sidan visats. */
export async function similarArtists(box, arid) {
  const gen = routeGen;
  let r;
  try { r = await api(`/music/artists/${+arid}/similar`, { bg: true }); } catch { return; }
  if (gen !== routeGen || !box.isConnected || !r.artists.length) return;
  box.innerHTML = `<section class="section"><h2>Liknande artister <span class="muted small">efter hur de låter</span></h2><div class="shelf">${r.artists.map(x => `<a class="card mcard" href="#/artist/${+x.id}">${cover(x.cover_album || x.id, !!x.cover_album, 'round')}<div class="t">${esc(x.name)}</div><div class="s">${x.albums} album</div></a>`).join('')}</div></section>`;
}

/** Ljudanalysens förlopp och inställningar i administrationen. */
export async function sonicAdmin(box) {
  const gen = routeGen;
  let s;
  try { s = await api('/music/sonic'); } catch (e) { if (box.isConnected) box.innerHTML = `<h2>Ljudanalys</h2>${errorState(e, { compact: true })}`; return; }
  if (gen !== routeGen || !box.isConnected) return;
  const pct = s.total ? Math.round(s.analyzed / s.total * 100) : 0;
  const state = s.envDisabled ? 'Avstängd med miljövariabeln MUSIC_SONIC=0' : !s.enabled ? 'Avstängd' : s.paused ? 'Pausad – video omkodas just nu' : s.running ? `Pågår${s.current.length ? ': ' + s.current.join(', ') : ''}` : s.pending ? 'Väntar på nästa omgång' : 'Klar';
  box.innerHTML = `<h2>Ljudanalys</h2>
    <p class="muted small" style="margin:0 0 8px">Tempo, energi, klang och stämning räknas fram för varje låt – för låtradio, ljudresor, stationer och "Liknande låtar". Allt sker på servern med ffmpeg (högst ${s.seconds} s från mitten av varje låt), med lägsta prioritet${s.lowPriority.ionice ? ' för både processor och disk' : ' för processorn'}.</p>
    <div class="row" style="align-items:center"><b>${s.analyzed} av ${s.total} låtar analyserade</b><span class="muted small">${pct} %${s.failed ? ` · ${s.failed} gick inte att läsa` : ''}${s.avgMs ? ` · i snitt ${(s.avgMs / 1000).toFixed(1).replace('.', ',')} s per låt` : ''}</span></div>
    <div class="track" role="progressbar" aria-label="Ljudanalysens förlopp" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" style="margin:8px 0;height:6px"><i style="width:${pct}%;display:block;height:100%;background:var(--accent)"></i></div>
    <p class="small" role="status">${esc(state)}</p>
    <div class="row" style="align-items:flex-end"><label class="switch"><input type="checkbox" id="sonen" ${s.enabled ? 'checked' : ''} ${s.envDisabled ? 'disabled' : ''}> Analysera musik i bakgrunden</label>
      <div><label for="sonc">Samtidiga analyser</label><select id="sonc">${[1, 2, 3, 4].map(n => `<option value="${n}"${n === s.concurrency ? ' selected' : ''}>${n}${n === 1 ? ' (rekommenderas)' : ''}</option>`).join('')}</select></div>
      <button type="button" class="ghost" id="sonre">Analysera om allt</button></div>`;
  const save = act(async (body) => { await api('/music/sonic', { method: 'PUT', body }); toast('Sparat'); sonicAdmin(box); });
  $('#sonen', box).onchange = (e) => save({ enabled: e.target.checked });
  $('#sonc', box).onchange = (e) => save({ concurrency: +e.target.value });
  $('#sonre', box).onclick = async () => {
    if (await confirmDialog('Alla låtar analyseras från början. Stationer, låtradio och Liknande låtar fungerar sämre tills analysen hunnit ikapp.', { title: 'Analysera om all musik?', okLabel: 'Analysera om' })) save({ reanalyze: true });
  };
  // Uppdatera förloppet medan analysen pågår (slutar när man lämnar sidan)
  if (s.running || s.pending) setTimeout(() => { if (gen === routeGen && box.isConnected) sonicAdmin(box); }, 10000);
}
