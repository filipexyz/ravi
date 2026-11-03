import { NextResponse, type NextRequest } from "next/server";

import { ConsoleApiError } from "@/server/console/api-error";
import { ConsoleWorkspaceSelectionRequiredError } from "@/server/console/workspace";

export const PAGES_AUTH_START_CONSOLE_HREF = "/";

export type PagesAccessDeniedReason = "org_forbidden" | "project_forbidden" | "workspace_selection_required";

export type PagesAuthStartErrorCode =
  | "invalid_return_to"
  | "pages_access_denied"
  | "pages_auth_failed"
  | "rate_limited";

export type PagesAuthStartErrorPayload = {
  error: PagesAuthStartErrorCode;
  reason?: PagesAccessDeniedReason;
};

export type PagesAuthStartErrorInput = {
  error: PagesAuthStartErrorCode;
  reason?: PagesAccessDeniedReason;
  request: Pick<Request, "headers" | "url">;
  requestId: string;
  returnTo?: string | null;
  status: number;
};

const ACCESS_DENIED_REASONS = new Set<PagesAccessDeniedReason>([
  "org_forbidden",
  "project_forbidden",
  "workspace_selection_required",
]);

export function pagesAuthStartPrefersJson(request: Pick<Request, "headers" | "url">) {
  const url = new URL(request.url);
  if (url.searchParams.get("format") === "json") return true;

  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  const tokens = accept.split(",").map((part) => part.split(";")[0]?.trim() ?? "");
  const wantsJson = tokens.includes("application/json");
  const wantsHtml = tokens.includes("text/html");
  if (wantsJson && !wantsHtml) return true;

  return false;
}

export function pagesAuthStartErrorFromUnknown(
  error: unknown,
  options: { hasResolvedTarget: boolean } = { hasResolvedTarget: false },
): { payload: PagesAuthStartErrorPayload; status: number } | null {
  if (error instanceof ConsoleApiError) {
    const code = error.payload.error;
    if (code === "invalid_return_to") {
      return { payload: { error: "invalid_return_to" }, status: error.status || 400 };
    }
    if (code === "pages_access_denied" || code === "not_found") {
      return {
        payload: {
          error: "pages_access_denied",
          reason: pagesAccessDeniedReason(error.payload.reason) ?? (code === "not_found" ? "project_forbidden" : undefined),
        },
        status: code === "not_found" ? 403 : error.status || 403,
      };
    }
    if (code === "rate_limited") {
      return { payload: { error: "rate_limited" }, status: error.status || 429 };
    }
    return { payload: { error: "pages_auth_failed" }, status: error.status || 500 };
  }

  if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
    return {
      payload: {
        error: "pages_access_denied",
        reason: options.hasResolvedTarget ? "org_forbidden" : "workspace_selection_required",
      },
      status: 403,
    };
  }

  return null;
}

