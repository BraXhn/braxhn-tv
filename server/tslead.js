// TS-segment som ska gå att börja spela på (start, fortsättning, spolning): bilderna som hör till föregående GOP tas bort.
//
// Filer med öppen GOP har efter varje nyckelbild några B-bilder som VISAS före nyckelbilden och som behöver bilder ur
// GOP:en innan. När uppspelningen fortsätter från segmentet före finns de bilderna. Börjar avkodningen på segmentet
// (spelaren har inget före) saknas de – och Chromes mjukvaruavkodare avbryter då hela uppspelningen med
// PIPELINE_ERROR_DECODE i stället för att hoppa över bilderna. De går ändå aldrig att visa utan sin föregångare, så
// ingenting förloras på att ta bort dem i just det segment som spelaren börjar på (seg-N.ts?ra=<sekunder in i
// segmentet>, se stream.js).
// Importerar inget utöver Buffer – testas för sig i test/open-gop-seek.test.js.

const PKT = 188, WRAP = 2 ** 33;

/** PTS (33 bitar, 90 kHz) ur ett PES-huvud som börjar på o, eller null */
function pesPts(b, o, end) {
  if (o + 14 > end || b[o] !== 0 || b[o + 1] !== 0 || b[o + 2] !== 1 || !(b[o + 7] & 0x80)) return null;
  return ((b[o + 9] & 0x0e) >> 1) * 2 ** 30 + ((b[o + 10] << 22) | ((b[o + 11] >> 1) << 15) | (b[o + 12] << 7) | (b[o + 13] >> 1));
}
/** Sektionens början i ett TS-paket med PAT/PMT (efter pekarfältet), eller -1 */
const section = (b, pay, end) => { const o = pay + 1 + b[pay]; return o + 12 <= end ? o : -1; };

/**
 * Tar bort bildpaket som visas före sin GOP:s nyckelbild, i segmentets första GOP och i varje senare GOP som börjar
 * högst upTo sekunder in i segmentet (spelaren ska börja upTo sekunder in och avkodar då från nyckelbilden närmast
 * före – alla bilder som tas bort ligger före den punkten och hade ändå inte visats). SLACK täcker att spelarens
 * tidslinje kan ligga någon tiondel fel mot strömmens.
 * Ljud och övriga paket lämnas orörda; bildpaketens löpnummer (continuity counter) räknas om så att strömmen är hel.
 * Ger tillbaka samma buffert om inget behöver tas bort eller om innehållet inte är ett TS-segment med H.264.
 */
export const SLACK = 0.5;
export function dropLeading(buf, upTo = 0) {
  if (!buf || buf.length < PKT * 3 || buf.length % PKT) return buf;
  const reach = (Math.max(0, Number(upTo) || 0) + SLACK) * 90000;
  const ahead = (a, b) => ((a - b + WRAP * 1.5) % WRAP) - WRAP / 2; // a − b med hänsyn till att PTS slår runt
  let pmt = -1, vid = -1, first = null, key = null, drop = false, done = false, shift = 0, o = 0, out = null;
  for (let p = 0; p < buf.length; p += PKT) {
    if (buf[p] !== 0x47) return buf; // inte i takt: rör ingenting
    const end = p + PKT, pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2], pusi = buf[p + 1] & 0x40, afc = (buf[p + 3] >> 4) & 3;
    const pay = afc & 1 ? p + 4 + (afc & 2 ? 1 + buf[p + 4] : 0) : -1;
    if (vid < 0 && pusi && pay > 0 && pay < end) {
      if (pid === 0) {
        // PAT: första programmet (programnummer 0 är nätverkstabellen)
        const s = section(buf, pay, end);
        if (s > 0) for (let i = s + 8, e = Math.min(end - 4, s + 3 + (((buf[s + 1] & 0x0f) << 8) | buf[s + 2]) - 4); i + 4 <= e; i += 4)
          if ((buf[i] << 8) | buf[i + 1]) { pmt = ((buf[i + 2] & 0x1f) << 8) | buf[i + 3]; break; }
      } else if (pid === pmt) {
        // PMT: första H.264-strömmen (typ 0x1b)
        const s = section(buf, pay, end);
        if (s > 0) {
          const e = Math.min(end, s + 3 + (((buf[s + 1] & 0x0f) << 8) | buf[s + 2]) - 4);
          for (let i = s + 12 + (((buf[s + 10] & 0x0f) << 8) | buf[s + 11]); i + 5 <= e; i += 5 + (((buf[i + 3] & 0x0f) << 8) | buf[i + 4]))
            if (buf[i] === 0x1b) { vid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2]; break; }
        }
      }
    }
    if (pid === vid && !done) {
      if (pusi && pay > 0) {
        const pts = pesPts(buf, pay, end);
        // Nästa nyckelbild (random_access_indicator): en ny GOP – efter upTo finns inget mer att ta bort
        const rai = (afc & 2) && buf[p + 4] > 0 && (buf[p + 5] & 0x40);
        if (first == null) { first = key = pts; drop = false; if (pts == null) done = true; }
        else if (rai) { drop = false; if (pts == null || ahead(pts, first) > reach) done = true; else key = pts; }
        else drop = pts != null && ahead(pts, key) < 0;
      }
      if (drop) {
        if (!out) { out = Buffer.allocUnsafe(buf.length); buf.copy(out, 0, 0, p); o = p; }
        if (afc & 1) shift++;
        continue;
      }
    }
    if (out) {
      buf.copy(out, o, p, end);
      if (pid === vid && shift && (afc & 1)) out[o + 3] = (buf[p + 3] & 0xf0) | ((buf[p + 3] - shift) & 0x0f);
      o += PKT;
    }
  }
  return out ? out.subarray(0, o) : buf;
}
