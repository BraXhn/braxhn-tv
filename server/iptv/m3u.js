// M3U-listor från IPTV-leverantörer. Tolkas rad för rad med en egen läsare (ingen regex som kan backa katastrofalt),
// linjär tid och fasta gränser: fientliga listor (miljoner rader, rader på flera MB, konstiga citattecken) ger
// aldrig mer än `max` kanaler och hoppar över det som inte går att läsa.
//
// Stöds: #EXTM3U med url-tvg/x-tvg-url, catchup, catchup-source, catchup-days, tvg-shift; #EXTINF med tvg-id,
// tvg-name, tvg-logo, group-title, tvg-chno, catchup/catchup-type, catchup-days/tvg-rec/timeshift, catchup-source,
// tvg-shift, radio, censored/parent-code; #EXTGRP; #EXTVLCOPT:http-user-agent/http-referrer; #KODIPROP med
// inputstream.adaptive.stream_headers; rubriker efter | i adressen (Kodi-stil: url|User-Agent=x&Referer=y).
// DRM-skyddade kanaler (license_key/license_type) går inte att spela och tas inte med.
import { cleanHeaders } from './net.js';

const SCHEME = /^(https?|rtp|udp|rtsp):\/\//i;
const MAX_LINE = 32 << 10;
const CTRL = /[\u0000-\u001f\u007f\u2028\u2029]/g;
export const clip = (s, n) => String(s ?? '').replace(CTRL, ' ').trim().slice(0, n);

/** Attribut i en #EXTINF/#EXTM3U-rad: key="v", key='v' eller key=v. Returnerar { attrs, rest } där rest är texten efter
 *  första kommatecknet utanför citattecken (kanalens namn). */
export function scanAttrs(s) {
  const attrs = {};
  let i = 0;
  const n = s.length;
  // Längden (-1) först i #EXTINF
  while (i < n && /[\s\d.+-]/.test(s[i])) i++;
  while (i < n) {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= n) break;
    if (s[i] === ',') return { attrs, rest: s.slice(i + 1) };
    let k = i;
    while (k < n && /[\w:.-]/.test(s[k])) k++;
    if (k === i) { i++; continue; } // okänt tecken: hoppa över
    const key = s.slice(i, k).toLowerCase();
    i = k;
    if (s[i] !== '=') continue; // ord utan värde
    i++;
    let v;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i], end = s.indexOf(q, i + 1);
      if (end < 0) { v = s.slice(i + 1); i = n; } else { v = s.slice(i + 1, end); i = end + 1; }
    } else {
      let e = i;
      while (e < n && s[e] !== ' ' && s[e] !== '\t' && s[e] !== ',') e++;
      v = s.slice(i, e); i = e;
    }
    if (Object.keys(attrs).length < 64) attrs[key] = v;
  }
  return { attrs, rest: '' };
}
const pipeHeaders = (s) => {
  const h = {};
  for (const part of String(s).split('&').slice(0, 10)) {
    const eq = part.indexOf('='); if (eq < 1) continue;
    let k = part.slice(0, eq), v = part.slice(eq + 1);
    try { k = decodeURIComponent(k); v = decodeURIComponent(v); } catch {}
    h[k] = v;
  }
  return h;
};
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const days = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) && x > 0 ? Math.min(x, 30) : null; };
const CATCHUP = new Set(['default', 'append', 'shift', 'timeshift', 'flussonic', 'flussonic-hls', 'flussonic-ts', 'fs', 'xc', 'vod']);
const ADULT = /(^|[^\p{L}\p{N}])(adult|adults|xxx|porn\w*|erotic\w*|erotik|vuxen\w*|18\s*\+|\+\s*18)($|[^\p{L}\p{N}])/iu;
export const isAdultName = (s) => ADULT.test(String(s || ''));

