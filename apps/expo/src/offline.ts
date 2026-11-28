// Nedladdning för offline i telefonen: filmer, avsnitt och ljudböcker sparas i appens egen mapp och spelas utan nät.
// Logiken utan filsystem (kön, väntande positioner, skärmtid utan nät) ligger i offlinecore.ts och testas med Node.
//
// Lagring: Paths.document/offline/<server>-<profil>/ med list.json (posterna, senaste skärmtidsstatus) och filerna
// (<nyckel>.mp4, <nyckel>.subN.vtt, <nyckel>.N.audio för bokens filer, <nyckel>.jpg för omslaget). last.json säger vilken
// profil som senast var inloggad per server – den visas när appen startar utan nät.
//
// Servern bestämmer behörigheten: rätten att ladda ner, åldersgräns, bibliotek och familjefiltret kontrolleras när
// planen hämtas (/api/items/:id/offline, /api/audiobooks/book/:id/offline), och filen hämtas med en mediatoken som bara
// gäller titeln i ett dygn. När servern svarar igen kontrolleras de nedladdade titlarna (403/404 = tas bort).
//
// Filen hämtas med expo-file-systems DownloadTask: paus och fortsätt, förlopp, och på iPhone en bakgrundssession som
// laddar vidare när appen ligger i bakgrunden. Hemadressen (api.ts goHomeIfHere) används när den är bekräftad.
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { Directory, DownloadTask, File, Paths } from 'expo-file-system';
import { api, ApiError, audioCaps, imageUrl, leaveHome, session } from './api';
import * as core from './offlinecore';
import { t, tn } from './i18n';
import type { DlEntry, DlSub, ScreenCache, ScreenStatus } from './offlinecore';

/** Webbläget har inget filsystem: där finns ingen nedladdning */
export const supported = Platform.OS === 'ios' || Platform.OS === 'android';

/** Väntetider (ms): mellan frågor medan servern förbereder filen, nytt försök utan nät, sparning av listan. Testerna kortar dem. */
export const timing = { wait: 4000, retry: 30000, save: 1500 };

// ---------- läget (en server och profil i taget) ----------
let scope = '';
let list: DlEntry[] = [];
let screen: ScreenCache | null = null;
/** Telefonens id för skärmtid utan nät (servern låter samma post från samma enhet växa) – sparas per profil */
let device = '';
let notice = '';
let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((fn) => fn()); };
const store = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  version: () => version,
};
/** Listan för skärmarna (ritas om vid varje ändring och förlopp) */
export function useDownloads(): DlEntry[] { useSyncExternalStore(store.subscribe, store.version, store.version); return list; }
export const getList = () => list;
export const find = (key: string) => list.find((x) => x.key === key) || null;
export const count = () => list.length;
let allowed = true; // user.canDownload i /api/status (barnprofiler och konton utan rätten får inte)
/** Visa Ladda ner? Bara i appen på telefonen, inloggad, och när kontot får ladda ner */
export const mayDownload = () => supported && !!scope && allowed;
/** Besked att visa i Nedladdat (t.ex. att något tagits bort för att profilen inte får se det längre) */
export const getNotice = () => notice;
export function clearNotice() { notice = ''; emit(); }

// ---------- filer ----------
const root = () => new Directory(Paths.document, 'offline');
const dirOf = (s: string) => new Directory(root(), s);
function ensureDir(d: Directory) { if (!d.exists) d.create({ intermediates: true, idempotent: true }); }
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** Sparar listan (efter en kort stund, så att förloppet inte skriver hela tiden; now = direkt) */
function persist(now = false) {
  if (!supported || !scope) return;
  clearTimeout(saveTimer);
  const s = scope, data = JSON.stringify({ v: 1, list, screen, device });
  const go = () => { try { const d = dirOf(s); ensureDir(d); new File(d, 'list.json').writeSync(data); } catch (e) { console.warn('[offline] kunde inte spara listan', e); } };
  if (now) go(); else saveTimer = setTimeout(go, timing.save);
}
type LastProfile = { uid: number; name: string; kid?: boolean };
function readIndex(): Record<string, LastProfile> {
  try { const f = new File(root(), 'last.json'); return f.exists ? JSON.parse(f.textSync()) || {} : {}; } catch { return {}; }
}
function writeIndex(m: Record<string, LastProfile>) { try { ensureDir(root()); new File(root(), 'last.json').writeSync(JSON.stringify(m)); } catch {} }

