// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalRandom:off globalTimers:off effectFnOpportunity:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_TTS_SETTINGS,
  MessageId,
  type RunId,
  ThreadId,
  TtsSynthesisError,
  type TtsAuto,
  type TtsCacheStats,
  type TtsMimeType,
  type TtsModesResponse,
  type TtsProvider,
  type TtsRegion,
  type TtsReplyRecord,
  type TtsSettings,
  type TtsSettingsResponse,
  type TtsSettingsUpdateRequest,
  type TtsSpeechState,
  type TtsSynthesizeRequest,
  type TtsSynthesizeResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export interface StoredTtsSettings extends TtsSettings {
  apiKey?: string | undefined;
  geminiApiKey?: string | undefined;
  chats: Record<string, TtsAuto>;
}

const DEFAULT_BASE_DIR = NodePath.join(NodeOS.homedir(), ".paseo-minimax-tts");
const MAX_CACHE_MB = 100_000;
const MAX_REPLIES = 20;

const isAuto = (value: unknown): value is TtsAuto =>
  value === "off" || value === "synthesize" || value === "play";

const isProvider = (value: unknown): value is TtsProvider =>
  value === "minimax" || value === "gemini";

function parseCacheMb(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > MAX_CACHE_MB) return undefined;
  return value;
}

function parseChats(value: unknown, legacy?: unknown) {
  const chats: Record<string, TtsAuto> = {};
  if (legacy && typeof legacy === "object") {
    for (const [key, item] of Object.entries(legacy)) {
      if (typeof item === "boolean") chats[key] = item ? "synthesize" : "off";
    }
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (isAuto(item)) chats[key] = item;
    }
  }
  return chats;
}

