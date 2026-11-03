import { cn } from "@/lib/cn";

export type Tone = "neutral" | "ok" | "warn" | "err" | "info";

const badgeTones: Record<Tone, string> = {
  neutral: "bg-sunken text-ink-2 ring-line",
  ok: "bg-ok-soft text-ok ring-transparent",
  warn: "bg-warn-soft text-warn ring-transparent",
  err: "bg-err-soft text-err ring-transparent",
  info: "bg-info-soft text-info ring-transparent",
};

const dotTones: Record<Tone, string> = {
  neutral: "bg-ink-3",
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  info: "bg-info",
};

export function Badge({
  children,
  className,
  dot,
  title,
  tone = "neutral",
}: {
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
  title?: string;
  tone?: Tone;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium ring-1 ring-inset",
        badgeTones[tone],
        className,
      )}
      title={title}
    >
      {dot ? <span aria-hidden className={cn("size-1.5 rounded-full", dotTones[tone])} /> : null}
      {children}
    </span>
  );
}

export function StatusDot({ className, label, tone = "neutral" }: { className?: string; label?: string; tone?: Tone }) {
  return (
    <span
      aria-label={label}
      className={cn("inline-block size-2 shrink-0 rounded-full", dotTones[tone], className)}
      role={label ? "img" : undefined}
    />
  );
}

const avatarPalette = [
  "bg-[#dff3e6] text-[#1f5b3c]",
  "bg-[#e8e4fb] text-[#4a3a9a]",
  "bg-[#fbe9d8] text-[#8a4b12]",
  "bg-[#dcecf7] text-[#1f4f74]",
  "bg-[#f6dfe6] text-[#8a2948]",
];

export function Avatar({
  className,
  label,
  seed,
  size = "md",
}: {
  className?: string;
  label: string;
  seed?: string;
  size?: "sm" | "md" | "lg";
}) {
  const key = seed || label || "?";
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const palette = avatarPalette[hash % avatarPalette.length];
  const initial = (label.trim() || "?").slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-md font-semibold",
        size === "sm" && "size-6 text-[11px]",
        size === "md" && "size-7 text-xs",
        size === "lg" && "size-10 text-base",
        palette,
        className,
      )}
    >
      {initial}
    </span>
  );
}
