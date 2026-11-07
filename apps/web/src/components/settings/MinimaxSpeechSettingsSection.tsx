import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  clearEnvironmentTtsCache,
  getEnvironmentTtsCacheStats,
  getEnvironmentTtsSettings,
  saveEnvironmentTtsSettings,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthSettingsWriteScope,
  DEFAULT_TTS_SETTINGS,
  type TtsAuto,
  type TtsCacheStats,
  type TtsProvider,
  type TtsRegion,
  type TtsSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { ttsModes } from "../../speech/minimaxTts";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  readPreparedConnection,
  useEnvironmentScope,
  useEnvironmentsWithScope,
  usePreparedConnection,
} from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AdvancedSettings } from "./AdvancedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

const PROVIDER_LABELS: Record<TtsProvider, string> = {
  minimax: "MiniMax",
  gemini: "Gemini TTS (Google AI Studio)",
};

const AUTO_MODE_LABELS: Record<TtsAuto, string> = {
  off: "Off",
  synthesize: "Synthesize",
  play: "Play",
};

const AUTO_MODE_DESCRIPTIONS: Record<TtsAuto, string> = {
  off: "Off unless a chat overrides it in its reply footer.",
  synthesize: "Automatically synthesize completed replies in the background.",
  play: "Automatically synthesize and play completed replies aloud.",
};

const REGION_LABELS: Record<TtsRegion, string> = {
  cn: "China (api.minimaxi.com)",
  global: "Global (api.minimax.io)",
};

const GEMINI_VOICE_PRESETS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "Kore", label: "Kore \u00b7 Clear & firm (Female)" },
  { id: "Leda", label: "Leda \u00b7 Warm & youthful (Female)" },
  { id: "Nika", label: "Nika \u00b7 Expressive & natural (Female)" },
  { id: "Aoede", label: "Aoede \u00b7 Relaxed & natural (Female)" },
  { id: "Zephyr", label: "Zephyr \u00b7 Bright & articulate (Female)" },
  { id: "Callirrhoe", label: "Callirrhoe \u00b7 Friendly & easy-going (Female)" },
  { id: "Despina", label: "Despina \u00b7 Smooth & gentle (Female)" },
  { id: "Puck", label: "Puck \u00b7 Upbeat & lively (Male)" },
  { id: "Charon", label: "Charon \u00b7 Calm & professional (Male)" },
  { id: "Fenrir", label: "Fenrir \u00b7 Energetic & expressive (Male)" },
  { id: "Orus", label: "Orus \u00b7 Crisp & steady (Male)" },
  { id: "Iapetus", label: "Iapetus \u00b7 Composed & intellectual (Male)" },
  { id: "Umbriel", label: "Umbriel \u00b7 Conversational & relaxed (Male)" },
];

const GEMINI_MODEL_PRESETS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  {
    id: "gemini-3.8-flash-lite-tts",
    label: "gemini-3.8-flash-lite-tts (Fast & low latency, recommended)",
  },
  {
    id: "gemini-3.8-flash-tts",
    label: "gemini-3.8-flash-tts (Expressive flagship)",
  },
  {
    id: "gemini-2.5-flash-preview-tts",
    label: "gemini-2.5-flash-preview-tts (Legacy 2.5 Flash)",
  },
];

function formatMegabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sameTtsSettings(a: TtsSettings, b: TtsSettings): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.voice === b.voice &&
    a.region === b.region &&
    a.geminiModel === b.geminiModel &&
    a.geminiVoice === b.geminiVoice &&
    a.geminiStyle === b.geminiStyle &&
    a.auto === b.auto &&
    a.cacheMb === b.cacheMb
  );
}

function resolveTargetConnections(
  prepared: PreparedConnection | null,
  canManage: boolean,
  scopedEnvironments: ReadonlyArray<{
    readonly environmentId: PreparedConnection["environmentId"];
  }>,
  writableEnvIds: ReadonlySet<PreparedConnection["environmentId"]>,
): PreparedConnection[] {
  const seen = new Set<string>();
  const list: PreparedConnection[] = [];
  if (prepared && canManage) {
    seen.add(prepared.environmentId);
    list.push(prepared);
  }
  for (const env of scopedEnvironments) {
    if (seen.has(env.environmentId) || !writableEnvIds.has(env.environmentId)) continue;
    const conn = readPreparedConnection(env.environmentId);
    if (conn) {
      seen.add(conn.environmentId);
      list.push(conn);
    }
  }
  return list;
}

