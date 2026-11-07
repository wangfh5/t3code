import type { TtsReplyRecord } from "@t3tools/contracts";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { clock, startAutoplay, watchGoneChats } from "./minimaxTts";

afterEach(() => {
  vi.useRealTimers();
});

describe("clock", () => {
  test("formats seconds into m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(9)).toBe("0:09");
    expect(clock(65.8)).toBe("1:05");
  });
});

describe("startAutoplay", () => {
  test("queues newly completed auto=play replies without replaying initial history", async () => {
    vi.useFakeTimers();
    let items: TtsReplyRecord[] = [
      {
        id: "old-1",
        threadId: "thread-1",
        title: "Old chat",
        text: "Old text",
        createdAt: "2026-01-01T00:00:00.000Z",
        auto: "play",
      },
    ];
    const played: string[] = [];
    const listeners = new Set<() => void>();
    let state: {
      id?: string | undefined;
      threadId?: string | undefined;
      playing: boolean;
      ended: boolean;
      error?: string | undefined;
    } = {
      playing: false,
      ended: false,
    };

    const emit = (patch: Partial<typeof state>) => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    };

    const auto = startAutoplay({
      intervalMs: 20,
      listReplies: async () => ({ items }),
      synthesize: async (id) => ({
        base64: Buffer.from(`audio-${id}`).toString("base64"),
        mimeType: "audio/mpeg",
      }),
      player: {
        snapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        play: async (input) => {
          played.push(input.id);
          emit({
            id: input.id,
            threadId: input.threadId,
            playing: true,
            ended: false,
            error: undefined,
          });
        },
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(35);
      expect(played).toEqual([]);

      items = [
        {
          id: "new-3",
          threadId: "thread-1",
          title: "Chat",
          text: "Third",
          createdAt: "2026-01-01T00:00:03.000Z",
          auto: "play",
        },
        {
          id: "new-2",
          threadId: "thread-1",
          title: "Chat",
          text: "Second",
          createdAt: "2026-01-01T00:00:02.000Z",
          auto: "synthesize",
        },
        {
          id: "new-1",
          threadId: "thread-1",
          title: "Chat",
          text: "First",
          createdAt: "2026-01-01T00:00:01.000Z",
          auto: "play",
        },
        ...items,
      ];

      await vi.advanceTimersByTimeAsync(50);
      expect(played).toEqual(["new-1"]);

      // Paused audio holds the queue.
      emit({ playing: false });
      await vi.advanceTimersByTimeAsync(35);
      expect(played).toEqual(["new-1"]);

      // Ended audio advances the queue.
      emit({ playing: false, ended: true });
      await vi.advanceTimersByTimeAsync(35);
      expect(played).toEqual(["new-1", "new-3"]);
    } finally {
      auto.stop();
    }
  });
});

describe("watchGoneChats", () => {
  test("stops active playback and drops queued replies when a thread is archived or deleted", () => {
    let active = new Set(["thread-1", "thread-2"]);
    const listeners = new Set<() => void>();
    const dropped: string[] = [];
    let currentThreadId: string | undefined = "thread-1";
    let disposed = 0;

    const stop = watchGoneChats({
      chats: {
        snapshot: () => active,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      player: {
        snapshot: () => ({ threadId: currentThreadId }),
        dispose: () => {
          disposed += 1;
          currentThreadId = undefined;
        },
      },
      dropChat: (threadId) => {
        dropped.push(threadId);
      },
    });

    try {
      active = new Set(["thread-2"]);
      for (const listener of listeners) listener();

      expect(dropped).toEqual(["thread-1"]);
      expect(disposed).toBe(1);
    } finally {
      stop();
    }
  });
});
