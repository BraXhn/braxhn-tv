// Välj server: visas vid start när flera servrar är sparade, och från Konto → Byt server.
// En ensam sparad server öppnas direkt utan den här sidan (App.tsx).
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, R } from '../theme';
import { removeServer, serverLabel, servers, type Server } from '../api';
import { Button } from '../components/ui';
import * as off from '../offline';

export default function Servers({ onPick, onAdd, onChanged }: { onPick: (sv: Server) => void; onAdd: () => void; onChanged: () => void }) {
  const [asking, setAsking] = useState(''); // servern som "Ta bort?" visas för
  return (
    <SafeAreaView style={st.root}>
      <ScrollView contentContainerStyle={st.scroll}>
        <View style={st.brand}>
          <Image source={require('../../assets/logo.png')} style={st.logo} />
          <Text style={st.brandText}>BraXhn TV</Text>
        </View>
        <Text style={st.h2}>Välj server</Text>
        {servers.map((sv) => (
          <View key={sv.id} style={st.row}>
            <Pressable style={({ pressed }) => [st.pick, pressed && { opacity: 0.7 }]} onPress={() => onPick(sv)} accessibilityRole="button" accessibilityLabel={`Öppna ${serverLabel(sv)} som ${sv.user}`}>
              <View style={st.icon}><Ionicons name="server-outline" size={20} color={C.accent} /></View>
              <View style={{ flex: 1 }}>
                <Text style={st.name} numberOfLines={1}>{serverLabel(sv)}</Text>
                <Text style={st.sub} numberOfLines={1}>{sv.user}{sv.profile && sv.profile !== sv.user ? ` · profil ${sv.profile}` : ''}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={C.dim} />
            </Pressable>
            {asking === sv.id ? (
              <View style={st.confirm}>
                {off.hasServerDownloads(sv.id) ? <Text style={{ color: C.dim, fontSize: 13 }}>Det nedladdade tas också bort.</Text> : null}
                <Button small kind="danger" label="Ta bort" onPress={async () => { off.removeServer(sv.id); await removeServer(sv.id); setAsking(''); onChanged(); }} />
                <Button small label="Avbryt" onPress={() => setAsking('')} />
              </View>
            ) : (
              <Pressable style={st.trash} onPress={() => setAsking(sv.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Ta bort ${serverLabel(sv)}`}>
                <Ionicons name="trash-outline" size={20} color={C.dim} />
              </Pressable>
            )}
          </View>
        ))}
        <Button label="Lägg till server" icon="add" onPress={onAdd} style={{ marginTop: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20, gap: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 10 },
  logo: { width: 44, height: 44, borderRadius: 10 },
  brandText: { color: C.text, fontSize: 24, fontWeight: '800' },
  h2: { color: C.text, fontSize: 19, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.bg2, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, paddingRight: 8 },
  pick: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 64 },
  icon: { width: 38, height: 38, borderRadius: 19, backgroundColor: C.bg3, alignItems: 'center', justifyContent: 'center' },
  name: { color: C.text, fontSize: 16, fontWeight: '700' },
  sub: { color: C.dim, fontSize: 13, marginTop: 2 },
  trash: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  confirm: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, maxWidth: 220 },
});
