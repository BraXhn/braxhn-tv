// Ett bibliotek: alla titlar som rutnät, sorterade efter titel, tillagd eller år (som webbappens bibliotekssida).
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R } from '../theme';
import { api, ensureImageToken, type MediaItem } from '../api';
import { ErrorState, Loading, Empty } from '../components/ui';
import { Grid } from './Main';
import type { Props } from '../nav';
import { t } from '../i18n';

const SORTS = ['title', 'added', 'year'] as const;
const sortLabel = (k: (typeof SORTS)[number]) => (k === 'title' ? t('Titel') : k === 'added' ? t('Senast tillagt') : t('År'));

export default function LibraryScreen({ navigation, route }: Props<'Library'>) {
  const insets = useSafeAreaInsets();
  const [sort, setSort] = useState<(typeof SORTS)[number]>('title');
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setItems(null);
    try { await ensureImageToken(); const r = await api<{ items: MediaItem[] }>(`/api/libraries/${route.params.id}/items?sort=${sort}`); setItems(r.items); setError(''); }
    catch (e: any) { setError(e?.message || t('Kunde inte hämta biblioteket')); }
  }, [route.params.id, sort]);
  useEffect(() => { load(); }, [load]);
  return (
    <View style={[st.root, { paddingTop: insets.top }]}>
      <View style={st.top}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('Tillbaka')} style={st.back}><Ionicons name="chevron-back" size={24} color={C.text} /></Pressable>
        <Text style={st.title} numberOfLines={1}>{route.params.name}</Text>
      </View>
      <View style={st.body}>
        <View style={st.sorts}>
          {SORTS.map((k) => (
            <Pressable key={k} onPress={() => setSort(k)} style={[st.chip, sort === k && st.chipOn]} accessibilityRole="button" accessibilityState={{ selected: sort === k }}>
              <Text style={[st.chipText, sort === k && { color: C.accent }]}>{sortLabel(k)}</Text>
            </Pressable>
          ))}
        </View>
        {error ? <ErrorState error={error} onRetry={load} /> : !items ? <Loading /> : !items.length ? <Empty text={t('Biblioteket är tomt.')} />
          : <Grid items={items} open={(it) => navigation.push('Item', { id: it.id })} />}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.chrome },
  top: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,.4)' },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { color: C.text, fontSize: 17, fontWeight: '700', flex: 1 },
  body: { flex: 1, backgroundColor: C.bg },
  sorts: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 10 },
  chip: { height: 34, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.bg2, justifyContent: 'center' },
  chipOn: { backgroundColor: C.bg3 },
  chipText: { color: C.dim, fontSize: 14, fontWeight: '600' },
});