function header(a) {
  const tvg = [a['url-tvg'], a['x-tvg-url'], a['tvg-url']].filter(Boolean).join(',').split(/[,\s]+/).map(s => s.trim()).filter(u => /^https?:\/\//i.test(u)).slice(0, 5);
  return { epg: [...new Set(tvg)], catchup: CATCHUP.has(String(a.catchup || a['catchup-type'] || '').toLowerCase()) ? String(a.catchup || a['catchup-type']).toLowerCase() : null,
    catchupSource: a['catchup-source'] ? clip(a['catchup-source'], 2000) : null, catchupDays: days(a['catchup-days'] || a['tvg-rec'] || a.timeshift), shift: num(a['tvg-shift']) };
}

/** Tolkar en M3U-lista. Returnerar { header, entries, skipped } – entries i samma form som livetv.js syncChannels vill ha
 *  plus headers/catchup/shift/radio/adult. */
export function parseM3U(text, { max = 50000 } = {}) {
  text = String(text ?? '');
  let H = header({}), cur = null, opts = {}, grp = null, skipped = 0;
  const out = [];
  let pos = 0;
  const L = text.length;
  while (pos < L && out.length < max) {
    let nl = text.indexOf('\n', pos); if (nl < 0) nl = L;
    const len = nl - pos;
    const raw = len > MAX_LINE ? '' : text.slice(pos, nl);
    pos = nl + 1;
    if (len > MAX_LINE) { skipped++; cur = null; continue; }
    const line = raw.trim();
    if (!line) continue;
    if (line.charCodeAt(0) === 0xfeff) { const l2 = line.slice(1); if (l2.startsWith('#EXTM3U')) H = header(scanAttrs(l2.slice(7)).attrs); continue; }
    if (line.startsWith('#EXTM3U')) { H = header(scanAttrs(line.slice(7)).attrs); continue; }
    if (line.startsWith('#EXTINF')) {
      const colon = line.indexOf(':');
      const { attrs, rest } = scanAttrs(colon > 0 ? line.slice(colon + 1) : '');
      cur = { attrs, name: rest.trim() };
      continue;
    }
    if (line.startsWith('#EXTGRP:')) { grp = clip(line.slice(8), 120); continue; }
    if (line.startsWith('#EXTVLCOPT:')) {
      const o = line.slice(11), eq = o.indexOf('=');
      if (eq > 0) {
        const k = o.slice(0, eq).trim().toLowerCase(), v = o.slice(eq + 1).trim();
        if (k === 'http-user-agent') opts['User-Agent'] = v;
        else if (k === 'http-referrer' || k === 'http-referer') opts.Referer = v;
        else if (k === 'http-origin') opts.Origin = v;
      }
      continue;
    }
    if (line.startsWith('#KODIPROP:')) {
      const o = line.slice(10), eq = o.indexOf('=');
      if (eq > 0) {
        const k = o.slice(0, eq).trim().toLowerCase(), v = o.slice(eq + 1).trim();
        if (k === 'inputstream.adaptive.stream_headers' || k === 'inputstream.adaptive.common_headers') Object.assign(opts, pipeHeaders(v));
        else if (/license_(key|type)|drm/.test(k) && v) opts.__drm = true;
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!cur) { opts = {}; grp = null; continue; } // adress utan #EXTINF
    let url = line, extra = {};
    const bar = url.indexOf('|');
    if (bar > 0) { extra = pipeHeaders(url.slice(bar + 1)); url = url.slice(0, bar); }
    const a = cur.attrs;
    if (SCHEME.test(url) && url.length <= 4000 && !opts.__drm) {
      // Kanalens egna catch-up-attribut, annars listans (#EXTM3U)
      const type = String(a.catchup || a['catchup-type'] || '').toLowerCase() || H.catchup || '';
      const cdays = days(a['catchup-days'] || a['tvg-rec'] || a.timeshift) ?? H.catchupDays;
      const src = a['catchup-source'] ? clip(a['catchup-source'], 2000) : H.catchupSource;
      const group = clip(a['group-title'] || grp || '', 120) || null;
      const name = clip(cur.name || a['tvg-name'] || 'Kanal', 120) || 'Kanal';
      out.push({
        name, url,
        epg: clip(a['tvg-id'] || '', 200) || null,
        logo: /^https?:\/\//i.test(a['tvg-logo'] || a.logo || '') ? clip(a['tvg-logo'] || a.logo, 2000) : null,
        group,
        number: clip(a['tvg-chno'] || a['channel-number'] || a['tvg-num'] || '', 12) || null,
        headers: cleanHeaders({ ...opts, ...extra }),
        catchup: CATCHUP.has(type) ? type : (src ? 'default' : cdays ? 'shift' : null),
        catchupDays: cdays, catchupSource: src,
        shift: num(a['tvg-shift']) ?? H.shift,
        radio: /^(true|1)$/i.test(a.radio || '') ? 1 : 0,
        adult: /^(1|true)$/i.test(a.censored || '') || !!a['parent-code'] || isAdultName(group) ? 1 : 0,
        hd: /\b(hd|fhd|uhd|4k)\b/i.test(name) ? 1 : 0,
      });
    } else skipped++;
    cur = null; opts = {}; grp = null;
  }
  return { header: H, entries: out, skipped };
}
