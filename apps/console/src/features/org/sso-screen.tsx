"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api/client";
import { useOrgKey } from "@/features/shell/workspace";
import type { Credential } from "@/server/console/fleet/contract";
import type { SsoConnection, SsoState } from "@/server/console/fleet/sso-contract";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input, Select } from "@/ui/form";
import { Panel } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, NoAccess, Notice, Skeleton } from "@/ui/states";
import { OrgArea } from "./org-area";
import { useOrganizationAccess } from "./access";

const errors: Record<string, string> = {
  version_conflict: "Esta configuração mudou. Atualize a tela antes de continuar.",
  fresh_sso_login_required: "Faça um novo teste de login nesta sessão antes de ativar.",
  sso_test_expired: "Este teste expirou ou já foi concluído. Atualize a tela para iniciar outro.",
  sso_credential_changed: "A credencial mudou ou foi revogada. Salve uma nova candidata e teste novamente.",
  sso_credential_binding_required: "Selecione um segredo OIDC válido para este emissor e cliente.",
  sso_admin_identity_mismatch: "O login candidato precisa confirmar seu e-mail e atender aos grupos de entrada configurados.",
  sso_identity_owned_elsewhere: "Esta identidade já pertence a outro usuário. Ela não foi vinculada.",
  vault_unavailable: "O cofre está indisponível. O login ativo não foi trocado.",
  forbidden: "Sua sessão não tem permissão para administrar o login.",
  network_error: "Não foi possível confirmar a resposta. Você pode repetir a mesma ação.",
};
const message = (error: unknown) => error instanceof ApiError ? errors[error.code] ?? "Não foi possível concluir. O login ativo foi preservado." : "Não foi possível concluir a operação.";
const labels = { draft: "Rascunho", tested: "Login validado", active: "Ativo", retired: "Substituído" };

