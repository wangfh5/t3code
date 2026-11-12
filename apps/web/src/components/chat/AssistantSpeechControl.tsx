import {
  cancelEnvironmentTts,
  getEnvironmentTtsSpeechStatus,
  synthesizeEnvironmentTts,
} from "@t3tools/client-runtime/voice-input";
import {
  type EnvironmentId,
  type ThreadId,
  type TtsAuto,
  type TtsSpeechState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { PauseIcon, PlayIcon, Volume2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  clearMinimaxAutoplayQueue,
  clock,
  ttsModes,
  useTtsModes,
  useWebPlayer,
  webPlayer,
} from "../../speech/minimaxTts";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { useThreadShell } from "../../state/entities";
import { usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const AUTO_MODES: readonly TtsAuto[] = ["off", "synthesize", "play"];

const AUTO_MODE_LABELS: Record<TtsAuto, string> = {
  off: "Off",
  synthesize: "Synthesize",
  play: "Play",
};

export function AssistantSpeechControl({
  messageId,
  text,
  streaming,
  environmentId,
  threadId,
  onVisibilityHoldChange,
}: {
  readonly messageId: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly onVisibilityHoldChange?: (hold: boolean) => void;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const threadShell = useThreadShell(
    environmentId && threadId ? { environmentId, threadId } : null,
  );
  const audio = useWebPlayer();
  const modes = useTtsModes(prepared);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<TtsSpeechState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  const trimmedText = text.trim();
  const hasText = trimmedText.length > 0 && trimmedText !== "(empty response)";
  const mine = audio.id === messageId && !audio.ended;
  const working = busy || state === "working";
  const holdVisible = working || mine || Boolean(error) || Boolean(mine && audio.error) || menuOpen;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps parent message footer visible while audio playback, synthesis, or the mode menu is open
  useEffect(() => {
    onVisibilityHoldChange?.(holdVisible);
    return () => {
      onVisibilityHoldChange?.(false);
    };
  }, [holdVisible, onVisibilityHoldChange]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- queries server synthesis/cache status for this assistant message on mount
  useEffect(() => {
    if (!prepared || streaming || !messageId) return;
    let cancelled = false;
    void runEnvironmentSpeech(getEnvironmentTtsSpeechStatus(prepared, messageId))
      .then((res) => {
        if (cancelled) return;
        setError(null);
        // If the reply aged out of the server's 20-item ring buffer after a restart,
        // we still have its text in the timeline and can synthesize on demand.
        setState(res.state === "expired" && hasText ? "idle" : res.state);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [prepared, streaming, messageId, hasText]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls server synthesis status timer while background synthesis is in progress
  useEffect(() => {
    if (!prepared || state !== "working") return;
    const timer = window.setInterval(() => {
      void runEnvironmentSpeech(getEnvironmentTtsSpeechStatus(prepared, messageId))
        .then((res) => {
          setState(res.state === "expired" && hasText ? "idle" : res.state);
        })
        .catch(() => undefined);
    }, 800);
    return () => window.clearInterval(timer);
  }, [prepared, state, messageId, hasText]);

  if (streaming || (!hasText && state !== "ready" && !mine)) {
    return null;
  }

  const chatKey = threadId ?? "";
  const override = chatKey ? modes.chats[chatKey] : undefined;
  const effectiveAuto = override ?? modes.auto;

  const handleToggleSpeech = async () => {
    if (!prepared) return;
    if (working) {
      setBusy(false);
      setState("idle");
      await runEnvironmentSpeech(cancelEnvironmentTts(prepared, { id: messageId })).catch(
        () => undefined,
      );
      return;
    }
    setError(null);
    clearMinimaxAutoplayQueue();
    if (mine) {
      try {
        await webPlayer.toggle();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Playback failed");
      }
      return;
    }

    setBusy(true);
    setState("working");
    try {
      const res = await runEnvironmentSpeech(
        synthesizeEnvironmentTts(prepared, {
          id: messageId,
          ...(threadId ? { threadId } : {}),
          ...(hasText ? { text: trimmedText } : {}),
        }),
      );
      setState("ready");
      await webPlayer.play({
        id: messageId,
        threadId: threadId ?? undefined,
        environmentId: environmentId ?? undefined,
        title: threadShell?.title ?? "Reading aloud",
        base64: res.base64,
        mimeType: res.mimeType,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to synthesize speech";
      setState("idle");
      if (message !== "Speech synthesis cancelled") {
        setError(message);
      }
    }
    setBusy(false);
  };

  const handleSelectMode = async (next: TtsAuto | null) => {
    if (!prepared || !chatKey) return;
    setError(null);
    try {
      await ttsModes.setChat(prepared, chatKey, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update chat auto mode");
    }
  };

  const duration = mine ? audio.duration : 0;
  const position = dragPos ?? (mine ? audio.position : 0);
  const progress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const activeError = error || (mine ? audio.error : undefined);

  const posFromClientX = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || duration <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const buttonLabel = working
    ? "Cancel synthesis"
    : mine
      ? audio.playing
        ? "Pause"
        : "Resume"
      : state === "ready"
        ? "Read aloud (cached)"
        : "Read aloud";

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!prepared || (!working && state === "expired" && !hasText)}
              onClick={() => void handleToggleSpeech()}
              aria-label={buttonLabel}
            />
          }
        >
          {working ? (
            <XIcon className="size-3" />
          ) : mine ? (
            audio.playing ? (
              <PauseIcon className="size-3" />
            ) : (
              <PlayIcon className="size-3" />
            )
          ) : (
            <Volume2Icon className={cn("size-3", state === "ready" && "text-primary")} />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{buttonLabel}</TooltipPopup>
      </Tooltip>

      {working ? (
        <span className="text-muted-foreground text-xs">Synthesizing…</span>
      ) : mine ? (
        <div className="inline-flex items-center gap-2">
          <div
            ref={barRef}
            role="slider"
            tabIndex={0}
            aria-label="Audio progress"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(position)}
            onPointerDown={(event) => {
              if (duration <= 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragPos(posFromClientX(event.clientX));
            }}
            onPointerMove={(event) => {
              if (dragPos === null) return;
              setDragPos(posFromClientX(event.clientX));
            }}
            onPointerUp={(event) => {
              if (dragPos === null) return;
              const next = posFromClientX(event.clientX);
              setDragPos(null);
              void webPlayer.seek(next);
            }}
            onPointerCancel={() => setDragPos(null)}
            className="flex h-4 w-24 cursor-pointer items-center select-none sm:w-28"
          >
            <div className="bg-muted relative h-1 w-full rounded-full">
              <div
                className="bg-primary h-full rounded-full"
                style={{ width: `${progress * 100}%` }}
              />
              <div
                className="bg-primary absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ left: `${progress * 100}%` }}
              />
            </div>
          </div>
          <span className="text-muted-foreground text-xs tabular-nums">
            {clock(position)} / {clock(duration)}
          </span>
        </div>
      ) : state === "ready" ? (
        <span className="text-muted-foreground text-xs">Ready</span>
      ) : null}

      {chatKey && prepared ? (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                aria-label="Automatic speech mode for this chat"
              />
            }
          >
            Auto: {effectiveAuto}
            {override ? " *" : ""}
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuRadioGroup
              value={effectiveAuto}
              onValueChange={(value) => {
                if (value === "off" || value === "synthesize" || value === "play") {
                  void handleSelectMode(value);
                }
              }}
            >
              {AUTO_MODES.map((item) => (
                <MenuRadioItem key={item} value={item}>
                  {AUTO_MODE_LABELS[item]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            {override ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => void handleSelectMode(null)}>
                  Default ({modes.auto})
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}

      {activeError ? <span className="text-destructive text-xs">{activeError}</span> : null}
    </div>
  );
}
