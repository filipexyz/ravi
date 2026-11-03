"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import { useId } from "react";

import { cn } from "@/lib/cn";
import { THEME_TOKENS } from "@/shared/widgets/theme/tokens";
import type { CompiledTheme, ContrastCheck, ContrastReport, ThemeMode } from "@/shared/widgets/types";

import { colorGroups, contrastPairLabel, MODE_WORDS, tokenLabel } from "./theme-form";

export function formatRatio(ratio: number) {
  return `${ratio.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}:1`;
}

/** "N de M pares passam.", counted from the report (the engine owns the list of pairs). */
export function contrastSummary(report: ContrastReport) {
  const passing = report.checks.filter((check) => check.ok).length;
  return `${passing} de ${report.checks.length} pares passam.`;
}

/**
 * The failing pairs in the open, then every pair the report holds behind a
 * disclosure, so a passing theme's report does not fill the page.
 */
export function ContrastChecks({ onSelect, report }: { onSelect?: (check: ContrastCheck) => void; report: ContrastReport }) {
  const failing = report.checks.filter((check) => !check.ok);
  return (
    <div className="space-y-2">
      {failing.length ? <ContrastTable caption="Pares abaixo do mínimo" checks={failing} onSelect={onSelect} /> : null}
      <details className="rounded-md border border-line bg-surface px-3 py-2">
        <summary className="cursor-pointer text-sm text-ink-2">{`Todos os pares (${report.checks.length})`}</summary>
        <ContrastTable caption="Contraste de todos os pares, nos modos claro e escuro" checks={report.checks} className="mt-3" onSelect={onSelect} />
      </details>
    </div>
  );
}

/**
 * The contrast report as a table: pair, mode, ratio, minimum and result in
 * words (with an icon, never color alone). Failing rows can link to the
 * token to fix (`onSelect`).
 */
export function ContrastTable({
  caption,
  checks,
  className,
  onSelect,
}: {
  caption: string;
  checks: readonly ContrastCheck[];
  className?: string;
  onSelect?: (check: ContrastCheck) => void;
}) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-line bg-surface", className)}>
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left text-ink-3">
            <th className="px-3 py-2 font-medium" scope="col">
              Par
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              Modo
            </th>
            <th className="px-3 py-2 text-right font-medium" scope="col">
              Contraste
            </th>
            <th className="px-3 py-2 text-right font-medium" scope="col">
              Mínimo
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              Resultado
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {checks.map((check) => {
            const label = contrastPairLabel(check.pair);
            return (
              <tr className={cn(!check.ok && "bg-err-soft")} key={`${check.mode}-${check.pair.join("-")}`}>
                <th className="px-3 py-2 text-left font-normal text-ink" scope="row">
                  {onSelect && !check.ok ? (
                    <button className="text-left underline underline-offset-2 hover:no-underline" onClick={() => onSelect(check)} type="button">
                      {label}
                    </button>
                  ) : (
                    label
                  )}
                </th>
                <td className="px-3 py-2 whitespace-nowrap text-ink-2">{MODE_WORDS[check.mode]}</td>
                <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-ink">{formatRatio(check.ratio)}</td>
                <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-ink-2">{formatRatio(check.min)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {check.ok ? (
                    <span className="inline-flex items-center gap-1 text-ok">
                      <CircleCheck aria-hidden size={14} />
                      Passa
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 font-medium text-err">
                      <CircleAlert aria-hidden size={14} />
                      Abaixo do mínimo
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Each color of a mode as a swatch with its name and hex value. */
export function ThemeSwatches({ mode, theme }: { mode: ThemeMode; theme: CompiledTheme }) {
  const headingId = useId();
  const vars = theme.vars[mode];
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 className="text-sm font-semibold text-ink" id={headingId}>
        {MODE_WORDS[mode]}
      </h3>
      {colorGroups(mode).map((group) => (
        <div className="space-y-1.5" key={group.id}>
          <h4 className="text-[13px] text-ink-3">{group.title}</h4>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
            {group.paths.map((path) => {
              const spec = THEME_TOKENS.find((token) => token.path === path);
              const value = spec ? vars[spec.cssVar] : undefined;
              return (
                <li className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-surface p-1.5" key={path}>
                  <span aria-hidden className="size-7 shrink-0 rounded border border-line-strong" style={{ background: value }} />
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] text-ink">{tokenLabel(path)}</span>
                    <span className="block font-mono text-[11.5px] text-ink-3">{value ?? "—"}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