export function settingsStore(dir = DEFAULT_BASE_DIR) {
  const file = NodePath.join(dir, "settings.json");
  let pending = Promise.resolve();

  const read = async (): Promise<StoredTtsSettings> => {
    try {
      const raw = JSON.parse(await NodeFSP.readFile(file, "utf8")) as Partial<StoredTtsSettings> & {
        autoSynthesize?: boolean;
        chatAuto?: Record<string, boolean>;
      };
      const auto = isAuto(raw.auto)
        ? raw.auto
        : raw.autoSynthesize === true
          ? "synthesize"
          : DEFAULT_TTS_SETTINGS.auto;
      return {
        provider: isProvider(raw.provider) ? raw.provider : DEFAULT_TTS_SETTINGS.provider,
        apiKey: typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : undefined,
        geminiApiKey:
          typeof raw.geminiApiKey === "string" && raw.geminiApiKey.trim()
            ? raw.geminiApiKey.trim()
            : undefined,
        model:
          typeof raw.model === "string" && raw.model.trim()
            ? raw.model.trim()
            : DEFAULT_TTS_SETTINGS.model,
        voice:
          typeof raw.voice === "string" && raw.voice.trim()
            ? raw.voice.trim()
            : DEFAULT_TTS_SETTINGS.voice,
        region:
          raw.region === "global" || raw.region === "cn" ? raw.region : DEFAULT_TTS_SETTINGS.region,
        geminiModel:
          typeof raw.geminiModel === "string" && raw.geminiModel.trim()
            ? raw.geminiModel.trim()
            : DEFAULT_TTS_SETTINGS.geminiModel,
        geminiVoice:
          typeof raw.geminiVoice === "string" && raw.geminiVoice.trim()
            ? raw.geminiVoice.trim()
            : DEFAULT_TTS_SETTINGS.geminiVoice,
        geminiStyle:
          typeof raw.geminiStyle === "string"
            ? raw.geminiStyle.trim()
            : DEFAULT_TTS_SETTINGS.geminiStyle,
        auto,
        cacheMb: parseCacheMb(raw.cacheMb) ?? DEFAULT_TTS_SETTINGS.cacheMb,
        chats: parseChats(raw.chats, raw.chatAuto),
      };
    } catch {
      return { ...DEFAULT_TTS_SETTINGS, chats: {} };
    }
  };

  const commit = async (next: StoredTtsSettings) => {
    await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
    await NodeFSP.chmod(dir, 0o700).catch(() => undefined);
    const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await NodeFSP.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await NodeFSP.chmod(temp, 0o600).catch(() => undefined);
    await NodeFSP.rename(temp, file);
    await NodeFSP.chmod(file, 0o600).catch(() => undefined);
    return next;
  };

  const run = <T>(fn: () => Promise<T>) => {
    const task = pending.then(fn, fn);
    pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  const write = (input: {
    provider?: TtsProvider;
    apiKey?: string;
    clearKey?: boolean;
    geminiApiKey?: string;
    clearGeminiKey?: boolean;
    model?: string;
    voice?: string;
    region?: TtsRegion;
    geminiModel?: string;
    geminiVoice?: string;
    geminiStyle?: string;
    auto?: TtsAuto;
    cacheMb?: number;
  }) =>
    run(async () => {
      const current = await read();
      const apiKey = input.clearKey ? undefined : input.apiKey?.trim() || current.apiKey;
      const geminiApiKey = input.clearGeminiKey
        ? undefined
        : input.geminiApiKey?.trim() || current.geminiApiKey;
      const cacheMb = input.cacheMb === undefined ? current.cacheMb : parseCacheMb(input.cacheMb);
      if (!cacheMb) {
        throw new Error(`Cache limit must be a whole number between 1 and ${MAX_CACHE_MB} MB`);
      }
      return commit({
        provider: input.provider ?? current.provider,
        apiKey,
        geminiApiKey,
        model: input.model?.trim() || current.model,
        voice: input.voice?.trim() || current.voice,
        region: input.region ?? current.region,
        geminiModel: input.geminiModel?.trim() || current.geminiModel,
        geminiVoice: input.geminiVoice?.trim() || current.geminiVoice,
        geminiStyle:
          input.geminiStyle !== undefined ? input.geminiStyle.trim() : current.geminiStyle,
        auto: input.auto ?? current.auto,
        cacheMb,
        chats: current.chats,
      });
    });

  const setChat = (threadId: string, mode: TtsAuto | null) =>
    run(async () => {
      const current = await read();
      const chats = { ...current.chats };
      if (mode === null) delete chats[threadId];
      else chats[threadId] = mode;
      return commit({ ...current, chats });
    });

  return { read, write, setChat };
}

interface CacheEntry {
  file: string;
  size: number;
  mtimeMs: number;
}

export function audioCache(dir = NodePath.join(DEFAULT_BASE_DIR, "audio")) {
  let pending = Promise.resolve();

  const pathFor = (key: string) =>
    NodePath.join(dir, `${NodeCrypto.createHash("sha256").update(key).digest("hex")}.mp3`);

  const scan = async (): Promise<CacheEntry[]> => {
    try {
      const names = await NodeFSP.readdir(dir);
      const list = await Promise.all(
        names.map(async (name) => {
          const file = NodePath.join(dir, name);
          if (name.endsWith(".tmp")) {
            await NodeFSP.rm(file, { force: true }).catch(() => undefined);
            return undefined;
          }
          if (!name.endsWith(".mp3")) return undefined;
          try {
            const info = await NodeFSP.stat(file);
            if (!info.isFile()) return undefined;
            return { file, size: info.size, mtimeMs: info.mtimeMs };
          } catch {
            return undefined;
          }
        }),
      );
      return list.filter((item): item is CacheEntry => item !== undefined);
    } catch {
      return [];
    }
  };

  const evict = async (limitBytes: number) => {
    const items = await scan();
    let bytes = items.reduce((sum, item) => sum + item.size, 0);
    if (bytes <= limitBytes) return;
    items.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const item of items) {
      if (bytes <= limitBytes) break;
      await NodeFSP.rm(item.file, { force: true }).catch(() => undefined);
      bytes -= item.size;
    }
  };

  const get = async (key: string) => {
    const file = pathFor(key);
    try {
      const data = await NodeFSP.readFile(file);
      const now = new Date();
      await NodeFSP.utimes(file, now, now).catch(() => undefined);
      return new Uint8Array(data);
    } catch {
      return undefined;
    }
  };

  const has = async (key: string) => {
    try {
      const info = await NodeFSP.stat(pathFor(key));
      return info.isFile();
    } catch {
      return false;
    }
  };

  const run = <T>(fn: () => Promise<T>) => {
    const task = pending.then(fn, fn);
    pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  const set = (key: string, bytes: Uint8Array, limitBytes: number) =>
    run(async () => {
      if (limitBytes <= 0) return;
      if (bytes.byteLength > limitBytes) {
        await evict(0);
        return;
      }
      await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
      await NodeFSP.chmod(dir, 0o700).catch(() => undefined);
      const file = pathFor(key);
      const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      await NodeFSP.writeFile(temp, bytes, { mode: 0o600 });
      await NodeFSP.chmod(temp, 0o600).catch(() => undefined);
      await NodeFSP.rename(temp, file);
      await NodeFSP.chmod(file, 0o600).catch(() => undefined);
      await evict(limitBytes);
    });

  const trim = (limitBytes: number) =>
    run(async () => {
      await evict(Math.max(0, limitBytes));
    });

  const stats = async (): Promise<TtsCacheStats> => {
    const items = await scan();
    return {
      files: items.length,
      bytes: items.reduce((sum, item) => sum + item.size, 0),
    };
  };

  const clear = () =>
    run(async (): Promise<TtsCacheStats> => {
      const items = await scan();
      await Promise.all(
        items.map((item) => NodeFSP.rm(item.file, { force: true }).catch(() => undefined)),
      );
      return {
        files: items.length,
        bytes: items.reduce((sum, item) => sum + item.size, 0),
      };
    });

  return { get, has, set, trim, stats, clear };
}

const HOSTS: Record<TtsRegion, string> = {
  cn: "https://api.minimaxi.com/v1/t2a_v2",
  global: "https://api.minimax.io/v1/t2a_v2",
};

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const LIMIT = 2_000;
const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const BITRATES: Record<number, number[]> = {
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  0: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44_100, 48_000, 32_000, 0],
  2: [22_050, 24_000, 16_000, 0],
  0: [11_025, 12_000, 8_000, 0],
};

