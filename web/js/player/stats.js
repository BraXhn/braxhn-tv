// Spelarens Statistik (som "Stats for nerds"): läge och skäl, upplösning/codec in och ut, bithastighet, buffert
// framåt, tappade bildrutor, nätverkshastighet och serverns omkodningshastighet (GET /api/stream/:id/stats).
// Dessutom rapporteras varje hack (bufferten tog slut) till servern, som loggar orsaken (POST /api/stream/:id/stall).
// Laddas med videospelaren (video.js); använder bara core.js.
import { esc, locale, t } from '../core.js';

const CAUSE = () => ({
  'server-busy': t('servern var upptagen med bakgrundsjobb'),
  transcode: t('servern hann inte koda om'),
  disk: t('servern väntade på disken'),
  network: t('nätet hann inte med'),
  client: t('enheten (avkodning eller webbläsare)')
});
const mbit = (bps) => bps > 0 ? (bps / 1e6).toLocaleString(locale, { maximumFractionDigits: 1 }) + ' Mbit/s' : '–';
const num = (n, d = 1) => Number(n).toLocaleString(locale, { maximumFractionDigits: d });

/** Strömmens id och pid ur uppspelningslänken (/api/stream/<id>/…?pid=) */
export function streamRef(url) {
  try {
    const u = new URL(url, location.origin), m = /\/api\/stream\/(\d+)\//.exec(u.pathname);
    return m ? { id: m[1], pid: u.searchParams.get('pid') || '' } : null;
  } catch { return null; }
}
function bufferAhead(v) {
  for (let i = 0; i < v.buffered.length; i++) if (v.currentTime >= v.buffered.start(i) - 0.1 && v.currentTime <= v.buffered.end(i)) return v.buffered.end(i) - v.currentTime;
  return 0;
}
const dropped = (v) => { try { const q = v.getVideoPlaybackQuality(); return { dropped: q.droppedVideoFrames, total: q.totalVideoFrames }; } catch { return { dropped: 0, total: 0 }; } };

