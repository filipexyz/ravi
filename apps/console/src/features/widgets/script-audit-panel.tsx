"use client";

import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import { Notice } from "@/ui/states";
import { BLOCKING_IMPACTS } from "@/shared/widgets/script/audit";
import type { RenderRecord, WidgetFieldSpec, WidgetScriptViolation } from "@/shared/widgets/types";

import type { PreviewView } from "./preview";
import { auditFrameDocument, auditToken, loadAxeSource, readAuditMessage, type ScriptAuditOutcome } from "./script-audit";

export const IMPACT_WORDS: Record<string, string> = { critical: "crítico", serious: "sério", moderate: "moderado", minor: "menor" };

function impactWord(impact: string | null) {
  return (impact && IMPACT_WORDS[impact]) ?? "sem impacto informado";
}

function ViolationList({ violations }: { violations: readonly WidgetScriptViolation[] }) {
  return (
    <ul className="mt-1 space-y-1.5">
      {violations.map((violation) => (
        <li className="text-[13px]" key={`${violation.id}-${violation.impact}`}>
          <span className={cn("font-medium", violation.impact && BLOCKING_IMPACTS.has(violation.impact) ? "text-err" : "text-ink")}>
            {`Impacto ${impactWord(violation.impact)}`}
          </span>
          {`: ${violation.help} `}
          <span className="font-mono text-ink-3">{violation.id}</span>
          {` (${violation.nodes === 1 ? "1 elemento" : `${violation.nodes} elementos`})`}
        </li>
      ))}
    </ul>
  );
}

/**
 * What an audit found, in PT-BR: passed, or each violation with its impact
 * and help, and any error the code threw. `serious` and `critical`
 * violations, and any error, stop a publish.
 */
export function ScriptAuditReport({ outcome, running = false }: { outcome: ScriptAuditOutcome | null; running?: boolean }) {
  if (running || !outcome) {
    return (
      <p className="text-[13px] text-ink-3" role="status">
        {running ? "Auditando a acessibilidade com o código rodando…" : "A auditoria de acessibilidade ainda não rodou."}
      </p>
    );
  }
  const blocking = outcome.violations.filter((violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact));
  const others = outcome.violations.filter((violation) => !blocking.includes(violation));
  const passed = outcome.status === "pass" && outcome.errors.length === 0;
  return (
    <div role="status">
      <Notice
        title={passed ? "Acessibilidade: passou" : outcome.errors.length && outcome.status === "pass" ? "O código falhou na prévia" : "Acessibilidade: não passou"}
        tone={passed ? "ok" : "err"}
      >
        {passed ? (
          <p>{others.length ? "Nenhuma violação séria ou crítica. Vale corrigir os avisos abaixo." : "Nenhuma violação encontrada pelo axe-core."}</p>
        ) : null}
        {outcome.errors.length ? (
          <>
            <p>O código lançou um erro, e uma versão assim não é publicada:</p>
            <ul className="mt-1 space-y-1">
              {outcome.errors.map((error, index) => (
                <li className="font-mono text-[12.5px]" key={index}>
                  {error}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {blocking.length ? (
          <>
            <p>{blocking.length === 1 ? "1 violação séria ou crítica impede publicar:" : `${blocking.length} violações sérias ou críticas impedem publicar:`}</p>
            <ViolationList violations={blocking} />
          </>
        ) : null}
        {others.length ? (
          <>
            <p className="mt-2">{others.length === 1 ? "1 aviso (não impede publicar):" : `${others.length} avisos (não impedem publicar):`}</p>
            <ViolationList violations={others} />
          </>
        ) : null}
      </Notice>
    </div>
  );
}

/**
 * The preview of a widget with code: the same document as the plain
 * preview, in a `sandbox="allow-scripts"` frame (opaque origin) that runs
 * widget.js on the cards and axe-core after it. Each new document reports
 * its outcome through `onOutcome` (null while it runs).
 */
export function ScriptPreviewFrame({
  code,
  fields,
  height = 480,
  html,
  onOutcome,
  records,
  scriptSha256,
  title,
  view,
}: {
  code: string;
  fields: Record<string, WidgetFieldSpec>;
  height?: number;
  html: string;
  onOutcome: (outcome: ScriptAuditOutcome | null) => void;
  records: readonly RenderRecord[];
  scriptSha256: string;
  title: string;
  view?: Partial<PreviewView>;
}) {
  const [axeSource, setAxeSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  useEffect(() => {
    let live = true;
    loadAxeSource().then(
      (source) => live && setAxeSource(source),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);
  const mode = view?.mode;
  const variant = view?.variant;
  const doc = useMemo(() => {
    if (axeSource === null) return null;
    const token = auditToken();
    return { token, srcDoc: auditFrameDocument({ html, code, records, fields, axeSource, token, view: { mode, variant } }) };
  }, [axeSource, html, code, records, fields, mode, variant]);

  useEffect(() => {
    if (!doc || !frame) return;
    onOutcome(null);
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const outcome = readAuditMessage(event.data, doc.token, scriptSha256);
      if (outcome) onOutcome(outcome);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [doc, frame, onOutcome, scriptSha256]);

  if (failed) {
    return (
      <Notice title="A prévia com código não carregou" tone="warn">
        O verificador de acessibilidade não carregou. Recarregue a página e tente de novo.
      </Notice>
    );
  }
  return (
    <div className="resize-y overflow-hidden rounded-lg border border-line bg-canvas" style={{ height }}>
      {doc ? (
        <iframe className="block size-full" ref={setFrame} referrerPolicy="no-referrer" sandbox="allow-scripts" srcDoc={doc.srcDoc} title={title} />
      ) : (
        <p className="p-4 text-[13px] text-ink-3" role="status">
          Carregando a prévia com código…
        </p>
      )}
    </div>
  );
}
