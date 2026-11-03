"use client";
import { Users } from "lucide-react";
import { useState } from "react";
import { ApiError } from "@/lib/api/client";
import type { MembershipChange, OrganizationMember, OrganizationMemberStatus } from "@/shared/organization-members";
import { Avatar, Badge, type Tone } from "@/ui/badge";
import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { Section } from "@/ui/layout";
import { List } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Notice } from "@/ui/states";
import { OrgArea } from "./org-area";
import { useOrganizationAccess } from "./access";
import { useOrganizationMembers, useChangeMembership } from "./member-queries";

const STATUS: Record<OrganizationMemberStatus, { label: string; tone: Tone }> = {
  active: { label: "Ativo", tone: "ok" }, invited: { label: "Pendente", tone: "info" },
  suspended: { label: "Suspenso", tone: "warn" }, removed: { label: "Removido", tone: "neutral" },
};
const ACTION = { active: "Reativar", suspended: "Suspender", removed: "Remover acesso" };

export function OrgMembersScreen() {
  return <OrgArea tab="members"><MembersBody /></OrgArea>;
}
function MembersBody() {
  const access = useOrganizationAccess(), directory = useOrganizationMembers(), change = useChangeMembership();
  const [intent, setIntent] = useState<{ member: OrganizationMember; input: MembershipChange } | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const canManage = access.allows("organization.members.manage");
  function review(member: OrganizationMember, status: MembershipChange["status"]) {
    change.reset(); setSuccess(null);
    setIntent({ member, input: { userId: member.userId, status, expectedVersion: member.version, operationId: crypto.randomUUID() } });
  }
  if (directory.isPending) return <ListSkeleton rows={3} />;
  if (directory.isError) return <ErrorState error={directory.error} onRetry={() => void directory.refetch()} />;
  const conflict = change.error instanceof ApiError && change.error.code === "version_conflict";
  const rejected = change.error instanceof ApiError && change.error.status >= 400 && change.error.status < 500;
  return <div className="space-y-6">
    {!canManage && <Notice title="Somente consulta" tone="info">Você pode consultar as pessoas, sem alterar a admissão.</Notice>}
    <Section title="Pessoas da organização" description="Admissão permite entrar. O acesso a projetos e ações depende das políticas publicadas. Alterar o estado não atribui papéis.">
      {access.allows("organization.authorization.read") && <Button href="/org/permissions" variant="ghost" className="mb-4">Políticas de acesso</Button>}
      {success && <p role="status" className="mb-4 text-sm text-ink">{success}</p>}
      {directory.data.members.length ? <List label="Pessoas">
        {directory.data.members.map(member => <li key={member.userId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3"><Avatar label={member.name} seed={member.userId} />
            <div className="min-w-0"><p className="break-words text-sm font-medium">{member.name}{member.userId === directory.data.currentUserId ? " (você)" : ""}</p>
              <p className="break-all text-sm text-ink-2">{member.email ?? "E-mail não disponível"}</p></div></div>
          <div className="flex flex-wrap items-center gap-2"><Badge tone={STATUS[member.status].tone}>{STATUS[member.status].label}</Badge>
            {canManage && <>
              {member.status === "active" ? <Button variant="ghost" onClick={() => review(member, "suspended")}>Suspender</Button>
                : member.status !== "invited" && <Button variant="ghost" onClick={() => review(member, "active")}>Reativar</Button>}
              {member.status !== "removed" && <Button variant="ghost" onClick={() => review(member, "removed")}>Remover acesso</Button>}
            </>}
          </div>
        </li>)}
      </List> : <EmptyState icon={Users} title="Nenhuma pessoa cadastrada" description="Este diretório mostra identidades já provisionadas. Convites e criação de novas identidades não estão disponíveis neste fluxo." />}
      <p className="mt-3 text-xs text-ink-2">Novas identidades e convites não são criados aqui. Um estado pendente não pode ser ativado por este fluxo.</p>
    </Section>
    <Dialog open={intent !== null} onClose={() => { if (!change.isPending) setIntent(null); }}
      title={intent ? ACTION[intent.input.status] + "?" : "Revisar acesso"}
      description={intent?.member.email ?? intent?.member.name}
      footer={<><Button variant="ghost" disabled={change.isPending} onClick={() => setIntent(null)}>Cancelar</Button>
        {conflict ? <Button onClick={async () => { const result = await directory.refetch(); if (!result.isError) { setIntent(null); change.reset(); } }}>Atualizar e revisar</Button>
          : <Button variant="primary" disabled={!intent || !canManage || change.isPending || rejected} onClick={() => {
            if (!intent) return;
            change.mutate(intent.input, { onSuccess: result => {
              setSuccess(intent.member.name + ": " + STATUS[result.member.status].label.toLowerCase() + ".");
              setIntent(null);
              if (result.member.userId === directory.data.currentUserId && result.member.status !== "active") window.location.assign("/login");
            } });
          }}>{change.isPending ? "Aplicando…" : change.isError && !rejected ? "Tentar novamente" : "Confirmar alteração"}</Button>}</>}>
      <p className="text-sm text-ink-2">{intent?.input.status === "active"
        ? "Permissões já publicadas para esta pessoa podem voltar a valer. Sessões e chaves pessoais antigas não serão reativadas; será necessário entrar novamente e emitir novas chaves."
        : "O acesso será interrompido e as sessões Console, Pages, vínculos Ravi e chaves pessoais serão revogados. Chaves institucionais criadas por esta pessoa serão preservadas. Dados e políticas serão preservados. O último gestor efetivo de políticas não pode ser removido."}</p>
      {change.isError && <FormMessage tone="err">{memberFailure(change.error)}</FormMessage>}
    </Dialog>
  </div>;
}
function memberFailure(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "version_conflict") return "O estado mudou. Atualize e revise antes de confirmar.";
    if (error.code === "authorization_last_manager_required") return "É necessário manter outro gestor com acesso efetivo às políticas. Nada foi alterado.";
    if (error.code === "member_admission_unsupported") return "Esta identidade ainda não pode ser admitida por este fluxo.";
    if (error.status === 403 || error.status === 401) return "Seu acesso mudou. Entre novamente ou solicite a permissão necessária.";
  }
  return "Não foi possível confirmar o resultado. Tentar novamente mantém a mesma solicitação, sem duplicar a alteração.";
}
