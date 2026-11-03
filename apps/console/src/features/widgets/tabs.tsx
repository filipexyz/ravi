"use client";

import { cn } from "@/lib/cn";

/**
 * Tabs inside one screen (the theme editor's form, JSON and files): a WAI-ARIA
 * tablist with arrow keys, Home and End. Panels stay mounted (hidden), so a
 * diagnostic can switch tabs and focus a field that is already there.
 */
export function Tabs<T extends string>({
  idPrefix,
  label,
  onChange,
  tabs,
  value,
}: {
  idPrefix: string;
  label: string;
  onChange: (value: T) => void;
  tabs: { id: T; label: React.ReactNode }[];
  value: T;
}) {
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next]!;
    onChange(tab.id);
    document.getElementById(`${idPrefix}-tab-${tab.id}`)?.focus();
  };
  return (
    <div aria-label={label} className="-mb-px flex gap-1 overflow-x-auto border-b border-line" onKeyDown={move} role="tablist">
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            aria-selected={selected}
            className={cn(
              "inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm transition-colors",
              selected ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink",
            )}
            id={`${idPrefix}-tab-${tab.id}`}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  active,
  children,
  className,
  id,
  idPrefix,
}: {
  active: boolean;
  children: React.ReactNode;
  className?: string;
  id: string;
  idPrefix: string;
}) {
  return (
    <div aria-labelledby={`${idPrefix}-tab-${id}`} className={className} hidden={!active} id={`${idPrefix}-panel-${id}`} role="tabpanel">
      {children}
    </div>
  );
}
