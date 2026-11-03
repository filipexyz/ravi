// GitHub repositories mounted in a cloud run: a short installation token of
// the organization's GitHub App installation that covers the repository,
// limited to that one repository. Never a repository another organization's
// installation covers.

import { createSign } from "node:crypto";

import { listOrganizationGithubConnections } from "@/server/console/github-app";

import type { CloudRepositoryTokenMinter } from "./access";
import { cloudError } from "./errors";

const GITHUB_API = "https://api.github.com";

export type GithubTokenDeps = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  listConnections?: (organizationId: string) => Promise<{ status: string; externalAccountId: string | null; metadataJson: Record<string, unknown> }[]>;
};

export function githubRepositoryTokenMinter(deps: GithubTokenDeps = {}): CloudRepositoryTokenMinter {
  return async ({ organizationId, repo }) => {
    const env = deps.env ?? process.env;
    const appId = env.RAVI_GITHUB_APP_ID?.trim();
    const privateKey = readPrivateKey(env.RAVI_GITHUB_APP_PRIVATE_KEY);
    if (!appId || !privateKey) {
      throw unavailable(repo, "GitHub repositories are not configured on this Console (RAVI_GITHUB_APP_ID, RAVI_GITHUB_APP_PRIVATE_KEY).");
    }
    const connections = await (deps.listConnections ?? listOrganizationGithubConnections)(organizationId);
    const wanted = repo.toLowerCase();
    const installation = connections.find(
      (connection) =>
        connection.status === "active" &&
        repositoriesOf(connection.metadataJson).some((fullName) => fullName.toLowerCase() === wanted),
    );
    const installationId = installation ? String(installation.metadataJson.installationId ?? installation.externalAccountId ?? "") : "";
    if (!installation || !/^\d+$/.test(installationId)) {
      throw unavailable(repo, `No GitHub installation linked to this organization covers ${repo}.`);
    }
    const jwt = appJwt(appId, privateKey, (deps.now ?? (() => new Date()))());
    const name = repo.split("/")[1] ?? repo;
    const response = await (deps.fetch ?? fetch)(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "user-agent": "ravi-console",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ repositories: [name], permissions: { contents: "read" } }),
    });
    if (!response.ok) throw unavailable(repo, `GitHub refused a token for ${repo} (${response.status}).`);
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) throw unavailable(repo, `GitHub returned no token for ${repo}.`);
    return { url: `https://github.com/${repo}`, token: body.token };
  };
}

function repositoriesOf(metadata: Record<string, unknown>) {
  const names = new Set<string>();
  for (const key of ["repositories", "selectedRepositories"]) {
    const list = metadata[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const fullName = entry && typeof entry === "object" ? (entry as { fullName?: unknown }).fullName : entry;
      if (typeof fullName === "string") names.add(fullName);
    }
  }
  return [...names];
}

function appJwt(appId: string, privateKey: string, now: Date) {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: issuedAt, exp: issuedAt + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** PEM as is, with escaped newlines, or base64 of the PEM. */
function readPrivateKey(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) return null;
  if (value.includes("BEGIN")) return value.replace(/\\n/g, "\n");
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return decoded.includes("BEGIN") ? decoded : null;
}

function unavailable(repo: string, message: string) {
  return cloudError("cloud_agent_repository_unavailable", message, { repository: repo });
}