/** Mätvärden för spelaren: kopplas till hls.js (om HLS) och videoelementet. Returnerar en stoppfunktion. */
export function watchPlayback(cur, v, hls, Hls) {
  const m = cur.metrics = { stalls: 0, lastCause: '', lastFrag: null, bitrate: 0, level: null };
  const ref = streamRef(cur.pb?.url || '');
  if (hls && Hls) {
    hls.on(Hls.Events.FRAG_LOADED, (_, d) => {
      const s = d.frag?.stats, l = s?.loading;
      if (!l || !(l.end > l.start)) return;
      let wait = 0; try { wait = +d.networkDetails?.getResponseHeader?.('X-Seg-Wait') || 0; } catch {}
      m.lastFrag = { load: Math.round(l.end - l.start), first: Math.round(l.first - l.start), wait, dur: d.frag.duration || 0, bytes: s.loaded || 0 };
      if (d.frag.duration) m.bitrate = (s.loaded || 0) * 8 / d.frag.duration;
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => { m.level = hls.levels?.[d.level] || null; });
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.details === 'bufferStalledError') stalled(); });
  }
  // Ett hack = videon väntar på data mitt i uppspelningen (inte vid start eller spolning)
  let started = false, lastReport = 0;
  const onPlaying = () => { started = true; };
  const onWaiting = () => { if (started && !v.seeking && v.currentTime > 0.5) stalled(); };
  v.addEventListener('playing', onPlaying);
  v.addEventListener('waiting', onWaiting);
  function stalled() {
    if (Date.now() - lastReport < 5000 || !ref) return;
    lastReport = Date.now();
    m.stalls++;
    const body = { position: v.currentTime, buffer: bufferAhead(v), dropped: dropped(v).dropped,
      bw: hls?.bandwidthEstimate || 0, bitrate: m.level?.bitrate || m.bitrate || 0, lastFrag: m.lastFrag };
    fetch(`/api/stream/${ref.id}/stall${ref.pid ? '?pid=' + ref.pid : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.ok ? r.json() : null).then(r => { if (r?.cause) m.lastCause = r.cause; }).catch(() => {});
  }
  return () => { v.removeEventListener('playing', onPlaying); v.removeEventListener('waiting', onWaiting); };
}

/** Visar/döljer panelen. Returnerar true när den visas. */
export function toggleStats(cur, v, box) {
  if (cur.statsTimer) { stopStats(cur, box); return false; }
  box.hidden = false;
  let srv = null, busy = false;
  const ref = streamRef(cur.pb?.url || '');
  const poll = () => {
    if (!ref || busy) return;
    busy = true;
    fetch(`/api/stream/${ref.id}/stats${ref.pid ? '?pid=' + ref.pid : ''}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      .then(r => { srv = r; }).catch(() => {}).finally(() => { busy = false; });
  };
  let n = 0;
  const draw = () => {
    if (!box.isConnected) return stopStats(cur, box);
    if (n++ % 2 === 0) poll();
    box.innerHTML = rows(cur, v, srv).map(([k, val, cls]) => `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(val)}</dd>`).join('');
  };
  draw();
  cur.statsTimer = setInterval(draw, 1000);
  return true;
}
export function stopStats(cur, box) {
  clearInterval(cur.statsTimer); cur.statsTimer = null;
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

/** Raderna i panelen: [rubrik, värde, klass] */
export function rows(cur, v, srv) {
  const pb = cur.pb || {}, it = cur.it || {}, m = cur.metrics || {}, hls = cur.hls;
  const mode = { direct: t('Direkt'), remux: 'Remux', transcode: t('Omkodning') }[pb.mode] || '–';
  const s = srv?.session;
  const out = [[t('Läge'), `${mode}${pb.reasons?.length ? ' – ' + pb.reasons.join(', ') : ''}`]];
  out.push([t('In'), [it.vcodec?.toUpperCase(), it.width && it.height ? `${it.width}×${it.height}` : '', it.hdr ? it.hdr.toUpperCase() : '', it.acodec?.toUpperCase()].filter(Boolean).join(' · ') || '–']);
  const lv = m.level || (hls && hls.levels?.[hls.currentLevel]) || null;
  out.push([t('Ut'), [(pb.vcodec || '').toUpperCase(), v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '', s?.encoder && s.encoder !== 'copy' ? s.encoder : ''].filter(Boolean).join(' · ') || '–']);
  out.push([t('Bithastighet'), mbit(lv?.bitrate || m.bitrate || (it.size && it.duration ? it.size * 8 / it.duration : 0))]);
  const ahead = bufferAhead(v);
  out.push([t('Buffert framåt'), `${num(ahead)} s`, ahead < 3 && !v.paused ? 'bad' : '']);
  const d = dropped(v);
  out.push([t('Tappade bildrutor'), `${d.dropped} / ${d.total}`, d.total && d.dropped / d.total > 0.02 ? 'bad' : '']);
  const f = m.lastFrag;
  out.push([t('Nätverk'), hls ? `${mbit(hls.bandwidthEstimate)}${f ? ' · ' + t('senaste segmentet {ms} ms (väntan på servern {w} ms)', { ms: f.load, w: f.wait }) : ''}` : t('direktuppspelning (webbläsaren buffrar själv)')]);
  if (s) {
    const sp = s.speed != null ? t('{x} × realtid', { x: num(s.speed, 2) }) : '–';
    const state = s.done ? t('klar') : s.throttled ? t('pausad – ligger {s} s före', { s: s.ahead }) : t('{s} s före spelaren', { s: s.ahead });
    out.push([t('Servern'), `${sp} · ${state}`]);
    out.push([t('Hinner servern med?'), s.keepingUp ? t('Ja') : t('Nej – omkodningen är långsammare än uppspelningen'), s.keepingUp ? 'ok' : 'bad']);
    if (s.waits) out.push([t('Väntan på segment'), t('{n} gånger, längst {ms} ms', { n: s.waits, ms: s.maxWait })]);
  }
  if (srv?.loop) out.push([t('Serverns svarstid'), t('{ms} ms (sämsta 1 %)', { ms: num(srv.loop.p99) }) + (srv.loop.block?.jobs?.length ? ' · ' + srv.loop.block.jobs.join(', ') : ''), srv.loop.p99 > 50 ? 'bad' : '']);
  if (m.stalls) out.push([t('Hack'), `${m.stalls}${m.lastCause ? ' – ' + (CAUSE()[m.lastCause] || m.lastCause) : ''}`, 'bad']);
  return out;
}
