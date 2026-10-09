import type { Hold, Timeline } from '@als/composition';
import type { PlayerRef } from '@remotion/player';
import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { EditorActions, EditorState, EditorStore } from './store.ts';

const StoreContext = createContext<EditorStore | null>(null);

export function EditorProvider({ store, children }: { store: EditorStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useEditorStore(): EditorStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useEditor outside <EditorProvider>');
  return store;
}

/** Subscribes to one slice of editor state. Select stable values, not new objects. */
export function useEditor<T>(selector: (state: EditorState & EditorActions) => T): T {
  return useStore(useEditorStore(), selector);
}

/** Playback shared by the Player, timeline and panels. */
export interface Playback {
  player: RefObject<PlayerRef | null>;
  timeline: Timeline;
  fps: number;
  frame: number;
  playing: boolean;
  seek: (frame: number) => void;
  pause: () => void;
  /** Pause on a moment's hold, where its card is fully in. */
  goToMoment: (id: string) => void;
  /** The hold the playhead is paused on, if any: the card that can be edited. */
  editableHold: Hold | undefined;
}

const PlaybackContext = createContext<Playback | null>(null);
export const PlaybackProvider = PlaybackContext.Provider;

export function usePlayback(): Playback {
  const playback = useContext(PlaybackContext);
  if (!playback) throw new Error('usePlayback outside <PlaybackProvider>');
  return playback;
}
