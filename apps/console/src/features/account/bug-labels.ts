import type { LucideIcon } from "lucide-react";
import { Bot, CheckCircle2, CircleDashed, CircleSlash, Copy, Monitor, ScanSearch, Terminal, User, Wrench } from "lucide-react";

import type {
  BugReportComment,
  BugReportPriority,
  BugReportSeverity,
  BugReportStatus,
} from "@/features/console/types";
import type { Tone } from "@/ui/badge";

/** Status in words a reporter understands, and what it means for them. */
export const BUG_STATUS: Record<
  BugReportStatus,
  { label: string; tone: Tone; icon: LucideIcon; meaning: string; open: boolean }
> = {
  submitted: {
    icon: CircleDashed,
    label: "Reported",
    meaning: "Ravi's team hasn't looked at it yet.",
    open: true,
    tone: "neutral",
  },
  triaging: {
    icon: ScanSearch,
    label: "Being looked at",
    meaning: "Ravi's team is reviewing it and deciding what to do.",
    open: true,
    tone: "info",
  },
  in_progress: {
    icon: Wrench,
    label: "Being fixed",
    meaning: "Someone is working on a fix.",
    open: true,
    tone: "info",
  },
  resolved: {
    icon: CheckCircle2,
    label: "Fixed",
    meaning: "A fix is out. If it still happens, report it again.",
    open: false,
    tone: "ok",
  },
  wontfix: {
    icon: CircleSlash,
    label: "Won't fix",
    meaning: "Ravi's team decided not to change this. The note says why when there is one.",
    open: false,
    tone: "neutral",
  },
  duplicate: {
    icon: Copy,
    label: "Duplicate",
    meaning: "The same problem was already reported, and it's tracked there.",
    open: false,
    tone: "neutral",
  },
};

export const BUG_SEVERITY: Record<BugReportSeverity, { label: string; tone: Tone }> = {
  critical: { label: "Critical", tone: "err" },
  high: { label: "High", tone: "warn" },
  medium: { label: "Medium", tone: "neutral" },
  low: { label: "Low", tone: "neutral" },
};

export const BUG_PRIORITY: Record<BugReportPriority, string> = {
  p0: "Urgent",
  p1: "High",
  p2: "Normal",
  p3: "Low",
};

export const COMMENT_SOURCE: Record<BugReportComment["source"], { label: string; icon: LucideIcon }> = {
  agent: { icon: Bot, label: "Your agent" },
  cli: { icon: Terminal, label: "Ravi CLI" },
  console: { icon: Monitor, label: "Console" },
  user: { icon: User, label: "You" },
};

export function bugStatus(status: string) {
  return BUG_STATUS[status as BugReportStatus] ?? BUG_STATUS.submitted;
}

export function bugSeverity(severity: string) {
  return BUG_SEVERITY[severity as BugReportSeverity] ?? { label: severity, tone: "neutral" as Tone };
}

/** `cli/runtime` → "CLI / runtime": where the problem happened. */
export function surfaceLabel(surface: string | null) {
  if (!surface) return null;
  const known: Record<string, string> = {
    channels: "Channels",
    cli: "CLI",
    console: "Console",
    daemon: "Daemon",
    pages: "Pages",
    runtime: "Runtime",
  };
  return surface
    .split("/")
    .map((part) => known[part.trim().toLowerCase()] ?? part.trim())
    .filter(Boolean)
    .join(" / ");
}
