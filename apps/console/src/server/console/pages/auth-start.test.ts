import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { ConsoleWorkspaceSelectionRequiredError } from "@/server/console/workspace";

import {
  pagesAuthStartErrorFromUnknown,
  pagesAuthStartErrorResponse,
  pagesAuthStartErrorView,
  pagesAuthStartPrefersJson,
  safePagesReturnHost,
} from "./auth-start";

describe("pages auth start error negotiation", () => {
  test("prefers JSON only when the client asks for it explicitly", () => {
    expect(pagesAuthStartPrefersJson(request({ accept: "application/json" }))).toBe(true);
    expect(pagesAuthStartPrefersJson(request({ format: "json" }))).toBe(true);
    expect(pagesAuthStartPrefersJson(request({ accept: "text/html,application/xhtml+xml" }))).toBe(false);
    expect(pagesAuthStartPrefersJson(request({ accept: "text/html, application/json" }))).toBe(false);
    expect(pagesAuthStartPrefersJson(request({ accept: "*/*", fetchMode: "navigate" }))).toBe(false);
    expect(pagesAuthStartPrefersJson(request({}))).toBe(false);
  });

  test("maps workspace selection after a resolved site to org_forbidden, not not_found", () => {
    const mapped = pagesAuthStartErrorFromUnknown(new ConsoleWorkspaceSelectionRequiredError([]), {
      hasResolvedTarget: true,
    });
    expect(mapped).toEqual({
      payload: { error: "pages_access_denied", reason: "org_forbidden" },
      status: 403,
    });
  });

  test("maps workspace selection without a resolved site to workspace_selection_required", () => {
    const mapped = pagesAuthStartErrorFromUnknown(new ConsoleWorkspaceSelectionRequiredError([]), {
      hasResolvedTarget: false,
    });
    expect(mapped).toEqual({
      payload: { error: "pages_access_denied", reason: "workspace_selection_required" },
      status: 403,
    });
  });

  test("does not keep legacy not_found for claim-code authorization failures", () => {
    const mapped = pagesAuthStartErrorFromUnknown(new ConsoleApiError(404, { error: "not_found" }));
    expect(mapped).toEqual({
      payload: { error: "pages_access_denied", reason: "project_forbidden" },
      status: 403,
    });
  });

  test("keeps invalid return targets distinct from access denied", () => {
    const mapped = pagesAuthStartErrorFromUnknown(new ConsoleApiError(400, { error: "invalid_return_to" }));
    expect(mapped).toEqual({
      payload: { error: "invalid_return_to" },
      status: 400,
    });
    const view = pagesAuthStartErrorView({ error: "invalid_return_to", returnTo: "https://missing.ravi.page/" });
    expect(view.title).toBe("Destino inválido");
    expect(view.body).toContain("não é um problema de permissão");
    expect(view.host).toBe("missing.ravi.page");
  });

  test("renders a styled Portuguese HTML page for browser navigations", async () => {
    const response = pagesAuthStartErrorResponse({
      error: "pages_access_denied",
      reason: "org_forbidden",
      request: request({ accept: "text/html", fetchMode: "navigate" }),
      requestId: "req_html",
      returnTo: "https://onb2-proto.ravi.page/deck",
      status: 403,
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain("Acesso negado");
    expect(html).toContain("O login deu certo");
    expect(html).toContain("onb2-proto.ravi.page");
    expect(html).toContain("Voltar para a página");
    expect(html).toContain("Abrir Console");
    expect(html).not.toContain("not_found");
    expect(html).not.toContain("org_");
  });

  test("returns precise JSON for API clients", async () => {
    const response = pagesAuthStartErrorResponse({
      error: "pages_access_denied",
      reason: "project_forbidden",
      request: request({ accept: "application/json" }),
      requestId: "req_json",
      returnTo: "https://onb2-proto.ravi.page/deck",
      status: 403,
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "pages_access_denied",
      reason: "project_forbidden",
    });
  });

  test("explains workspace selection without calling it not_found", async () => {
    const view = pagesAuthStartErrorView({
      error: "pages_access_denied",
      reason: "workspace_selection_required",
      returnTo: "https://onb2-proto.ravi.page/",
    });
    expect(view.title).toBe("Selecione uma organização");
    expect(view.lead).toContain("organização selecionada");
    expect(view.consoleHref).toBe("/");

    const json = pagesAuthStartErrorResponse({
      error: "pages_access_denied",
      reason: "workspace_selection_required",
      request: request({ accept: "application/json" }),
      requestId: "req_ws",
      returnTo: "https://onb2-proto.ravi.page/",
      status: 403,
    });
    expect(await json.json()).toEqual({
      error: "pages_access_denied",
      reason: "workspace_selection_required",
    });
  });

  test("shows only a safe host from returnTo", () => {
    expect(safePagesReturnHost("https://onb2-proto.ravi.page/private?x=1")).toBe("onb2-proto.ravi.page");
    expect(safePagesReturnHost("https://user:pass@evil.example/")).toBeNull();
    expect(safePagesReturnHost("javascript:alert(1)")).toBeNull();
    expect(safePagesReturnHost("not a url")).toBeNull();
  });
});

function request(input: { accept?: string; fetchMode?: string; format?: string }) {
  const url = new URL("https://console.ravi.bot/api/pages/auth/start");
  if (input.format) url.searchParams.set("format", input.format);
  const headers = new Headers();
  if (input.accept) headers.set("accept", input.accept);
  if (input.fetchMode) headers.set("sec-fetch-mode", input.fetchMode);
  return new Request(url, { headers });
}
