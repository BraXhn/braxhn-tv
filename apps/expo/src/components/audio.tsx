// Delar till musik, ljudböcker och poddar: omslag, låtrader, albumkort, sidhuvud och minispelaren (som webbens #mbar).
import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { C, R } from '../theme';
import { fmtTime, imageFailed } from '../api';
import { bookCoverUrl, chapterAt, coverUrl, currentTrack, enqueue, next, playNext, podImageUrl, toggle, useNowPlaying, useNowPlayingPart, type Album, type Track } from '../music';
import { useImageToken } from './ui';
import type { Stack } from '../nav';
import { t } from '../i18n';

/** Omslag (album, bok eller podd) med en ikon som reserv när bilden saknas */
export function Cover({ uri, size, icon = 'musical-notes', round, style }: { uri?: string | null; size: number; icon?: keyof typeof Ionicons.glyphMap; round?: boolean; style?: StyleProp<ViewStyle> }) {
  useImageToken();
  const [bad, setBad] = useState('');
  return (
    <View style={[{ width: size, height: size, borderRadius: round ? size / 2 : R.art, backgroundColor: C.bg3, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, style]}>
      {uri && bad !== uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} onError={() => { setBad(uri); imageFailed(uri); }} />
        : <Ionicons name={icon} size={Math.max(16, size * 0.38)} color={C.dim} />}
    </View>
  );
}
export const albumCover = (a: { id?: number; albumId?: number | null; cover?: boolean }, w = 300) => {
  const id = a.albumId ?? a.id;
  return a.cover && id ? coverUrl(id, w) : null;
};

export function AlbumCard({ a, width, onPress }: { a: Album; width: number; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ width }, pressed && { opacity: 0.75 }]} accessibilityRole="button" accessibilityLabel={`${a.title}, ${a.artist || ''}`}>
      <Cover uri={a.cover ? coverUrl(a.id, 300) : null} size={width} icon="disc-outline" />
      <Text style={s.cardT} numberOfLines={2}>{a.title}</Text>
      <Text style={s.cardS} numberOfLines={1}>{[a.artist, a.year].filter(Boolean).join(' · ')}</Text>
    </Pressable>
  );
}

/** Låtrad: tryck spelar listan från den här låten, ⋮ ger Spela härnäst / Lägg i kön / albumet / artisten */
export function TrackRow({ t: tr, i, onPress, showCover, numbered }: { t: Track; i: number; onPress: () => void; showCover?: boolean; numbered?: boolean }) {
  // Bara den här radens läge: spelas (1), pausad (-1) eller inte den här låten (0)
  const here = useNowPlayingPart((x) => (x.mode === 'music' && x.queue[x.idx]?.id === tr.id ? (x.playing ? 1 : -1) : 0));
  const nav = useNavigation<NavigationProp<Stack>>();
  const [menu, setMenu] = useState(false);
  const on = here !== 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.bg2 }]} accessibilityRole="button" accessibilityLabel={t('Spela {title}', { title: tr.title })}>
      {showCover ? <Cover uri={albumCover(tr, 120)} size={44} />
        : <View style={s.num}>{on ? <Ionicons name={here > 0 ? 'volume-high' : 'pause'} size={16} color={C.accent} /> : <Text style={s.numT}>{numbered ? tr.track || i + 1 : i + 1}</Text>}</View>}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.rowT, on && { color: C.accent }]} numberOfLines={1}>{tr.title}</Text>
        <Text style={s.rowS} numberOfLines={1}>{[tr.artist, showCover ? tr.album : null].filter(Boolean).join(' · ')}</Text>
      </View>
      {tr.favorite ? <Ionicons name="heart" size={14} color={C.accent} /> : null}
      <Text style={s.rowD}>{tr.duration ? fmtTime(tr.duration) : ''}</Text>
      <Pressable onPress={() => setMenu(true)} hitSlop={8} style={s.more} accessibilityRole="button" accessibilityLabel={t('Mer för {title}', { title: tr.title })}>
        <Ionicons name="ellipsis-vertical" size={18} color={C.dim} />
      </Pressable>
      <Sheet visible={menu} onClose={() => setMenu(false)} title={tr.title} items={[
        { icon: 'play-forward-outline', label: t('Spela härnäst'), onPress: () => playNext([tr]) },
        { icon: 'list-outline', label: t('Lägg sist i kön'), onPress: () => enqueue([tr]) },
        ...(tr.albumId ? [{ icon: 'disc-outline' as const, label: t('Gå till albumet'), onPress: () => nav.navigate('Album', { id: tr.albumId! }) }] : []),
        ...(tr.artistId ? [{ icon: 'person-outline' as const, label: t('Gå till artisten'), onPress: () => nav.navigate('Artist', { id: tr.artistId! }) }] : []),
      ]} />
    </Pressable>
  );
}

