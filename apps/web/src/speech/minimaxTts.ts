import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  getEnvironmentTtsModes,
  getEnvironmentTtsReplies,
  setEnvironmentTtsChatMode,
  synthesizeEnvironmentTts,
} from "@t3tools/client-runtime/voice-input";
import {
  DEFAULT_TTS_SETTINGS,
  type EnvironmentId,
  type TtsAuto,
  type TtsMimeType,
  type TtsReplyRecord,
} from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { runEnvironmentSpeech } from "./runEnvironmentSpeech";

export interface WebAudioState {
  id?: string | undefined;
  threadId?: string | undefined;
  environmentId?: EnvironmentId | undefined;
  title?: string | undefined;
  position: number;
  duration: number;
  playing: boolean;
  ended: boolean;
  error?: string | undefined;
}

const EMPTY_AUDIO_STATE: WebAudioState = {
  position: 0,
  duration: 0,
  playing: false,
  ended: false,
};

function toBytes(base64: string) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

export function clock(value: number) {
  const total = Math.max(0, Math.floor(value || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function createWebPlayer() {
  let state: WebAudioState = EMPTY_AUDIO_STATE;
  let audio: HTMLAudioElement | undefined;
  let url: string | undefined;
  const listeners = new Set<() => void>();

  const emit = (patch: Partial<WebAudioState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const cleanup = () => {
    if (audio) {
      audio.pause();
      audio.onloadedmetadata = null;
      audio.ondurationchange = null;
      audio.ontimeupdate = null;
      audio.onplay = null;
      audio.onpause = null;
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
      audio = undefined;
    }
    if (url) {
      URL.revokeObjectURL(url);
      url = undefined;
    }
  };

  const play = async (input: {
    id: string;
    threadId?: string | undefined;
    environmentId?: EnvironmentId | undefined;
    title?: string | undefined;
    base64: string;
    mimeType: string;
  }) => {
    cleanup();
    const blob = new Blob([toBytes(input.base64)], { type: input.mimeType });
    url = URL.createObjectURL(blob);
    const current = new Audio(url);
    current.preload = "metadata";
    audio = current;
    state = {
      id: input.id,
      threadId: input.threadId,
      environmentId: input.environmentId,
      title: input.title,
      position: 0,
      duration: 0,
      playing: false,
      ended: false,
    };
    for (const listener of listeners) listener();

    const syncDuration = () => {
      if (audio !== current) return;
      if (Number.isFinite(current.duration) && current.duration > 0) {
        emit({ duration: current.duration });
      }
    };

    current.onloadedmetadata = syncDuration;
    current.ondurationchange = syncDuration;
    current.ontimeupdate = () => {
      if (audio !== current) return;
      emit({
        position: current.currentTime || 0,
        duration:
          Number.isFinite(current.duration) && current.duration > 0
            ? current.duration
            : state.duration,
      });
    };
    current.onplay = () => {
      if (audio !== current) return;
      emit({ playing: true, ended: false, error: undefined });
    };
    current.onpause = () => {
      if (audio !== current || current.ended) return;
      emit({ playing: false });
    };
    current.onended = () => {
      if (audio !== current) return;
      const end =
        Number.isFinite(current.duration) && current.duration > 0
          ? current.duration
          : current.currentTime || state.duration;
      emit({ position: end, duration: end, playing: false, ended: true });
    };
    current.onerror = () => {
      if (audio !== current) return;
      emit({ playing: false, error: "Audio playback failed" });
    };

    await current.play();
  };

  const toggle = async () => {
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (state.ended) audio.currentTime = 0;
    await audio.play();
  };

  const seek = async (position: number) => {
    if (!audio) return;
    const max = state.duration > 0 ? state.duration : position;
    const next = Math.max(0, Math.min(position, max));
    audio.currentTime = next;
    emit({ position: next, ended: false });
  };

  const dispose = () => {
    cleanup();
    state = EMPTY_AUDIO_STATE;
    for (const listener of listeners) listener();
  };

  return {
    play,
    toggle,
    seek,
    dispose,
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const webPlayer = createWebPlayer();

export function useWebPlayer() {
  return useSyncExternalStore(webPlayer.subscribe, webPlayer.snapshot, webPlayer.snapshot);
}

export interface ModesState {
  auto: TtsAuto;
  chats: Record<string, TtsAuto>;
  loaded: boolean;
}

const DEFAULT_MODES_STATE: ModesState = {
  auto: DEFAULT_TTS_SETTINGS.auto,
  chats: {},
  loaded: false,
};

let modesState: ModesState = DEFAULT_MODES_STATE;
const modesByEnv = new Map<EnvironmentId, ModesState>();
const modesInflightByEnv = new Map<EnvironmentId, Promise<ModesState>>();
const modesListeners = new Set<() => void>();

function emitModes(environmentId: EnvironmentId, next: ModesState) {
  modesState = next;
  modesByEnv.set(environmentId, next);
  for (const listener of modesListeners) listener();
}

export const ttsModes = {
  snapshot: (environmentId?: EnvironmentId | null) =>
    (environmentId ? modesByEnv.get(environmentId) : undefined) ?? modesState,
  subscribe: (listener: () => void) => {
    modesListeners.add(listener);
    return () => modesListeners.delete(listener);
  },
  refresh: (prepared: PreparedConnection) => {
    const existing = modesInflightByEnv.get(prepared.environmentId);
    if (existing) return existing;
    const inflight = runEnvironmentSpeech(getEnvironmentTtsModes(prepared))
      .then((res) => {
        const next: ModesState = {
          auto: res.auto,
          chats: res.chats,
          loaded: true,
        };
        emitModes(prepared.environmentId, next);
        return next;
      })
      .finally(() => {
        modesInflightByEnv.delete(prepared.environmentId);
      });
    modesInflightByEnv.set(prepared.environmentId, inflight);
    return inflight;
  },
  setChat: async (prepared: PreparedConnection, threadId: string, mode: TtsAuto | null) => {
    const res = await runEnvironmentSpeech(setEnvironmentTtsChatMode(prepared, { threadId, mode }));
    const next: ModesState = {
      auto: res.auto,
      chats: res.chats,
      loaded: true,
    };
    emitModes(prepared.environmentId, next);
    return next;
  },
};

export function useTtsModes(prepared: PreparedConnection | null) {
  const envId = prepared?.environmentId;
  const state = useSyncExternalStore(
    ttsModes.subscribe,
    () => ttsModes.snapshot(envId),
    () => ttsModes.snapshot(envId),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- primes the external ttsModes store from the environment HTTP endpoint when the connection changes
  useEffect(() => {
    if (!prepared) return;
    if (!modesByEnv.get(prepared.environmentId)?.loaded) {
      void ttsModes.refresh(prepared).catch(() => undefined);
    }
  }, [prepared]);
  return state;
}

export interface AutoPlayer {
  snapshot: () => {
    id?: string | undefined;
    threadId?: string | undefined;
    playing: boolean;
    ended: boolean;
    error?: string | undefined;
  };
  subscribe: (listener: () => void) => () => void;
  play: (input: {
    id: string;
    threadId?: string | undefined;
    environmentId?: EnvironmentId | undefined;
    title?: string | undefined;
    base64: string;
    mimeType: string;
  }) => Promise<void>;
}

export function startAutoplay(input: {
  listReplies: () => Promise<{ items: ReadonlyArray<TtsReplyRecord> }>;
  synthesize: (
    id: string,
    threadId?: string,
    text?: string,
  ) => Promise<{ base64: string; mimeType: TtsMimeType }>;
  player: AutoPlayer;
  environmentId?: EnvironmentId | undefined;
  intervalMs?: number | undefined;
}) {
  const seen = new Set<string>();
  const queue: TtsReplyRecord[] = [];
  let primed = false;
  let polling = false;
  let working = false;
  let activeChatId: string | undefined;
  let closed = false;
  let epoch = 0;

  const pump = async () => {
    if (closed || working) return;
    const current = input.player.snapshot();
    if (current.id && !current.ended && !current.error) return;
    const next = queue.shift();
    if (!next) return;
    working = true;
    activeChatId = next.threadId;
    const token = epoch;
    try {
      const audio = await input.synthesize(next.id, next.threadId, next.text);
      if (closed || token !== epoch) return;
      const latest = input.player.snapshot();
      if (latest.id && !latest.ended && !latest.error) {
        queue.unshift(next);
        return;
      }
      await input.player.play({
        id: next.id,
        threadId: next.threadId,
        environmentId: input.environmentId,
        title: next.title,
        base64: audio.base64,
        mimeType: audio.mimeType,
      });
    } catch {
      // Ignore background autoplay errors so a transient failure does not wedge the queue.
    } finally {
      working = false;
      activeChatId = undefined;
      if (!closed) {
        const after = input.player.snapshot();
        if ((!after.id || after.ended || after.error) && queue.length > 0) {
          void pump();
        }
      }
    }
  };

  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const res = await input.listReplies();
      if (closed) return;
      if (!primed) {
        for (const item of res.items) seen.add(item.id);
        primed = true;
        return;
      }
      const fresh = [...res.items].reverse().filter((item) => !seen.has(item.id));
      for (const item of fresh) {
        seen.add(item.id);
        if (item.auto === "play") queue.push(item);
      }
      await pump();
    } catch {
      // Ignore transient poll errors.
    } finally {
      polling = false;
    }
  };

  const unsub = input.player.subscribe(() => {
    const state = input.player.snapshot();
    if ((!state.id || state.ended || state.error) && queue.length > 0) {
      void pump();
    }
  });

  void poll();
  const timer = setInterval(() => {
    void poll();
  }, input.intervalMs ?? 1_500);

  return {
    clear: () => {
      epoch += 1;
      queue.length = 0;
    },
    dropChat: (threadId: string) => {
      if (activeChatId === threadId) epoch += 1;
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index]?.threadId === threadId) {
          queue.splice(index, 1);
        }
      }
    },
    stop: () => {
      closed = true;
      epoch += 1;
      queue.length = 0;
      clearInterval(timer);
      unsub();
    },
  };
}

export interface ThreadSource {
  snapshot: () => ReadonlySet<string>;
  subscribe: (listener: () => void) => () => void;
}

export function watchGoneChats(input: {
  chats: ThreadSource;
  player: {
    snapshot: () => { threadId?: string | undefined };
    dispose: () => void;
  };
  dropChat: (threadId: string) => void;
}) {
  let prev = new Set(input.chats.snapshot());

  const sync = () => {
    const next = input.chats.snapshot();
    for (const id of prev) {
      if (next.has(id)) continue;
      input.dropChat(id);
      if (input.player.snapshot().threadId === id) {
        input.player.dispose();
      }
    }
    prev = new Set(next);
  };

  return input.chats.subscribe(sync);
}

const activeAutoplays = new Map<EnvironmentId, ReturnType<typeof startAutoplay>>();

export function clearMinimaxAutoplayQueue() {
  for (const auto of activeAutoplays.values()) {
    auto.clear();
  }
}

function dropMinimaxChatAudio(threadId: string) {
  for (const auto of activeAutoplays.values()) {
    auto.dropChat(threadId);
  }
  if (webPlayer.snapshot().threadId === threadId) {
    webPlayer.dispose();
  }
}

export function useMinimaxAutoplay(
  preparedOrList: PreparedConnection | ReadonlyArray<PreparedConnection> | null,
  activeThreadIds: ReadonlySet<string>,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- manages background autoplay polling timers across all connected environments while mounted
  useEffect(() => {
    const connections = Array.isArray(preparedOrList)
      ? preparedOrList
      : preparedOrList
        ? [preparedOrList as PreparedConnection]
        : [];
    const nextIds = new Set(connections.map((conn) => conn.environmentId));
    for (const [envId, auto] of activeAutoplays) {
      if (!nextIds.has(envId)) {
        auto.stop();
        activeAutoplays.delete(envId);
      }
    }
    for (const conn of connections) {
      if (activeAutoplays.has(conn.environmentId)) continue;
      const auto = startAutoplay({
        environmentId: conn.environmentId,
        listReplies: () => runEnvironmentSpeech(getEnvironmentTtsReplies(conn)),
        synthesize: (id, threadId, text) =>
          runEnvironmentSpeech(
            synthesizeEnvironmentTts(conn, {
              id,
              ...(threadId ? { threadId } : {}),
              ...(text ? { text } : {}),
            }),
          ),
        player: webPlayer,
      });
      activeAutoplays.set(conn.environmentId, auto);
    }
  }, [preparedOrList]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cleans up all active autoplay pollers when the sidebar unmounts
  useEffect(
    () => () => {
      for (const auto of activeAutoplays.values()) {
        auto.stop();
      }
      activeAutoplays.clear();
    },
    [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops external HTMLAudioElement and autoplay queue when the playing thread is archived or deleted
  useEffect(() => {
    const currentId = webPlayer.snapshot().threadId;
    if (currentId && activeThreadIds.size > 0 && !activeThreadIds.has(currentId)) {
      dropMinimaxChatAudio(currentId);
    }
  }, [activeThreadIds]);
}
