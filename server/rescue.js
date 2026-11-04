// Nödläge vid start: när servern inte kan starta av ett skäl i miljön – skadad databas, full disk, /config som inte går
// att skriva i, en låst databas – visas en enkel sida på samma port i stället för en krasch i en slinga med ett
// obegripligt stackspår i Docker-loggen. Sidan förklarar felet (svenska/engelska efter webbläsarens språk) och kan
// återställa en säkerhetskopia eller lägga den skadade databasen åt sidan – med en engångskod som bara står i loggen
// (ingen inloggning fungerar utan databas, och sidan kan nås via en omvänd proxy).
// Importerar bara Nodes inbyggda moduler: det som gick sönder (db.js och allt som importerar den) får inte behövas här.
// Programfel (TypeError, SyntaxError …) går inte hit – de kraschar som förut, så att de syns och rättas.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG = process.env.CONFIG_DIR || '/config';
const DBFILE = path.join(CONFIG, 'braxhn-tv.db');

/** Är felet vid start ett miljöfel (då nödläget) – eller ett programfel (då kraschen som förut)? */
export function startupProblem(e) {
  if (!e) return null;
  if (e.code === 'ERR_SQLITE_ERROR' || typeof e.errcode === 'number') {
    const kind = { 11: 'corrupt', 26: 'corrupt', 13: 'full', 8: 'readonly', 14: 'cantopen', 10: 'ioerr', 5: 'busy', 6: 'busy' }[(e.errcode ?? -1) & 0xff];
    return kind ? { kind, detail: String(e.message || e), path: DBFILE } : null;
  }
  const fsKind = { EACCES: 'perm', EPERM: 'perm', EROFS: 'readonly', ENOSPC: 'full', EIO: 'ioerr', ENOTCONN: 'ioerr', ESTALE: 'ioerr' }[e.code];
  return fsKind ? { kind: fsKind, detail: String(e.message || e), path: e.path || CONFIG } : null;
}

