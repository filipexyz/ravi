"use client";

import { MessageSquareText } from "lucide-react";

import { CodeBlock } from "@/ui/copy";

/** A prompt the person can send to their agent, set apart like a chat message. */
export function PromptExample({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-line bg-surface px-3.5 py-3 text-sm text-ink">
      <MessageSquareText aria-hidden className="mt-0.5 shrink-0 text-ink-3" size={16} />
      <p className="min-w-0">{children}</p>
    </div>
  );
}

/** How bases come to exist: from a conversation with an agent, which runs the CLI. */
export function CreateBaseHelp({ projectSlug }: { projectSlug: string }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-[13px] font-medium text-ink-2">Peça ao seu agente, por exemplo</p>
        <PromptExample>
          “Crie uma base para as tarefas deste projeto com título, status (a fazer, fazendo, feito), responsável e prazo.
          Depois faça uma página onde cada pessoa vê as próprias tarefas.”
        </PromptExample>
      </div>
      <CodeBlock
        code={`ravi bases create "Tarefas" --slug tarefas --project ${projectSlug} --json`}
        label="O agente roda o CLI, por exemplo"
      />
    </div>
  );
}

/** How a base changes: schema, views and access are edited by an agent, never here. */
export function ChangeBaseHelp({ baseSlug, projectSlug }: { baseSlug: string; projectSlug: string }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">
        Esta tela só mostra a base. Propriedades, views, quem pode lê-las e as próprias linhas são alteradas pelos seus
        agentes na conversa, e as páginas que as pessoas usam também são feitas por eles.
      </p>
      <div className="space-y-1.5">
        <p className="text-[13px] font-medium text-ink-2">Peça ao seu agente, por exemplo</p>
        <PromptExample>
          “Na base {baseSlug}, adicione uma propriedade de prioridade com baixa, média e alta, e mostre-a na view que meu
          time usa.”
        </PromptExample>
      </div>
      <CodeBlock code={`ravi bases show ${baseSlug} --project ${projectSlug} --json`} label="Para ler a mesma base pelo CLI" />
    </div>
  );
}
