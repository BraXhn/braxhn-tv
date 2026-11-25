// Windows-appens inbyggda spelare (mpv): när får den spela, och vad får den veta? Rena funktioner utan sidan –
// testas i test/windows-native.test.js. Själva överlämningen sköts av player/native.js.

/** Kör webbappen i Windows-appen? (user agent "… BraXhnTV-Windows/<version>" och WebView2:s meddelandekanal) */
export function inWindowsApp(ua = globalThis.navigator?.userAgent || '', w = globalThis.window) {
  return /\bBraXhnTV-Windows\/\d/.test(ua) && !!w?.chrome?.webview?.postMessage;
}

// mpv spelar i stort sett allt: originalfilen skickas direkt så länge servern inte behöver ändra något (familjefilter,
// inbränd undertext, lägre kvalitet). Ljudspåret väljer spelaren själv i filen (atrack=1) och ljudet går orört vidare.
// cast=1: strömlänken får en egen kortlivad token, eftersom mpv inte har webbvyns inloggningskaka.
export const NATIVE_CAPS = {
  c: 'mp4,mkv,webm',
  v: 'h264,hevc,av1,vp9,vp8,mpeg2video,mpeg4,vc1,wmv3,msmpeg4v3',
  a: 'aac,mp3,mp2,ac3,eac3,dts,truehd,mlp,flac,alac,opus,vorbis,wmav2,pcm_s16le,pcm_s24le,pcm_s32le,pcm_bluray,pcm_dvd',
  atrack: '1', hdr: '1', dv: '1', cast: '1'
};

/**
 * Frågan till GET /api/items/:id/playback för den inbyggda spelaren.
 * o: { start, audio, version, q ('auto' = kontots val), bw (kbit/s, utanför hemmet), save ('Spara data'), cinema }
 */
export function nativeQuery(o = {}) {
  const p = new URLSearchParams(NATIVE_CAPS);
  if (o.q && o.q !== 'auto') p.set('q', o.q);
  if (o.version) p.set('version', String(o.version));
  if (o.audio !== undefined && o.audio !== '' && o.audio !== null) p.set('audio', String(o.audio));
  if (o.start > 0) p.set('start', String(Math.floor(o.start)));
  if (o.bw) p.set('bw', String(o.bw));
  if (o.save) p.set('save', '1');
  if (o.cinema) p.set('cinema', '1');
  return p.toString();
}

/**
 * Serverns svar → vad den inbyggda spelaren får, eller { use: false, why } när webbspelaren ska spela:
 *  - inte direktuppspelning (servern kodar om eller remuxar: för låg bandbredd utanför hemmet, vald kvalitet,
 *    inbränd undertext, ett filformat som inte kan skickas direkt),
 *  - familjefiltret är på för profilen (webbspelaren tystar och hoppar över scener; mpv gör det inte än),
 *  - trailers före filmen (bio-läget).
 * origin: serverns adress (strömlänkarna i svaret är relativa).
 */
export function nativePlan(it, pb, { start = 0, origin, sub = '' } = {}) {
  if (!pb || !it) return { use: false, why: 'svar saknas' };
  if (pb.mode !== 'direct') return { use: false, why: 'mode:' + pb.mode };
  if (pb.filter) return { use: false, why: 'familjefilter' };
  if (pb.preroll?.length) return { use: false, why: 'trailers' };
  if (!pb.token) return { use: false, why: 'token saknas' };
  const abs = (u) => new URL(u, origin).href;
  // Undertexter: inbäddade (e<strömindex>) läser mpv ur filen själv; filer bredvid filmen och nedladdade hämtas som WebVTT
  const urls = new Map((pb.subtitles || []).map(s => [s.id, s.url]));
  const subs = (it.subtitles || []).map(s => {
    const embedded = /^e\d+$/.test(s.id);
    return { id: s.id, label: s.label || '', lang: s.lang || '', forced: !!s.forced,
      ...(embedded ? { index: +s.id.slice(1) } : urls.get(s.id) ? { url: abs(urls.get(s.id)) } : {}) };
  }).filter(s => s.index != null || s.url);
  const title = it.kind === 'episode'
    ? [it.showTitle, `S${String(it.season ?? 0).padStart(2, '0')}E${String(it.episode ?? 0).padStart(2, '0')}`, it.title].filter(Boolean).join(' · ')
    : [it.title, it.year].filter(Boolean).join(' · ');
  return {
    use: true,
    msg: {
      t: 'native-play', id: it.id, url: abs(pb.url), title, start: Math.max(0, +start || 0), duration: pb.duration || it.duration || 0,
      // ffmpeg-index för ljudspåret servern valde (kontots språkval), och undertexten som ska vara på
      audio: pb.audioSelected != null ? +pb.audioSelected : null, sub: subs.some(s => s.id === sub) ? sub : '', subs,
      nextId: it.nextId || null, autoNext: !!pb.autoNext?.enabled,
      chapters: (pb.chapters || []).map(c => ({ start: +c.start || 0, title: c.title || '' }))
    }
  };
}

/** Framstegets kropp till POST /api/items/:id/progress (samma som webbspelaren skickar) */
export const progressBody = (pos, dur) => JSON.stringify({ position: Math.max(0, +pos || 0), duration: +dur || 0 });
