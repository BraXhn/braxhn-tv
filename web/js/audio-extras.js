// Ljudspelaren: sovtimer och låttexter
import { $, $$, api, esc, keyClick, toast, t } from './core.js';
import { M, applyVolume, seekTo, spokenPos } from './audio.js';
import { iconButton } from './ui/buttons.js';
import { openDialog } from './ui/dialog.js';
import { loadingState } from './ui/states.js';

// ---------- sovtimer ----------
export const SLEEP = { until: 0, end: false, timer: null };
const SLEEP_FADE = 10; // sekunder nedtoning före paus
export function setSleep(v) { // v: 0 = av, antal minuter eller 'end' (när låten/kapitlet/avsnittet tar slut)
  clearInterval(SLEEP.timer); SLEEP.timer = null;
  SLEEP.end = v === 'end';
  SLEEP.until = typeof v === 'number' && v > 0 ? Date.now() + v * 60e3 : 0;
  M.fade = 1; applyVolume();
  if (SLEEP.end || SLEEP.until) SLEEP.timer = setInterval(sleepTick, 250);
  sleepLabel();
}
function sleepLeft() {
  const a = M.audio;
  if (!SLEEP.end) return (SLEEP.until - Date.now()) / 1000;
  const rate = a.playbackRate || 1;
  if (M.spoken) {
    const s = M.spoken, t = spokenPos();
    let end = s.duration || 0;
    if (s.kind === 'book' && (s.chapters || []).length > 1) { const ch = s.chapters.filter(c => c.start <= t).pop(); if (ch?.end) end = end ? Math.min(end, ch.end) : ch.end; }
    return end ? (end - t) / rate : Infinity;
  }
  const d = M.cur?.duration || a.duration;
  return d ? (d - (a.currentTime + (M.offset || 0))) / rate : Infinity;
}
function sleepTick() {
  const a = M.audio;
  if (!a || (!M.cur && !M.spoken)) return setSleep(0);
  const left = sleepLeft();
  M.fade = left < SLEEP_FADE ? Math.max(0, left / SLEEP_FADE) : 1;
  applyVolume();
  // Pausen sparar positionen (ljudböcker/poddar) via onpause
  if (left <= 0.3) { a.pause(); setSleep(0); toast(t('Sovtimern pausade uppspelningen')); return; }
  sleepLabel(left);
}
function sleepLabel(left) {
  const b = $('#msleep'); if (!b) return;
  b.classList.toggle('on', !!(SLEEP.until || SLEEP.end));
  b.textContent = SLEEP.until ? t('☾ {v} min', { v: Math.max(1, Math.ceil((left ?? sleepLeft()) / 60)) }) : SLEEP.end ? t('☾ slut') : '☾';
  b.setAttribute('aria-label', SLEEP.until ? t('Sovtimer, {v} minuter kvar', { v: Math.max(1, Math.ceil((left ?? sleepLeft()) / 60)) }) : SLEEP.end ? t('Sovtimer, pausar vid slutet') : t('Sovtimer'));
}
export function sleepDialog() {
  const what = M.spoken ? (M.spoken.kind === 'book' ? t('kapitlet') : t('avsnittet')) : t('låten');
  const h = openDialog({ title: t('Sovtimer'), closeOnRoute: false, body: `<p class="muted small">${t('Ljudet tonas ner och pausas – positionen i ljudböcker och poddar sparas.')}</p>
    <div class="plpick">${[15, 30, 45, 60].map(m => `<button class="ghost" data-sl="${m}">${t('{m} minuter', { m })}</button>`).join('')}
    <button class="ghost" data-sl="end">${t('När {what} tar slut', { what })}</button>${SLEEP.until || SLEEP.end ? t('<button class="ghost" data-sl="0">Stäng av sovtimern</button>') : ''}</div>` });
  const d = h.el, close = () => h.close();
  $('[data-sl]', d)?.focus();
  $$('[data-sl]', d).forEach(b => b.onclick = () => {
    const v = b.dataset.sl;
    setSleep(v === 'end' ? 'end' : +v);
    if (v !== '0') toast(v === 'end' ? t('Pausar när {what} tar slut', { what }) : t('Pausar om {v} minuter', { v }));
    close();
  });
}

