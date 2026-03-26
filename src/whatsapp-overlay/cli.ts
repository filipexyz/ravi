#!/usr/bin/env bun

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OverlayDomCommandRequest, OverlayDomCommandResult } from "./dom-control.js";
import type {
  OverlayComponentMatch,
  OverlayChatRowState,
  OverlayPublishedState,
  OverlaySelectorProbe,
} from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const DEFAULT_BASE_URL = process.env.RAVI_WA_OVERLAY_URL ?? "http://127.0.0.1:4210";

const program = new Command();
program.name("ravi-overlay").description("WhatsApp Web overlay inspector").version(pkg.version);

program
  .command("health")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .action(async (options: { url: string }) => {
    const res = await fetchJson(`${options.url}/health`);
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("current")
  .description("Show the latest WhatsApp Web view-state published by the extension")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--json", "Print raw JSON")
  .action(async (options: { url: string; json?: boolean }) => {
    const state = await fetchCurrent(options.url);
    if (options.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    renderCurrent(state);
  });

program
  .command("bind <session>")
  .description("Bind the currently open WhatsApp chat to a Ravi session")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--title <title>", "Override chat title")
  .option("--chat-id <chatId>", "Override chat id")
  .action(async (session: string, options: { url: string; title?: string; chatId?: string }) => {
    const state = await fetchCurrent(options.url);
    const current = state.current;
    const title = options.title ?? current?.context?.title ?? current?.view?.selectedChat ?? null;
    const chatId = options.chatId ?? current?.context?.chatId ?? current?.view?.chatIdCandidate ?? null;

    if (!title && !chatId) {
      throw new Error("No current chat title or chatId available to bind.");
    }

    const result = await postJson(`${options.url}/api/whatsapp-overlay/bind`, {
      session,
      title,
      chatId,
    });

    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("watch")
  .description("Poll the latest WhatsApp Web view-state")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--interval <ms>", "Polling interval in milliseconds", "1000")
  .option("--json", "Print raw JSON on every tick")
  .action(async (options: { url: string; interval: string; json?: boolean }) => {
    const intervalMs = Math.max(250, Number.parseInt(options.interval, 10) || 1000);
    let lastSignature = "";

    for (;;) {
      const state = await fetchCurrent(options.url);
      const signature = JSON.stringify({
        postedAt: state.current?.postedAt ?? null,
        screen: state.current?.view?.screen ?? null,
        title: state.current?.view?.title ?? null,
        session: state.snapshot?.session?.sessionName ?? null,
        activity: state.snapshot?.session?.live?.activity ?? null,
      });

      if (signature !== lastSignature) {
        console.clear();
        if (options.json) {
          console.log(JSON.stringify(state, null, 2));
        } else {
          renderCurrent(state);
        }
        lastSignature = signature;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  });

program
  .command("components")
  .description("Show the latest computed DOM components published by the extension")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--json", "Print raw JSON")
  .action(async (options: { url: string; json?: boolean }) => {
    const state = await fetchCurrent(options.url);
    const components = state.current?.view?.components ?? [];
    if (options.json) {
      console.log(JSON.stringify(components, null, 2));
      return;
    }
    renderComponents(components);
  });

program
  .command("component <id>")
  .description("Show one computed DOM component by id")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--json", "Print raw JSON")
  .action(async (id: string, options: { url: string; json?: boolean }) => {
    const state = await fetchCurrent(options.url);
    const component = (state.current?.view?.components ?? []).find((entry) => entry.id === id);
    if (!component) {
      throw new Error(`Component not found: ${id}`);
    }
    if (options.json) {
      console.log(JSON.stringify(component, null, 2));
      return;
    }
    renderComponent(component);
  });

program
  .command("selectors")
  .description("Show selector probe counts published by the extension")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--json", "Print raw JSON")
  .action(async (options: { url: string; json?: boolean }) => {
    const state = await fetchCurrent(options.url);
    const probes = state.current?.view?.selectorProbes ?? [];
    if (options.json) {
      console.log(JSON.stringify(probes, null, 2));
      return;
    }
    renderSelectorProbes(probes);
  });

program
  .command("inspect")
  .description("Inspect visible WhatsApp chat rows with their resolver/session map")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--index <n>", "Visible row index to inspect")
  .option("--title <text>", "Filter visible rows by title")
  .option("--json", "Print raw JSON")
  .action(async (options: { url: string; index?: string; title?: string; json?: boolean }) => {
    const state = await fetchCurrent(options.url);
    const rows = buildInspectRows(state.current?.view?.chatRows ?? [], options);
    if (rows.length === 0) {
      throw new Error("No visible chat row matched. Reload the extension so it republishes chatRows.");
    }

    const resolved = await resolveInspectRows(options.url, rows);
    const payload = {
      generatedAt: Date.now(),
      count: resolved.length,
      rows: resolved,
    };

    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    renderInspectRows(payload.rows);
  });

const dom = program.command("dom").description("Control and inspect WhatsApp Web DOM through the extension");

dom
  .command("query <selector>")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--limit <n>", "Limit returned nodes", "5")
  .option("--visible", "Only visible nodes")
  .option("--json", "Print raw JSON")
  .action(async (selector: string, options: { url: string; limit: string; visible?: boolean; json?: boolean }) => {
    const result = await runDomCommand(options.url, {
      name: "query",
      selector,
      limit: Number.parseInt(options.limit, 10) || 5,
      visible: options.visible,
    });
    renderDomResult(result, options.json);
  });

dom
  .command("html <selector>")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--index <n>", "Node index", "0")
  .option("--json", "Print raw JSON")
  .action(async (selector: string, options: { url: string; index: string; json?: boolean }) => {
    const result = await runDomCommand(options.url, {
      name: "html",
      selector,
      index: Number.parseInt(options.index, 10) || 0,
    });
    renderDomResult(result, options.json);
  });

dom
  .command("text <selector>")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--index <n>", "Node index", "0")
  .option("--value <text>", "Set textContent before reading it")
  .option("--json", "Print raw JSON")
  .action(async (selector: string, options: { url: string; index: string; value?: string; json?: boolean }) => {
    const result = await runDomCommand(options.url, {
      name: "text",
      selector,
      index: Number.parseInt(options.index, 10) || 0,
      text: options.value,
    });
    renderDomResult(result, options.json);
  });

dom
  .command("attr <selector> <name> [value]")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--index <n>", "Node index", "0")
  .option("--remove", "Remove the attribute instead of setting it")
  .option("--json", "Print raw JSON")
  .action(
    async (
      selector: string,
      name: string,
      value: string | undefined,
      options: { url: string; index: string; remove?: boolean; json?: boolean },
    ) => {
      const result = await runDomCommand(options.url, {
        name: "attr",
        selector,
        index: Number.parseInt(options.index, 10) || 0,
        attrName: name,
        attrValue: options.remove ? null : value,
      });
      renderDomResult(result, options.json);
    },
  );

dom
  .command("click <selector>")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--index <n>", "Node index", "0")
  .option("--json", "Print raw JSON")
  .action(async (selector: string, options: { url: string; index: string; json?: boolean }) => {
    const result = await runDomCommand(options.url, {
      name: "click",
      selector,
      index: Number.parseInt(options.index, 10) || 0,
    });
    renderDomResult(result, options.json);
  });

dom
  .command("inject <selector>")
  .requiredOption("--html <html>", "HTML content to inject")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--index <n>", "Node index", "0")
  .option("--position <pos>", "Insert position", "afterend")
  .option("--json", "Print raw JSON")
  .action(
    async (
      selector: string,
      options: {
        url: string;
        index: string;
        position: "beforebegin" | "afterbegin" | "beforeend" | "afterend";
        html: string;
        json?: boolean;
      },
    ) => {
      const result = await runDomCommand(options.url, {
        name: "inject",
        selector,
        index: Number.parseInt(options.index, 10) || 0,
        position: options.position,
        html: options.html,
      });
      renderDomResult(result, options.json);
    },
  );

dom
  .command("remove <selector>")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--visible", "Only visible nodes")
  .option("--limit <n>", "Limit removed nodes", "20")
  .option("--json", "Print raw JSON")
  .action(async (selector: string, options: { url: string; visible?: boolean; limit: string; json?: boolean }) => {
    const result = await runDomCommand(options.url, {
      name: "remove",
      selector,
      visible: options.visible,
      limit: Number.parseInt(options.limit, 10) || 20,
    });
    renderDomResult(result, options.json);
  });

dom
  .command("outline <selector>")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--color <value>", "Outline color", "#ff4d4f")
  .option("--visible", "Only visible nodes")
  .option("--limit <n>", "Limit outlined nodes", "5")
  .option("--json", "Print raw JSON")
  .action(
    async (
      selector: string,
      options: { url: string; color: string; visible?: boolean; limit: string; json?: boolean },
    ) => {
      const result = await runDomCommand(options.url, {
        name: "outline",
        selector,
        visible: options.visible,
        limit: Number.parseInt(options.limit, 10) || 5,
        attrValue: options.color,
      });
      renderDomResult(result, options.json);
    },
  );

dom
  .command("clear")
  .option("--url <baseUrl>", "Bridge base URL", DEFAULT_BASE_URL)
  .option("--json", "Print raw JSON")
  .action(async (options: { url: string; json?: boolean }) => {
    const result = await runDomCommand(options.url, { name: "clear" });
    renderDomResult(result, options.json);
  });

program.parse();

async function fetchCurrent(baseUrl: string) {
  return fetchJson(`${baseUrl}/api/whatsapp-overlay/current`);
}

async function resolveChatList(
  baseUrl: string,
  payload: { entries: Array<{ id: string; chatId?: string | null; title?: string | null; session?: string | null }> },
) {
  return postJson(`${baseUrl}/api/whatsapp-overlay/chat-list/resolve`, payload);
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function runDomCommand(baseUrl: string, request: OverlayDomCommandRequest): Promise<OverlayDomCommandResult> {
  const created = await postJson(`${baseUrl}/api/whatsapp-overlay/dom/command`, request);
  const commandId = created?.commandId;
  if (!commandId) {
    throw new Error("DOM command was not created");
  }

  const deadline = Date.now() + 8000;
  for (;;) {
    const status = await fetchJson(`${baseUrl}/api/whatsapp-overlay/dom/result?id=${encodeURIComponent(commandId)}`);
    if (status?.result) {
      return status.result as OverlayDomCommandResult;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for DOM command result: ${commandId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function renderCurrent(state: {
  current?: OverlayPublishedState | null;
  snapshot?: {
    resolved?: boolean;
    session?: {
      sessionName?: string | null;
      agentId?: string | null;
      live?: { activity?: string | null; summary?: string | null; updatedAt?: number | null };
      chatId?: string | null;
    } | null;
  } | null;
  history?: OverlayPublishedState[];
}): void {
  if (!state.current) {
    console.log("No WhatsApp Web state published yet.");
    return;
  }

  const current = state.current;
  const session = state.snapshot?.session;
  const lines = [
    `screen:   ${current.view.screen}`,
    `title:    ${current.view.title ?? "-"}`,
    `selected: ${current.view.selectedChat ?? "-"}`,
    `focus:    ${current.view.focus ?? "-"}`,
    `url:      ${current.view.url ?? "-"}`,
    `chatId:   ${current.context.chatId ?? "-"}`,
    `session:  ${session?.sessionName ?? "-"}`,
    `agent:    ${session?.agentId ?? "-"}`,
    `activity: ${session?.live?.activity ?? "-"}`,
    `summary:  ${session?.live?.summary ?? "-"}`,
    `liveAt:   ${session?.live?.updatedAt ? new Date(session.live.updatedAt).toLocaleTimeString() : "-"}`,
    `postedAt: ${new Date(current.postedAt).toLocaleString()}`,
    `signals:  header=${yesNo(current.view.hasConversationHeader)} composer=${yesNo(current.view.hasComposer)} chatList=${yesNo(current.view.hasChatList)} drawer=${yesNo(current.view.hasDrawer)} modal=${yesNo(current.view.hasModal)}`,
    `components:${current.view.components?.length ?? 0}`,
    `probes:   ${current.view.selectorProbes?.length ?? 0}`,
  ];

  console.log(lines.join("\n"));

  const history = state.history ?? [];
  if (history.length > 0) {
    console.log("\nrecent:");
    for (const item of history.slice(0, 5)) {
      console.log(
        `- ${new Date(item.postedAt).toLocaleTimeString()}  ${item.view.screen}  ${item.view.title ?? item.view.selectedChat ?? "-"}`,
      );
    }
  }
}

function buildInspectRows(
  rows: OverlayChatRowState[],
  options: { index?: string; title?: string },
): Array<OverlayChatRowState & { index: number }> {
  let next = rows.map((row, index) => ({ ...row, index }));

  if (options.title) {
    const needle = options.title.trim().toLowerCase();
    next = next.filter((row) => row.title.toLowerCase().includes(needle));
  }

  if (options.index !== undefined) {
    const index = Number.parseInt(options.index, 10);
    next = Number.isFinite(index) ? next.filter((row) => row.index === index) : [];
  }

  return next;
}

async function resolveInspectRows(
  baseUrl: string,
  rows: Array<OverlayChatRowState & { index: number }>,
): Promise<
  Array<
    OverlayChatRowState & {
      index: number;
      query: { chatId: string | null; title: string | null; session: string | null };
      matchedSession: {
        sessionName: string | null;
        agentId: string | null;
        chatId: string | null;
        status: string | null;
      } | null;
      resolved: boolean;
      warnings: string[];
    }
  >
> {
  const response = await resolveChatList(baseUrl, {
    entries: rows.map((row) => ({
      id: row.id,
      chatId: row.chatIdCandidate ?? null,
      title: row.title,
      session: null,
    })),
  });

  const byId = new Map((response?.items ?? []).map((item: any) => [item.id, item]));
  return rows.map((row) => {
    const item = byId.get(row.id);
    return {
      ...row,
      unreadCount: row.unreadCount ?? deriveUnreadCount(row.text),
      query: {
        chatId: item?.query?.chatId ?? row.chatIdCandidate ?? null,
        title: item?.query?.title ?? row.title,
        session: item?.query?.session ?? null,
      },
      matchedSession: item?.session
        ? {
            sessionName: item.session.sessionName ?? null,
            agentId: item.session.agentId ?? null,
            chatId: item.session.chatId ?? null,
            status: item.session.live?.activity ?? null,
          }
        : null,
      resolved: item?.resolved === true,
      warnings: Array.isArray(item?.warnings) ? item.warnings : [],
    };
  });
}

function deriveUnreadCount(text: string | null | undefined): number | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  const match =
    normalized.match(/(\d+)\s*mensagens?\s+n[aã]o\s+lidas?/i) ||
    normalized.match(/(\d+)\s*unread/i) ||
    normalized.match(/(\d+)\s*new message/i);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function renderInspectRows(
  rows: Array<
    OverlayChatRowState & {
      index: number;
      matchedSession: {
        sessionName: string | null;
        agentId: string | null;
        chatId: string | null;
        status: string | null;
      } | null;
      resolved: boolean;
      warnings: string[];
    }
  >,
): void {
  if (rows.length === 0) {
    console.log("No visible rows matched.");
    return;
  }

  for (const row of rows) {
    console.log(`[${row.index}] ${row.title}`);
    console.log(`  chatId:  ${row.chatIdCandidate ?? "-"}`);
    console.log(`  unread:  ${row.unreadCount ?? 0}`);
    console.log(`  selected:${row.selected ? " yes" : " no"}`);
    console.log(`  session: ${row.matchedSession?.sessionName ?? "-"}`);
    console.log(`  status:  ${row.matchedSession?.status ?? "-"}`);
    console.log(`  agent:   ${row.matchedSession?.agentId ?? "-"}`);
    console.log(`  linked:  ${row.matchedSession?.chatId ?? "-"}`);
    if (row.warnings.length > 0) {
      console.log(`  warn:    ${row.warnings.join(" | ")}`);
    }
    console.log("");
  }
}

function yesNo(value: boolean | undefined): string {
  return value ? "yes" : "no";
}

function renderComponents(components: OverlayComponentMatch[]): void {
  if (components.length === 0) {
    console.log("No computed components published yet.");
    return;
  }

  for (const component of components) {
    console.log(
      `${component.id.padEnd(20)} ${component.confidence.padEnd(6)} score=${String(component.score).padEnd(3)} selector=${component.selector ?? "-"}`,
    );
    if (component.signals?.length) {
      console.log(`  signals: ${component.signals.join(", ")}`);
    }
    if (component.count !== undefined) {
      console.log(`  count:   ${component.count}`);
    }
    if (component.extracted && Object.keys(component.extracted).length > 0) {
      console.log(`  data:    ${JSON.stringify(component.extracted)}`);
    }
  }
}

function renderComponent(component: OverlayComponentMatch): void {
  console.log(`id:         ${component.id}`);
  console.log(`surface:    ${component.surface}`);
  console.log(`selector:   ${component.selector ?? "-"}`);
  console.log(`score:      ${component.score}`);
  console.log(`confidence: ${component.confidence}`);
  console.log(`signals:    ${component.signals?.join(", ") ?? "-"}`);
  console.log(`count:      ${component.count ?? "-"}`);
  console.log(`data:       ${component.extracted ? JSON.stringify(component.extracted) : "-"}`);
}

function renderSelectorProbes(probes: OverlaySelectorProbe[]): void {
  if (probes.length === 0) {
    console.log("No selector probes published yet.");
    return;
  }

  for (const probe of probes) {
    console.log(
      `${probe.name.padEnd(24)} count=${String(probe.count).padEnd(3)} visible=${String(probe.visibleCount ?? 0).padEnd(3)} selector=${probe.selector}`,
    );
    if (probe.sampleText) {
      console.log(`  sample: ${probe.sampleText}`);
    }
    if (probe.samplePath?.length) {
      console.log(`  path:   ${probe.samplePath.join(" <- ")}`);
    }
  }
}

function renderDomResult(result: OverlayDomCommandResult, asJson?: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`ok:         ${result.ok ? "yes" : "no"}`);
  console.log(`command:    ${result.name}`);
  console.log(`finishedAt: ${new Date(result.finishedAt).toLocaleTimeString()}`);
  console.log(`targets:    ${result.targetCount ?? 0}`);

  if (result.error) {
    console.log(`error:      ${result.error}`);
  }

  if (result.output !== undefined) {
    console.log(`output:     ${typeof result.output === "string" ? result.output : JSON.stringify(result.output)}`);
  }

  if (result.nodes?.length) {
    console.log("\nnodes:");
    for (const node of result.nodes) {
      console.log(`- ${node.tag}`);
      console.log(`  text: ${node.text ?? "-"}`);
      console.log(`  path: ${node.path.join(" <- ")}`);
      if (Object.keys(node.attrs).length > 0) {
        console.log(`  attrs: ${JSON.stringify(node.attrs)}`);
      }
      if (node.html) {
        console.log(`  html: ${node.html}`);
      }
    }
  }
}
