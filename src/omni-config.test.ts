import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOmniCliAuthEnv,
  materializeOmniCliAuthConfig,
  OMNI_CLI_DEFAULT_SERVER,
  resolveOmniConnection,
} from "./omni-config.js";

describe("Omni CLI auth materialization", () => {
  it("writes the runtime primary key onto both the flat fields and servers.list.default", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-omni-cli-auth-"));
    try {
      const connection = {
        apiUrl: "http://omni.runtime.test:8882",
        apiKey: "runtime-primary-key",
        source: "omni-config" as const,
      };
      const configPath = materializeOmniCliAuthConfig(connection, dir);
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
        apiUrl: string;
        apiKey: string;
        servers: { active: string; list: Record<string, { url: string; apiKey: string }> };
      };

      expect(config.apiUrl).toBe(connection.apiUrl);
      expect(config.apiKey).toBe(connection.apiKey);
      expect(config.servers.active).toBe(OMNI_CLI_DEFAULT_SERVER);
      expect(config.servers.list[OMNI_CLI_DEFAULT_SERVER]).toEqual({
        url: connection.apiUrl,
        apiKey: connection.apiKey,
      });
      expect(buildOmniCliAuthEnv(connection, dir)).toEqual({
        OMNI_API_URL: connection.apiUrl,
        OMNI_API_KEY: connection.apiKey,
        OMNI_CONFIG_DIR: dir,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveOmniConnection prefers OMNI_API_URL/OMNI_API_KEY over any config file", () => {
    const previousUrl = process.env.OMNI_API_URL;
    const previousKey = process.env.OMNI_API_KEY;
    process.env.OMNI_API_URL = "http://env.omni.test:8882";
    process.env.OMNI_API_KEY = "env-primary-key";
    try {
      expect(resolveOmniConnection()).toEqual({
        apiUrl: "http://env.omni.test:8882",
        apiKey: "env-primary-key",
        source: "env",
      });
    } finally {
      if (previousUrl === undefined) delete process.env.OMNI_API_URL;
      else process.env.OMNI_API_URL = previousUrl;
      if (previousKey === undefined) delete process.env.OMNI_API_KEY;
      else process.env.OMNI_API_KEY = previousKey;
    }
  });
});
