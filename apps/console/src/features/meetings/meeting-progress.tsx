"use client";

import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { formatDate, formatRelative } from "@/ui/time";

import { formatClock, meetingSteps, type MeetingStep } from "./format";
import type { Meeting } from "./types";

/** Where the bot is between being sent and a ready recording, one step per line. */
export function MeetingProgress({ meeting }: { meeting: Meeting }) {
  const steps = meetingSteps(meeting);
  return (
    <ol aria-label="Progress" className="space-y-0">
      {steps.map((step, index) => (
        <li className="relative flex gap-3 pb-5 last:pb-0" key={step.key}>
          {index < steps.length - 1 ? (
            <span
              aria-hidden
              className={cn("absolute top-7 bottom-1 left-3 w-px -translate-x-1/2", step.state === "done" ? "bg-ok/40" : "bg-line")}
            />
          ) : null}
          <StepMark meeting={meeting} step={step} />
          <div className="min-w-0 pt-0.5">
            <div className={cn("text-sm", step.state === "upcoming" ? "text-ink-3" : "font-medium text-ink")}>{step.label}</div>
            <StepWhen meeting={meeting} step={step} />
            {step.detail ? <p className={cn("mt-0.5 text-[13px]", step.state === "failed" ? "text-err" : "text-ink-2")}>{step.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepMark({ meeting, step }: { meeting: Meeting; step: MeetingStep }) {
  if (step.state === "done") {
    return (
      <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
        <Check aria-hidden size={14} strokeWidth={2.5} />
      </span>
    );
  }
  if (step.state === "failed") {
    return (
      <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-err-soft text-err">
        <X aria-hidden size={14} strokeWidth={2.5} />
      </span>
    );
  }
  if (step.state === "upcoming") {
    return <span className="relative size-6 shrink-0 rounded-full border border-dashed border-line-strong bg-canvas" />;
  }
  const tone = meeting.status === "recording" ? "err" : meeting.status === "waiting_room" ? "warn" : "info";
  return (
    <span
      className={cn(
        "relative flex size-6 shrink-0 items-center justify-center rounded-full",
        tone === "err" ? "bg-err-soft" : tone === "warn" ? "bg-warn-soft" : "bg-info-soft",
      )}
    >
      <span
        className={cn(
          "absolute inline-flex size-2.5 animate-ping rounded-full opacity-60 motion-reduce:animate-none",
          tone === "err" ? "bg-err" : tone === "warn" ? "bg-warn" : "bg-info",
        )}
      />
      <span className={cn("relative size-2 rounded-full", tone === "err" ? "bg-err" : tone === "warn" ? "bg-warn" : "bg-info")} />
    </span>
  );
}

function StepWhen({ meeting, step }: { meeting: Meeting; step: MeetingStep }) {
  if (!step.since) return null;
  if (step.key === "recording" && step.state === "current") return <Elapsed since={step.since} />;
  if (step.key === "scheduled" && step.state === "current") {
    return (
      <div className="text-[13px] text-ink-3">
        {formatDate(step.since, true)} · {formatRelative(step.since)}
      </div>
    );
  }
  if (step.key === "join" || (step.state === "upcoming" && step.key !== "scheduled")) return null;
  return <div className="text-[13px] text-ink-3">{formatDate(step.since, true)}</div>;
}

/** A live counter while Ravi records. */
function Elapsed({ since }: { since: string }) {
  const start = Date.parse(since);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = now === null || !Number.isFinite(start) ? null : formatClock(Math.max(0, (now - start) / 1000));
  return (
    <div className="text-[13px] text-ink-3">
      Since {formatDate(since, true)}
      {elapsed ? (
        <>
          {" · "}
          <span className="font-mono text-err tabular-nums">{elapsed}</span> so far
        </>
      ) : null}
    </div>
  );
}