interface MinimaxResponse {
  data?: { audio?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
    code?: number;
  };
}

/**
 * Cleans markdown links, image references, raw URLs, and inline backticks so TTS reads
 * only human-friendly labels (e.g. `[statement.tex](file:///...)` -> `statement.tex`).
 */
export function cleanTextForTts(input: string): string {
  return (
    input
      // Markdown images: ![alt](url) -> alt
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      // Markdown links (including code-wrapped labels like [`ClassName`](file:///...)): [label](url) -> label
      .replace(/\[([^\]]+)\]\((?:[^()\s]+|\([^()\s]*\))+\)/g, "$1")
      // Angle-bracket autolinks: <https://...> or <file:///...>
      .replace(/<(?:https?|file|mailto):[^>]+>/gi, "")
      // Bare file:// URLs -> keep only basename
      .replace(/\bfile:\/\/[^\s)>\]"'`]+/gi, (match) => {
        const withoutHash = match.split("#")[0] ?? match;
        const segments = withoutHash.split("/").filter(Boolean);
        return segments[segments.length - 1] ?? "";
      })
      // Unwrap inline code backticks around short labels
      .replace(/`([^`\n]+)`/g, "$1")
      .trim()
  );
}

export function splitText(input: string): string[] {
  const text = cleanTextForTts(input);
  if (!text) return [];
  if (text.length <= LIMIT) return [text];

  const parts: string[] = [];
  let rest = text;
  while (rest.length > LIMIT) {
    const slice = rest.slice(0, LIMIT);
    const cut =
      Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n")) >= LIMIT * 0.4
        ? Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n")) + 1
        : (findBreak(slice, /[.!?\u3002\uff01\uff1f\uff1b;]/g) ??
          findBreak(slice, /[,\uff0c\u3001\uff1a:\s]/g) ??
          LIMIT);
    const head = rest.slice(0, cut).trim();
    if (head) parts.push(head);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function findBreak(text: string, pattern: RegExp) {
  let match: RegExpExecArray | null;
  let index = -1;
  while ((match = pattern.exec(text)) !== null) {
    index = match.index + match[0].length;
  }
  return index >= LIMIT * 0.4 ? index : undefined;
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function id3Length(bytes: Uint8Array) {
  if (bytes.byteLength < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const b6 = bytes[6] ?? 0;
  const b7 = bytes[7] ?? 0;
  const b8 = bytes[8] ?? 0;
  const b9 = bytes[9] ?? 0;
  if ((b6 | b7 | b8 | b9) & 0x80) return 0;
  const size = ((b6 & 0x7f) << 21) | ((b7 & 0x7f) << 14) | ((b8 & 0x7f) << 7) | (b9 & 0x7f);
  const flags = bytes[5] ?? 0;
  const footer = flags & 0x10 ? 10 : 0;
  const total = 10 + size + footer;
  return total <= bytes.byteLength ? total : 0;
}

function frameInfo(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.byteLength) return undefined;
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  if (version === 1 || layer !== 1) return undefined;
  const bitrate = BITRATES[version]?.[(b2 >> 4) & 0x0f] ?? 0;
  const sampleRate = SAMPLE_RATES[version]?.[(b2 >> 2) & 0x03] ?? 0;
  if (!bitrate || !sampleRate) return undefined;
  const padding = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03;
  const sideInfo = version === 3 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
  const coef = version === 3 ? 144 : 72;
  const length = Math.floor((coef * bitrate * 1_000) / sampleRate) + padding;
  if (length < 4 || offset + length > bytes.byteLength) return undefined;
  return { length, sideInfo };
}

export function mp3Frames(bytes: Uint8Array) {
  let offset = id3Length(bytes);
  const first = frameInfo(bytes, offset);
  if (first) {
    const tagOffset = offset + 4 + first.sideInfo;
    if (tagOffset + 4 <= offset + first.length) {
      const tag = String.fromCharCode(
        bytes[tagOffset] ?? 0,
        bytes[tagOffset + 1] ?? 0,
        bytes[tagOffset + 2] ?? 0,
        bytes[tagOffset + 3] ?? 0,
      );
      if (tag === "Xing" || tag === "Info") offset += first.length;
    }
  }
  return offset > 0 ? bytes.subarray(offset) : bytes;
}

export function isWavBytes(bytes: Uint8Array) {
  return (
    bytes.byteLength >= 44 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

export function detectAudioMimeType(bytes: Uint8Array): TtsMimeType {
  return isWavBytes(bytes) ? "audio/wav" : "audio/mpeg";
}

function parseWavPcm(bytes: Uint8Array): {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
} {
  if (!isWavBytes(bytes)) {
    return { pcm: bytes, sampleRate: 24_000, channels: 1, bitsPerSample: 16 };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let channels = 1;
  let sampleRate = 24_000;
  let bitsPerSample = 16;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (id === "fmt " && chunkSize >= 16 && dataOffset + 16 <= bytes.byteLength) {
      channels = view.getUint16(dataOffset + 2, true) || 1;
      sampleRate = view.getUint32(dataOffset + 4, true) || 24_000;
      bitsPerSample = view.getUint16(dataOffset + 14, true) || 16;
    } else if (id === "data") {
      const end = Math.min(bytes.byteLength, dataOffset + chunkSize);
      return {
        pcm: bytes.subarray(dataOffset, end),
        sampleRate,
        channels,
        bitsPerSample,
      };
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return {
    pcm: bytes.subarray(44),
    sampleRate,
    channels,
    bitsPerSample,
  };
}

export function wrapWavPcm(
  pcm: Uint8Array,
  sampleRate = 24_000,
  channels = 1,
  bitsPerSample = 16,
): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const byteRate = sampleRate * channels * (bitsPerSample >> 3);
  const blockAlign = channels * (bitsPerSample >> 3);
  header.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + pcm.byteLength, true);
  header.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  header.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  header.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, pcm.byteLength, true);
  return concatBytes([header, pcm]);
}

function joinWavChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) {
    const single = chunks[0]!;
    return isWavBytes(single) ? single : wrapWavPcm(single);
  }
  let sampleRate = 24_000;
  let channels = 1;
  let bitsPerSample = 16;
  const pcmParts: Uint8Array[] = [];
  for (const [idx, chunk] of chunks.entries()) {
    const parsed = parseWavPcm(chunk);
    if (idx === 0) {
      sampleRate = parsed.sampleRate;
      channels = parsed.channels;
      bitsPerSample = parsed.bitsPerSample;
    }
    pcmParts.push(parsed.pcm);
  }
  return wrapWavPcm(concatBytes(pcmParts), sampleRate, channels, bitsPerSample);
}

async function readBody(res: Response, providerLabel = "TTS") {
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) {
    throw new Error(`${providerLabel} response exceeded maximum allowed size`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${providerLabel} response exceeded maximum allowed size`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatBytes(chunks));
}

