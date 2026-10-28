// Liten XML-tolk för e-böckernas metadata (container.xml, OPF, NCX, navigeringsdokumentet, ComicInfo.xml).
// Ingen XML-motor: en enda genomgång från början till slut (indexOf och teckenvis läsning av taggar – inga regex som
// kan backa), DOCTYPE och egna entiteter expanderas aldrig (bara de fem fördefinierade och numeriska), och taket för
// storlek, antal noder och djup gör att även en fientlig fil tolkas i linjär tid. Tolkningen är förlåtande:
// felaktigt nästlade taggar stängs så gott det går i stället för att ge fel.

export const XML_MAX = 4 << 20;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeEntities = (s) => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (m, e) => {
  if (e[0] !== '#') return ENT[e];
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
});
const isNameCh = (c) => !(c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '/' || c === '>' || c === '=');
const localOf = (n) => { const i = n.indexOf(':'); return (i < 0 ? n : n.slice(i + 1)).toLowerCase(); };

export class XmlError extends Error {}
/**
 * Tolkar XML/XHTML till ett träd: { name, local (gemener utan prefix), attrs: { namn: värde }, children: [element | text] }.
 * Roten är ett konstgjort element (name '#doc'). Kastar XmlError vid för stor/djup fil.
 */
export function parseXml(input, { maxNodes = 50000, maxDepth = 100 } = {}) {
  const s = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  if (s.length > XML_MAX) throw new XmlError('för stor XML-fil');
  const root = { name: '#doc', local: '#doc', attrs: {}, children: [] };
  const stack = [root];
  let nodes = 0, i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = s.length;
  const cur = () => stack[stack.length - 1];
  const addText = (t) => { if (t) { cur().children.push(decodeEntities(t)); if (++nodes > maxNodes) throw new XmlError('för många noder'); } };
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { addText(s.slice(i)); break; }
    if (lt > i) addText(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9);
      const t = s.slice(lt + 9, e < 0 ? n : e);
      if (t) { cur().children.push(t); if (++nodes > maxNodes) throw new XmlError('för många noder'); }
      i = e < 0 ? n : e + 3; continue;
    }
    if (s[lt + 1] === '?') { const e = s.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (s[lt + 1] === '!') {
      // DOCTYPE (ev. med intern delmängd [ … ]) hoppas över – entiteterna i den används aldrig
      const gt = s.indexOf('>', lt + 2), br = s.indexOf('[', lt + 2);
      if (br >= 0 && (gt < 0 || br < gt)) { const e = s.indexOf(']>', br); i = e < 0 ? n : e + 2; }
      else i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (s[lt + 1] === '/') {
      const gt = s.indexOf('>', lt + 2);
      const name = s.slice(lt + 2, gt < 0 ? n : gt).trim();
      i = gt < 0 ? n : gt + 1;
      // Stäng upp till närmaste element med samma namn (finns inget: ignorera sluttaggen)
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    // Öppningstagg: namn och attribut läses tecken för tecken (citattecken respekteras – '>' i ett värde avslutar inte)
    let p = lt + 1;
    while (p < n && isNameCh(s[p])) p++;
    const name = s.slice(lt + 1, p);
    if (!name) { addText('<'); i = lt + 1; continue; }
    const attrs = {};
    let self = false, closed = false;
    while (p < n) {
      const c = s[p];
      if (c === '>') { p++; closed = true; break; }
      if (c === '/' && s[p + 1] === '>') { self = true; p += 2; closed = true; break; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '/') { p++; continue; }
      const a0 = p;
      while (p < n && isNameCh(s[p])) p++;
      const an = s.slice(a0, p);
      if (!an) { p++; continue; }
      while (p < n && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n' || s[p] === '\r')) p++;
      let val = '';
      if (s[p] === '=') {
        p++;
        while (p < n && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n' || s[p] === '\r')) p++;
        const q = s[p];
        if (q === '"' || q === "'") { const e = s.indexOf(q, p + 1); val = s.slice(p + 1, e < 0 ? n : e); p = e < 0 ? n : e + 1; }
        else { const v0 = p; while (p < n && s[p] !== '>' && s[p] !== ' ' && s[p] !== '\t' && s[p] !== '\n' && !(s[p] === '/' && s[p + 1] === '>')) p++; val = s.slice(v0, p); }
      }
      if (!(an in attrs) && Object.keys(attrs).length < 64) attrs[an] = decodeEntities(val);
    }
    i = p;
    if (!closed) break;
    const el = { name, local: localOf(name), attrs, children: [] };
    if (++nodes > maxNodes) throw new XmlError('för många noder');
    cur().children.push(el);
    if (!self) {
      if (stack.length > maxDepth) throw new XmlError('för djupt nästlad XML');
      stack.push(el);
    }
  }
  return root;
}

// ---------- hjälpare ----------
/** Attributet (namn eller lokalt namn utan prefix, skiftlägesokänsligt) */
export function attr(el, name) {
  if (!el) return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(el.attrs)) if (k.toLowerCase() === want || localOf(k) === want) return v;
  return null;
}
/** Första elementet med det lokala namnet (djupet först), eller null */
export function find(el, local, max = 200000) {
  if (!el) return null;
  const st = [el];
  let seen = 0;
  while (st.length && seen++ < max) {
    const x = st.pop();
    if (x !== el && x.local === local) return x;
    for (let k = x.children.length - 1; k >= 0; k--) if (typeof x.children[k] !== 'string') st.push(x.children[k]);
  }
  return null;
}
/** Alla element med det lokala namnet i dokumentordning (högst limit) */
export function findAll(el, local, limit = 5000) {
  const out = [];
  if (!el) return out;
  const st = [el];
  while (st.length && out.length < limit) {
    const x = st.pop();
    if (x !== el && x.local === local) out.push(x);
    for (let k = x.children.length - 1; k >= 0; k--) if (typeof x.children[k] !== 'string') st.push(x.children[k]);
  }
  return out;
}
/** Direkta barn med det lokala namnet */
export const kids = (el, local) => (el?.children || []).filter(c => typeof c !== 'string' && (!local || c.local === local));
/** All text i elementet (blanktecken hopslagna), högst max tecken */
export function textOf(el, max = 20000) {
  if (!el) return '';
  let out = '';
  const st = [el];
  while (st.length && out.length < max) {
    const x = st.pop();
    if (typeof x === 'string') { out += x; continue; }
    if (x.local === 'script' || x.local === 'style') continue;
    for (let k = x.children.length - 1; k >= 0; k--) st.push(x.children[k]);
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}