/** Ändrar en post i den mapp som var öppen när arbetet började (byttes profilen under tiden händer inget) */
function updateIn(my: string, key: string, fn: (e: DlEntry) => DlEntry, save = true): DlEntry | null {
  if (my !== scope) return null;
  const i = list.findIndex((x) => x.key === key);
  if (i < 0) return null;
  const n = fn(list[i]);
  list = list.map((x, j) => (j === i ? n : x));
  emit(); if (save) persist();
  return n;
}

// ---------- öppna och stänga ----------
/** Profilen är inloggad på servern: dess nedladdningar visas och kön fortsätter */
export function openScope(serverId: string, user: { id: number; name: string; kid?: boolean }) {
  if (!supported || !serverId || !user?.id) return;
  const m = readIndex(); m[serverId] = { uid: user.id, name: user.name, kid: !!user.kid }; writeIndex(m);
  const s = core.scopeOf(serverId, user.id);
  if (s === scope) return;
  closeScope();
  scope = s;
  list = []; screen = null; notice = ''; device = '';
  try {
    const f = new File(dirOf(s), 'list.json');
    if (f.exists) { const j = JSON.parse(f.textSync()); list = Array.isArray(j?.list) ? j.list : []; screen = core.readScreen(j?.screen); device = typeof j?.device === 'string' ? j.device : ''; }
  } catch {}
  // En klar fil som försvunnit (telefonen rensade, appens data togs bort) tas bort ur listan
  const d = dirOf(s);
  list = list.filter((e) => e && e.key && Array.isArray(e.files)).map(core.afterRestart)
    .filter((e) => e.state !== 'done' || e.files.every((f) => { try { return new File(d, f.name).exists; } catch { return false; } }));
  emit();
}
/** Servern svarar inte: visa nedladdningarna för profilen som senast var inloggad på servern */
export function openLast(serverId: string): LastProfile | null {
  if (!supported) return null;
  const last = readIndex()[serverId];
  if (!last?.uid) return null;
  openScope(serverId, { id: last.uid, name: last.name, kid: last.kid });
  return last;
}
/** Profilbyte, serverbyte: pågående nedladdning pausas (fortsätter när profilen öppnas igen) */
export function closeScope() {
  if (!scope) return;
  if (cur) { try { cur.task?.pause(); } catch {} cur = null; }
  persist(true);
  scope = ''; list = []; screen = null; notice = ''; device = '';
  emit();
}

// ---------- köa ----------
interface VideoLike { id: number; kind: string; title: string; year?: number | null; showTitle?: string; show?: number; season?: number; episode?: number; duration?: number | null; position?: number; watched?: boolean; thumb?: boolean; showPoster?: boolean; poster?: boolean }
type OfflineStatus = { status: 'none' | 'queued' | 'running' | 'ready' | 'error' | 'missing'; progress?: number; url?: string; size?: number; error?: string; subs?: { id: string; lang: string | null; label: string; forced: boolean; url: string }[] };

function mustUse() {
  if (!supported) throw new ApiError(t('Nedladdning finns bara i appen på telefonen, inte i webbläsaren.'));
  if (!scope) throw new ApiError(t('Logga in för att ladda ner.'));
}
/** Ladda ner en film eller ett avsnitt. Servern tillfrågas direkt, så att ett nej (rätten att ladda ner, familjefiltret,
 *  barnprofilens gränser) syns på en gång. false = finns redan i Nedladdat. */
