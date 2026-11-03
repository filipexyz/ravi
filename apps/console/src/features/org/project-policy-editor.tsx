"use client";

import { useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Field, Input, Select } from "@/ui/form";
import { Section } from "@/ui/layout";
import { PROJECT_ACTIONS, PROJECT_ACTION_LABELS, ORGANIZATION_ACTIONS, ORGANIZATION_ACTION_LABELS } from "@/shared/project-authorization";
import type { Principal, ProjectPolicy, ProjectAction, OrganizationAction } from "@/server/console/authorization/policy";

type Revision = { id: string; document: ProjectPolicy; digest: string; reason: string; createdAt: string; createdBy: string };
export type PolicyEditorData = {
  generation: number; currentUserId: string; organizationId: string; canManage: boolean;
  active: Revision | null; draft: Revision | null; initialProposal: ProjectPolicy | null;
  members: { id: string; name: string | null; email: string; role: string }[];
  projects: { id: string; name: string }[]; installations: { id: string; name: string }[];
  services: { id: string; name: string }[];
  history: Omit<Revision, "document">[];
  events: { id: string; action: string; generation: number; createdAt: string; actorId: string }[];
};
type ImpactPreview = { id: string; generation: number; revisionId: string; expiresAt: string;
  impact: { evaluated: number; allowedBefore: number; allowedAfter: number; added: number; removed: number; initialActivation: boolean;
    organizationAdded: number; organizationRemoved: number;
    serviceSample: { serviceId: string; name: string; resource: string; action: string; before: boolean; after: boolean }[];
    organizationSample: { userId: string; action: OrganizationAction; before: boolean; after: boolean }[];
    sample: { userId: string; projectId: string; projectName: string; action: ProjectAction; before: boolean; after: boolean }[] } };
type Simulation = { allowed: boolean; reason: string; revisionId: string; lanes: { lane: string; ruleIds: string[] }[] };
export type PolicyTransport = <T>(path: string, body?: unknown) => Promise<T>;

export function policyErrorMessage(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  const messages: Record<string, string> = {
    authorization_admin_required: "You are not a policy manager. Organization membership does not grant access here.",
    unauthenticated: "Sign in again to manage access.",
    authorization_revision_conflict: "The policy changed while you were editing. Your unsaved changes remain here. Reload and review the new version before publishing.",
    authorization_preview_stale: "Membership or project information changed. Review the impact again before publishing.",
    authorization_preview_required: "This review expired or belongs to a different revision. Review the impact again.",
    authorization_self_lockout: "Keep yourself as a policy manager. You cannot remove your own administrative access in this change.",
    authorization_reference_invalid: "A selected member, group, project or installation is no longer available in this organization.",
    authorization_input_invalid: "Check the policy fields: names must be unique, each rule needs a subject, project and action, and referenced groups must exist.",
    csrf_origin_invalid: "This request did not come from the Console origin. Reopen the Console and try again.",
    authorization_unavailable: "Authorization is unavailable. No fallback access was granted. Try again when the Console database is available.",
    project_not_found: "That project is not available in this organization.",
  };
  return messages[code ?? ""] ?? "The operation could not be confirmed. Keep these inputs and retry; the same operation key is reused.";
}

