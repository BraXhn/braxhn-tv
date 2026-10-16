// Mätvärden för Prometheus (GET /metrics). Avstängt tills en token finns (inställning eller METRICS_TOKEN);
// skrapan skickar den som "Authorization: Bearer <token>".
import crypto from 'node:crypto';
import { get, all, getSetting, setSetting } from './db.js';
import { send, fail, clientIp } from './util.js';
import { auditHooks, ipBlocked, noteFail } from './auth.js';
import * as act from './activity.js';
import * as st from './stream.js';
import * as live from './livetv.js';
import { status as scanStatus } from './scanner.js';
import * as diskmon from './diskmon.js';
import { VERSION } from './updates.js';
import './audiobooks.js'; // tabellen books

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// ---------- token ----------
export const fromEnv = () => !!process.env.METRICS_TOKEN;
export const enabled = () => fromEnv() || !!getSetting('metrics_token_hash', '');
/** Ny token: bara hashen sparas, token visas en gång */
export function newToken() {
  const t = crypto.randomBytes(24).toString('base64url');
  setSetting('metrics_token_hash', sha(t).toString('hex'));
  return t;
}
export const disable = () => setSetting('metrics_token_hash', '');
export function checkToken(h) {
  const m = /^Bearer\s+(\S{8,512})$/i.exec(String(h || '').trim());
  if (!m) return false;
  const got = sha(m[1]);
  const want = [];
  if (process.env.METRICS_TOKEN) want.push(sha(process.env.METRICS_TOKEN));
  const stored = getSetting('metrics_token_hash', '');
  if (/^[0-9a-f]{64}$/.test(stored)) want.push(Buffer.from(stored, 'hex'));
  return want.some(w => crypto.timingSafeEqual(w, got));
}

// ---------- räknare sedan start ----------
const counters = { login_fail: 0, login_ok: 0, login_locked: 0, login_denied: 0 };
auditHooks.push((event) => { if (event in counters) counters[event]++; });
const startedAt = Date.now();

// ---------- textformat ----------
const lbl = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmtNum = (v) => Number.isFinite(+v) ? String(+v) : 'NaN';
function family(out, name, type, help, samples) {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const [labels, v] of samples) {
    const l = labels && Object.keys(labels).length ? '{' + Object.entries(labels).map(([k, x]) => `${k}="${lbl(x)}"`).join(',') + '}' : '';
    out.push(`${name}${l} ${fmtNum(v)}`);
  }
}

