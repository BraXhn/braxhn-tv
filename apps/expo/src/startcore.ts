// Snabbare start: /playback skickas samtidigt som titelns uppgifter (/api/items/:id) i stället för efter – som webbens
// earlyPlayback (web/js/player/video.js). Reglerna utan spelaren och utan importer (testas i repots
// test/expo-start.test.js); anropen görs i screens/Player.tsx.
//
// Den tidiga frågan är samma som förvärmningen (warmPlay i api.ts, utan warm=1): utan ljudspår, så servern väljer
// profilens förval – samma spår som titelns defaultAudio, som appen annars skickar. Då tar uppspelningen över en
// förvärmd ström, och svaret kan användas direkt. Blev ljudet ett annat (till exempel en titel med flera versioner
// där spårens nummer skiljer) frågar appen igen med ljudspåret och prev=<den tidiga strömmens pid>, och servern
// stoppar den tidiga strömmen. Undertexter skickar appen inte till servern, så de påverkar inte frågan.

export type EarlyPb = { url?: string | null; audioSelected?: string | number | null };

/** Passar den tidiga frågans svar uppspelningen? Ja när servern valde titelns förvalda ljudspår (eller inget förval finns) */
export function earlyFits(pb: EarlyPb | null | undefined, defaultAudio: number | null | undefined): boolean {
  if (!pb) return false;
  if (defaultAudio == null) return true; // appen skulle ändå fråga utan ljudspår
  return String(pb.audioSelected ?? '') === String(defaultAudio);
}

/**
 * Titeln och /playback samtidigt. early: /playback utan ljudspår (skickas direkt), item: titelns uppgifter,
 * again(audio, early): /playback med titelns ljudspår när det tidiga svaret inte passar (eller misslyckades),
 * drop: strömmen i ett svar som aldrig används (titeln gick inte att hämta, spelaren stängdes – live() blev false).
 * Ger null när spelaren stängts; fel i titeln eller i den andra frågan kastas.
 */
export async function startPlayback<I extends { defaultAudio?: number | null }, P extends EarlyPb>(o: {
  early: () => Promise<P>;
  item: () => Promise<I>;
  again: (audio: number | null, early: P | null) => Promise<P>;
  drop: (pb: P) => void;
  live?: () => boolean;
}): Promise<{ item: I; pb: P; audio: number | null } | null> {
  const live = o.live || (() => true);
  const early = o.early();
  early.catch(() => {}); // ett fel här visas inte – appen frågar igen
  const dropEarly = () => { early.then((p) => o.drop(p), () => {}); };
  let item: I;
  try { item = await o.item(); }
  catch (e) { dropEarly(); throw e; }
  if (!live()) { dropEarly(); return null; }
  const audio = item.defaultAudio ?? null;
  const first = await early.catch(() => null);
  if (!live()) { if (first) o.drop(first); return null; }
  if (first && earlyFits(first, audio)) return { item, pb: first, audio };
  let pb: P;
  try { pb = await o.again(audio, first); }
  catch (e) { if (first) o.drop(first); throw e; }
  if (!live()) { o.drop(pb); return null; }
  return { item, pb, audio };
}