// ---------- låttexter ----------
// Panelen (Text-knappen) och karaokeläget (helskärm). Synkad text: raden som sjungs markeras och rullas till mitten,
// klick på en rad spolar dit. Rullar man själv följer panelen inte med på en stund. Tiden är M.audio (fasaden: den
// glapplösa motorn eller ljudelementet) + M.offset (omkodad ström som startats om vid spolning).
const LY = { open: false, data: null, tid: null, idx: -1, seq: 0, manual: 0, kar: null };
const MANUAL_MS = 4000; // så länge panelen inte rullar själv efter att man rullat
const LEAD = 0.2; // raden markeras lite före sin tid (ögat hinner)
const nowPos = () => M.audio.currentTime + (M.offset || 0);
export function ensureLyricsPanel() {
  if ($('#lyrics')) return;
  const p = document.createElement('div'); p.id = 'lyrics'; p.hidden = true;
  p.innerHTML = `<div class="lyhead"><b id="lytitle"></b><span class="row">${iconButton({ icon: '⛶', label: t('Karaokeläge (helskärm)'), id: 'lykar', haspopup: 'dialog' })}${iconButton({ icon: '✕', label: t('Stäng låttexten'), id: 'lyx' })}</span></div><div id="lybody"></div>`;
  document.body.append(p);
  $('#lyx').onclick = () => showLyrics(false);
  $('#lykar').onclick = openKaraoke;
  const box = $('#lybody');
  for (const ev of ['wheel', 'touchmove', 'keydown']) box.addEventListener(ev, () => { LY.manual = Date.now(); }, { passive: true });
}
export function showLyrics(on) {
  LY.open = on;
  const p = $('#lyrics'); if (p) p.hidden = !on;
  $('#mlyr')?.classList.toggle('on', on); $('#mlyr')?.setAttribute('aria-pressed', String(on));
  if (on) { LY.tid = null; loadLyrics(); }
  else LY.kar?.close();
}
export const toggleLyrics = () => showLyrics(!LY.open);
/** Raderna som HTML (panelen och karaokeläget). Rader med ordtider får ett element per ord (karaokeläget fyller dem). */
function linesHtml(d, words) {
  return d.lines.map((l, i) => `<p data-ly="${i}" class="${d.synced ? 'sync' : ''}">${words && l.words ? l.words.map((w, j) => `<span data-w="${j}">${esc(w.text)}</span>`).join('') : esc(l.text) || '&nbsp;'}</p>`).join('');
}
const emptyHtml = (d) => d.instrumental ? t('<p class="muted">Instrumental – ingen text.</p>')
  : t('<p class="muted">Ingen text hittades. Lägg en .lrc-fil med samma namn bredvid ljudfilen, eller bädda in texten i filens taggar.</p>');
function bindSeek(box, d) {
  if (d.synced) $$('[data-ly]', box).forEach(p => keyClick(p).onclick = () => { LY.manual = 0; seekTo(d.lines[+p.dataset.ly].t); });
}
export async function loadLyrics() {
  const tt = M.cur;
  if (!LY.open || !tt?.id || M.spoken || LY.tid === tt.id) return;
  LY.tid = tt.id; LY.data = null; LY.idx = -1; LY.manual = 0;
  const seq = ++LY.seq;
  $('#lytitle').textContent = tt.title;
  $('#lybody').innerHTML = loadingState({ kind: 'inline', label: t('Hämtar låttext…') });
  let d;
  try { d = await api(`/music/tracks/${tt.id}/lyrics`, { bg: true }); } catch { d = { lines: [] }; }
  if (seq !== LY.seq) return; // en annan låt hann starta
  LY.data = d;
  // source: lrc/sylt/tag = egen fil, lrclib = hämtad från LRCLIB (server/musicmeta.js)
  $('#lybody').innerHTML = d.lines.length ? linesHtml(d, false) + (d.source === 'lrclib' ? t('<p class="muted small lysrc">Text från LRCLIB</p>') : '') : emptyHtml(d);
  bindSeek($('#lybody'), d);
  $('#lykar').disabled = !d.lines.length;
  if (LY.kar) renderKaraoke();
  lyricsTick();
}
/** Raden som sjungs vid tiden tm (binärsökning), -1 före första */
export function lineAt(lines, tm) {
  let lo = 0, hi = lines.length - 1, i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= tm) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  return i;
}
const centre = (box, el, smooth = true) => box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
export function lyricsTick() {
  const d = LY.data;
  if (!LY.open || !d?.synced || M.spoken) return;
  const i = lineAt(d.lines, nowPos() + LEAD);
  if (i === LY.idx) return;
  LY.idx = i;
  const box = $('#lybody');
  box.querySelector('.on')?.classList.remove('on');
  const el = i >= 0 ? box.querySelector(`[data-ly="${i}"]`) : null;
  if (el) { el.classList.add('on'); if (Date.now() - LY.manual > MANUAL_MS) centre(box, el); }
}