export function pagesAuthStartErrorResponse(input: PagesAuthStartErrorInput) {
  const payload: PagesAuthStartErrorPayload = { error: input.error };
  if (input.reason) payload.reason = input.reason;

  const headers = {
    "cache-control": "no-store",
    "x-request-id": input.requestId,
  };

  if (pagesAuthStartPrefersJson(input.request)) {
    return NextResponse.json(payload, { status: input.status, headers });
  }

  const view = pagesAuthStartErrorView({
    error: input.error,
    reason: input.reason,
    returnTo: input.returnTo,
  });

  return new NextResponse(renderPagesAuthStartErrorHtml(view), {
    status: input.status,
    headers: {
      ...headers,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });
}

export function pagesAuthStartErrorView(input: {
  error: PagesAuthStartErrorCode;
  reason?: PagesAccessDeniedReason;
  returnTo?: string | null;
}) {
  const host = safePagesReturnHost(input.returnTo);
  const returnHref = safePagesReturnHref(input.returnTo);
  const copy = pagesAuthStartErrorCopy(input.error, input.reason);
  const canAsk =
    input.error === "pages_access_denied" &&
    (input.reason === "org_forbidden" || input.reason === "project_forbidden") &&
    returnHref !== null;

  return {
    ...copy,
    consoleHref: PAGES_AUTH_START_CONSOLE_HREF,
    host,
    // People who manage the page approve it; see the console/access spec.
    requestAccessHref: canAsk ? `/access/request?returnTo=${encodeURIComponent(returnHref)}` : null,
    returnHref,
  };
}

export function safePagesReturnHost(returnTo: string | null | undefined) {
  const url = parseSafePagesReturnUrl(returnTo);
  return url?.hostname ?? null;
}

export function safePagesReturnHref(returnTo: string | null | undefined) {
  return parseSafePagesReturnUrl(returnTo)?.toString() ?? null;
}

function pagesAuthStartErrorCopy(error: PagesAuthStartErrorCode, reason?: PagesAccessDeniedReason) {
  if (error === "invalid_return_to") {
    return {
      body: "O destino de retorno é inválido ou este site não existe. Isso não é um problema de permissão.",
      lead: "Não foi possível abrir esta página.",
      title: "Destino inválido",
    };
  }

  if (error === "rate_limited") {
    return {
      body: "Aguarde um momento e tente de novo.",
      lead: "Muitas tentativas em pouco tempo.",
      title: "Tente novamente",
    };
  }

  if (error === "pages_auth_failed") {
    return {
      body: "Tente de novo em instantes. Se continuar, abra o Console e confirme se esta é a conta certa.",
      lead: "Não foi possível concluir a autenticação desta página.",
      title: "Falha na autenticação",
    };
  }

  if (reason === "project_forbidden") {
    return {
      body: "Peça acesso a esta página para quem cuida dela, ou um papel com leitura no projeto.",
      lead: "O login deu certo, mas esta conta não tem acesso a este projeto.",
      title: "Acesso negado",
    };
  }

  if (reason === "workspace_selection_required") {
    return {
      body: "Abra o Console, escolha a organização e tente abrir o link de novo.",
      lead: "Sua identidade está autenticada, mas o Console precisa de uma organização selecionada.",
      title: "Selecione uma organização",
    };
  }

  return {
    body: "Peça acesso a esta página para quem cuida dela, ou peça para te convidarem à organização dona do site.",
    lead: "O login deu certo, mas esta conta não pertence à organização desta página.",
    title: "Acesso negado",
  };
}

function renderPagesAuthStartErrorHtml(view: ReturnType<typeof pagesAuthStartErrorView>) {
  const hostRow = view.host
    ? `<p class="host">Página solicitada: <span>${escapeHtml(view.host)}</span></p>`
    : "";
  const askLink = view.requestAccessHref
    ? `<a class="btn btn-primary" href="${escapeHtml(view.requestAccessHref)}">Pedir acesso</a>`
    : "";
  const backLink = view.returnHref
    ? `<a class="btn${askLink ? "" : " btn-primary"}" href="${escapeHtml(view.returnHref)}">Voltar para a página</a>`
    : "";

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow,noarchive">
    <title>${escapeHtml(view.title)} · Ravi Pages</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0a0a;
        --bg-2: #111111;
        --line: rgba(255, 255, 255, 0.07);
        --line-2: rgba(255, 255, 255, 0.12);
        --fg: #f4f4f3;
        --mute: #8a8a87;
        --accent: #f4f4f3;
        --accent-fg: #0a0a0a;
        --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --mono: "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
        --radius: 6px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--bg);
        color: var(--fg);
        font-family: var(--sans);
        font-size: 14px;
        line-height: 1.5;
      }
      main {
        width: min(100%, 440px);
        padding: 24px;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--bg-2);
      }
      .mark {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: var(--radius);
        background: var(--accent);
        color: var(--accent-fg);
        font-size: 12px;
        font-weight: 700;
      }
      .kicker {
        margin: 16px 0 0;
        color: var(--mute);
        font-family: var(--mono);
        font-size: 11px;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      h1 { margin: 8px 0 0; font-size: 22px; line-height: 1.2; font-weight: 600; }
      p { margin: 10px 0 0; color: var(--mute); }
      .host span { color: var(--fg); font-family: var(--mono); font-size: 12px; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 32px;
        padding: 0 12px;
        border: 1px solid var(--line-2);
        border-radius: var(--radius);
        background: transparent;
        color: var(--fg);
        font: inherit;
        font-weight: 500;
        text-decoration: none;
      }
      .btn-primary { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">R</div>
      <p class="kicker">Ravi Pages</p>
      <h1>${escapeHtml(view.title)}</h1>
      <p>${escapeHtml(view.lead)}</p>
      <p>${escapeHtml(view.body)}</p>
      ${hostRow}
      <div class="actions">
        ${askLink}
        ${backLink}
        <a class="btn${backLink || askLink ? "" : " btn-primary"}" href="${escapeHtml(view.consoleHref)}">Abrir Console</a>
      </div>
    </main>
  </body>
</html>`;
}

function pagesAccessDeniedReason(value: string | undefined): PagesAccessDeniedReason | undefined {
  if (value && ACCESS_DENIED_REASONS.has(value as PagesAccessDeniedReason)) {
    return value as PagesAccessDeniedReason;
  }
  return undefined;
}

function parseSafePagesReturnUrl(returnTo: string | null | undefined) {
  if (!returnTo) return null;
  try {
    const url = new URL(returnTo);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