export function render() {
  const out = [];
  family(out, 'braxhn_info', 'gauge', 'Version av BraXhn TV', [[{ version: VERSION }, 1]]);
  // Uppspelningar per läge
  const modes = { direct: 0, remux: 0, transcode: 0 };
  for (const a of act.listActive()) modes[a.mode in modes ? a.mode : 'transcode']++;
  family(out, 'braxhn_streams_active', 'gauge', 'Pågående uppspelningar per läge', Object.entries(modes).map(([m, n]) => [{ mode: m }, n]));
  // ffmpeg-processer
  const hls = st.activeTranscodes();
  const liveN = live.activeLive().length;
  const rec = get("SELECT COUNT(*) AS n FROM recordings WHERE status IN ('recording','processing')")?.n || 0;
  family(out, 'braxhn_ffmpeg_processes', 'gauge', 'Körande ffmpeg-processer', [
    [{ kind: 'remux' }, hls.filter(m => m === 'remux').length], [{ kind: 'transcode' }, hls.filter(m => m !== 'remux').length],
    [{ kind: 'live' }, liveN], [{ kind: 'dvr' }, rec]]);
  family(out, 'braxhn_transcode_sessions', 'gauge', 'HLS-sessioner i omkodningsmappen', [[null, st.sessionCount()]]);
  // Skanning
  family(out, 'braxhn_scan_running', 'gauge', '1 när en skanning pågår', [[null, scanStatus.running ? 1 : 0]]);
  family(out, 'braxhn_scan_last_timestamp_seconds', 'gauge', 'När senaste skanningen blev klar (Unix-tid)', [[null, scanStatus.last || 0]]);
  family(out, 'braxhn_scan_last_duration_seconds', 'gauge', 'Hur lång tid senaste skanningen tog',
    [[null, !scanStatus.running && scanStatus.last && scanStatus.started ? Math.max(0, scanStatus.last - scanStatus.started) : 0]]);
  family(out, 'braxhn_scan_warnings', 'gauge', 'Varningar från senaste skanningen', [[null, scanStatus.warnings?.length || 0]]);
  // Bibliotek
  const libs = all(`SELECT l.id, l.name, l.type,
    (SELECT COUNT(*) FROM items i WHERE i.library_id=l.id AND i.kind IN ('movie','show')) AS titles,
    (SELECT COUNT(*) FROM items i WHERE i.library_id=l.id AND i.kind='episode') AS episodes,
    (SELECT COUNT(*) FROM tracks t WHERE t.library_id=l.id) AS tracks,
    (SELECT COUNT(*) FROM books b WHERE b.library_id=l.id) AS books FROM libraries l ORDER BY l.id`);
  const libSamples = [];
  for (const l of libs) {
    const base = { library: l.name, type: l.type };
    if (l.type === 'movie') libSamples.push([{ ...base, kind: 'movie' }, l.titles]);
    else if (l.type === 'show') libSamples.push([{ ...base, kind: 'show' }, l.titles], [{ ...base, kind: 'episode' }, l.episodes]);
    else if (l.type === 'music') libSamples.push([{ ...base, kind: 'track' }, l.tracks]);
    else if (l.type === 'audiobook') libSamples.push([{ ...base, kind: 'book' }, l.books]);
  }
  family(out, 'braxhn_library_items', 'gauge', 'Antal titlar per bibliotek', libSamples);
  family(out, 'braxhn_users', 'gauge', 'Antal konton och profiler', [[null, get('SELECT COUNT(*) AS n FROM users').n]]);
  // Inloggningar
  family(out, 'braxhn_auth_events_total', 'counter', 'Inloggningshändelser sedan start', Object.entries(counters).map(([e, n]) => [{ event: e }, n]));
  family(out, 'braxhn_login_failures_24h', 'gauge', 'Misslyckade/nekade inloggningar senaste dygnet',
    [[null, get("SELECT COUNT(*) AS n FROM audit WHERE event IN ('login_fail','login_locked','login_denied') AND ts > ?", Math.floor(Date.now() / 1000) - 86400).n]]);
  // Live-TV och inspelningar
  const inUse = Object.values(live.tunersInUse()).reduce((a, b) => a + b, 0);
  family(out, 'braxhn_live_tuners_in_use', 'gauge', 'Tuners som används (live + inspelning)', [[null, inUse]]);
  family(out, 'braxhn_live_tuners_total', 'gauge', 'Tuners i aktiverade källor', [[null, get('SELECT COALESCE(SUM(tuner_count),0) AS n FROM tuners WHERE enabled=1').n]]);
  family(out, 'braxhn_live_sessions', 'gauge', 'Kanaler som sänds live just nu', [[null, liveN]]);
  family(out, 'braxhn_recordings', 'gauge', 'Inspelningar per status', all("SELECT status, COUNT(*) AS n FROM recordings WHERE status NOT IN ('cancelled','deleted') GROUP BY status").map(r => [{ status: r.status }, r.n]));
  // Diskutrymme
  const disk = diskmon.snapshot().entries.filter(e => e.total);
  const dl = (e) => ({ target: e.key, label: e.label, path: e.path });
  family(out, 'braxhn_disk_free_bytes', 'gauge', 'Ledigt utrymme (för icke-root)', disk.map(e => [dl(e), e.free]));
  family(out, 'braxhn_disk_total_bytes', 'gauge', 'Filsystemets storlek', disk.map(e => [dl(e), e.total]));
  family(out, 'braxhn_disk_low', 'gauge', '0 = ok, 1 = under gränsen, 2 = kritiskt', disk.map(e => [dl(e), { ok: 0, low: 1, critical: 2 }[e.level] ?? 0]));
  // Processen
  const mem = process.memoryUsage();
  family(out, 'process_resident_memory_bytes', 'gauge', 'Processens minne (RSS)', [[null, mem.rss]]);
  family(out, 'braxhn_heap_used_bytes', 'gauge', 'Använt JavaScript-heap', [[null, mem.heapUsed]]);
  family(out, 'process_start_time_seconds', 'gauge', 'När processen startade (Unix-tid)', [[null, Math.floor(startedAt / 1000)]]);
  family(out, 'braxhn_uptime_seconds', 'gauge', 'Sekunder sedan start', [[null, Math.floor(process.uptime())]]);
  return out.join('\n') + '\n';
}

/** GET /metrics – 404 när funktionen är avstängd, 401 utan rätt token */
export function serve(req, res) {
  if (!enabled()) return fail(res, 404, 'Okänd endpoint');
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Endast GET');
  const ip = clientIp(req);
  if (ipBlocked(ip)) return fail(res, 429, 'För många försök – vänta en stund');
  if (!checkToken(req.headers.authorization)) {
    noteFail(ip, null);
    return send(res, 401, { error: 'Ogiltig token' }, { 'WWW-Authenticate': 'Bearer realm="metrics"' });
  }
  const body = render();
  send(res, 200, req.method === 'HEAD' ? '' : body, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
}
