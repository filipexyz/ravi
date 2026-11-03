"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { PageHeader } from "@/ui/layout";
import { ProjectPolicyEditor, policyErrorMessage, type PolicyEditorData, type PolicyTransport } from "./project-policy-editor";
const endpoint = "/api/console/authorization";
const browserTransport: PolicyTransport = (path, body) => body === undefined ? api.get(endpoint + path) : api.post(endpoint + path, body);

export function ProjectPolicyScreen() {
  const { organization } = useWorkspace();
  return <PolicyScreen key={organization.id} organization={organization} />;
}

function PolicyScreen({ organization }: { organization: { id: string; name: string } }) {
  const router = useRouter();
  const queries = useQueryClient();
  const [data, setData] = useState<PolicyEditorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    browserTransport<PolicyEditorData>("").then((value) => { if (!cancelled) setData(value); }, (cause) => { if (!cancelled) setError(policyErrorMessage(cause)); });
    return () => { cancelled = true; };
  }, [attempt]);
  return <>
    <PageHeader title="Access policies" description={`${organization.name} · Organization configuration, project data and policy administration have separate grants.`} />
    {error ? <div role="alert" className="space-y-3 rounded-lg border border-line p-5"><p>{error}</p><Button onClick={() => { setData(null); setError(null); setAttempt((n) => n + 1); }}>Try again</Button></div>
      : !data ? <p role="status" className="py-8 text-ink-2">Loading the active policy…</p>
        : <ProjectPolicyEditor key={organization.id} initialData={data} transport={browserTransport} onPublished={async () => { await queries.invalidateQueries(); router.refresh(); }} />}
  </>;
}
