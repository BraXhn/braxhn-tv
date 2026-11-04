// Loggning av oväntade fel. Ett avvisat löfte som ingen fångar loggas och servern fortsätter.
// Ett ofångat undantag kan ha lämnat servern i ett okänt tillstånd: logga och avsluta så att
// Docker/Unraid startar om containern (restart: unless-stopped) – utom fel som beror på miljön och inte på koden
// (en klient som kopplar ner, en nätverksresurs som försvinner, full disk, en tjänst som inte svarar): de loggas
// och servern fortsätter. Kommer sådana fel i en slinga (fler än 100 på en minut) avslutas den ändå.
// Programfel (TypeError, ReferenceError …) avslutar alltid – de ska synas, i testerna också.
// Tidsstämplar och loggen i Administration: server/logs.js (importeras först)
const ENV_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ENOSPC', 'EDQUOT',
  'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EIO', 'ESTALE', 'ENOTCONN', 'EBUSY', 'EMFILE', 'ENFILE', 'EAGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
/** Fel i miljön (nät, disk, databas som är full/låst) – inte i koden */
const envError = (e) => !!e && typeof e === 'object' && !(e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError || e instanceof RangeError)
  && (ENV_CODES.has(e.code) || ENV_CODES.has(e.cause?.code) || (e.code === 'ERR_SQLITE_ERROR' && [5, 6, 8, 10, 13].includes((e.errcode ?? -1) & 0xff)));
let envErrs = [];
process.on('unhandledRejection', (e) => { console.error('[fel] ohanterat avvisat löfte:', e?.stack || e); });
process.on('uncaughtException', (e, origin) => {
  const t = Date.now();
  envErrs = envErrs.filter(x => t - x < 60e3);
  if (envError(e) && envErrs.push(t) <= 100) { console.error(`[fel] ofångat fel från miljön (${e.code || e.errcode}) – servern fortsätter:`, e?.stack || e); return; }
  console.error(`[fel] ofångat undantag (${origin}):`, e?.stack || e);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 200).unref();
});
import './logs.js';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { startupProblem, serveRescue } from './rescue.js';

const PORT = +process.env.PORT || 8420;
// Resten av servern laddas här: misslyckas det av ett skäl i miljön (skadad databas, full disk, /config som inte går
// att skriva i …) visas en förklarande sida på porten i stället (rescue.js). Andra fel kraschar som förut.
let mods;
try {
  mods = await Promise.all([import('./app.js'), import('./scanner.js'), import('./db.js'), import('./stream.js'), import('./acme.js'), import('./livetv.js'), import('./dvr.js'), import('./startinfo.js'), import('./updates.js')]);
} catch (e) {
  const problem = startupProblem(e);
  if (!problem) throw e;
  console.error('[start]', e?.stack || e);
  const srv = serveRescue(PORT, problem);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { srv.close(); process.exit(0); });
}
if (mods) {
  const [{ handle }, { scan }, { CONFIG, db }, { purgeIdle }, { scheduleRenewal }, { shutdown: liveShutdown }, { shutdown: dvrShutdown }, { logStart }, { VERSION }] = mods;
  logStart({ version: VERSION, config: CONFIG }).catch(e => console.warn('[start] startloggen:', e.message));
  const app = (req, res) => handle(req, res).catch(e => { console.error(e); try { res.writeHead(500); res.end(); } catch {} });

  // Skydd mot långsamma/hängande anslutningar (slowloris). requestTimeout gäller bara mottagandet av
  // förfrågan – svar (strömmar) kan fortfarande pågå länge.
  function harden(srv) {
    srv.headersTimeout = 20000;
    srv.requestTimeout = 60000;
    srv.keepAliveTimeout = 15000;
    srv.timeout = 180000;          // inaktiv socket
    srv.maxHeadersCount = 100;
    srv.maxRequestsPerSocket = 1000;
    return srv;
  }
  const server = harden(http.createServer({ maxHeaderSize: 16384 }, app));
  // Porten upptagen (en annan container/app på samma port) eller inte tillåten: en begriplig rad i stället för ett stackspår
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `[start] Port ${PORT} används redan av ett annat program – välj en annan port i containerns inställningar (eller PORT=…)`
      : `[start] Kan inte lyssna på port ${PORT}: ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`BraXhn TV lyssnar på port ${PORT} (http)`);
    setTimeout(() => scan(), 3000);
  });

  // Inbyggd HTTPS: lägg cert.pem + key.pem (t.ex. från Let's Encrypt) i /config/tls/
  const TLS_DIR = path.join(CONFIG, 'tls');
  const HTTPS_PORT = +process.env.HTTPS_PORT || 8443;
  let tlsServer = null;
  function loadTls() {
    try {
      const cert = fs.readFileSync(path.join(TLS_DIR, 'cert.pem')), key = fs.readFileSync(path.join(TLS_DIR, 'key.pem'));
      if (tlsServer) { tlsServer.setSecureContext({ cert, key }); console.log('TLS-certifikat inläst på nytt'); return; }
      tlsServer = harden(https.createServer({ cert, key, minVersion: 'TLSv1.2', maxHeaderSize: 16384 }, app));
      tlsServer.listen(HTTPS_PORT, () => console.log(`BraXhn TV lyssnar på port ${HTTPS_PORT} (https)`));
      globalThis.__braxhnTls = true;
    } catch (e) { if (e.code !== 'ENOENT') console.warn('Kunde inte läsa TLS-certifikat:', e.message); }
  }
  fs.mkdirSync(TLS_DIR, { recursive: true });
  loadTls();
  // Läs in förnyade certifikat automatiskt (kollas var 6:e timme)
  setInterval(loadTls, 6 * 3600e3).unref();
  globalThis.__braxhnReloadTls = loadTls;
  // Let's Encrypt: förnya automatiskt när en domän är inställd
  scheduleRenewal(loadTls);

  // Avsluta snyggt: stoppa live-TV och låt pågående inspelningar skriva klart sina filer
  // Unraid (docker stop) skickar SIGTERM och väntar 10 s innan containern dödas – allt ska vara klart före det.
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
    if (stopping) return; stopping = true;
    const t0 = Date.now();
    console.log(`[stopp] ${sig} – stänger av (inspelningar skrivs klart, omkodningar stoppas, databasen stängs)`);
    // Hänger något ändå: avsluta före Dockers SIGKILL så att databasen hinner stängas av SQLite själv
    setTimeout(() => { console.warn('[stopp] avstängningen tog för lång tid – avslutar'); try { db.close(); } catch {} process.exit(0); }, 8000).unref();
    server.close(); tlsServer?.close();
    server.closeIdleConnections?.(); tlsServer?.closeIdleConnections?.();
    try { liveShutdown(); await dvrShutdown(5000); } catch {}
    // Stoppa omkodningar och stäng databasen ordentligt (WAL skrivs in i huvudfilen)
    try { purgeIdle(-1); } catch {}
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    try { db.close(); } catch {}
    console.log(`[stopp] klart på ${Date.now() - t0} ms`);
    process.exit(0);
  });
}