async function renderGeminiSpeech(input: {
  parts: string[];
  settings: StoredTtsSettings;
  signal?: AbortSignal | undefined;
  partKey?: ((index: number, count: number) => string) | undefined;
  readPart?: ((key: string) => Promise<Uint8Array | undefined>) | undefined;
  writePart?: ((key: string, bytes: Uint8Array) => Promise<void>) | undefined;
}) {
  const apiKey = input.settings.geminiApiKey?.trim();
  if (!apiKey) {
    throw new Error("Add your Google AI Studio API key in Settings \u2192 Voice first");
  }
  const model = input.settings.geminiModel?.trim() || DEFAULT_TTS_SETTINGS.geminiModel;
  const voice = input.settings.geminiVoice?.trim() || DEFAULT_TTS_SETTINGS.geminiVoice;
  const style = input.settings.geminiStyle?.trim() || "";
  const isGemini38 = model.startsWith("gemini-3.8");

  const wavChunks: Uint8Array[] = [];
  for (const [index, part] of input.parts.entries()) {
    const key = input.parts.length > 1 ? input.partKey?.(index, input.parts.length) : undefined;
    const cached = key ? await input.readPart?.(key) : undefined;
    if (cached) {
      wavChunks.push(cached);
      continue;
    }

    const timer = new AbortController();
    const onAbort = () => timer.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => timer.abort(), TIMEOUT_MS);
    let res: Response;
    let raw: string;

    const partPayload: Record<string, unknown> = isGemini38
      ? {
          text: part,
          ...(style ? { speechMetadata: { style } } : {}),
        }
      : {
          text: style ? `${style}: ${part}` : part,
        };

    const voiceConfig: Record<string, unknown> = isGemini38
      ? { voice }
      : { prebuiltVoiceConfig: { voiceName: voice } };

    try {
      res = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        signal: timer.signal,
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [partPayload],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig,
            },
          },
        }),
      });
      raw = await readBody(res, "Gemini TTS");
    } catch (err) {
      if (input.signal?.aborted) throw new Error("Speech synthesis cancelled", { cause: err });
      if (timer.signal.aborted)
        throw new Error("Gemini TTS request timed out after 60s", { cause: err });
      throw err;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    }

    let payload: GeminiResponse | undefined;
    try {
      payload = JSON.parse(raw) as GeminiResponse;
    } catch {
      payload = undefined;
    }
    if (!res.ok) {
      throw new Error(
        payload?.error?.message || raw.trim() || `Gemini TTS request failed (${res.status})`,
      );
    }
    const inlineData = payload?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    const base64Audio = inlineData?.data?.trim() ?? "";
    if (!base64Audio) {
      throw new Error("Gemini TTS returned empty audio data");
    }
    const rawBytes = new Uint8Array(Buffer.from(base64Audio, "base64"));
    const wavBytes = isWavBytes(rawBytes) ? rawBytes : wrapWavPcm(rawBytes, 24_000, 1, 16);
    if (key) await input.writePart?.(key, wavBytes);
    wavChunks.push(wavBytes);
  }

  return joinWavChunks(wavChunks);
}

