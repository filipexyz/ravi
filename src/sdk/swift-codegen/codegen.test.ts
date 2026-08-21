import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Arg, Command, Group, Option, Returns } from "../../cli/decorators.js";
import {
  commandsListReturnSchema,
  routeExplainReturnSchema,
  routeShowReturnSchema,
  routesListReturnSchema,
} from "../../cli/commands/operational-return-schemas.js";
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

@Group({ name: "crm", description: "CRM ops", scope: "open" })
class CrmCommands {
  @Command({ name: "account", description: "Show account" })
  account(@Arg("id") _id: string) {
    return {};
  }
}

@Group({ name: "crm.account", description: "CRM account ops", scope: "open" })
class CrmAccountCommands {
  @Command({ name: "create", description: "Create account" })
  create(@Arg("name") _name: string) {
    return {};
  }
}

@Group({ name: "image", description: "Image ops", scope: "open" })
class ImageCommands {
  @Command({ name: "split", description: "Split an image atlas" })
  @Returns(
    z.object({
      artifactId: z.string(),
      artifact_id: z.string(),
      "artifact-id": z.string(),
    }),
  )
  split() {
    return { artifactId: "canonical", artifact_id: "snake", "artifact-id": "kebab" };
  }
}

@Group({ name: "collisions", description: "Swift identifier collisions", scope: "open" })
class CollisionCommands {
  @Command({ name: "arguments", description: "Exercise colliding argument names" })
  arguments(
    @Arg("artifactId") _canonical: string,
    @Arg("artifact_id") _snake: string,
    @Arg("artifact-id") _kebab: string,
  ) {
    return {};
  }

  @Command({ name: "option-fields", description: "Exercise colliding option field names" })
  optionFields(
    @Option({ flags: "--artifact-id <id>" }) _canonical?: string,
    @Option({ flags: "--artifact-ID <id>" }) _alternate?: string,
  ) {
    return {};
  }

  @Command({ name: "reserved-argument", description: "Exercise the reserved options parameter" })
  reservedArgument(@Arg("options") _wireOptions: string, @Option({ flags: "--force" }) _force?: boolean) {
    return {};
  }
}

@Group({ name: "commands", description: "Ravi commands", scope: "open" })
class CommandsContractCommands {
  @Command({ name: "list", description: "List Ravi commands" })
  @Returns(commandsListReturnSchema)
  list() {
    return {};
  }
}

@Group({ name: "routes", description: "Read-only Ravi routes", scope: "admin" })
class RoutesContractCommands {
  @Command({ name: "list", description: "List routes" })
  @Returns(routesListReturnSchema)
  list() {
    return {};
  }

  @Command({ name: "show", description: "Show one route" })
  @Returns(routeShowReturnSchema)
  show() {
    return {};
  }

