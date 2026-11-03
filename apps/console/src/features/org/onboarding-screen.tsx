"use client";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConsoleApiError } from "@ravi/console-sdk";
import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { Panel } from "@/ui/layout";
import { ErrorState, NoAccess, Notice, Skeleton } from "@/ui/states";
import { OrgArea } from "./org-area";
import { useOrganizationAccess } from "./access";
import { useNodeClient } from "./node-queries";
import { ConnectionInstructions, InstallationCheck } from "./managed-installations";

function useGuide() {
  const { sdk, key } = useNodeClient(), access = useOrganizationAccess();
  const allowed = access.allows("organization.onboarding.read") && access.allows("organization.installations.read");
  const query = useQuery({ queryKey: key("onboarding"), queryFn: () => sdk.onboarding.state({}), enabled: allowed, staleTime: 0, retry: false, refetchInterval: 10_000 });
  return { query, allowed, access, sdk, key };
}
export function OnboardingReminder() {
  const { query, allowed } = useGuide();
  if (!allowed || query.isPending || query.isError || query.data.completed) return null;
  return <div className="mb-5 max-w-2xl"><Notice title="Conclua a instalação" tone="info">Conecte seu Ravi e verifique a conexão.<div className="mt-3"><Button href="/org/onboarding">Continuar instalação</Button></div></Notice></div>;
}
export function OnboardingScreen() {
  const { query, allowed, access, sdk, key } = useGuide(), client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const intent = useRef<{ operationId: string; snapshot: string } | null>(null);
  async function finish() {
    if (busy || !query.data) return;
    setBusy(true); setError(null);
    if (intent.current?.snapshot !== query.data.snapshot) intent.current = { operationId: crypto.randomUUID(), snapshot: query.data.snapshot };
    try { client.setQueryData(key("onboarding"), await sdk.onboarding.finish(intent.current)); }
    catch (failure) {
      setError(failure instanceof ConsoleApiError && failure.code === "version_conflict"
        ? "O estado mudou. Confira a instalação atualizada antes de concluir."
        : "Não foi possível concluir. Verifique a conexão e o resultado do teste antes de tentar novamente.");
      await query.refetch();
    } finally { setBusy(false); }
  }
  return <OrgArea tab="onboarding">{!allowed ? <NoAccess title="Acesso necessário à instalação" /> : query.isPending ? <Skeleton className="h-64" />
    : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    : <div className="max-w-3xl space-y-5">
      {query.data.completed ? <>
        <Notice title="Instalação concluída" tone="info">A configuração foi concluída. Acompanhe o estado atual e administre suas instalações pelo Console.
          <div className="mt-4"><Button variant="primary" href="/org/installations">Gerenciar instalações</Button></div>
        </Notice>
        <Panel padded><h2 className="font-medium">Quando precisar</h2><p className="mt-1 text-sm text-ink-2">Adicione outra instalação ou gerencie os acessos da equipe. Essas etapas são opcionais.</p>
          <div className="mt-4 flex flex-wrap gap-2"><Button href="/org/installations">Conectar outro Ravi</Button>{access.allows("organization.members.read") && <Button href="/org/members">Gerenciar pessoas</Button>}</div>
        </Panel>
      </> : <>
        <div><h2 className="text-lg font-semibold">Conclua sua instalação</h2><p className="mt-1 text-sm text-ink-2">Associe o Ravi e confirme que ele está disponível para gestão.</p></div>
        {!query.data.installations.some(node => node.status !== "revoked") ? <ConnectionInstructions /> : query.data.installations.filter(node => node.status !== "revoked").map(node =>
          <Panel key={node.id} padded><h3 className="font-medium">{node.name}</h3><p className="mb-4 mt-1 text-sm text-ink-2">{node.status === "online" ? "Conexão estabelecida" : "Aguardando a instalação se conectar…"}</p>
            {!query.data.ready && node.status === "online" && access.allows("organization.installations.manage") && <InstallationCheck node={node} />}
          </Panel>)}
        {query.data.ready && access.allows("organization.onboarding.manage") && <Panel padded><h3 className="font-medium">Tudo pronto para concluir</h3><p className="mt-1 text-sm text-ink-2">A instalação está conectada e respondeu ao teste.</p><div className="mt-4"><Button variant="primary" loading={busy} onClick={() => void finish()}>Concluir instalação</Button></div></Panel>}
        {error && <FormMessage>{error}</FormMessage>}
      </>}
    </div>}
  </OrgArea>;
}
