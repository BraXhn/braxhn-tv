// Ljudspelaren (följer med mellan sidor): musik, ljudböcker och poddar, mediesession, lyssningsinställningar och jämn ljudnivå.
// Musik spelas glapplöst/med övertoning av Web Audio-motorn (audioengine.js) när det går, annars av <audio id="maudio">.
// M.audio är en fasad med samma gränssnitt som ett ljudelement (paused, play(), pause(), currentTime …) för resten av webben.
import { $, $$, act, api, esc, fmtTime, imgUrl, keyClick, routeGen, store, toast } from './core.js';
import { SLEEP, ensureLyricsPanel, loadLyrics, lyricsTick, setSleep, showLyrics, sleepDialog, toggleLyrics } from './audio-extras.js';
import { audioCaps } from './player/caps.js';
import { castAudio, castReady } from './player/cast.js';
import { LP, RP } from './player/live.js';
import { stopVideo } from './player/overlay.js';
import { P, closeAllPlayers } from './player/video.js';
import { screenBadge } from './screentime.js';
import { cover, trackRows } from './views/music.js';
import { openDialog } from './ui/dialog.js';
import { openMenu } from './ui/menu.js';
import { ICON } from './ui/icons.js';
import { provide } from './lazy.js';
import * as AE from './audioengine.js';
import { gainFor } from './audiomix.js';
import * as self from './audio.js';
provide('audio', self); // fasaderna i lazy.js når modulen härifrån

