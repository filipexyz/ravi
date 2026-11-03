"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";

import { libraryErrorText, useRecordWidgetAudit } from "@/features/library/api";
import type { LibraryItem, LibraryItemVersion } from "@/features/library/types";
import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { Section } from "@/ui/layout";
import { Notice } from "@/ui/states";
import { formatDate } from "@/ui/time";
import type { CompiledTheme, LibraryFileText } from "@/shared/widgets/types";

import { runWidgetAudit, type ScriptAuditOutcome } from "./script-audit";
import { ScriptAuditReport } from "./script-audit-panel";

export const SCRIPT_AUDIT_SECTION_ID = "auditoria";

/**
 * A widget version with code: its accessibility audit (JS-CONTRACT J3).
 * Pages refuse a version whose stored audit does not pass for its
 * widget.js (`KIT_WIDGET_UNAUDITED`, with a link here). An org owner or
 * admin runs it: the card from example.json with the code running, axe-core
 * over it, and the result stored on the version. A run where the code
 * throws is shown and not stored.
 */
export function WidgetScriptAuditSection({
  files,
  item,
  run = runWidgetAudit,
  theme,
  version,
}: {
  files: readonly LibraryFileText[];
  item: Pick<LibraryItem, "ref">;
  /** The audit runner (tests pass one). */
  run?: (files: readonly LibraryFileText[], theme: CompiledTheme) => Promise<ScriptAuditOutcome | null>;
  theme: CompiledTheme;
  version: Pick<LibraryItemVersion, "number" | "script" | "scriptAudit" | "scriptAudited" | "canAudit">;
}) {
  const record = useRecordWidgetAudit();
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<ScriptAuditOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!version.script) return null;
  const stored = version.scriptAudit && version.scriptAudit.scriptSha256 === version.script.sha256 ? version.scriptAudit : null;

  const audit = async () => {
    setError(null);
    setOutcome(null);
    setRunning(true);
    try {
      const result = await run(files, theme);
      if (!result) {
        setError("Os arquivos desta versão não compilam, então a auditoria não roda.");
        return;
      }
      setOutcome(result);
      if (result.errors.length) return;
      const { errors: _errors, ...body } = result;
      await record.mutateAsync({ ref: item.ref, version: version.number, audit: body });
    } catch (failure) {
      setError(libraryErrorText(failure) ?? "Não deu para rodar ou gravar a auditoria. Tente de novo.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Section
      description="Com o código, o card de example.json passa pelo axe-core nos modos claro e escuro. Violações sérias ou críticas reprovam, e uma página só usa esta versão depois que a auditoria passa."
      id={SCRIPT_AUDIT_SECTION_ID}
      title="Acessibilidade do código"
    >
      <div className="space-y-3">
        {outcome || running ? (
          <ScriptAuditReport outcome={outcome} running={running} />
        ) : stored ? (
          <div className="space-y-1.5">
            <ScriptAuditReport outcome={{ ...stored, errors: [] }} />
            <p className="text-[13px] text-ink-3">{`Auditoria gravada em ${formatDate(stored.auditedAt, true)}.`}</p>
          </div>
        ) : (
          <Notice title="Ainda sem auditoria" tone="warn">
            {version.scriptAudit
              ? "A auditoria gravada é de outro widget.js. Páginas não usam esta versão até uma nova auditoria passar."
              : "Páginas não usam esta versão até a auditoria passar."}
          </Notice>
        )}
        {error ? <FormMessage>{error}</FormMessage> : null}
        {record.isSuccess && outcome && !running ? (
          <p className="text-[13px] text-ink-3" role="status">
            {outcome.status === "pass" ? "Auditoria gravada. Páginas já podem usar esta versão." : "Auditoria gravada como reprovada."}
          </p>
        ) : null}
        {version.canAudit ? (
          <Button icon={ShieldCheck} loading={running} onClick={() => void audit()} variant="secondary">
            {stored || outcome ? "Rodar a auditoria de novo" : "Rodar a auditoria"}
          </Button>
        ) : version.scriptAudited ? null : (
          <p className="text-[13px] text-ink-3">Peça a um owner ou admin da organização para abrir esta página e rodar a auditoria.</p>
        )}
      </div>
    </Section>
  );
}
