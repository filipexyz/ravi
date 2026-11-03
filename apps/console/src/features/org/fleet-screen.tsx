"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import { useOrgKey } from "@/features/shell/workspace";
import type { Credential, FleetState, Installation, SecretKind } from "@/server/console/fleet/contract";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input, Select, Textarea } from "@/ui/form";
import { Panel } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, NoAccess, Notice, Skeleton } from "@/ui/states";
import { OrgArea } from "./org-area";
import { useOrganizationAccess } from "./access";

const errors: Record<string, string> = {
  vault_not_configured: "O cofre ainda precisa ser preparado pelo administrador da instalação.",
  vault_unavailable: "O cofre está indisponível ou selado. Nenhuma configuração foi ativada.",
  vault_write_conflict: "A versão no cofre não corresponde a esta operação. Recarregue o estado antes de continuar.",
  version_conflict: "Esta configuração mudou em outra operação. Recarregue antes de editar novamente.",
  invalid_ssh_key: "Use uma chave privada SSH válida, dedicada a esta instalação e sem senha.",
  ssh_credential_required: "Escolha uma credencial SSH disponível.",
  credential_in_active_sso: "Esta credencial mantém o login ativo. Teste e ative outra conexão SSO antes de substituí-la ou revogá-la.",
  credential_binding_immutable: "O emissor e o cliente desta credencial não podem mudar. Cadastre outra credencial para outro destino.",
  host_key_mismatch: "A identidade do servidor não corresponde ao fingerprint confirmado. A autenticação foi recusada.",
  target_not_allowed: "O destino deve resolver somente para IPv4 privado ou Tailscale; loopback e link-local não são aceitos.",
  ssh_authentication_failed: "Não foi possível autenticar com esta credencial e usuário SSH.",
  ssh_connection_closed: "O servidor encerrou a conexão antes da conclusão do teste.",
  host_unreachable: "Não foi possível resolver ou alcançar o endereço privado.",
  probe_timeout: "O servidor não respondeu dentro do limite. Verifique a rede antes de testar novamente.",
  ravi_cli_unavailable: "O acesso não comprovou uma versão válida do CLI Ravi.",
  credential_unavailable: "A credencial não está disponível para uso. Verifique o cofre e seu estado.",
  credential_revoked: "Esta credencial foi revogada. Cadastre outra credencial.",
  fresh_test_required: "Teste novamente a versão atual antes de ativar; o teste vale por cinco minutos.",
  invalid_request: "Revise os campos. Valores vazios, usuário root e formatos inválidos não são aceitos.",
  idempotency_conflict: "Esta tentativa não corresponde à operação anterior. Recarregue o estado antes de continuar.",
};
function message(error: unknown) {
  if (error instanceof ApiError) return errors[error.code] ?? (error.status === 403 ? "Você não tem permissão para esta operação." : "Não foi possível concluir. A configuração não foi considerada ativa.");
  return "Não foi possível concluir. Verifique a conexão e tente novamente.";
}
const kindLabel = (kind: SecretKind) => kind === "ssh_private_key" ? "Chave SSH" : "Segredo OIDC";
const stateLabel = (state: Installation["status"]) => ({ draft: "Precisa testar", tested: "Testado", active: "Transporte ativo", failed: "Teste falhou" })[state];

export function FleetScreen({ tab }: { tab: "credentials" | "installations" }) {
  const access = useOrganizationAccess();
  const canRead = access.allows(`organization.${tab}.read`), canManage = access.allows(`organization.${tab}.manage`);
  const canChooseCredential = access.allows("organization.credentials.read");
  const key = useOrgKey();
  const query = useQuery({ queryKey: key("fleet", tab), queryFn: async (): Promise<FleetState> => tab === "credentials"
    ? { credentials: await api.get<Credential[]>("/api/console/fleet/credentials"), installations: [] }
    : { credentials: [], installations: await api.get<Installation[]>("/api/console/fleet/installations") }, enabled: canRead, retry: false });
  const choices = useQuery({ queryKey: key("fleet-credential-choices"), queryFn: () => api.get<Credential[]>("/api/console/fleet/credentials"),
    enabled: tab === "installations" && canRead && canManage && canChooseCredential, retry: false });
  const client = useQueryClient();
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: key("fleet") }), client.invalidateQueries({ queryKey: key("fleet-credential-choices") })]); };
  return <OrgArea tab={tab}>
    {!canRead ? <NoAccess title="Acesso não concedido" description="Sua política atual não permite consultar esta configuração." />
      : query.isPending ? <div aria-busy="true" role="status" aria-label="Carregando configuração"><Skeleton className="h-32 max-w-2xl" /></div>
      : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      : tab === "credentials" ? <Credentials data={query.data} canManage={canManage} refresh={refresh} />
        : <Installations data={{ ...query.data, credentials: choices.data ?? [] }} canManage={canManage}
          canChooseCredential={canChooseCredential && choices.isSuccess} refresh={refresh} />}
  </OrgArea>;
}