const TEXT = {
  sv: {
    title: 'BraXhn TV kan inte starta',
    corrupt: 'Databasen (braxhn-tv.db i /config) är skadad. Det händer oftast efter ett strömavbrott eller en disk med fel.',
    full: 'Disken där /config ligger är full, så databasen kan inte öppnas. Frigör utrymme (t.ex. gamla loggar, omkodningsmappen eller cache-poolen) och starta om containern.',
    readonly: 'Mappen /config (eller databasen i den) är skrivskyddad. Kontrollera att appdata-mappen är monterad med läs- och skrivrätt (rw) och att den inte ligger på en full eller felande disk.',
    perm: 'Servern får inte skriva i mappen nedan. Kontrollera att mappen ägs av containerns användare (PUID/PGID, i Unraid normalt 99/100): kör t.ex. "chown -R 99:100 /mnt/user/appdata/braxhn-tv" i Unraids terminal.',
    cantopen: 'Databasfilen går inte att öppna. Kontrollera att /config är monterad och att mappen finns.',
    ioerr: 'Läs- eller skrivfel på disken där /config ligger. Kontrollera disken (SMART, Unraids logg) – och om /config ligger på en nätverksresurs, att den är ansluten.',
    busy: 'Databasen är låst av ett annat program (t.ex. sqlite3 eller ett säkerhetskopieringsverktyg som läser filen). Stäng programmet och starta om containern.',
    where: 'Sökväg', error: 'Fel',
    backups: 'Säkerhetskopior som hittades', none: 'Inga säkerhetskopior hittades i /config/backups.',
    restore: 'Återställ den här', fresh: 'Lägg den skadade databasen åt sidan och starta med en tom',
    code: 'Engångskod (står i containerns logg: Unraid → Docker → BraXhn TV → Logs)',
    manual: 'Själv, utan sidan: stoppa containern, kopiera en säkerhetskopia till /config/restore.db och starta igen – den kontrolleras och byts in vid start, och den gamla databasen sparas bredvid. Krypterade kopior (.bxtv): docker exec -it braxhn-tv node server/restore.js /backup/fil.bxtv',
    retry: 'Servern försöker starta igen av sig själv om några minuter.',
    done: 'Klart. Servern startar om – ladda om sidan om en stund.', bad: 'Fel kod eller fil.', locked: 'För många försök. Starta om containern för en ny kod.'
  },
  en: {
    title: 'BraXhn TV cannot start',
    corrupt: 'The database (braxhn-tv.db in /config) is damaged. This usually happens after a power cut or a failing disk.',
    full: 'The disk that holds /config is full, so the database cannot be opened. Free up space (old logs, the transcode folder or the cache pool) and restart the container.',
    readonly: 'The /config folder (or the database in it) is read-only. Check that the appdata folder is mounted read-write (rw) and is not on a full or failing disk.',
    perm: 'The server is not allowed to write to the folder below. Make sure it is owned by the container user (PUID/PGID, normally 99/100 on Unraid): for example run "chown -R 99:100 /mnt/user/appdata/braxhn-tv" in the Unraid terminal.',
    cantopen: 'The database file cannot be opened. Check that /config is mounted and that the folder exists.',
    ioerr: 'Read or write error on the disk that holds /config. Check the disk (SMART, the Unraid log) – and if /config is on a network share, that it is connected.',
    busy: 'The database is locked by another program (for example sqlite3 or a backup tool reading the file). Close it and restart the container.',
    where: 'Path', error: 'Error',
    backups: 'Backups found', none: 'No backups were found in /config/backups.',
    restore: 'Restore this one', fresh: 'Move the damaged database aside and start with an empty one',
    code: 'One-time code (shown in the container log: Unraid → Docker → BraXhn TV → Logs)',
    manual: 'By hand, without this page: stop the container, copy a backup to /config/restore.db and start it again – it is checked and swapped in at start, and the old database is kept next to it. Encrypted backups (.bxtv): docker exec -it braxhn-tv node server/restore.js /backup/file.bxtv',
    retry: 'The server will try to start again by itself in a few minutes.',
    done: 'Done. The server restarts – reload the page in a moment.', bad: 'Wrong code or file.', locked: 'Too many attempts. Restart the container for a new code.'
  }
};
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Webbläsarens första språk: svenska bara när det är svenska; inget angivet = svenska (som webben)
const langOf = (req) => { const al = String(req.headers['accept-language'] || '').trim(); return !al || /^sv\b/i.test(al) ? 'sv' : 'en'; };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Giltiga säkerhetskopior (SQLite-filer) i backups-mapparna, nyast först */
export function findBackups() {
  const dirs = [...new Set([path.join(CONFIG, 'backups'), process.env.BACKUP_DIR].filter(Boolean))];
  const out = [];
  for (const dir of dirs) {
    let list = [];
    try { list = fs.readdirSync(dir); } catch { continue; }
    for (const f of list) {
      if (!/\.db$/.test(f)) continue;
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size < 4096) continue;
        const fd = fs.openSync(p, 'r'), head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
        if (head.toString('latin1') === 'SQLite format 3\0') out.push({ id: crypto.createHash('sha256').update(p).digest('hex').slice(0, 16), path: p, name: f, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 20);
}

/**
 * Startar nödläget på port (http). Returnerar servern. exit(kod) anropas när en åtgärd gjorts eller tiden för ett nytt
 * försök gått ut (Docker startar om containern: --restart unless-stopped i mallen).
 */
export function serveRescue(port, problem, { exit = (c) => process.exit(c), retryMin = null } = {}) {
  const code = String(crypto.randomInt(100000, 1000000));
  let tries = 0, acting = false;
  console.error(`[start] BraXhn TV kan inte starta: ${TEXT.sv[problem.kind]} (${problem.detail})`);
  console.error(`[start] Nödläge: öppna webbsidan på port ${port} för förklaring och återställning. Engångskod: ${code}`);
  const retry = retryMin ?? (['full', 'busy', 'perm', 'readonly', 'ioerr', 'cantopen'].includes(problem.kind) && fs.existsSync('/.dockerenv') ? 5 : 0);
  if (retry > 0) setTimeout(() => { console.error('[start] försöker starta igen'); exit(75); }, retry * 60e3).unref();
  const page = (L, msg = '') => {
    const T = TEXT[L], backups = problem.kind === 'corrupt' ? findBackups() : [];
    const form = (action, label, extra = '') => `<form method="post" action="/rescue/${action}">${extra}<label>${esc(T.code)}<br><input name="code" inputmode="numeric" autocomplete="off" required pattern="[0-9]{6}"></label> <button>${esc(label)}</button></form>`;
    return `<!doctype html><html lang="${L}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(T.title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 16px;background:#111;color:#eee}code,pre{background:#222;padding:2px 4px;border-radius:4px;white-space:pre-wrap;word-break:break-all}
li{margin:.6rem 0}button{padding:.4rem .8rem;margin-top:.3rem}input{padding:.3rem;width:8rem}.msg{background:#333;padding:.6rem;border-radius:6px}@media(prefers-color-scheme:light){body{background:#fff;color:#111}code,pre{background:#eee}.msg{background:#eee}}</style>
<h1>${esc(T.title)}</h1>${msg ? `<p class="msg">${esc(msg)}</p>` : ''}<p>${esc(T[problem.kind])}</p>
<p>${esc(T.where)}: <code>${esc(problem.path)}</code><br>${esc(T.error)}: <code>${esc(problem.detail)}</code></p>
${problem.kind === 'corrupt' ? `<h2>${esc(T.backups)}</h2>${backups.length ? `<ul>${backups.map(b => `<li><code>${esc(b.name)}</code> – ${new Date(b.mtime).toISOString().slice(0, 16).replace('T', ' ')} – ${(b.size / 2 ** 20).toFixed(1)} MB${form('restore', T.restore, `<input type="hidden" name="id" value="${b.id}">`)}</li>`).join('')}</ul>` : `<p>${esc(T.none)}</p>`}
<h2>${esc(T.fresh)}</h2>${form('fresh', T.fresh)}<p>${esc(T.manual)}</p>` : retry > 0 ? `<p>${esc(T.retry)}</p>` : ''}</html>`;
  };
  const srv = http.createServer((req, res) => {
    const L = langOf(req);
    const reply = (status, msg) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", 'X-Frame-Options': 'DENY' }); res.end(page(L, msg)); };
    if (req.method === 'POST' && /^\/rescue\/(restore|fresh)$/.test(req.url) && problem.kind === 'corrupt') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        const f = new URLSearchParams(body);
        if (acting) return reply(200, TEXT[L].done);
        if (tries >= 10) return reply(429, TEXT[L].locked);
        if (!crypto.timingSafeEqual(sha(f.get('code') || ''), sha(code))) { tries++; return reply(403, TEXT[L].bad); }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        try {
          if (req.url === '/rescue/restore') {
            const b = findBackups().find(x => x.id === f.get('id'));
            if (!b) { tries++; return reply(400, TEXT[L].bad); }
            // db.js kontrollerar restore.db vid start (quick_check, rätt tabeller) och byter in den; den skadade sparas
            fs.copyFileSync(b.path, path.join(CONFIG, 'restore.db.part'));
            fs.renameSync(path.join(CONFIG, 'restore.db.part'), path.join(CONFIG, 'restore.db'));
            console.error(`[start] återställer ${b.path} vid omstart`);
          } else {
            for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(DBFILE + ext)) fs.renameSync(DBFILE + ext, `${DBFILE}.skadad-${stamp}${ext}`);
            console.error(`[start] den skadade databasen sparades som braxhn-tv.db.skadad-${stamp} – startar med en tom databas`);
          }
        } catch (e) { return reply(500, e.message); }
        acting = true;
        reply(200, TEXT[L].done);
        setTimeout(() => exit(75), 500).unref();
      });
      return;
    }
    if (req.url === '/api/health' || req.url.startsWith('/api/')) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      return res.end(JSON.stringify({ error: TEXT.sv.title, problem: problem.kind }));
    }
    reply(503);
  });
  srv.listen(port);
  return srv;
}
