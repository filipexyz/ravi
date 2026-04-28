import "reflect-metadata";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import { getRegistry } from "../registry-snapshot.js";
import { emitJson } from "../../sdk/openapi/index.js";

function buildSpecJson(): string {
  return emitJson(getRegistry());
}

function writeFileSafe(target: string, body: string): string {
  const absolute = resolve(target);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body, "utf8");
  return absolute;
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