function Credentials({ data, refresh, canManage }: { data: FleetState; refresh: () => Promise<void>; canManage: boolean }) {
  const [editing, setEditing] = useState<Credential | "new" | null>(null);
  const [revoking, setRevoking] = useState<Credential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revokeKey = useRef("");
  return <div data-fleet-private className="max-w-3xl space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1">
      <h2 className="text-base font-semibold">Credenciais</h2>
      <p className="max-w-xl text-sm text-ink-2">Os valores ficam no cofre desta instalação. Depois de salvar, você pode usá-los ou substituí-los, mas não revelá-los.</p>
    </div>{canManage && !editing && <Button variant="primary" onClick={() => setEditing("new")}>Adicionar credencial</Button>}</div>
    {!canManage && <Notice title="Somente consulta" tone="info">Você pode consultar os metadados, mas não alterar credenciais. Os valores secretos nunca são exibidos.</Notice>}
    {canManage && editing ? <CredentialForm key={typeof editing === "string" ? "new" : editing.id} credential={editing === "new" ? undefined : editing}
      onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} /> : null}
    {data.credentials.length === 0 && !editing ? <EmptyState title="Nenhuma credencial cadastrada" description={canManage ? "Adicione uma chave SSH dedicada para testar uma instalação Ravi. O segredo OIDC é usado na configuração de login." : "Ainda não há metadados de credenciais para consultar."} /> : null}
    <ul className="space-y-3" aria-label="Credenciais cadastradas">{data.credentials.map(item => <li key={item.id}>
      <Panel padded><div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1"><h3 className="break-words font-medium">{item.label}</h3>
          <p className="text-sm text-ink-2">{kindLabel(item.kind)} · versão {item.secretVersion}</p>
          <Badge tone={item.status === "revoked" ? "warn" : "neutral"}>{item.status === "revoked" ? "Revogada no Console" : "Armazenada"}</Badge>
          {item.status === "active" && <p className="text-sm text-ink-2">O uso depende de uma conexão validada.</p>}
        </div>{canManage && item.status === "active" && <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing(item)} disabled={Boolean(editing)}>Substituir</Button>
          <Button variant="danger" onClick={() => { revokeKey.current = crypto.randomUUID(); setError(null); setRevoking(item); }}>Revogar</Button>
        </div>}
      </div></Panel>
    </li>)}</ul>
    <Dialog open={canManage && Boolean(revoking)} title="Revogar esta credencial?" onClose={() => { if (!busy) setRevoking(null); }}
      description="O Console deixará de usá-la. As instalações vinculadas precisarão de outra credencial e de um novo teste. Isso não remove a chave no servidor de destino."
      footer={<><Button disabled={busy} onClick={() => setRevoking(null)}>Cancelar</Button><Button variant="danger" loading={busy} disabled={busy} onClick={async () => {
        if (!revoking || busy) return; setBusy(true); setError(null);
        try { await api.post("/api/console/fleet/credentials/revoke", { operationId: revokeKey.current, id: revoking.id, expectedRevision: revoking.revision }); setRevoking(null); await refresh(); }
        catch (error) { setError(message(error)); } finally { setBusy(false); }
      }}>Revogar credencial</Button></>}>
      {error ? <FormMessage>{error}</FormMessage> : null}
    </Dialog>
  </div>;
}

