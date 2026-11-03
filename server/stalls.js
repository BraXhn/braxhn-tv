// Varför hackade uppspelningen? Spelaren rapporterar ett hack (POST /api/stream/:id/stall) med sina mätvärden;
// servern jämför med sitt eget läge (strömningssessionen och händelseslingan) och väljer den troligaste orsaken.
// Ren funktion (testas i Node): srv = stream.sessionStats() eller null (direktuppspelning), cl = spelarens
// mätvärden, loop = loopmon.loopStats().
//   server-busy – händelseslingan stod still (bakgrundsjobb, synkron disk) – segmenten kunde inte skickas
//   transcode   – omkodningen är långsammare än uppspelningen (processor/grafikkort räcker inte)
//   disk        – remux/direkt: servern väntade på disken (sovande disk, långsam läsning)
//   network     – överföringen tog längre tid än segmentet räcker (nätet eller wifi)
//   client      – servern och nätet hann med: avkodningen eller webbläsaren (tappade bildrutor, flik i bakgrunden)
const mbit = (bps) => (bps / 1e6).toFixed(1).replace('.', ',');

export function stallCause(srv, cl = {}, loop = {}, at = Date.now()) {
  const b = loop.block;
  if (b && b.ms >= 200) {
    return { cause: 'server-busy', text: `servern var upptagen – händelseslingan stod still ${b.ms} ms${b.jobs?.length ? ` (${b.jobs.join(', ')})` : ''}` };
  }
  const w = srv?.lastWait && at - srv.lastWait.at < 60e3 ? srv.lastWait : null;
  // Väntan på ett segment som är nästan lika lång som segmentet: spelarens buffert tog slut på servern
  const waitedLong = !!(w && w.ms > Math.max(1500, (w.dur || 6) * 1000 * 0.7));
  if (srv?.mode === 'transcode' && (waitedLong || (srv.running && !srv.keepingUp))) {
    const sp = srv.speed != null ? `${String(srv.speed).replace('.', ',')} × realtid` : 'okänd hastighet';
    return { cause: 'transcode', text: `servern hann inte koda om (${sp}, ${srv.encoder || 'kodare okänd'}${srv.tonemap ? ', HDR→SDR' : ''})` };
  }
  if (srv && waitedLong) return { cause: 'disk', text: `servern väntade ${(w.ms / 1000).toFixed(1).replace('.', ',')} s på segment ${w.n} (disken eller läsningen)` };
  const f = cl.lastFrag;
  // Överföringen (från första byte) tog längre tid än segmentets längd, eller uppmätt bandbredd under strömmens
  const slowXfer = f && f.dur > 0 && f.load - (f.wait || 0) > f.dur * 1000 * 0.8;
  if (slowXfer || (cl.bw > 0 && cl.bitrate > 0 && cl.bw < cl.bitrate * 1.15)) {
    return { cause: 'network', text: `nätet hann inte med${cl.bw > 0 ? ` (uppmätt ${mbit(cl.bw)} Mbit/s` : ' ('}${cl.bitrate > 0 ? `${cl.bw > 0 ? ', ' : ''}strömmen behöver ${mbit(cl.bitrate)} Mbit/s` : ''})` };
  }
  const dropped = cl.dropped > 0 ? `, ${cl.dropped} tappade bildrutor` : '';
  return { cause: 'client', text: `klienten – servern och nätet hann med (avkodningen eller webbläsaren${dropped})` };
}
