"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api/client";
import { useOrgKey } from "@/features/shell/workspace";
import type { ApiKeyInventory, ApiKeyMetadata, ApiKeyReceipt, ServicePrincipalMetadata } from "@/shared/api-keys";
import { ORGANIZATION_ACTIONS, ORGANIZATION_ACTION_LABELS, PROJECT_ACTIONS, PROJECT_ACTION_LABELS } from "@/shared/project-authorization";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input, Select } from "@/ui/form";
import { Section } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { ErrorState, ListSkeleton, Notice } from "@/ui/states";
import { useOrganizationAccess } from "./access";
import { OrgArea } from "./org-area";

type Intent = { kind: "issue" | "classify" | "rotate" | "revoke"; key?: ApiKeyMetadata }
  | { kind: "services/create" | "services/revoke"; service?: ServicePrincipalMetadata };
const TITLES = { issue: "Nova chave", classify: "Classificar chave", rotate: "Rotacionar chave", revoke: "Revogar chave",
  "services/create": "Novo serviço", "services/revoke": "Desativar serviço" };
const subjectLabel = (key: ApiKeyMetadata) => key.subjectKind === "unclassified" ? "Titular não classificado"
  : `${key.subjectKind === "user" ? "Pessoal" : "Institucional"} · ${key.subjectName ?? "Titular indisponível"}`;
const labels = { ...PROJECT_ACTION_LABELS, ...ORGANIZATION_ACTION_LABELS };
function message(error: unknown) {
  const messages: Record<string, string> = {
    api_key_subject_not_authorized: "O titular ainda não tem todas as ações selecionadas. Publique as concessões em Políticas de acesso e tente novamente.",
    api_key_subject_inactive: "O titular não está ativo nesta organização. Atualize o inventário e revise a seleção.",
    api_key_expiry_invalid: "Escolha um vencimento futuro, em até 366 dias.",
    api_key_scope_invalid: "Revise o projeto e as ações selecionadas.",
    version_conflict: "Este item mudou. Atualize e revise antes de confirmar.",
    forbidden: "Seu acesso atual não permite esta ação.",
    auth_required: "Sua sessão terminou. Entre novamente.",
    api_key_revoked: "A chave já foi revogada. Emita uma nova chave se necessário.",
  };
  return error instanceof ApiError ? messages[error.code] ?? "Não foi possível confirmar. Mantenha os campos e tente novamente."
    : "Não foi possível confirmar. Mantenha os campos e tente novamente.";
}

