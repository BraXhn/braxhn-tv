// Föräldraöversikt (#/family i webben, server/parents.js): huvudkontot ser vad barnprofilerna i hushållet tittat och
// lyssnat på, dagens skärmtid och vad som spelas just nu – även utanför hemmet (det är huvudkontots egna profiler, inte
// administration). Vuxna profiler och andra konton syns aldrig. Skärmtiden ändras med /api/screentime/:uid (social.js).
//   GET  /api/parents              – barnen med dagens sammanfattning
//   GET  /api/parents/:pid?days=7  – ett barn: per dag, mest sett, senaste uppspelningar, ljudböcker (7 eller 30 dagar)
//   POST /api/parents/:pid/stop    – stoppa barnets pågående uppspelningar
import { get, run } from '../db.js';
import { send, fail } from '../util.js';
import { audit } from '../auth.js';
import * as st from '../stream.js';
import * as act from '../activity.js';
import * as ver from '../versions.js';
import * as parents from '../parents.js';
import { route, user } from '../http/router.js';
import { ctx, itemsByIds } from '../http/context.js';

const viewer = (c) => get('SELECT id, parent_id, max_age FROM users WHERE id=?', c.user.id);
/** Barnprofilen i adressen, eller 404 (samma svar för andra hushåll som för profiler som inte finns) */
function kidFor(c) {
  const k = parents.kidOf(viewer(c), c.p.pid);
  if (!k) fail(c.res, 404, 'Finns inte');
  return k;
}

route('GET', '/api/parents', user, (c) => {
  const v = viewer(c);
  // Barnprofiler och vuxna profiler under huvudkontot har ingen översikt (owner = false: webben visar en förklaring)
  send(c.res, 200, { owner: v.parent_id == null && v.max_age == null, kids: parents.kidsOf(v).map(k => parents.summary(k)) });
});
route('GET', '/api/parents/:pid', user, (c) => {
  const k = kidFor(c); if (!k) return;
  const d = parents.detail(k, parseInt(c.q.get('days')) || 7);
  // Korten för Mest sett (titlar som finns kvar i biblioteket, med huvudkontots rättigheter)
  const cards = new Map(itemsByIds(c.user.id, d.top.map(t => t.id)).map(i => [i.id, i]));
  d.top = d.top.map(t => ({ ...t, item: cards.get(t.id) || null }));
  send(c.res, 200, d);
});
route('POST', '/api/parents/:pid/stop', user, (c) => {
  const k = kidFor(c); if (!k) return;
  let n = 0;
  for (const p of parents.nowPlaying(k.id)) {
    const s = act.stopPlay(p.key);
    if (!s) continue;
    n++;
    // Alla versioner av titeln (strömmen kan gälla en annan fil än huvudraden) – samma som administratörens stopp
    const main = get('SELECT * FROM items WHERE id=?', s.itemId);
    for (const id of main ? ver.versionsOf(main).map(x => x.id) : [s.itemId]) {
      st.stopUserSessions(id, k.id);
      run("DELETE FROM sessions WHERE user_id=? AND kind='media' AND scope_item=?", k.id, id);
    }
  }
  if (n) audit('stream_stopped', { ...ctx(c), detail: `${k.name}: ${n} (föräldraöversikten)` });
  send(c.res, 200, { stopped: n });
});
