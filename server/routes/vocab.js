// Språkinlärningens ordlista (server/vocab.js): orden är profilens egna – andra profiler, även i samma hushåll, ser
// dem aldrig (otillåtet = finns inte). Nya ord kräver att profilen får se titeln (allowedFor), och ord från titlar
// som profilen inte längre får se (ändrad åldersgräns, bibliotek) döljs i listan och exporten. Ljudklippen kräver
// rätten att ladda ner, tas inte ut för barnprofiler med påtvingat familjefilter (ljudet vore otystat) och har ett
// tak för samtidiga ffmpeg (taget innan något väntar).
import { get } from '../db.js';
import { send, fail, readJson } from '../util.js';
import * as vocab from '../vocab.js';
import * as family from '../familyfilter.js';
import { route, user } from '../http/router.js';
import { allowedFor, canDownload } from '../http/context.js';

const allowed = (c) => (it) => allowedFor(c.user.id, it);
const rowsFor = (c) => vocab.list(c.user.id, allowed(c), { item: /^\d+$/.test(c.q.get('item') || '') ? +c.q.get('item') : null, q: c.q.get('q') || '' });

route('GET', '/api/vocab', user, (c) => send(c.res, 200, { words: rowsFor(c), max: vocab.MAX_WORDS }));

route('POST', '/api/vocab', user, async (c) => {
  const b = await readJson(c.req, 16 << 10);
  const it = /^\d+$/.test(String(b?.itemId ?? '')) ? get(`SELECT * FROM items WHERE id=? AND kind IN ('movie','episode')`, +b.itemId) : null;
  if (!it || !allowedFor(c.user.id, it)) return fail(c.res, 404, 'Finns inte');
  const w = vocab.parse(b);
  if (w.error) return fail(c.res, 400, w.error);
  const r = vocab.add(c.user.id, it, w);
  if (r.error) return fail(c.res, 409, r.error);
  send(c.res, 200, r);
});

// Export till Anki: ?format=tsv (standard) | csv | zip (TSV + ljudklipp, högst MAX_ZIP_CLIPS)
route('GET', '/api/vocab/export', user, async (c) => {
  const format = ['csv', 'tsv', 'zip'].includes(c.q.get('format')) ? c.q.get('format') : 'tsv';
  const rows = rowsFor(c);
  const day = new Date().toISOString().slice(0, 10);
  if (format !== 'zip') {
    return send(c.res, 200, '﻿' + vocab.exportText(rows, format), { 'Content-Type': `text/${format === 'csv' ? 'csv' : 'tab-separated-values'}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="ordlista-${day}.${format === 'csv' ? 'csv' : 'txt'}"`, 'Cache-Control': 'private, no-store' });
  }
  if (!canDownload(c.user.id)) return fail(c.res, 403, 'Ditt konto får inte ladda ner');
  const slot = vocab.clipSlot();
  if (!slot) return fail(c.res, 429, 'Ljudklipp tas redan fram – försök igen om en stund');
  const files = [], sound = new Set();
  try {
    const kidsBlock = family.enforced(c.user.id);
    for (const r of rows.filter(x => x.clip).slice(0, vocab.MAX_ZIP_CLIPS)) {
      if (c.req.destroyed) return;
      const it = get(`SELECT * FROM items WHERE id=? AND path IS NOT NULL`, r.itemId);
      if (!it || (kidsBlock && family.muteIntervals(it).length)) continue;
      try { files.push({ name: vocab.clipName(r), data: await vocab.clipMp3(it, { ...vocab.one(c.user.id, r.id) }) }); sound.add(r.id); }
      catch (e) { console.warn(`[ordlista] ljudklipp ${r.id}: ${e.message}`); }
    }
  } finally { slot(); }
  files.unshift({ name: 'ordlista.txt', data: Buffer.from(vocab.exportText(rows, 'tsv', sound), 'utf8') });
  send(c.res, 200, vocab.zip(files), { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="ordlista-${day}.zip"`, 'Cache-Control': 'private, no-store' });
});

route('PUT', '/api/vocab/:id', user, async (c) => {
  const r = vocab.update(c.user.id, +c.p.id, await readJson(c.req, 16 << 10) || {});
  if (!r) return fail(c.res, 404, 'Finns inte');
  if (r.error) return fail(c.res, 400, r.error);
  send(c.res, 200, r);
});
route('DELETE', '/api/vocab/:id', user, (c) => vocab.remove(c.user.id, +c.p.id) ? send(c.res, 200, { ok: true }) : fail(c.res, 404, 'Finns inte'));

// Repliken som MP3 (att lyssna på i ordlistan eller spara)
route('GET', '/api/vocab/:id/clip', user, async (c) => {
  const r = vocab.one(c.user.id, +c.p.id);
  const it = r?.item_id != null ? get('SELECT * FROM items WHERE id=? AND path IS NOT NULL', r.item_id) : null;
  if (!r || !it || !allowedFor(c.user.id, it) || r.s == null) return fail(c.res, 404, 'Finns inte');
  if (!canDownload(c.user.id)) return fail(c.res, 403, 'Ditt konto får inte ladda ner');
  if (family.enforced(c.user.id) && family.muteIntervals(it).length) return fail(c.res, 403, 'Familjefiltret är på för profilen – ljudklipp går inte att ta ut');
  const slot = vocab.clipSlot();
  if (!slot) return fail(c.res, 429, 'Ljudklipp tas redan fram – försök igen om en stund');
  let mp3;
  try { mp3 = await vocab.clipMp3(it, r); }
  catch (e) { console.warn(`[ordlista] ljudklipp ${r.id}: ${e.message}`); return fail(c.res, 500, 'Ljudklippet kunde inte tas fram'); }
  finally { slot(); }
  send(c.res, 200, mp3, { 'Content-Type': 'audio/mpeg', 'Content-Disposition': `inline; filename="${vocab.clipName(r)}"`, 'Cache-Control': 'private, max-age=3600' });
});
