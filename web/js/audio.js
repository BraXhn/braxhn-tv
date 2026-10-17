// Ljudspelaren (följer med mellan sidor): musik, ljudböcker och poddar, mediesession, lyssningsinställningar och jämn ljudnivå
import { $, $$, act, api, esc, fmtTime, keyClick, routeGen, store, toast } from './core.js';
import { SLEEP, ensureLyricsPanel, loadLyrics, lyricsTick, setSleep, showLyrics, sleepDialog, toggleLyrics } from './audio-extras.js';
import { audioCaps } from './player/caps.js';
import { LP, RP } from './player/live.js';
import { stopVideo } from './player/overlay.js';
import { P, closeAllPlayers } from './player/video.js';
import { screenBadge } from './screentime.js';
import { cover, trackRows } from './views/music.js';

// ---------- musikspelare (följer med mellan sidor) ----------
export const M = { queue: [], idx: -1, cur: null, audio: null, repeat: false, seekSeq: 0 };
// Stäng musikbaren och sluta ladda ljudet (utan load() fortsätter elementet buffra och håller omkodningen vid liv)
export function stopAudio() {
  if (!M.audio) return;
  if (M.spoken) spokenSave();
  M.spoken = null; M.cur = null; M.queue = []; M.idx = -1; M.sfile = null; M.seekSeq++;
  setSleep(0); showLyrics(false);
  stopVideo(M.audio);
  const bar = $('#mbar'); if (bar) bar.hidden = true;
  document.body.classList.remove('hasbar');
  setSession({});
}
function ensureBar() {
  if ($('#mbar')) return;
  const bar = document.createElement('div'); bar.id = 'mbar'; bar.hidden = true;
  bar.innerHTML = `<audio id="maudio" preload="auto"></audio>
    <div class="mleft"><div id="mcov"></div><div class="mtxt"><b id="mtitle"></b><a id="martist" class="muted small"></a></div></div>
    <div class="mmid"><div class="row mctl"><button class="ghost small" id="mprev">⏮</button><button class="primary" id="mplay">⏸</button><button class="ghost small" id="mnext">⏭</button>
      <button class="ghost small" id="mrep" title="Upprepa">🔁</button><button class="ghost small" id="msleep" title="Sovtimer">☾</button><button class="ghost small" id="mlyr" title="Låttext">Text</button></div>
      <div class="mseek"><span id="mcurt" class="small muted">0:00</span><div class="track" id="mtrack"><i id="mfill"></i></div><span id="mdur" class="small muted">0:00</span></div></div>
    <div class="mright"><select id="mspeed" title="Hastighet" hidden>${[0.75, 1, 1.1, 1.25, 1.5, 1.75, 2].map(v => `<option value="${v}">${String(v).replace('.', ',')}×</option>`).join('')}</select><input type="range" id="mvol" min="0" max="1" step="0.05" value="${store.get('mvol', 1)}"><button class="ghost small" id="mq">Kö</button><button class="ghost small" id="mx" title="Stäng">✕</button></div>`;
  document.body.append(bar);
  const a = M.audio = $('#maudio');
  a.volume = store.get('mvol', 1);
  ensureLyricsPanel();
  a.ontimeupdate = () => {
    if (M.spoken) return spokenTick();
    lyricsTick();
    // Omkodad ström som startats om vid spolning börjar på 0 – lägg till startpositionen
    const t = a.currentTime + (M.offset || 0);
    $('#mcurt').textContent = fmtTime(t); const d = M.cur?.duration || a.duration; if (d) { $('#mfill').style.width = (t / d * 100) + '%'; $('#mdur').textContent = fmtTime(d); } };
  a.onended = () => M.spoken ? spokenEnded() : nextTrack(true);
  $('#mspeed').onchange = (e) => { a.playbackRate = +e.target.value; if (M.spoken) { M.spoken.speed = a.playbackRate; store.set('speed', a.playbackRate); } };
  a.onplay = () => { if (NORM.ctx?.state === 'suspended') NORM.ctx.resume().catch(() => {}); $('#mplay').textContent = '⏸'; if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; };
  a.onpause = () => { $('#mplay').textContent = '▶'; if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; if (M.spoken) spokenSave(); };
  a.onerror = () => toast('Kunde inte spela låten');
  $('#mplay').onclick = () => a.paused ? a.play() : a.pause();
  $('#mnext').onclick = () => M.spoken ? spokenSeek(spokenPos() + LPREFS.skipForward) : nextTrack(false);
  $('#mprev').onclick = () => { if (M.spoken) return spokenSeek(spokenPos() - LPREFS.skipBack); if (a.currentTime + (M.offset || 0) > 3) seekTo(0); else if (M.idx > 0) loadTrack(M.idx - 1); };
  $('#mrep').onclick = () => { M.repeat = !M.repeat; $('#mrep').classList.toggle('on', M.repeat); };
  $('#mvol').oninput = (e) => { store.set('mvol', +e.target.value); applyVolume(); };
  $('#msleep').onclick = sleepDialog;
  $('#mlyr').onclick = toggleLyrics;
  $('#mtrack').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(), d = M.spoken?.duration || M.cur?.duration || a.duration; if (d) seekTo((e.clientX - r.left) / r.width * d); };
  $('#mx').onclick = stopAudio;
  $('#mq').onclick = showQueue;
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
  $('#mspeed').hidden = !spoken; $('#mrep').hidden = spoken; $('#mq').hidden = spoken; $('#mlyr').hidden = spoken;
  const b = LPREFS.skipBack, f = LPREFS.skipForward;
  $('#mprev').textContent = spoken ? `↺${b}` : '⏮'; $('#mnext').textContent = spoken ? `${f}↻` : '⏭';
  $('#mprev').title = spoken ? `${b} sekunder bakåt` : 'Föregående'; $('#mnext').title = spoken ? `${f} sekunder framåt` : 'Nästa';
  if (spoken) showLyrics(false);
  applyVolume();
}
export function playSpoken(s) {
  ensureBar();
  loadListenPrefs();
  closeAllPlayers();
  if (M.spoken) spokenSave();
  M.queue = []; M.idx = -1; M.cur = { id: null, duration: s.duration, title: s.title };
  M.spoken = { ...s, speed: s.speed || +store.get('speed', 1), lastSave: Date.now() };
  M.sfile = null;
  setBarMode(true);
  const bar = $('#mbar'); bar.hidden = false; document.body.classList.add('hasbar');
  $('#mcov').innerHTML = s.cover ? `<div class="cover small"><img src="${esc(s.cover)}" alt=""></div>` : '<div class="cover small">🎧</div>';
  $('#mtitle').textContent = s.title;
  $('#martist').textContent = s.sub || ''; $('#martist').href = s.link || '#';
  $('#mspeed').value = String(M.spoken.speed);
  if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.sub || '', artwork: s.cover ? [{ src: s.cover, sizes: '600x600', type: 'image/jpeg' }] : [] });
  spokenSeek(s.position && s.duration && s.duration - s.position > 30 ? s.position : 0);
}
export const spokenPos = () => M.spoken && M.sfile ? M.sfile.offset + (M.soff || 0) + M.audio.currentTime : 0;
export async function spokenSeek(t) {
  const s = M.spoken, a = M.audio; if (!s) return;
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
  const a = M.audio;
  // Omkodade strömmar saknar Range – starta om på rätt position
  if (M.transcoded) { M.offset = t; a.src = M.url + (M.url.includes('?') ? '&' : '?') + 'ss=' + t; a.play().catch(() => {}); }
  else { M.offset = 0; a.currentTime = t; }
}
export function playQueue(tracks, i) {
  if (!tracks.length) return;
  ensureBar();
  if (M.spoken) { spokenSave(); M.spoken = null; }
  setBarMode(false);
  closeAllPlayers();
  ensureGainNode(); // i användarens klick – annars får ljudsammanhanget inte starta
  loadListenPrefs();
  M.queue = tracks; loadTrack(i);
}
async function loadTrack(i) {
  const t = M.queue[i]; if (!t) return;
  M.idx = i; M.cur = t;
  const a = M.audio, bar = $('#mbar');
  bar.hidden = false; document.body.classList.add('hasbar');
  M.url = `/api/music/tracks/${t.id}/stream?a=${audioCaps()}`;
  M.offset = 0; M.transcoded = false; // inte föregående spårs (eller bokens) värden
  applyVolume(); // spårets egen ljudnivå
  loadLyrics();
  a.src = M.url;
  a.play().catch(() => {});
  fetch(M.url, { method: 'HEAD' }).then(r => { if (M.cur === t) M.transcoded = r.headers.get('x-transcoded') === '1'; }).catch(() => {});
  $('#mcov').innerHTML = cover(t.albumId, t.cover, 'small');
  $('#mtitle').textContent = t.title;
  $('#martist').textContent = t.artist || ''; $('#martist').href = t.artistId ? `#/artist/${t.artistId}` : '#';
  $$('tr[data-ti]').forEach(r => r.classList.toggle('playing', r.dataset.tid === String(t.id)));
  if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '',
    artwork: t.cover ? [{ src: `/api/music/cover/${t.albumId}`, sizes: '600x600', type: 'image/jpeg' }] : [] });
  fetch(`/api/music/tracks/${t.id}/played`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
}
function nextTrack(auto) {
  // Sovtimer "när låten tar slut": stanna i stället för att gå vidare
  if (auto && SLEEP.end) { M.audio.pause(); setSleep(0); return; }
  if (M.idx + 1 < M.queue.length) loadTrack(M.idx + 1);
  else if (M.repeat) loadTrack(0);
  else if (auto) { M.audio.pause(); }
}
function showQueue() {
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Kö</h2><div style="max-height:60vh;overflow:auto">${trackRows(M.queue, { showCover: true })}</div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="cl">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  $$('tr[data-ti]', d).forEach(r => { if (+r.dataset.ti === M.idx) r.classList.add('playing'); keyClick(r).onclick = (e) => { if (e.target.closest('button')) return; loadTrack(+r.dataset.ti); d.close(); d.remove(); }; });
  $('#cl', d).onclick = () => { d.close(); d.remove(); };
}

