// Spolning i en omkodad ström: reglerna utan spelaren (testas i repots test/expo-seek.test.js).
// Spellistan har 6 s-segment, och servern måste koda hela segmentet med målet innan något kan visas (3–4,5 s för en
// 1080p-film). Spolar man utanför det som är buffrat startar appen i stället om strömmen vid målet
// (/playback med start= och prev=<förra strömmens pid>): servern ger korta segment där (1 s med processorn, 2 s med
// grafikkortet, som vid Fortsätt titta) och stoppar den gamla strömmen direkt. Samma regler som webbspelaren
// (seekRestart i web/js/player/hlsconfig.js). Remux och direktuppspelning påverkas inte.
//
// Skillnaden mot webben: expo-video visar inte serverns svarshuvuden (X-Seg-Ready) och har ingen händelse före en
// spolning. Appen ser spolningen som ett hopp i positionen (seekJump) och gissar vilka segment servern har klara ur
// var strömmen startades och hur långt spelaren har buffrat (readyGuess) – försiktigt, så hellre en omstart för
// mycket än en väntan på ett helt 6 s-segment.

export type Frag = { start: number; duration: number };
/** En mätning av spelaren (timeUpdate): position och buffertens slut i sekunder, när (ms), om den spelade */
export type Sample = { pos: number; buf: number; at: number; playing: boolean; rate?: number };

/** Segmenten i en HLS-medialista (#EXTINF) med start och längd */
export function parseFrags(m3u8: string): Frag[] {
  const out: Frag[] = [];
  let t = 0;
  for (const line of String(m3u8 || '').split('\n')) {
    const m = /^#EXTINF:([\d.]+)/.exec(line.trim());
    if (!m) continue;
    const d = parseFloat(m[1]);
    if (!(d > 0)) continue;
    out.push({ start: t, duration: d });
    t += d;
  }
  return out;
}

/** Segmentet som innehåller t, eller -1 */
export function fragAt(frags: Frag[], t: number): number {
  if (!Number.isFinite(t)) return -1;
  return frags.findIndex((f) => t >= f.start - 0.001 && t < f.start + f.duration);
}

/** Medialistan bakom mastern (samma frågesträng, samma segmentgränser i alla kvalitetssteg) */
export const indexUrl = (master: string) => master.replace('/hls/master.m3u8', '/hls/index.m3u8');

/** pid i strömmens adress (just den här uppspelningen), eller '' */
export function pidOf(url: string | null | undefined): string {
  const m = /[?&]pid=([0-9a-f]{8})(?:&|$)/.exec(String(url || ''));
  return m ? m[1] : '';
}

// Servern tar bort segment som ligger mer än 30 segment bakom det spelaren senast bad om (BEHIND i server/stream.js)
const BEHIND = 30;
/**
 * Segmenten [från, till] som servern troligen har klara i den pågående omkodningen: från segmentet där körningen
 * startade (runSeg) till segmentet där spelarens buffert slutar – spelaren har hämtat dem, så servern har kodat dem.
 * Servern kodar oftast längre fram än så; det vet appen inte, så gissningen är försiktig.
 */
export function readyGuess(frags: Frag[], runSeg: number, bufferedEnd: number): [number, number] | null {
  if (!frags.length || runSeg < 0) return null;
  const last = frags.length - 1;
  let hi = fragAt(frags, Math.max(0, bufferedEnd - 0.05));
  if (hi < 0) hi = bufferedEnd >= frags[last].start ? last : runSeg;
  hi = Math.max(hi, runSeg);
  return [Math.max(runSeg, hi - BEHIND + 1), hi];
}

/**
 * Ska spelaren starta om strömmen vid t i stället för att låta spelaren hämta segmentet? Nej när
 * - ingen bild har visats än (spelarens egna hopp vid starten),
 * - t redan är buffrat,
 * - segmentet redan är kort (början av filen, efter en omstart eller Fortsätt titta),
 * - t är nära slutet (där ger servern inga korta segment),
 * - servern har segmentet klart eller kodar det just nu (ready = [från, till], till + 1 kodas).
 * Samma regler som webbens seekRestart.
 */
export function seekRestart(buffered: [number, number][], t: number, o: { frags: Frag[]; ready?: [number, number] | null; started?: boolean }): boolean {
  const { frags, ready = null, started = true } = o;
  if (!started || !Number.isFinite(t) || !frags.length) return false;
  if (buffered.some(([a, b]) => t >= a - 0.1 && t < b)) return false;
  const n = fragAt(frags, t);
  if (n < 0) return false;
  const last = frags[frags.length - 1];
  if (t > last.start + last.duration - 4) return false;
  if (frags[n].duration <= 2.01) return false;
  if (ready && n >= ready[0] && n <= ready[1] + 1) return false;
  return true;
}

/**
 * Har användaren spolat mellan två mätningar? Positionen hoppade mer än 2,5 s framåt jämfört med hur långt den
 * hinner spela, eller mer än 1,5 s bakåt. Ett stopp för buffring flyttar aldrig positionen framåt eller bakåt, så det
 * räknas inte (positionen står still medan klockan går).
 */
export function seekJump(prev: Sample, now: Sample): boolean {
  if (!Number.isFinite(prev.pos) || !Number.isFinite(now.pos)) return false;
  const secs = Math.max(0, (now.at - prev.at) / 1000);
  const ran = prev.playing ? secs * (prev.rate && prev.rate > 0 ? prev.rate : 1) : 0;
  return now.pos > prev.pos + ran + 2.5 || now.pos < prev.pos - 1.5;
}

/**
 * Beslutet efter ett hopp från prev (före spolningen) till t: starta om, eller låta spelaren hämta segmentet.
 * Bufferten före spolningen är prev.pos–prev.buf (telefonens spelare sparar inte det som redan spelats).
 */
export function decideSeek(prev: Sample, t: number, s: { frags: Frag[]; runSeg: number; started: boolean }): boolean {
  const ready = readyGuess(s.frags, s.runSeg, prev.buf);
  return seekRestart(prev.buf > prev.pos ? [[prev.pos, prev.buf]] : [], t, { frags: s.frags, ready, started: s.started });
}

/** Spolningen gav ingen omstart: var körningen på servern börjar nu. Låg målet utanför det servern hade startar den
 *  om omkodningen vid målet (spelaren bad om segmentet där). */
export function runAfterSeek(prev: Sample, t: number, s: { frags: Frag[]; runSeg: number }): number {
  const n = fragAt(s.frags, t), ready = readyGuess(s.frags, s.runSeg, prev.buf);
  if (n < 0) return s.runSeg;
  return ready && n >= ready[0] && n <= ready[1] + 1 ? s.runSeg : n;
}

/**
 * Startar appen om strömmen vid en spolning på den här plattformen? Inte i webbläget: Chromes egen HLS-spelare
 * hämtar alltid de två första segmenten i en ny ström innan den går till målet (bryr sig varken om EXT-X-START eller
 * #t= i adressen), så omstarten blev långsammare än att vänta på 6 s-segmentet (uppmätt 2,4–2,8 s → 2,9–3,7 s).
 * Telefonernas spelare (AVPlayer, ExoPlayer) börjar där spellistan säger (nhls=1 → EXT-X-START).
 */
export const restartsOn = (platform: string) => platform === 'ios' || platform === 'android';
