// Feedback och felrapporter: formuläret (samma som dialogen bakom knappen Feedback i webben) och Mina ärenden med
// status, svar och möjlighet att svara när teamet ber om mer information. Öppnas från Konto och från spelaren vid ett
// uppspelningsfel. Texter, anrop och den tekniska informationen: feedback.ts. All text visas som vanlig text.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { C, R } from '../theme';
import type { UserInfo } from '../api';
import { Button, ErrorState, Loading } from '../components/ui';
import type { Props } from '../nav';
import {
  AREA, FROM, KIND, KIND_SUB, MAX_TEXT, contextRows, currentArea, fmtDate, myTickets, previewContext, recentError, replyTicket, sendTicket, statusLabel,
  type Kind, type TechContext, type Ticket, type Tone,
} from '../feedback';
import { t } from '../i18n';

/** Servern före 1.3.0 har inte feedback: säg det i stället för "Finns inte (404)" */
const errText = (e: any, fallback: string) => (e?.status === 404 ? t('Servern har inte feedback än. Den som sköter servern behöver uppdatera BraXhn TV till version 1.3.0 eller senare.') : e?.message || fallback);

function Header({ title, onBack, right }: { title: string; onBack: () => void; right?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[st.head, { paddingTop: insets.top + 6 }]}>
      <Pressable onPress={onBack} style={st.back} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('Tillbaka')}><Ionicons name="chevron-back" size={24} color={C.text} /></Pressable>
      <Text style={st.headTitle} numberOfLines={1} accessibilityRole="header">{title}</Text>
      {right}
    </View>
  );
}

function Badge({ label, tone }: { label: string; tone: Tone }) {
  const color = tone === 'ok' ? C.ok : tone === 'err' ? C.err : tone === 'warn' ? C.warn : C.accent2;
  return <View style={[st.badge, { borderColor: color }]}><Text style={[st.badgeText, { color }]}>{label}</Text></View>;
}

/** Den tekniska informationen som en lista */
function ContextList({ c }: { c: TechContext | null }) {
  const rows = contextRows(c);
  if (!rows.length) return <Text style={st.small}>{t('Ingen teknisk information bifogas.')}</Text>;
  return <View style={{ gap: 6 }}>{rows.map(([k, v], i) => <View key={i}><Text style={st.dt}>{k}</Text><Text style={st.dd} selectable>{v}</Text></View>)}</View>;
}

/** Rubrik som fäller ut innehållet (som details/summary i webben) */
function Fold({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children?: React.ReactNode }) {
  return (
    <View>
      <Pressable onPress={onToggle} style={st.fold} accessibilityRole="button" aria-expanded={open} hitSlop={6}>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={16} color={C.dim} /><Text style={st.foldText}>{label}</Text>
      </Pressable>
      {open ? <View style={{ paddingTop: 8 }}>{children}</View> : null}
    </View>
  );
}

function Check({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={st.check} accessibilityRole="checkbox" aria-checked={on} accessibilityLabel={label}>
      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? C.accent : C.dim} /><Text style={st.checkText}>{label}</Text>
    </Pressable>
  );
}

// ---------- formuläret ----------