function CredentialForm({ credential, onCancel, onSaved }: { credential?: Credential; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [id] = useState(() => credential?.id ?? crypto.randomUUID());
  const operationId = useRef(crypto.randomUUID());
  const [label, setLabel] = useState(credential?.label ?? "");
  const [kind, setKind] = useState<SecretKind>(credential?.kind ?? "ssh_private_key");
  const [value, setValue] = useState("");
  const [issuer, setIssuer] = useState(credential?.binding?.issuer ?? "");
  const [clientId, setClientId] = useState(credential?.binding?.clientId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(!credential);
  const changed = () => { operationId.current = crypto.randomUUID(); setError(null); };
  return <Panel padded><form className="space-y-4" onSubmit={async event => {
    event.preventDefault(); if (busy || !confirmed) return; setBusy(true); setError(null);
    try { await api.post("/api/console/fleet/credentials/save", { operationId: operationId.current, id, label, kind, value,
      binding: kind === "oidc_client_secret" ? { issuer, clientId } : null, expectedRevision: credential?.revision ?? 0 });
      setValue(""); await onSaved(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }}><fieldset disabled={busy} className="space-y-4">
    <legend className="mb-3 font-medium">{credential ? "Substituir credencial" : "Nova credencial"}</legend>
    <Field label="Nome" hint="Um nome que identifique o uso, sem incluir o segredo.">{props => <Input {...props} value={label} required maxLength={100} onChange={event => { setLabel(event.target.value); changed(); }} />}</Field>
    <Field label="Tipo">{props => <Select {...props} value={kind} disabled={Boolean(credential)} onChange={event => { setKind(event.target.value as SecretKind); setValue(""); changed(); }}>
      <option value="ssh_private_key">Chave SSH dedicada</option><option value="oidc_client_secret">Segredo de cliente OIDC</option>
    </Select>}</Field>
    {kind === "oidc_client_secret" && <>
      <Field label="Emissor OIDC" hint="URL HTTPS exata do emissor. O segredo só poderá ser usado com este emissor e cliente.">{props => <Input {...props} type="url" required readOnly={Boolean(credential)} value={issuer} autoCapitalize="none" spellCheck={false} onChange={event => { setIssuer(event.target.value); changed(); }} />}</Field>
      <Field label="Identificador do cliente">{props => <Input {...props} required readOnly={Boolean(credential)} value={clientId} autoCapitalize="none" spellCheck={false} onChange={event => { setClientId(event.target.value); changed(); }} />}</Field>
    </>}
    <Field label={kind === "ssh_private_key" ? "Chave privada SSH" : "Segredo do cliente"} hint={`${kind === "ssh_private_key" ? "Não use sua chave pessoal. " : ""}O valor não será devolvido pela API nem ficará disponível para consulta.`}>
      {props => kind === "ssh_private_key" ? <Textarea {...props} value={value} required maxLength={32768} autoComplete="off" spellCheck={false} onChange={event => { setValue(event.target.value); changed(); }} />
        : <Input {...props} type="password" autoComplete="new-password" value={value} required maxLength={32768} onChange={event => { setValue(event.target.value); changed(); }} />}
    </Field>
    {credential && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
      <span>Entendo que as conexões vinculadas voltarão a precisar de teste. O segredo anterior não será exibido.</span></label>}
    {error && <FormMessage>{error}</FormMessage>}
    <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={onCancel}>Cancelar</Button><Button type="submit" variant="primary" loading={busy} disabled={!confirmed}>Salvar no cofre</Button></div>
  </fieldset></form></Panel>;
}

function Installations({ data, refresh, canManage, canChooseCredential }: { data: FleetState; refresh: () => Promise<void>; canManage: boolean; canChooseCredential: boolean }) {
  const [editing, setEditing] = useState<Installation | "new" | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keep keys across retries of one action/revision; never rotate automatically on failure.
  const operations = useRef(new Map<string, string>());
  const run = async (item: Installation, action: "test" | "activate") => {
    if (pending) return;
    const key = `${item.id}:${item.revision}:${action}`;
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    setPending(item.id); setError(null);
    try { await api.post(`/api/console/fleet/installations/${action}`, { operationId: operations.current.get(key), id: item.id, expectedRevision: item.revision }); await refresh(); }
    catch (error) { setError(message(error)); } finally { setPending(null); }
  };
  return <div className="max-w-3xl space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><h2 className="text-base font-semibold">Instalações Ravi</h2>
      <p className="max-w-xl text-sm text-ink-2">Cadastre o endereço privado e confira a identidade do servidor antes de testar o acesso.</p></div>
      {canManage && canChooseCredential && !editing && <Button variant="primary" onClick={() => setEditing("new")}>Adicionar instalação</Button>}</div>
    {!canManage && <Notice title="Somente consulta" tone="info">Seu acesso permite consultar as instalações, sem alterar ou testar conexões.</Notice>}
    {canManage && !canChooseCredential && <Notice title="Seleção de credencial indisponível" tone="info">Para cadastrar ou editar uma conexão é necessário consultar as credenciais. Confira seu acesso e tente atualizar a página.</Notice>}
    <Notice title="O teste verifica o transporte" tone="info">Ele autentica via SSH e consulta a versão do CLI. Conversar com agentes e delegar a identidade do usuário ainda não faz parte desta conexão.</Notice>
    {canManage && canChooseCredential && editing && <InstallationForm key={typeof editing === "string" ? "new" : editing.id} item={editing === "new" ? undefined : editing} credentials={data.credentials}
      onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} />}
    {error && <FormMessage>{error}</FormMessage>}
    {data.installations.length === 0 && !editing ? <EmptyState title="Nenhuma instalação cadastrada" description={canManage ? "Prepare uma credencial dedicada e obtenha o fingerprint do servidor por um canal confiável." : "Ainda não há conexões para consultar."} /> : null}
    <ul className="space-y-3" aria-label="Instalações cadastradas">{data.installations.map(item => <li key={item.id}><Panel padded>
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1"><h3 className="break-words font-medium">{item.label}</h3>
        <p className="break-all font-mono text-sm text-ink-2">{item.hostname}:{item.port}</p>
        <Badge tone={item.status === "failed" ? "err" : item.status === "active" || item.status === "tested" ? "ok" : "neutral"}>{stateLabel(item.status)}</Badge>
        {item.cliVersion && <p className="text-sm text-ink-2">CLI {item.cliVersion} · teste {item.testedAt ? new Date(item.testedAt).toLocaleString() : ""}</p>}
        {item.failureCode && <p className="max-w-lg text-sm text-err" role="status">{errors[item.failureCode] ?? "O teste não confirmou a conexão."}</p>}
      </div>{canManage && <div className="flex flex-wrap gap-2">
        {canChooseCredential && <Button disabled={Boolean(pending || editing)} onClick={() => setEditing(item)}>Editar</Button>}
        <Button disabled={Boolean(pending)} loading={pending === item.id} onClick={() => void run(item, "test")}>Testar acesso</Button>
        {item.status === "tested" && <Button variant="primary" disabled={Boolean(pending)} onClick={() => void run(item, "activate")}>Ativar transporte</Button>}
      </div>}</div>
    </Panel></li>)}</ul>
  </div>;
}

function InstallationForm({ item, credentials, onCancel, onSaved }: { item?: Installation; credentials: Credential[]; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [id] = useState(() => item?.id ?? crypto.randomUUID());
  const [fields, setFields] = useState({ label: item?.label ?? "", hostname: item?.hostname ?? "", port: String(item?.port ?? 22), username: item?.username ?? "ravi-fleet",
    hostFingerprint: item?.hostFingerprint ?? "", credentialId: item?.credentialId ?? "" });
  const operationId = useRef(crypto.randomUUID());
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (key: keyof typeof fields, value: string) => { setFields(current => ({ ...current, [key]: value })); operationId.current = crypto.randomUUID(); setError(null); if (key === "hostFingerprint" || key === "hostname" || key === "port") setConfirmed(false); };
  return <Panel padded><form className="space-y-4" onSubmit={async event => {
    event.preventDefault(); if (!confirmed || busy) return; setBusy(true); setError(null);
    try { await api.post("/api/console/fleet/installations/save", { ...fields, port: Number(fields.port), operationId: operationId.current, id, expectedRevision: item?.revision ?? 0 }); await onSaved(); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  }}><fieldset disabled={busy} className="space-y-4"><legend className="mb-3 font-medium">{item ? "Editar instalação" : "Nova instalação"}</legend>
    <Field label="Nome">{props => <Input {...props} required maxLength={100} value={fields.label} onChange={event => update("label", event.target.value)} />}</Field>
    <Field label="Endereço privado" hint="Nome DNS ou IPv4 privado/Tailscale. Sem protocolo, caminho ou senha.">{props => <Input {...props} required value={fields.hostname} onChange={event => update("hostname", event.target.value)} autoCapitalize="none" spellCheck={false} />}</Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Porta SSH">{props => <Input {...props} required type="number" min={1} max={65535} value={fields.port} onChange={event => update("port", event.target.value)} />}</Field>
      <Field label="Usuário SSH" hint="Usuário dedicado, não root.">{props => <Input {...props} required value={fields.username} onChange={event => update("username", event.target.value)} autoCapitalize="none" />}</Field></div>
    <Field label="Credencial SSH">{props => <Select {...props} required value={fields.credentialId} onChange={event => update("credentialId", event.target.value)}>
      <option value="">Escolha uma credencial</option>{credentials.filter(x => x.status === "active" && x.kind === "ssh_private_key").map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
    </Select>}</Field>
    <Field label="Fingerprint do servidor" hint="SHA256 confirmado no console do servidor ou por outro canal confiável. Não aceite apenas o que uma conexão desconhecida apresenta.">{props => <Input {...props} required value={fields.hostFingerprint} onChange={event => update("hostFingerprint", event.target.value)} spellCheck={false} autoCapitalize="none" />}</Field>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>Conferi este fingerprint por um canal confiável.</span></label>
    {error && <FormMessage>{error}</FormMessage>}
    <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={onCancel}>Cancelar</Button><Button type="submit" variant="primary" loading={busy} disabled={!confirmed}>Salvar configuração</Button></div>
  </fieldset></form></Panel>;
}
