import { expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import type { RuntimeControlRequest } from "./types.js";

it("controls persisted Codex goals without loading a thread or starting inference", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-goal-controls-"));
  const command = join(cwd, "fake-codex.mjs");
  const ledger = join(cwd, "requests.jsonl");
  const state = join(cwd, "goal.json");
  writeFileSync(state, "null");
  writeFileSync(
    command,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const state = ${JSON.stringify(state)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({input:process.stdin}).on("line", line => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({...message, codexHome:process.env.CODEX_HOME}) + "\\n");
  if (message.id === undefined) return;
  let goal = JSON.parse(readFileSync(state,"utf8"));
  if (message.method === "initialize") return send({id:message.id,result:{}});
  if (message.method === "thread/goal/get") return send({id:message.id,result:{goal}});
  if (message.method === "thread/goal/clear") {
    writeFileSync(state,"null");
    return send({id:message.id,result:{}});
  }
  if (message.method !== "thread/goal/set") return send({id:message.id,error:{code:-32601,message:"Must not load a thread"}});
  if (message.params.objective === "malformed") return send({id:message.id,result:{}});
  const {threadId,objective,status,tokenBudget} = message.params;
  goal = {threadId,objective:objective ?? goal?.objective,status:status ?? "active",tokenBudget:tokenBudget === undefined ? goal?.tokenBudget ?? null : tokenBudget,tokensUsed:12,timeUsedSeconds:3,createdAt:1,updatedAt:2};
  writeFileSync(state,JSON.stringify(goal));
  send({id:message.id,result:{goal}});
});
`,
  );
  chmodSync(command, 0o755);
  try {
    const provider = createCodexRuntimeProvider({ command });
    const run = (request: RuntimeControlRequest) =>
      provider.controlSession!(
        { cwd, sessionId: "thread_fixture", sessionParams: { codexHome: cwd }, env: { RAVI_CODEX_TRANSPORT: "stdio" } },
        request,
      );
    const first = await run({
      operation: "goal.set",
      goal: { objective: "Finish fixture", status: "active", tokenBudget: 100 },
    });
    expect(first).toMatchObject({
      ok: true,
      goal: {
        objective: "Finish fixture",
        status: "active",
        tokensUsed: 12,
        timeUsedSeconds: 3,
        createdAt: 1000,
        updatedAt: 2000,
      },
    });
    for (const status of ["paused", "active", "blocked", "budget_limited", "usage_limited", "complete"] as const) {
      const result = await run({ operation: "goal.set", goal: { status } });
      expect(result).toMatchObject({
        ok: true,
        goal: { status, objective: "Finish fixture", tokensUsed: 12, tokenBudget: 100 },
      });
    }
    expect(await run({ operation: "goal.set", goal: { objective: "Do not replace", createOnly: true } })).toMatchObject(
      { ok: true, data: { changed: false }, goal: { objective: "Finish fixture" } },
    );
    expect(await run({ operation: "goal.set", goal: { tokenBudget: null } })).toMatchObject({
      ok: true,
      goal: { tokenBudget: null },
    });
    expect(await run({ operation: "goal.set", goal: { objective: "malformed" } })).toMatchObject({ ok: false });
    expect(await run({ operation: "goal.clear" })).toMatchObject({ ok: true, goal: null });
    expect(await run({ operation: "goal.get" })).toMatchObject({ ok: true, goal: null });
    const requests = readFileSync(ledger, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.every((request) =>
        ["initialize", "initialized", "thread/goal/get", "thread/goal/set", "thread/goal/clear"].includes(
          request.method,
        ),
      ),
    ).toBe(true);
    expect(requests.every((request) => request.codexHome === cwd)).toBe(true);
    expect(
      requests.filter((request) => request.method === "thread/goal/set").map((request) => request.params.status),
    ).toContain("usageLimited");
    expect(
      requests.filter((request) => request.method === "thread/goal/set").map((request) => request.params.status),
    ).toContain("budgetLimited");
    const pause = requests.find((request) => request.params?.status === "paused");
    expect(pause.params).toEqual({ threadId: "thread_fixture", status: "paused" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20000);
