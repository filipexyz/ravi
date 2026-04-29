import "reflect-metadata";
import { describe, expect, it } from "bun:test";

import { Arg, CliOnly, Command, Group } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { buildMetaPayload, buildRouteTable, commandUrlPath } from "./route-table.js";

@Group({ name: "alpha", description: "alpha group", scope: "open" })
class AlphaCommands {
  @Command({ name: "ping", description: "ping" })
  ping() {
    return { ok: true };
  }
}

@Group({ name: "alpha.beta", description: "nested alpha", scope: "open" })
class AlphaBetaCommands {
  @Command({ name: "show", description: "show" })
  show(@Arg("id") id: string) {
    return { id };
  }
}

@Group({ name: "local", description: "local only", scope: "open" })
class LocalOnlyCommands {
  @Command({ name: "watch", description: "watch" })
  @CliOnly()
  watch() {
    return { ok: true };
  }
}

@Group({ name: "_stream", description: "reserved", scope: "open" })
class ReservedStreamCommands {
  @Command({ name: "events", description: "reserved events" })
  events() {
    return { ok: true };
  }
}

const registry = buildRegistry([AlphaCommands, AlphaBetaCommands]);

describe("commandUrlPath", () => {
  it("joins group segments + command under /api/v1", () => {
    const ping = registry.commands.find((c) => c.fullName === "alpha.ping")!;
    expect(commandUrlPath(ping)).toBe("/api/v1/alpha/ping");
    const show = registry.commands.find((c) => c.fullName === "alpha.beta.show")!;
    expect(commandUrlPath(show)).toBe("/api/v1/alpha/beta/show");
  });
});

describe("buildRouteTable", () => {
  it("indexes every command by URL path", () => {
    const table = buildRouteTable(registry);
    expect(table.byPath.has("/api/v1/alpha/ping")).toBe(true);
    expect(table.byPath.has("/api/v1/alpha/beta/show")).toBe(true);
    expect(table.byPath.size).toBe(registry.commands.length);
    expect(table.registryHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("excludes CLI-only commands from gateway routes and meta", () => {
    const registryWithCliOnly = buildRegistry([AlphaCommands, LocalOnlyCommands]);
    const table = buildRouteTable(registryWithCliOnly);
    const meta = buildMetaPayload(table);

    expect(table.byPath.has("/api/v1/local/watch")).toBe(false);
    expect(meta.commands.some((cmd) => cmd.fullName === "local.watch")).toBe(false);
    expect(meta.commandCount).toBe(table.byPath.size);
  });

  it("reserves /api/v1/_stream/* for SSE channels", () => {
    const reservedRegistry = buildRegistry([ReservedStreamCommands]);
    expect(() => buildRouteTable(reservedRegistry)).toThrow("reserved for SDK streaming channels");
  });
});

describe("buildMetaPayload", () => {
  it("includes commands sorted by fullName with schema, scope, and path", () => {
    const meta = buildMetaPayload(buildRouteTable(registry));
    expect(meta.commandCount).toBe(registry.commands.length);
    const fullNames = meta.commands.map((c) => c.fullName);
    expect([...fullNames].sort()).toEqual(fullNames);
    const show = meta.commands.find((c) => c.fullName === "alpha.beta.show")!;
    expect(show.path).toBe("/api/v1/alpha/beta/show");
    expect(show.scope).toBe("open");
    expect(show.args[0]?.name).toBe("id");
    expect(show.args[0]?.schema).toBeDefined();
  });
});
