// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DEFAULT_TTS_SETTINGS } from "@t3tools/contracts";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  audioCache,
  createMinimaxTtsRuntime,
  finalReply,
  mp3Frames,
  renderSpeech,
  settingsStore,
  splitText,
} from "./MinimaxTts.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finalReply", () => {
  test("reads only the final assistant reply of a completed turn", () => {
    expect(
      finalReply({
        outcome: { status: "completed" },
        timeline: [
          {
            kind: "user_message",
            item: { type: "user_message", text: "first" },
          },
          {
            kind: "CanonicalItem",
            item: { type: "assistant_message", text: "draft" },
          },
          {
            kind: "CanonicalItem",
            item: { type: "assistant_message", text: "  final answer  " },
          },
        ],
      }),
    ).toBe("final answer");

    expect(
      finalReply({
        outcome: { status: "failed" },
        timeline: [
          {
            kind: "CanonicalItem",
            item: { type: "assistant_message", text: "ignored" },
          },
        ],
      }),
    ).toBe("");
  });
});

describe("splitText", () => {
  test("splits long text along natural boundaries", () => {
    const chunk = `${"今天天气不错，我们去散步吧。".repeat(120)}\n\n${"第二段内容继续展开。".repeat(120)}`;
    const parts = splitText(chunk);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((item) => item.length <= 2_000)).toBe(true);
  });
});

describe("mp3Frames", () => {
  test("strips leading ID3v2 and Xing header frames when joining chunks", () => {
    const id3 = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 1, 2, 3, 4,
    ]);
    const xing = new Uint8Array(417);
    xing.set([0xff, 0xfb, 0x90, 0xc4], 0);
    xing.set([0x58, 0x69, 0x6e, 0x67], 21);
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0xc4, 9, 8, 7, 6]);
    const full = new Uint8Array(id3.byteLength + xing.byteLength + audio.byteLength);
    full.set(id3, 0);
    full.set(xing, id3.byteLength);
    full.set(audio, id3.byteLength + xing.byteLength);

    expect(Array.from(mp3Frames(full))).toEqual(Array.from(audio));
  });
});

describe("renderSpeech", () => {
  test("calls MiniMax t2a_v2 and decodes hex audio", async () => {
    const seen: Array<{ url: string; body: unknown; auth: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")),
          auth: headers.get("Authorization"),
        });
        return new Response(
          JSON.stringify({
            data: { audio: Buffer.from("mp3-bytes").toString("hex") },
            base_resp: { status_code: 0, status_msg: "ok" },
          }),
          { status: 200 },
        );
      }),
    );

    const bytes = await renderSpeech({
      text: "你好，世界",
      settings: {
        ...DEFAULT_TTS_SETTINGS,
        apiKey: "secret-key",
        chats: {},
      },
    });

    expect(Buffer.from(bytes).toString("utf8")).toBe("mp3-bytes");
    expect(seen).toEqual([
      {
        url: "https://api.minimaxi.com/v1/t2a_v2",
        auth: "Bearer secret-key",
        body: {
          model: DEFAULT_TTS_SETTINGS.model,
          text: "你好，世界",
          stream: false,
          voice_setting: {
            voice_id: DEFAULT_TTS_SETTINGS.voice,
            speed: 1,
            vol: 1,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 32_000,
            bitrate: 128_000,
            format: "mp3",
            channel: 1,
          },
        },
      },
    ]);
  });

  test("reuses cached chunks when retrying a multi-part synthesis", async () => {
    const parts = new Map<string, Uint8Array>();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 2) {
          return new Response(
            JSON.stringify({
              base_resp: { status_code: 1002, status_msg: "rate limited" },
            }),
            { status: 429 },
          );
        }
        return new Response(
          JSON.stringify({
            data: { audio: Buffer.from(`part-${calls}`).toString("hex") },
            base_resp: { status_code: 0, status_msg: "ok" },
          }),
          { status: 200 },
        );
      }),
    );

    const text = `${"第一段内容。".repeat(250)}\n\n${"第二段内容。".repeat(250)}`;
    const run = () =>
      renderSpeech({
        text,
        settings: {
          ...DEFAULT_TTS_SETTINGS,
          apiKey: "secret-key",
          chats: {},
        },
        partKey: (index, count) => `turn-1:${index}:${count}`,
        readPart: async (key) => parts.get(key),
        writePart: async (key, bytes) => {
          parts.set(key, bytes);
        },
      });

    await expect(run()).rejects.toThrow("rate limited");
    expect(calls).toBe(2);

    const bytes = await run();
    expect(calls).toBe(3);
    expect(Buffer.from(bytes).toString("utf8")).toBe("part-1part-3");
  });
});

