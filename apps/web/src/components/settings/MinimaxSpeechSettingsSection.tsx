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
  type TtsRegion,
  type TtsSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { ttsModes } from "../../speech/minimaxTts";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AdvancedSettings } from "./AdvancedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

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

function formatMegabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MinimaxSpeechSettingsSection() {
  const settingsScope = useOptionalSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = settingsScope?.target?.environmentId ?? primaryEnvironmentId;
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);

  const [saved, setSaved] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS);
  const [form, setForm] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS);
  const [cacheMbText, setCacheMbText] = useState(String(DEFAULT_TTS_SETTINGS.cacheMb));
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [cache, setCache] = useState<TtsCacheStats>({ files: 0, bytes: 0 });
  const [loadedEnvId, setLoadedEnvId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loading = Boolean(prepared && loadedEnvId !== prepared.environmentId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads persisted MiniMax TTS settings and audio cache stats from the environment HTTP endpoint on mount
  useEffect(() => {
    if (!prepared) return;
    let cancelled = false;
    void Promise.all([
      runEnvironmentSpeech(getEnvironmentTtsSettings(prepared)),
      runEnvironmentSpeech(getEnvironmentTtsCacheStats(prepared)),
    ])
      .then(([res, stats]) => {
        if (cancelled) return;
        const next: TtsSettings = {
          model: res.model,
          voice: res.voice,
          region: res.region,
          auto: res.auto,
          cacheMb: res.cacheMb,
        };
        setSaved(next);
        setForm(next);
        setCacheMbText(String(next.cacheMb));
        setHasKey(res.hasKey);
        setCache(stats);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load MiniMax speech settings");
      })
      .finally(() => {
        if (!cancelled) setLoadedEnvId(prepared.environmentId);
      });
    return () => {
      cancelled = true;
    };
  }, [prepared]);

  const parsedCacheMb = Number(cacheMbText.trim());
  const validCacheMb =
    cacheMbText.trim().length > 0 &&
    Number.isInteger(parsedCacheMb) &&
    parsedCacheMb >= 1 &&
    parsedCacheMb <= 100_000;

  const dirty =
    Boolean(apiKey.trim()) ||
    form.model !== saved.model ||
    form.voice !== saved.voice ||
    form.region !== saved.region ||
    form.auto !== saved.auto ||
    cacheMbText.trim() !== String(saved.cacheMb);

  const handleSave = async (clearKey = false) => {
    if (!prepared || !canManage) return;
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
        model: form.model.trim() || DEFAULT_TTS_SETTINGS.model,
        voice: form.voice.trim() || DEFAULT_TTS_SETTINGS.voice,
        region: form.region,
        auto: form.auto,
        cacheMb,
      };
      await runEnvironmentSpeech(
        saveEnvironmentTtsSettings(prepared, {
          ...next,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(clearKey ? { clearKey: true } : {}),
        }),
      );
      setSaved(next);
      setForm(next);
      setCacheMbText(String(next.cacheMb));
      if (clearKey) setHasKey(false);
      else if (apiKey.trim()) setHasKey(true);
      setApiKey("");
      const stats = await runEnvironmentSpeech(getEnvironmentTtsCacheStats(prepared));
      setCache(stats);
      await ttsModes.refresh(prepared).catch(() => undefined);
      setStatus(clearKey ? "API key removed" : "Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save MiniMax speech settings");
    } finally {
      setSaving(false);
    }
  };

  const handleClearCache = async () => {
    if (!prepared || !canManage) return;
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
      const res = await runEnvironmentSpeech(clearEnvironmentTtsCache(prepared));
      setCache({ files: 0, bytes: 0 });
      setStatus(
        res.files > 0
          ? `Cleared ${res.files} cached ${res.files === 1 ? "file" : "files"} (${formatMegabytes(res.bytes)})`
          : "Cache is already empty",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear audio cache");
    } finally {
      setClearing(false);
    }
  };

  const controlsDisabled = !prepared || !canManage || loading || saving;

  return (
    <SettingsSection id={searchableSetting("minimax-speech").id} title="MiniMax speech">
      <SettingsRow
        title="API key"
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
                onClick={() => void handleSave(true)}
              >
                Remove saved key
              </Button>
            ) : null}
          </div>
        }
      />

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
        description={`${cache.files} ${cache.files === 1 ? "file" : "files"} · ${formatMegabytes(cache.bytes)} used`}
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
              {clearing ? "Clearing…" : confirmClear ? "Tap again to clear" : "Clear cache"}
            </Button>
          </div>
        }
      />

      <AdvancedSettings targetIds={[searchableSetting("minimax-speech").id]}>
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
      </AdvancedSettings>

      <div className="flex items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 text-xs">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : status ? (
            <span className="text-muted-foreground">{status}</span>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || controlsDisabled}
          onClick={() => void handleSave(false)}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </SettingsSection>
  );
}