export async function downloadVideo(it: VideoLike, q: string): Promise<boolean> {
  mustUse();
  const key = core.keyOf(it.kind, it.id);
  if (find(key)) return false;
  const my = scope;
  const st = await api<OfflineStatus>(`/api/items/${it.id}/offline`, { method: 'POST', body: { q } });
  if (st.status === 'error') throw new ApiError(st.error || t('Servern kunde inte förbereda filen – försök igen senare.'));
  if (my !== scope || find(key)) return false;
  list = [...list, { ...core.videoEntry(it, q), state: st.status === 'ready' ? 'queued' : 'preparing', prep: st.progress || 0 }];
  emit(); persist(true);
  const ep = it.kind === 'episode';
  saveArt(my, key, ep && it.thumb ? imageUrl(it.id, 'thumb', 480) : ep && it.show ? imageUrl(it.show, 'poster', 300) : imageUrl(it.id, 'poster', 300));
  pump();
  return true;
}
/** Ladda ner en ljudbok (alla dess filer) */
export async function downloadBook(id: number, cover = true): Promise<boolean> {
  mustUse();
  const key = core.keyOf('book', id);
  if (find(key)) return false;
  const my = scope;
  const b = await api<{ id: number; title: string; author?: string | null; narrator?: string | null; duration?: number | null; position?: number; speed?: number; chapters?: core.Chapter[]; files: { id: number; offset: number; duration: number; url: string }[] }>(`/api/audiobooks/book/${id}/offline?a=${encodeURIComponent(audioCaps())}`);
  if (!b?.files?.length) throw new ApiError(t('Boken har inga ljudfiler.'));
  if (my !== scope || find(key)) return false;
  list = [...list, core.bookEntry(b)];
  emit(); persist(true);
  if (cover) saveArt(my, key, `${session.server}/api/audiobooks/cover/${id}?w=300${session.imgToken ? '&t=' + session.imgToken : ''}`);
  pump();
  return true;
}
/** Omslaget sparas som fil, så att listan har bilder utan nät (går det inte blir det utan bild) */
function saveArt(my: string, key: string, url: string) {
  (async () => {
    const d = dirOf(my); ensureDir(d);
    await File.downloadFileAsync(url, new File(d, key + '.jpg'), { idempotent: true });
    updateIn(my, key, (x) => ({ ...x, art: true }));
  })().catch(() => {});
}
/** Omslaget som fil för en nedladdad titel (används i stället för serverns bild, så att det syns utan nät) */
export function localArt(kind: string, id: number): string | null {
  const e = scope ? find(core.keyOf(kind, id)) : null;
  return e ? artUri(e) : null;
}
export function artUri(e: DlEntry): string | null {
  if (!e.art || !scope) return null;
  try { return new File(dirOf(scope), e.key + '.jpg').uri; } catch { return null; }
}

// ---------- pausa, fortsätt, ta bort ----------
let cur: { key: string; my: string; task: DownloadTask | null; cancelled?: boolean } | null = null;
export function pause(key: string) {
  updateIn(scope, key, core.pauseEntry);
  if (cur?.key === key) { try { cur.task?.pause(); } catch {} }
}
export function resume(key: string) { updateIn(scope, key, core.resumeEntry); pump(); }
export async function remove(key: string) {
  const e = find(key);
  if (!e) return;
  if (cur?.key === key) { cur.cancelled = true; try { cur.task?.cancel(); } catch {} }
  // Serverns omkodning stoppas om den bara gjordes för den här nedladdningen
  if (e.state === 'preparing' && e.kind !== 'book') api(`/api/items/${e.id}/offline?q=${encodeURIComponent(e.q)}`, { method: 'DELETE' }).catch(() => {});
  const s = scope;
  list = list.filter((x) => x.key !== key);
  emit(); persist(true);
  dropFiles(s, e);
}
function dropFiles(s: string, e: DlEntry) {
  const d = dirOf(s);
  for (const n of [...e.files.map((f) => f.name), ...e.subs.map((x) => x.name), e.key + '.jpg']) { try { const f = new File(d, n); if (f.exists) f.delete(); } catch {} }
}
/** Tar bort allt som profilen laddat ner (utloggning, Ta bort allt). Skärmtid som inte lämnats in finns kvar. */
export function removeAll() {
  if (!scope) return;
  if (cur) { cur.cancelled = true; try { cur.task?.cancel(); } catch {} }
  try { const d = dirOf(scope); if (d.exists) d.delete(); } catch {}
  list = []; screen = screen?.plays.length ? { ...screen, status: null } : null;
  emit(); persist(true);
}
/** Servern tas bort ur listan: alla dess profilers nedladdningar tas bort */
export function removeServer(serverId: string) {
  if (!supported) return;
  if (scope && core.scopeOfServer(scope, serverId)) { removeAll(); scope = ''; emit(); }
  try { for (const x of root().exists ? root().list() : []) if (x instanceof Directory && core.scopeOfServer(x.name, serverId)) x.delete(); } catch {}
  const m = readIndex(); delete m[serverId]; writeIndex(m);
}
/** Finns det något nedladdat från servern på telefonen (någon av dess profiler)? */
export function hasServerDownloads(serverId: string): boolean {
  if (!supported) return false;
  if (scope && core.scopeOfServer(scope, serverId) && list.length) return true;
  try { return (root().exists ? root().list() : []).some((x) => x instanceof Directory && core.scopeOfServer(x.name, serverId) && x.list().some((f) => f.name !== 'list.json')); } catch { return false; }
}
/** Hur mycket som laddats ner, och hur mycket plats som finns kvar på telefonen */
export function storage(): { used: number; free: number } {
  let free = 0;
  try { free = supported ? Paths.availableDiskSpace : 0; } catch {}
  return { used: core.usedBytes(list), free };
}

