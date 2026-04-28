import "reflect-metadata";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import { getRegistry } from "../registry-snapshot.js";
import { emitJson } from "../../sdk/openapi/index.js";
import { emitAll, computeRegistryHash, type EmittedSdk } from "../../sdk/client-codegen/index.js";

function buildSpecJson(): string {
  return emitJson(getRegistry());
}

function writeFileSafe(target: string, body: string): string {
  const absolute = resolve(target);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body, "utf8");
  return absolute;
}

const DEFAULT_CLIENT_OUT_DIR = "packages/ravi-os-sdk/src";
const DEFAULT_SDK_VERSION = "0.1.0";
const GENERATED_FILES = ["client.ts", "schemas.ts", "types.ts", "version.ts"] as const;

type GeneratedFileName = (typeof GENERATED_FILES)[number];

function generatedSources(version: string): EmittedSdk {
  const registry = getRegistry();
  const hash = computeRegistryHash(registry);
  return emitAll(registry, {
    version: {
      sdkVersion: version,
      registryHash: hash,
      gitSha: detectGitSha(),
    },
  });
}

function generatedSourceMap(emitted: EmittedSdk): Record<GeneratedFileName, string> {
  return {
    "client.ts": emitted.client,
    "schemas.ts": emitted.schemas,
    "types.ts": emitted.types,
    "version.ts": emitted.version,
  };
}

function detectGitSha(): string {
  try {
    return execSync("git rev-parse --short=12 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

@Group({
  name: "sdk.openapi",
  description: "OpenAPI 3.1 emitter for the Ravi CLI registry",
  scope: "open",
})
export class SdkOpenApiCommands {
  @Command({ name: "emit", description: "Emit OpenAPI 3.1 spec from the CLI registry" })
  emit(
    @Option({ flags: "--out <path>", description: "Write spec JSON to this path" }) out?: string,
    @Option({ flags: "--stdout", description: "Print spec JSON to stdout" }) toStdout?: boolean,
    @Option({ flags: "--json", description: "Print the result payload as JSON" }) asJson?: boolean,
  ) {
    try {
      const json = buildSpecJson();
      if (toStdout && out) {
        fail("Pick exactly one destination: --out <path> or --stdout.");
      }

      if (toStdout) {
        process.stdout.write(`${json}\n`);
        return { status: "stdout", bytes: json.length };
      }

      const target = out?.trim() ? out : "openapi.json";
      const absolute = writeFileSafe(target, `${json}\n`);
      const payload = { status: "written" as const, path: absolute, bytes: json.length };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Wrote OpenAPI spec to ${absolute} (${json.length} bytes)`);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "check", description: "Diff a stored OpenAPI spec against the live registry" })
  check(
    @Option({ flags: "--against <path>", description: "Path to the stored spec to diff against" }) against?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const target = against?.trim();
      if (!target) fail("--against <path> is required.");
      const absolute = resolve(target);
      let stored: string;
      try {
        stored = readFileSync(absolute, "utf8");
      } catch (error) {
        fail(`Cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const live = `${buildSpecJson()}\n`;
      const drift = stored !== live && stored.trimEnd() !== live.trimEnd();
      const payload = {
        path: absolute,
        drift,
        liveBytes: live.length,
        storedBytes: stored.length,
      };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
        return payload;
      }
      if (drift) {
        console.error(`OpenAPI drift detected: ${absolute} differs from the live registry.`);
        console.error("Re-run `ravi sdk openapi emit --out <path>` to refresh the snapshot.");
        process.exit(1);
      }
      console.log(`OpenAPI snapshot is current: ${absolute}`);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

@Group({
  name: "sdk.client",
  description: "TypeScript client codegen for @ravi-os/sdk",
  scope: "open",
})
export class SdkClientCommands {
  @Command({
    name: "generate",
    description: "Generate the four @ravi-os/sdk source files from the live registry",
  })
  generate(
    @Option({
      flags: "--out <path>",
      description: "Target directory for the generated files",
      defaultValue: DEFAULT_CLIENT_OUT_DIR,
    })
    out: string = DEFAULT_CLIENT_OUT_DIR,
    @Option({ flags: "--version <semver>", description: "SDK semver baked into version.ts" })
    version?: string,
    @Option({ flags: "--json", description: "Print the result payload as JSON" })
    asJson?: boolean,
  ) {
    try {
      const sources = generatedSources(version?.trim() || DEFAULT_SDK_VERSION);
      const sourceMap = generatedSourceMap(sources);
      const written: { file: GeneratedFileName; path: string; bytes: number }[] = [];
      for (const file of GENERATED_FILES) {
        const target = resolve(out, file);
        writeFileSafe(target, sourceMap[file]);
        written.push({ file, path: target, bytes: sourceMap[file].length });
      }
      const payload = { status: "written" as const, dir: resolve(out), files: written };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        for (const w of written) {
          console.log(`Wrote ${w.file} (${w.bytes} bytes) -> ${w.path}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({
    name: "check",
    description: "Compare on-disk @ravi-os/sdk sources to a fresh emit; exit 1 on drift",
  })
  check(
    @Option({
      flags: "--out <path>",
      description: "Directory containing the generated files",
      defaultValue: DEFAULT_CLIENT_OUT_DIR,
    })
    out: string = DEFAULT_CLIENT_OUT_DIR,
    @Option({ flags: "--version <semver>", description: "SDK semver baked into version.ts" })
    version?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    try {
      const sources = generatedSources(version?.trim() || DEFAULT_SDK_VERSION);
      const sourceMap = generatedSourceMap(sources);
      const drift: { file: GeneratedFileName; reason: string; path: string }[] = [];
      const dir = resolve(out);
      for (const file of GENERATED_FILES) {
        const target = resolve(out, file);
        let stored: string;
        try {
          stored = readFileSync(target, "utf8");
        } catch (error) {
          drift.push({
            file,
            path: target,
            reason: `missing on disk (${error instanceof Error ? error.message : String(error)})`,
          });
          continue;
        }
        if (stored !== sourceMap[file]) {
          const storedSize = stored.length;
          const liveSize = sourceMap[file].length;
          drift.push({
            file,
            path: target,
            reason: `byte mismatch (stored=${storedSize}, live=${liveSize})`,
          });
        }
      }
      const payload = { dir, drift, files: GENERATED_FILES };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
        return payload;
      }
      if (drift.length > 0) {
        for (const d of drift) {
          console.error(`SDK drift: ${d.file} — ${d.reason}`);
        }
        console.error("Re-run `ravi sdk client generate` to refresh.");
        process.exit(1);
      }
      console.log(`SDK client artifacts are current at ${dir}.`);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
