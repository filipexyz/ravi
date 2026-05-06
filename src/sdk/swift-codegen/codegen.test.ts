import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Arg, Command, Group, Option, Returns } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { compareSwiftSdkSource, computeRegistryHash, emitAllSwift } from "./index.js";
import { jsonSchemaToSwift } from "./json-schema-to-swift.js";

@Group({ name: "artifacts", description: "Artifact ops", scope: "open" })
class ArtifactsCommands {
  @Command({ name: "show", description: "Show an artifact" })
  @Returns(z.object({ id: z.string(), kind: z.string(), links: z.array(z.object({ targetId: z.string() })) }))
  show(@Arg("id") _id: string) {
    return { id: "x", kind: "report", links: [] };
  }

  @Command({ name: "blob", description: "Stream artifact bytes" })
  @Returns.binary()
  blob(@Arg("id") _id: string) {
    return new Response("x");
  }
}

@Group({ name: "context.credentials", description: "Credentials", scope: "open" })
class ContextCredentialsCommands {
  @Command({ name: "list", description: "List credentials" })
  list(@Option({ flags: "--limit <n>", description: "Max rows" }) _limit?: string) {
    return [];
  }

  @Command({ name: "rotate", description: "Rotate keys" })
  @Returns(z.object({ ok: z.boolean() }))
  rotate(
    @Arg("agentId") _agentId: string,
    @Arg("paths", { variadic: true }) _paths: string[],
    @Option({ flags: "--dry-run" }) _dry?: boolean,
  ) {
    return { ok: true };
  }

  @Command({ name: "inspect", description: "Inspect optional credential target" })
  inspect(@Arg("name", { required: false }) _name?: string) {
    return {};
  }
}

const FIXED_VERSION = {
  sdkVersion: "9.9.9",
  registryHash: "sha256:fixed",
  gitSha: "fixed",
};

function emitMockSwiftSdk() {
  const registry = buildRegistry([ArtifactsCommands, ContextCredentialsCommands]);
  return { registry, output: emitAllSwift(registry, { version: FIXED_VERSION }) };
}

describe("swift-codegen :: emitAllSwift", () => {
  it("is deterministic across re-runs", () => {
    const a = emitMockSwiftSdk().output;
    const b = emitMockSwiftSdk().output;
    expect(a.client).toBe(b.client);
    expect(a.types).toBe(b.types);
    expect(a.schemas).toBe(b.schemas);
    expect(a.version).toBe(b.version);
  });

  it("emits a RaviClient facade with nested namespaces", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.client).toContain("public final class RaviClient");
    expect(output.client).toContain("public var artifacts: ArtifactsNamespace");
    expect(output.client).toContain("public var context: ContextNamespace");
    expect(output.client).toContain("public var credentials: ContextCredentialsNamespace");
  });

  it("threads args and options into flat transport calls", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.client).toContain("public func show(_ id: String) async throws -> ArtifactsShowReturn");
    expect(output.client).toContain(`body["id"] = try RaviJSON.fromEncodable(id)`);
    expect(output.client).toContain(
      `return try await transport.call(groupSegments: ["artifacts"], command: "show", body: body, as: ArtifactsShowReturn.self)`,
    );
  });

  it("emits options structs and options encoding", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.types).toContain("public struct ContextCredentialsListOptions: Codable, Sendable");
    expect(output.types).toContain("public var limit: String?");
    expect(output.types).toContain(`body["limit"] = try RaviJSON.fromEncodable(limit)`);
    expect(output.client).toContain("public func list(_ options: ContextCredentialsListOptions = .init())");
  });

  it("represents variadic args as arrays", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.client).toContain(
      "public func rotate(_ agentId: String, _ paths: [String], _ options: ContextCredentialsRotateOptions = .init())",
    );
    expect(output.client).toContain(`body["paths"] = try RaviJSON.fromEncodable(paths)`);
  });

  it("defaults optional positional args to nil", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.client).toContain("public func inspect(_ name: String? = nil)");
  });

  it("uses RaviJSON for unknown returns and RaviBinaryResponse for binary", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.types).toContain("public typealias ContextCredentialsListReturn = RaviJSON");
    expect(output.types).toContain("public typealias ArtifactsBlobReturn = RaviBinaryResponse");
    expect(output.client).toContain("return try await transport.callBinary");
  });

  it("emits Swift return structs for top-level object schemas", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.types).toContain("public struct ArtifactsShowReturn: Codable, Sendable");
    expect(output.types).toContain("public var id: String");
    expect(output.types).toContain("public var links: [RaviJSON]");
  });

  it("emits version constants", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.version).toContain(`public let RAVI_SDK_VERSION = "9.9.9"`);
    expect(output.version).toContain(`public let RAVI_REGISTRY_HASH = "sha256:fixed"`);
    expect(output.version).toContain(`public let RAVI_GIT_SHA = "fixed"`);
  });
});

describe("swift-codegen :: jsonSchemaToSwift", () => {
  it("keeps JSON Schema enums in valid Swift scalar types", () => {
    expect(jsonSchemaToSwift({ enum: ["active", "paused"] })).toBe("String");
    expect(jsonSchemaToSwift({ enum: [1, 2] })).toBe("Int");
    expect(jsonSchemaToSwift({ enum: [1, 2.5] })).toBe("Double");
    expect(jsonSchemaToSwift({ enum: ["active", 1] })).toBe("RaviJSON");
  });
});

describe("swift-codegen :: compareSwiftSdkSource", () => {
  function emitWith(overrides: Partial<typeof FIXED_VERSION>) {
    const registry = buildRegistry([ArtifactsCommands, ContextCredentialsCommands]);
    return emitAllSwift(registry, { version: { ...FIXED_VERSION, ...overrides } });
  }

  it("ignores only RAVI_GIT_SHA in version drift checks", () => {
    const a = emitWith({ gitSha: "aaaaaaaaaaaa" });
    const b = emitWith({ gitSha: "bbbbbbbbbbbb" });
    expect(a.version).not.toBe(b.version);
    expect(compareSwiftSdkSource("RaviVersion.generated.swift", a.version, b.version).equal).toBe(true);
    expect(
      compareSwiftSdkSource("RaviVersion.generated.swift", a.version, emitWith({ registryHash: "other" }).version)
        .equal,
    ).toBe(false);
  });

  it("requires byte equality for generated client/types/schemas", () => {
    const output = emitWith({});
    expect(compareSwiftSdkSource("RaviClient.generated.swift", output.client, output.client).equal).toBe(true);
    expect(compareSwiftSdkSource("RaviTypes.generated.swift", `${output.types}// drift\n`, output.types).equal).toBe(
      false,
    );
  });
});

describe("swift-codegen :: computeRegistryHash", () => {
  it("is stable for a registry and changes with shape", () => {
    const a = buildRegistry([ArtifactsCommands]);
    const b = buildRegistry([ArtifactsCommands, ContextCredentialsCommands]);
    expect(computeRegistryHash(a)).toBe(computeRegistryHash(a));
    expect(computeRegistryHash(a)).not.toBe(computeRegistryHash(b));
  });
});
