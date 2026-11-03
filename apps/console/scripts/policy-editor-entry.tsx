/** Browser entry for the real editor / HTTP / private PostgreSQL acceptance. */
import React from "react";
import { createRoot } from "react-dom/client";
import { ProjectPolicyEditor, type PolicyEditorData, type PolicyTransport } from "../src/features/org/project-policy-editor";

const transport: PolicyTransport = async (path, body) => {
  const response = await fetch(`/api/console/authorization${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error("Policy request refused"), { code: data.error });
  return data;
};
const data = await transport<PolicyEditorData>("");
createRoot(document.getElementById("root")!).render(<React.StrictMode>
  <main className="rv-app mx-auto min-h-screen max-w-5xl px-5 py-8">
    <h1 className="mb-6 text-2xl font-semibold text-ink">Access policies</h1>
    <ProjectPolicyEditor initialData={data} transport={transport} />
  </main>
</React.StrictMode>);
