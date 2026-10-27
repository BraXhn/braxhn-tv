// Inspelningsplanering (rena funktioner, ingen databas – testas i test/dvr-plan.test.js och används av dvr.js):
// regelns tidsfönster, avsnittsidentitet och simuleringen av hur tunrarna kommer att räcka. Simuleringen gör samma
// sak som dvr.js gör i verkligheten, så att konflikter kan visas i förväg:
//  - en inspelning begär en tuner vid start − marginal och släpper den vid slut + marginal;
//  - finns ingen ledig tuner och någon pågående inspelning på samma källa har lägre prioritet, avbryts den med lägst
//    prioritet (det som hunnit spelas in sparas) – annars väntar inspelningen och tar första tunern som blir ledig
//    (den börjar då sent), eller missas helt om programmet hinner ta slut;
//  - väntande inspelningar får lediga tunrar i prioritetsordning (högst först), sedan efter starttid.

/** Lokal veckodag (sön = 0) och minut efter midnatt för en tidpunkt i sekunder (serverns tidszon, TZ) */
export function localParts(t) {
  const d = new Date(t * 1000);
  return { day: d.getDay(), minute: d.getHours() * 60 + d.getMinutes() };
}

/** Ligger sändningens start inom regelns fönster? days = bitmask (sön = 1, mån = 2 … lör = 64), NULL/0 = alla dagar.
 *  time_from/time_to = minuter efter midnatt; time_to < time_from betyder över midnatt (t.ex. 22:00–02:00). */
export function inWindow(rule, start) {
  const { day, minute } = localParts(start);
  if (rule.days && !(rule.days & (1 << day))) return false;
  const a = rule.time_from, b = rule.time_to;
  if (a == null || b == null || a === b) return true;
  return a < b ? minute >= a && minute < b : minute >= a || minute < b;
}

/** Avsnittets identitet för dubblettkontroll: "s3e5", "t:undertitel" eller null (okänt – t.ex. nyheter) */
export function episodeKey(p) {
  if (p.season != null && p.episode != null) return `s${p.season}e${p.episode}`;
  const sub = String(p.subtitle || '').trim().toLowerCase();
  return sub ? 't:' + sub : null;
}

const RANKS = { ok: 0, late: 1, cut: 2, missed: 3 };
export const worse = (a, b) => RANKS[a] > RANKS[b];

/**
 * Simulerar tunrarna. recs: [{ id, tunerId, start, stop, padBefore, padAfter, priority, recording? }] där recording =
 * pågår redan (har en tuner nu). tuners: { [tunerId]: antal }. now: nuvarande tid (pågående inspelningar räknas från den).
 * Returnerar Map id → { outcome: 'ok'|'late'|'cut'|'missed', from, to, by: [id …] } där from/to är den tid som spelas
 * in (null om missad) och by = inspelningarna som tog tunern.
 */
export function simulate(recs, tuners, now = 0) {
  const out = new Map();
  const bySrc = new Map();
  for (const r of recs) { if (!bySrc.has(r.tunerId)) bySrc.set(r.tunerId, []); bySrc.get(r.tunerId).push(r); }
  for (const [tid, list] of bySrc) {
    const cap = Math.max(1, tuners[tid] || 2);
    const items = list.map(r => {
      const a = r.recording ? Math.min(now, r.start - (r.padBefore || 0)) : r.start - (r.padBefore || 0);
      return { r, a, b: r.stop + (r.padAfter || 0), prio: r.priority || 0 };
    });
    const res = new Map(items.map(x => [x.r.id, { outcome: 'ok', from: null, to: null, by: [] }]));
    const holding = [], waiting = [];
    // Händelsetider: alla start- och sluttider (sorterade, unika)
    const times = [...new Set(items.flatMap(x => [x.a, x.b, x.r.stop]))].sort((x, y) => x - y);
    const pending = [...items].sort((x, y) => x.a - y.a || (x.r.recording ? 0 : 1) - (y.r.recording ? 0 : 1) || y.prio - x.prio);
    const order = (x, y) => (y.r.recording ? 1 : 0) - (x.r.recording ? 1 : 0) || y.prio - x.prio || x.a - y.a || x.r.id - y.r.id;
    for (const t of times) {
      // Färdiga inspelningar släpper tunern
      for (let i = holding.length - 1; i >= 0; i--) if (holding[i].b <= t) { res.get(holding[i].r.id).to = holding[i].b; holding.splice(i, 1); }
      // Nya som vill börja
      const fresh = [];
      while (pending.length && pending[0].a <= t) { const x = pending.shift(); waiting.push(x); fresh.push(x); }
      // Väntande vars program tagit slut missas
      for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].r.stop <= t) { res.get(waiting[i].r.id).outcome = 'missed'; waiting.splice(i, 1); }
      waiting.sort(order);
      for (let i = 0; i < waiting.length;) {
        const w = waiting[i];
        if (holding.length < cap) {
          holding.push(w); waiting.splice(i, 1);
          const st = res.get(w.r.id); st.from = Math.max(w.a, t);
          if (t > w.a && st.outcome === 'ok') st.outcome = 'late';
          continue;
        }
        // Högre prioritet tar tunern från den med lägst prioritet – bara när den själv ska börja (som tick() i dvr.js)
        const low = fresh.includes(w) ? [...holding].sort((x, y) => x.prio - y.prio || y.a - x.a)[0] : null;
        if (low && low.prio < w.prio) {
          holding.splice(holding.indexOf(low), 1);
          const ls = res.get(low.r.id); ls.outcome = 'cut'; ls.to = t; ls.by.push(w.r.id);
          holding.push(w); waiting.splice(i, 1);
          res.get(w.r.id).from = t;
          continue;
        }
        const st = res.get(w.r.id);
        for (const h of holding) if (!st.by.includes(h.r.id)) st.by.push(h.r.id);
        i++;
      }
    }
    for (const w of waiting) res.get(w.r.id).outcome = 'missed';
    for (const [id, v] of res) { if (v.outcome === 'missed') { v.from = null; v.to = null; } out.set(id, v); }
  }
  return out;
}

/** Utfallet som text till användaren */
export function outcomeText(o) {
  return { ok: '', late: 'börjar sent – alla tuners är upptagna när den ska starta', cut: 'avbryts av en inspelning med högre prioritet', missed: 'spelas inte in – alla tuners är upptagna' }[o] || '';
}