// ---------- karaokeläge ----------
// Helskärmsdialog med stor text: raden som sjungs lyses upp, med ordtider (utökad LRC, SYLT per ord) fylls orden i takt
// med sången. Uppdateras varje bildruta medan dialogen är öppen.
function openKaraoke() {
  if (LY.kar || !LY.data?.lines.length) return;
  const h = LY.kar = openDialog({ title: M.cur?.title || t('Låttext'), className: 'karaoke', closeOnRoute: false,
    body: `<p class="muted kartist" id="karart"></p><div class="karbody" id="karbody"></div>`,
    actions: [{ label: t('Helskärm'), id: 'karfull', onClick: () => { toggleFull(h.el); return false; } }, { label: t('Stäng'), kind: 'primary' }],
    onClose: () => { LY.kar = null; cancelAnimationFrame(kar.raf); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } });
  const box = h.$('#karbody');
  for (const ev of ['wheel', 'touchmove']) box.addEventListener(ev, () => { kar.manual = Date.now(); }, { passive: true });
  renderKaraoke();
  const loop = () => { if (LY.kar !== h) return; karaokeFrame(); kar.raf = requestAnimationFrame(loop); };
  kar.raf = requestAnimationFrame(loop);
}
const kar = { raf: 0, idx: -2, word: -1, manual: 0 };
function toggleFull(el) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen?.().catch(() => toast(t('Helskärm stöds inte här')));
}
function renderKaraoke() {
  const h = LY.kar, d = LY.data; if (!h) return;
  h.el.querySelector('.dlg-title').textContent = M.cur?.title || t('Låttext');
  h.$('#karart').textContent = M.cur?.artist || '';
  const box = h.$('#karbody');
  box.classList.toggle('plain', !d?.synced);
  box.innerHTML = d?.lines.length ? linesHtml(d, true) : emptyHtml(d || {});
  if (d) bindSeek(box, d);
  kar.idx = -2; kar.word = -1;
}
function karaokeFrame() {
  const d = LY.data, h = LY.kar;
  if (!h || !d?.synced || M.spoken || !M.audio) return;
  const now = nowPos(), box = h.$('#karbody');
  const i = lineAt(d.lines, now + LEAD);
  if (i !== kar.idx) {
    kar.idx = i; kar.word = -1;
    box.querySelectorAll('.on, .past').forEach(e => e.classList.remove('on', 'past'));
    box.querySelectorAll('[data-w]').forEach(w => { w.className = ''; w.style.removeProperty('--p'); });
    for (let k = 0; k < i; k++) box.querySelector(`[data-ly="${k}"]`)?.classList.add('past');
    const el = i >= 0 ? box.querySelector(`[data-ly="${i}"]`) : null;
    if (el) { el.classList.add('on'); if (Date.now() - kar.manual > MANUAL_MS) centre(box, el); }
  }
  const line = d.lines[i];
  if (!line?.words) return;
  // Ordet som sjungs fylls från vänster (--p 0–1) fram till nästa ords tid (eller nästa rad)
  const el = box.querySelector(`[data-ly="${i}"]`); if (!el) return;
  const ws = line.words, nextT = d.lines[i + 1]?.t ?? (ws[ws.length - 1].t + 1);
  let w = -1; for (let k = 0; k < ws.length; k++) if (ws[k].t <= now) w = k;
  const spans = el.querySelectorAll('[data-w]');
  if (w !== kar.word) { spans.forEach((s, k) => { s.className = k < w ? 'sung' : k === w ? 'cur' : ''; if (k !== w) s.style.removeProperty('--p'); }); kar.word = w; }
  if (w >= 0) {
    const end = ws[w + 1]?.t ?? nextT, p = Math.max(0, Math.min(1, (now - ws[w].t) / Math.max(0.05, end - ws[w].t)));
    spans[w]?.style.setProperty('--p', p.toFixed(3));
  }
}
