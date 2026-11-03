"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Button, Card, CardBody, CardHeader, SlashMark } from "@/components/ui";
import {
  ConsoleApiClientError,
  useCreateViewerAssertionAudience,
  useDeleteViewerAssertionAudience,
  useViewerAssertionAudiences,
} from "./queries";

export function ViewerAssertionAudiencesPanel({
  defaultHostname,
  num = 6,
  projectId,
  siteId,
}: {
  defaultHostname: string;
  num?: number;
  projectId: string;
  siteId: string;
}) {
  const queryClient = useQueryClient();
  const audiences = useViewerAssertionAudiences(projectId, siteId);
  const createAudience = useCreateViewerAssertionAudience(projectId, siteId);
  const deleteAudience = useDeleteViewerAssertionAudience(projectId, siteId);
  const [audience, setAudience] = useState("");
  const [origins, setOrigins] = useState(`https://${defaultHostname}`);
  const [formError, setFormError] = useState<string | null>(null);

  async function refresh() {
    await queryClient.invalidateQueries({
      queryKey: ["console", "projects", projectId, "pages", "sites", siteId, "viewer-assertion-audiences"],
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextOrigins = origins
      .split(/\s+/)
      .map((origin) => origin.trim())
      .filter(Boolean);
    if (!audience.trim() || nextOrigins.length === 0) return;
    setFormError(null);
    try {
      await createAudience.mutateAsync({ audience: audience.trim(), origins: nextOrigins });
      setAudience("");
      await refresh();
    } catch (error) {
      setFormError(audienceErrorMessage(error));
    }
  }

  async function remove(audienceId: string) {
    setFormError(null);
    try {
      await deleteAudience.mutateAsync(audienceId);
      await refresh();
    } catch (error) {
      setFormError(audienceErrorMessage(error));
    }
  }

  return (
    <Card className="grid-span-2">
      <CardHeader>
        <SlashMark label="viewer assertions" num={num} />
      </CardHeader>
      <CardBody>
        <div className="col gap-16">
          <p className="t-small t-mute">
            Register the exact audience a Page may mint for this site. Page JavaScript calls{" "}
            <span className="t-mono">ravi.identity.assertion</span> through <span className="t-mono">/_ravi/connectors/exec</span>{" "}
            and must list that action in the release <span className="t-mono">uses</span> allowlist. Backends verify
            ES256 tokens with <span className="t-mono">iss https://console.ravi.bot</span> and{" "}
            <span className="t-mono">https://console.ravi.bot/api/public/pages/viewer-assertions/jwks</span>. Tokens last
            60 seconds and are not shown here.
          </p>
          {formError ? <div className="form-banner form-banner--err">{formError}</div> : null}
          <form className="grid grid-2" onSubmit={(event) => void submit(event)}>
            <div className="field">
              <label htmlFor="viewer-assertion-audience">Audience</label>
              <input
                className="input t-mono"
                id="viewer-assertion-audience"
                onChange={(event) => setAudience(event.target.value)}
                placeholder="https://api.customer.example"
                value={audience}
              />
            </div>
            <div className="field">
              <label htmlFor="viewer-assertion-origins">Allowed origins</label>
              <textarea
                className="input t-mono"
                id="viewer-assertion-origins"
                onChange={(event) => setOrigins(event.target.value)}
                rows={3}
                value={origins}
              />
            </div>
            <Button disabled={createAudience.isPending} type="submit" variant="primary">
              {createAudience.isPending ? "Saving" : "Register audience"}
            </Button>
          </form>
          <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
            {audiences.data && audiences.data.items.length === 0 ? (
              <div className="empty">No audiences registered for this site.</div>
            ) : null}
            {audiences.data?.items.map((item, index) => (
              <div
                key={item.id}
                style={{
                  alignItems: "center",
                  borderTop: index === 0 ? undefined : "1px solid var(--line)",
                  display: "flex",
                  gap: 12,
                  justifyContent: "space-between",
                  padding: "12px 14px",
                }}
              >
                <div className="col gap-4">
                  <span className="t-mono">{item.audience}</span>
                  <span className="t-tiny t-mute">{item.origins.join(", ")}</span>
                </div>
                <Button
                  disabled={deleteAudience.isPending}
                  icon={Trash2}
                  onClick={() => void remove(item.id)}
                  size="sm"
                  type="button"
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function audienceErrorMessage(error: unknown) {
  if (error instanceof ConsoleApiClientError) {
    return error.payload.fieldErrors?.audience || error.payload.fieldErrors?.origins || error.payload.error;
  }
  return "Could not update viewer assertion audiences.";
}