export function SsoScreen() {
  const orgKey = useOrgKey(); const queryClient = useQueryClient(); const access = useOrganizationAccess();
  const allowed = access.allows("organization.sso.read"), canManage = access.allows("organization.sso.manage");
  const canChooseCredential = access.allows("organization.credentials.read") && canManage;
  const query = useQuery({ queryKey: orgKey("fleet-sso"), queryFn: () => api.get<SsoState>("/api/console/fleet/sso"), enabled: allowed, retry: false });
  const credentials = useQuery({ queryKey: orgKey("fleet-credential-choices"), queryFn: () => api.get<Credential[]>("/api/console/fleet/credentials"), enabled: allowed && canChooseCredential, retry: false });
  return <OrgArea tab="sso">{!allowed ? <NoAccess title="Acesso ao login não concedido" />
    : query.isPending ? <Skeleton className="h-64" />
    : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    : <SsoBody state={query.data} credentials={credentials.data ?? []} canManage={canManage}
      canCreate={canChooseCredential && credentials.isSuccess}
      refresh={async () => { await queryClient.invalidateQueries({ queryKey: orgKey("fleet-sso") }); }} />}</OrgArea>;
}
function SsoBody({ state, credentials, refresh, canManage, canCreate }: { state: SsoState; credentials: Credential[]; refresh: () => Promise<void>; canManage: boolean; canCreate: boolean }) {
  const search = useSearchParams();
  const [creating, setCreating] = useState(false), [pending, setPending] = useState<string | null>(null);
  const [activating, setActivating] = useState<SsoConnection | null>(null);
  const [acknowledged, setAcknowledged] = useState(false), [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const active = state.connections.find(item => item.status === "active");
  async function run(item: SsoConnection, action: "test" | "activate") {
    if (pending) return; setPending(item.id); setError(null);
    const key = `${item.id}:${item.revision}:${action}`;
    if (!keys.current.has(key)) keys.current.set(key, crypto.randomUUID());
    try {
      const result = await api.post<{ url?: string }>(`/api/console/fleet/sso/${action}`, { id: item.id, expectedRevision: item.revision,
        operationId: keys.current.get(key), ...(action === "activate" ? { acknowledgeIdentityChange: true } : {}) });
      if (action === "test" && result.url) { window.location.assign(result.url); return; }
      setActivating(null); await refresh();
    } catch (error) { setError(message(error)); } finally { setPending(null); }
  }
  return <div className="max-w-3xl space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><h2 className="text-base font-semibold">Login da organização</h2>
      <p className="max-w-xl text-sm text-ink-2">Teste um login real antes de substituir a conexão ativa. Salvar não altera o acesso atual.</p></div>
      {canManage && canCreate && !creating && <Button variant="primary" onClick={() => setCreating(true)}>Nova conexão OIDC</Button>}</div>
    {!canManage && <Notice title="Somente consulta" tone="info">Você pode consultar o estado do login, sem testar ou ativar configurações.</Notice>}
    {canManage && !canCreate && <Notice title="Seleção de credencial indisponível" tone="info">Criar uma conexão exige consultar as credenciais OIDC. Confira seu acesso e atualize a página.</Notice>}
    <Panel padded><h3 className="font-medium">Login em uso</h3><p className="mt-1 break-all text-sm text-ink-2">{active ? `${active.label} · ${active.issuer}` : "Configuração inicial preparada pelo operador"}</p></Panel>
    {search.get("test") === "failed" && <Notice title="O teste de login não foi validado" tone="warn">A conexão ativa foi preservada. Confira credencial, URL de retorno, e-mail verificado e grupos antes de tentar novamente.</Notice>}
    {error && !activating && <FormMessage>{error}</FormMessage>}
    {canManage && canCreate && creating && <SsoForm credentials={credentials} onCancel={() => setCreating(false)} onSaved={async () => { setCreating(false); await refresh(); }} />}
    {!state.connections.length && !creating && <EmptyState title="Nenhuma conexão candidata" description={canManage ? "Cadastre primeiro um segredo OIDC em Credenciais. SAML, SCIM e criação automática de membros não estão disponíveis." : "O login inicial continua em uso; não há candidatas para consultar."} />}
    <ul className="space-y-3" aria-label="Conexões de login">{state.connections.map(item => <li key={item.id}><Panel padded>
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1"><h3 className="break-words font-medium">{item.label}</h3>
        <p className="break-all text-sm text-ink-2">{item.issuer}</p><Badge tone={item.status === "active" || item.status === "tested" ? "ok" : "neutral"}>{labels[item.status]}</Badge>
        {item.testedAt && <p className="text-sm text-ink-2">Teste: {new Date(item.testedAt).toLocaleString()} · ativação disponível por 5 minutos na mesma sessão.</p>}
      </div>{canManage && ["draft", "tested"].includes(item.status) && <div className="flex flex-wrap gap-2">
        <Button loading={pending === item.id} disabled={Boolean(pending)} onClick={() => void run(item, "test")}>Entrar para testar</Button>
        {item.status === "tested" && <Button variant="primary" disabled={Boolean(pending)} onClick={() => { setActivating(item); setAcknowledged(false); setError(null); }}>Revisar ativação</Button>}
      </div>}</div>
    </Panel></li>)}</ul>
    <Dialog open={canManage && Boolean(activating)} onClose={() => { if (!pending) setActivating(null); }} title="Ativar este login?"
      description="Somente sua sessão validada será mantida. As outras sessões serão encerradas. Se o emissor mudou, os outros membros precisam ter suas identidades provisionadas nele."
      footer={<><Button disabled={Boolean(pending)} onClick={() => setActivating(null)}>Cancelar</Button><Button variant="primary" disabled={!acknowledged || Boolean(pending)} loading={Boolean(pending)} onClick={() => { if (activating) void run(activating, "activate"); }}>Ativar login</Button></>}>
      <p className="mb-4 break-all text-sm">{activating?.issuer}</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>Revisei o impacto nos outros membros e tenho o procedimento de recuperação do operador.</span></label>
      {error && <FormMessage>{error}</FormMessage>}
    </Dialog>
  </div>;
}
function SsoForm({ credentials, onCancel, onSaved }: { credentials: Credential[]; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [id] = useState(() => crypto.randomUUID()), operation = useRef(crypto.randomUUID());
  const [label, setLabel] = useState(""), [credentialId, setCredentialId] = useState("");
  const [allowPrivateNetwork, setAllowPrivate] = useState(false), [restrictGroups, setRestrictGroups] = useState(false);
  const [groups, setGroups] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const credential = credentials.find(item => item.id === credentialId);
  const changed = () => { operation.current = crypto.randomUUID(); setError(null); };
  return <Panel padded><form className="space-y-4" onSubmit={async event => {
    event.preventDefault(); if (busy || !credential?.binding) return; setBusy(true); setError(null);
    const admissionGroups = restrictGroups ? [...new Set(groups.split(",").map(x => x.trim()).filter(Boolean))] : [];
    if (restrictGroups && !admissionGroups.length) { setBusy(false); setError("Informe ao menos um grupo para restringir o login."); return; }
    try { await api.post("/api/console/fleet/sso/save", { id, operationId: operation.current, expectedRevision: 0, label,
      ...credential.binding, credentialId, allowPrivateNetwork, admissionGroups }); await onSaved(); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  }}><fieldset disabled={busy} className="space-y-4"><legend className="mb-3 font-medium">Nova conexão OIDC</legend>
    <Field label="Nome">{props => <Input {...props} required maxLength={100} value={label} onChange={event => { setLabel(event.target.value); changed(); }} />}</Field>
    <Field label="Credencial OIDC" hint="O emissor e o cliente são os vinculados a este segredo.">{props => <Select {...props} required value={credentialId} onChange={event => { setCredentialId(event.target.value); changed(); }}>
      <option value="">Escolha uma credencial</option>{credentials.filter(item => item.kind === "oidc_client_secret" && item.status === "active").map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select>}</Field>
    {credential?.binding && <div className="rounded border border-line p-3 text-sm"><p className="break-all">Emissor: {credential.binding.issuer}</p><p className="break-all">Cliente: {credential.binding.clientId}</p></div>}
    <Notice title="URLs de retorno no provedor" tone="info">Cadastre <code className="break-all">/callback</code> para o login e <code className="break-all">/callback/fleet</code> para o teste, ambos na origem HTTPS deste Console. Os endpoints do IdP devem compartilhar a origem do emissor.</Notice>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={allowPrivateNetwork} onChange={event => { setAllowPrivate(event.target.checked); changed(); }} /><span>Autorizo chamadas ao IPv4 privado deste emissor. Loopback e endereços de metadados continuam bloqueados.</span></label>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={restrictGroups} onChange={event => { setRestrictGroups(event.target.checked); changed(); }} /><span>Restringir entrada por grupos do IdP</span></label>
    {restrictGroups && <fieldset className="space-y-3 rounded border border-line p-3"><legend className="px-1 text-sm font-medium">Quem pode entrar</legend>
      <p className="text-sm text-ink-2">Membros existentes precisam pertencer a pelo menos um desses grupos. Isso não cria usuários, papéis ou permissões; o acesso aos recursos é concedido separadamente no Console.</p>
      <Field label="Grupos permitidos" hint="Nomes exatos deste emissor, separados por vírgula.">{props => <Input {...props} required value={groups} onChange={event => { setGroups(event.target.value); changed(); }} />}</Field>
    </fieldset>}
    {error && <FormMessage>{error}</FormMessage>}
    <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={onCancel}>Cancelar</Button><Button type="submit" variant="primary" loading={busy} disabled={!credential}>Salvar rascunho</Button></div>
  </fieldset></form></Panel>;
}
