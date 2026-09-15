import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Arg, Command, Group, Option, Returns } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { compareDartSdkSource, computeRegistryHash, emitAllDart } from "./index.js";
import { jsonSchemaToDart } from "./json-schema-to-dart.js";

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

@Group({ name: "collisions", description: "Dart identifier collisions", scope: "open" })
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

const FIXED_VERSION = {
  sdkVersion: "9.9.9",
  registryHash: "sha256:fixed",
  gitSha: "fixed",
};

function emitMockDartSdk() {
  const registry = buildRegistry([ArtifactsCommands, ContextCredentialsCommands]);
  return { registry, output: emitAllDart(registry, { version: FIXED_VERSION }) };
}

describe("dart-codegen :: emitAllDart", () => {
  it("is deterministic across re-runs", () => {
    const a = emitMockDartSdk().output;
    const b = emitMockDartSdk().output;
    expect(a.client).toBe(b.client);
    expect(a.types).toBe(b.types);
    expect(a.schemas).toBe(b.schemas);
    expect(a.version).toBe(b.version);
    expect(a.streaming).toBe(b.streaming);
  });

  it("emits a RaviClient facade with nested namespaces", () => {
    const { output } = emitMockDartSdk();
    expect(output.client).toContain("class RaviClient");
    expect(output.client).toContain("ArtifactsNamespace get artifacts => ArtifactsNamespace(_transport);");
    expect(output.client).toContain("ContextNamespace get context => ContextNamespace(_transport);");
    expect(output.client).toContain(
      "ContextCredentialsNamespace get credentials => ContextCredentialsNamespace(_transport);",
    );
  });

  it("threads args and options into flat transport calls", () => {
    const { output } = emitMockDartSdk();
    expect(output.client).toContain("Future<ArtifactsShowReturn> show(String id) async");
    expect(output.client).toContain(`requestBody["id"] = RaviJson.from(id);`);
    expect(output.client).toContain('groupSegments: const ["artifacts"]');
    expect(output.client).toContain('command: "show"');
    expect(output.client).toContain("decode: artifactsShowReturnFromJson");
  });

  it("emits options classes and options encoding", () => {
    const { output } = emitMockDartSdk();
    expect(output.types).toContain("class ContextCredentialsListOptions");
    expect(output.types).toContain("final String? limit;");
    expect(output.types).toContain(`into["limit"] = RaviJson.from(limit);`);
    expect(output.client).toContain(
      "Future<ContextCredentialsListReturn> list([ContextCredentialsListOptions options = const ContextCredentialsListOptions()]) async",
    );
  });

  it("represents variadic args as lists", () => {
    const { output } = emitMockDartSdk();
    expect(output.client).toContain(
      "Future<ContextCredentialsRotateReturn> rotate(String agentId, List<String> paths, [ContextCredentialsRotateOptions options = const ContextCredentialsRotateOptions()]) async",
    );
    expect(output.client).toContain(`requestBody["paths"] = RaviJson.from(paths);`);
  });

  it("defaults optional positional args to null", () => {
    const { output } = emitMockDartSdk();
    expect(output.client).toContain("Future<ContextCredentialsInspectReturn> inspect([String? name]) async");
  });

  it("uses RaviJson for unknown returns and RaviBinaryResponse for binary", () => {
    const { output } = emitMockDartSdk();
    expect(output.types).toContain("typedef ContextCredentialsListReturn = RaviJson;");
    expect(output.types).toContain("typedef ArtifactsBlobReturn = RaviBinaryResponse;");
    expect(output.client).toContain("return _transport.callBinary(");
  });

  it("emits Dart return classes for top-level object schemas", () => {
    const { output } = emitMockDartSdk();
    expect(output.types).toContain("class ArtifactsShowReturn");
    expect(output.types).toContain("final String id;");
    expect(output.types).toContain("final List<RaviJson> links;");
  });

  it("disambiguates property names that normalize to the same Dart identifier", () => {
    const registry = buildRegistry([ImageCommands]);
    const output = emitAllDart(registry, { version: FIXED_VERSION });

    expect(output.types).toContain("final String artifactId;");
    expect(output.types).toContain("final String artifact_id;");
    expect(output.types).toContain("final String artifact_id_2;");
    expect(output.types).toContain(`artifactId: raviJsonAsString(json["artifactId"])`);
    expect(output.types).toContain(`artifact_id: raviJsonAsString(json["artifact_id"])`);
    expect(output.types).toContain(`artifact_id_2: raviJsonAsString(json["artifact-id"])`);
  });

  it("disambiguates colliding positional argument names without changing their wire keys", () => {
    const registry = buildRegistry([CollisionCommands]);
    const output = emitAllDart(registry, { version: FIXED_VERSION });

    expect(output.client).toContain(
      "Future<CollisionsArgumentsReturn> arguments(String artifactId, String artifact_id, String artifact_id_2) async",
    );
    expect(output.client).toContain(`requestBody["artifactId"] = RaviJson.from(artifactId);`);
    expect(output.client).toContain(`requestBody["artifact_id"] = RaviJson.from(artifact_id);`);
    expect(output.client).toContain(`requestBody["artifact-id"] = RaviJson.from(artifact_id_2);`);
  });

  it("disambiguates colliding option class fields without changing their wire keys", () => {
    const registry = buildRegistry([CollisionCommands]);
    const output = emitAllDart(registry, { version: FIXED_VERSION });

    expect(output.types).toContain("class CollisionsOptionFieldsOptions");
    expect(output.types).toContain("final String? artifactId;");
    expect(output.types).toContain("final String? artifact_ID;");
    expect(output.types).toContain(`into["artifactId"] = RaviJson.from(artifactId);`);
    expect(output.types).toContain(`into["artifact-ID"] = RaviJson.from(artifact_ID);`);
  });

  it("keeps the generated options bag distinct from an argument named options", () => {
    const registry = buildRegistry([CollisionCommands]);
    const output = emitAllDart(registry, { version: FIXED_VERSION });

    expect(output.client).toContain(
      "Future<CollisionsReservedArgumentReturn> reservedArgument(String options_2, [CollisionsReservedArgumentOptions options = const CollisionsReservedArgumentOptions()]) async",
    );
    expect(output.client).toContain(`requestBody["options"] = RaviJson.from(options_2);`);
    expect(output.client).toContain("options.encodeBody(requestBody);");
  });

  it("disambiguates commands that are also namespace nodes", () => {
    const registry = buildRegistry([CrmCommands, CrmAccountCommands]);
    const output = emitAllDart(registry, { version: FIXED_VERSION });

    expect(output.client).toContain("CrmAccountNamespace get account => CrmAccountNamespace(_transport);");
    expect(output.client).toContain("Future<CrmAccountReturn> accountCommand(String id) async");
    expect(output.client).toContain("Future<CrmAccountCreateReturn> create(String name) async");
    expect(output.client).toContain('command: "account"');
    expect(output.client).toContain('groupSegments: const ["crm", "account"]');
  });

  it("emits version constants", () => {
    const { output } = emitMockDartSdk();
    expect(output.version).toContain('const raviSdkVersion = "9.9.9";');
    expect(output.version).toContain('const raviRegistryHash = "sha256:fixed";');
    expect(output.version).toContain('const raviGitSha = "fixed";');
  });

  it("emits an official SSE parser and never uses EventSource", () => {
    const { output } = emitMockDartSdk();
    expect(output.streaming).toContain("class RaviSseParser<T>");
    expect(output.streaming).toContain("class RaviStreamClient");
    expect(output.streaming).toContain("http.Request('GET'");
    expect(output.streaming).toContain("authorization");
    expect(output.streaming).not.toContain("EventSource");
  });
});

