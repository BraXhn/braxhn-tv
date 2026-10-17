// Ljudspelaren: sovtimer och låttexter
import { $, $$, api, esc, keyClick, toast } from './core.js';
import { M, applyVolume, seekTo, spokenPos } from './audio.js';

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
  if (left <= 0.3) { a.pause(); setSleep(0); toast('Sovtimern pausade uppspelningen'); return; }
  sleepLabel(left);
}
function sleepLabel(left) {
  const b = $('#msleep'); if (!b) return;
  b.classList.toggle('on', !!(SLEEP.until || SLEEP.end));
  b.textContent = SLEEP.until ? `☾ ${Math.max(1, Math.ceil((left ?? sleepLeft()) / 60))} min` : SLEEP.end ? '☾ slut' : '☾';
}
export function sleepDialog() {
  const what = M.spoken ? (M.spoken.kind === 'book' ? 'kapitlet' : 'avsnittet') : 'låten';
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Sovtimer</h2><p class="muted small">Ljudet tonas ner och pausas – positionen i ljudböcker och poddar sparas.</p>
    <div class="plpick">${[15, 30, 45, 60].map(m => `<button class="ghost" data-sl="${m}">${m} minuter</button>`).join('')}
    <button class="ghost" data-sl="end">När ${what} tar slut</button>${SLEEP.until || SLEEP.end ? '<button class="ghost" data-sl="0">Stäng av sovtimern</button>' : ''}</div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="cl">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  const close = () => { d.close(); d.remove(); };
  $('#cl', d).onclick = close;
  $$('[data-sl]', d).forEach(b => b.onclick = () => {
    const v = b.dataset.sl;
    setSleep(v === 'end' ? 'end' : +v);
    if (v !== '0') toast(v === 'end' ? `Pausar när ${what} tar slut` : `Pausar om ${v} minuter`);
    close();
  });
}

// ---------- låttexter ----------
const LY = { open: false, data: null, tid: null, idx: -1, seq: 0 };
export function ensureLyricsPanel() {
  if ($('#lyrics')) return;
  const p = document.createElement('div'); p.id = 'lyrics'; p.hidden = true;
  p.innerHTML = `<div class="lyhead"><b id="lytitle"></b><button class="ghost small" id="lyx" title="Stäng">✕</button></div><div id="lybody"></div>`;
  document.body.append(p);
  $('#lyx').onclick = () => showLyrics(false);
}
export function showLyrics(on) {
  LY.open = on;
  const p = $('#lyrics'); if (p) p.hidden = !on;
  $('#mlyr')?.classList.toggle('on', on);
  if (on) { LY.tid = null; loadLyrics(); }
}
export const toggleLyrics = () => showLyrics(!LY.open);
export async function loadLyrics() {
  const t = M.cur;
  if (!LY.open || !t?.id || M.spoken || LY.tid === t.id) return;
  LY.tid = t.id; LY.data = null; LY.idx = -1;
  const seq = ++LY.seq;
  $('#lytitle').textContent = t.title;
  $('#lybody').innerHTML = '<div class="spin"></div>';
  let d;
  try { d = await api(`/music/tracks/${t.id}/lyrics`, { bg: true }); } catch { d = { lines: [] }; }
  if (seq !== LY.seq) return; // en annan låt hann starta
  LY.data = d;
  $('#lybody').innerHTML = d.lines.length ? d.lines.map((l, i) => `<p data-ly="${i}" class="${d.synced ? 'sync' : ''}">${esc(l.text) || '&nbsp;'}</p>`).join('')
    : '<p class="muted">Ingen text hittades. Lägg en .lrc-fil med samma namn bredvid ljudfilen, eller bädda in texten i filens taggar.</p>';
  if (d.synced) $$('[data-ly]', $('#lybody')).forEach(p => keyClick(p).onclick = () => seekTo(d.lines[+p.dataset.ly].t));
  lyricsTick();
}
export function lyricsTick() {
  const d = LY.data;
  if (!LY.open || !d?.synced || M.spoken) return;
  const t = M.audio.currentTime + (M.offset || 0) + 0.2;
  let lo = 0, hi = d.lines.length - 1, i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (d.lines[mid].t <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  if (i === LY.idx) return;
  LY.idx = i;
  const box = $('#lybody');
  box.querySelector('.on')?.classList.remove('on');
  const el = i >= 0 ? box.querySelector(`[data-ly="${i}"]`) : null;
  if (el) { el.classList.add('on'); box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' }); }
}