// ================= LYSSNING: inställningar, jämn ljudnivå, sovtimer, låttexter och smarta listor =================
let LPREFS = { normalize: true, skipBack: 15, skipForward: 30, skipSilence: false, choices: { skipBack: [5, 10, 15, 30, 45, 60], skipForward: [10, 15, 30, 45, 60, 90] } };
// Hämtas när uppspelning startar (kan ha ändrats i en annan app eller profil)
function loadListenPrefs() {
  return api('/me/listening', { bg: true }).then(p => {
    LPREFS = p;
    if (M.audio) { if (M.spoken) setBarMode(true); else applyVolume(); }
    return p;
  }).catch(() => LPREFS);
}
export async function renderListenPrefs(box) {
  const gen = routeGen;
  const p = await api('/me/listening');
  if (gen !== routeGen || !box.isConnected) return;
  const opts = (list, v) => list.map(n => `<option value="${n}" ${n === v ? 'selected' : ''}>${n} sekunder</option>`).join('');
  box.innerHTML = `<h2>Lyssning</h2>
    <label class="row"><input type="checkbox" id="lpnorm" ${p.normalize ? 'checked' : ''} style="width:auto"> Jämn ljudnivå i musik</label>
    <p class="muted small" style="margin:4px 0 12px">Låtar spelas lika högt med hjälp av ReplayGain-taggar, eller med ljudstyrka som servern mäter i bakgrunden efter skanning. I Safari på iPhone/iPad kan webbsidan inte ändra volymen – använd appen där.</p>
    <div class="row"><div><label>Hopp bakåt (ljudböcker och poddar)</label><select id="lpback">${opts(p.choices.skipBack, p.skipBack)}</select></div>
      <div><label>Hopp framåt</label><select id="lpfwd">${opts(p.choices.skipForward, p.skipForward)}</select></div></div>
    <label class="row" style="margin-top:12px"><input type="checkbox" id="lpsil" ${p.skipSilence ? 'checked' : ''} style="width:auto"> Hoppa över tystnad i poddar</label>
    <p class="muted small" style="margin:4px 0 0">Fungerar i Android-appen (och i bilen). Webben och iPhone/Apple TV saknar ett säkert sätt att korta tystnad utan att den sparade positionen blir fel.</p>`;
  const save = act(async () => {
    LPREFS = await api('/me/listening', { method: 'PUT', body: { normalize: $('#lpnorm').checked, skipBack: +$('#lpback').value, skipForward: +$('#lpfwd').value, skipSilence: $('#lpsil').checked }, bg: true });
    if (M.audio) { if (LPREFS.normalize && M.cur && !M.spoken) ensureGainNode(); if (M.spoken) setBarMode(true); else applyVolume(); }
    toast('Sparat');
  });
  for (const id of ['#lpnorm', '#lpback', '#lpfwd', '#lpsil']) $(id, box).onchange = save;
}

