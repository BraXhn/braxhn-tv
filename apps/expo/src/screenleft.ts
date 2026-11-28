// Skärmtiden i spelaren: "12 min kvar idag" och en varning de sista fem minuterna, som webbspelaren
// (web/js/player/screenleft.js) och Android-appen (ScreenLeftCore.kt). Bara för profiler med skärmtid och en gräns idag
// (minuter per dag eller en sluttid). Statusen kommer med varje framstegsrapport (screenTime.left, var tionde sekund
// medan filmen spelar) och, utan nät, från appens egen räkning (screenGate i offlinecore.ts). En paus räknas inte av
// servern, så tiden kvar står still medan filmen är pausad. Ingen react-native: testas i Node
// (test/expo-screenleft.test.js).
import { t } from './i18n';

/** Sekunder kvar när varningen visas */
export const WARN_LEFT = 5 * 60;

export interface Left { min: number; warn: boolean }

/** Serverns status (framstegssvaret, GET /api/screentime) eller appens egen räkning (screenGate) */
export interface LeftSource { limited?: boolean; allowed?: boolean; left?: number | null; remaining?: number | null }

/**
 * Vad spelaren visar: null (ingen skärmtid, ingen gräns idag eller redan slut – då stoppas spelaren i stället) eller
 * { min, warn }. left = det som tar slut först av dagens tid och sluttiden; en äldre server utan left ger remaining.
 */
export function playerLeft(s: LeftSource | null | undefined): Left | null {
  if (!s?.limited || !s.allowed) return null;
  const raw = s.left !== undefined ? s.left : s.remaining;
  if (raw == null || !Number.isFinite(+raw)) return null;
  const left = Math.max(0, +raw);
  return { min: Math.max(1, Math.ceil(left / 60)), warn: left <= WARN_LEFT };
}

/** Appens egen räkning (screenGate): left null = ingen gräns */
export const gateLeft = (g: { allowed: boolean; left: number | null }) => playerLeft({ limited: g.left != null, allowed: g.allowed, left: g.left });

/** "1 h 5 min" från en timme, annars "45 min" (som webbens fmt; samma på svenska och engelska) */
export const fmtLeft = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

/**
 * Texterna och när de syns. Spelarens egna reglage (expo-video) syns inte för appen, så tiden kvar visas i appens
 * överkant medan den syns (innan bilden kommer) och när filmen är pausad. Varningen syns hela tiden de sista fem
 * minuterna, även när filmen spelar. compact: kort text på en smal skärm (som webben på telefonen).
 */
export function leftView(p: Left | null, o: { paused: boolean; chrome: boolean; compact: boolean }): { pill: string; low: boolean; warn: string } | null {
  if (!p) return null;
  const amount = fmtLeft(p.min);
  const pill = o.chrome || o.paused ? (o.compact ? t('⏱ {left} kvar', { left: amount }) : t('{left} kvar idag', { left: amount })) : '';
  const warn = p.warn ? t('Skärmtiden tar slut om {v} min', { v: p.min }) : '';
  return pill || warn ? { pill, low: p.warn, warn } : null;
}
