// Sidorna i appen och vad de tar emot
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
export type Tab = 'home' | 'search' | 'list' | 'account';
export type Stack = {
  Main: { tab?: Tab } | undefined;
  Library: { id: number; name: string };
  Item: { id: number };
  Player: { id: number; start: number; title?: string };
};
export type Props<T extends keyof Stack> = NativeStackScreenProps<Stack, T>;
