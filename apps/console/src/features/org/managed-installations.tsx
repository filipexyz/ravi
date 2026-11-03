"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Installation } from "@ravi/operation-contracts/console";
import { CodeBlock } from "@/ui/copy";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/layout";
import { Field, Input, FormMessage } from "@/ui/form";
import { ErrorState, NoAccess, Notice, Skeleton } from "@/ui/states";
import { OrgArea } from "./org-area";
import { useManagedNodes, useNodeClient } from "./node-queries";
import { NodeChannels } from "./node-channels";

const statusLabel = { pending: "Aguardando conexão", online: "Conectada", offline: "Sem conexão", revoked: "Acesso revogado" };
const operationLabel = { queued: "Aguardando a instalação…", delivered: "Verificando…", succeeded: "Instalação verificada", failed: "A verificação falhou", uncertain: "Resultado ainda não confirmado", cancelled: "Operação cancelada" };

const emptyLocation = () => "";
const readOrigin = () => location.origin;
const readHash = () => location.hash;
const subscribeLocation = (notify: () => void) => {
  window.addEventListener("hashchange", notify); window.addEventListener("popstate", notify);
  return () => { window.removeEventListener("hashchange", notify); window.removeEventListener("popstate", notify); };
};
export function ConnectionInstructions() {
  const origin = useSyncExternalStore(subscribeLocation, readOrigin, emptyLocation);
  return <Panel padded><h3 className="font-medium">Conectar uma instalação</h3>
    <p className="mt-1 text-sm text-ink-2">Na máquina que vai executar o Ravi, rode o comando. Ele abre a confirmação neste Console.</p>
    <div className="mt-4">{origin ? <CodeBlock label="Comando de conexão" copyLabel="Copiar comando de conexão" code={`ravi console connect --url ${origin}`} /> : <p role="status">Preparando comando…</p>}</div>
    <p className="mt-3 text-sm text-ink-2">Use um ambiente separado do Console. No uso pessoal, uma VM com acesso limitado mantém os privilégios do executor fora desta máquina de gestão.</p>
  </Panel>;
}

