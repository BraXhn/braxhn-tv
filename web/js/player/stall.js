// Vakt mot uppspelning som står still fast den ska spela: videon säger att den spelar (paused = false) men tiden går
// inte framåt. Händer framför allt vid start av en HLS-ström (remux/omkodning) när första segmentet börjar en bit
// efter 0 eller när två segment inte möts – då väntar webbläsaren på data som aldrig kommer. Förut fick man pausa och
// starta igen. Importerar inget (testas i Node).

/** Vad ska göras när tiden inte rört sig på en stund? buffered = [[start, slut], …] i sekunder.
 *  'jump' till nästa buffrade bit (glapp framför oss), 'kick' = pausa och spela (data finns där vi står), annars null. */
export function stallAction(buffered, t) {
  const inside = buffered.find(([a, b]) => t >= a - 0.05 && t < b);
  if (inside) return inside[1] - t > 0.3 ? { do: 'kick' } : null;
  const next = buffered.find(([a]) => a > t && a - t < 3);
  return next ? { do: 'jump', to: next[0] + 0.05 } : null;
}

/** Startar vakten för ett videoelement. Returnerar en funktion som stoppar den. */
export function watchStall(v, { ms = 3000, max = 5, live = () => true } = {}) {
  let last = -1, since = Date.now(), tries = 0;
  const id = setInterval(() => {
    if (!live() || !v.isConnected) return stop();
    if (v.paused || v.seeking || v.ended) { last = v.currentTime; since = Date.now(); return; }
    if (Math.abs(v.currentTime - last) > 0.01) { last = v.currentTime; since = Date.now(); return; }
    if (Date.now() - since < ms || tries >= max) return;
    const r = []; for (let i = 0; i < v.buffered.length; i++) r.push([v.buffered.start(i), v.buffered.end(i)]);
    const a = stallAction(r, v.currentTime);
    if (!a) return;
    tries++; since = Date.now();
    if (a.do === 'jump') v.currentTime = a.to;
    else { v.pause(); v.play().catch(() => {}); }
  }, 500);
  const stop = () => clearInterval(id);
  return stop;
}