// ---------- nedladdningen ----------
let running = false;
let retry: ReturnType<typeof setTimeout> | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abortErr = () => Object.assign(new Error('avbruten'), { name: 'AbortError' });
const msgOf = (e: any) => String(e?.message || e || '');
/** Fel utan svar från servern (nätet borta): status 0 från api(), eller nedladdningens fel utan statuskod */
const netErr = (e: any) => (e instanceof ApiError ? e.status === 0 : core.httpStatusOf(msgOf(e)) === 0 && !/space|ENOSPC|full/i.test(msgOf(e)));
/** Startar kön (en fil i taget) */
export function pump() {
  if (running || !scope || !supported) return;
  running = true;
  loop().catch((e) => console.warn('[offline]', e)).finally(() => { running = false; });
}
async function loop() {
  const my = scope;
  for (;;) {
    if (scope !== my) return;
    const items = core.todo(list);
    if (!items.length) return;
    let moved = false, waiting = false;
    for (const job of items) {
      const e = find(job.key);
      if (!e || !core.isActive(e) || scope !== my) continue;
      try { if ((await work(e, my)) === 'wait') waiting = true; else moved = true; }
      catch (err: any) {
        if (err?.name === 'AbortError' || scope !== my || !find(job.key)) { moved = true; continue; } // pausad, borttagen, profilbyte
        if (netErr(err)) {
          updateIn(my, job.key, (x) => (core.isActive(x) ? { ...x, state: 'queued', error: t('Väntar på kontakt med servern – fortsätter av sig själv.') } : x));
          clearTimeout(retry); retry = setTimeout(pump, timing.retry);
          return;
        }
        updateIn(my, job.key, (x) => ({ ...x, state: 'error', error: friendly(err) }));
        moved = true;
      }
    }
    if (!moved && waiting) await sleep(timing.wait);
  }
}
function friendly(err: any): string {
  if (err instanceof ApiError) return err.message;
  const code = core.httpStatusOf(msgOf(err));
  if (code === 401) return t('Länken till filen gäller inte längre – tryck Försök igen.');
  if (code === 403) return t('Servern nekade nedladdningen.');
  if (code === 404) return t('Filen finns inte längre på servern.');
  if (code) return t('Servern svarade {code} – försök igen senare.', { code });
  if (/space|ENOSPC|full/i.test(msgOf(err))) return t('Telefonen har inte plats – ta bort något i Nedladdat.');
  return t('Nedladdningen misslyckades – tryck Försök igen.');
}
/** Ett steg för posten: 'wait' = servern förbereder filen, 'done' = klar */
async function work(e: DlEntry, my: string): Promise<'wait' | 'done'> {
  if (e.kind === 'book') {
    const b = await api<{ files: { id: number; url: string }[] }>(`/api/audiobooks/book/${e.id}/offline?a=${encodeURIComponent(audioCaps())}`);
    const byId = new Map((b.files || []).map((f) => [f.id, f.url]));
    if (e.files.some((f) => !byId.get(f.id!))) throw new ApiError(t('Boken har ändrats på servern – ta bort den och ladda ner igen.'), 409);
    updateIn(my, e.key, (x) => ({ ...x, state: 'downloading', error: null }));
    for (let i = 0; i < e.files.length; i++) await fetchFile(my, e.key, i, byId.get(e.files[i].id!)!, 0);
    finish(my, e.key, []);
    return 'done';
  }
  const q = encodeURIComponent(e.q);
  let st = await api<OfflineStatus>(`/api/items/${e.id}/offline?q=${q}&subs=1`);
  if (st.status === 'none' || (st.status === 'error' && e.state !== 'preparing')) st = await api<OfflineStatus>(`/api/items/${e.id}/offline`, { method: 'POST', body: { q: e.q } });
  if (st.status === 'error') throw new ApiError(st.error || t('Servern kunde inte förbereda filen – försök igen senare.'), 500);
  if (st.status !== 'ready') { updateIn(my, e.key, (x) => (core.isActive(x) ? { ...x, state: 'preparing', prep: st.progress || 0, error: null } : x), false); return 'wait'; }
  if (!st.url) st = await api<OfflineStatus>(`/api/items/${e.id}/offline?q=${q}&subs=1`);
  if (!st.url) throw new ApiError(t('Servern gav ingen länk till filen – försök igen.'), 500);
  await fetchFile(my, e.key, 0, st.url, st.size || 0);
  // Undertexterna (små) sist – en undertext som inte går att hämta hoppas över
  const subs: DlSub[] = [];
  for (const [i, s] of (st.subs || []).slice(0, 12).entries()) {
    if (scope !== my || !find(e.key)) throw abortErr();
    const name = `${e.key}.sub${i}.vtt`;
    try { await File.downloadFileAsync(core.joinUrl(session.server, s.url), new File(dirOf(my), name), { idempotent: true }); subs.push({ name, lang: s.lang, label: s.label, forced: !!s.forced }); } catch {}
  }
  finish(my, e.key, subs);
  return 'done';
}
function finish(my: string, key: string, subs: DlSub[]) {
  updateIn(my, key, (x) => {
    const size = x.files.reduce((s, f) => s + (f.size || 0), 0);
    return { ...x, subs, state: 'done', done: Date.now(), size, got: size, error: null, resume: null };
  });
  persist(true);
}
/** Hämtar en fil till posten: vidare från där den slutade när det går, från hemadressen när den är bekräftad */
async function fetchFile(my: string, key: string, i: number, rel: string, size: number) {
  const e0 = find(key);
  if (!e0 || scope !== my) throw abortErr();
  const f0 = e0.files[i];
  if (f0.done) return;
  const single = e0.files.length === 1;
  const dir = dirOf(my); ensureDir(dir);
  const file = new File(dir, f0.name);
  const partial = () => { try { return file.exists ? file.size || 0 : 0; } catch { return 0; } };
  let plan = core.resumePlan({ os: Platform.OS, partial: partial(), expect: single ? e0.expect : undefined, size, saved: e0.resume });
  // Plats: avbryt i förväg om filen uppenbart inte får plats
  const free = storage().free;
  if (size && free && free < size - partial() + 100e6) throw new ApiError(t('Telefonen har inte plats ({need} behövs, {free} ledigt) – ta bort något i Nedladdat.', { need: core.fmtSize(size), free: core.fmtSize(free) }), 507);
  const before = e0.files.reduce((s, f, j) => s + (j !== i && f.done ? f.size : 0), 0);
  updateIn(my, key, (x) => ({ ...x, state: 'downloading', prep: 100, error: null, ...(single && size ? { size, expect: size } : {}) }));
  let last = 0;
  const onProgress = ({ bytesWritten, totalBytes }: { bytesWritten: number; totalBytes: number }) => {
    if (Date.now() - last < 500) return;
    last = Date.now();
    updateIn(my, key, (x) => ({ ...x, got: before + bytesWritten, ...(single && totalBytes > 0 && !x.size ? { size: totalBytes } : {}) }), false);
  };
  let task: DownloadTask | null = null;
  const attempt = (base: string, how: ReturnType<typeof core.resumePlan>) => {
    const url = core.joinUrl(base, rel);
    if (how.how === 'saved' && e0.resume) task = DownloadTask.fromSavable(e0.resume, { onProgress });
    else if (how.how === 'offset') task = DownloadTask.fromSavable({ url, fileUri: file.uri, isDirectory: false, resumeData: String(how.offset) }, { onProgress });
    else { if (file.exists) file.delete(); task = File.createDownloadTask(url, file, { onProgress }); }
    cur = { key, my, task };
    return how.how === 'fresh' ? task.downloadAsync() : task.resumeAsync();
  };
  const stopped = () => !!cur?.cancelled || scope !== my || !find(key);
  const bases = core.downloadBases(session.saved, session.server);
  let result: File | null;
  try {
    try { result = await attempt(bases[0], plan); }
    catch (err) {
      if (stopped()) throw abortErr();
      const code = core.httpStatusOf(msgOf(err));
      if (code === 0 && bases.length > 1) {
        // Hemadressen svarar inte längre (lämnat hemmet): vidare från den sparade adressen
        leaveHome();
        plan = Platform.OS === 'android' ? core.resumePlan({ os: 'android', partial: partial(), size }) : { how: 'fresh' };
        result = await attempt(bases[1], plan);
      } else if (code && plan.how !== 'fresh') {
        // Den sparade länken gäller inte längre (tokenen gäller ett dygn): börja om med den nya
        updateIn(my, key, (x) => ({ ...x, resume: null }));
        result = await attempt(bases[0], { how: 'fresh' });
      } else throw err;
    }
  } catch (err) { if (stopped()) throw abortErr(); throw err; }
  finally { if (cur?.key === key) cur = null; }
  if (result === null) {
    // Pausad: på iPhone sparas systemets läge så att nedladdningen kan fortsätta (även efter omstart)
    let saved: DlEntry['resume'] = null;
    if (Platform.OS === 'ios') { try { saved = (task as DownloadTask | null)?.savable() || null; } catch {} }
    updateIn(my, key, (x) => ({ ...x, state: core.isActive(x) ? 'paused' : x.state, resume: saved }));
    persist(true);
    throw abortErr();
  }
  if (stopped()) throw abortErr();
  const got = partial();
  updateIn(my, key, (x) => {
    const files = x.files.map((f, j) => (j === i ? { ...f, done: true, size: got } : f));
    return { ...x, files, resume: null, got: files.reduce((s, f) => s + (f.done ? f.size : 0), 0) };
  });
}

