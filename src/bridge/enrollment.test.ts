import { expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("supported operator enrollment replaces an existing v1 document with trust-only v2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-enroll-"));
  try {
    const script = `import {writeFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';
   import {randomUUID} from 'node:crypto';import {BridgeCommands} from './src/cli/commands/bridge.ts';
   import {getBridgeStore,bridgeStateDir} from './src/bridge/store.ts';import {runtimeIdentity} from './src/bridge/auth.ts';
   mkdirSync(bridgeStateDir(),{recursive:true});const identity=runtimeIdentity(bridgeStateDir()),store=getBridgeStore();
   const trust={id:randomUUID(),orgId:randomUUID(),installationId:randomUUID(),runtimeId:identity.runtimeId,issuer:'https://console.test',issuerPublicKey:identity.publicKey,issuerKeyId:'test',epoch:1,active:true};
   store.putEnrollment({...trust,subjects:[randomUUID()],agentIds:['test'],projectIds:[randomUUID()],capabilities:[],approvalCapabilities:[]});
   const next={...trust,epoch:2},file=join(process.env.RAVI_STATE_DIR,'enrollment.json');writeFileSync(file,JSON.stringify(next));
   new BridgeCommands().enroll(file,true,true);
   if(JSON.stringify(store.enrollment(trust.id))!==JSON.stringify(next))process.exit(2);store.close();`;
    const env: NodeJS.ProcessEnv = { ...process.env, RAVI_STATE_DIR: dir };
    for (const key of Object.keys(env)) if (key.startsWith("RAVI_") && key !== "RAVI_STATE_DIR") delete env[key];
    const child = spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text(),
      errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(output).toContain('"epoch":2');
    expect(errors).not.toContain("UNHANDLED_ERROR");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