export function FeedbackScreen({ navigation, route, user }: Props<'Feedback'> & { user: UserInfo | null }) {
  const [kind, setKind] = useState<Kind>(route.params?.kind || (recentError() ? 'bug' : 'idea'));
  const [area, setArea] = useState(route.params?.area || currentArea());
  const [text, setText] = useState('');
  const [tech, setTech] = useState(true);
  const [showCtx, setShowCtx] = useState(false);
  const [ctx, setCtx] = useState<{ c: TechContext | null; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ sent: boolean; message: string } | null>(null);
  const seq = useRef(0);
  const admin = !!user?.is_admin;

  // "Visa vad som skickas med": servern svarar med exakt det som skulle sparas (samma funktion som vid Skicka)
  useEffect(() => {
    if (!tech || !showCtx) return;
    const n = ++seq.current;
    setCtx(null);
    previewContext(kind).then((r) => { if (n === seq.current) setCtx({ c: r.context }); }).catch((e) => { if (n === seq.current) setCtx({ c: null, error: errText(e, t('Kunde inte hämta förhandsvisningen')) }); });
  }, [tech, showCtx, kind]);

  const send = async () => {
    if (!text.trim()) { setError(t('Skriv ett meddelande.')); return; }
    setBusy(true); setError('');
    try {
      const r = await sendTicket({ kind, area, text, tech });
      setDone({ sent: r.status === 'approved', message: r.message || (r.status === 'approved' ? t('Ärendet är skickat till teamet.') : t('Ärendet är mottaget och väntar på granskning.')) });
    } catch (e: any) { setError(errText(e, t('Ärendet kunde inte skickas – försök igen.'))); }
    finally { setBusy(false); }
  };

  if (done) return (
    <View style={st.root}>
      <Header title={done.sent ? t('Tack – ärendet är skickat') : t('Tack – ärendet är mottaget')} onBack={() => navigation.goBack()} />
      <View style={st.body}>
        <View style={st.panel}>
          <Ionicons name="checkmark-circle" size={36} color={C.ok} />
          <Text style={st.lead}>{done.message}</Text>
          <Text style={st.small}>{t('Svaret syns under Mina ärenden.')}</Text>
          <View style={st.row}>
            <Button label={t('Mina ärenden')} icon="chatbubbles-outline" onPress={() => navigation.replace('Tickets')} />
            <Button label={t('Klar')} kind="primary" onPress={() => navigation.goBack()} />
          </View>
        </View>
      </View>
    </View>
  );

  return (
    <View style={st.root}>
      <Header title={t('Feedback och felrapporter')} onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
          <View style={{ gap: 10 }} accessibilityRole="radiogroup" accessibilityLabel={t('Vad vill du göra?')}>
            {(['idea', 'bug'] as const).map((k) => (
              <Pressable key={k} onPress={() => setKind(k)} style={[st.opt, kind === k && st.optOn]} accessibilityRole="radio" aria-checked={kind === k} accessibilityLabel={KIND()[k]}>
                <Ionicons name={kind === k ? 'radio-button-on' : 'radio-button-off'} size={20} color={kind === k ? C.accent : C.dim} />
                <View style={{ flex: 1 }}><Text style={st.optTitle}>{KIND()[k]}</Text><Text style={st.small}>{KIND_SUB()[k]}</Text></View>
              </Pressable>
            ))}
          </View>

          <Text style={st.label}>{t('Gäller')}</Text>
          <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel={t('Gäller')}>
            {Object.entries(AREA()).map(([k, v]) => (
              <Pressable key={k} onPress={() => setArea(k)} style={[st.chip, area === k && st.chipOn]} accessibilityRole="radio" aria-checked={area === k}>
                <Text style={[st.chipText, area === k && { color: C.onAccent }]}>{v}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={st.label} nativeID="fbtext">{t('Meddelande')}</Text>
          <TextInput style={st.input} value={text} onChangeText={(v) => { setText(v); if (error) setError(''); }} multiline maxLength={MAX_TEXT} textAlignVertical="top"
            placeholder={t('T.ex. Tryckte på Spela på en film. Bilden frös efter en minut.')} placeholderTextColor={C.dim} accessibilityLabel={t('Meddelande')} accessibilityLabelledBy="fbtext" />
          <Text style={st.small}>{t('Vad gjorde du, vad hände och vad hade du väntat dig?')}</Text>

          <Check on={tech} onPress={() => setTech((v) => !v)} label={t('Skicka med teknisk information (appversion, enhet, skärmstorlek och senaste uppspelningen)')} />
          {tech ? (
            <Fold label={t('Visa vad som skickas med')} open={showCtx} onToggle={() => setShowCtx((v) => !v)}>
              {ctx ? (ctx.error ? <Text style={st.small}>{ctx.error}</Text> : <ContextList c={ctx.c} />) : <Text style={st.small}>{t('Hämtar…')}</Text>}
            </Fold>
          ) : null}

          <Text style={st.small}>{admin ? t('Du är administratör: ärendet skickas direkt till utvecklarna.') : t('En administratör läser ärendet först. Det skickas till utvecklarna bara om administratören godkänner det.')} {t('Svaret syns under Mina ärenden.')}</Text>
          {error ? <Text style={st.err} accessibilityLiveRegion="polite">{error}</Text> : null}
          <View style={[st.row, { justifyContent: 'flex-end' }]}>
            <Button label={t('Mina ärenden')} icon="chatbubbles-outline" onPress={() => navigation.replace('Tickets')} />
            <Button label={busy ? t('Skickar…') : t('Skicka')} kind="primary" icon="send" disabled={busy} onPress={send} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// ---------- Mina ärenden ----------

function TicketCard({ k, admin, onReplied }: { k: Ticket; admin: boolean; onReplied: (msg: string) => void }) {
  const [label, tone] = statusLabel(k);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCtx, setShowCtx] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const send = async () => {
    if (!reply.trim()) { setError(t('Skriv ett svar.')); return; }
    setBusy(true); setError('');
    try { await replyTicket(k.id, reply); setReply(''); onReplied(admin ? t('Svaret är skickat till teamet.') : t('Svaret är mottaget och väntar på granskning.')); }
    catch (e: any) { setError(errText(e, t('Svaret kunde inte skickas – försök igen.'))); }
    finally { setBusy(false); }
  };
  return (
    <View style={st.panel}>
      <View style={[st.row, { alignItems: 'center' }]}><Text style={st.num}>#{k.id}</Text><Badge label={label} tone={tone} /></View>
      <Text style={st.small}>{KIND()[k.kind] || ''} · {AREA()[k.area] || ''} · {fmtDate(k.created)}</Text>
      {k.title ? <Text style={st.h3}>{k.title}</Text> : null}
      <Text style={st.text} selectable>{k.text}</Text>
      {k.sentText || k.sentTitle ? (
        <Fold label={t('Administratören ändrade texten innan den skickades')} open={showSent} onToggle={() => setShowSent((v) => !v)}>
          {k.sentTitle ? <Text style={st.h3}>{k.sentTitle}</Text> : null}<Text style={st.text}>{k.sentText || k.text}</Text>
        </Fold>
      ) : null}
      {k.thread.map((m, i) => (
        <View key={i} style={[st.msg, m.from === 'team' && st.msgTeam]}>
          <Text style={st.small}><Text style={{ fontWeight: '700', color: C.text }}>{FROM()[m.from] || m.from}</Text> · {fmtDate(m.created)}{m.pending ? ' · ' + t('Väntar på granskning') : ''}</Text>
          {m.status === 'reopened' ? <Text style={st.small}>{t('Ärendet öppnades igen')}</Text> : null}
          {m.text ? <Text style={st.text} selectable>{m.text}</Text> : m.status && m.status !== 'reopened' ? <Text style={st.small}>{statusLabel({ status: m.status, version: m.version })[0]}</Text> : null}
        </View>
      ))}
      {k.canReply ? (
        <View style={{ gap: 8, marginTop: 4 }}>
          <Text style={st.label} nativeID={`fbr${k.id}`}>{t('Ditt svar till teamet')}</Text>
          <TextInput style={[st.input, { minHeight: 90 }]} value={reply} onChangeText={setReply} multiline maxLength={MAX_TEXT} textAlignVertical="top" accessibilityLabel={t('Ditt svar till teamet')} accessibilityLabelledBy={`fbr${k.id}`} />
          <Text style={st.small}>{admin ? t('Svaret skickas direkt till teamet.') : t('Svaret granskas av en administratör innan det skickas vidare.')}</Text>
          {error ? <Text style={st.err}>{error}</Text> : null}
          <View style={st.row}><Button label={busy ? t('Skickar…') : t('Skicka svaret')} kind="primary" disabled={busy} onPress={send} /></View>
        </View>
      ) : null}
      <Fold label={t('Teknisk information som bifogades')} open={showCtx} onToggle={() => setShowCtx((v) => !v)}><ContextList c={k.context} /></Fold>
    </View>
  );
}

export function TicketsScreen({ navigation, user }: Props<'Tickets'> & { user: UserInfo | null }) {
  const [list, setList] = useState<Ticket[] | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    try { setList((await myTickets()).tickets); setError(''); }
    catch (e: any) { setError(errText(e, t('Kunde inte hämta dina ärenden'))); }
  }, []);
  // Hämtas på nytt när man kommer tillbaka från formuläret
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const newBtn = <Button small label={t('Nytt ärende')} icon="add" kind="primary" onPress={() => navigation.navigate('Feedback', {})} />;
  return (
    <View style={st.root}>
      <Header title={t('Mina ärenden')} onBack={() => navigation.goBack()} right={newBtn} />
      {error && !list ? <ErrorState error={error} onRetry={load} /> : !list ? <Loading /> : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
            <Text style={st.dim}>{t('Här ser du det du har skickat in, vad som händer med det och teamets svar. Bara du ser dina ärenden.')}</Text>
            {note ? <Text style={st.ok} accessibilityLiveRegion="polite">{note}</Text> : null}
            {list.length ? list.map((k) => <TicketCard key={`${k.id}-${k.updated}`} k={k} admin={!!user?.is_admin} onReplied={(m) => { setNote(m); load(); }} />) : (
              <View style={[st.panel, { alignItems: 'center' }]}>
                <Ionicons name="chatbubbles-outline" size={32} color={C.dim} />
                <Text style={st.h3}>{t('Inga ärenden än')}</Text>
                <Text style={[st.dim, { textAlign: 'center' }]}>{t('Har du en idé eller är det något som inte fungerar? Tryck på Nytt ärende.')}</Text>
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingBottom: 8, backgroundColor: C.chrome, borderBottomWidth: 1, borderBottomColor: C.line },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headTitle: { flex: 1, color: C.text, fontSize: 18, fontWeight: '700' },
  body: { padding: 14, gap: 12, paddingBottom: 40 },
  panel: { backgroundColor: C.bg2, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, padding: 16, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg2 },
  optOn: { borderColor: C.accent },
  optTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  label: { color: C.text, fontSize: 14, fontWeight: '700', marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.bg3 },
  chipOn: { backgroundColor: C.accent },
  chipText: { color: C.text, fontSize: 14, fontWeight: '600' },
  input: { minHeight: 130, color: C.text, fontSize: 15, lineHeight: 21, backgroundColor: C.bg2, borderWidth: 1, borderColor: C.line, borderRadius: R.md, padding: 12 },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6, minHeight: 44 },
  checkText: { flex: 1, color: C.text, fontSize: 14, lineHeight: 20 },
  fold: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  foldText: { color: C.dim, fontSize: 14 },
  dt: { color: C.dim, fontSize: 12.5 },
  dd: { color: C.text, fontSize: 14, lineHeight: 19 },
  small: { color: C.dim, fontSize: 13, lineHeight: 18 },
  dim: { color: C.dim, fontSize: 14, lineHeight: 20 },
  lead: { color: C.text, fontSize: 16, lineHeight: 22 },
  err: { color: C.err, fontSize: 14, lineHeight: 20 },
  ok: { color: C.ok, fontSize: 14, lineHeight: 20 },
  num: { color: C.text, fontSize: 15, fontWeight: '800' },
  h3: { color: C.text, fontSize: 16, fontWeight: '700' },
  text: { color: C.text, fontSize: 15, lineHeight: 21 },
  badge: { borderWidth: 1, borderRadius: R.pill, paddingHorizontal: 9, paddingVertical: 2 },
  badgeText: { fontSize: 12.5, fontWeight: '700' },
  msg: { borderLeftWidth: 3, borderLeftColor: C.line, paddingLeft: 10, gap: 2, marginTop: 4 },
  msgTeam: { borderLeftColor: C.accent },
});
