"use client";

import { Check, Copy, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { buttonClass, type ButtonSize } from "./button";

async function writeClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return {
    copied,
    copy: async (value: string) => {
      const ok = await writeClipboard(value);
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    },
  };
}

/** Copies `value`. With children it is a labelled button, without it an icon button. */
export function CopyButton({
  children,
  className,
  icon = Copy,
  label = "Copy",
  size = "sm",
  value,
  variant = "ghost",
}: {
  children?: React.ReactNode;
  className?: string;
  /** Shown until the value is copied. */
  icon?: LucideIcon;
  label?: string;
  size?: ButtonSize;
  value: string;
  variant?: "ghost" | "secondary";
}) {
  const { copied, copy } = useCopy();
  const Icon = copied ? Check : icon;
  const iconOnly = !children;
  return (
    <button
      aria-label={iconOnly ? (copied ? "Copied" : label) : undefined}
      className={cn(
        buttonClass({ size, variant }),
        iconOnly && (size === "sm" ? "w-8 px-0" : "w-9 px-0"),
        copied && "text-ok",
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        void copy(value);
      }}
      title={iconOnly ? label : undefined}
      type="button"
    >
      <Icon aria-hidden size={size === "sm" ? 14 : 16} />
      {children ? (copied ? "Copied" : children) : null}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}

/** A command or snippet the reader is meant to copy. */
export function CodeBlock({
  className,
  code,
  copyLabel = "Copy command",
  label,
}: {
  className?: string;
  code: string;
  /** What the copy button says it copies, for text that isn't a command. */
  copyLabel?: string;
  label?: string;
}) {
  return (
    <div className={cn("group relative rounded-md border border-line bg-sunken", className)}>
      {label ? <div className="border-b border-line px-3 py-1.5 text-xs text-ink-3">{label}</div> : null}
      <pre className="overflow-x-auto px-3 py-2.5 pr-12 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink">
        {code}
      </pre>
      <CopyButton className="absolute top-1.5 right-1.5" label={copyLabel} value={code} />
    </div>
  );
}

/** Short copyable value shown inline, such as a hostname or id. */
export function CopyValue({ className, display, value }: { className?: string; display?: React.ReactNode; value: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <span className="truncate font-mono text-[13px] text-ink">{display ?? value}</span>
      <CopyButton label="Copy" value={value} />
    </span>
  );
}
