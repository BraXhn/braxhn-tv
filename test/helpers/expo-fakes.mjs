// Låtsasmoduler för Expo-appens offline.ts i Node (se expo-loader.mjs): ett filsystem i minnet, nedladdningar som
// testet styr (klar, fel, paus), och api() som svarar med testets funktion. Inget här körs i appen.

// ---------- react och react-native ----------
export function useSyncExternalStore() {}
export const Platform = { get OS() { return globalThis.__os || 'android'; } };
export const AppState = { addEventListener() { return { remove() {} }; } };

// ---------- expo-file-system ----------
const files = new Map(); // uri -> { text, size }
const dirs = new Set();
const uriOf = (parts) => parts.map((x) => (typeof x === 'string' ? x : x.uri)).join('/');
const parentOf = (uri) => uri.slice(0, uri.lastIndexOf('/'));
export const fsState = {
  files, dirs, tasks: [],
  /** Svaret på en vanlig nedladdning (File.downloadFileAsync): text, eller kasta ett fel */
  net: async () => '',
  /** Svaret på api(path, opts) */
  api: async () => ({}),
  apiCalls: [],
  reset() { files.clear(); dirs.clear(); this.tasks.length = 0; this.apiCalls.length = 0; },
};
export class Directory {
  constructor(...p) { this.uri = uriOf(p); }
  get name() { return this.uri.split('/').pop(); }
  get exists() { return dirs.has(this.uri); }
  create() { let u = this.uri; while (u.includes('/') && !u.endsWith(':')) { dirs.add(u); u = parentOf(u); } }
  delete() {
    if (!dirs.has(this.uri)) throw new Error('finns inte: ' + this.uri);
    for (const k of [...files.keys()]) if (k.startsWith(this.uri + '/')) files.delete(k);
    for (const d of [...dirs]) if (d === this.uri || d.startsWith(this.uri + '/')) dirs.delete(d);
  }
  list() {
    return [...[...dirs].filter((d) => parentOf(d) === this.uri).map((d) => new Directory(d)), ...[...files.keys()].filter((f) => parentOf(f) === this.uri).map((f) => new File(f))];
  }
}
export class File {
  constructor(...p) { this.uri = uriOf(p); }
  get name() { return this.uri.split('/').pop(); }
  get exists() { return files.has(this.uri); }
  get size() { return files.get(this.uri)?.size ?? 0; }
  textSync() { if (!files.has(this.uri)) throw new Error('finns inte'); return files.get(this.uri).text; }
  async text() { return this.textSync(); }
  writeSync(t) { if (!dirs.has(parentOf(this.uri))) throw new Error('mappen saknas: ' + parentOf(this.uri)); files.set(this.uri, { text: String(t), size: String(t).length }); }
  delete() { if (!files.has(this.uri)) throw new Error('finns inte'); files.delete(this.uri); }
  static async downloadFileAsync(url, file) { const t = await fsState.net(url); new Directory(parentOf(file.uri)).create(); files.set(file.uri, { text: String(t), size: String(t).length }); return file; }
  static createDownloadTask(url, file, opts) { return new DownloadTask(url, file, opts); }
}
/** Nedladdning som testet styr: progress(), partial() (det som hunnit skrivas), finish(), fail(), pause(), cancel() */
export class DownloadTask {
  constructor(url, file, opts, saved = null) { this.url = url; this.file = file; this.opts = opts; this.saved = saved; this.state = 'idle'; }
  run(kind) { this.kind = kind; this.state = 'active'; fsState.tasks.push(this); return new Promise((res, rej) => { this.res = res; this.rej = rej; }); }
  downloadAsync() { return this.run('fresh'); }
  resumeAsync() { return this.run('resume'); }
  progress(n, total) { this.opts?.onProgress?.({ bytesWritten: n, totalBytes: total }); }
  partial(n) { new Directory(parentOf(this.file.uri)).create(); files.set(this.file.uri, { text: '', size: n }); }
  finish(size) { this.partial(size); this.state = 'completed'; this.res(this.file); }
  fail(msg) { this.state = 'error'; this.rej(new Error(msg)); }
  pause() { this.state = 'paused'; this.res?.(null); }
  async pauseAsync() { this.pause(); }
  cancel() { this.state = 'cancelled'; this.rej?.(new Error('UnableToDownloadException: cancelled')); }
  savable() { return { url: this.url, fileUri: this.file.uri, isDirectory: false, resumeData: 'ios-data' }; }
  static fromSavable(st, opts) { return new DownloadTask(st.url, new File(st.fileUri), opts, st); }
}
export const Paths = { document: new Directory('mem:/doc'), get availableDiskSpace() { return globalThis.__free ?? 50e9; } };

// ---------- appens api.ts ----------
export class ApiError extends Error { constructor(m, status = 0, data = null) { super(m); this.status = status; this.data = data; } }
export const session = { server: '', saved: '', token: 'tok', userId: 1, imgToken: 'img', imgUntil: 0 };
export const audioCaps = () => 'mp3,aac,flac';
export const imageUrl = (id, type, w) => `${session.server}/api/image/${id}/${type}?w=${w}`;
export function leaveHome() { if (session.saved) session.server = session.saved; }
export async function api(path, opts = {}) { fsState.apiCalls.push({ path, method: opts.method || 'GET', body: opts.body }); return fsState.api(path, opts); }
