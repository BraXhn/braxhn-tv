// Sidorna i appen och vad de tar emot
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
export type Tab = 'home' | 'search' | 'music' | 'list' | 'account';
export type Stack = {
  Main: { tab?: Tab } | undefined;
  Library: { id: number; name: string };
  Item: { id: number };
  Player: { id: number; start: number; title?: string };
  // Musik, ljudböcker och poddar
  Album: { id: number };
  Artist: { id: number };
  Playlist: { id: number; lib?: number; smart?: string; name?: string };
  Book: { id: number };
  Podcast: { id: number };
  NowPlaying: undefined;
};
export type Props<T extends keyof Stack> = NativeStackScreenProps<Stack, T>;