// ---------- jämn ljudnivå ----------
// Web Audio (GainNode) kan även höja tysta låtar. iOS-Safari pausar Web Audio när skärmen låses, så där används den inte
// (och där går det inte heller att ändra volymen – normaliseringen gör då ingenting).
const NORM = { ctx: null, node: null, failed: false };
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function ensureGainNode() {
  if (NORM.node || NORM.failed || !LPREFS.normalize || !M.audio) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || isIOS()) { NORM.failed = true; return; }
  try {
    const ctx = new AC(), src = ctx.createMediaElementSource(M.audio), node = ctx.createGain();
    src.connect(node); node.connect(ctx.destination);
    NORM.ctx = ctx; NORM.node = node;
  } catch { NORM.failed = true; }
}
/** Spårets förstärkning (linjär) mot referensen -18 LUFS; aldrig så mycket att toppen klipps, högst +12 dB. */
function trackGain() {
  const t = M.cur;
  if (M.spoken || !LPREFS.normalize || !t || t.gain == null) return 1;
  let g = 10 ** (t.gain / 20);
  if (t.peak > 0) g = Math.min(g, 1 / t.peak);
  return Math.min(g, 4);
}
/** Volym = reglaget × (bara dämpning om Web Audio saknas) × sovtimerns nedtoning */
export function applyVolume() {
  const a = M.audio; if (!a) return;
  const g = trackGain(), vol = +store.get('mvol', 1), fade = M.fade ?? 1;
  if (NORM.node) { NORM.node.gain.value = g; a.volume = Math.max(0, Math.min(1, vol * fade)); }
  else a.volume = Math.max(0, Math.min(1, vol * Math.min(1, g) * fade));
}