// ---------- uppspelning ----------
/** Den nedladdade filmen eller avsnittet, om filen finns */
export function localVideo(id: number): { entry: DlEntry; uri: string; subs: (DlSub & { uri: string })[] } | null {
  if (!supported || !scope) return null;
  const e = core.localEntry(list, 'movie', id);
  if (!e) return null;
  try {
    const d = dirOf(scope), f = new File(d, e.files[0].name);
    if (!f.exists) return null;
    return { entry: e, uri: f.uri, subs: e.subs.map((s) => ({ ...s, uri: new File(d, s.name).uri })) };
  } catch { return null; }
}
/** Undertextens text (WebVTT) */
export async function readText(name: string): Promise<string> { return new File(dirOf(scope), name).text(); }
/** Den nedladdade boken: filerna som lokala adresser och omslaget */
export function localBook(id: number): { entry: DlEntry; files: { id: number; offset: number; duration: number; uri: string }[]; cover: string | null } | null {
  if (!supported || !scope) return null;
  const e = core.localEntry(list, 'book', id);
  if (!e) return null;
  try {
    const d = dirOf(scope);
    const files = e.files.map((f) => ({ id: f.id || 0, offset: f.offset || 0, duration: f.duration || 0, uri: new File(d, f.name).uri, ok: new File(d, f.name).exists }));
    if (files.some((f) => !f.ok)) return null;
    return { entry: e, files: files.map(({ ok, ...f }) => f), cover: artUri(e) };
  } catch { return null; }
}
export const nextLocalEpisode = (e: DlEntry) => core.nextLocalEpisode(list, e);

