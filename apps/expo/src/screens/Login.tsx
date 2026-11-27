// Lägg till server: serverns adress, namn och lösenord (och kod från autentiseringsappen när kontot har
// tvåstegsverifiering). Samma sida används när en sparad server behöver lösenordet igen – då är adressen ifylld.
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, R } from '../theme';
import { ApiError, addServer, api, normalizeServer, serverLabel, type Server } from '../api';
import { Button } from '../components/ui';
import { t } from '../i18n';

export default function Login({ onDone, onCancel, again }: { onDone: () => void; onCancel?: () => void; again?: Server | null }) {
  const [server, setSrv] = useState(again?.url || '');
  const [name, setName] = useState(again?.user || '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [need2fa, setNeed2fa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    const url = normalizeServer(server);
    if (!url) return setError(t('Skriv serverns adress, t.ex. 192.168.1.10 eller tv.example.com'));
    if (!name.trim() || !password) return setError(t('Skriv namn och lösenord'));
    setBusy(true); setError('');
    try {
      // Kontrollera först att adressen går till en BraXhn TV-server – då blir felet begripligt
      const st = await api<{ name?: string; needsSetup?: boolean }>('/api/status', { server: url, auth: false, timeout: 10000 });
      if (st.needsSetup) throw new ApiError(t('Servern är inte installerad än. Öppna den i en webbläsare och gör klart installationen först.'));
      const r = await api<{ token: string; user?: { name: string } }>('/api/login', { server: url, auth: false, method: 'POST', body: { name: name.trim(), password, app: true, ...(code ? { code: code.trim() } : {}) } });
      await addServer(url, r.user?.name || name.trim(), r.token);
      onDone();
    } catch (e: any) {
      if (e?.data?.need2fa) { setNeed2fa(true); setError(code ? e.message : ''); }
      else setError(e?.message || t('Inloggningen misslyckades'));
    } finally { setBusy(false); }
  }

  return (
    <SafeAreaView style={st.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">
          <View style={st.brand}>
            <Image source={require('../../assets/logo.png')} style={st.logo} />
            <Text style={st.brandText}>BraXhn TV</Text>
          </View>
          <View style={st.panel}>
            <Text style={st.h2}>{again ? t('Logga in på {v}', { v: serverLabel(again) }) : t('Lägg till server')}</Text>
            <Text style={st.label}>{t('Serverns adress')}</Text>
            <TextInput style={st.input} value={server} onChangeText={setSrv} placeholder={t('192.168.1.10 eller tv.example.com')} placeholderTextColor={C.dim}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="next" accessibilityLabel={t('Serverns adress')} />
            <Text style={st.label}>{t('Namn')}</Text>
            <TextInput style={st.input} value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} textContentType="username" autoComplete="username" returnKeyType="next" accessibilityLabel={t('Namn')} />
            <Text style={st.label}>{t('Lösenord')}</Text>
            <TextInput style={st.input} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={submit} accessibilityLabel={t('Lösenord')} />
            {need2fa ? (<>
              <Text style={st.label}>{t('Kod från din autentiseringsapp')}</Text>
              <TextInput style={st.input} value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" autoFocus returnKeyType="go" onSubmitEditing={submit} accessibilityLabel={t('Kod från din autentiseringsapp')} />
            </>) : null}
            {error ? <Text style={st.err} accessibilityRole="alert">{error}</Text> : null}
            <Button label={busy ? t('Loggar in…') : again ? t('Logga in') : t('Lägg till')} kind="primary" onPress={submit} disabled={busy} style={{ marginTop: 16 }} />
            {onCancel ? <Button label={t('Avbryt')} onPress={onCancel} disabled={busy} style={{ marginTop: 10 }} /> : null}
          </View>
          <Text style={st.help}>{t('Hemma räcker serverns IP-adress. Utanför hemmet behövs en https-adress, t.ex. via BraXhn Relay.')}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20, gap: 16 },
  brand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 6 },
  logo: { width: 44, height: 44, borderRadius: 10 },
  brandText: { color: C.text, fontSize: 24, fontWeight: '800' },
  panel: { backgroundColor: C.bg2, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, padding: 18 },
  h2: { color: C.text, fontSize: 19, fontWeight: '700', marginBottom: 6 },
  label: { color: C.dim, fontSize: 13, marginTop: 12, marginBottom: 5 },
  input: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.line, borderRadius: R.sm, color: C.text, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44 },
  err: { color: C.err, fontSize: 14, marginTop: 12, lineHeight: 20 },
  help: { color: C.dim, fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
