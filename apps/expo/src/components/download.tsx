// Ladda ner för offline: knappen på titelsidan (film, avsnitt, hel säsong) och boksidan, med kvalitet, förlopp,
// paus, fortsätt och ta bort. Själva nedladdningen sköter src/offline.ts.
import React, { useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C, R } from '../theme';
import * as off from '../offline';
import { fmtSize, keyOf, progressOf, qualityLabel, qualityOptions, type DlEntry } from '../offlinecore';
import { Button } from './ui';
import { t, tn } from '../i18n';

let lastQ = '480'; // senast valda kvalitet (mindre filer passar telefonen bäst)

/** Frågar först (Ta bort / Avbryt). På webben finns inga nedladdningar, så frågan behövs bara i appen. */
export function confirm(title: string, text: string, ok: string, fn: () => void) {
  if (Platform.OS === 'web') { if (globalThis.confirm?.(`${title}\n\n${text}`)) fn(); return; }
  Alert.alert(title, text, [{ text: t('Avbryt'), style: 'cancel' }, { text: ok, style: 'destructive', onPress: fn }]);
}
export const askRemove = (e: DlEntry) => confirm(t('Ta bort {title}?', { title: e.title }), t('Filen tas bort från telefonen. Du kan ladda ner den igen när du har nät.'), t('Ta bort'), () => { off.remove(e.key); });

/** Förloppsrad med text */
export function Progress({ e }: { e: DlEntry }) {
  const p = progressOf(e);
  return (
    <View style={{ gap: 5 }}>
      {e.state !== 'done' && e.state !== 'error' ? <View style={st.barBg}><View style={[st.barFill, { width: `${Math.round(p.part * 100)}%` }, e.state === 'paused' && { backgroundColor: C.dim }]} /></View> : null}
      <Text style={[st.small, e.state === 'error' && { color: C.err }]} numberOfLines={2}>{p.text}</Text>
    </View>
  );
}

/** Knapparna för en nedladdning som finns: pausa, fortsätt, försök igen, ta bort */
export function EntryActions({ e, small = true }: { e: DlEntry; small?: boolean }) {
  return (
    <View style={st.row}>
      {e.state === 'queued' || e.state === 'preparing' || e.state === 'downloading' ? <Button small={small} icon="pause" label={t('Pausa')} onPress={() => off.pause(e.key)} /> : null}
      {e.state === 'paused' ? <Button small={small} icon="play" label={t('Fortsätt')} onPress={() => off.resume(e.key)} /> : null}
      {e.state === 'error' ? <Button small={small} icon="refresh" label={t('Försök igen')} onPress={() => off.resume(e.key)} /> : null}
      <Button small={small} kind="danger" icon={e.state === 'done' ? 'trash-outline' : 'close'} label={e.state === 'done' ? t('Ta bort') : t('Avbryt')} onPress={() => askRemove(e)} />
    </View>
  );
}