// ---------- positioner ----------
/** Sparar positionen för en nedladdad titel. sent = servern fick den redan; annars skickas den med at när nätet finns */
export function savePosition(kind: string, id: number, pos: number, o: { done?: boolean; sent?: boolean; speed?: number } = {}) {
  const e = updateIn(scope, core.keyOf(kind, id), (x) => core.recordPosition(x, pos, o));
  if (e?.pending) syncSoon();
}
let syncing = false;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
export function syncSoon(ms = 2000) { clearTimeout(syncTimer); syncTimer = setTimeout(() => { syncPending().catch(() => {}); }, ms); }
/** Skickar positioner och skärmtid som sparats utan nät – bara för profilen som är inloggad (token hör till den) */
export async function syncPending() {
  if (syncing || !scope || !session.token) return;
  syncing = true;
  const my = scope;
  let gone = false;
  try {
    for (const e of list.filter((x) => x.pending)) {
      if (scope !== my) break;
      const req = core.progressRequest(e), sent = e.pending!;
      if (!req) continue;
      let status = 0;
      try { await api(req.path, { method: 'POST', body: req.body, timeout: 10000 }); status = 200; } catch (err: any) { status = err?.status || 0; }
      if (status === 0 || status === 401) { gone = true; break; } // inget nät eller inte inloggad: nästa gång
      updateIn(my, e.key, (x) => core.ackSent(x, sent, status));
    }
    if (!gone && scope === my) await syncScreen(my);
  } finally { syncing = false; }
}
export const pendingCount = () => core.pendingCount(list);

