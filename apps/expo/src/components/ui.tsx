// Gemensamma delar: knappar, kort, hyllor och tomma lägen – med webbappens utseende (web/style.css).
import React, { useSyncExternalStore } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { C, R, TOUCH } from '../theme';
import { imageFailed, imageToken, imageUrl, sxe, type MediaItem } from '../api';
import { t, tn } from '../i18n';

export function Button({ label, onPress, onPressIn, kind = 'ghost', icon, disabled, style, small }: {
  label: string; onPress?: () => void; onPressIn?: () => void; kind?: 'primary' | 'ghost' | 'danger';
  icon?: keyof typeof Ionicons.glyphMap; disabled?: boolean; style?: StyleProp<ViewStyle>; small?: boolean;
}) {
  const fg = kind === 'primary' ? C.onAccent : kind === 'danger' ? C.err : C.text;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} onPressIn={onPressIn}
      style={({ pressed }) => [s.btn, small && s.btnSmall, kind === 'primary' && s.btnPrimary, pressed && (kind === 'primary' ? s.btnPrimaryDown : s.btnDown), disabled && { opacity: 0.5 }, style]}>
      {icon ? <Ionicons name={icon} size={small ? 15 : 17} color={fg} /> : null}
      <Text style={[s.btnText, { color: fg }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** Ritar om när bildtoken byts (ny profil, förnyad eller utknuffad token) */
export const useImageToken = () => useSyncExternalStore(imageToken.subscribe, imageToken.version, imageToken.version);

/** Bilden till ett kort: affisch (2:3) eller stillbild (16:9), med titeln som reserv när bilden saknas */
export function Art({ it, land, width }: { it: MediaItem; land?: boolean; width: number }) {
  const ep = it.kind === 'episode';
  const id = land ? it.id : ep && it.show ? it.show : it.id;
  const has = land ? it.thumb : ep ? it.showPoster : it.poster;
  const done = it.duration && it.position ? Math.min(1, it.position / it.duration) : 0;
  useImageToken();
  const uri = imageUrl(id, land ? 'thumb' : 'poster', land ? 480 : 300);
  return (
    <View style={[s.art, { width, aspectRatio: land ? 16 / 9 : 2 / 3 }]}>
      {has ? <Image source={{ uri }} onError={() => imageFailed(uri)} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} recyclingKey={`${id}-${land ? 't' : 'p'}`} />
        : <View style={s.ph}><Text style={s.phText} numberOfLines={3}>{ep ? it.showTitle || it.title : it.title}</Text></View>}
      {it.watched ? <View style={s.seen}><Ionicons name="checkmark" size={13} color={C.accent} /></View> : null}
      {done > 0 && !it.watched ? <View style={s.barBg}><View style={[s.barFill, { width: `${done * 100}%` }]} /></View> : null}
    </View>
  );
}

export function Card({ it, width, onPress, land }: { it: MediaItem; width: number; onPress: () => void; land?: boolean }) {
  const ep = it.kind === 'episode';
  const title = ep ? it.showTitle || it.title : it.title;
  const sub = ep ? [it.title, sxe(it)].filter(Boolean) : [it.year ? String(it.year) : it.kind === 'show' && it.episodes ? tn(it.episodes, '1 avsnitt', '{n} avsnitt') : ''];
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title} style={({ pressed }) => [{ width }, pressed && { opacity: 0.75 }]}>
      <Art it={it} land={land} width={width} />
      <Text style={s.cardT} numberOfLines={2}>{title}</Text>
      {sub.filter(Boolean).map((x, i) => <Text key={i} style={s.cardS} numberOfLines={1}>{x}</Text>)}
    </Pressable>
  );
}

export function Shelf({ title, items, onOpen, cardW = 125, action }: { title: string; items: MediaItem[]; onOpen: (it: MediaItem) => void; cardW?: number; action?: { label: string; onPress: () => void } }) {
  if (!items.length) return null;
  return (
    <View style={s.shelfWrap}>
      <View style={s.shelfHead}>
        <Text style={s.h2} numberOfLines={1}>{title}</Text>
        {action ? <Pressable onPress={action.onPress} hitSlop={10}><Text style={s.shelfMore}>{action.label}</Text></Pressable> : null}
      </View>
      <FlatList horizontal data={items} keyExtractor={(x) => String(x.id)} showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, gap: 14 }} initialNumToRender={5} windowSize={5}
        renderItem={({ item }) => <Card it={item} width={cardW} onPress={() => onOpen(item)} />} />
    </View>
  );
}

export const Loading = () => <View style={s.center}><ActivityIndicator color={C.accent} size="large" /></View>;
export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <View style={s.center}>
      <Ionicons name="cloud-offline-outline" size={36} color={C.dim} />
      <Text style={s.errText}>{error}</Text>
      {onRetry ? <Button label={t('Försök igen')} kind="primary" onPress={onRetry} /> : null}
    </View>
  );
}
export const Empty = ({ text }: { text: string }) => <View style={s.center}><Text style={s.dim}>{text}</Text></View>;

export const s = StyleSheet.create({
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: TOUCH, paddingHorizontal: 16, paddingVertical: 9, borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: 'transparent' },
  btnSmall: { minHeight: 34, paddingHorizontal: 10, paddingVertical: 5 },
  btnPrimary: { backgroundColor: C.accent, borderColor: C.accent },
  btnPrimaryDown: { backgroundColor: C.accent2, borderColor: C.accent2 },
  btnDown: { borderColor: C.dim },
  btnText: { fontSize: 15, fontWeight: '600' },
  art: { borderRadius: R.art, overflow: 'hidden', backgroundColor: C.bg3 },
  ph: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8 },
  phText: { color: C.dim, fontSize: 13, textAlign: 'center' },
  seen: { position: 'absolute', top: 0, right: 0, width: 22, height: 21, backgroundColor: 'rgba(10,10,12,.85)', borderBottomLeftRadius: 4, alignItems: 'center', justifyContent: 'center' },
  barBg: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, backgroundColor: 'rgba(0,0,0,.6)' },
  barFill: { height: 4, backgroundColor: C.accent },
  cardT: { marginTop: 6, color: C.text, fontSize: 13, fontWeight: '700', lineHeight: 17 },
  cardS: { color: C.dim, fontSize: 12.5, lineHeight: 17 },
  shelfWrap: { marginTop: 22 },
  shelfHead: { flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingHorizontal: 14, marginBottom: 10 },
  h2: { color: C.text, fontSize: 19, fontWeight: '700', flexShrink: 1 },
  shelfMore: { color: C.dim, fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  errText: { color: C.text, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  dim: { color: C.dim, fontSize: 14, textAlign: 'center' },
});