const EMPTY_SCOPED_ENVIRONMENTS: ReadonlyArray<{
  readonly environmentId: PreparedConnection["environmentId"];
}> = [];

export function MinimaxSpeechSettingsSection() {
  const settingsScope = useOptionalSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = settingsScope?.target?.environmentId ?? primaryEnvironmentId;
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const scopedEnvironments = settingsScope?.connectedEnvironments ?? EMPTY_SCOPED_ENVIRONMENTS;
  const writableEnvIds = useEnvironmentsWithScope(scopedEnvironments, AuthSettingsWriteScope);

  const [saved, setSaved] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS);
  const [form, setForm] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS);
  const [cacheMbText, setCacheMbText] = useState(String(DEFAULT_TTS_SETTINGS.cacheMb));
  const [apiKey, setApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [outOfSync, setOutOfSync] = useState(false);
  const [cache, setCache] = useState<TtsCacheStats>({ files: 0, bytes: 0 });
  const [loadedEnvId, setLoadedEnvId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loading = Boolean(prepared && loadedEnvId !== prepared.environmentId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads persisted read-aloud TTS settings and audio cache stats across scoped environments on mount
  useEffect(() => {
    if (!prepared) return;
    let cancelled = false;
    const targets = resolveTargetConnections(
      prepared,
      canManage,
      scopedEnvironments,
      writableEnvIds,
    );
    const peers = targets.filter((conn) => conn.environmentId !== prepared.environmentId);
    void Promise.all([
      runEnvironmentSpeech(getEnvironmentTtsSettings(prepared)),
      runEnvironmentSpeech(getEnvironmentTtsCacheStats(prepared)),
      Promise.allSettled(
        peers.map(async (conn) => ({
          settings: await runEnvironmentSpeech(getEnvironmentTtsSettings(conn)),
          stats: await runEnvironmentSpeech(getEnvironmentTtsCacheStats(conn)),
        })),
      ),
    ])
      .then(([res, stats, peerResults]) => {
        if (cancelled) return;
        const next: TtsSettings = {
          provider: res.provider ?? DEFAULT_TTS_SETTINGS.provider,
          model: res.model,
          voice: res.voice,
          region: res.region,
          geminiModel: res.geminiModel ?? DEFAULT_TTS_SETTINGS.geminiModel,
          geminiVoice: res.geminiVoice ?? DEFAULT_TTS_SETTINGS.geminiVoice,
          geminiStyle: res.geminiStyle ?? DEFAULT_TTS_SETTINGS.geminiStyle,
          auto: res.auto,
          cacheMb: res.cacheMb,
        };
        let totalFiles = stats.files;
        let totalBytes = stats.bytes;
        let diff = false;
        for (const item of peerResults) {
          if (item.status !== "fulfilled") continue;
          totalFiles += item.value.stats.files;
          totalBytes += item.value.stats.bytes;
          const peerNext: TtsSettings = {
            provider: item.value.settings.provider ?? DEFAULT_TTS_SETTINGS.provider,
            model: item.value.settings.model,
            voice: item.value.settings.voice,
            region: item.value.settings.region,
            geminiModel: item.value.settings.geminiModel ?? DEFAULT_TTS_SETTINGS.geminiModel,
            geminiVoice: item.value.settings.geminiVoice ?? DEFAULT_TTS_SETTINGS.geminiVoice,
            geminiStyle: item.value.settings.geminiStyle ?? DEFAULT_TTS_SETTINGS.geminiStyle,
            auto: item.value.settings.auto,
            cacheMb: item.value.settings.cacheMb,
          };
          if (!sameTtsSettings(next, peerNext)) {
            diff = true;
          }
        }
        setSaved(next);
        setForm(next);
        setCacheMbText(String(next.cacheMb));
        setHasKey(res.hasKey);
        setHasGeminiKey(Boolean(res.hasGeminiKey));
        setOutOfSync(diff);
        setCache({ files: totalFiles, bytes: totalBytes });
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load read-aloud settings");
      })
      .finally(() => {
        if (!cancelled) setLoadedEnvId(prepared.environmentId);
      });
    return () => {
      cancelled = true;
    };
  }, [prepared, canManage, scopedEnvironments, writableEnvIds]);

  const parsedCacheMb = Number(cacheMbText.trim());
  const validCacheMb =
    cacheMbText.trim().length > 0 &&
    Number.isInteger(parsedCacheMb) &&
    parsedCacheMb >= 1 &&
    parsedCacheMb <= 100_000;

  const dirty =
    outOfSync ||
    Boolean(apiKey.trim()) ||
    Boolean(geminiApiKey.trim()) ||
    form.provider !== saved.provider ||
    form.model !== saved.model ||
    form.voice !== saved.voice ||
    form.region !== saved.region ||
    form.geminiModel !== saved.geminiModel ||
    form.geminiVoice !== saved.geminiVoice ||
    form.geminiStyle !== saved.geminiStyle ||
    form.auto !== saved.auto ||
    cacheMbText.trim() !== String(saved.cacheMb);

  const handleSave = async (options?: { clearKey?: boolean; clearGeminiKey?: boolean }) => {
    const targets = resolveTargetConnections(
      prepared,
      canManage,
      scopedEnvironments,
      writableEnvIds,
    );
    if (!prepared || !canManage || targets.length === 0) return;
    if (!validCacheMb) {
      setStatus(null);
      setError("Cache limit must be a whole number between 1 and 100000 MB");
      return;
    }
    const cacheMb = parsedCacheMb;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const next: TtsSettings = {
        provider: form.provider,
        model: form.model.trim() || DEFAULT_TTS_SETTINGS.model,
        voice: form.voice.trim() || DEFAULT_TTS_SETTINGS.voice,
        region: form.region,
        geminiModel: form.geminiModel.trim() || DEFAULT_TTS_SETTINGS.geminiModel,
        geminiVoice: form.geminiVoice.trim() || DEFAULT_TTS_SETTINGS.geminiVoice,
        geminiStyle: form.geminiStyle.trim(),
        auto: form.auto,
        cacheMb,
      };
      const payload = {
        ...next,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(options?.clearKey ? { clearKey: true } : {}),
        ...(geminiApiKey.trim() ? { geminiApiKey: geminiApiKey.trim() } : {}),
        ...(options?.clearGeminiKey ? { clearGeminiKey: true } : {}),
      };
      await Promise.all(
        targets.map((conn) => runEnvironmentSpeech(saveEnvironmentTtsSettings(conn, payload))),
      );
      setSaved(next);
      setForm(next);
      setOutOfSync(false);
      setCacheMbText(String(next.cacheMb));
      if (options?.clearKey) setHasKey(false);
      else if (apiKey.trim()) setHasKey(true);
      if (options?.clearGeminiKey) setHasGeminiKey(false);
      else if (geminiApiKey.trim()) setHasGeminiKey(true);
      setApiKey("");
      setGeminiApiKey("");
      const statsList = await Promise.all(
        targets.map((conn) =>
          runEnvironmentSpeech(getEnvironmentTtsCacheStats(conn)).catch(() => ({
            files: 0,
            bytes: 0,
          })),
        ),
      );
      setCache({
        files: statsList.reduce((sum, item) => sum + item.files, 0),
        bytes: statsList.reduce((sum, item) => sum + item.bytes, 0),
      });
      await Promise.all(targets.map((conn) => ttsModes.refresh(conn).catch(() => undefined)));
      setStatus(
        options?.clearKey || options?.clearGeminiKey
          ? "API key removed"
          : targets.length > 1
            ? `Saved across ${targets.length} environments`
            : "Saved",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save read-aloud settings");
    } finally {
      setSaving(false);
    }
  };

  const handleClearCache = async () => {
    const targets = resolveTargetConnections(
      prepared,
      canManage,
      scopedEnvironments,
      writableEnvIds,
    );
    if (!prepared || !canManage || targets.length === 0) return;
    if (!confirmClear) {
      setConfirmClear(true);
      setStatus(null);
      setError(null);
      return;
    }
    setClearing(true);
    setConfirmClear(false);
    setStatus(null);
    setError(null);
    try {
      const results = await Promise.all(
        targets.map((conn) => runEnvironmentSpeech(clearEnvironmentTtsCache(conn))),
      );
      const clearedFiles = results.reduce((sum, item) => sum + item.files, 0);
      const clearedBytes = results.reduce((sum, item) => sum + item.bytes, 0);
      setCache({ files: 0, bytes: 0 });
      setStatus(
        clearedFiles > 0
          ? `Cleared ${clearedFiles} cached ${clearedFiles === 1 ? "file" : "files"} (${formatMegabytes(clearedBytes)})`
          : "Cache is already empty",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear audio cache");
    } finally {
      setClearing(false);
    }
  };

  const controlsDisabled = !prepared || !canManage || loading || saving;
  const isGemini = form.provider === "gemini";
  const selectedGeminiVoicePreset = GEMINI_VOICE_PRESETS.find(
    (preset) => preset.id === form.geminiVoice,
  );
  const selectedGeminiModelPreset = GEMINI_MODEL_PRESETS.find(
    (preset) => preset.id === form.geminiModel,
  );

  return (
    <SettingsSection id={searchableSetting("minimax-speech").id} title="Read aloud (TTS)">
      <SettingsRow
        title="Provider"
        description="Choose the speech synthesis service used to read assistant replies aloud."
        control={
          <Select
            value={form.provider}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value === "minimax" || value === "gemini") {
                setForm({ ...form, provider: value });
                setStatus(null);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Read aloud provider" className="w-64">
              <SelectValue>{PROVIDER_LABELS[form.provider]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(PROVIDER_LABELS) as TtsProvider[]).map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {PROVIDER_LABELS[provider]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      {isGemini ? (
        <>
          <SettingsRow
            title="Google AI Studio API key"
            description="Paste an API key from aistudio.google.com. Ready to use immediately with built-in Gemini 3.8 TTS defaults."
            control={
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                <Input
                  type="password"
                  value={geminiApiKey}
                  disabled={controlsDisabled}
                  onChange={(event) => {
                    setGeminiApiKey(event.target.value);
                    setStatus(null);
                  }}
                  placeholder={
                    hasGeminiKey
                      ? "Saved (enter a new key to replace)"
                      : "Paste your AI Studio API key (AIza...)"
                  }
                  aria-label="Google AI Studio API key"
                  className="w-64 max-w-full"
                />
                {hasGeminiKey ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={controlsDisabled}
                    onClick={() => void handleSave({ clearGeminiKey: true })}
                  >
                    Remove saved key
                  </Button>
                ) : null}
              </div>
            }
          />

          <SettingsRow
            title="Voice"
            description="Prebuilt studio voice for Gemini TTS (supports multilingual & Chinese/English speech automatically)."
            control={
              <Select
                value={selectedGeminiVoicePreset ? form.geminiVoice : "Kore"}
                disabled={controlsDisabled}
                onValueChange={(value) => {
                  if (value) {
                    setForm({ ...form, geminiVoice: value });
                    setStatus(null);
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label="Gemini voice" className="w-64">
                  <SelectValue>
                    {selectedGeminiVoicePreset
                      ? selectedGeminiVoicePreset.label
                      : `${form.geminiVoice} (Custom)`}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {GEMINI_VOICE_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : (
        <SettingsRow
          title="MiniMax API key"
          description="Read assistant replies aloud with MiniMax speech synthesis. Stored on the environment and never echoed back."
          control={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <Input
                type="password"
                value={apiKey}
                disabled={controlsDisabled}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setStatus(null);
                }}
                placeholder={
                  hasKey ? "Saved (enter a new key to replace)" : "Paste your MiniMax API key"
                }
                aria-label="MiniMax API key"
                className="w-64 max-w-full"
              />
              {hasKey ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={controlsDisabled}
                  onClick={() => void handleSave({ clearKey: true })}
                >
                  Remove saved key
                </Button>
              ) : null}
            </div>
          }
        />
      )}

      <SettingsRow
        title="Automatic speech"
        description={AUTO_MODE_DESCRIPTIONS[form.auto]}
        control={
          <Select
            value={form.auto}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value === "off" || value === "synthesize" || value === "play") {
                setForm({ ...form, auto: value });
                setStatus(null);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Automatic speech mode" className="w-40">
              <SelectValue>{AUTO_MODE_LABELS[form.auto]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(AUTO_MODE_LABELS) as TtsAuto[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {AUTO_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Audio cache"
        description={`${cache.files} ${cache.files === 1 ? "file" : "files"} \u00b7 ${formatMegabytes(cache.bytes)} used`}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span>Keep at most</span>
              <Input
                type="number"
                min={1}
                max={100_000}
                step={1}
                value={cacheMbText}
                disabled={controlsDisabled}
                aria-label="Maximum audio cache size in MB"
                onChange={(event) => {
                  setCacheMbText(event.target.value);
                  setStatus(null);
                }}
                className="w-20"
              />
              <span>MB</span>
            </label>
            <Button
              type="button"
              size="sm"
              variant={confirmClear ? "destructive" : "outline"}
              disabled={controlsDisabled || clearing || cache.files === 0}
              onClick={() => void handleClearCache()}
            >
              {clearing ? "Clearing\u2026" : confirmClear ? "Tap again to clear" : "Clear cache"}
            </Button>
          </div>
        }
      />

      <AdvancedSettings targetIds={[searchableSetting("minimax-speech").id]}>
        {isGemini ? (
          <>
            <SettingsRow
              title="Gemini model"
              description="Select a preset Gemini TTS model or type a custom model ID below."
              control={
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <Select
                    value={selectedGeminiModelPreset ? form.geminiModel : ""}
                    disabled={controlsDisabled}
                    onValueChange={(value) => {
                      if (value) {
                        setForm({ ...form, geminiModel: value });
                        setStatus(null);
                      }
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Gemini model preset" className="w-64">
                      <SelectValue>
                        {selectedGeminiModelPreset
                          ? selectedGeminiModelPreset.label
                          : "Custom model"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {GEMINI_MODEL_PRESETS.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Input
                    type="text"
                    value={form.geminiModel}
                    disabled={controlsDisabled}
                    placeholder={DEFAULT_TTS_SETTINGS.geminiModel}
                    aria-label="Gemini model ID"
                    onChange={(event) => {
                      setForm({ ...form, geminiModel: event.target.value });
                      setStatus(null);
                    }}
                    className="w-64"
                  />
                </div>
              }
            />

            <SettingsRow
              title="Custom voice ID"
              description="Override with any Gemini voice name or custom voice ID (e.g. Kore, Puck, voice_...)."
              control={
                <Input
                  type="text"
                  value={form.geminiVoice}
                  disabled={controlsDisabled}
                  placeholder={DEFAULT_TTS_SETTINGS.geminiVoice}
                  aria-label="Gemini voice ID"
                  onChange={(event) => {
                    setForm({ ...form, geminiVoice: event.target.value });
                    setStatus(null);
                  }}
                  className="w-64"
                />
              }
            />

            <SettingsRow
              title="Speaking style (optional)"
              description="Optional natural-language delivery instruction (e.g. 'warm, calm, and conversational'). Leave blank for default."
              control={
                <Input
                  type="text"
                  value={form.geminiStyle}
                  disabled={controlsDisabled}
                  placeholder="Optional style prompt"
                  aria-label="Gemini speaking style"
                  onChange={(event) => {
                    setForm({ ...form, geminiStyle: event.target.value });
                    setStatus(null);
                  }}
                  className="w-64"
                />
              }
            />
          </>
        ) : (
          <>
            <SettingsRow
              title="Region"
              description="Select the MiniMax API endpoint matching your account region."
              control={
                <Select
                  value={form.region}
                  disabled={controlsDisabled}
                  onValueChange={(value) => {
                    if (value === "cn" || value === "global") {
                      setForm({ ...form, region: value });
                      setStatus(null);
                    }
                  }}
                >
                  <SelectTrigger size="sm" aria-label="MiniMax region" className="w-56">
                    <SelectValue>{REGION_LABELS[form.region]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {(Object.keys(REGION_LABELS) as TtsRegion[]).map((region) => (
                      <SelectItem key={region} value={region}>
                        {REGION_LABELS[region]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Model"
              description="MiniMax speech model identifier."
              control={
                <Input
                  type="text"
                  value={form.model}
                  disabled={controlsDisabled}
                  placeholder={DEFAULT_TTS_SETTINGS.model}
                  aria-label="MiniMax model"
                  onChange={(event) => {
                    setForm({ ...form, model: event.target.value });
                    setStatus(null);
                  }}
                  className="w-56"
                />
              }
            />

            <SettingsRow
              title="Voice ID"
              description="MiniMax voice identifier used for synthesis."
              control={
                <Input
                  type="text"
                  value={form.voice}
                  disabled={controlsDisabled}
                  placeholder={DEFAULT_TTS_SETTINGS.voice}
                  aria-label="MiniMax voice ID"
                  onChange={(event) => {
                    setForm({ ...form, voice: event.target.value });
                    setStatus(null);
                  }}
                  className="w-64"
                />
              }
            />
          </>
        )}
      </AdvancedSettings>

      <div className="flex items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 text-xs">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : status ? (
            <span className="text-muted-foreground">{status}</span>
          ) : outOfSync ? (
            <span className="text-muted-foreground">
              Settings differ across connected environments. Click Save to sync.
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || controlsDisabled}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving\u2026" : "Save"}
        </Button>
      </div>
    </SettingsSection>
  );
}