export async function renderSpeech(input: {
  text: string;
  settings: StoredTtsSettings;
  signal?: AbortSignal;
  partKey?: (index: number, count: number) => string;
  readPart?: (key: string) => Promise<Uint8Array | undefined>;
  writePart?: (key: string, bytes: Uint8Array) => Promise<void>;
}) {
  const parts = splitText(input.text);
  if (!parts.length) {
    throw new Error("Nothing to read aloud");
  }

  if (input.settings.provider === "gemini") {
    return renderGeminiSpeech({
      parts,
      settings: input.settings,
      signal: input.signal,
      partKey: input.partKey,
      readPart: input.readPart,
      writePart: input.writePart,
    });
  }

  const apiKey = input.settings.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Add your MiniMax API key in Settings \u2192 Voice first");
  }

  const chunks: Uint8Array[] = [];
  for (const [index, part] of parts.entries()) {
    const key = parts.length > 1 ? input.partKey?.(index, parts.length) : undefined;
    const cached = key ? await input.readPart?.(key) : undefined;
    if (cached) {
      chunks.push(mp3Frames(cached));
      continue;
    }
    const timer = new AbortController();
    const onAbort = () => timer.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => timer.abort(), TIMEOUT_MS);
    let res: Response;
    let raw: string;
    try {
      res = await fetch(HOSTS[input.settings.region], {
        method: "POST",
        signal: timer.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.settings.model,
          text: part,
          stream: false,
          voice_setting: {
            voice_id: input.settings.voice,
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
        }),
      });
      raw = await readBody(res, "MiniMax");
    } catch (err) {
      if (input.signal?.aborted) throw new Error("Speech synthesis cancelled", { cause: err });
      if (timer.signal.aborted)
        throw new Error("MiniMax request timed out after 60s", { cause: err });
      throw err;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    }

    let payload: MinimaxResponse | undefined;
    try {
      payload = JSON.parse(raw) as MinimaxResponse;
    } catch {
      payload = undefined;
    }
    if (!res.ok) {
      throw new Error(
        payload?.base_resp?.status_msg || raw.trim() || `MiniMax request failed (${res.status})`,
      );
    }
    const code = payload?.base_resp?.status_code ?? 0;
    if (code !== 0) {
      throw new Error(payload?.base_resp?.status_msg || `MiniMax error ${code}`);
    }
    const hex = payload?.data?.audio?.trim() ?? "";
    if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error("MiniMax returned invalid audio data");
    }
    const bytes = new Uint8Array(Buffer.from(hex, "hex"));
    if (key) await input.writePart?.(key, bytes);
    chunks.push(parts.length > 1 ? mp3Frames(bytes) : bytes);
  }
  return concatBytes(chunks);
}

