// "Påbörjad" för filmer och avsnitt – gränsen finns bara här på servern (webbens motsvarighet: resumeAt() i
// web/js/core.js, samma värden; test/home-continue.test.js jämför dem). Sett minst CONTINUE_MIN sekunder (2 min);
// korta klipp (under 8 min) räknas från en fjärdedel av längden. Under gränsen är titeln inte påbörjad någonstans:
// inte i Fortsätt titta, filtret Påbörjade, bio-läget eller nästa avsnitt, och API-svarens position är 0 (titeln
// börjar om från början, ingen "Fortsätt från"). Den sparade positionen i progress lämnas orörd.
export const CONTINUE_MIN = 120;
/** Är positionen pos (s) i en titel som är dur s lång (okänd: 0/null) påbörjad? */
export const isStarted = (pos, dur) => pos > 0 && pos >= Math.min(CONTINUE_MIN, (dur > 0 ? dur : 1e9) * 0.25);
/** Positionen att fortsätta från: pos om titeln räknas som påbörjad, annars 0 */
export const resumeAt = (pos, dur) => isStarted(pos, dur) ? pos : 0;
/** Samma villkor i SQL. pos/dur = kolumnuttryck (t.ex. 'q.position', 'e.duration'); NULL-position ger falskt. */
export const startedSql = (pos = 'p.position', dur = 'i.duration') =>
  `(COALESCE(${pos}, 0) > 0 AND ${pos} >= MIN(${CONTINUE_MIN}, COALESCE(NULLIF(${dur}, 0), 1e9) * 0.25))`;

// "Sedd" för filmer och avsnitt – regeln finns här; Expo-appen (apps/expo/src/offlinecore.ts isWatched) och
// Android-appen (OfflineCore.kt Watched) har samma regel för nedladdade titlar (test/watched.test.js).
// Sedd när eftertexterna har börjat (markeringen credits_start, om den ligger i andra halvan av titeln), annars när
// högst 8 % av längden är kvar. Procent i stället för fasta 2 minuter: ett avsnitt på 5 minuter blev förr sett efter
// 3:01. 8 % är samma gräns som förut för titlar över 25 minuter (en film på 2 timmar: 9,6 min kvar), och långa
// eftertexter fångas av markeringen.
export const WATCHED_LEFT = 0.08;
/** Eftertexter före halva titeln räknas inte (en felplacerad markering ska inte göra titeln sedd för tidigt) */
export const CREDITS_FROM = 0.5;
/** Är positionen pos (s) i en titel som är dur s lång sedd? credits = där eftertexterna börjar (s), om det är känt */
export function isWatched(pos, dur, credits = null) {
  if (!(dur > 0) || !(pos > 0)) return false;
  if (credits > dur * CREDITS_FROM && credits < dur && pos >= credits) return true;
  return dur - pos <= dur * WATCHED_LEFT;
}