  @Command({ name: "explain", description: "Explain route resolution" })
  @Returns(routeExplainReturnSchema)
  explain() {
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
    expect(output.client).toContain(`requestBody["id"] = try RaviJSON.fromEncodable(id)`);
    expect(output.client).toContain(
      `return try await transport.call(groupSegments: ["artifacts"], command: "show", body: requestBody, as: ArtifactsShowReturn.self)`,
    );
  });

  it("emits options structs and options encoding", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.types).toContain("public struct ContextCredentialsListOptions: Codable, Sendable");
    expect(output.types).toContain("public var limit: String?");
    expect(output.types).toContain(`body["limit"] = try RaviJSON.fromEncodable(value)`);
    expect(output.client).toContain("public func list(_ options: ContextCredentialsListOptions = .init())");
  });

  it("represents variadic args as arrays", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.client).toContain(
      "public func rotate(_ agentId: String, _ paths: [String], _ options: ContextCredentialsRotateOptions = .init())",
    );
    expect(output.client).toContain(`requestBody["paths"] = try RaviJSON.fromEncodable(paths)`);
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

  it("emits typed commands projection models without RaviJSON", () => {
    const output = emitAllSwift(buildRegistry([CommandsContractCommands]), { version: FIXED_VERSION });

    expect(output.types).toContain("public struct CommandsListItem: Codable, Sendable");
    expect(output.types).toContain("public var arguments: [String]?");
    expect(output.types).toContain("public var issues: [CommandsListIssue]?");
    expect(output.types).toContain("CommandsListItem requires at least one field.");
    expect(output.types).toContain("CommandsListItem contains an unknown field.");
    expect(output.types).toContain("public var items: [CommandsListItem]");
    expect(output.types).toContain("public var agent: CommandsListAgent");
    expect(output.types).not.toContain("RaviJSON");
  });

  it("emits typed non-empty route projections and concrete nested route models", () => {
    const output = emitAllSwift(buildRegistry([RoutesContractCommands]), { version: FIXED_VERSION });

    expect(output.types).toContain("public struct RoutesListItem: Codable, Sendable");
    expect(output.types).toContain("RoutesListItem requires at least one field.");
    expect(output.types).toContain("RoutesListItem contains an unknown field.");
    expect(output.types).toContain("public var items: [RoutesListItem]");
    expect(output.types).toContain("public var routes: [RoutesListItem]");
    expect(output.types).toContain("public struct RoutesRouteWithTags: Codable, Sendable");
    expect(output.types).toContain("public var route: RoutesRouteWithTags");
    expect(output.types).toContain("public var origin: RoutesExplainOrigin");
    expect(output.types).toContain("public var liveEffect: RoutesExplainLiveEffect?");
  });

  it("emits Swift return structs for top-level object schemas", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.types).toContain("public struct ArtifactsShowReturn: Codable, Sendable");
    expect(output.types).toContain("public var id: String");
    expect(output.types).toContain("public var links: [RaviJSON]");
  });

  it("disambiguates property names that normalize to the same Swift identifier", () => {
    const registry = buildRegistry([ImageCommands]);
    const output = emitAllSwift(registry, { version: FIXED_VERSION });

    expect(output.types).toContain("public var artifactId: String");
    expect(output.types).toContain("public var artifact_id: String");
    expect(output.types).toContain("public var artifact_id_2: String");
    expect(output.types).toContain(`case artifactId = "artifactId"`);
    expect(output.types).toContain(`case artifact_id = "artifact_id"`);
    expect(output.types).toContain(`case artifact_id_2 = "artifact-id"`);
  });

  it("disambiguates colliding positional argument names without changing their wire keys", () => {
    const registry = buildRegistry([CollisionCommands]);
    const output = emitAllSwift(registry, { version: FIXED_VERSION });

    expect(output.client).toContain(
      "public func arguments(_ artifactId: String, _ artifact_id: String, _ artifact_id_2: String)",
    );
    expect(output.client).toContain(`requestBody["artifactId"] = try RaviJSON.fromEncodable(artifactId)`);
    expect(output.client).toContain(`requestBody["artifact_id"] = try RaviJSON.fromEncodable(artifact_id)`);
    expect(output.client).toContain(`requestBody["artifact-id"] = try RaviJSON.fromEncodable(artifact_id_2)`);
  });

  it("disambiguates colliding option struct fields without changing their coding keys", () => {
    const registry = buildRegistry([CollisionCommands]);
    const output = emitAllSwift(registry, { version: FIXED_VERSION });

    expect(output.types).toContain("public struct CollisionsOptionFieldsOptions: Codable, Sendable");
    expect(output.types).toContain("public var artifactId: String?");
    expect(output.types).toContain("public var artifact_ID: String?");
    expect(output.types).toContain(`case artifactId = "artifactId"`);
    expect(output.types).toContain(`case artifact_ID = "artifact-ID"`);
    expect(output.types).toContain(`body["artifactId"] = try RaviJSON.fromEncodable(value)`);
    expect(output.types).toContain(`body["artifact-ID"] = try RaviJSON.fromEncodable(value)`);
  });

  it("keeps the generated options bag distinct from an argument named options", () => {
    const registry = buildRegistry([CollisionCommands]);
    const output = emitAllSwift(registry, { version: FIXED_VERSION });

    expect(output.client).toContain(
      "public func reservedArgument(_ options_2: String, _ options: CollisionsReservedArgumentOptions = .init())",
    );
    expect(output.client).toContain(`requestBody["options"] = try RaviJSON.fromEncodable(options_2)`);
    expect(output.client).toContain("try options.encodeBody(into: &requestBody)");
  });

  it("disambiguates commands that are also namespace nodes", () => {
    const registry = buildRegistry([CrmCommands, CrmAccountCommands]);
    const output = emitAllSwift(registry, { version: FIXED_VERSION });

    expect(output.client).toContain("public var account: CrmAccountNamespace");
    expect(output.client).toContain("public func accountCommand(_ id: String) async throws -> CrmAccountReturn");
    expect(output.client).toContain("public func create(_ name: String) async throws -> CrmAccountCreateReturn");
    expect(output.client).toContain(`groupSegments: ["crm"], command: "account"`);
    expect(output.client).toContain(`groupSegments: ["crm","account"], command: "create"`);
  });

  it("emits version constants", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.version).toContain(`public let RAVI_SDK_VERSION = "9.9.9"`);
    expect(output.version).toContain(`public let RAVI_REGISTRY_HASH = "sha256:fixed"`);
    expect(output.version).toContain(`public let RAVI_GIT_SHA = "fixed"`);
  });

  it("uses the delegate streaming transport on platforms without URLSession.AsyncBytes", () => {
    const { output } = emitMockSwiftSdk();
    expect(output.streaming).toContain("#if os(Android) || os(Linux)");
    expect(output.streaming).toContain("RaviStreamingSessionDelegate");
    expect(output.streaming).toContain("let streamSession = URLSession(");
  });
});

describe("swift-codegen :: jsonSchemaToSwift", () => {
  it("preserves a concrete named type through a nullable union", () => {
    expect(
      jsonSchemaToSwift({
        anyOf: [
          { type: "object", title: "RoutesExplainLiveEffect", properties: { verified: { type: "boolean" } } },
          { type: "null" },
        ],
      }),
    ).toBe("RoutesExplainLiveEffect");
  });

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