// ---------- musikspelare (följer med mellan sidor) ----------
export const M = { queue: [], idx: -1, cur: null, audio: null, el: null, repeat: false, seekSeq: 0, loadSeq: 0 };
// Fasaden M.audio: motorn när den spelar en buffert, annars elementet
const FACADE = {
  get paused() { return AE.on() ? AE.paused() : M.el.paused; },
  play() { return AE.on() ? AE.resume() : M.el.play(); },
  pause() { if (AE.on()) AE.pause(); else M.el.pause(); },
  get currentTime() { return AE.on() ? AE.pos() : M.el.currentTime; },
  set currentTime(t) { if (AE.on()) AE.seek(t); else M.el.currentTime = t; },
  get duration() { return AE.on() ? AE.dur() : M.el.duration; },
  get muted() { return M.el.muted; },
  set muted(v) { M.el.muted = !!v; applyVolume(); },
  get volume() { return +store.get('mvol', 1); },
  set volume(v) { store.set('mvol', v); applyVolume(); },
  get playbackRate() { return M.el.playbackRate; },
  set playbackRate(v) { M.el.playbackRate = v; }
};
// Stäng musikbaren och sluta ladda ljudet (utan load() fortsätter elementet buffra och håller omkodningen vid liv)
export function stopAudio() {
  if (!M.audio) return;
  if (M.spoken) spokenSave();
  M.spoken = null; M.cur = null; M.queue = []; M.idx = -1; M.sfile = null; M.seekSeq++; M.loadSeq++; M.radio = null;
  setSleep(0); showLyrics(false);
  AE.stop(); AE.E.elT = null;
  stopVideo(M.el);
  const bar = $('#mbar'); if (bar) bar.hidden = true;
  document.body.classList.remove('hasbar');
  setSession({});
}
const setMplay = (playing) => { const b = $('#mplay'); if (!b) return; b.textContent = playing ? '⏸' : '▶'; b.title = playing ? 'Pausa' : 'Spela'; b.setAttribute('aria-label', b.title); };
function setPlaying(playing) {
  setMplay(playing);
  if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
// Förloppet i spelaren (elementets timeupdate eller motorns tick var 250:e ms)
function timeUI() {
  if (M.spoken) return spokenTick();
  lyricsTick();
  // Omkodad ström som startats om vid spolning börjar på 0 – lägg till startpositionen
  const a = M.audio, t = a.currentTime + (M.offset || 0);
  $('#mcurt').textContent = fmtTime(t); $('#mbar').dataset.t = t.toFixed(1);
  const d = M.cur?.duration || a.duration; if (d) { $('#mfill').style.width = Math.min(100, t / d * 100) + '%'; $('#mdur').textContent = fmtTime(d); }
}
// Motorns krokar: nästa låt i kön, byte till den, slut, förlopp, spelar/pausad och att elementet ska tystna
const HOOKS = {
  upcoming: () => upcoming(),
  advance: (t, i) => showTrack(t, i),
  ended: () => nextTrack(true),
  time: () => timeUI(),
  state: (playing) => setPlaying(playing),
  stopElement: () => stopVideo(M.el)
};
function upcoming() {
  if (M.spoken || SLEEP.end || !M.queue.length) return null;
  const i = M.idx + 1 < M.queue.length ? M.idx + 1 : M.repeat ? 0 : -1;
  return i >= 0 ? { t: M.queue[i], i } : null;
}
function ensureBar() {
  if ($('#mbar')) return;
  const bar = document.createElement('div'); bar.id = 'mbar'; bar.hidden = true;
  bar.innerHTML = `<audio id="maudio" preload="auto"></audio>
    <div class="mleft"><div id="mcov"></div><div class="mtxt"><b id="mtitle"></b><a id="martist" class="muted small"></a></div></div>
    <div class="mmid"><div class="row mctl"><button class="ghost small" id="mprev" aria-label="Föregående" title="Föregående">⏮</button><button class="primary" id="mplay" aria-label="Pausa" title="Pausa">⏸</button><button class="ghost small" id="mnext" aria-label="Nästa" title="Nästa">⏭</button>
      <button class="ghost small" id="mrep" title="Upprepa" aria-label="Upprepa" aria-pressed="false">🔁</button><button class="ghost small" id="mset" title="Ljudinställningar" aria-label="Ljudinställningar" aria-haspopup="menu">${ICON.gear}</button><button class="ghost small" id="msleep" title="Sovtimer" aria-label="Sovtimer" aria-haspopup="dialog">☾</button><button class="ghost small" id="mlyr" title="Låttext" aria-pressed="false">Text</button><button class="ghost small castbtn" id="mcast" title="Casta till Chromecast" aria-label="Casta till Chromecast" ${castReady ? '' : 'hidden'}>📺<button class="ghost small" id="mradio" title="Starta låtradio från låten" aria-label="Starta låtradio från låten" aria-pressed="false">📻</button></div>
      <div class="mseek"><span id="mcurt" class="small muted">0:00</span><div class="track" id="mtrack"><i id="mfill"></i></div><span id="mdur" class="small muted">0:00</span></div></div>
    <div class="mright"><select id="mspeed" title="Hastighet" aria-label="Uppspelningshastighet" hidden>${[0.75, 1, 1.1, 1.25, 1.5, 1.75, 2].map(v => `<option value="${v}">${String(v).replace('.', ',')}×</option>`).join('')}</select><input type="range" id="mvol" aria-label="Volym" min="0" max="1" step="0.05" value="${store.get('mvol', 1)}"><button class="ghost small" id="mq" aria-haspopup="dialog">Kö</button><button class="ghost small" id="mx" title="Stäng spelaren" aria-label="Stäng spelaren">✕</button></div>`;
  document.body.append(bar);
  const a = M.el = $('#maudio');
  M.audio = FACADE;
  a.volume = store.get('mvol', 1);
  ensureLyricsPanel();
  a.ontimeupdate = () => { if (!AE.on()) timeUI(); };
  a.onended = () => { if (M.spoken) return spokenEnded(); if (AE.on() || AE.elementEnded()) return; nextTrack(true); };
  $('#mspeed').onchange = (e) => { a.playbackRate = +e.target.value; if (M.spoken) { M.spoken.speed = a.playbackRate; store.set('speed', a.playbackRate); } };
  a.onplay = () => { if (AE.E.ctx?.state === 'suspended') AE.E.ctx.resume().catch(() => {}); if (!AE.on()) setPlaying(true); };
  a.onpause = () => { if (AE.on()) return; setPlaying(false); if (M.spoken) spokenSave(); };
  a.onerror = () => { if (AE.on() || !a.getAttribute('src')) return; toast('Kunde inte spela låten', { error: true }); };
  $('#mplay').onclick = () => M.audio.paused ? M.audio.play() : M.audio.pause();
  $('#mnext').onclick = () => M.spoken ? spokenSeek(spokenPos() + LPREFS.skipForward) : nextTrack(false);
  $('#mprev').onclick = () => { if (M.spoken) return spokenSeek(spokenPos() - LPREFS.skipBack); if (M.audio.currentTime + (M.offset || 0) > 3) seekTo(0); else if (M.idx > 0) loadTrack(M.idx - 1); };
  $('#mrep').onclick = () => { M.repeat = !M.repeat; $('#mrep').classList.toggle('on', M.repeat); $('#mrep').setAttribute('aria-pressed', String(M.repeat)); };
  $('#mset').onclick = (e) => soundMenu(e.currentTarget);
  $('#mvol').oninput = (e) => { store.set('mvol', +e.target.value); applyVolume(); };
  $('#msleep').onclick = sleepDialog;
  $('#mlyr').onclick = toggleLyrics;
  $('#mradio').onclick = act(() => M.cur?.id ? startRadio({ trackId: M.cur.id }, M.cur.title) : null);
  $('#mtrack').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(), d = M.spoken?.duration || M.cur?.duration || M.audio.duration; if (d) seekTo((e.clientX - r.left) / r.width * d); };
  $('#mx').onclick = stopAudio;
  $('#mq').onclick = showQueue;
  $('#mcast').onclick = castAudio;
  if (!P && !LP && !RP) musicSession();
}
// Mediatangenter (tangentbord, hörlurar, låsskärm) styr den spelare som är aktiv
const MS_ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto', 'seekbackward', 'seekforward', 'stop'];
function setSession(h) {
  if (!navigator.mediaSession) return;
  for (const k of MS_ACTIONS) { try { navigator.mediaSession.setActionHandler(k, h[k] || null); } catch {} }
}
export function videoSession(v) {
  setSession({ play: () => v.play().catch(() => {}), pause: () => v.pause(),
    seekto: (d) => { v.currentTime = d.seekTime; }, seekbackward: () => { v.currentTime -= 10; }, seekforward: () => { v.currentTime += 10; } });
  if (navigator.mediaSession) navigator.mediaSession.metadata = null;
}
export function musicSession() {
  const a = M.audio;
  if (!a) return setSession({});
  setSession({ play: () => a.play().catch(() => {}), pause: () => a.pause(), nexttrack: () => nextTrack(false), previoustrack: () => $('#mprev')?.click(),
    seekto: (d) => seekTo(d.seekTime),
    seekbackward: () => M.spoken ? spokenSeek(spokenPos() - LPREFS.skipBack) : (a.currentTime -= 10),
    seekforward: () => M.spoken ? spokenSeek(spokenPos() + LPREFS.skipForward) : (a.currentTime += 10) });
}
// ---------- tal: ljudböcker och poddar (flera filer, global position, hastighet, sparad position) ----------
function setBarMode(spoken) {
  $('#mspeed').hidden = !spoken; $('#mrep').hidden = spoken; $('#mset').hidden = spoken; $('#mq').hidden = spoken; $('#mlyr').hidden = spoken; $('#mradio').hidden = spoken;
  const b = LPREFS.skipBack, f = LPREFS.skipForward;
  $('#mprev').textContent = spoken ? `↺${b}` : '⏮'; $('#mnext').textContent = spoken ? `${f}↻` : '⏭';
  $('#mprev').title = spoken ? `${b} sekunder bakåt` : 'Föregående'; $('#mnext').title = spoken ? `${f} sekunder framåt` : 'Nästa';
  $('#mprev').setAttribute('aria-label', $('#mprev').title); $('#mnext').setAttribute('aria-label', $('#mnext').title);
  if (spoken) showLyrics(false);
  applyVolume();
}
export function playSpoken(s) {
  ensureBar();
  loadListenPrefs();
  closeAllPlayers();
  if (M.spoken) spokenSave();
  M.queue = []; M.idx = -1; M.cur = { id: null, duration: s.duration, title: s.title }; M.radio = null; M.loadSeq++;
  AE.stop(); AE.E.elT = null; AE.E.paused = false; AE.applyGains(); // tal spelas alltid av elementet, utan jämn ljudnivå
  M.spoken = { ...s, speed: s.speed || +store.get('speed', 1), lastSave: Date.now() };
  M.sfile = null;
  setBarMode(true);
  const bar = $('#mbar'); bar.hidden = false; document.body.classList.add('hasbar');
  $('#mcov').innerHTML = s.cover ? `<div class="cover small"><img src="${esc(imgUrl(s.cover, 52))}" alt="" decoding="async" data-fb="1"></div>` : '<div class="cover small">🎧</div>';
  $('#mtitle').textContent = s.title;
  $('#martist').textContent = s.sub || ''; $('#martist').href = s.link || '#';
  $('#mspeed').value = String(M.spoken.speed);
  if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.sub || '', artwork: s.cover ? [{ src: s.cover, sizes: '600x600', type: 'image/jpeg' }] : [] });
  spokenSeek(s.position && s.duration && s.duration - s.position > 30 ? s.position : 0);
}
export const spokenPos = () => M.spoken && M.sfile ? M.sfile.offset + (M.soff || 0) + M.el.currentTime : 0;
export async function spokenSeek(t) {
  const s = M.spoken, a = M.el; if (!s) return;
  t = Math.max(0, Math.min(t, (s.duration || 1e9) - 0.5));
  const f = [...s.files].reverse().find(x => x.offset <= t) || s.files[0];
  const local = t - f.offset;
  const seq = ++M.seekSeq;
  if (M.sfile === f && !M.transcoded) { a.currentTime = local; return; }
  const head = await fetch(f.url, { method: 'HEAD' }).catch(() => null);
  // Ett senare hopp eller ett annat avsnitt har hunnit före – detta svar gäller inte längre
  if (seq !== M.seekSeq || M.spoken !== s) return;
  M.sfile = f;
  M.transcoded = head?.headers.get('x-transcoded') === '1';
  M.soff = M.transcoded ? local : 0;
  a.src = M.transcoded ? f.url + (f.url.includes('?') ? '&' : '?') + 'ss=' + local : f.url;
  a.addEventListener('loadedmetadata', () => { if (!M.transcoded && local > 0) a.currentTime = local; a.playbackRate = M.spoken?.speed || 1; }, { once: true });
  a.play().catch(() => {});
}
function spokenTick() {
  const s = M.spoken, t = spokenPos();
  $('#mcurt').textContent = fmtTime(t); $('#mdur').textContent = fmtTime(s.duration || 0);
  if (s.duration) $('#mfill').style.width = Math.min(100, t / s.duration * 100) + '%';
  const ch = (s.chapters || []).filter(c => c.start <= t).pop();
  if (ch && s.chapters.length > 1) $('#martist').textContent = `${s.sub ? s.sub + ' · ' : ''}${ch.title}`;
  if (Date.now() - s.lastSave > 15000 && !M.audio.paused) spokenSave();
}
function spokenSave(final) {
  const s = M.spoken; if (!s) return;
  s.lastSave = Date.now();
  const position = final ? s.duration : spokenPos();
  if (!final && position < 5) return;
  const url = s.kind === 'book' ? `/api/audiobooks/book/${s.id}/progress` : `/api/podcasts/episodes/${s.id}/progress`;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position, speed: s.speed }), keepalive: true })
    .then(r => r.json()).then(d => { if (d.screenTime) screenBadge(d.screenTime); if (d.stop && M.spoken === s && !M.audio.paused) { M.audio.pause(); toast(d.screenTime?.message || 'Tiden är slut för idag'); } }).catch(() => {});
}
function spokenEnded() {
  const s = M.spoken, i = s.files.indexOf(M.sfile);
  if (i >= 0 && i + 1 < s.files.length) spokenSeek(s.files[i + 1].offset + 0.01);
  else { spokenSave(true); setSleep(0); toast(s.kind === 'book' ? 'Boken är slut' : 'Avsnittet är slut'); }
}
window.addEventListener('pagehide', () => { if (M.spoken) spokenSave(); });
export function seekTo(t) {
  if (M.spoken) return spokenSeek(t);
  if (AE.on()) return AE.seek(t);
  const a = M.el;
  // Omkodade strömmar saknar Range – starta om på rätt position
  if (M.transcoded) { M.offset = t; a.src = M.url + (M.url.includes('?') ? '&' : '?') + 'ss=' + t; a.play().catch(() => {}); }
  else { M.offset = 0; a.currentTime = t; }
}
/** Spelar en kö. opts.radio = låtradions start ({ trackId | albumId | artistId }): kön fylls då på av sig själv. */
export function playQueue(tracks, i, opts = {}) {
  if (!tracks.length) return;
  M.radio = opts.radio ? { seed: opts.radio, name: opts.radioName || '', loading: false } : null;
  ensureBar();
  setRadioState();
  if (M.spoken) { spokenSave(); M.spoken = null; }
  setBarMode(false);
  closeAllPlayers();
  ensureEngine(); // i användarens klick – annars får ljudsammanhanget inte starta
  loadListenPrefs();
  M.queue = tracks; loadTrack(i);
}
/** Startar låt i i kön: som buffert (glapplöst/övertoning) om den hinner avkodas inom GRACE, annars i elementet. */
async function loadTrack(i) {
  const t = M.queue[i]; if (!t) return;
  const seq = ++M.loadSeq, el = M.el;
  showTrack(t, i);
  M.offset = 0; M.transcoded = false; // inte föregående spårs (eller bokens) värden
  if (AE.wants(t)) {
    const p = AE.prepare(t).catch(() => null);
    AE.stop();
    if (!el.paused) el.pause();
    const dec = await Promise.race([p, new Promise(r => setTimeout(r, AE.GRACE))]);
    if (seq !== M.loadSeq) return; // en annan låt hann starta
    if (dec) { stopVideo(el); AE.play(t, i, dec); return; }
  } else AE.stop();
  // Elementet: nästa låt kan ändå bli en buffert (motorn tar över vid övergången)
  AE.E.elT = t; AE.E.paused = false; AE.applyGains();
  M.url = `/api/music/tracks/${t.id}/stream?a=${audioCaps()}`;
  el.src = M.url;
  el.play().catch(() => {});
  fetch(M.url, { method: 'HEAD' }).then(r => { if (M.cur === t) M.transcoded = r.headers.get('x-transcoded') === '1'; }).catch(() => {});
}
/** Visar låten i spelaren och gör det som hör till en ny låt (text, mediesession, låtradio, "spelad"). */
function showTrack(t, i) {
  M.idx = i; M.cur = t;
  const bar = $('#mbar');
  bar.hidden = false; document.body.classList.add('hasbar');
  applyVolume(); // spårets egen ljudnivå
  loadLyrics();
  $('#mcov').innerHTML = cover(t.albumId, t.cover, 'small');
  $('#mtitle').textContent = t.title;
  $('#martist').textContent = t.artist || ''; $('#martist').href = t.artistId ? `#/artist/${t.artistId}` : '#';
  $$('tr[data-ti]').forEach(r => r.classList.toggle('playing', r.dataset.tid === String(t.id)));
  if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '',
    artwork: t.cover ? [{ src: `/api/music/cover/${t.albumId}`, sizes: '600x600', type: 'image/jpeg' }] : [] });
  if (M.radio && M.queue.length - i <= 3) extendRadio();
  fetch(`/api/music/tracks/${t.id}/played`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
}
// ---------- låtradio (oändlig kö från ljudanalysen, server/sonic.js) ----------
const setRadioState = () => { const b = $('#mradio'); if (!b) return; b.classList.toggle('on', !!M.radio); b.setAttribute('aria-pressed', String(!!M.radio)); };
/** Startar en låtradio från en låt, ett album eller en artist. */
export async function startRadio(seed, name = '') {
  const r = await api('/music/radio', { method: 'POST', body: { ...seed, count: 25 }, bg: true });
  if (!r.trackList.length) return toast('Hittade inga låtar till radion');
  playQueue(r.trackList, 0, { radio: seed, radioName: r.name || name });
  toast(r.sonic ? `Låtradio: ${r.name || name}` : `Låtradio: ${r.name || name} (efter genre och artist – ljudanalysen är inte klar)`);
}
// Fyller på kön när tre låtar återstår: servern får det som spelats (för drift) och hela kön (inga upprepningar)
async function extendRadio() {
  const R = M.radio;
  if (!R || R.loading) return;
  R.loading = true;
  try {
    const played = M.queue.slice(0, M.idx + 1).map(t => t.id);
    const r = await api('/music/radio', { method: 'POST', bg: true, body: { ...R.seed, history: played.slice(-30), exclude: M.queue.map(t => t.id).slice(-1000), count: 20 } });
    if (M.radio !== R) return; // annan kö har startats under tiden
    const have = new Set(M.queue.map(t => t.id));
    M.queue = [...M.queue, ...r.trackList.filter(t => !have.has(t.id))];
  } catch {} finally { R.loading = false; }
}
function nextTrack(auto) {
  // Sovtimer "när låten tar slut": stanna i stället för att gå vidare
  if (auto && SLEEP.end) { M.audio.pause(); setSleep(0); return; }
  if (M.idx + 1 < M.queue.length) loadTrack(M.idx + 1);
  else if (M.repeat) loadTrack(0);
  else if (auto) { M.audio.pause(); }
}
function showQueue() {
  const h = openDialog({ title: M.radio ? `Kö – låtradio${M.radio.name ? ': ' + M.radio.name : ''}` : 'Kö', closeOnRoute: false, body: `<div class="scrollbox tall">${trackRows(M.queue, { showCover: true })}</div>` });
  const d = h.el;
  $$('tr[data-ti]', d).forEach(r => { if (+r.dataset.ti === M.idx) { r.classList.add('playing'); r.setAttribute('aria-current', 'true'); } keyClick(r).onclick = (e) => { if (e.target.closest('button')) return; loadTrack(+r.dataset.ti); h.close(); }; });
  // Fokus på låten som spelas (TV/fjärrkontroll: pilarna går vidare därifrån)
  $('tr.playing', d)?.focus();
}