interface TurnLike {
  outcome?: { status: string };
  timeline: ReadonlyArray<{
    kind: string;
    item: { type: string; text?: string };
  }>;
}

export function finalReply(turn: TurnLike) {
  if (turn.outcome?.status !== "completed") return "";
  let text = "";
  for (const entry of turn.timeline) {
    if (entry.kind === "user_message") text = "";
    if (entry.kind === "CanonicalItem" && entry.item.type === "assistant_message") {
      text = entry.item.text?.trim() ?? "";
    }
  }
  return text;
}

function cacheKey(
  settings: {
    provider?: TtsProvider;
    model: string;
    voice: string;
    geminiModel?: string;
    geminiVoice?: string;
    geminiStyle?: string;
  },
  id: string,
) {
  if (settings.provider === "gemini") {
    return `gemini\0${settings.geminiModel ?? DEFAULT_TTS_SETTINGS.geminiModel}\0${settings.geminiVoice ?? DEFAULT_TTS_SETTINGS.geminiVoice}\0${settings.geminiStyle ?? ""}\0${id}`;
  }
  return `${settings.model}\0${settings.voice}\0${id}`;
}

interface Job {
  controller: AbortController;
  promise: Promise<Uint8Array>;
  threadId?: string | undefined;
}

export function createMinimaxTtsRuntime(options?: {
  dir?: string;
  lookupMessageText?: (threadId: string, messageId: string) => Promise<string | undefined>;
}) {
  const baseDir = options?.dir ?? DEFAULT_BASE_DIR;
  const store = settingsStore(baseDir);
  const cache = audioCache(NodePath.join(baseDir, "audio"));
  const replies: TtsReplyRecord[] = [];
  const jobs = new Map<string, Job>();

  const speak = async (id: string, text: string, threadId?: string) => {
    const active = jobs.get(id);
    if (active) return active.promise;

    const settings = await store.read();
    const key = cacheKey(settings, id);
    const cached = await cache.get(key);
    if (cached) return cached;

    const controller = new AbortController();
    const limitBytes = settings.cacheMb * 1024 * 1024;
    const promise = (async () => {
      const bytes = await renderSpeech({
        text,
        settings,
        signal: controller.signal,
        partKey: (index, count) => `${key}\0part:${index}:${count}`,
        readPart: (part) => cache.get(part),
        writePart: (part, chunk) => cache.set(part, chunk, limitBytes),
      });
      await cache.set(key, bytes, limitBytes);
      return bytes;
    })();
    jobs.set(id, { controller, promise, threadId });
    void promise.then(
      () => jobs.delete(id),
      () => jobs.delete(id),
    );
    return promise;
  };

  const getSettings = async (): Promise<TtsSettingsResponse> => {
    const settings = await store.read();
    return {
      provider: settings.provider,
      model: settings.model,
      voice: settings.voice,
      region: settings.region,
      geminiModel: settings.geminiModel,
      geminiVoice: settings.geminiVoice,
      geminiStyle: settings.geminiStyle,
      auto: settings.auto,
      cacheMb: settings.cacheMb,
      hasKey: Boolean(settings.apiKey),
      hasGeminiKey: Boolean(settings.geminiApiKey),
    };
  };

  const saveSettings = async (input: TtsSettingsUpdateRequest) => {
    const next = await store.write(input);
    await cache.trim(next.cacheMb * 1024 * 1024);
    return { ok: true };
  };

  const cacheStats = () => cache.stats();
  const clearCache = () => cache.clear();

  const getModes = async (): Promise<TtsModesResponse> => {
    const settings = await store.read();
    return { auto: settings.auto, chats: settings.chats };
  };

  const setChatMode = async (input: {
    threadId: string;
    mode: TtsAuto | null;
  }): Promise<TtsModesResponse> => {
    const id = input.threadId.trim();
    if (!id) throw new Error("Missing chat id");
    const next = await store.setChat(id, input.mode);
    return { auto: next.auto, chats: next.chats };
  };

  const listReplies = async () => ({ items: [...replies] });

  const speechStatus = async (input: { id: string }): Promise<{ state: TtsSpeechState }> => {
    if (jobs.has(input.id)) return { state: "working" };
    const settings = await store.read();
    if (await cache.has(cacheKey(settings, input.id))) return { state: "ready" };
    if (replies.some((item) => item.id === input.id)) return { state: "idle" };
    return { state: "expired" };
  };

  const synthesize = async (input: TtsSynthesizeRequest): Promise<TtsSynthesizeResponse> => {
    const item = replies.find((entry) => entry.id === input.id);
    let text = item?.text ?? input.text?.trim();
    if (!text && input.threadId && options?.lookupMessageText) {
      text = (await options.lookupMessageText(input.threadId, input.id))?.trim();
    }
    if (!text) {
      const settings = await store.read();
      const cached = await cache.get(cacheKey(settings, input.id));
      if (cached) {
        return {
          base64: Buffer.from(cached).toString("base64"),
          mimeType: detectAudioMimeType(cached),
        };
      }
      throw new Error("This reply is no longer available to synthesize");
    }
    const bytes = await speak(input.id, text, item?.threadId ?? input.threadId);
    return {
      base64: Buffer.from(bytes).toString("base64"),
      mimeType: detectAudioMimeType(bytes),
    };
  };

  const cancelSpeech = async (input?: { id?: string }) => {
    if (input?.id) {
      jobs.get(input.id)?.controller.abort();
      return { ok: true };
    }
    for (const job of jobs.values()) job.controller.abort();
    return { ok: true };
  };

  const recordCompletedReply = async (input: {
    id: string;
    threadId: string;
    title: string;
    text: string;
    createdAt: string;
  }) => {
    const trimmed = input.text.trim();
    if (!trimmed) return;
    if (replies.some((item) => item.id === input.id)) return;
    const settings = await store.read();
    const auto = settings.chats[input.threadId] ?? settings.auto;
    replies.unshift({
      id: input.id,
      threadId: input.threadId,
      title: input.title,
      text: trimmed,
      createdAt: input.createdAt,
      auto,
    });
    if (replies.length > MAX_REPLIES) replies.length = MAX_REPLIES;
    if (auto !== "off") {
      void speak(input.id, trimmed, input.threadId).catch(() => undefined);
    }
  };

  const cleanupThread = (threadId: string) => {
    for (const [id, job] of jobs.entries()) {
      if (job.threadId === threadId) {
        job.controller.abort();
        jobs.delete(id);
      }
    }
    for (let i = replies.length - 1; i >= 0; i -= 1) {
      if (replies[i]?.threadId === threadId) {
        replies.splice(i, 1);
      }
    }
  };

  return {
    getSettings,
    saveSettings,
    cacheStats,
    clearCache,
    getModes,
    setChatMode,
    listReplies,
    speechStatus,
    synthesize,
    cancelSpeech,
    recordCompletedReply,
    cleanupThread,
  };
}

