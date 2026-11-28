// Uppkopplingen utanför hemmet (bw till /playback). Reglerna utan React Native och utan importer – testas i repots
// test/expo-bw.test.js (också mot en lokal server med strypt takt). Samma regler som webben (web/js/player/caps.js)
// och Android-appen (BwCore.kt); anropen görs i api.ts.
//
// Servern väljer startsteget efter bw (kbit/s): den listar steget som ryms först, förstartar det och kodar om en
// remux eller direktuppspelning som inte ryms i nätet. Utan bw gäller serverns gissning. Hemma bryr sig servern inte
// om bw, så appen mäter bara utanför hemmet.
//
// - Mätningen: 4 MB från /api/speedtest, högst 1 s. Takten räknas på det som kommer efter första tredjedelen
//   (svarstid och TCP:s långsamma början hör inte till uppkopplingens takt).
// - En mätning gäller i 10 minuter; den görs i bakgrunden när appen öppnas och kommer tillbaka, och när titelsidan
//   öppnas utan en färsk mätning.
// - Förvärmningen och uppspelningen måste skicka samma bw, annars tar servern inte över den förvärmda strömmen.

export const SAMPLE_KB = 4096;
export const SAMPLE_MS = 1000;
/** Så länge gäller en mätning */
export const FRESH_MS = 10 * 60e3;
/** Så länge väntar uppspelningen högst på en mätning (som webben) */
export const WAIT_MS = 1500;
/** Så länge använder uppspelningen samma bw som förvärmningen (servern håller en förvärmd ström i 20 s) */
export const PAIR_MS = 30e3;

/**
 * Är appen utanför hemmet? Nej när den sparade adressen redan är en hemadress, när hemadressen används och när servern
 * säger att förfrågan kommer från hemnätet (here i /api/local). Okänt (äldre server, inget svar än) räknas som
 * utanför när adressen är publik.
 */
export function away(o: { savedIsLocal: boolean; viaHome: boolean; here: boolean | null }): boolean {
  return !o.savedIsLocal && !o.viaHome && o.here !== true;
}

/** Takten (kbit/s) ur märken [ms, byte hittills]; det första märket är när svaret började komma */
export function rateOf(marks: [number, number][]): number {
  if (marks.length < 2) return 0;
  const last = marks[marks.length - 1], total = last[1];
  const from = marks.find((m) => m[1] >= total / 3) || marks[0];
  // För lite kvar att räkna på (allt kom i en eller två bitar): hela provet från första byte
  const a = last[0] - from[0] >= 20 && last[1] > from[1] ? from : marks[0];
  const ms = Math.max(1, last[0] - a[0]), bytes = Math.max(0, last[1] - a[1]);
  return bytes ? Math.round((bytes * 8) / ms) : 0; // byte/ms × 8 = kbit/s
}

/** Senaste mätningen och när den gjordes */
export class Meter {
  kbps = 0; at = 0; freshMs: number;
  constructor(freshMs = FRESH_MS) { this.freshMs = freshMs; }
  note(k: number, now: number) { if (k > 0 && Number.isFinite(k)) { this.kbps = Math.round(k); this.at = now; } }
  /** Mätningen om den är färsk, annars 0 */
  fresh(now: number): number { return this.kbps > 0 && now - this.at >= 0 && now - this.at < this.freshMs ? this.kbps : 0; }
  clear() { this.kbps = 0; this.at = 0; }
}

/** Nyckeln för en förvärmning: titeln och startpositionen i hela sekunder (som warmPlay i api.ts) */
export const pairKey = (id: number, start = 0) => `${id}:${Math.floor(start || 0)}`;

/** Vilket bw som förvärmdes för en titel och position, och när */
export class Pairs {
  private m = new Map<string, { bw: number; at: number }>();
  private windowMs: number;
  constructor(windowMs = PAIR_MS) { this.windowMs = windowMs; }
  put(key: string, bw: number, now: number) { if (this.m.size > 50) this.m.clear(); this.m.set(key, { bw, at: now }); }
  get(key: string, now: number): number | null { const p = this.m.get(key); return p && now - p.at >= 0 && now - p.at < this.windowMs ? p.bw : null; }
  clear() { this.m.clear(); }
}

/**
 * bw till förvärmningen: samma som förra förvärmningen av titeln, annars den färska mätningen. null hemma, eller
 * utanför hemmet utan färsk mätning – då förvärms inget (servern kan inte förutse valet) och appen mäter i stället.
 */
export function forWarm(isAway: boolean, paired: number | null, fresh: number): number | null {
  if (!isAway) return null;
  return paired ?? (fresh > 0 ? fresh : null);
}

/**
 * bw till uppspelningen: samma som förvärmningen, annars den färska mätningen, annars en mätning som får ta högst
 * waitMs (measure delar en mätning som redan pågår). null = skicka inget (hemma, eller ingen mätning i tid).
 */
export async function forPlay(isAway: boolean, paired: number | null, fresh: number, measure: () => Promise<number>, waitMs = WAIT_MS): Promise<number | null> {
  if (!isAway) return null;
  if (paired != null) return paired;
  if (fresh > 0) return fresh;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<number>((r) => { timer = setTimeout(() => r(0), waitMs); });
  const k = await Promise.race([measure().catch(() => 0), late]);
  clearTimeout(timer);
  return k > 0 ? k : null;
}

/** Det som behövs av XMLHttpRequest (finns i React Native och webbläsaren) */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(k: string, v: string): void;
  send(): void;
  abort(): void;
  responseType: string;
  readyState: number;
  status: number;
  response?: any;
  onprogress: ((e: { loaded: number }) => void) | null;
  onreadystatechange: (() => void) | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
}

/**
 * Provet: hämtar url med XMLHttpRequest (React Natives fetch ger inte svaret bit för bit) och ger takten i kbit/s,
 * 0 vid fel. Avbryts SAMPLE_MS efter att svaret börjat komma, och helt efter limitMs.
 */
export function sample(url: string, headers: Record<string, string>, o: { xhr: () => XhrLike; now?: () => number; maxMs?: number; limitMs?: number }): Promise<number> {
  const now = o.now || (() => Date.now());
  const maxMs = o.maxMs ?? SAMPLE_MS;
  return new Promise((done) => {
    const x = o.xhr();
    const marks: [number, number][] = [];
    let over = false;
    const finish = (ok: boolean) => {
      if (over) return;
      over = true; clearTimeout(timer);
      try { x.abort(); } catch {}
      done(ok ? rateOf(marks) : 0);
    };
    const timer = setTimeout(() => finish(marks.length > 1), o.limitMs ?? maxMs + 5000);
    const begin = () => { if (!marks.length) marks.push([now(), 0]); };
    try {
      x.open('GET', url);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.responseType = 'arraybuffer';
      x.onreadystatechange = () => {
        if (x.readyState >= 2 && x.status && x.status !== 200) finish(false);
        else if (x.readyState === 2) begin();
      };
      x.onprogress = (e) => {
        begin();
        const t = now();
        marks.push([t, e.loaded]);
        if (t - marks[0][0] > maxMs) finish(true);
      };
      x.onload = () => {
        // Inga delbesked (eller allt i ett): hela provet från att svaret började komma
        if (marks.length < 2) { begin(); marks.push([now(), x.response?.byteLength || 0]); }
        finish(x.status === 200);
      };
      x.onerror = () => finish(false);
      x.ontimeout = () => finish(false);
      x.send();
    } catch { finish(false); }
  });
}