// ---------- skärmtid ----------
/** Senaste status från servern (GET /api/screentime eller screenTime i framstegssvaret). Väntar tid utan nät skickas den. */
export function noteScreen(status: ScreenStatus | null | undefined) {
  if (!scope || !status) return;
  screen = core.freshScreen(status, Date.now(), screen); persist();
  if (screen?.plays.length && !syncing) syncSoon();
}
/** Lämnar in tiden som spelats utan nät (POST /api/screentime/offline) och tar bort det servern tagit emot */
async function syncScreen(my: string) {
  const req = core.offlineRequest(screen, device || (device = 'expo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)));
  if (!req) return;
  const sent = req.body.entries.map((p) => ({ id: p.id, seconds: p.seconds }));
  let r: { done?: string[]; stop?: boolean; screenTime?: ScreenStatus | null } | null = null;
  try { r = await api(req.path, { method: 'POST', body: req.body, timeout: 10000 }); } catch { return; } // nästa gång
  if (scope !== my) return;
  screen = core.ackOffline(screen, sent, r); persist(true);
}
/** Hämtar statusen nu (kort väntan). false = servern svarade inte – då gäller den sparade */
export async function refreshScreen(timeout = 4000): Promise<boolean> {
  try { noteScreen(await api<ScreenStatus>('/api/screentime', { timeout })); return true; } catch { return false; }
}
export const screenGate = (audio = false) => core.screenGate(screen, new Date(), audio);
/** Tid som spelats utan kontakt med servern (audio = ljudbok): räknas här och lämnas in när nätet är tillbaka */
export function countOffline(seconds: number, audio = false) {
  const n = core.addOfflineTime(screen, new Date(), seconds, audio);
  if (n !== screen) { screen = n; persist(); }
}

// ---------- när servern svarar ----------
const checked = new Map<string, number>();
/**
 * Servern svarar (inloggad): positioner skickas, skärmtiden hämtas, kön fortsätter, och nedladdade titlar kontrolleras
 * (högst var sjätte timme): får kontot inte ladda ner längre tas allt bort, en titel som profilen inte får se längre
 * (403/404) tas bort.
 */
export async function online(canDownload?: boolean) {
  if (!scope) return;
  const my = scope;
  allowed = canDownload !== false; emit();
  if (canDownload === false) {
    if (list.length) { removeAll(); notice = t('Nedladdningarna togs bort: kontot får inte ladda ner längre.'); emit(); }
    return;
  }
  refreshScreen().catch(() => {});
  pump();
  await syncPending().catch(() => {});
  if (Date.now() - (checked.get(my) || 0) < 6 * 3600e3) return;
  checked.set(my, Date.now());
  const gone: string[] = [];
  for (const e of list.filter((x) => x.state === 'done')) {
    if (scope !== my) return;
    let status = 200;
    try { await api(e.kind === 'book' ? `/api/audiobooks/book/${e.id}` : `/api/items/${e.id}`, { timeout: 10000 }); } catch (err: any) { status = err?.status || 0; }
    if (status === 0) { checked.delete(my); return; } // nätet försvann: igen nästa gång
    if (core.accessVerdict(status) === 'remove') { await remove(e.key); gone.push(e.title); }
  }
  if (gone.length && scope === my) { notice = tn(gone.length, '{titles} togs bort från Nedladdat – profilen får inte se den längre, eller så finns den inte kvar på servern.', '{titles} togs bort från Nedladdat – profilen får inte se dem längre, eller så finns de inte kvar på servern.', { titles: gone.join(', ') }); emit(); }
}

// Appen tillbaka i förgrunden: kön och positionerna fortsätter (nätet kan ha kommit tillbaka)
AppState.addEventListener('change', (st) => { if (st === 'active' && scope) { pump(); syncSoon(500); } });
