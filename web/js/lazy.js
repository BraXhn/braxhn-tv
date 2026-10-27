// Moduler som laddas vid behov: spelarstacken (video, ljud, live, Chromecast, Spela på…) och vyerna utom startsidan.
// Startens moduler (det app.js importerar statiskt) når spelaren bara genom fasaderna här: de laddar spelaren vid
// första anropet. Spelarmodulerna anmäler sig med provide() när de laddats, så att fasaderna kan svara direkt
// (finns det en spelare? stäng den) utan att ladda något – oavsett vilken väg modulen laddades.
// need() förladdar hela kedjan av beroenden på en gång (modulepreload med innehållshash, listan #moddeps räknas fram
// av servern i server/http/static.js) i stället för en importnivå i taget. Importerar bara core.js.
import { toastErr } from './core.js';

const pending = new Map(); // modul (relativt js/) -> Promise med modulen
let deps = null, have = null;
const depsOf = () => {
  if (!deps) { try { deps = JSON.parse(document.getElementById('moddeps')?.textContent || '{}'); } catch { deps = {}; } }
  return deps;
};
// Modulens adress med innehållshash, som import() får den via import map (#importmap i index.html, server/http/static.js)
// – modulepreload använder inte import map, så adressen slås upp här. Utan import map: adressen utan hash.
let imap = null;
function hrefOf(f) {
  if (!imap) { try { imap = JSON.parse(document.querySelector('script[type=importmap]')?.textContent || '{}').imports || {}; } catch { imap = {}; } }
  const p = new URL(f, import.meta.url).pathname; // /m/js/views/item.js
  return new URL(imap[p] || p, location.href).href;
}
/** Laddar en modul i js/ (t.ex. 'views/item.js') – alla dess beroenden hämtas parallellt */
export function need(file) {
  let p = pending.get(file);
  if (p) return p;
  const g = depsOf(), all = new Set(), todo = [file];
  while (todo.length) { const f = todo.pop(); if (all.has(f)) continue; all.add(f); todo.push(...(g[f] || [])); }
  have ??= new Set([...document.querySelectorAll('link[rel=modulepreload]')].map(l => l.href));
  for (const f of all) {
    const href = hrefOf(f);
    if (have.has(href)) continue;
    have.add(href);
    const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = href; document.head.append(l);
  }
  p = import(`./${file}`);
  pending.set(file, p);
  p.catch(() => pending.delete(file)); // t.ex. utan kontakt med servern: försök igen nästa gång
  return p;
}
// Arbete som får vänta tills den första sidan är ritad (förladdning, Spela på…, aktivitetsrutan) – annars tar det
// anslutningarna från startsidans moduler och anrop
let drawn = false;
const waiting = [];
const whenIdle = (fn) => { if (window.requestIdleCallback) requestIdleCallback(() => fn(), { timeout: 1500 }); else setTimeout(fn, 200); };
/** Kör fn när den första sidan är ritad och webbläsaren har tid över */
export function idle(fn) { if (drawn) whenIdle(fn); else waiting.push(fn); }
/** Anropas av app.js när den första sidan visas */
export function pageDrawn() { if (drawn) return; drawn = true; for (const fn of waiting.splice(0)) whenIdle(fn); }

// ---------- spelaren ----------
const mods = {}; // anmälda spelarmoduler: video, audio, live, remote
/** Anropas av spelarmodulerna när de laddats (namnrymden, så att let-exporter som P följer med) */
export const provide = (name, ns) => { mods[name] = ns; };
export const loadPlayer = () => need('player/video.js');
/** Videospelarens läge (P i player/video.js), null om ingen spelare är öppen eller spelaren inte laddats */
export const curPlayer = () => mods.video?.P ?? null;
export function closeAllPlayers() { mods.video?.closeAllPlayers(); }
export function stopAudio() { mods.audio?.stopAudio(); }
export const liveOpen = () => !!(mods.live?.LP || mods.live?.RP);
export function closeLiveAndRec() { mods.live?.closeLive(); mods.live?.closeRec(); }
/** Startknapp (som startPlay i video.js): knappen är inaktiv medan spelaren laddas och startar */
export function startPlay(b, ...args) {
  if (mods.video) return mods.video.startPlay(b, ...args);
  if (b) { if (b.disabled) return; b.disabled = true; }
  return loadPlayer().then(m => { if (b) b.disabled = false; return m.startPlay(b, ...args); }, (e) => { if (b) b.disabled = false; toastErr(e); });
}
export const play = (...args) => loadPlayer().then(m => m.play(...args));
export const playSpoken = (s) => need('audio.js').then(m => m.playSpoken(s)).catch(e => toastErr(e));
/** "Spela på…": den här webbläsaren blir en enhet som kan styras (laddar spelaren – anropas när sidan är ritad) */
export const startRemote = () => need('player/remote.js').then(m => m.startRemote()).catch(() => {});
export function stopRemote() { mods.remote?.stopRemote(); }
export const openRemotePicker = (anchor, o) => need('player/remote.js').then(m => m.openRemotePicker(anchor, o)).catch(e => toastErr(e));
