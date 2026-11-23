import { SCOPE } from "./test-scope.js";
import { spawn } from "bun";
import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("candidate client delegates via public CLI with child context, without installing or granting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omie-client-test-"));
  try {
    const source = join(dir, "source"),
      output = join(dir, "candidate"),
      bin = join(dir, "bin");
    mkdirSync(join(source, "api"), { recursive: true });
    mkdirSync(bin);
    mkdirSync(join(source, "host"));
    writeFileSync(join(source, "host/app-policy.ts"), "const condition = ctx.surface.id === SCOPE.canonicalChat;");
    writeFileSync(
      join(source, "ravi.app.json"),
      JSON.stringify({ id: "omie-orders", context: { allow: [] }, operations: {} }),
    );
    writeFileSync(
      join(source, "api/cli.ts"),
      "export async function run(){\n  // There is no supported provider-action gateway\n  throw new Error('OMIE_HOST_ADAPTER_REQUIRED');\n}\n",
    );
    copyFileSync(join(import.meta.dir, "domain.ts"), join(source, "domain.ts"));
    writeFileSync(join(source, ".env"), "SYNTHETIC_SECRET=not-copied");
    const script = resolve(import.meta.dir, "../../../integrations/omie-orders/prepare-client.py");
    const scopeFile = join(dir, "scope.json");
    writeFileSync(scopeFile, JSON.stringify(SCOPE));
    const result = spawnSync("python3", [script, source, output, "--scope-file", scopeFile], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).installed).toBe(false);
    const manifest = JSON.parse(readFileSync(join(output, "ravi.app.json"), "utf8"));
    expect(manifest.operations["omie-orders.host-read"]).toMatchObject({
      interface: "builtin",
      handler: "apps.omie-orders.read",
      mutating: false,
    });
    expect(manifest.context.allow).not.toContain("execute:omie:*");
    expect(readFileSync(join(source, "api/cli.ts"), "utf8")).toContain("OMIE_HOST_ADAPTER_REQUIRED");
    const fake = join(bin, "ravi");
    writeFileSync(
      fake,
      `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,result:{success:true,childPresent:process.env.RAVI_CONTEXT_KEY==='synthetic-child',argv:process.argv.slice(2)}}));\n`,
      { mode: 0o700 },
    );
    const runner = join(dir, "runner.ts");
    writeFileSync(
      runner,
      `import {invokeApi} from './candidate/bridge.ts'; console.log(JSON.stringify(await invokeApi('produtos/pedido:ListarPedidos',{params:{pagina:1}},false)));`,
    );
    const child = spawn([process.execPath, runner], {
      env: { PATH: `${bin}:${process.env.PATH}`, RAVI_CONTEXT_KEY: "synthetic-child" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const raw = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const out = JSON.parse(raw);
    expect(out.childPresent).toBe(true);
    expect(out.argv.slice(0, 6)).toEqual(["apps", "run", "omie-orders", "host-read", "--json", "--"]);
    expect(out.argv[6]).toBe("produtos/pedido:ListarPedidos");
    expect(raw).not.toContain("synthetic-child");
    writeFileSync(
      fake,
      `#!${process.execPath}\nconsole.log(JSON.stringify({success:false,error:{code:'OMIE_OPERATION_DENIED',message:'synthetic-private-detail'}})); process.exit(1);\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      runner,
      `import {invokeApi} from './candidate/bridge.ts'; try { await invokeApi('produtos/pedido:ListarPedidos',{params:{}},false); } catch(e) {console.log(JSON.stringify({code:e.code,message:e.message}));}`,
    );
    const rejected = spawn([process.execPath, runner], {
      env: { PATH: `${bin}:${process.env.PATH}`, RAVI_CONTEXT_KEY: "synthetic-child" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const rejection = await new Response(rejected.stdout).text();
    expect(await rejected.exited).toBe(0);
    expect(JSON.parse(rejection).code).toBe("OMIE_OPERATION_DENIED");
    expect(rejection).not.toContain("synthetic-private-detail");
    symlinkSync(scopeFile, join(source, "private-scope-link.json"));
    const rejectedOutput = join(dir, "candidate-with-link");
    const unsafe = spawnSync("python3", [script, source, rejectedOutput, "--scope-file", scopeFile], {
      encoding: "utf8",
    });
    expect(unsafe.status).not.toBe(0);
    expect(existsSync(rejectedOutput)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