describe("settingsStore", () => {
  test("persists settings with owner-only permissions and supports clearing key", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "minimax-tts-"));
    try {
      const store = settingsStore(dir);
      const first = await store.write({
        apiKey: "key-1",
        region: "global",
        voice: "English_CalmWoman",
        auto: "play",
        cacheMb: 256,
      });
      expect(first.apiKey).toBe("key-1");
      expect(first.region).toBe("global");
      expect(first.voice).toBe("English_CalmWoman");
      expect(first.auto).toBe("play");
      expect(first.cacheMb).toBe(256);

      const info = await NodeFSP.stat(NodePath.join(dir, "settings.json"));
      expect(info.mode & 0o077).toBe(0);

      const second = await store.write({ model: "speech-2.8-turbo" });
      expect(second.apiKey).toBe("key-1");
      expect(second.model).toBe("speech-2.8-turbo");

      const chatUpdated = await store.setChat("thread-1", "synthesize");
      expect(chatUpdated.chats).toEqual({ "thread-1": "synthesize" });

      const chatReset = await store.setChat("thread-1", null);
      expect(chatReset.chats).toEqual({});

      await expect(store.write({ cacheMb: Number.NaN })).rejects.toThrow(
        "Cache limit must be a whole number between 1 and 100000 MB",
      );
      await expect(store.write({ cacheMb: 100_001 })).rejects.toThrow(
        "Cache limit must be a whole number between 1 and 100000 MB",
      );

      const cleared = await store.write({ clearKey: true });
      expect(cleared.apiKey).toBeUndefined();
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  test("migrates legacy boolean auto settings to three-state modes", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "minimax-tts-legacy-"));
    try {
      await NodeFSP.writeFile(
        NodePath.join(dir, "settings.json"),
        JSON.stringify({
          autoSynthesize: true,
          chatAuto: {
            "thread-on": true,
            "thread-off": false,
          },
        }),
      );
      const store = settingsStore(dir);
      const loaded = await store.read();
      expect(loaded.auto).toBe("synthesize");
      expect(loaded.chats).toEqual({
        "thread-on": "synthesize",
        "thread-off": "off",
      });
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("audioCache", () => {
  test("evicts oldest cached audio when exceeding size limit and clears all files", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "minimax-tts-cache-"));
    try {
      const cache = audioCache(dir);
      const chunk = new Uint8Array(60);

      await cache.set("first", chunk, 100);
      const firstFile = NodePath.join(
        dir,
        `${NodeCrypto.createHash("sha256").update("first").digest("hex")}.mp3`,
      );
      const old = new Date(1_000_000_000);
      await NodeFSP.utimes(firstFile, old, old);

      await cache.set("second", chunk, 100);

      expect(await cache.get("first")).toBeUndefined();
      expect((await cache.get("second"))?.byteLength).toBe(60);

      const before = await cache.stats();
      expect(before).toEqual({ files: 1, bytes: 60 });

      await cache.set("oversized", new Uint8Array(200), 100);
      expect(await cache.get("oversized")).toBeUndefined();
      expect(await cache.get("second")).toBeUndefined();
      expect(await cache.stats()).toEqual({ files: 0, bytes: 0 });

      await cache.set("third", chunk, 100);
      const cleared = await cache.clear();
      expect(cleared).toEqual({ files: 1, bytes: 60 });
      expect(await cache.stats()).toEqual({ files: 0, bytes: 0 });
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createMinimaxTtsRuntime", () => {
  test("records completed replies, auto-synthesizes when enabled, and cleans up archived threads", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "minimax-tts-runtime-"));
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(
            JSON.stringify({
              data: { audio: Buffer.from("auto-mp3").toString("hex") },
              base_resp: { status_code: 0, status_msg: "ok" },
            }),
            { status: 200 },
          );
        }),
      );

      const runtime = createMinimaxTtsRuntime({
        dir,
        lookupMessageText: async (_threadId, messageId) =>
          messageId === "older-msg" ? "Older message text" : undefined,
      });

      await runtime.saveSettings({
        ...DEFAULT_TTS_SETTINGS,
        apiKey: "secret-key",
        auto: "play",
      });

      await runtime.recordCompletedReply({
        id: "msg-1",
        threadId: "thread-1",
        title: "First chat",
        text: "Hello world",
        createdAt: "2026-11-07T00:00:00.000Z",
      });

      const replies = await runtime.listReplies();
      expect(replies.items).toHaveLength(1);
      expect(replies.items[0]).toMatchObject({
        id: "msg-1",
        threadId: "thread-1",
        title: "First chat",
        text: "Hello world",
        auto: "play",
      });

      const synthesized = await runtime.synthesize({ id: "msg-1" });
      expect(Buffer.from(synthesized.base64, "base64").toString("utf8")).toBe("auto-mp3");
      expect(await runtime.speechStatus({ id: "msg-1" })).toEqual({ state: "ready" });

      const older = await runtime.synthesize({ id: "older-msg", threadId: "thread-1" });
      expect(Buffer.from(older.base64, "base64").toString("utf8")).toBe("auto-mp3");

      runtime.cleanupThread("thread-1");
      expect((await runtime.listReplies()).items).toEqual([]);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
