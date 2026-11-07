import { type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ArrowUpRightIcon, PauseIcon, PlayIcon, Volume2Icon, XIcon } from "lucide-react";
import { memo } from "react";

import {
  clearMinimaxAutoplayQueue,
  useMinimaxAutoplay,
  useWebPlayer,
  webPlayer,
} from "../../speech/minimaxTts";
import { useQuietThreadShells, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const SidebarNowPlaying = memo(function SidebarNowPlaying() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const prepared = Option.getOrNull(usePreparedConnection(primaryEnvironmentId));
  const shells = useQuietThreadShells();

  const activeThreadIds = new Set<string>();
  for (const shell of shells) {
    if (shell.archivedAt === null) {
      activeThreadIds.add(shell.id);
    }
  }

  useMinimaxAutoplay(prepared, activeThreadIds);

  const audio = useWebPlayer();
  const targetEnvironmentId = audio.environmentId ?? primaryEnvironmentId;
  const threadShell = useThreadShell(
    targetEnvironmentId && audio.threadId
      ? { environmentId: targetEnvironmentId, threadId: audio.threadId as ThreadId }
      : null,
  );

  if (!audio.id || audio.ended) return null;

  const title = threadShell?.title || audio.title || "Reading aloud";
  const canNavigate = Boolean(targetEnvironmentId && audio.threadId);
  const progress =
    audio.duration > 0 ? Math.min(100, Math.max(0, (audio.position / audio.duration) * 100)) : 0;

  const handleOpenThread = () => {
    if (!targetEnvironmentId || !audio.threadId) return;
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: targetEnvironmentId,
        threadId: audio.threadId as ThreadId,
      },
    });
  };

  return (
    <div className="border-border/80 bg-muted/40 relative flex items-center gap-1 overflow-hidden rounded-lg border p-1 text-xs">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={!canNavigate}
              onClick={handleOpenThread}
              aria-label={canNavigate ? `Jump to ${title}` : title}
              className="group text-foreground enabled:hover:bg-accent/70 focus-visible:ring-ring flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:outline-none disabled:cursor-default"
            />
          }
        >
          <Volume2Icon className="text-primary size-3.5 shrink-0" />
          <span className="truncate font-medium group-hover:underline group-hover:underline-offset-2">
            {audio.playing ? "" : "Paused \u00b7 "}
            {title}
          </span>
          {canNavigate ? (
            <ArrowUpRightIcon className="text-muted-foreground group-hover:text-foreground ml-auto size-3 shrink-0 opacity-60 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">{canNavigate ? `Jump to chat: ${title}` : title}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={audio.playing ? "Pause" : "Resume"}
              onClick={() => void webPlayer.toggle()}
            />
          }
        >
          {audio.playing ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{audio.playing ? "Pause" : "Resume"}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Stop"
              onClick={() => {
                clearMinimaxAutoplayQueue();
                webPlayer.dispose();
              }}
            />
          }
        >
          <XIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Stop</TooltipPopup>
      </Tooltip>
      {progress > 0 ? (
        <div className="bg-border/40 pointer-events-none absolute inset-x-0 bottom-0 h-0.5">
          <div
            className="bg-primary/70 h-full transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
    </div>
  );
});