export function InstallationCheck({ node }: { node: Installation }) {
  const { sdk, key } = useNodeClient(), client = useQueryClient();
  const [operationId, setOperationId] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const intent = useRef<string | null>(null);
  const latest = useQuery({ queryKey: key("latest", node.id, node.revision), queryFn: () => sdk.operations.latest({ installationId: node.id }), retry: false });
  const currentOperationId = operationId ?? latest.data?.operation?.id;
  const receipt = useQuery({ queryKey: key("operation", currentOperationId), queryFn: () => sdk.operations.show({ operationId: currentOperationId! }), enabled: !!currentOperationId,
    retry: false, refetchInterval: query => query.state.data && ["queued", "delivered"].includes(query.state.data.status) ? 2000 : false });
  const verified = receipt.data?.status === "succeeded";
  useEffect(() => { if (verified) { void client.invalidateQueries({ queryKey: key("onboarding") }); } }, [verified, client, key]);
  async function check() {
    if (busy) return;
    setBusy(true); setError(null);
    intent.current ??= crypto.randomUUID();
    try {
      const result = await sdk.operations.enqueue({ operationId: intent.current, installationId: node.id, command: { kind: "health" } });
      client.setQueryData(key("operation", result.id), result); client.setQueryData(key("latest", node.id, node.revision), { operation: result }); setOperationId(result.id);
    } catch { setError("Não foi possível confirmar o pedido. Tente novamente para consultar a mesma operação."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3">
    {(latest.isPending || (latest.isFetching && !currentOperationId)) && <p role="status" className="text-sm text-ink-2">Consultando o último teste…</p>}
    {latest.isError && <FormMessage>Não foi possível consultar o último teste. <button className="underline" onClick={() => void latest.refetch()}>Tentar novamente</button></FormMessage>}
    {!receipt.data && !currentOperationId && latest.isSuccess && !latest.isFetching && !latest.data.operation && <Button variant="primary" loading={busy} onClick={() => void check()}>Verificar instalação</Button>}
    {receipt.data && <div aria-live="polite" className="text-sm"><p className="font-medium">{operationLabel[receipt.data.status]}</p>
      <p className="mt-1 text-ink-2">{receipt.data.status === "uncertain" ? "Consulte o recibo antes de tentar outra operação. Uma resposta perdida não comprova falha." : verified ? "A instalação respondeu ao teste. Você pode concluir a configuração." : "Você pode sair desta tela; a operação permanece registrada."}</p>
      {receipt.data.result?.kind === "health" && <p className="mt-1 text-ink-2">Ravi {receipt.data.result.health.version} · {receipt.data.result.health.channels.length} canais configurados</p>}
      {["failed", "cancelled"].includes(receipt.data.status) && <Button className="mr-2 mt-2" loading={busy} onClick={() => { intent.current = null; void check(); }}>Realizar novo teste</Button>}
      {["uncertain", "failed", "cancelled"].includes(receipt.data.status) && <Button className="mt-2" onClick={() => void receipt.refetch()}>Consultar recibo</Button>}
    </div>}
    {receipt.isError && <FormMessage>Não foi possível atualizar o resultado. <button className="underline" onClick={() => void receipt.refetch()}>Consultar novamente</button></FormMessage>}
    {error && <FormMessage>{error}</FormMessage>}
  </div>;
}

function NodeCard({ node }: { node: Installation }) {
  const { sdk, key, access } = useManagedNodes(), client = useQueryClient();
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const intent = useRef(crypto.randomUUID());
  const [channelsOpen, setChannelsOpen] = useState(false);
  async function revoke() {
    setBusy(true); setError(null);
    try { await sdk.installations.revoke({ installationId: node.id, expectedRevision: node.revision, operationId: intent.current }); await client.invalidateQueries({ queryKey: key("installations") }); setConfirm(false); }
    catch { setError("Não foi possível revogar. Atualize o estado e tente novamente."); }
    finally { setBusy(false); }
  }
  return <Panel padded><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-medium">{node.name}</h3>
    <p className="mt-1 text-sm text-ink-2">{statusLabel[node.status]}{node.platform ? ` · ${node.platform}` : ""}</p></div>
    {node.status !== "revoked" && access.allows("organization.installations.manage") && <Button variant="ghost" onClick={() => setConfirm(true)}>Revogar acesso</Button>}</div>
    {node.status === "online" && access.allows("organization.installations.manage") && <div className="mt-4"><InstallationCheck node={node} /></div>}
    {node.status === "online" && access.allows("organization.installations.manage") && <div className="mt-4"><Button aria-expanded={channelsOpen} onClick={() => setChannelsOpen(!channelsOpen)}>{channelsOpen ? "Fechar canais" : "Configurar canais"}</Button>{channelsOpen && <NodeChannels node={node} />}</div>}
    {confirm && <div className="mt-4 space-y-3 border-t border-line pt-4"><p className="text-sm">Revogar o acesso de {node.name}? Novas operações serão bloqueadas. Uma execução já iniciada pode continuar na máquina.</p><div className="flex flex-wrap gap-2"><Button variant="danger" loading={busy} onClick={() => void revoke()}>Confirmar revogação</Button><Button disabled={busy} onClick={() => setConfirm(false)}>Cancelar</Button></div></div>}
    {error && <FormMessage>{error}</FormMessage>}
  </Panel>;
}
export function ManagedInstallationsScreen() {
  const { access, query } = useManagedNodes();
  return <OrgArea tab="installations"><div className="max-w-3xl space-y-5"><div><h2 className="text-lg font-semibold">Instalações Ravi</h2><p className="mt-1 text-sm text-ink-2">Conecte e acompanhe os Ravis que você administra.</p></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : query.isPending ? <Skeleton className="h-32" /> : query.data.installations.map(node => <NodeCard key={node.id} node={node} />)}
    {access.allows("organization.installations.manage") && <ConnectionInstructions />}
  </div></OrgArea>;
}

export function AssociationScreen() {
  const { sdk, key, access } = useManagedNodes(), client = useQueryClient();
  const fragment = useSyncExternalStore(subscribeLocation, readHash, emptyLocation);
  const proof = useMemo(() => { const hash = new URLSearchParams(fragment.slice(1)); const associationId = hash.get("request"), challenge = hash.get("challenge"); return associationId && challenge ? { associationId, challenge } : null; }, [fragment]);
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [approved, setApproved] = useState<Installation | null>(null);
  const intent = useRef<string | null>(null);
  const query = useQuery({ queryKey: key("association", proof?.associationId), queryFn: () => sdk.associations.show(proof!), enabled: !!proof && access.allows("organization.installations.read"), retry: false });
  async function approve(event: React.FormEvent) {
    event.preventDefault(); if (!proof || !query.data || busy) return;
    setBusy(true); setError(null); intent.current ??= crypto.randomUUID();
    try { const result = await sdk.associations.approve({ ...proof, name: name.trim() || query.data.name, fingerprint: query.data.fingerprint, operationId: intent.current }); setApproved(result); history.replaceState(null, "", location.pathname); await client.invalidateQueries({ queryKey: key("installations") }); }
    catch { setError("Não foi possível associar. Confira se a solicitação ainda está válida e tente novamente."); }
    finally { setBusy(false); }
  }
  return <OrgArea tab="installations"><div className="max-w-3xl space-y-5"><h2 className="text-lg font-semibold">Associar instalação</h2>
    {approved ? <Notice title="Instalação associada" tone="info">A máquina já pode estabelecer sua conexão. O próximo passo é verificar o resultado.<div className="mt-3"><Button variant="primary" href="/org/onboarding">Verificar instalação</Button></div></Notice>
      : !proof ? <Notice title="Abra o link mostrado pelo CLI" tone="info">Execute o comando de conexão na instalação que deseja associar.</Notice>
      : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : query.isPending ? <Skeleton className="h-48" />
      : query.data.status !== "pending" ? <Notice title={query.data.status === "approved" ? "Instalação já associada" : "Solicitação encerrada"} tone="info">{query.data.status === "approved" ? "Consulte a instalação para verificar a conexão." : "Inicie uma nova solicitação pelo CLI."}<div className="mt-3"><Button href="/org/installations">Gerenciar instalações</Button></div></Notice>
      : !access.allows("organization.installations.manage") ? <NoAccess title="Permissão necessária para associar instalações" />
      : <Panel padded><form onSubmit={event => void approve(event)} className="space-y-5"><div><h3 className="font-medium">{query.data.name}</h3><p className="mt-1 text-sm text-ink-2">{query.data.platform} · Confirme que esta é a máquina onde você iniciou a instalação.</p></div>
        <Field label="Nome da instalação">{props => <Input {...props} name="installation-name" autoComplete="off" maxLength={120} value={name} placeholder={query.data.name} onChange={event => { setName(event.target.value); intent.current = null; }} />}</Field>
        <details><summary className="cursor-pointer text-sm">Identidade e alcance do acesso</summary><p className="mt-2 text-sm text-ink-2">Esta chave identifica somente esta instalação. Ela não dá acesso administrativo ao Console ou às outras máquinas.</p><code className="mt-2 block break-all text-xs">{query.data.fingerprint}</code></details>
        {error && <FormMessage>{error}</FormMessage>}<Button type="submit" variant="primary" loading={busy}>Associar esta instalação</Button>
      </form></Panel>}
  </div></OrgArea>;
}
