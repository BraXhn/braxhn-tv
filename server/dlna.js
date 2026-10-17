// DLNA/UPnP-mediaserver: smart-TV och mediaspelare utan app hittar biblioteket på hemnätet.
// Avstängt som standard (inställning eller DLNA=1). SSDP (multicast 239.255.255.250:1900) annonserar servern,
// ContentDirectory listar Filmer, Serier → säsonger → avsnitt och Musik → album → spår, och filerna skickas direkt
// (utan omkodning) med Range-stöd.
//
// Säkerhetsavvägning: DLNA-klienter kan inte logga in. Därför svarar /dlna/ bara till betrodda nät (hemnät/VPN enligt
// inställningarna) och aldrig på förfrågningar som gått via en omvänd proxy (X-Forwarded-For m.fl.), så att en proxy
// som släpper in internet inte öppnar biblioteket. Alla på hemnätet kan se det som DLNA visar – därför finns en
// åldersgräns (standard: samma som huvudkontot, dvs. allt) som döljer titlar över den nivån.
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, all, getSetting, setSetting, IMAGES } from './db.js';
import { send, fail, streamFile, isPrivate, inCidr } from './util.js';
import { VERSION } from './updates.js';

const PORT = +process.env.PORT || 8420;
const MCAST = '239.255.255.250', SSDP_PORT = 1900, MAX_AGE = 1800;

// ---------- inställningar ----------
export const enabled = () => getSetting('dlna_enabled', process.env.DLNA === '1' ? '1' : '0') === '1';
export const friendlyName = () => String(getSetting('dlna_name', 'BraXhn TV') || 'BraXhn TV').slice(0, 60);
export function uuid() {
  let u = getSetting('dlna_uuid', '');
  if (!/^[0-9a-f-]{36}$/.test(u)) { u = crypto.randomUUID(); setSetting('dlna_uuid', u); }
  return u;
}
/** Högsta åldersgräns som visas. Tom inställning = huvudkontots gräns (normalt ingen). null = allt. */
export function maxAge() {
  const v = getSetting('dlna_max_age', '');
  if (v !== '' && v != null && Number.isFinite(+v)) return +v;
  return get('SELECT max_age FROM users WHERE parent_id IS NULL ORDER BY id LIMIT 1')?.max_age ?? null;
}
const allowUnrated = () => getSetting('allow_unrated', '0') === '1';
function ageSql() {
  const max = maxAge();
  return max == null ? { sql: '', params: [] } : { sql: ' AND COALESCE(i.age, s.age, ?) <= ?', params: [allowUnrated() ? max : 999, max] };
}

// ---------- XML ----------
export const xml = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export const unxml = (s) => String(s ?? '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (m, e) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
  if (named) return named;
  try { return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)); } catch { return m; }
});

