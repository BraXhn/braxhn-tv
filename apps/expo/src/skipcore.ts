// Sammanfattning, intro och eftertexter i spelaren: vilken knapp som visas, om den trycks av sig själv efter en kort
// nedräkning (kontots val, autoSkip i /playback) och vad som händer när avsnittet är slut (autoNext). Samma regler som
// webbspelaren (web/js/player/autoskip.js). Utan importer: testas i repots test/expo-skip.test.js; spelaren är
// screens/Player.tsx.

/** Sekunder som "Hoppar över intro… Avbryt" visas innan spelaren hoppar (som webben) */
export const SKIP_DELAY = 3;

export type SkipKind = 'recap' | 'intro' | 'credits';
export interface SkipPb {
  intro?: { start: number; end: number } | null; recap?: { start: number; end: number } | null; credits?: number | null;
  autoSkip?: Partial<Record<SkipKind, boolean>> | null; autoNext?: { enabled?: boolean; countdown?: number | string } | null;
}
export interface SkipPlan { kind: SkipKind; to: number | 'next'; auto: boolean }

/**
 * Delen som spelas just nu (t sekunder in), eller null. to = tiden att hoppa till, eller 'next' (nästa avsnitt).
 * auto = hoppa av sig själv (valet är på och delen har inte redan hoppats över eller avbrutits – done).
 * Sammanfattningen går före introt om de överlappar; eftertexterna bara när det finns ett nästa avsnitt och bara den
 * första minuten (sedan försvinner knappen).
 */
export function skipPlan(pb: SkipPb | null | undefined, t: number, o: { hasNext?: boolean; done?: Set<string> | null } = {}): SkipPlan | null {
  if (!pb || !Number.isFinite(t)) return null;
  const a = pb.autoSkip || {};
  const mk = (kind: SkipKind, to: number | 'next'): SkipPlan => ({ kind, to, auto: !!a[kind] && !(o.done && o.done.has(kind)) });
  if (pb.recap && t >= pb.recap.start && t < pb.recap.end - 1) return mk('recap', pb.recap.end);
  if (pb.intro && t >= pb.intro.start && t < pb.intro.end - 1) return mk('intro', pb.intro.end);
  if (pb.credits && o.hasNext && t >= pb.credits && t < pb.credits + 60) return mk('credits', 'next');
  return null;
}

/**
 * När avsnittet är slut: auto = nästa avsnitt startar av sig självt efter seconds sekunder (0 = direkt). Utan autoNext
 * i svaret (äldre server, nedladdat utan nät) gäller 8 s. null = inget nästa avsnitt.
 */
export function nextPlan(pb: SkipPb | null | undefined, hasNext: boolean): { auto: boolean; seconds: number } | null {
  if (!hasNext) return null;
  const n = pb?.autoNext;
  if (!n) return { auto: true, seconds: 8 };
  const s = Math.max(0, Math.min(60, parseInt(String(n.countdown), 10)));
  return { auto: !!n.enabled, seconds: Number.isFinite(s) ? s : 8 };
}