describe("dart-codegen :: jsonSchemaToDart", () => {
  it("keeps JSON Schema enums in valid Dart scalar types", () => {
    expect(jsonSchemaToDart({ enum: ["active", "paused"] })).toBe("String");
    expect(jsonSchemaToDart({ enum: [1, 2] })).toBe("int");
    expect(jsonSchemaToDart({ enum: [1, 2.5] })).toBe("double");
    expect(jsonSchemaToDart({ enum: ["active", 1] })).toBe("RaviJson");
  });
});

describe("dart-codegen :: compareDartSdkSource", () => {
  function emitWith(overrides: Partial<typeof FIXED_VERSION>) {
    const registry = buildRegistry([ArtifactsCommands, ContextCredentialsCommands]);
    return emitAllDart(registry, { version: { ...FIXED_VERSION, ...overrides } });
  }

  it("ignores only raviGitSha in version drift checks", () => {
    const a = emitWith({ gitSha: "aaaaaaaaaaaa" });
    const b = emitWith({ gitSha: "bbbbbbbbbbbb" });
    expect(a.version).not.toBe(b.version);
    expect(compareDartSdkSource("ravi_version.generated.dart", a.version, b.version).equal).toBe(true);
    expect(
      compareDartSdkSource("ravi_version.generated.dart", a.version, emitWith({ registryHash: "other" }).version).equal,
    ).toBe(false);
  });

  it("requires byte equality for generated client/types/schemas", () => {
    const output = emitWith({});
    expect(compareDartSdkSource("ravi_client.generated.dart", output.client, output.client).equal).toBe(true);
    expect(compareDartSdkSource("ravi_types.generated.dart", `${output.types}// drift\n`, output.types).equal).toBe(
      false,
    );
  });
});

describe("dart-codegen :: computeRegistryHash", () => {
  it("is stable for a registry and changes with shape", () => {
    const a = buildRegistry([ArtifactsCommands]);
    const b = buildRegistry([ArtifactsCommands, ContextCredentialsCommands]);
    expect(computeRegistryHash(a)).toBe(computeRegistryHash(a));
    expect(computeRegistryHash(a)).not.toBe(computeRegistryHash(b));
  });
});
