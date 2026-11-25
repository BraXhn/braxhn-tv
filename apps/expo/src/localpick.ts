// Hemma via den publika adressen (docs/api.md, /api/local): välj serverns adress på hemnätet när den svarar rätt.
// Ingen import – testas med Node (test/local-home.test.js).
//
// Servern ger (över den sparade, inloggade adressen) sina hemadresser och ett prov: n och proof. Hemadressens
// /api/local/ping?n=… svarar med samma id och proof bara när förfrågan kommer från hemnätet. En annan maskin med
// samma IP på ett annat nät kan inte svara rätt, så appen skickar sin inloggning dit först när beviset stämmer.

export interface LocalInfo { id: string; here?: boolean; addrs: string[]; n: string; proof: string }
/** Hämtar JSON från adressen utan inloggning, med tidsgräns (ms). Kastar vid fel. */
export type GetJson = (url: string, timeoutMs: number) => Promise<any>;

/** Så länge väntar appen på hemadressen innan den använder den sparade */
export const PROBE_MS = 800;

/** Är adressen redan en adress i hemnätet (IP i privata nät, .local/.lan/.home eller ett namn utan punkt)? */
export function isLocalUrl(url: string): boolean {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(host)) return true;
  return host === 'localhost' || !host.includes('.') || /\.(local|lan|home)$/.test(host);
}

/**
 * Provar alla hemadresser samtidigt. Svaret är den första som svarar med serverns id och rätt bevis inom ms, annars
 * null (servern är redan nådd hemifrån, inga adresser, fel svar eller inget svar i tid).
 */
export function pickLocal(info: LocalInfo | null | undefined, get: GetJson, ms = PROBE_MS): Promise<string | null> {
  if (!info || info.here || !Array.isArray(info.addrs) || !info.id || !info.n || !info.proof) return Promise.resolve(null);
  const addrs = info.addrs.filter((a) => typeof a === 'string' && /^https?:\/\/[^/\s?#@]+$/i.test(a)).slice(0, 4);
  if (!addrs.length) return Promise.resolve(null);
  return new Promise((done) => {
    let left = addrs.length, over = false;
    const finish = (v: string | null) => { if (!over) { over = true; clearTimeout(timer); done(v); } };
    const timer = setTimeout(() => finish(null), ms + 50);
    for (const a of addrs) {
      get(`${a}/api/local/ping?n=${encodeURIComponent(info.n)}`, ms)
        .then((r) => { if (r && r.id === info.id && r.proof === info.proof) finish(a); else if (--left === 0) finish(null); })
        .catch(() => { if (--left === 0) finish(null); });
    }
  });
}
