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
  // Nedladdat (fungerar utan nät)
  Downloads: undefined;
  // Feedback och felrapporter (från Konto och från spelaren vid ett fel) och Mina ärenden
  Feedback: { kind?: 'idea' | 'bug'; area?: string } | undefined;
  Tickets: undefined;
};
export type Props<T extends keyof Stack> = NativeStackScreenProps<Stack, T>;