// ================= LYSSNING: inställningar, jämn ljudnivå, glapplöst och övertoning =================
let LPREFS = { normalize: true, normMode: 'track', gapless: true, crossfade: 0, skipBack: 15, skipForward: 30, skipSilence: false,
  choices: { skipBack: [5, 10, 15, 30, 45, 60], skipForward: [10, 15, 30, 45, 60, 90], crossfade: [0, 2, 4, 6, 8, 10, 12] } };
const normMode = () => LPREFS.normalize === false ? 'off' : (LPREFS.normMode || 'track');
function enginePrefs() { AE.setPrefs({ gapless: LPREFS.gapless !== false, crossfade: +LPREFS.crossfade || 0, normMode: M.spoken ? 'off' : normMode() }); }
// Hämtas när uppspelning startar (kan ha ändrats i en annan app eller profil)
function loadListenPrefs() {
  return api('/me/listening', { bg: true }).then(p => {
    LPREFS = p;
    enginePrefs();
    if (M.el) { if (M.spoken) setBarMode(true); else applyVolume(); }
    return p;
  }).catch(() => LPREFS);
}
async function saveListen(body) {
  LPREFS = await api('/me/listening', { method: 'PUT', body, bg: true });
  if (M.el && !M.spoken && (normMode() !== 'off' || LPREFS.gapless || LPREFS.crossfade)) ensureEngine();
  enginePrefs();
  if (M.el) { if (M.spoken) setBarMode(true); else applyVolume(); }
}
const NORM_LABEL = { track: 'Spår', album: 'Album', off: 'Av' };
const fadeLabel = (s) => s ? `${s} s` : 'Av';
/** Musikspelarens meny med ljudinställningar (jämn ljudnivå, glapplöst, övertoning) – sparas på kontot. */
function soundMenu(anchor) {
  const save = (body, msg) => act(async () => { await saveListen(body); toast(msg); })();
  const nm = normMode(), cf = +LPREFS.crossfade || 0, noWa = !AE.ready() && AE.E.failed;
  openMenu(anchor, [
    { icon: '⚖', label: 'Jämn ljudnivå', hint: NORM_LABEL[nm], submenu: [
      { label: 'Spår – varje låt lika högt', icon: nm === 'track' ? '✓' : '', onSelect: () => save({ normMode: 'track' }, 'Jämn ljudnivå per spår') },
      { label: 'Album – behåll skillnaderna inom albumet', icon: nm === 'album' ? '✓' : '', onSelect: () => save({ normMode: 'album' }, 'Jämn ljudnivå per album') },
      { label: 'Av', icon: nm === 'off' ? '✓' : '', onSelect: () => save({ normMode: 'off' }, 'Jämn ljudnivå av') }] },
    { icon: '∞', label: 'Glapplös uppspelning', hint: LPREFS.gapless === false ? 'Av' : 'På', disabled: noWa,
      onSelect: () => save({ gapless: LPREFS.gapless === false }, LPREFS.gapless === false ? 'Glapplös uppspelning på' : 'Glapplös uppspelning av') },
    { icon: '⤨', label: 'Övertoning', hint: fadeLabel(cf), disabled: noWa, submenu: (LPREFS.choices?.crossfade || [0, 2, 4, 6, 8, 10, 12]).map(s => ({
      label: s ? `${s} sekunder` : 'Av', icon: s === cf ? '✓' : '', onSelect: () => save({ crossfade: s }, s ? `Övertoning ${s} sekunder` : 'Övertoning av') })) },
    'separator',
    { label: noWa ? 'Webbläsaren saknar Web Audio – bara ljudnivån gäller' : 'Gäller inte vid Chromecast', disabled: true },
    { label: 'Fler lyssningsinställningar', href: '#/account' }
  ], { title: 'Ljud' });
}
export async function renderListenPrefs(box) {
  const gen = routeGen;
  const p = await api('/me/listening');
  if (gen !== routeGen || !box.isConnected) return;
  const opts = (list, v) => list.map(n => `<option value="${n}" ${n === v ? 'selected' : ''}>${n} sekunder</option>`).join('');
  const nm = p.normalize === false ? 'off' : (p.normMode || 'track');
  box.innerHTML = `<h2>Lyssning</h2>
    <div class="row"><div><label for="lpnorm">Jämn ljudnivå i musik</label><select id="lpnorm">${['track', 'album', 'off'].map(m => `<option value="${m}" ${m === nm ? 'selected' : ''}>${{ track: 'Per spår', album: 'Per album', off: 'Av' }[m]}</option>`).join('')}</select></div>
      <div><label for="lpfade">Övertoning mellan låtar</label><select id="lpfade">${(p.choices.crossfade || [0]).map(s => `<option value="${s}" ${s === p.crossfade ? 'selected' : ''}>${s ? `${s} sekunder` : 'Av'}</option>`).join('')}</select></div></div>
    <p class="muted small" style="margin:4px 0 12px">Låtar spelas lika högt med hjälp av ReplayGain-taggar, eller med ljudstyrka som servern mäter i bakgrunden efter skanning. <i>Per album</i> behåller skillnaden mellan albumets låtar. Toppvärdet hindrar att något klipps. I Safari på iPhone/iPad kan webbsidan inte ändra volymen – använd appen där.</p>
    <label class="row"><input type="checkbox" id="lpgap" ${p.gapless !== false ? 'checked' : ''} style="width:auto"> Glapplös uppspelning</label>
    <p class="muted small" style="margin:4px 0 12px">Livealbum och klassiskt spelas utan hack mellan spåren. Övertoningen görs aldrig mellan låtar som går ihop på samma album, och blir kortare eller uteblir när låten redan slutar i tystnad. Gäller webbspelaren (inte Chromecast eller Safari på iPhone/iPad).</p>
    <div class="row"><div><label>Hopp bakåt (ljudböcker och poddar)</label><select id="lpback">${opts(p.choices.skipBack, p.skipBack)}</select></div>
      <div><label>Hopp framåt</label><select id="lpfwd">${opts(p.choices.skipForward, p.skipForward)}</select></div></div>
    <label class="row" style="margin-top:12px"><input type="checkbox" id="lpsil" ${p.skipSilence ? 'checked' : ''} style="width:auto"> Hoppa över tystnad i poddar</label>
    <p class="muted small" style="margin:4px 0 0">Fungerar i Android-appen (och i bilen). Webben och iPhone/Apple TV saknar ett säkert sätt att korta tystnad utan att den sparade positionen blir fel.</p>`;
  const save = act(async () => {
    await saveListen({ normMode: $('#lpnorm').value, crossfade: +$('#lpfade').value, gapless: $('#lpgap').checked,
      skipBack: +$('#lpback').value, skipForward: +$('#lpfwd').value, skipSilence: $('#lpsil').checked });
    toast('Sparat');
  });
  for (const id of ['#lpnorm', '#lpfade', '#lpgap', '#lpback', '#lpfwd', '#lpsil']) $(id, box).onchange = save;
}

// ---------- jämn ljudnivå och motorn ----------
// Web Audio (GainNode) kan även höja tysta låtar och gör glapplöst/övertoning möjligt. iOS-Safari pausar Web Audio när
// skärmen låses, så där används den inte (och där går det inte heller att ändra volymen – normaliseringen gör då ingenting).
function ensureEngine() {
  if (!M.el) return;
  if (AE.init(M.el, HOOKS, audioCaps())) { enginePrefs(); applyVolume(); }
}
/** Volym = reglaget × sovtimerns nedtoning; spårets förstärkning i motorn (eller bara dämpning om Web Audio saknas) */
export function applyVolume() {
  const a = M.el; if (!a) return;
  const vol = +store.get('mvol', 1), fade = M.fade ?? 1;
  if (AE.ready()) {
    a.volume = 1;
    AE.setVolume(Math.max(0, Math.min(1, vol * fade)), a.muted);
    enginePrefs();
  } else {
    const g = M.spoken ? 1 : gainFor(M.cur, normMode());
    a.volume = Math.max(0, Math.min(1, vol * Math.min(1, g) * fade));
  }
}
