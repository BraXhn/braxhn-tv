// Catch-up (spela redan sända program) för IPTV-kanaler. Rena funktioner: kanalens adress + catch-up-läge + programmets
// tider → adressen att spela. Lägena och platshållarna följer Kodi IPTV Simple, som de flesta listor skrivs för:
//   default   catchup-source är hela adressen (relativ källa läggs till kanalens adress)
//   append    catchup-source läggs till efter kanalens adress
//   shift     ?utc={utc}&lutc={lutc} läggs till (även "timeshift", och tvg-rec utan läge)
//   flussonic …/kanal/index.m3u8 → …/kanal/index-{utc}-{duration}.m3u8, …/kanal/mpegts → …/kanal/timeshift_abs-{utc}.ts
//   xc        Xtream Codes: …/live/user/pass/123.ts → …/timeshift/user/pass/{minuter}/{Y}-{m}-{d}:{H}-{M}/123.ts
// Platshållare: {utc}/${start}/{start}, {utcend}/${end}/{end}, {lutc}/${now}/{now}/${timestamp}/{timestamp},
// {duration}, {duration:N} (delat med N), {offset:N}/${offset}, {Y} {m} {d} {H} {M} {S}, {utc:Y-m-d H:M:S} (formaterad),
// ${(b)yyyyMMddHHmmss} och ${(e)…} (början/slut i Java-format), {catchup-id}.
// Tiderna i {Y}…{S} är UTC, för Xtream i serverns tidszon (server_info.timezone).
export const DEFAULT_DAYS = 5;
const MODES = { timeshift: 'shift', fs: 'flussonic', 'flussonic-hls': 'flussonic', 'flussonic-ts': 'flussonic' };
export const modeOf = (m) => m ? (MODES[m] || m) : null;

function parts(t, tz) {
  const d = new Date(t * 1000);
  if (tz) {
    try {
      const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      const o = Object.fromEntries(f.formatToParts(d).map(p => [p.type, p.value]));
      return { Y: o.year, m: o.month, d: o.day, H: o.hour, M: o.minute, S: o.second };
    } catch {} // okänd tidszon: UTC
  }
  const p = (n) => String(n).padStart(2, '0');
  return { Y: String(d.getUTCFullYear()), m: p(d.getUTCMonth() + 1), d: p(d.getUTCDate()), H: p(d.getUTCHours()), M: p(d.getUTCMinutes()), S: p(d.getUTCSeconds()) };
}
// {utc:Y-m-d} – bokstäverna Y m d H M S byts, allt annat står kvar
const fmtShort = (t, f, tz) => { const p = parts(t, tz); return f.replace(/[YmdHMS]/g, c => p[c]); };
// ${(b)yyyy-MM-dd HH:mm:ss}
const fmtJava = (t, f, tz) => { const p = parts(t, tz); return f.replace(/yyyy|MM|dd|HH|mm|ss/g, c => ({ yyyy: p.Y, MM: p.m, dd: p.d, HH: p.H, mm: p.M, ss: p.S })[c]); };

/** Fyller i platshållarna. start/end/now i unix-sekunder. */
export function fill(tpl, { start, end, now, tz = null, id = '' }) {
  const dur = Math.max(0, end - start);
  const val = { utc: start, start, utcend: end, end, lutc: now, now, timestamp: now, duration: dur, offset: Math.max(0, now - start) };
  return String(tpl)
    .replace(/\$\{\((b|e)\)([^}]{1,40})\}/g, (_, w, f) => fmtJava(w === 'b' ? start : end, f, tz))
    .replace(/\$?\{(utc|start|utcend|end|lutc|now|timestamp|duration|offset)(?::([^}]{1,40}))?\}/g, (_, k, arg) => {
      if (arg == null) return String(val[k]);
      if (k === 'duration' || k === 'offset') { const n = parseInt(arg, 10); return String(Math.floor(val[k] / (n > 0 ? n : 1))); }
      return fmtShort(val[k], arg, tz);
    })
    .replace(/\{catchup-id\}/g, encodeURIComponent(String(id)))
    .replace(/\{([YmdHMS])\}/g, (_, c) => parts(start, tz)[c]);
}

/** Catch-up-adressen för ett program, eller null. ch: { stream_url, catchup, catchup_source, tz? }, p: { start, stop } */
export function catchupUrl(ch, p, { now = Math.floor(Date.now() / 1000), tz = ch.tz || null } = {}) {
  const mode = modeOf(ch.catchup);
  if (!mode || !p) return null;
  const url = String(ch.stream_url || '');
  const end = Math.min(p.stop, now); // pågående program: fram till nu
  const v = { start: p.start, end: Math.max(end, p.start + 60), now, tz, id: p.catchupId || '' };
  const src = ch.catchup_source || '';
  switch (mode) {
    case 'default':
    case 'vod':
      if (!src) return null;
      return /^[a-z]+:\/\//i.test(src) ? fill(src, v) : url + fill(src, v);
    case 'append':
      return src ? url + fill(src, v) : null;
    case 'shift':
      return url + (url.includes('?') ? '&' : '?') + fill('utc={utc}&lutc={lutc}', v);
    case 'flussonic': {
      const m = /^(.*\/)([^/?]*?)(\.m3u8|mpegts)(\?.*)?$/.exec(url);
      if (!m) return null;
      const q = m[4] || '';
      if (m[3] === 'mpegts') return m[1] + fill('timeshift_abs-{utc}.ts', v) + q;
      return m[1] + fill(`${m[2] || 'index'}-{utc}-{duration}.m3u8`, v) + q;
    }
    case 'xc': {
      const m = /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(\.\w+)?$/.exec(url.split('?')[0]);
      if (!m) return null;
      return `${m[1]}/timeshift/${m[2]}/${m[3]}/${Math.max(1, Math.ceil((v.end - v.start) / 60))}/${fill('{Y}-{m}-{d}:{H}-{M}', v)}/${m[4]}${m[5] && m[5] !== '.m3u8' ? m[5] : '.ts'}`;
    }
  }
  return null;
}

/** Går programmet att spela i efterhand? Påbörjade och avslutade program inom kanalens arkiv (dagar). */
export function catchupWindow(ch, p, now = Math.floor(Date.now() / 1000)) {
  if (!modeOf(ch?.catchup) || !p) return false;
  if (modeOf(ch.catchup) !== 'shift' && modeOf(ch.catchup) !== 'flussonic' && modeOf(ch.catchup) !== 'xc' && !ch.catchup_source) return false;
  const days = ch.catchup_days || DEFAULT_DAYS;
  return p.start < now - 30 && p.start >= now - days * 86400;
}