export interface MinimaxTtsShape {
  readonly getSettings: Effect.Effect<TtsSettingsResponse, TtsSynthesisError>;
  readonly saveSettings: (
    input: TtsSettingsUpdateRequest,
  ) => Effect.Effect<{ ok: boolean }, TtsSynthesisError>;
  readonly cacheStats: Effect.Effect<TtsCacheStats, TtsSynthesisError>;
  readonly clearCache: Effect.Effect<TtsCacheStats, TtsSynthesisError>;
  readonly getModes: Effect.Effect<TtsModesResponse, TtsSynthesisError>;
  readonly setChatMode: (input: {
    threadId: string;
    mode: TtsAuto | null;
  }) => Effect.Effect<TtsModesResponse, TtsSynthesisError>;
  readonly listReplies: Effect.Effect<{ items: ReadonlyArray<TtsReplyRecord> }, TtsSynthesisError>;
  readonly speechStatus: (input: {
    id: string;
  }) => Effect.Effect<{ state: TtsSpeechState }, TtsSynthesisError>;
  readonly synthesize: (
    input: TtsSynthesizeRequest,
  ) => Effect.Effect<TtsSynthesizeResponse, TtsSynthesisError>;
  readonly cancelSpeech: (input?: {
    id?: string;
  }) => Effect.Effect<{ ok: boolean }, TtsSynthesisError>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class MinimaxTts extends Context.Service<MinimaxTts, MinimaxTtsShape>()(
  "t3/speech/MinimaxTts",
) {}

const tryTts = <A>(fn: () => Promise<A>): Effect.Effect<A, TtsSynthesisError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new TtsSynthesisError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });

