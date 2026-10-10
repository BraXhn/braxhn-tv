import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from './app.js';
import { scan } from './scanner.js';
import { CONFIG } from './db.js';

const PORT = +process.env.PORT || 8420;
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

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); tlsServer?.close(); process.exit(0); });