/** Enkel meny nerifrån (som webbens ⋮-meny på en telefon) */
export function Sheet({ visible, onClose, title, items }: { visible: boolean; onClose: () => void; title: string; items: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; on?: boolean }[] }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel={t('Stäng menyn')}>
        <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Text style={s.sheetT} numberOfLines={1}>{title}</Text>
          {items.map((x) => (
            <Pressable key={x.label} onPress={() => { onClose(); x.onPress(); }} style={({ pressed }) => [s.sheetRow, pressed && { backgroundColor: C.bg3 }]} accessibilityRole="menuitem">
              <Ionicons name={x.icon} size={20} color={x.on ? C.accent : C.text} />
              <Text style={[s.sheetL, x.on && { color: C.accent }]}>{x.label}</Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

/** Sidhuvud med tillbaka-knapp (som Library och Item) */
export function Header({ title, onBack, right }: { title: string; onBack: () => void; right?: React.ReactNode }) {
  return (
    <View style={s.top}>
      <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('Tillbaka')} style={s.back}><Ionicons name="chevron-back" size={24} color={C.text} /></Pressable>
      <Text style={s.topT} numberOfLines={1}>{title}</Text>
      {right}
    </View>
  );
}

/** Minispelaren ovanför flikraden (eller längst ner på en undersida): omslag, titel, spela/pausa och nästa */
export function MiniPlayer({ bottomInset = 0 }: { bottomInset?: number }) {
  const np = useNowPlaying();
  const nav = useNavigation<NavigationProp<Stack>>();
  if (!np.mode) return null;
  const cur = currentTrack();
  const title = np.mode === 'music' ? cur?.title || '' : np.mode === 'book' ? np.book?.title || '' : np.episode?.title || '';
  const sub = np.mode === 'music' ? [cur?.artist, cur?.album].filter(Boolean).join(' · ') : np.mode === 'book' ? chapterAt(np.pos)?.title || np.book?.author || '' : np.episode?.podcastTitle || '';
  const uri = np.mode === 'music' ? (cur ? albumCover(cur, 120) : null) : np.mode === 'book' ? (np.book?.cover ? bookCoverUrl(np.book.id, 120) : null) : np.episode ? podImageUrl(np.episode.podcast, 120) : null;
  const frac = np.dur > 0 ? Math.min(1, np.pos / np.dur) : 0;
  return (
    <View style={[s.mini, { paddingBottom: bottomInset }]}>
      <View style={s.miniBar}><View style={[s.miniFill, { width: `${frac * 100}%` }]} /></View>
      <View style={s.miniRow}>
        <Pressable style={s.miniLeft} onPress={() => nav.navigate('NowPlaying')} accessibilityRole="button" accessibilityLabel={t('Öppna spelaren: {title}', { title })}>
          <Cover uri={uri} size={42} icon={np.mode === 'book' ? 'book' : np.mode === 'podcast' ? 'mic' : 'musical-notes'} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.miniT} numberOfLines={1}>{title}</Text>
            <Text style={[s.miniS, (np.error || np.stopped) ? { color: C.err } : null]} numberOfLines={1}>{np.stopped || np.error || sub}</Text>
          </View>
        </Pressable>
        <Pressable onPress={toggle} style={s.miniBtn} accessibilityRole="button" accessibilityLabel={np.playing ? t('Pausa') : t('Spela')}>
          {np.buffering ? <ActivityIndicator color={C.text} /> : <Ionicons name={np.playing ? 'pause' : 'play'} size={26} color={C.text} />}
        </Pressable>
        <Pressable onPress={next} style={s.miniBtn} accessibilityRole="button" accessibilityLabel={np.mode === 'music' ? t('Nästa låt') : t('Framåt 30 sekunder')}>
          <Ionicons name={np.mode === 'music' ? 'play-skip-forward' : 'play-forward'} size={22} color={C.text} />
        </Pressable>
      </View>
    </View>
  );
}

export const s = StyleSheet.create({
  cardT: { marginTop: 6, color: C.text, fontSize: 13, fontWeight: '700', lineHeight: 17 },
  cardS: { color: C.dim, fontSize: 12.5, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, paddingVertical: 6 },
  num: { width: 24, alignItems: 'center' },
  numT: { color: C.dim, fontSize: 14 },
  rowT: { color: C.text, fontSize: 15, fontWeight: '600' },
  rowS: { color: C.dim, fontSize: 13, marginTop: 2 },
  rowD: { color: C.dim, fontSize: 13, fontVariant: ['tabular-nums'] },
  more: { width: 32, height: 40, alignItems: 'center', justifyContent: 'center' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.bg2, borderTopLeftRadius: R.lg, borderTopRightRadius: R.lg, paddingTop: 10, borderTopWidth: 1, borderColor: C.line },
  sheetT: { color: C.dim, fontSize: 13, paddingHorizontal: 18, paddingVertical: 8 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 50, paddingHorizontal: 18 },
  sheetL: { color: C.text, fontSize: 16 },
  top: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,.4)', backgroundColor: C.chrome },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  topT: { color: C.text, fontSize: 17, fontWeight: '700', flex: 1 },
  mini: { backgroundColor: 'rgba(30,31,34,.98)', borderTopWidth: 1, borderTopColor: C.line },
  miniBar: { height: 2, backgroundColor: 'rgba(255,255,255,.08)' },
  miniFill: { height: 2, backgroundColor: C.accent },
  miniRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 10, paddingRight: 4, height: 60 },
  miniLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0, height: 60 },
  miniT: { color: C.text, fontSize: 14.5, fontWeight: '700' },
  miniS: { color: C.dim, fontSize: 12.5, marginTop: 2 },
  miniBtn: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
});