export const layer = Layer.effect(
  MinimaxTts,
  Effect.gen(function* () {
    const orchestrator = yield* Effect.serviceOption(Orchestrator.OrchestratorV2);
    const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
    const runtime = createMinimaxTtsRuntime();

    const handleCompletedRun = Effect.fn("MinimaxTts.handleCompletedRun")(function* (
      threadId: ThreadId,
      runId: RunId,
    ) {
      if (projections._tag === "None") return;
      const records = yield* projections.value
        .getThreadRecords(threadId, ["messages"], {
          messageRunIds: [runId],
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (!records) return;
      const { thread, messages } = records;
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.lineage.relationshipToParent === "subagent"
      ) {
        return;
      }
      let target: (typeof messages)[number] | undefined;
      for (const msg of messages) {
        if (msg.role === "assistant" && !msg.streaming && msg.text.trim()) {
          target = msg;
        }
      }
      if (!target) return;
      yield* Effect.promise(() =>
        runtime.recordCompletedReply({
          id: target.id,
          threadId: thread.id,
          title: thread.title,
          text: target.text,
          createdAt: DateTime.formatIso(target.updatedAt),
        }),
      );
    });

    const start = Effect.fn("MinimaxTts.start")(function* () {
      if (orchestrator._tag === "None") return;
      yield* orchestrator.value.streamDomainEvents.pipe(
        Stream.runForEach((event) => {
          if (event.type === "run.updated" && event.payload.status === "completed") {
            return handleCompletedRun(event.threadId, event.payload.id);
          }
          if (event.type === "thread.archived" || event.type === "thread.deleted") {
            return Effect.sync(() => runtime.cleanupThread(event.threadId));
          }
          return Effect.void;
        }),
        Effect.forkScoped,
        Effect.asVoid,
      );
    });

    return MinimaxTts.of({
      getSettings: tryTts(() => runtime.getSettings()),
      saveSettings: (input) => tryTts(() => runtime.saveSettings(input)),
      cacheStats: tryTts(() => runtime.cacheStats()),
      clearCache: tryTts(() => runtime.clearCache()),
      getModes: tryTts(() => runtime.getModes()),
      setChatMode: (input) => tryTts(() => runtime.setChatMode(input)),
      listReplies: tryTts(() => runtime.listReplies()),
      speechStatus: (input) => tryTts(() => runtime.speechStatus(input)),
      synthesize: Effect.fn("MinimaxTts.synthesize")(function* (input: TtsSynthesizeRequest) {
        let resolvedText = input.text?.trim();
        if (!resolvedText && input.threadId && projections._tag === "Some") {
          const found = yield* projections.value
            .getMessagesById(ThreadId.make(input.threadId), [MessageId.make(input.id)])
            .pipe(Effect.orElseSucceed(() => new Map()));
          resolvedText = found.get(MessageId.make(input.id))?.text.trim();
        }
        return yield* tryTts(() =>
          runtime.synthesize({
            ...input,
            ...(resolvedText ? { text: resolvedText } : {}),
          }),
        );
      }),
      cancelSpeech: (input) => tryTts(() => runtime.cancelSpeech(input)),
      start,
    });
  }),
);
