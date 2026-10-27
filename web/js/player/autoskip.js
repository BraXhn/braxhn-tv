// Intro, sammanfattning och eftertexter i videospelaren: vilken knapp som visas och om den trycks automatiskt
// (kontots uppspelningsval, /api/items/:id/playback → autoSkip/autoNext). Rena funktioner utan import – testas i
// test/playprefs.test.js och används av video.js.

/** Sekunder som "Hoppar över intro… Avbryt" visas innan spelaren hoppar */
export const SKIP_DELAY = 3;

/**
 * Avsnittet som spelas just nu (t sekunder in): { kind, to, auto } eller null.
 * kind = 'recap' | 'intro' | 'credits'; to = tiden att hoppa till, eller 'next' (nästa avsnitt).
 * auto = hoppa automatiskt (valet är på och avsnittet har inte redan hoppats över eller avbrutits – done).
 * Sammanfattningen går före introt om de överlappar; eftertexterna bara när det finns ett nästa avsnitt
 * (och bara den första minuten, sedan försvinner knappen).
 */
export function skipPlan(pb, t, { hasNext = false, done = null } = {}) {
  if (!pb || !Number.isFinite(t)) return null;
  const a = pb.autoSkip || {};
  const mk = (kind, to) => ({ kind, to, auto: !!a[kind] && !(done && done.has(kind)) });
  if (pb.recap && t >= pb.recap.start && t < pb.recap.end - 1) return mk('recap', pb.recap.end);
  if (pb.intro && t >= pb.intro.start && t < pb.intro.end - 1) return mk('intro', pb.intro.end);
  if (pb.credits && hasNext && t >= pb.credits && t < pb.credits + 60) return mk('credits', 'next');
  return null;
}

/**
 * När avsnittet är slut: { auto, seconds } – auto = nästa avsnitt startar av sig självt efter seconds sekunder
 * (0 = direkt). Utan autoNext i svaret (äldre server) gäller 8 s som förut. null = inget nästa avsnitt.
 */
export function nextPlan(pb, hasNext) {
  if (!hasNext) return null;
  const n = pb?.autoNext;
  if (!n) return { auto: true, seconds: 8 };
  const s = Math.max(0, Math.min(60, parseInt(n.countdown)));
  return { auto: !!n.enabled, seconds: Number.isFinite(s) ? s : 8 };
}

/**
 * Reklamavbrott i inspelningar (samma mönster som skipPlan): avbrottet som spelas just nu { i, to, auto } eller null.
 * ads = [{ start, end }] från /api/dvr; auto = hoppa automatiskt (valet på och avbrottet inte redan överhoppat – done,
 * så att man kan spola tillbaka in i reklamen och titta).
 */
export function adPlan(ads, t, { auto = false, done = null } = {}) {
  if (!Array.isArray(ads) || !Number.isFinite(t)) return null;
  const i = ads.findIndex(a => t >= a.start && t < a.end - 1);
  if (i < 0) return null;
  return { i, to: ads[i].end, auto: !!auto && !(done && done.has(i)) };
}

/** Kapitel ur reklamavbrotten: [{ start, end, ad, label }] – "Del 1", "Reklam", "Del 2" … (duration kan saknas) */
export function adChapters(ads, duration = null) {
  const list = (Array.isArray(ads) ? ads : []).filter(a => a.end > a.start).sort((a, b) => a.start - b.start);
  const out = [];
  let t = 0, n = 0;
  for (const a of list) {
    if (a.start - t >= 5) out.push({ start: t, end: a.start, ad: false, label: `Del ${++n}` });
    out.push({ start: a.start, end: a.end, ad: true, label: 'Reklam' });
    t = a.end;
  }
  if (duration == null || duration - t >= 5) out.push({ start: t, end: duration ?? null, ad: false, label: `Del ${++n}` });
  return out;
}
