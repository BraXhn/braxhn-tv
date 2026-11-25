// Ljudspelaren (följer med mellan sidor): musik, ljudböcker och poddar, mediesession, lyssningsinställningar och jämn ljudnivå.
// Musik spelas glapplöst/med övertoning av Web Audio-motorn (audioengine.js) när det går, annars av <audio id="maudio">.
// M.audio är en fasad med samma gränssnitt som ett ljudelement (paused, play(), pause(), currentTime …) för resten av webben.
import { $, $$, act, api, esc, fmtTime, imgUrl, keyClick, me, mediaKey, routeGen, status, store, toast, t } from './core.js';
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
import { ICON, skipIcon } from './ui/icons.js';
import { provide } from './lazy.js';
import * as AE from './audioengine.js';
import { gainFor } from './audiomix.js';
import * as self from './audio.js';
provide('audio', self); // fasaderna i lazy.js når modulen härifrån

// ---------- musikspelare (följer med mellan sidor) ----------
// resume: kön är återställd efter omladdning men inte startad ({ pos }) – Spela startar låten där.
// starting: en ny låt väntar på sin buffert (positionen den ska börja på); elementet har kvar förra låtens position då.
export const M = { queue: [], idx: -1, cur: null, audio: null, el: null, repeat: false, seekSeq: 0, loadSeq: 0, resume: null, starting: null };
// Fasaden M.audio: motorn när den spelar en buffert, annars elementet (och den återställda kön innan den startats)
const FACADE = {
  get paused() { return M.resume ? true : AE.on() ? AE.paused() : M.el.paused; },
  play() { return M.resume ? resumeQueue() : AE.on() ? AE.resume() : M.el.play(); },
  pause() { if (M.resume) return; if (AE.on()) AE.pause(); else M.el.pause(); },
  get currentTime() { return M.resume ? M.resume.pos : AE.on() ? AE.pos() : M.el.currentTime; },
  set currentTime(t) { if (M.resume) seekTo(t); else if (AE.on()) AE.seek(t); else M.el.currentTime = t; },
  get duration() { return M.resume ? M.cur?.duration || 0 : AE.on() ? AE.dur() : M.el.duration; },
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
  queueStop(); // platsen sparas (byte av profil, utloggning) – sedan skrivs inget mer från den här kön
  M.spoken = null; M.cur = null; M.queue = []; M.idx = -1; M.sfile = null; M.seekSeq++; M.loadSeq++; M.radio = null; M.resume = null; M.starting = null;
  setSleep(0); showLyrics(false); clearWait();
  AE.stop(); AE.only(null); AE.E.elT = null;
  stopVideo(M.el);
  const bar = $('#mbar'); if (bar) bar.hidden = true;
  document.body.classList.remove('hasbar');
  setSession({});
}
const setMplay = (playing) => { const b = $('#mplay'); if (!b) return; b.innerHTML = playing ? ICON.pause : ICON.play; b.title = playing ? t('Pausa') : t('Spela'); b.setAttribute('aria-label', b.title); };
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
  if (!a.paused && Date.now() - Q.saved > QUEUE_EVERY) saveQueue();
}
// Motorns krokar: nästa låt i kön, byte till den, slut, förlopp, spelar/pausad och att elementet ska tystna
const HOOKS = {
  upcoming: () => upcoming(),
  advance: (t, i) => showTrack(t, i),
  ended: () => nextTrack(true),
  time: () => timeUI(),
  state: (playing) => { setPlaying(playing); queueTouch(); },
  stopElement: () => stopVideo(M.el),
  underrun: (t, i, pos) => elementTakeover(t, pos)
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
    <div class="mmid"><div class="row mctl"><button class="ghost small mic" id="mprev" aria-label="${t('Föregående')}" title="${t('Föregående')}">${ICON.prev}</button><button class="primary" id="mplay" aria-label="${t('Pausa')}" title="${t('Pausa')}">${ICON.pause}</button><button class="ghost small mic" id="mnext" aria-label="${t('Nästa')}" title="${t('Nästa')}">${ICON.next}</button>
      <button class="ghost small mic" id="mrep" title="${t('Upprepa')}" aria-label="${t('Upprepa')}" aria-pressed="false">${ICON.repeat}</button><button class="ghost small mic" id="mset" title="${t('Ljudinställningar')}" aria-label="${t('Ljudinställningar')}" aria-haspopup="menu">${ICON.gear}</button><button class="ghost small mic" id="msleep" title="${t('Sovtimer')}" aria-label="${t('Sovtimer')}" aria-haspopup="dialog">${ICON.moon}</button><button class="ghost small mic" id="mlyr" title="${t('Låttext')}" aria-label="${t('Låttext')}" aria-pressed="false">${ICON.lyrics}</button><button class="ghost small mic castbtn" id="mcast" title="${t('Casta till Chromecast')}" aria-label="${t('Casta till Chromecast')}" ${castReady ? '' : 'hidden'}>${ICON.cast}</button><button class="ghost small mic" id="mradio" title="${t('Starta låtradio från låten')}" aria-label="${t('Starta låtradio från låten')}" aria-pressed="false">${ICON.radio}</button></div>
      <div class="mseek"><span id="mcurt" class="small muted">0:00</span><div class="track" id="mtrack"><i id="mfill"></i></div><span id="mdur" class="small muted">0:00</span></div></div>
    <div class="mright"><select id="mspeed" title="${t('Hastighet')}" aria-label="${t('Uppspelningshastighet')}" hidden>${[0.75, 1, 1.1, 1.25, 1.5, 1.75, 2].map(v => `<option value="${v}">${String(v).replace('.', ',')}×</option>`).join('')}</select><input type="range" id="mvol" aria-label="${t('Volym')}" min="0" max="1" step="0.05" value="${store.get('mvol', 1)}"><button class="ghost small" id="mq" aria-haspopup="dialog">${t('Kö')}</button><button class="ghost small mic" id="mx" title="${t('Stäng spelaren')}" aria-label="${t('Stäng spelaren')}">${ICON.close}</button></div>`;
  document.body.append(bar);
  const a = M.el = $('#maudio');
  M.audio = FACADE;
  a.volume = store.get('mvol', 1);
  ensureLyricsPanel();
  a.ontimeupdate = () => { if (!AE.on()) timeUI(); };
  a.onended = () => { if (M.spoken) return spokenEnded(); if (AE.on() || AE.elementEnded()) return; nextTrack(true); };
  $('#mspeed').onchange = (e) => { a.playbackRate = +e.target.value; if (M.spoken) { M.spoken.speed = a.playbackRate; store.set('speed', a.playbackRate); } };
  a.onplay = () => { if (AE.E.ctx?.state === 'suspended') AE.E.ctx.resume().catch(() => {}); if (!AE.on()) { setPlaying(true); queueTouch(); } };
  a.onpause = () => { if (AE.on()) return; setPlaying(false); if (M.spoken) spokenSave(); else queueTouch(); };
  a.onerror = () => { if (AE.on() || !a.getAttribute('src')) return; if (M.spoken || !M.cur?.id) return toast(t('Kunde inte spela låten'), { error: true }); elementFailed(); };
  $('#mplay').onclick = () => M.audio.paused ? M.audio.play() : M.audio.pause();
  $('#mnext').onclick = () => M.spoken ? spokenSeek(spokenPos() + LPREFS.skipForward) : nextTrack(false);
  $('#mprev').onclick = () => { if (M.spoken) return spokenSeek(spokenPos() - LPREFS.skipBack); if (curPos() > 3) seekTo(0); else if (M.idx > 0) loadTrack(M.idx - 1); };
  $('#mrep').onclick = () => { M.repeat = !M.repeat; setRepeatState(); queueTouch(); };
  $('#mset').onclick = (e) => soundMenu(e.currentTarget);
  $('#mvol').oninput = (e) => { store.set('mvol', +e.target.value); applyVolume(); };
  $('#msleep').onclick = sleepDialog;
  $('#mlyr').onclick = toggleLyrics;
  $('#mradio').onclick = act(() => M.cur?.id ? startRadio({ trackId: M.cur.id }, M.cur.title) : null);
  $('#mtrack').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(), d = M.spoken?.duration || M.cur?.duration || M.audio.duration; if (d) seekTo((e.clientX - r.left) / r.width * d); };
  $('#mx').onclick = () => { queueForget(); stopAudio(); }; // stängd spelare = ingen kö att fortsätta med
  $('#mq').onclick = showQueue;
  $('#mcast').onclick = castAudio;
  if (!P && !LP && !RP) musicSession();
}
// Mediaknapparna som tangenter (TV-fjärrkontroller, tangentbord utan Media Session): ljudspelaren när ingen video spelas
document.addEventListener('keydown', (e) => {
  const k = mediaKey(e), a = M.audio;
  if (!k || e.defaultPrevented || !a || $('#mbar')?.hidden !== false || P || LP || RP) return;
  const click = (s) => $(s)?.click();
  if (k === 'MediaPlayPause') click('#mplay');
  else if (k === 'MediaPlay') a.play().catch(() => {});
  else if (k === 'MediaPause') a.pause();
  else if (k === 'MediaStop') stopAudio();
  else if (k === 'MediaTrackNext') click('#mnext');
  else if (k === 'MediaTrackPrevious') click('#mprev');
  else if (k === 'MediaFastForward') M.spoken ? spokenSeek(spokenPos() + LPREFS.skipForward) : seekTo(curPos() + 30);
  else if (k === 'MediaRewind') M.spoken ? spokenSeek(spokenPos() - LPREFS.skipBack) : seekTo(Math.max(0, curPos() - 10));
  else return;
  e.preventDefault();
});
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
  $('#mspeed').hidden = !spoken; $('#mrep').hidden = spoken; $('#mq').hidden = spoken; $('#mlyr').hidden = spoken; $('#mradio').hidden = spoken;
  const b = LPREFS.skipBack, f = LPREFS.skipForward;
  $('#mprev').innerHTML = spoken ? skipIcon(b, false) : ICON.prev; $('#mnext').innerHTML = spoken ? skipIcon(f, true) : ICON.next;
  $('#mprev').title = spoken ? t('{b} sekunder bakåt', { b }) : t('Föregående'); $('#mnext').title = spoken ? t('{f} sekunder framåt', { f }) : t('Nästa');
  $('#mprev').setAttribute('aria-label', $('#mprev').title); $('#mnext').setAttribute('aria-label', $('#mnext').title);
  if (spoken) showLyrics(false);
  applyVolume();
}
export function playSpoken(s) {
  ensureBar();
  loadListenPrefs();
  closeAllPlayers();
  if (M.spoken) spokenSave();
  if (M.queue.length) queueForget(); // boken/avsnittet ersätter musikkön (som förut) – den sparade kön ska inte komma tillbaka
  queueStop();
  M.queue = []; M.idx = -1; M.cur = { id: null, duration: s.duration, title: s.title }; M.radio = null; M.loadSeq++; M.resume = null; M.starting = null;
  clearWait();
  AE.stop(); AE.only(null); AE.E.elT = null; AE.E.paused = false; AE.applyGains(); // tal spelas alltid av elementet (musikens jämna ljudnivå gäller inte)
  if (LPREFS.speechLevel) ensureEngine(); // jämn ljudnivå för tal går genom Web Audio (i användarens klick)
  M.spoken = { ...s, speed: s.speed || +store.get('speed', 1), lastSave: Date.now() };
  enginePrefs();
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
    .then(r => r.json()).then(d => { if (d.screenTime) screenBadge(d.screenTime); if (d.stop && M.spoken === s && !M.audio.paused) { M.audio.pause(); toast(d.screenTime?.message || t('Tiden är slut för idag')); } }).catch(() => {});
}
function spokenEnded() {
  const s = M.spoken, i = s.files.indexOf(M.sfile);
  if (i >= 0 && i + 1 < s.files.length) spokenSeek(s.files[i + 1].offset + 0.01);
  else { spokenSave(true); setSleep(0); toast(s.kind === 'book' ? t('Boken är slut') : t('Avsnittet är slut')); }
}
window.addEventListener('pagehide', () => { if (M.spoken) spokenSave(); });
export function seekTo(t) {
  if (M.spoken) return spokenSeek(t);
  queueTouch();
  if (M.resume) { M.resume.pos = Math.max(0, Math.min(t, (M.cur?.duration || 1e9) - 1)); return timeUI(); }
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
  ensureEngine(tracks[i]); // i användarens klick – annars får ljudsammanhanget inte starta
  loadListenPrefs();
  M.queue = tracks; Q.owner = me?.id || 0; loadTrack(i);
}
/** Startar låt i i kön: som buffert (glapplöst/övertoning) om den hinner avkodas inom GRACE, annars i elementet. */
async function loadTrack(i, pos = 0) {
  const t = M.queue[i]; if (!t) return;
  const seq = ++M.loadSeq, el = M.el;
  M.resume = null;
  M.starting = pos; // tills låten börjar: elementet har kvar förra låtens position (Föregående och spolning läser den)
  showTrack(t, i);
  M.offset = 0; M.transcoded = false; M.want = 0; // inte föregående spårs (eller bokens) värden
  clearWait();
  AE.stop();
  AE.only(t.id); // låtar som hoppats över hämtas inte färdigt
  // Utanför hemmet tar hämtningen tid – där börjar elementet direkt och motorn tar nästa låt.
  if (AE.wants(t) && !status.remote) {
    AE.prepare(t).catch(() => {});
    if (!el.paused) el.pause();
    // Snabbstart: början av låten räcker för att börja spela (motorn byter till mer och till sist hela låten medan
    // den spelar). null = hämtningen går för långsamt eller misslyckades – vänta inte.
    let dec = await Promise.race([AE.first(t), new Promise(r => setTimeout(r, AE.GRACE))]);
    // Långsamt nät där hämtningen ändå hinner med låten: början är snart framme – vänta på den i stället för att börja om i elementet
    if (!dec && seq === M.loadSeq && AE.hopeful(t)) dec = await Promise.race([AE.first(t), new Promise(r => {
      const end = Date.now() + 2 * AE.GRACE, iv = setInterval(() => { if (Date.now() > end || seq !== M.loadSeq || !AE.hopeful(t)) { clearInterval(iv); r(null); } }, 150); })]);
    if (seq !== M.loadSeq) return; // en annan låt hann starta
    // Fortsätter efter omladdning: räcker inte början av låten till positionen tar elementet den (spolar dit)
    if (dec && !(dec.partial && pos > dec.avail - 1)) { M.starting = null; stopVideo(el); AE.play(t, i, dec, pos); return; }
    AE.drop(t.id); // elementet hämtar låten själv – två hämtningar samtidigt halverar farten på långsamt nät
  }
  if (pos > 0) return elementTakeover(t, pos);
  // Elementet: nästa låt kan ändå bli en buffert (motorn tar över vid övergången)
  AE.E.elT = t; AE.E.paused = false; AE.applyGains();
  M.url = `/api/music/tracks/${t.id}/stream?a=${audioCaps()}`;
  M.starting = null;
  el.src = M.url;
  el.play().catch(() => {});
  fetch(M.url, { method: 'HEAD' }).then(r => { if (M.cur === t) M.transcoded = r.headers.get('x-transcoded') === '1'; }).catch(() => {});
}
/** Motorn har bara början av låten och resten hann inte komma (eller spolning förbi början): elementet fortsätter från pos. */
async function elementTakeover(t, pos) {
  if (M.cur !== t) return;
  const seq = ++M.loadSeq, el = M.el;
  M.url = `/api/music/tracks/${t.id}/stream?a=${audioCaps()}`;
  let tc = false;
  try { tc = (await fetch(M.url, { method: 'HEAD' })).headers.get('x-transcoded') === '1'; } catch {}
  if (seq !== M.loadSeq || M.cur !== t) return;
  AE.stop();
  AE.drop(t.id); // elementet hämtar själv – motorns hämtning av samma låt avbryts
  AE.E.elT = t; AE.E.paused = false; AE.applyGains();
  M.transcoded = tc;
  M.starting = null;
  M.want = pos; // dit elementet ska – används om nätet försvinner innan det hunnit dit
  // Omkodade strömmar saknar Range – de startas på rätt position; filer spolas när de laddats
  if (tc) { M.offset = pos; el.src = M.url + '&ss=' + pos; }
  else { M.offset = 0; el.src = M.url; el.addEventListener('loadedmetadata', () => { if (seq === M.loadSeq) el.currentTime = pos; }, { once: true }); }
  el.addEventListener('playing', () => { if (seq === M.loadSeq) M.want = 0; }, { once: true });
  el.play().catch(() => {});
}
// ---------- nätavbrott: vänta och fortsätt ----------
// Låten kunde inte laddas. Är det nätet (servern svarar inte) väntar spelaren och fortsätter av sig själv från samma
// ställe när servern svarar igen; svarar servern är det låten som inte går att spela.
const RETRIED = new WeakSet();
function clearWait() { if (M.wait) { clearTimeout(M.wait.timer); M.wait = null; } }
async function elementFailed() {
  const tr = M.cur, el = M.el;
  if (!tr?.id || M.wait?.tr === tr) return;
  const pos = Math.max((el.currentTime || 0) + (M.offset || 0), M.want || 0);
  const w = M.wait = { tr, pos, n: 0, timer: 0, told: false, again: null };
  const reach = async () => { try { return (await fetch(`/api/music/tracks/${tr.id}/stream?a=${audioCaps()}`, { method: 'HEAD', cache: 'no-store' })).ok; } catch { return false; } };
  w.again = async () => {
    clearTimeout(w.timer);
    const ok = await reach();
    if (M.wait !== w) return;
    if (M.cur !== tr) return clearWait();
    if (!ok) {
      if (!w.told) { w.told = true; toast(t('Inget nät – musiken fortsätter när det är tillbaka')); }
      w.timer = setTimeout(w.again, Math.min(15000, 1000 * 2 ** w.n++));
      return;
    }
    M.wait = null;
    // Servern svarar: ett nytt försök (nätet kan ha kommit tillbaka nyss). Går det inte då är det låten.
    if (!w.told && RETRIED.has(tr)) return toast(t('Kunde inte spela låten'), { error: true });
    RETRIED.add(tr);
    AE.forgetErrors();
    if (w.pos > 1) elementTakeover(tr, w.pos); else loadTrack(M.idx);
  };
  w.again();
}
window.addEventListener('online', () => M.wait?.again());
/** Visar låten i spelaren och gör det som hör till en ny låt (text, mediesession, låtradio, "spelad"). */
function showTrack(t, i, restored = false) {
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
  if (restored) return; // återställd kö: inget spelas förrän man trycker Spela
  if (M.radio && M.queue.length - i <= 3) extendRadio();
  fetch(`/api/music/tracks/${t.id}/played`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  queueTouch();
}
// ---------- låtradio (oändlig kö från ljudanalysen, server/sonic.js) ----------
const setRadioState = () => { const b = $('#mradio'); if (!b) return; b.classList.toggle('on', !!M.radio); b.setAttribute('aria-pressed', String(!!M.radio)); };
/** Startar en låtradio från en låt, ett album eller en artist. */
export async function startRadio(seed, name = '') {
  const r = await api('/music/radio', { method: 'POST', body: { ...seed, count: 25 }, bg: true });
  if (!r.trackList.length) return toast(t('Hittade inga låtar till radion'));
  playQueue(r.trackList, 0, { radio: seed, radioName: r.name || name });
  toast(r.sonic ? t('Låtradio: {v}', { v: r.name || name }) : t('Låtradio: {v} (efter genre och artist – ljudanalysen är inte klar)', { v: r.name || name }));
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
    queueTouch();
  } catch {} finally { R.loading = false; }
}
function nextTrack(auto) {
  // Sovtimer "när låten tar slut": stanna i stället för att gå vidare
  if (auto && SLEEP.end) { M.audio.pause(); setSleep(0); return; }
  if (M.idx + 1 < M.queue.length) loadTrack(M.idx + 1);
  else if (M.repeat) loadTrack(0);
  else if (auto) { M.audio.pause(); }
}
// ---------- kön sparas på servern (server/musicqueue.js) ----------
// Efter omladdning, i en ny flik eller på en annan enhet visar minispelaren samma låt, kö (blandad ordning, upprepning,
// låtradio) och position, pausad. Bara den som använder spelaren skriver: en flik som bara visar en återställd kö
// skriver inget, så den senast använda vinner och flikar skriver inte över varandra i en evig slinga. owner = profilen
// kön hör till – efter byte av profil eller utloggning skrivs inget mer (servern nekar också en annan profils uid).
const QUEUE_EVERY = 15000, QUEUE_MAX = 1000;
const Q = { owner: 0, dirty: false, timer: 0, saved: 0 };
/** Positionen i låten som spelas (eller ska spelas) – inte elementets gamla position medan en ny låt laddas */
const curPos = () => M.resume ? M.resume.pos : M.starting != null ? M.starting : M.audio ? M.audio.currentTime + (M.offset || 0) : 0;
const setRepeatState = () => { const b = $('#mrep'); if (!b) return; b.classList.toggle('on', M.repeat); b.setAttribute('aria-pressed', String(M.repeat)); };
function saveQueue(final = false) {
  clearTimeout(Q.timer); Q.timer = 0;
  if (M.spoken || !M.cur?.id || !M.queue.length || !Q.owner || Q.owner !== me?.id) return;
  Q.dirty = false; Q.saved = Date.now();
  let ids = M.queue.map(x => x.id), idx = M.idx;
  if (ids.length > QUEUE_MAX) { const from = Math.max(0, Math.min(idx - 200, ids.length - QUEUE_MAX)); ids = ids.slice(from, from + QUEUE_MAX); idx -= from; }
  const body = { uid: Q.owner, ids, idx, pos: Math.round(curPos() * 10) / 10, repeat: M.repeat, radio: M.radio ? { seed: M.radio.seed, name: M.radio.name } : null };
  fetch('/api/me/queue', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: final }).catch(() => {});
}
/** Kön eller platsen ändrades av den som använder spelaren: sparas strax (flera ändringar i rad blir en skrivning) */
function queueTouch() {
  if (M.spoken || !Q.owner) return;
  Q.dirty = true; clearTimeout(Q.timer); Q.timer = setTimeout(saveQueue, 1000);
}
/** Spelaren stängs eller byter till tal: det osparade sparas, sedan skrivs inget mer från den här kön */
function queueStop() {
  if (Q.owner && !M.spoken && (Q.dirty || (M.audio && !M.audio.paused))) saveQueue(true);
  clearTimeout(Q.timer); Q.owner = 0; Q.dirty = false;
}
/** Kön ska inte komma tillbaka (spelaren stängdes, en bok eller ett avsnitt tog över) */
function queueForget() {
  if (Q.owner && Q.owner === me?.id) fetch('/api/me/queue', { method: 'DELETE', keepalive: true }).catch(() => {});
  clearTimeout(Q.timer); Q.owner = 0; Q.dirty = false;
}
const queueLeave = () => { if (Q.owner && !M.spoken && M.audio && (Q.dirty || !M.audio.paused)) saveQueue(true); };
window.addEventListener('pagehide', queueLeave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') queueLeave(); });
/**
 * Visar den sparade kön pausad (router.js anropar med serverns svar när sidan startat). Inget händer om något redan
 * spelas eller om en annan profil hunnit logga in. Låtar som inte finns eller som profilen inte får se har servern tagit bort.
 */
export function restoreQueue(q, uid) {
  if (M.cur || M.spoken || P || LP || RP || !q?.tracks?.length || !me || me.id !== uid) return false;
  const i = Math.max(0, Math.min(q.idx | 0, q.tracks.length - 1));
  ensureBar(); setBarMode(false);
  M.queue = q.tracks; M.repeat = !!q.repeat; setRepeatState();
  M.radio = q.radio?.seed ? { seed: q.radio.seed, name: q.radio.name || '', loading: false } : null; setRadioState();
  M.resume = { pos: Math.max(0, +q.pos || 0) };
  Q.owner = uid; Q.dirty = false; Q.saved = Date.now();
  showTrack(M.queue[i], i, true);
  setPlaying(false); timeUI();
  return true;
}
/** Spela på den återställda kön: låten startar där man var (i användarens klick – ljudsammanhanget får starta då) */
function resumeQueue() {
  const r = M.resume; if (!r) return Promise.resolve();
  closeAllPlayers();
  ensureEngine(M.cur);
  loadListenPrefs();
  loadTrack(M.idx, r.pos);
  return Promise.resolve();
}
function showQueue() {
  const h = openDialog({ title: M.radio ? t('Kö – låtradio{v}', { v: M.radio.name ? ': ' + M.radio.name : '' }) : t('Kö'), closeOnRoute: false, body: `<div class="scrollbox tall">${trackRows(M.queue, { showCover: true })}</div>` });
  const d = h.el;
  $$('tr[data-ti]', d).forEach(r => { if (+r.dataset.ti === M.idx) { r.classList.add('playing'); r.setAttribute('aria-current', 'true'); } keyClick(r).onclick = (e) => { if (e.target.closest('button')) return; loadTrack(+r.dataset.ti); h.close(); }; });
  // Fokus på låten som spelas (TV/fjärrkontroll: pilarna går vidare därifrån)
  $('tr.playing', d)?.focus();
}

// ================= LYSSNING: inställningar, jämn ljudnivå, glapplöst och övertoning =================
let LPREFS = { normalize: true, normMode: 'track', gapless: true, crossfade: 0, skipBack: 15, skipForward: 30, skipSilence: false,
  choices: { skipBack: [5, 10, 15, 30, 45, 60], skipForward: [10, 15, 30, 45, 60, 90], crossfade: [0, 2, 4, 6, 8, 10, 12] } };
const normMode = () => LPREFS.normalize === false ? 'off' : (LPREFS.normMode || 'track');
function enginePrefs() { AE.setPrefs({ gapless: LPREFS.gapless !== false, crossfade: +LPREFS.crossfade || 0, normMode: M.spoken ? 'off' : normMode() }); AE.setVoice(!!M.spoken && !!LPREFS.speechLevel); }
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
const NORM_LABEL = { track: t('Spår'), album: 'Album', off: t('Av') };
const fadeLabel = (s) => s ? `${s} s` : t('Av');
/** Musikspelarens meny med ljudinställningar (jämn ljudnivå, glapplöst, övertoning) – sparas på kontot. */
function soundMenu(anchor) {
  const save = (body, msg) => act(async () => { await saveListen(body); toast(msg); })();
  if (M.spoken) return speechMenu(anchor, save);
  const nm = normMode(), cf = +LPREFS.crossfade || 0, noWa = !AE.ready() && AE.E.failed;
  openMenu(anchor, [
    { icon: '⚖', label: t('Jämn ljudnivå'), hint: NORM_LABEL[nm], submenu: [
      { label: t('Spår – varje låt lika högt'), icon: nm === 'track' ? '✓' : '', onSelect: () => save({ normMode: 'track' }, t('Jämn ljudnivå per spår')) },
      { label: t('Album – behåll skillnaderna inom albumet'), icon: nm === 'album' ? '✓' : '', onSelect: () => save({ normMode: 'album' }, t('Jämn ljudnivå per album')) },
      { label: t('Av'), icon: nm === 'off' ? '✓' : '', onSelect: () => save({ normMode: 'off' }, t('Jämn ljudnivå av')) }] },
    { icon: '∞', label: t('Glapplös uppspelning'), hint: LPREFS.gapless === false ? t('Av') : t('På'), disabled: noWa,
      onSelect: () => save({ gapless: LPREFS.gapless === false }, LPREFS.gapless === false ? t('Glapplös uppspelning på') : t('Glapplös uppspelning av')) },
    { icon: '⤨', label: t('Övertoning'), hint: fadeLabel(cf), disabled: noWa, submenu: (LPREFS.choices?.crossfade || [0, 2, 4, 6, 8, 10, 12]).map(s => ({
      label: s ? t('{s} sekunder', { s }) : t('Av'), icon: s === cf ? '✓' : '', onSelect: () => save({ crossfade: s }, s ? t('Övertoning {s} sekunder', { s }) : t('Övertoning av')) })) },
    'separator',
    { label: noWa ? t('Webbläsaren saknar Web Audio – bara ljudnivån gäller') : t('Gäller inte vid Chromecast'), disabled: true },
    { label: t('Fler lyssningsinställningar'), href: '#/account' }
  ], { title: t('Ljud') });
}
/** Ljudmenyn för ljudböcker och poddar: jämn ljudnivå för tal (kompressor i Web Audio) */
function speechMenu(anchor, save) {
  const on = !!LPREFS.speechLevel, noWa = !AE.ready() && AE.E.failed;
  openMenu(anchor, [
    { icon: on ? '✓' : '', label: t('Jämn ljudnivå för tal'), hint: on ? t('På') : t('Av'), disabled: noWa, onSelect: () => { if (!on) ensureEngine(); save({ speechLevel: !on }, on ? t('Jämn ljudnivå för tal av') : t('Jämn ljudnivå för tal på')); } },
    'separator',
    { label: noWa ? t('Webbläsaren saknar Web Audio (t.ex. iPhone/iPad)') : t('Svaga och starka röster spelas jämnare – bra i bilen och med hörlurar'), disabled: true },
    { label: t('Fler lyssningsinställningar'), href: '#/account' }
  ], { title: t('Ljud') });
}
export async function renderListenPrefs(box) {
  const gen = routeGen;
  const p = await api('/me/listening');
  if (gen !== routeGen || !box.isConnected) return;
  const opts = (list, v) => list.map(n => `<option value="${n}" ${n === v ? 'selected' : ''}>${t('{n} sekunder', { n })}</option>`).join('');
  const nm = p.normalize === false ? 'off' : (p.normMode || 'track');
  box.innerHTML = `<h2>${t('Lyssning')}</h2>
    <div class="row"><div><label for="lpnorm">${t('Jämn ljudnivå i musik')}</label><select id="lpnorm">${['track', 'album', 'off'].map(m => `<option value="${m}" ${m === nm ? 'selected' : ''}>${{ track: t('Per spår'), album: 'Per album', off: t('Av') }[m]}</option>`).join('')}</select></div>
      <div><label for="lpfade">${t('Övertoning mellan låtar')}</label><select id="lpfade">${(p.choices.crossfade || [0]).map(s => `<option value="${s}" ${s === p.crossfade ? 'selected' : ''}>${s ? t('{s} sekunder', { s }) : t('Av')}</option>`).join('')}</select></div></div>
    <p class="muted small" style="margin:4px 0 12px">${t('Låtar spelas lika högt med hjälp av ReplayGain-taggar, eller med ljudstyrka som servern mäter i bakgrunden efter skanning. <i>Per album</i> behåller skillnaden mellan albumets låtar. Toppvärdet hindrar att något klipps. I Safari på iPhone/iPad kan webbsidan inte ändra volymen – använd appen där.')}</p>
    <label class="row"><input type="checkbox" id="lpgap" ${p.gapless !== false ? 'checked' : ''} style="width:auto"> ${t('Glapplös uppspelning')}</label>
    <p class="muted small" style="margin:4px 0 12px">${t('Livealbum och klassiskt spelas utan hack mellan spåren. Övertoningen görs aldrig mellan låtar som går ihop på samma album, och blir kortare eller uteblir när låten redan slutar i tystnad. Gäller webbspelaren (inte Chromecast eller Safari på iPhone/iPad).')}</p>
    <div class="row"><div><label for="lpback">${t('Hopp bakåt (ljudböcker och poddar)')}</label><select id="lpback">${opts(p.choices.skipBack, p.skipBack)}</select></div>
      <div><label for="lpfwd">${t('Hopp framåt')}</label><select id="lpfwd">${opts(p.choices.skipForward, p.skipForward)}</select></div></div>
    <label class="row" style="margin-top:12px"><input type="checkbox" id="lpspeech" ${p.speechLevel ? 'checked' : ''} style="width:auto"> ${t('Jämn ljudnivå för tal (ljudböcker och poddar)')}</label>
    <p class="muted small" style="margin:4px 0 0">${t('Viskningar och höga partier spelas jämnare. Gäller webbspelaren (inte Chromecast eller Safari på iPhone/iPad).')}</p>
    <label class="row" style="margin-top:12px"><input type="checkbox" id="lpsil" ${p.skipSilence ? 'checked' : ''} style="width:auto"> ${t('Hoppa över tystnad i poddar')}</label>
    <p class="muted small" style="margin:4px 0 0">${t('Fungerar i Android-appen (och i bilen). Webben och iPhone/Apple TV saknar ett säkert sätt att korta tystnad utan att den sparade positionen blir fel.')}</p>`;
  const save = act(async () => {
    await saveListen({ normMode: $('#lpnorm').value, crossfade: +$('#lpfade').value, gapless: $('#lpgap').checked,
      skipBack: +$('#lpback').value, skipForward: +$('#lpfwd').value, skipSilence: $('#lpsil').checked, speechLevel: $('#lpspeech').checked });
    toast(t('Sparat'));
  });
  for (const id of ['#lpnorm', '#lpfade', '#lpgap', '#lpback', '#lpfwd', '#lpsil', '#lpspeech']) $(id, box).onchange = save;
  $('#lpspeech', box).addEventListener('change', (e) => { if (e.target.checked) ensureEngine(); });
}

// ---------- jämn ljudnivå och motorn ----------
// Web Audio (GainNode) kan även höja tysta låtar och gör glapplöst/övertoning möjligt. iOS-Safari pausar Web Audio när
// skärmen låses, så där används den inte (och där går det inte heller att ändra volymen – normaliseringen gör då ingenting).
function ensureEngine(first) {
  if (!M.el) return;
  if (AE.init(M.el, HOOKS, audioCaps(), first?.gapless?.sampleRate)) { enginePrefs(); applyVolume(); }
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