export function ApiKeysScreen() { return <OrgArea tab="api-keys"><KeyInventory /></OrgArea>; }
function KeyInventory() {
  const key = useOrgKey(), access = useOrganizationAccess();
  const query = useQuery({ queryKey: key("api-keys"), queryFn: () => api.get<ApiKeyInventory>("/api/console/fleet/api-keys"),
    enabled: access.allows("organization.api_keys.read"), retry: false });
  const [intent, setIntent] = useState<Intent | null>(null), [status, setStatus] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const inventoryHeading = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const focusInventory = () => requestAnimationFrame(() => inventoryHeading.current?.focus());
  const closeForm = () => { setIntent(null); focusInventory(); };
  const closeToken = () => { setToken(null); focusInventory(); };
  if (query.isPending) return <ListSkeleton rows={3} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data, canManage = access.allows("organization.api_keys.manage");
  const review = (next: Intent) => { setStatus(""); setIntent(next); };
  return <div className="space-y-6">
    {!canManage && <Notice title="Somente consulta" tone="info">Você pode consultar titulares e escopos, sem alterar chaves.</Notice>}
    {data.unresolved > 0 && <Notice title="Classificação pendente" tone="warn">
      {data.unresolved} chave(s) precisam de classificação ou rotação. O novo uso é negado. Conclua o inventário antes de liberar a implantação.
    </Notice>}
    <Section title={<span ref={inventoryHeading} tabIndex={-1}>Chaves de API</span>} description="Cada chave pertence a uma pessoa ou serviço e só pode usar ações concedidas ao titular. Quem criou a chave não define seus poderes.">
      <p className="mb-4 text-sm text-ink-2">Criar uma chave não conecta serviços automaticamente.</p>
      {status && <p role="status" className="mb-4 text-sm text-ink">{status}</p>}
      {!intent && canManage && <Button variant="primary" className="mb-4" onClick={() => review({ kind: "issue" })}>Nova chave</Button>}
      {intent && <KeyForm key={JSON.stringify(intent)} intent={intent} data={data} onCancel={closeForm}
        onRefresh={async () => { const result = await query.refetch(); if (!result.isError) closeForm(); }}
        onSuccess={async result => {
          setIntent(null); setToken(result.token ?? null);
          setStatus(result.token ? "Chave emitida. Guarde o valor antes de fechar." : "Alteração registrada. Se a emissão foi uma repetição, o valor não é exibido novamente; rotacione se não o guardou.");
          await query.refetch();
          if (!result.token) focusInventory();
        }} />}
      <ul aria-label="Chaves" className="divide-y divide-line rounded-lg border border-line bg-surface">
        {data.keys.map(item => <li key={item.id} className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0">
            <h3 className="break-words text-sm font-medium">{item.name}</h3>
            <p className="mt-1 break-words text-sm text-ink-2">{subjectLabel(item)}</p>
          </div><Badge tone={item.status !== "active" ? "neutral" : item.expiresAt && new Date(item.expiresAt).getTime() <= now || item.subjectKind === "unclassified" || item.rotationRequired ? "warn" : "ok"}>
            {item.status !== "active" ? "Revogada / inativa" : item.subjectKind === "unclassified" ? "Não classificada" : item.expiresAt && new Date(item.expiresAt).getTime() <= now ? "Expirada" : item.rotationRequired ? "Rotação necessária" : "Ativa"}
          </Badge></div>
          <p className="break-words text-sm text-ink-2">Escopo: {item.projectId ? item.projectName ?? "Projeto indisponível" : "Organização"} · {item.scopes.map(a => labels[a] ?? a).join(", ") || "Ações não classificadas"}</p>
          <details className="text-sm text-ink-2"><summary className="cursor-pointer">Autoria e validade</summary>
            <p className="mt-2">Criada por: {item.authorName ?? "Autoria indisponível"}. Autoria não é titularidade.</p>
            <p>Vencimento: {item.expiresAt ? new Date(item.expiresAt).toLocaleString() : "Não definido"}.</p>
            <p>Identificação: <span className="font-mono">{item.prefix}…</span></p>
          </details>
          {!intent && canManage && item.status === "active" && <div className="flex flex-wrap gap-2">
            <Button onClick={() => review({ kind: item.subjectKind === "unclassified" ? "classify" : "rotate", key: item })}>
              {item.subjectKind === "unclassified" ? "Classificar" : "Rotacionar"}</Button>
            <Button variant="ghost" onClick={() => review({ kind: "revoke", key: item })}>Revogar</Button>
          </div>}
        </li>)}
        {!data.keys.length && <li className="p-5 text-sm text-ink-2">Nenhuma chave cadastrada. Escolha um titular com concessões explícitas para emitir a primeira.</li>}
      </ul>
    </Section>
    <Section title="Serviços da organização" description="Uma identidade institucional mantém suas próprias concessões. Suspender seu criador não interrompe o serviço.">
      {access.allows("organization.authorization.read") && <Button href="/org/permissions" variant="ghost" className="mb-3">Políticas de acesso</Button>}
      {!intent && canManage && <Button className="mb-3" onClick={() => review({ kind: "services/create" })}>Novo serviço</Button>}
      <ul aria-label="Serviços" className="divide-y divide-line rounded-lg border border-line bg-surface">
        {data.services.map(service => <li key={service.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div><p className="break-words text-sm font-medium">{service.name}</p><p className="text-sm text-ink-2">{service.status === "active" ? "Ativo · acesso depende da política" : "Desativado"}</p></div>
          {!intent && canManage && service.status === "active" && <Button variant="ghost" onClick={() => review({ kind: "services/revoke", service })}>Desativar</Button>}
        </li>)}
        {!data.services.length && <li className="p-5 text-sm text-ink-2">Crie o serviço, publique suas concessões e depois emita uma chave institucional.</li>}
      </ul>
    </Section>
    <Dialog open={token !== null} onClose={closeToken} title="Guarde a nova chave" description="Este valor aparece uma única vez. Depois de fechar, você não poderá consultá-lo novamente."
      footer={<Button variant="primary" onClick={closeToken}>Guardei a chave</Button>}>
      <Field label="Chave emitida" hint="Copie para o destino autorizado. O valor não aparece no inventário nem na auditoria.">
        {props => <Input {...props} readOnly value={token ?? ""} autoComplete="off" onFocus={e => e.target.select()} />}</Field>
    </Dialog>
  </div>;
}

function KeyForm({ intent, data, onCancel, onSuccess, onRefresh }: { intent: Intent; data: ApiKeyInventory;
  onCancel: () => void; onSuccess: (receipt: ApiKeyReceipt) => Promise<void>; onRefresh: () => Promise<void> }) {
  const item = "key" in intent ? intent.key : undefined, service = "service" in intent ? intent.service : undefined;
  const binding = intent.kind === "issue" || intent.kind === "classify", createService = intent.kind === "services/create";
  const revoke = intent.kind === "revoke" || intent.kind === "services/revoke";
  const [name, setName] = useState(""), [kind, setKind] = useState<"user" | "service">("user"), [subjectId, setSubjectId] = useState("");
  const [projectId, setProjectId] = useState(""), [scopes, setScopes] = useState<string[]>([]), [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState(""), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const operation = useRef<{ signature: string; id: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>("input,select")?.focus(); }, []);
  const conflict = error instanceof ApiError && error.code === "version_conflict";
  const choices = kind === "user" ? data.users : data.services.filter(s => s.status === "active");
  const catalog = projectId ? PROJECT_ACTIONS : ORGANIZATION_ACTIONS;
  const ready = reason.trim().length >= 3 && reviewed && (!createService || name.trim())
    && (!binding || subjectId && scopes.length && (intent.kind !== "issue" || name.trim())) && (createService || revoke || expiresAt);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!ready || busy || conflict) return;
    const fields = { reason, ...(item ? { id: item.id, expectedRevision: item.revision } : {}),
      ...(service ? { id: service.id, expectedRevision: service.revision } : {}),
      ...(createService || intent.kind === "issue" ? { name } : {}),
      ...(binding ? { subject: { kind, id: subjectId }, projectId: projectId || null, scopes } : {}),
      ...(!createService && !revoke ? { expiresAt: new Date(expiresAt).toISOString() } : {}) };
    const signature = JSON.stringify(fields);
    if (operation.current?.signature !== signature) operation.current = { signature, id: crypto.randomUUID() };
    setBusy(true); setError(null);
    try { await onSuccess(await api.post<ApiKeyReceipt>(`/api/console/fleet/api-keys/${intent.kind}`, { ...fields, operationId: operation.current.id })); }
    catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  return <form ref={form} onSubmit={event => void submit(event)} className="mb-6 max-w-2xl space-y-4 rounded-lg border border-line-strong bg-surface p-5" aria-label={TITLES[intent.kind]}>
    <h3 className="font-medium">{TITLES[intent.kind]}{item ? ` · ${item.name}` : service ? ` · ${service.name}` : ""}</h3>
    <fieldset disabled={busy} className="space-y-4" onChange={() => setReviewed(false)}>
      {(createService || intent.kind === "issue") && <Field label="Nome">{props => <Input {...props} autoFocus required maxLength={120} value={name} onChange={e => setName(e.target.value)} />}</Field>}
      {binding && <>
        <Field label="Tipo">{props => <Select {...props} value={kind} onChange={e => { setKind(e.target.value as typeof kind); setSubjectId(""); }}><option value="user">Pessoal</option><option value="service">Institucional</option></Select>}</Field>
        <Field label="Titular" hint="Seleção explícita. O criador não é escolhido automaticamente.">{props => <Select {...props} required value={subjectId} onChange={e => setSubjectId(e.target.value)}><option value="">Escolha o titular</option>{choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <Field label="Escopo">{props => <Select {...props} value={projectId} onChange={e => { setProjectId(e.target.value); setScopes([]); }}><option value="">Organização</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Ações permitidas pela chave</legend>
          {catalog.map(action => <label key={action} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={scopes.includes(action)} onChange={e => setScopes(current => e.target.checked ? [...current, action] : current.filter(a => a !== action))} /><span>{labels[action]}</span></label>)}
        </fieldset>
      </>}
      {!createService && !revoke && <Field label="Vencimento" hint="Horário local, até 366 dias. Não há chave sem prazo.">{props => <Input {...props} type="datetime-local" required value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />}</Field>}
      <Field label="Motivo">{props => <Input {...props} required minLength={3} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} />}</Field>
    </fieldset>
    <p className="text-sm text-ink-2">{intent.kind === "revoke" ? "O valor atual deixará de funcionar. Reativar a pessoa não reativa esta chave."
      : intent.kind === "services/revoke" ? "Todas as chaves deste serviço serão revogadas. Esta desativação é definitiva."
      : intent.kind === "rotate" ? "O valor anterior deixará de funcionar imediatamente. Titular e escopo serão preservados."
      : intent.kind === "classify" ? "A classificação registra o titular e o escopo. A chave continuará sem uso até uma rotação explícita."
      : createService ? "O serviço começa sem concessões. Publique sua política antes de emitir uma chave."
      : "A chave só permite estas ações enquanto o titular estiver ativo e autorizado pela política."}</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} />Revisei o titular, o escopo e a consequência desta ação.</label>
    {error != null && <p role="alert" className="text-sm text-err">{message(error)}</p>}
    <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button disabled={busy} onClick={onCancel}>Cancelar</Button>
      {conflict ? <Button onClick={() => void onRefresh()}>Atualizar e revisar</Button> : <Button type="submit" variant="primary" disabled={!ready || busy}>{busy ? "Aplicando…" : "Confirmar"}</Button>}
    </div>
  </form>;
}
