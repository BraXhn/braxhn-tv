// Läser ett inbäddat undertextspår med ffmpeg med början där tittaren är, i stället för från filmens början.
// Ett spår i en stor fil (en 4K-film på 60 GB) tar annars minuter att läsa innan undertexten syns – särskilt
// när man slår på den mitt i filmen. Läsningen hoppar till tittarens position (-ss, med -copyts så att tiderna
// stämmer), läser framåt, och fyller sedan i det som saknas tills hela spåret är läst.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import * as jobs from './jobs.js';

const LEAD = 10;          // börja så här många sekunder före tittarens position
const AHEAD = 120;        // en läsning som snart når tittaren får fortsätta
const IDLE_MS = 2 * 60e3; // ingen har frågat på så länge: sluta läsa (fortsätter vid nästa fråga)

export class SubReader {
  /**
   * @param {object} o
   * @param {string} o.file mediefilen
   * @param {number} o.stream strömmens index i filen
   * @param {'webvtt'|'sup'} o.format
   * @param {number} o.duration filmens längd (s)
   * @param {() => { push(buf: Buffer): void, end?(): void }} o.parser ny tolk per ffmpeg-körning
   * @param {() => void} o.onComplete hela spåret är läst
   * @param {(msg: string) => void} o.onError
   */
  constructor(o) {
    Object.assign(this, o);
    this.covered = []; this.proc = null; this.from = 0; this.pos = 0; this.stopAt = null;
    this.complete = false; this.failed = false; this.errors = 0; this.asked = Date.now();
    this.idleTimer = setInterval(() => { if (this.proc && Date.now() - this.asked > IDLE_MS) this.stop(); }, 30e3);
    this.idleTimer.unref?.();
  }
  covers(t) { return this.covered.some(([a, b]) => a <= t && t <= b); }
  /** Lästa intervall slås ihop */
  add(a, b) {
    if (!(b > a)) return;
    const all = [...this.covered, [a, b]].sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const r of all) { const l = out[out.length - 1]; if (l && r[0] <= l[1] + 0.5) l[1] = Math.max(l[1], r[1]); else out.push([...r]); }
    this.covered = out;
  }
  /** Tittaren är vid t (s): se till att läsningen täcker t och en bit framåt */
  want(t) {
    this.asked = Date.now();
    if (this.complete || this.failed) return;
    t = Math.max(0, Math.min(+t || 0, this.duration || Infinity));
    const end = Math.min(this.duration || Infinity, t + 60);
    if (this.covers(t) && this.covers(end)) { if (!this.proc) this.next(); return; }
    if (this.proc && this.from <= t && t <= this.pos + AHEAD) return; // på väg dit
    this.start(Math.max(0, t - LEAD), null);
  }
  /** Fortsätt med första luckan som inte är läst */
  next() {
    if (this.complete || this.failed) return;
    let at = 0;
    for (const [a, b] of this.covered) { if (a > at + 0.5) break; at = Math.max(at, b); }
    if (at >= (this.duration || Infinity) - 0.5) { this.done(); return; }
    const nxt = this.covered.find(([a]) => a > at + 0.5);
    this.start(at, nxt ? nxt[0] : null);
  }
  done() {
    if (this.complete) return;
    this.complete = true; clearInterval(this.idleTimer);
    this.onComplete();
  }
  stop() {
    const p = this.proc; if (!p) return;
    this.proc = null; this.jb?.end();
    this.add(this.from, this.pos);
    p.kill('SIGKILL');
  }
  start(from, stopAt) {
    this.stop();
    this.from = from; this.pos = from; this.stopAt = stopAt;
    const out = this.format === 'sup' ? ['-c', 'copy', '-f', 'sup'] : ['-f', 'webvtt'];
    // Videon kopieras till ingenstans bara för att -progress ska visa hur långt läsningen kommit
    // (undertextpaket kommer glest och säger inget om läspositionen)
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-protocol_whitelist', 'file,pipe', '-copyts',
      ...(from > 0 ? ['-ss', from.toFixed(3)] : []), '-i', this.file,
      '-map', `0:${this.stream}`, ...out, '-flush_packets', '1', 'pipe:1',
      '-map', '0:v:0?', '-c', 'copy', '-f', 'null', '-', '-progress', 'pipe:2', '-stats_period', '1'];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    this.jb?.end();
    const jb = this.jb = jobs.track('subtitle', `Läser undertext: ${this.title || path.basename(this.file)}`, { total: this.duration || null });
    const parser = this.parser();
    let err = '', line = '';
    p.stdout.on('data', (c) => {
      try { parser.push(c); } catch (e) { err = e.message; this.failed = true; p.kill('SIGKILL'); }
    });
    p.stderr.on('data', (c) => {
      line += c;
      const parts = line.split('\n'); line = parts.pop();
      for (const l of parts) {
        const m = /^out_time_us=(\d+)/.exec(l);
        if (m) {
          if (this.proc !== p) continue;
          this.pos = from + +m[1] / 1e6;
          this.add(from, this.pos);
          jb.update(this.covered.reduce((a, [x, y]) => a + Math.min(y, this.duration || y) - x, 0));
          // Läsningen har nått något som redan är läst: hoppa till nästa lucka
          if (this.stopAt != null && this.pos >= this.stopAt) { this.stop(); parser.end?.(); this.next(); }
        } else if (!/^[a-z_]+=/.test(l)) err = (err + l + '\n').slice(-1000);
      }
    });
    p.on('error', (e) => { jb.end(); if (this.proc === p) { this.proc = null; this.fail(e.message); } });
    p.on('close', (code) => {
      parser.end?.(); jb.end();
      if (this.proc !== p) return; // stoppad av oss
      this.proc = null;
      // Filens slut: allt härifrån är läst
      if (code === 0) { this.add(from, this.duration ? Math.max(this.pos, this.duration) : Infinity); this.errors = 0; this.next(); }
      else if (this.failed || ++this.errors > 2) this.fail(err.trim() || `ffmpeg avslutades med ${code}`);
      else this.add(from, this.pos);
    });
  }
  fail(msg) {
    this.failed = true; clearInterval(this.idleTimer);
    this.onError(msg);
  }
  close() { clearInterval(this.idleTimer); this.stop(); }
}

/** Tolkar WebVTT medan den skrivs: anropar onCue({ s, e, text }) för varje komplett cue */
export function vttParser(onCue) {
  let buf = '';
  const dec = new StringDecoder('utf8'); // ett tecken kan delas mellan två bitar
  const time = (x) => x.split(':').reduce((a, v) => a * 60 + parseFloat(v), 0);
  const block = (b) => {
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) return;
    const m = /^\s*([\d:.]+)\s+-->\s+([\d:.]+)(.*)$/.exec(lines[i]);
    if (!m) return;
    const text = lines.slice(i + 1).join('\n').trim();
    if (text) onCue({ s: time(m[1]), e: time(m[2]), settings: m[3].trim(), text });
  };
  return {
    push(c) {
      buf += dec.write(c).replace(/\r/g, '');
      const parts = buf.split(/\n\n+/); buf = parts.pop();
      for (const b of parts) block(b);
    },
    end() { buf += dec.end(); if (buf.trim()) block(buf); buf = ''; }
  };
}
