// "Vem tittar?": profilerna i hushållet som rutor med initial och färg, som i webbappen (web/js/views/login.js).
// Visas efter inloggningen när kontot har flera profiler, och från Konto → Byt profil. Profiler med PIN frågar efter
// den; en barnprofil som byter till en profil med högre åldersgräns utan PIN får ange huvudkontots lösenord.
import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, R } from '../theme';
import { listProfiles, switchProfile, type Profile, type UserInfo } from '../api';
import { Button, ErrorState, Loading } from '../components/ui';
import { saveNow as saveAudio } from '../music';
import { t } from '../i18n';

/** Samma färg som webben ger profilen: egen färg om den är satt, annars en nyans räknad ur namnet */
export function profileColor(p: { name: string; color?: string | null }): string {
  const c = p.color;
  if (typeof c === 'string' && (/^#[0-9a-f]{3,8}$/i.test(c) || /^(rgb|hsl)a?\([0-9a-z\s.,%/+-]*\)$/i.test(c))) return c;
  let h = 0; for (const ch of String(p.name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 55%, 36%)`;
}

type Ask = { p: Profile; kind: 'pin' | 'password'; wrong: boolean };

/** onDone(profil) efter ett byte, onDone(null) = fortsätt med den profil som redan är vald */
export default function Profiles({ current, onDone }: { current: string; onDone: (u: UserInfo | null) => void }) {
  const [data, setData] = useState<{ current: number; profiles: Profile[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(0); // profilen som byts till just nu
  const [ask, setAsk] = useState<Ask | null>(null);
  const [secret, setSecret] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { setData(await listProfiles()); } catch (e: any) { setError(e?.message || t('Kunde inte hämta profilerna')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function pick(p: Profile, extra: { pin?: string; password?: string } = {}) {
    if (!data) return;
    if (p.id === data.current) return onDone(null); // samma profil: inget byte
    // Profiler med PIN: fråga direkt, i stället för att först få "Fel PIN" av servern
    if (p.hasPin && !extra.pin) { setAsk({ p, kind: 'pin', wrong: false }); setSecret(''); setNote(''); return; }
    setBusy(p.id); setNote('');
    try {
      await saveAudio(); // kön eller bokens plats sparas på den gamla profilen innan inloggningen byts
      onDone(await switchProfile(p.id, extra));
    } catch (e: any) {
      if (e?.data?.needPin) { setAsk({ p, kind: 'pin', wrong: !!extra.pin }); setSecret(''); }
      else if (e?.data?.needPassword) { setAsk({ p, kind: 'password', wrong: !!extra.password }); setSecret(''); }
      else { setAsk(null); setNote(e?.message || t('Kunde inte byta profil – försök igen.')); }
    } finally { setBusy(0); }
  }
  const submit = () => {
    if (!ask || !secret) return;
    pick(ask.p, ask.kind === 'pin' ? { pin: secret } : { password: secret });
  };

  if (error && !data) return <SafeAreaView style={st.root}><ErrorState error={error} onRetry={load} /><Button label={t('Fortsätt som {name}', { name: current })} onPress={() => onDone(null)} style={st.back} /></SafeAreaView>;
  if (!data) return <SafeAreaView style={st.root}><Loading /></SafeAreaView>;

  return (
    <SafeAreaView style={st.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">
          <View style={st.brand}>
            <Image source={require('../../assets/logo.png')} style={st.logo} />
          </View>
          {ask ? (
            <View style={st.panel}>
              <View style={[st.av, st.avSmall, { backgroundColor: profileColor(ask.p) }]}><Text style={[st.avText, { fontSize: 26 }]}>{ask.p.name.slice(0, 1).toUpperCase()}</Text></View>
              <Text style={st.h2}>{ask.kind === 'pin' ? t('PIN för {name}', { name: ask.p.name }) : t('Byt till {name}', { name: ask.p.name })}</Text>
              <Text style={st.dim}>{ask.kind === 'pin' ? t('Skriv profilens PIN.') : t('Skriv huvudkontots lösenord för att byta till en profil utan åldersgräns.')}</Text>
              <TextInput style={[st.input, ask.kind === 'pin' && st.pinInput]} value={secret} onChangeText={(v) => setSecret(ask.kind === 'pin' ? v.replace(/\D/g, '') : v)}
                secureTextEntry autoFocus keyboardType={ask.kind === 'pin' ? 'number-pad' : 'default'} maxLength={ask.kind === 'pin' ? 8 : 200}
                autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType={ask.kind === 'pin' ? 'oneTimeCode' : 'password'}
                returnKeyType="go" onSubmitEditing={submit} accessibilityLabel={ask.kind === 'pin' ? 'PIN' : t('Huvudkontots lösenord')} />
              {ask.wrong ? <Text style={st.err} accessibilityRole="alert">{ask.kind === 'pin' ? t('Fel PIN – försök igen.') : t('Fel lösenord – försök igen.')}</Text> : null}
              {note ? <Text style={st.err} accessibilityRole="alert">{note}</Text> : null}
              <Button label={busy ? t('Byter…') : t('Byt profil')} kind="primary" onPress={submit} disabled={!!busy || !secret} style={{ marginTop: 16, alignSelf: 'stretch' }} />
              <Button label={t('Avbryt')} onPress={() => { setAsk(null); setNote(''); }} disabled={!!busy} style={{ marginTop: 10, alignSelf: 'stretch' }} />
            </View>
          ) : (<>
            <Text style={st.h1}>{t('Vem tittar?')}</Text>
            <View style={st.list}>
              {data.profiles.map((p) => (
                <Pressable key={p.id} style={({ pressed }) => [st.card, pressed && { opacity: 0.75 }]} onPress={() => pick(p)} disabled={!!busy}
                  accessibilityRole="button" accessibilityLabel={p.name + (p.kid ? ', ' + t('barnprofil') : '') + (p.hasPin ? ', ' + t('kräver PIN') : '') + (p.id === data.current ? ', ' + t('vald nu') : '')}>
                  <View style={[st.av, { backgroundColor: profileColor(p) }, p.id === data.current && st.avOn]}>
                    <Text style={st.avText}>{p.name.slice(0, 1).toUpperCase()}</Text>
                    {busy === p.id ? <View style={st.avBusy}><Text style={st.dim}>…</Text></View> : null}
                  </View>
                  <Text style={st.name} numberOfLines={1}>{p.name}</Text>
                  {p.kid ? <Text style={st.sub}>{t('Barn')}{p.maxAge != null ? ' · ' + t('max {n} år', { n: p.maxAge }) : ''}</Text>
                    : p.hasPin ? <Text style={st.sub}><Ionicons name="lock-closed" size={11} color={C.dim} /> PIN</Text> : null}
                </Pressable>
              ))}
            </View>
            {note ? <Text style={[st.err, { textAlign: 'center' }]} accessibilityRole="alert">{note}</Text> : null}
            <Button label={t('Fortsätt som {name}', { name: current })} onPress={() => onDone(null)} style={{ alignSelf: 'center', marginTop: 26 }} />
          </>)}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  brand: { alignItems: 'center', marginBottom: 18 },
  logo: { width: 44, height: 44, borderRadius: 10 },
  h1: { color: C.text, fontSize: 28, fontWeight: '800', textAlign: 'center', marginBottom: 26 },
  list: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 20 },
  card: { width: 100, alignItems: 'center', gap: 7 },
  av: { width: 96, height: 96, borderRadius: R.lg, alignItems: 'center', justifyContent: 'center' },
  avOn: { borderWidth: 3, borderColor: C.text },
  avSmall: { width: 64, height: 64, alignSelf: 'center', marginBottom: 10 },
  avText: { color: '#fff', fontSize: 40, fontWeight: '800' },
  avBusy: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,.45)', borderRadius: R.lg, alignItems: 'center', justifyContent: 'center' },
  name: { color: C.text, fontSize: 15, maxWidth: 100 },
  sub: { color: C.dim, fontSize: 12, marginTop: -3 },
  panel: { backgroundColor: C.bg2, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, padding: 18, alignItems: 'stretch' },
  h2: { color: C.text, fontSize: 19, fontWeight: '700', textAlign: 'center' },
  dim: { color: C.dim, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 6 },
  input: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.line, borderRadius: R.sm, color: C.text, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, marginTop: 14 },
  pinInput: { fontSize: 24, letterSpacing: 8, textAlign: 'center' },
  err: { color: C.err, fontSize: 14, marginTop: 12, lineHeight: 20, textAlign: 'center' },
  back: { alignSelf: 'center', marginBottom: 30 },
});
