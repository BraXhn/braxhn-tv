// Musikspelarens beräkningar utan sidoeffekter (testas i node, test/gapless.test.js): jämn ljudnivå,
// trim av kodarfördröjning/utfyllnad och planen för övergången mellan två spår (glapplöst eller övertoning).
// Importerar inget – används av audioengine.js och audio.js.

const MAX_GAIN = 4; // +12 dB

/**
 * Förstärkning (linjär) för ett spår. mode: 'track' | 'album' | 'off'. gain/albumGain i dB mot −18 LUFS (servern).
 * Klippning förhindras med spårets eget toppvärde (det är spårets sampel som klipps), annars albumets.
 */
export function gainFor(t, mode) {
  if (!t || mode === 'off') return 1;
  const db = mode === 'album' ? (t.albumGain ?? t.gain) : (t.gain ?? t.albumGain);
  if (db == null || !Number.isFinite(+db)) return 1;
  let g = 10 ** (+db / 20);
  const peak = t.peak > 0 ? t.peak : t.albumPeak > 0 ? t.albumPeak : null;
  if (peak) g = Math.min(g, 1 / peak);
  return Math.min(g, MAX_GAIN);
}

/**
 * Hur mycket av den avkodade bufferten som ska skäras bort (i buffertens sampel). Webbläsarna skiljer sig: Chromium tar
 * bort MP3:ns fördröjning och utfyllnad själv, andra gör det inte (eller bara i början). Därför jämförs den avkodade
 * längden med det exakta antalet sampel från servern (gapless.samples i filens takt). len = buffertens längd, rate = dess takt.
 */
export function trimFor(len, rate, gl) {
  const none = { front: 0, back: 0 };
  if (!gl?.samples || !gl.sampleRate || !(len > 0)) return none;
  const r = rate / gl.sampleRate, want = gl.samples * r, e = len - want;
  const tol = Math.max(4, 2 * r);
  const skip = (gl.skip || 0) * r, pad = (gl.pad || 0) * r;
  const near = (v) => Math.abs(e - v) <= tol;
  if (e <= tol) return none; // redan exakt (eller kortare – rör inget)
  const cut = (front) => ({ front: Math.round(front), back: Math.max(0, Math.round(e - front)) });
  if (near(skip + pad)) return cut(skip); // inget trimmat av webbläsaren
  if (near(pad)) return cut(0); // bara början trimmad
  if (near(skip)) return cut(skip); // bara slutet trimmat
  return cut(skip > 0 && e > skip ? skip : 0); // okänt: fördröjningen först, resten från slutet
}

/** Nästa spår på samma album i albumets ordning – spåren går ihop och tonas aldrig över. */
export function continues(a, b) {
  if (!a || !b || a.albumId == null || a.albumId !== b.albumId) return false;
  const da = a.disc || 1, db = b.disc || 1;
  if (a.track == null || b.track == null) return false;
  return (da === db && b.track === a.track + 1) || (db === da + 1 && b.track === 1);
}

/**
 * Övergången från cur till next. len/nextLen = spårens längd efter trim (s). prefs: { crossfade (s), gapless }.
 * Returnerar { overlap, curEnd, nextStart }: next startar på positionen nextStart när cur når curEnd − overlap,
 * och cur tonas ut till curEnd. overlap 0 = glapplöst (curEnd = len, nextStart = 0, inget hoppas över).
 * Smart övertoning: aldrig mellan spår som går ihop på samma album; slutar spåret i tystnad (≥ 1 s) tonas inget över,
 * bara den döda tiden kortas; kort tystnad ger halva längden. Aldrig mer än en tredjedel av något av spåren.
 */
export function planTransition(cur, next, len, nextLen, prefs = {}) {
  const X = Math.max(0, +prefs.crossfade || 0);
  const gap = { overlap: 0, curEnd: len, nextStart: 0, kind: 'gapless' };
  if (!X || continues(cur, next)) return gap;
  const tail = Math.max(0, Math.min(+cur?.gapless?.silenceEnd || 0, len / 2));
  const head = Math.max(0, Math.min(+next?.gapless?.silenceStart || 0, nextLen / 2));
  if (tail >= 1) {
    // Spåret har redan ett slut: ingen övertoning, men högst en halv sekund tystnad i övergången
    return { overlap: 0, curEnd: len - tail + 0.5, nextStart: Math.max(0, head - 0.1), kind: 'trim' };
  }
  let x = tail > 0.25 ? X / 2 : X;
  x = Math.min(x, (len - tail) / 3, (nextLen - head) / 3);
  if (!(x > 0.05)) return gap;
  return { overlap: x, curEnd: len - tail, nextStart: head, kind: 'crossfade' };
}

/** Lika effekt (cos/sin) – summan av två okorrelerade signaler håller samma ljudstyrka genom övergången. */
export function fadeCurve(out, n = 64) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i / (n - 1); c[i] = out ? Math.cos(p * Math.PI / 2) : Math.sin(p * Math.PI / 2); }
  return c;
}
