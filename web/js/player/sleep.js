// Videospelarens sovtimer: pausar filmen efter 15–60 minuter eller när filmen/avsnittet tar slut, som ljudspelarens
// sovtimer (audio-extras.js). De sista tio sekunderna tonas ljudet ner och bilden mörknar, sedan pausas filmen.
// Pausen sparar positionen (Fortsätt titta) via spelarens pause-händelse i video.js. Timern följer med till nästa
// avsnitt (video.js play), och "när avsnittet tar slut" stoppar i stället för att nästa avsnitt startar.
// sleepLeft/sleepFade är rena funktioner (testas i test/playprefs.test.js).
import { $, $$, esc, t, toast } from '../core.js';
import { ICON } from '../ui/icons.js';
import { need } from '../lazy.js';

/** Sekunder nedtoning före pausen */
export const SLEEP_FADE = 10;
export const SLEEP_MINUTES = [15, 30, 45, 60];
// until: klockslag (ms) för pausen, end: pausa när filmen/avsnittet tar slut, cur/v: spelaren timern hör till,
// base: volym och ljusstyrka före nedtoningen (återställs efter pausen)
export const SL = { until: 0, end: false, timer: null, cur: null, v: null, base: null, label: '' };

/**
 * Sekunder kvar till pausen. now (ms), pos/dur (sekunder i filmen), rate = uppspelningshastighet.
 * Infinity = okänt (ingen timer, eller filmens längd är inte känd än).
 */
export function sleepLeft({ until = 0, end = false } = {}, now, pos, dur, rate = 1) {
  if (end) return dur > 0 && Number.isFinite(pos) ? Math.max(0, (dur - pos) / (rate > 0 ? rate : 1)) : Infinity;
  return until ? (until - now) / 1000 : Infinity;
}
/** Nedtoningens styrka 1 (full volym) → 0 (tyst) de sista SLEEP_FADE sekunderna */
export const sleepFade = (left) => left < SLEEP_FADE ? Math.max(0, left / SLEEP_FADE) : 1;
/** Ska "Nästa avsnitt" (eftertexterna, slutet) stoppas? Ja när timern väntar på att avsnittet tar slut. */
export const sleepStopsNext = () => SL.end;
export const sleepOn = () => !!(SL.until || SL.end);

/** Ny spelare (play i video.js): knappen och timern kopplas till den. carry = timern från förra avsnittet. */
export function attachSleep(cur, v, carry = null) {
  SL.cur = cur; SL.v = v; SL.base = null;
  if (carry && (carry.until > Date.now() || carry.end)) start(carry.end ? 'end' : null, carry.until);
  const b = $('#psleep', cur.el); if (b) b.onclick = (e) => { e.stopPropagation(); sleepDialog(); };
  label();
}
/** Det som följer med till nästa spelare (läses innan den gamla stängs) */
export const sleepCarry = () => sleepOn() ? { until: SL.until, end: SL.end } : null;
/** Spelaren stängs: timern stängs av (play() för nästa avsnitt tar med den med sleepCarry) */
export function sleepClosed() { setSleep(0); SL.cur = null; SL.v = null; }

function start(mode, until) {
  clearInterval(SL.timer); SL.timer = null;
  SL.end = mode === 'end';
  SL.until = SL.end ? 0 : until || 0;
  if (sleepOn()) SL.timer = setInterval(tick, 250);
}
/** v: 0 = av, antal minuter eller 'end' (när filmen/avsnittet tar slut) */
export function setSleep(v) {
  restore();
  start(v === 'end' ? 'end' : null, typeof v === 'number' && v > 0 ? Date.now() + v * 60e3 : 0);
  label();
}
function restore() {
  const v = SL.v, b = SL.base; SL.base = null;
  if (v && b) { v.volume = b.volume; v.style.opacity = ''; }
}
function left() {
  const v = SL.v, cur = SL.cur;
  if (!v) return Infinity;
  return sleepLeft(SL, Date.now(), v.currentTime, cur?.it?.duration || (isFinite(v.duration) ? v.duration : 0), v.playbackRate || 1);
}
function tick() {
  const v = SL.v;
  if (!v || !v.isConnected) return sleepClosed();
  // Pausad av användaren: nedtoningen väntar (minuttimern går ändå, som i ljudspelaren)
  const l = left();
  if (!v.paused && l < SLEEP_FADE) {
    if (!SL.base) SL.base = { volume: v.volume };
    const f = sleepFade(l);
    v.volume = Math.max(0, Math.min(1, SL.base.volume * f));
    v.style.opacity = String(0.25 + 0.75 * f);
  } else if (SL.base && l >= SLEEP_FADE) restore();
  if (l <= 0.3) {
    // Pausen skickar positionen till servern (video.js: pause → sendProgress), så Fortsätt titta pekar hit
    const was = !v.paused;
    if (was) v.pause();
    setSleep(0);
    if (was) toast(t('Sovtimern pausade uppspelningen'));
    return;
  }
  label(l);
}
function label(l = left()) {
  const b = SL.cur && $('#psleep', SL.cur.el); if (!b) return;
  const on = sleepOn();
  const min = Math.max(1, Math.ceil((Number.isFinite(l) ? l : 0) / 60));
  const txt = SL.until ? t('{v} min', { v: min }) : SL.end ? t('slut') : '';
  if (txt !== SL.label || b.classList.contains('on') !== on) {
    SL.label = txt;
    b.innerHTML = ICON.moon + (txt ? `<span aria-hidden="true">${esc(txt)}</span>` : '');
    b.classList.toggle('on', on);
  }
  const aria = SL.until ? t('Sovtimer, {v} minuter kvar', { v: min }) : SL.end ? t('Sovtimer, pausar vid slutet') : t('Sovtimer');
  if (b.getAttribute('aria-label') !== aria) { b.setAttribute('aria-label', aria); b.title = aria; }
  // Sista minuten: en markering som syns även när kontrollerna är dolda
  const box = $('#psleepcd', SL.cur.el);
  if (box) {
    const show = on && Number.isFinite(l) && l <= 60;
    box.hidden = !show;
    if (show) box.textContent = t('Sovtimern pausar om {v} s', { v: Math.max(0, Math.ceil(l)) });
  }
}

export async function sleepDialog() {
  const cur = SL.cur; if (!cur) return;
  const what = cur.it?.kind === 'episode' ? t('avsnittet') : t('filmen');
  const { openDialog } = await need('ui/dialog.js');
  if (SL.cur !== cur) return;
  const h = openDialog({ title: t('Sovtimer'), closeOnRoute: false, body: `<p class="muted small">${t('Ljudet tonas ner och filmen pausas – Fortsätt titta börjar där.')}</p>
    <div class="plpick">${SLEEP_MINUTES.map(m => `<button class="ghost" data-sl="${m}">${t('{m} minuter', { m })}</button>`).join('')}
    <button class="ghost" data-sl="end">${t('När {what} tar slut', { what })}</button>${sleepOn() ? `<button class="ghost" data-sl="0">${t('Stäng av sovtimern')}</button>` : ''}</div>` });
  const d = h.el;
  $('[data-sl]', d)?.focus();
  $$('[data-sl]', d).forEach(b => b.onclick = () => {
    const v = b.dataset.sl;
    setSleep(v === 'end' ? 'end' : +v);
    toast(v === '0' ? t('Sovtimern är avstängd') : v === 'end' ? t('Pausar när {what} tar slut', { what }) : t('Pausar om {v} minuter', { v }));
    h.close();
  });
}