const keyOf = (p: Principal) => p.kind === "agent" ? `agent:${p.installationId}:${p.id}` : `${p.kind}:${p.id}`;
type Choice = { key: string; label: string; principal?: Principal };
function Choices({ label, choices, values, onChange, disabled, exclusiveAll = false }: {
  label: string; choices: Choice[]; values: string[]; onChange: (values: string[]) => void; disabled?: boolean; exclusiveAll?: boolean;
}) {
  return <fieldset className="min-w-0 space-y-2" disabled={disabled}>
    <legend className="text-sm font-medium text-ink">{label}</legend>
    <details className="rounded-md border border-line-strong bg-surface px-3 py-2">
      <summary className="cursor-pointer break-words text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus">
        {values.length ? values.map((key) => choices.find((c) => c.key === key)?.label ?? key).join(", ") : "Choose…"}
      </summary>
      <div className="mt-3 max-h-56 space-y-2 overflow-y-auto border-t border-line pt-3">
        {choices.map((choice) => <label key={choice.key} className="flex cursor-pointer items-start gap-2 break-words text-sm text-ink-2">
          <input type="checkbox" className="mt-1 size-4 shrink-0 accent-current" checked={values.includes(choice.key)}
            onChange={(event) => {
              const next = event.target.checked ? [...values, choice.key] : values.filter((value) => value !== choice.key);
              onChange(exclusiveAll && event.target.checked ? choice.key === "*" ? ["*"] : next.filter((v) => v !== "*") : next);
            }} />
          <span>{choice.label}</span>
        </label>)}
      </div>
    </details>
  </fieldset>;
}