const VIDEO_MIME = { '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.ts': 'video/vnd.dlna.mpeg-tts', '.m2ts': 'video/vnd.dlna.mpeg-tts', '.mts': 'video/vnd.dlna.mpeg-tts', '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.flv': 'video/x-flv' };
const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.alac': 'audio/mp4' };
const mimeOf = (p, map, def) => map[path.extname(String(p || '')).toLowerCase()] || def;
const FEATURES = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
const dur = (s) => { s = Math.max(0, +s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(3).padStart(6, '0')}`; };
const ext = (p) => (path.extname(String(p || '')).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin');

// ---------- innehåll ----------
const ITEM_SQL = `SELECT i.id, i.kind, i.title, i.year, i.path, i.size, i.duration, i.width, i.height, i.season, i.episode, i.parent_id, i.library_id,
  i.poster, i.thumb, i.overview, s.title AS show_title, s.poster AS show_poster FROM items i LEFT JOIN items s ON s.id=i.parent_id`;
const videoLibs = () => all("SELECT id, name, type FROM libraries WHERE type IN ('movie','show','music') ORDER BY name");

function itemAllowed(id, kinds) {
  const a = ageSql();
  return get(`${ITEM_SQL} WHERE i.id=? AND i.kind IN (${kinds.map(() => '?').join(',')})${a.sql}`, id, ...kinds, ...a.params) || null;
}
function libCount(l) {
  const a = ageSql();
  if (l.type === 'music') return get('SELECT COUNT(*) AS n FROM albums WHERE library_id=?', l.id).n;
  return get(`SELECT COUNT(*) AS n FROM items i LEFT JOIN items s ON s.id=i.parent_id WHERE i.library_id=? AND i.kind=? AND i.version_of IS NULL${a.sql}`, l.id, l.type === 'movie' ? 'movie' : 'show', ...a.params).n;
}

function container(id, parent, title, count, cls = 'object.container.storageFolder', extra = '') {
  return `<container id="${xml(id)}" parentID="${xml(parent)}" restricted="1" searchable="0"${count != null ? ` childCount="${count}"` : ''}>` +
    `<dc:title>${xml(title)}</dc:title><upnp:class>${cls}</upnp:class>${extra}</container>`;
}
function videoItem(it, parent, base) {
  const ep = it.kind === 'episode';
  const title = ep ? `${it.episode != null ? it.episode + '. ' : ''}${it.title}` : it.title;
  const art = it.poster ? `${base}/dlna/art/${it.id}.jpg` : it.thumb ? `${base}/dlna/art/${it.id}.jpg` : ep && it.show_poster ? `${base}/dlna/art/${it.parent_id}.jpg` : null;
  const res = `<res protocolInfo="http-get:*:${mimeOf(it.path, VIDEO_MIME, 'video/mpeg')}:${FEATURES}"${it.size ? ` size="${+it.size}"` : ''}` +
    `${it.duration ? ` duration="${dur(it.duration)}"` : ''}${it.width && it.height ? ` resolution="${+it.width}x${+it.height}"` : ''}>${xml(`${base}/dlna/media/${it.id}${ext(it.path)}`)}</res>`;
  return `<item id="I${it.id}" parentID="${xml(parent)}" restricted="1"><dc:title>${xml(title)}</dc:title>` +
    `<upnp:class>${ep ? 'object.item.videoItem' : 'object.item.videoItem.movie'}</upnp:class>` +
    (it.year ? `<dc:date>${+it.year}-01-01</dc:date>` : '') +
    (it.overview ? `<dc:description>${xml(String(it.overview).slice(0, 500))}</dc:description>` : '') +
    (ep ? `<upnp:seriesTitle>${xml(it.show_title || '')}</upnp:seriesTitle>${it.season != null ? `<upnp:episodeSeason>${+it.season}</upnp:episodeSeason>` : ''}${it.episode != null ? `<upnp:episodeNumber>${+it.episode}</upnp:episodeNumber>` : ''}` : '') +
    (art ? `<upnp:albumArtURI dlna:profileID="JPEG_TN">${xml(art)}</upnp:albumArtURI>` : '') + res + '</item>';
}
function trackItem(t, base) {
  return `<item id="T${t.id}" parentID="A${t.album_id}" restricted="1"><dc:title>${xml(t.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    (t.artist ? `<upnp:artist>${xml(t.artist)}</upnp:artist><dc:creator>${xml(t.artist)}</dc:creator>` : '') +
    (t.album ? `<upnp:album>${xml(t.album)}</upnp:album>` : '') + (t.track_no ? `<upnp:originalTrackNumber>${+t.track_no}</upnp:originalTrackNumber>` : '') +
    (t.cover ? `<upnp:albumArtURI dlna:profileID="JPEG_TN">${xml(`${base}/dlna/cover/${t.album_id}.jpg`)}</upnp:albumArtURI>` : '') +
    `<res protocolInfo="http-get:*:${mimeOf(t.path, AUDIO_MIME, 'audio/mpeg')}:${FEATURES}"${t.size ? ` size="${+t.size}"` : ''}${t.duration ? ` duration="${dur(t.duration)}"` : ''}>` +
    `${xml(`${base}/dlna/track/${t.id}${ext(t.path)}`)}</res></item>`;
}
const TRACK_SQL = `SELECT t.id, t.title, t.track_no, t.disc_no, t.duration, t.path, t.size, t.album_id, al.title AS album, al.cover, ar.name AS artist
  FROM tracks t LEFT JOIN albums al ON al.id=t.album_id LEFT JOIN artists ar ON ar.id=COALESCE(t.artist_id, al.artist_id)`;
const albumSql = `SELECT al.id, al.title, al.year, al.cover, al.library_id, ar.name AS artist, (SELECT COUNT(*) FROM tracks t WHERE t.album_id=al.id) AS n
  FROM albums al LEFT JOIN artists ar ON ar.id=al.artist_id`;
const albumNode = (al, base) => container(`A${al.id}`, `L${al.library_id}`, al.title, al.n, 'object.container.album.musicAlbum',
  (al.artist ? `<upnp:artist>${xml(al.artist)}</upnp:artist><dc:creator>${xml(al.artist)}</dc:creator>` : '') +
  (al.cover ? `<upnp:albumArtURI dlna:profileID="JPEG_TN">${xml(`${base}/dlna/cover/${al.id}.jpg`)}</upnp:albumArtURI>` : ''));
function showNode(sh, base) {
  const n = get('SELECT COUNT(DISTINCT season) AS n FROM items WHERE parent_id=? AND kind=\'episode\'', sh.id).n;
  return container(`S${sh.id}`, `L${sh.library_id}`, sh.title, n, 'object.container.storageFolder',
    sh.poster ? `<upnp:albumArtURI dlna:profileID="JPEG_TN">${xml(`${base}/dlna/art/${sh.id}.jpg`)}</upnp:albumArtURI>` : '');
}
const seasonName = (n) => n === 0 ? 'Extramaterial' : `Säsong ${n}`;

/** Barn till ett objekt: { nodes: [xml], total } (null = finns inte). Sidindelning görs här. */
export function children(id, base, start = 0, count = 0) {
  const lim = count > 0 ? Math.min(count, 5000) : 5000, off = Math.max(0, start);
  const a = ageSql();
  let m;
  if (id === '0') {
    const libs = videoLibs();
    return { nodes: libs.slice(off, off + lim).map(l => container(`L${l.id}`, '0', l.name, libCount(l))), total: libs.length };
  }
  if ((m = /^L(\d+)$/.exec(id))) {
    const l = get("SELECT id, name, type FROM libraries WHERE id=? AND type IN ('movie','show','music')", +m[1]);
    if (!l) return null;
    if (l.type === 'music') {
      const rows = all(`${albumSql} WHERE al.library_id=? ORDER BY COALESCE(ar.sort_name, ar.name, ''), al.year, al.title LIMIT ? OFFSET ?`, l.id, lim, off);
      return { nodes: rows.map(r => albumNode(r, base)), total: libCount(l) };
    }
    const kind = l.type === 'movie' ? 'movie' : 'show';
    const rows = all(`${ITEM_SQL} WHERE i.library_id=? AND i.kind=? AND i.version_of IS NULL${a.sql} ORDER BY i.sort_title, i.title LIMIT ? OFFSET ?`, l.id, kind, ...a.params, lim, off);
    return { nodes: rows.map(r => kind === 'movie' ? videoItem(r, id, base) : showNode(r, base)), total: libCount(l) };
  }
  if ((m = /^S(\d+)$/.exec(id))) {
    const sh = itemAllowed(+m[1], ['show']);
    if (!sh) return null;
    const seasons = all("SELECT season, COUNT(*) AS n FROM items WHERE parent_id=? AND kind='episode' GROUP BY season ORDER BY season", sh.id);
    return { nodes: seasons.slice(off, off + lim).map(s => container(`E${sh.id}_${s.season ?? 0}`, id, seasonName(s.season ?? 0), s.n)), total: seasons.length };
  }
  if ((m = /^E(\d+)_(\d+)$/.exec(id))) {
    const sh = itemAllowed(+m[1], ['show']);
    if (!sh) return null;
    const eps = all(`${ITEM_SQL} WHERE i.parent_id=? AND i.kind='episode' AND COALESCE(i.season,0)=? ORDER BY i.episode, i.title`, sh.id, +m[2]);
    if (!eps.length) return null;
    return { nodes: eps.slice(off, off + lim).map(e => videoItem(e, id, base)), total: eps.length };
  }
  if ((m = /^A(\d+)$/.exec(id))) {
    if (!get('SELECT 1 FROM albums WHERE id=?', +m[1])) return null;
    const tr = all(`${TRACK_SQL} WHERE t.album_id=? ORDER BY t.disc_no, t.track_no, t.title`, +m[1]);
    return { nodes: tr.slice(off, off + lim).map(t => trackItem(t, base)), total: tr.length };
  }
  if (/^[IT]\d+$/.test(id)) return metadata(id, base) ? { nodes: [], total: 0 } : null;
  return null;
}

/** Objektet självt (BrowseMetadata) */
export function metadata(id, base) {
  let m;
  if (id === '0') return `<container id="0" parentID="-1" restricted="1" searchable="0" childCount="${videoLibs().length}"><dc:title>${xml(friendlyName())}</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`;
  if ((m = /^L(\d+)$/.exec(id))) {
    const l = get("SELECT id, name, type FROM libraries WHERE id=? AND type IN ('movie','show','music')", +m[1]);
    return l ? container(id, '0', l.name, libCount(l)) : null;
  }
  if ((m = /^S(\d+)$/.exec(id))) { const sh = itemAllowed(+m[1], ['show']); return sh ? showNode(sh, base) : null; }
  if ((m = /^E(\d+)_(\d+)$/.exec(id))) {
    const sh = itemAllowed(+m[1], ['show']);
    const n = sh ? get("SELECT COUNT(*) AS n FROM items WHERE parent_id=? AND kind='episode' AND COALESCE(season,0)=?", sh.id, +m[2]).n : 0;
    return n ? container(id, `S${sh.id}`, seasonName(+m[2]), n) : null;
  }
  if ((m = /^I(\d+)$/.exec(id))) {
    const it = itemAllowed(+m[1], ['movie', 'episode']);
    if (!it) return null;
    return videoItem(it, it.kind === 'movie' ? `L${it.library_id}` : `E${it.parent_id}_${it.season ?? 0}`, base);
  }
  if ((m = /^A(\d+)$/.exec(id))) { const al = get(`${albumSql} WHERE al.id=?`, +m[1]); return al ? albumNode(al, base) : null; }
  if ((m = /^T(\d+)$/.exec(id))) { const t = get(`${TRACK_SQL} WHERE t.id=?`, +m[1]); return t ? trackItem(t, base) : null; }
  return null;
}

const DIDL_OPEN = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">';
export const didl = (nodes) => DIDL_OPEN + nodes.join('') + '</DIDL-Lite>';
export const systemUpdateId = () => (get('SELECT COALESCE(MAX(added),0) AS a FROM items').a + get('SELECT COUNT(*) AS n FROM tracks').n) % 2147483647;

// ---------- SOAP ----------
const CDS = 'urn:schemas-upnp-org:service:ContentDirectory:1', CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1';
const envelope = (inner) => `<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`;
const response = (svc, action, args) => envelope(`<u:${action}Response xmlns:u="${svc}">${Object.entries(args).map(([k, v]) => `<${k}>${xml(v)}</${k}>`).join('')}</u:${action}Response>`);
const fault = (code, desc) => envelope(`<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${xml(desc)}</errorDescription></UPnPError></detail></s:Fault>`);
export function soapArg(body, name) {
  const re = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s[^<>]*)?(?:/>|>([^<]*)</(?:[A-Za-z_][\\w.-]*:)?${name}>)`);
  const m = re.exec(body);
  return m ? unxml(m[1] || '') : null;
}

/** Hanterar ett SOAP-anrop. Returnerar { status, body }. */
export function soap(service, action, body, base) {
  if (service === 'ContentDirectory') {
    if (action === 'Browse') {
      const id = soapArg(body, 'ObjectID'), flag = soapArg(body, 'BrowseFlag');
      if (id == null || !['BrowseDirectChildren', 'BrowseMetadata'].includes(flag)) return { status: 500, body: fault(402, 'Invalid Args') };
      const start = Math.max(0, parseInt(soapArg(body, 'StartingIndex')) || 0), count = Math.max(0, parseInt(soapArg(body, 'RequestedCount')) || 0);
      let nodes, total;
      if (flag === 'BrowseMetadata') { const n = metadata(id, base); if (!n) return { status: 500, body: fault(701, 'No such object') }; nodes = [n]; total = 1; }
      else { const c = children(id, base, start, count); if (!c) return { status: 500, body: fault(701, 'No such object') }; ({ nodes, total } = c); }
      return { status: 200, body: response(CDS, 'Browse', { Result: didl(nodes), NumberReturned: nodes.length, TotalMatches: total, UpdateID: systemUpdateId() }) };
    }
    if (action === 'GetSearchCapabilities') return { status: 200, body: response(CDS, action, { SearchCaps: '' }) };
    if (action === 'GetSortCapabilities') return { status: 200, body: response(CDS, action, { SortCaps: '' }) };
    if (action === 'GetSystemUpdateID') return { status: 200, body: response(CDS, action, { Id: systemUpdateId() }) };
  }
  if (service === 'ConnectionManager') {
    if (action === 'GetProtocolInfo') return { status: 200, body: response(CMS, action, { Source: [...new Set([...Object.values(VIDEO_MIME), ...Object.values(AUDIO_MIME), 'image/jpeg'])].map(m => `http-get:*:${m}:*`).join(','), Sink: '' }) };
    if (action === 'GetCurrentConnectionIDs') return { status: 200, body: response(CMS, action, { ConnectionIDs: '0' }) };
    if (action === 'GetCurrentConnectionInfo') return { status: 200, body: response(CMS, action, { RcsID: -1, AVTransportID: -1, ProtocolInfo: '', PeerConnectionManager: '', PeerConnectionID: -1, Direction: 'Output', Status: 'OK' }) };
  }
  return { status: 500, body: fault(401, 'Invalid Action') };
}

// ---------- beskrivningar ----------
export function description() {
  const svc = (type, name) => `<service><serviceType>urn:schemas-upnp-org:service:${type}:1</serviceType><serviceId>urn:upnp-org:serviceId:${type}</serviceId>` +
    `<SCPDURL>/dlna/${type}.xml</SCPDURL><controlURL>/dlna/control/${type}</controlURL><eventSubURL>/dlna/event/${type}</eventSubURL></service>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>${xml(friendlyName())}</friendlyName>
<manufacturer>BraXhn</manufacturer><manufacturerURL>https://github.com/BraXhn/braxhn-tv</manufacturerURL><modelDescription>Självhostad mediaserver</modelDescription>
<modelName>BraXhn TV</modelName><modelNumber>${xml(VERSION)}</modelNumber><UDN>uuid:${uuid()}</UDN><dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>
<presentationURL>/</presentationURL><serviceList>${svc('ContentDirectory')}${svc('ConnectionManager')}</serviceList></device></root>`;
}
const arg = (name, dir, v) => `<argument><name>${name}</name><direction>${dir}</direction><relatedStateVariable>${v}</relatedStateVariable></argument>`;
const action = (name, args) => `<action><name>${name}</name><argumentList>${args.join('')}</argumentList></action>`;
const sv = (name, type, events = 'no', extra = '') => `<stateVariable sendEvents="${events}"><name>${name}</name><dataType>${type}</dataType>${extra}</stateVariable>`;
const scpd = (actions, vars) => `<?xml version="1.0" encoding="utf-8"?>\n<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>${actions.join('')}</actionList><serviceStateTable>${vars.join('')}</serviceStateTable></scpd>`;
export const SCPD = {
  ContentDirectory: () => scpd([
    action('Browse', [arg('ObjectID', 'in', 'A_ARG_TYPE_ObjectID'), arg('BrowseFlag', 'in', 'A_ARG_TYPE_BrowseFlag'), arg('Filter', 'in', 'A_ARG_TYPE_Filter'),
      arg('StartingIndex', 'in', 'A_ARG_TYPE_Index'), arg('RequestedCount', 'in', 'A_ARG_TYPE_Count'), arg('SortCriteria', 'in', 'A_ARG_TYPE_SortCriteria'),
      arg('Result', 'out', 'A_ARG_TYPE_Result'), arg('NumberReturned', 'out', 'A_ARG_TYPE_Count'), arg('TotalMatches', 'out', 'A_ARG_TYPE_Count'), arg('UpdateID', 'out', 'A_ARG_TYPE_UpdateID')]),
    action('GetSearchCapabilities', [arg('SearchCaps', 'out', 'SearchCapabilities')]),
    action('GetSortCapabilities', [arg('SortCaps', 'out', 'SortCapabilities')]),
    action('GetSystemUpdateID', [arg('Id', 'out', 'SystemUpdateID')])
  ], [sv('A_ARG_TYPE_ObjectID', 'string'), sv('A_ARG_TYPE_BrowseFlag', 'string', 'no', '<allowedValueList><allowedValue>BrowseMetadata</allowedValue><allowedValue>BrowseDirectChildren</allowedValue></allowedValueList>'),
    sv('A_ARG_TYPE_Filter', 'string'), sv('A_ARG_TYPE_Index', 'ui4'), sv('A_ARG_TYPE_Count', 'ui4'), sv('A_ARG_TYPE_SortCriteria', 'string'), sv('A_ARG_TYPE_Result', 'string'),
    sv('A_ARG_TYPE_UpdateID', 'ui4'), sv('SearchCapabilities', 'string'), sv('SortCapabilities', 'string'), sv('SystemUpdateID', 'ui4', 'yes')]),
  ConnectionManager: () => scpd([
    action('GetProtocolInfo', [arg('Source', 'out', 'SourceProtocolInfo'), arg('Sink', 'out', 'SinkProtocolInfo')]),
    action('GetCurrentConnectionIDs', [arg('ConnectionIDs', 'out', 'CurrentConnectionIDs')]),
    action('GetCurrentConnectionInfo', [arg('ConnectionID', 'in', 'A_ARG_TYPE_ConnectionID'), arg('RcsID', 'out', 'A_ARG_TYPE_RcsID'), arg('AVTransportID', 'out', 'A_ARG_TYPE_AVTransportID'),
      arg('ProtocolInfo', 'out', 'A_ARG_TYPE_ProtocolInfo'), arg('PeerConnectionManager', 'out', 'A_ARG_TYPE_ConnectionManager'), arg('PeerConnectionID', 'out', 'A_ARG_TYPE_ConnectionID'),
      arg('Direction', 'out', 'A_ARG_TYPE_Direction'), arg('Status', 'out', 'A_ARG_TYPE_ConnectionStatus')])
  ], [sv('SourceProtocolInfo', 'string', 'yes'), sv('SinkProtocolInfo', 'string', 'yes'), sv('CurrentConnectionIDs', 'string', 'yes'), sv('A_ARG_TYPE_ConnectionID', 'i4'),
    sv('A_ARG_TYPE_RcsID', 'i4'), sv('A_ARG_TYPE_AVTransportID', 'i4'), sv('A_ARG_TYPE_ProtocolInfo', 'string'), sv('A_ARG_TYPE_ConnectionManager', 'string'),
    sv('A_ARG_TYPE_Direction', 'string', 'no', '<allowedValueList><allowedValue>Input</allowedValue><allowedValue>Output</allowedValue></allowedValueList>'),
    sv('A_ARG_TYPE_ConnectionStatus', 'string', 'no', '<allowedValueList><allowedValue>OK</allowedValue><allowedValue>ContentFormatMismatch</allowedValue><allowedValue>InsufficientBandwidth</allowedValue><allowedValue>UnreliableChannel</allowedValue><allowedValue>Unknown</allowedValue></allowedValueList>')])
};

// ---------- HTTP ----------
const XML_TYPE = 'text/xml; charset="utf-8"';
// Adressen som klienten använde (för länkar i svaren); annars serverns egen adress
function baseUrl(req) {
  const h = String(req.headers.host || '');
  if (/^(\[[0-9a-f:.]+\]|[a-z0-9.-]{1,253})(:\d{1,5})?$/i.test(h)) return `http://${h}`;
  return `http://${addressFor(req.socket.remoteAddress)}:${PORT}`;
}
async function readBody(req, limit = 65536) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('För stor förfrågan'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
const viaProxy = (req) => ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto'].some(h => req.headers[h] != null);

/** /dlna/… – trusted = klienten är på ett betrott nät (isTrusted i http/router.js) */
export async function handle(req, res, url, { trusted }) {
  if (!enabled()) return fail(res, 404, 'Okänd endpoint');
  if (!trusted || viaProxy(req)) return fail(res, 403, 'DLNA är bara tillgängligt på hemnätverket');
  const p = url.pathname, m = req.method;
  res.setHeader('Server', `${os.type()}/${os.release()} UPnP/1.0 BraXhnTV/${VERSION}`);
  if ((m === 'GET' || m === 'HEAD') && p === '/dlna/description.xml') return send(res, 200, m === 'HEAD' ? '' : description(), { 'Content-Type': XML_TYPE });
  let x;
  if ((m === 'GET' || m === 'HEAD') && (x = /^\/dlna\/(ContentDirectory|ConnectionManager)\.xml$/.exec(p))) return send(res, 200, m === 'HEAD' ? '' : SCPD[x[1]](), { 'Content-Type': XML_TYPE });
  if (m === 'POST' && (x = /^\/dlna\/control\/(ContentDirectory|ConnectionManager)$/.exec(p))) {
    const body = await readBody(req);
    const act = /#([A-Za-z_]\w*)"?\s*$/.exec(String(req.headers.soapaction || ''))?.[1] || /<(?:[A-Za-z_][\w.-]*:)?Body[^>]*>\s*<(?:[A-Za-z_][\w.-]*:)?([A-Za-z_]\w*)/.exec(body)?.[1];
    const r = soap(x[1], act, body, baseUrl(req));
    return send(res, r.status, r.body, { 'Content-Type': XML_TYPE, EXT: '' });
  }
  if ((m === 'SUBSCRIBE' || m === 'UNSUBSCRIBE') && /^\/dlna\/event\/(ContentDirectory|ConnectionManager)$/.test(p)) {
    // Händelser skickas inte, men klienter som prenumererar ska få ett giltigt svar
    if (m === 'UNSUBSCRIBE') return send(res, 200, '');
    return send(res, 200, '', { SID: String(req.headers.sid || `uuid:${crypto.randomUUID()}`).slice(0, 100), TIMEOUT: 'Second-1800' });
  }
  if (m !== 'GET' && m !== 'HEAD') return fail(res, 405, 'Metoden stöds inte');
  const dlnaHeaders = (type) => ({ 'Content-Type': type, 'transferMode.dlna.org': 'Streaming', 'contentFeatures.dlna.org': FEATURES, 'Cache-Control': 'no-store' });
  if ((x = /^\/dlna\/media\/(\d+)(\.[a-z0-9]{1,5})?$/.exec(p))) {
    const it = itemAllowed(+x[1], ['movie', 'episode']);
    if (!it?.path) return fail(res, 404, 'Finns inte');
    let s; try { s = fs.statSync(it.path); } catch { return fail(res, 404, 'Filen hittades inte'); }
    return streamFile(req, res, it.path, s.size, dlnaHeaders(mimeOf(it.path, VIDEO_MIME, 'video/mpeg')));
  }
  if ((x = /^\/dlna\/track\/(\d+)(\.[a-z0-9]{1,5})?$/.exec(p))) {
    const t = get('SELECT path FROM tracks WHERE id=?', +x[1]);
    if (!t?.path) return fail(res, 404, 'Finns inte');
    let s; try { s = fs.statSync(t.path); } catch { return fail(res, 404, 'Filen hittades inte'); }
    return streamFile(req, res, t.path, s.size, dlnaHeaders(mimeOf(t.path, AUDIO_MIME, 'audio/mpeg')));
  }
  let img = null;
  if ((x = /^\/dlna\/art\/(\d+)\.jpg$/.exec(p))) {
    const it = itemAllowed(+x[1], ['movie', 'show', 'episode']);
    if (it) img = [`${it.id}-poster.jpg`, `${it.id}-thumb.jpg`].map(f => path.join(IMAGES, f)).find(f => fs.existsSync(f));
  } else if ((x = /^\/dlna\/cover\/(\d+)\.jpg$/.exec(p))) img = path.join(IMAGES, `a${+x[1]}-cover.jpg`);
  if (img) {
    let s; try { s = fs.statSync(img); } catch { return fail(res, 404, 'Ingen bild'); }
    return streamFile(req, res, img, s.size, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' }, { ranges: false });
  }
  fail(res, 404, 'Finns inte');
}

// ---------- SSDP ----------
/** Serverns IPv4-adresser på nätverkskorten (inte loopback). DLNA_IP sätter adressen manuellt. */
export function localAddrs() {
  if (process.env.DLNA_IP) return [{ address: process.env.DLNA_IP, cidr: `${process.env.DLNA_IP}/0` }];
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, cidr: a.cidr || `${a.address}/24` });
  return out;
}
export function addressFor(remote) {
  const ip = String(remote || '').replace(/^::ffff:/, '');
  const list = localAddrs();
  return (list.find(a => inCidr(ip, a.cidr)) || list[0])?.address || '127.0.0.1';
}
export const searchTypes = () => ['upnp:rootdevice', `uuid:${uuid()}`, 'urn:schemas-upnp-org:device:MediaServer:1', CDS, CMS];
const usn = (t) => t.startsWith('uuid:') ? t : `uuid:${uuid()}::${t}`;
const location = (ip) => `http://${ip}:${PORT}/dlna/description.xml`;
const serverHdr = () => `${os.type()}/${os.release()} UPnP/1.0 BraXhnTV/${VERSION}`;
export function parseSsdp(msg) {
  const lines = String(msg).split(/\r?\n/);
  const h = {};
  for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  return { start: lines[0] || '', headers: h };
}
/** Svar på M-SEARCH: vilka typer ska besvaras? */
export function matchSearch(st) {
  const types = searchTypes();
  if (st === 'ssdp:all') return types;
  return types.includes(st) ? [st] : [];
}
export const searchResponse = (st, ip) => ['HTTP/1.1 200 OK', `CACHE-CONTROL: max-age=${MAX_AGE}`, `DATE: ${new Date().toUTCString()}`, 'EXT:',
  `LOCATION: ${location(ip)}`, `SERVER: ${serverHdr()}`, `ST: ${st}`, `USN: ${usn(st)}`, '', ''].join('\r\n');
const notifyMsg = (nt, ip, nts) => ['NOTIFY * HTTP/1.1', `HOST: ${MCAST}:${SSDP_PORT}`, `CACHE-CONTROL: max-age=${MAX_AGE}`, `LOCATION: ${location(ip)}`,
  `NT: ${nt}`, `NTS: ${nts}`, `SERVER: ${serverHdr()}`, `USN: ${usn(nt)}`, '', ''].join('\r\n');

export const state = { running: false, error: null, addresses: [] };
let sock = null, timer = null;
function announce(nts) {
  if (!sock) return;
  for (const a of localAddrs()) {
    try { sock.setMulticastInterface(a.address); } catch {}
    for (const t of searchTypes()) { const b = Buffer.from(notifyMsg(t, a.address, nts)); sock.send(b, 0, b.length, SSDP_PORT, MCAST, () => {}); }
  }
}
function onMessage(msg, rinfo) {
  if (!isPrivate(rinfo.address) || msg.length > 4096) return; // bara hemnätet
  const { start, headers } = parseSsdp(msg);
  if (!/^M-SEARCH \* HTTP\/1\.1$/i.test(start) || String(headers.man || '').replace(/"/g, '') !== 'ssdp:discover') return;
  const types = matchSearch(headers.st || '');
  if (!types.length) return;
  const ip = addressFor(rinfo.address);
  const delay = Math.min(Math.max(+headers.mx || 1, 1), 3) * 1000 * Math.random() * 0.5;
  setTimeout(() => {
    for (const t of types) { const b = Buffer.from(searchResponse(t, ip)); sock?.send(b, 0, b.length, rinfo.port, rinfo.address, () => {}); }
  }, delay).unref();
}
export function start() {
  // DLNA_SSDP=0: ingen annonsering (t.ex. när en annan DLNA-server redan använder port 1900) – adressen anges då manuellt i spelaren
  if (sock || process.env.DLNA_SSDP === '0') return;
  state.error = null;
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock = s;
  s.on('error', (e) => {
    state.error = e.code === 'EADDRINUSE' ? 'Port 1900 används redan (kör en annan DLNA-server?)' : e.message;
    console.warn('[dlna] SSDP:', state.error);
    stop(false);
  });
  s.on('message', onMessage);
  s.bind(SSDP_PORT, () => {
    state.addresses = localAddrs().map(a => a.address);
    for (const a of state.addresses) { try { s.addMembership(MCAST, a); } catch (e) { console.warn('[dlna] multicast på', a, e.message); } }
    try { s.setMulticastTTL(4); } catch {}
    state.running = true;
    console.log(`[dlna] mediaserver aktiv på ${state.addresses.join(', ') || 'okänd adress'} (port ${PORT})`);
    announce('ssdp:alive');
    setTimeout(() => announce('ssdp:alive'), 3000).unref();
    timer = setInterval(() => announce('ssdp:alive'), MAX_AGE / 2 * 1000); timer.unref();
  });
}
export function stop(bye = true) {
  if (!sock) return;
  if (bye && state.running) announce('ssdp:byebye');
  clearInterval(timer); timer = null;
  const s = sock; sock = null; state.running = false;
  setTimeout(() => { try { s.close(); } catch {} }, bye ? 200 : 0).unref();
}
/** Starta eller stoppa enligt inställningen */
export function apply() { if (enabled()) start(); else stop(); }
