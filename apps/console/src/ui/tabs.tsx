"use client";

import Link from "@/ui/link";

import { cn } from "@/lib/cn";

export type TabItem = {
  href: string;
  label: React.ReactNode;
  active: boolean;
  count?: number;
};

/** Tabs that are links: each tab is a URL, so back/forward and sharing work. */
export function TabNav({ className, items, label }: { className?: string; items: TabItem[]; label: string }) {
  return (
    <nav aria-label={label} className={cn("-mb-px flex gap-1 overflow-x-auto", className)}>
      {items.map((item) => (
        <Link
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm transition-colors",
            item.active ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink",
          )}
          href={item.href}
          key={item.href}
        >
          {item.label}
          {item.count !== undefined ? (
            <span className="rounded-full bg-sunken px-1.5 text-xs text-ink-3">{item.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

/** A small set of mutually exclusive options held in local state. */
export function Segmented<T extends string>({
  className,
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  label: string;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: React.ReactNode }>;
  value: T;
}) {
  return (
    <div aria-label={label} className={cn("inline-flex rounded-md border border-line bg-sunken p-0.5", className)} role="radiogroup">
      {options.map((option) => (
        <button
          aria-checked={option.value === value}
          className={cn(
            "h-7 rounded px-2.5 text-[13px] transition-colors",
            option.value === value ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-3 hover:text-ink",
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