export function ProjectPolicyEditor({ initialData, transport, onPublished }: {
  initialData: PolicyEditorData; transport: PolicyTransport; onPublished?: () => void | Promise<void>;
}) {
  const [data, setData] = useState(initialData);
  const proposed = (value: PolicyEditorData) => structuredClone((value.draft?.document ?? value.active?.document ?? value.initialProposal)!);
  const [document, setDocument] = useState(() => proposed(initialData));
  const [editing, setEditing] = useState(Boolean(initialData.draft || !initialData.active));
  const [dirty, setDirty] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<ImpactPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [testUser, setTestUser] = useState(initialData.currentUserId);
  const [testProject, setTestProject] = useState(initialData.projects[0]?.id ?? "");
  const [testAction, setTestAction] = useState<ProjectAction>("project.read");
  const [scope, setScope] = useState<"project" | "organization">("project");
  const [testOrganizationAction, setTestOrganizationAction] = useState<OrganizationAction>("organization.settings.read");
  const lastMutation = useRef<{ signature: string; key: string } | null>(null);
  const edit = (change: (draft: ProjectPolicy) => void) => {
    setDocument((current) => { const next = structuredClone(current); change(next); return next; });
    setDirty(true); setPreview(null); setReviewed(false); setSimulation(null); setStatus("");
  };
  const load = async (collapse = false) => {
    const latest = await transport<PolicyEditorData>("");
    setData(latest); setDocument(proposed(latest)); setDirty(false); setPreview(null); setReviewed(false); setSimulation(null);
    if (collapse) setEditing(false);
    return latest;
  };
  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setError(null); setStatus("");
    try { await action(); } catch (cause) { setError(policyErrorMessage(cause)); } finally { setBusy(null); }
  };
  const mutate = async (path: string, fields: Record<string, unknown>) => {
    const input = { expectedGeneration: data.generation, reason: reason.trim(), ...fields };
    const signature = JSON.stringify({ path, input });
    if (lastMutation.current?.signature !== signature) lastMutation.current = { signature, key: crypto.randomUUID() };
    await transport(path, { ...input, operationKey: lastMutation.current.key });
    lastMutation.current = null;
  };
  const members: Choice[] = data.members.map((m) => ({ key: `user:${m.id}`, label: m.name || m.email, principal: { kind: "user", id: m.id } }));
  const groups: Choice[] = document.groups.map((g) => ({ key: `group:${g.id}`, label: `Group: ${g.id}`, principal: { kind: "group", id: g.id } }));
  const roles: Choice[] = (document.roles ?? []).map(r => ({ key: `role:${r.id}`, label: `Role: ${r.name}`, principal: { kind: "role", id: r.id } }));
  const orgRoles = roles.filter(r => document.roles?.find(p => p.id === r.principal!.id)?.scope.kind === "organization");
  const roleChoices = roles.filter(r => document.roles?.find(p => p.id === r.principal!.id)?.scope.kind === "project");
  const installationChoices: Choice[] = data.installations.map((i) => ({ key: `installation:${i.id}`, label: `Installation: ${i.name}`, principal: { kind: "installation", id: i.id } }));
  const serviceChoices: Choice[] = data.services.map(i => ({ key: `service:${i.id}`, label: `Service: ${i.name}`, principal: { kind: "service", id: i.id } }));
  const existingAgents: Choice[] = document.rules.flatMap((r) => r.principals).filter((p) => p.kind === "agent")
    .map((p) => ({ key: keyOf(p), label: `Agent boundary: ${p.id}`, principal: p }));
  const principals = [...members, ...groups, ...(scope === "project" ? roleChoices : orgRoles), ...serviceChoices, ...installationChoices, ...existingAgents.filter((p, index, list) => list.findIndex((q) => q.key === p.key) === index)];
  const projects: Choice[] = [{ key: "*", label: "All projects, including future projects" }, ...data.projects.map((p) => ({ key: p.id, label: p.name }))];
  const selectedPrincipals = (keys: string[], options = principals) => keys.map((key) => options.find((c) => c.key === key)?.principal).filter((p): p is Principal => Boolean(p));
  const subjectName = (id: string) => data.members.find((m) => m.id === id)?.name ?? data.members.find((m) => m.id === id)?.email ?? "Member";
  const canSave = !busy && reason.trim().length >= 3 && (dirty || !data.draft);

  return <div className="space-y-8">
    <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-line bg-surface p-5">
      <div><h2 className="font-medium text-ink">{data.active ? "Active policy" : "No active policy"}</h2>
        <p className="mt-1 text-sm text-ink-2">{data.active ? "Only explicit rules grant access. A matching deny always wins." : "Protected access is denied until a policy is active. This proposal is not active."}</p>
        {data.draft ? <p className="mt-2 text-sm text-warn">A saved draft is waiting for review; current access has not changed.</p> : null}</div>
      {!data.canManage ? <p className="text-sm text-ink-2">Read-only policy access. Editing requires an explicit policy management grant.</p> : !editing ? <Button onClick={() => setEditing(true)}>Edit policy</Button> : null}
    </div>
    {error ? <div role="alert" className="space-y-3 rounded-lg border border-err bg-err-soft p-4 text-sm text-ink"><p>{error}</p>
      <Button disabled={Boolean(busy)} onClick={() => void run("reload", async () => { await load(); lastMutation.current = null; setStatus("Latest policy loaded. Unsaved local changes were discarded."); })}>Reload and discard local changes</Button></div> : null}
    <p role="status" aria-live="polite" className={status ? "text-sm text-ok" : "sr-only"}>{status}</p>
    {editing && data.canManage ? <>
      <Section title="1. Edit a draft" description="Choose who may do what, in each scope. Saving does not change active access.">
        <fieldset disabled={Boolean(busy)} className="space-y-4">
          <Field label="Rule scope">{props => <Select {...props} value={scope} onChange={e => { setScope(e.target.value as typeof scope); setSimulation(null); }}><option value="project">Projects</option><option value="organization">Organization configuration</option></Select>}</Field>
          <details className="rounded-lg border border-line bg-surface p-4">
            <summary className="cursor-pointer font-medium text-ink">Roles and assignments</summary>
            <p className="my-3 text-sm text-ink-2">A role name grants nothing. Assign members and scope, then grant actions in a rule. Renaming preserves grants.</p>
            <div className="space-y-5">{(document.roles ?? []).map((role, index) => {
              const referenced = [...document.administrators, ...document.rules.flatMap(r => r.principals), ...(document.organizationRules ?? []).flatMap(r => r.principals)].some(p => p.kind === "role" && p.id === role.id);
              return <section key={role.id} aria-label={`Role ${index + 1}`} className="space-y-3 border-t border-line pt-3">
                <Field label={`Role ${index + 1} name`}>{props => <Input {...props} value={role.name} maxLength={80} onChange={e => edit(d => { d.roles![index]!.name = e.target.value; })} />}</Field>
                <Field label={`Role ${index + 1} scope`}>{props => <Select {...props} value={role.scope.kind} onChange={e => edit(d => { d.roles![index]!.scope = e.target.value === "organization" ? { kind: "organization" } : { kind: "project", projects: data.projects[0] ? [data.projects[0].id] : ["*"] }; })}><option value="project">Selected projects</option><option value="organization">Organization configuration</option></Select>}</Field>
                {role.scope.kind === "project" ? <Choices label="Role projects" choices={projects} values={role.scope.projects} exclusiveAll onChange={keys => edit(d => { d.roles![index]!.scope = { kind: "project", projects: keys }; })} /> : null}
                <Choices label="Assigned members" choices={members.map(m => ({ ...m, key: m.principal!.id }))} values={role.members} onChange={keys => edit(d => { d.roles![index]!.members = keys; })} />
                <Choices label="Assigned policy groups" choices={groups.map(g => ({ ...g, key: g.principal!.id }))} values={role.groups} onChange={keys => edit(d => { d.roles![index]!.groups = keys; })} />
                <Button variant="ghost" disabled={referenced} onClick={() => edit(d => { d.roles!.splice(index, 1); })}>Remove role {role.name}</Button>
                {referenced ? <p className="text-sm text-ink-2">Remove this role from rules and policy managers before deleting it.</p> : null}
              </section>;
            })}</div>
            <Button className="mt-4" onClick={() => edit(d => { (d.roles ??= []).push({ id: crypto.randomUUID(), name: "New role", members: [], groups: [], scope: scope === "organization" ? { kind: "organization" } : { kind: "project", projects: data.projects[0] ? [data.projects[0].id] : ["*"] } }); })}>Add role</Button>
          </details>
          {scope === "project" ? <>
          {document.rules.length === 0 ? <p className="rounded-lg border border-line p-5 text-sm text-ink-2">No rules: everyone is denied project access. Policy managers can still manage this page.</p> : null}
          {document.rules.map((rule, index) => <section key={index} aria-label={`Rule ${index + 1}`} className="space-y-4 rounded-lg border border-line bg-surface p-4 sm:p-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 basis-full sm:flex-1 sm:basis-0"><Field label={`Rule ${index + 1} name`}>{(props) => <Input {...props} value={rule.id} maxLength={80} onChange={(e) => edit((d) => { d.rules[index]!.id = e.target.value; })} />}</Field></div>
              <div className="w-32"><Field label="Effect">{(props) => <Select {...props} value={rule.effect} onChange={(e) => edit((d) => { d.rules[index]!.effect = e.target.value as "allow" | "deny"; })}><option value="allow">Allow</option><option value="deny">Deny</option></Select>}</Field></div>
              <Button variant="ghost" aria-label={`Remove rule ${index + 1}`} onClick={() => edit((d) => { d.rules.splice(index, 1); })}>Remove</Button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Choices label="Who" choices={principals} values={rule.principals.map(keyOf)} onChange={(keys) => edit((d) => { d.rules[index]!.principals = selectedPrincipals(keys); })} />
              <Choices label="Projects" choices={projects} values={rule.projects} exclusiveAll onChange={(keys) => edit((d) => { d.rules[index]!.projects = keys; })} />
            </div>
            <Choices label="Actions" choices={PROJECT_ACTIONS.map((key) => ({ key, label: PROJECT_ACTION_LABELS[key] }))} values={rule.actions} onChange={(keys) => edit((d) => { d.rules[index]!.actions = keys as ProjectAction[]; })} />
          </section>)}
          <Button onClick={() => edit((d) => d.rules.push({ id: `rule-${crypto.randomUUID().slice(0, 8)}`, effect: "allow", principals: [{ kind: "user", id: data.currentUserId }], projects: data.projects[0] ? [data.projects[0].id] : ["*"], actions: ["project.read"] }))}>Add rule</Button>
          <p className="text-sm text-ink-2">Write/admin do not automatically include read. Installation access also requires the linked person’s permission; a link alone grants nothing.</p>
          </> : <>
            {(document.organizationRules ?? []).length === 0 ? <p className="text-sm text-ink-2">No organization configuration grants. Policy managers remain a separate grant below.</p> : null}
            {(document.organizationRules ?? []).map((rule, index) => <section key={index} aria-label={`Organization rule ${index + 1}`} className="space-y-4 rounded-lg border border-line bg-surface p-4 sm:p-5">
              <Field label={`Organization rule ${index + 1} name`}>{props => <Input {...props} value={rule.id} maxLength={80} onChange={e => edit(d => { d.organizationRules![index]!.id = e.target.value; })} />}</Field>
              <Field label="Effect">{props => <Select {...props} value={rule.effect} onChange={e => edit(d => { d.organizationRules![index]!.effect = e.target.value as "allow" | "deny"; })}><option value="allow">Allow</option><option value="deny">Deny</option></Select>}</Field>
              <Choices label="Who" choices={principals} values={rule.principals.map(keyOf)} onChange={keys => edit(d => { d.organizationRules![index]!.principals = selectedPrincipals(keys); })} />
              <Choices label="Organization actions" choices={ORGANIZATION_ACTIONS.map(key => ({ key, label: ORGANIZATION_ACTION_LABELS[key] }))} values={rule.actions} onChange={keys => edit(d => { d.organizationRules![index]!.actions = keys as OrganizationAction[]; })} />
              <Button variant="ghost" onClick={() => edit(d => { d.organizationRules!.splice(index, 1); })}>Remove organization rule {index + 1}</Button>
            </section>)}
            <Button onClick={() => edit(d => { (d.organizationRules ??= []).push({ id: `organization-${crypto.randomUUID().slice(0, 8)}`, effect: "allow", principals: [{ kind: "user", id: data.currentUserId }], actions: ["organization.settings.read"] }); })}>Add organization rule</Button>
            <p className="text-sm text-ink-2">Organization access never grants project data. Manage does not imply read. Credential values are never revealed.</p>
          </>}

          <details className="rounded-lg border border-line bg-surface p-4">
            <summary className="cursor-pointer font-medium text-ink">Groups in this policy</summary>
            <p className="my-3 text-sm text-ink-2">These are policy-managed groups, not live IdP groups. Membership changes take effect when published.</p>
            <div className="space-y-5">{document.groups.map((group, index) => <div key={index} className="space-y-3 border-t border-line pt-3">
              <Field label={`Group ${index + 1} name`}>{(props) => <Input {...props} value={group.id} onChange={(e) => edit((d) => { d.groups[index]!.id = e.target.value; })} />}</Field>
              <Choices label="Members" choices={members.map((m) => ({ ...m, key: m.principal!.id }))} values={group.members} onChange={(keys) => edit((d) => { d.groups[index]!.members = keys; })} />
              <Button variant="ghost" onClick={() => edit((d) => { d.groups.splice(index, 1); })}>Remove group {group.id}</Button>
            </div>)}</div>
            <Button className="mt-4" onClick={() => edit((d) => { d.groups.push({ id: `group-${crypto.randomUUID().slice(0, 8)}`, members: [] }); })}>Add group</Button>
          </details>
          <details className="rounded-lg border border-line bg-surface p-4">
            <summary className="cursor-pointer font-medium text-ink">Who may administer policies</summary>
            <p className="my-3 text-sm text-ink-2">Policy managers can change grants across this organization. This does not give them project data access. Keep yourself as a manager.</p>
            <Choices label="Policy managers" choices={[...members, ...groups, ...orgRoles]} values={document.administrators.map(keyOf)} onChange={(keys) => edit((d) => { d.administrators = selectedPrincipals(keys, [...members, ...groups, ...orgRoles]) as ProjectPolicy["administrators"]; })} />
          </details>
          <Field label="Reason for this change" hint="Describe the access change. Do not include credentials or personal secrets.">{(props) => <Input {...props} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: give the design team read access to Project A" />}</Field>
          <div className="flex flex-wrap items-center gap-3"><Button variant={dirty || !data.draft ? "primary" : "secondary"} disabled={!canSave} loading={busy === "save"}
            onClick={() => void run("save", async () => { await mutate("/draft", { document }); await load(); setStatus("Draft saved. Active access is unchanged."); })}>Save draft</Button>
            <span className="text-sm text-ink-2">{dirty ? "Unsaved changes" : data.draft ? "Draft saved" : "Not yet saved as a draft"}</span></div>
        </fieldset>
      </Section>

      <Section title="2. Check access and review impact" description="A saved draft can be tested without granting access. Publication requires a fresh review.">
        <div className="space-y-4 rounded-lg border border-line bg-surface p-5">
          <fieldset disabled={Boolean(busy) || dirty || !data.draft} className="grid gap-4 md:grid-cols-3">
            <Field label="Person">{(props) => <Select {...props} value={testUser} onChange={(e) => { setTestUser(e.target.value); setSimulation(null); }}>{data.members.map((m) => <option value={m.id} key={m.id}>{m.name || m.email}</option>)}</Select>}</Field>
            {scope === "project" ? <>
              <Field label="Project">{(props) => <Select {...props} value={testProject} onChange={(e) => { setTestProject(e.target.value); setSimulation(null); }}>{data.projects.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</Select>}</Field>
              <Field label="Action">{(props) => <Select {...props} value={testAction} onChange={(e) => { setTestAction(e.target.value as ProjectAction); setSimulation(null); }}>{PROJECT_ACTIONS.map((a) => <option key={a} value={a}>{PROJECT_ACTION_LABELS[a]}</option>)}</Select>}</Field>
            </> : <Field label="Organization action">{props => <Select {...props} value={testOrganizationAction} onChange={e => { setTestOrganizationAction(e.target.value as OrganizationAction); setSimulation(null); }}>{ORGANIZATION_ACTIONS.map(a => <option key={a} value={a}>{ORGANIZATION_ACTION_LABELS[a]}</option>)}</Select>}</Field>}
          </fieldset>
          <Button disabled={Boolean(busy) || dirty || !data.draft || (scope === "project" && !testProject)} onClick={() => void run("simulate", async () => { setSimulation(await transport("/simulate", { expectedGeneration: data.generation, source: "draft", userId: testUser, ...(scope === "project" ? { projectId: testProject, action: testAction } : { resourceKind: "organization", action: testOrganizationAction }) })); })}>Check draft access</Button>
          {simulation ? <p role="status" className="text-sm text-ink"><strong>{simulation.allowed ? "Allowed by draft" : "Denied by draft"}</strong> — {simulation.reason === "no_grant" ? "no matching grant" : simulation.reason === "explicit_deny" ? "an explicit deny takes precedence" : simulation.allowed ? "matching allow, no matching deny" : "identity is unavailable"}.
            {simulation.lanes.flatMap((lane) => lane.ruleIds).length ? ` Rules: ${simulation.lanes.flatMap((lane) => lane.ruleIds).join(", ")}.` : ""} This is a simulation, not an executed operation.</p> : null}
          <div className="border-t border-line pt-4"><Button variant={!dirty && data.draft && !preview ? "primary" : "secondary"} disabled={Boolean(busy) || dirty || !data.draft}
            onClick={() => void run("preview", async () => { setPreview(await transport("/preview", { expectedGeneration: data.generation })); setReviewed(false); })}>Review impact</Button></div>
          {preview ? <div className="space-y-3" aria-label="Impact review">
            <p className="font-medium text-ink">{preview.impact.added} permissions added · {preview.impact.removed} removed</p>
            <p className="text-sm text-ink-2">{preview.impact.evaluated} person or service/resource/action combinations evaluated across both scopes. Compared with the active policy. Review expires in five minutes.</p>
            <p className="text-sm text-ink-2">Organization: {preview.impact.organizationAdded} added · {preview.impact.organizationRemoved} removed. Project: {preview.impact.added - preview.impact.organizationAdded} added · {preview.impact.removed - preview.impact.organizationRemoved} removed.</p>
            <ul className="divide-y divide-line rounded-md border border-line">{preview.impact.organizationSample.map((change, i) => <li key={i} className="px-3 py-2 text-sm text-ink-2">{subjectName(change.userId)} · Organization · {ORGANIZATION_ACTION_LABELS[change.action]}: {change.after ? "allowed" : "denied"}</li>)}</ul>
            <ul className="divide-y divide-line rounded-md border border-line">{preview.impact.sample.map((change, i) => <li key={i} className="px-3 py-2 text-sm text-ink-2">{subjectName(change.userId)} · {change.projectName} · {PROJECT_ACTION_LABELS[change.action]}: {change.after ? "allowed" : "denied"}</li>)}</ul>
            <ul className="divide-y divide-line rounded-md border border-line">{preview.impact.serviceSample.map((change, i) => <li key={i} className="px-3 py-2 text-sm text-ink-2">Service: {change.name} · {change.resource === data.organizationId ? "Organization" : data.projects.find(p => p.id === change.resource)?.name ?? "Unavailable project"} · {change.action}: {change.after ? "allowed" : "denied"}</li>)}</ul>
            <p className="text-sm text-ink-2">Showing up to 50 changes. Installation/agent grants are additional ceilings, not permission to act as any person.</p>
            <label className="flex items-start gap-2 text-sm text-ink"><input className="mt-1 size-4 shrink-0" type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={Boolean(busy)} />I reviewed the impact and want to activate this exact draft.</label>
            <Button variant="primary" disabled={Boolean(busy) || !reviewed || reason.trim().length < 3} loading={busy === "publish"}
              onClick={() => void run("publish", async () => { await mutate("/publish", { previewId: preview.id }); await load(true); setStatus("Policy published. New access decisions now use this revision."); setReason(""); await onPublished?.(); })}>3. Publish policy</Button>
          </div> : null}
        </div>
      </Section>
    </> : null}
    <details className="rounded-lg border border-line bg-surface p-5">
      <summary className="cursor-pointer font-medium text-ink">Revision history and audit</summary>
      <p className="my-3 text-sm text-ink-2">Restoring creates a new draft. It still requires review and publication. Enter a reason before choosing a previous revision.</p>
      {!editing ? <Field label="Reason for restoring" hint="The previous policy will not become active automatically.">{(props) => <Input {...props} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field> : null}
      <ul className="space-y-3">{data.history.map((revision) => <li key={revision.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="min-w-0 text-sm text-ink-2"><p className="break-words">{revision.reason}</p><p>{new Date(revision.createdAt).toLocaleString()} · {revision.digest.slice(0, 12)}{revision.id === data.active?.id ? " · Active" : ""}</p></div>
        {data.canManage ? <Button disabled={Boolean(busy) || reason.trim().length < 3} onClick={() => void run("rollback", async () => { await mutate("/rollback", { revisionId: revision.id }); await load(); setEditing(true); setStatus("Previous policy copied to a new draft. Review before publishing."); })}>Restore as draft</Button> : null}
      </li>)}</ul>
      <ul className="mt-5 space-y-2 border-t border-line pt-4 text-sm text-ink-2">{data.events.map((event) => <li key={event.id}>{event.action.replace("policy.", "").replaceAll("_", " ")} · revision {event.generation} · {subjectName(event.actorId)} · {new Date(event.createdAt).toLocaleString()}</li>)}</ul>
    </details>
  </div>;
}