/** Val av kvalitet: storleken är uppskattad efter serverns bithastighet för steget */
function QualityPick({ height, duration, many, onPick, onCancel }: { height?: number | null; duration?: number | null; many?: number; onPick: (q: string) => void; onCancel: () => void }) {
  const opts = qualityOptions(height, duration);
  const { free } = off.storage();
  return (
    <View style={st.pick}>
      <Text style={st.small}>{many ? tn(many, 'Kvalitet för 1 avsnitt', 'Kvalitet för {n} avsnitt') : t('Välj kvalitet')}{free ? ' · ' + t('ledigt på telefonen: {v}', { v: fmtSize(free) }) : ''}</Text>
      {opts.map((o) => (
        <Pressable key={o.q} onPress={() => { lastQ = o.q; onPick(o.q); }} style={({ pressed }) => [st.opt, o.q === lastQ && st.optOn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={t('Ladda ner i {v}', { v: o.label })}>
          <Text style={st.optT}>{o.label}</Text>
          <Text style={st.small} numberOfLines={1}>{[o.hint, o.bytes ? `≈ ${fmtSize(o.bytes)}` : ''].filter(Boolean).join(' · ')}</Text>
        </Pressable>
      ))}
      <Button small label={t('Avbryt')} onPress={onCancel} />
    </View>
  );
}

/** Ladda ner en film eller ett avsnitt (titelsidan) */
export function DownloadVideo({ it }: { it: { id: number; kind: string; title: string; height?: number | null; duration?: number | null } & Record<string, any> }) {
  const list = off.useDownloads();
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!off.mayDownload() && !list.length) return null;
  const e = list.find((x) => x.key === keyOf(it.kind, it.id));
  if (e) return <View style={st.box}><Progress e={e} /><EntryActions e={e} /></View>;
  if (!off.mayDownload()) return null;
  const start = async (q: string) => {
    setPicking(false); setBusy(true);
    try { await off.downloadVideo(it as any, q); setErr(''); } catch (x: any) { setErr(x?.message || t('Det gick inte att ladda ner')); } finally { setBusy(false); }
  };
  return (
    <View style={st.box}>
      {picking ? <QualityPick height={it.height} duration={it.duration} onPick={start} onCancel={() => setPicking(false)} />
        : <Button icon="download-outline" label={busy ? t('Frågar servern…') : t('Ladda ner')} disabled={busy} onPress={() => setPicking(true)} />}
      {err ? <Text style={[st.small, { color: C.err }]}>{err}</Text> : null}
    </View>
  );
}

/** Hela säsongen: alla avsnitt i listan som inte redan finns i Nedladdat */
export function DownloadSeason({ eps, label }: { eps: ({ id: number; kind: string; title: string; duration?: number | null } & Record<string, any>)[]; label: string }) {
  const list = off.useDownloads();
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState('');
  if (!off.mayDownload() || !eps.length) return null;
  const have = eps.filter((x) => list.some((e) => e.key === keyOf('episode', x.id)));
  const done = have.filter((x) => list.find((e) => e.key === keyOf('episode', x.id))?.state === 'done').length;
  const todo = eps.filter((x) => !have.includes(x));
  const start = async (q: string) => {
    setPicking(false);
    let ok = 0, fail = '';
    for (const x of todo) { try { if (await off.downloadVideo(x as any, q)) ok++; } catch (y: any) { fail = y?.message || t('Det gick inte'); } }
    setMsg(fail ? tn(todo.length, '{ok} av 1 avsnitt lades till. {fail}', '{ok} av {n} avsnitt lades till. {fail}', { ok, fail }) : '');
  };
  return (
    <View style={[st.box, { paddingHorizontal: 14 }]}>
      {have.length ? <Text style={st.small}>{tn(eps.length, '{done} av 1 avsnitt nedladdat', '{done} av {n} avsnitt nedladdade', { done }) + (have.length > done ? t(', {n} på gång', { n: have.length - done }) : '')}</Text> : null}
      {picking ? <QualityPick many={todo.length} duration={todo.reduce((s, x) => s + (x.duration || 0), 0)} onPick={start} onCancel={() => setPicking(false)} />
        : todo.length ? <Button small icon="download-outline" label={tn(todo.length, 'Ladda ner {label} (1 avsnitt)', 'Ladda ner {label} ({n} avsnitt)', { label })} onPress={() => setPicking(true)} /> : null}
      {msg ? <Text style={[st.small, { color: C.err }]}>{msg}</Text> : null}
    </View>
  );
}

/** Liten knapp per avsnitt: ladda ner i senast vald kvalitet, se förlopp, pausa/fortsätt, ta bort */
export function EpisodeDownload({ it }: { it: { id: number; kind: string; title: string } & Record<string, any> }) {
  const list = off.useDownloads();
  if (!off.mayDownload() && !list.length) return null;
  const e = list.find((x) => x.key === keyOf('episode', it.id));
  if (!e && !off.mayDownload()) return null;
  const p = e ? progressOf(e) : null;
  const icon: keyof typeof Ionicons.glyphMap = !e ? 'download-outline' : e.state === 'done' ? 'checkmark-circle' : e.state === 'paused' ? 'pause-circle-outline' : e.state === 'error' ? 'alert-circle-outline' : 'cloud-download';
  const label = !e ? t('Ladda ner avsnitt {n} i {q}', { n: it.episode ?? '', q: qualityLabel(lastQ) }) : e.state === 'done' ? t('Nedladdat, ta bort') : p!.text;
  const press = () => {
    if (!e) { off.downloadVideo(it as any, lastQ).catch((x) => Alert.alert(t('Det gick inte att ladda ner'), x?.message || '')); return; }
    if (e.state === 'done') askRemove(e);
    else if (e.state === 'paused' || e.state === 'error') off.resume(e.key);
    else off.pause(e.key);
  };
  return (
    <Pressable onPress={press} hitSlop={8} style={st.epBtn} accessibilityRole="button" accessibilityLabel={label}>
      <Ionicons name={icon} size={22} color={e?.state === 'done' ? C.ok : e?.state === 'error' ? C.err : C.dim} />
      {e && e.state !== 'done' && e.state !== 'error' ? <Text style={st.tiny}>{e.state === 'preparing' ? '…' : `${Math.round(p!.part * 100)}%`}</Text> : null}
    </Pressable>
  );
}

/** Ladda ner en ljudbok (boksidan) */
export function DownloadBook({ id, cover }: { id: number; cover?: boolean }) {
  const list = off.useDownloads();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!off.mayDownload() && !list.length) return null;
  const e = list.find((x) => x.key === keyOf('book', id));
  if (e) return <View style={[st.box, { paddingHorizontal: 14 }]}><Progress e={e} /><EntryActions e={e} /></View>;
  if (!off.mayDownload()) return null;
  return (
    <View style={[st.box, { paddingHorizontal: 14 }]}>
      <Button icon="download-outline" label={busy ? t('Frågar servern…') : t('Ladda ner boken')} disabled={busy}
        onPress={async () => { setBusy(true); try { await off.downloadBook(id, cover !== false); setErr(''); } catch (x: any) { setErr(x?.message || t('Det gick inte att ladda ner')); } finally { setBusy(false); } }} />
      {err ? <Text style={[st.small, { color: C.err }]}>{err}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  box: { gap: 8, marginTop: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  small: { color: C.dim, fontSize: 13, lineHeight: 18 },
  tiny: { color: C.dim, fontSize: 10 },
  barBg: { height: 4, borderRadius: 2, backgroundColor: C.bg3, overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: C.accent },
  pick: { gap: 6, padding: 10, borderRadius: R.lg, backgroundColor: C.bg2, borderWidth: 1, borderColor: C.line },
  opt: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: R.md, borderWidth: 1, borderColor: C.line, gap: 2 },
  optOn: { borderColor: C.accent },
  optT: { color: C.text, fontSize: 15, fontWeight: '700' },
  epBtn: { width: 40, alignItems: 'center', justifyContent: 'center', gap: 1 },
});
