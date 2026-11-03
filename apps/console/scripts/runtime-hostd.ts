import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type JsonRecord = Record<string, unknown>;
export type RuntimeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type RuntimeHostInventory = {
  architecture: string;
  capacity: JsonRecord;
  health: JsonRecord;
  hostname: string;
  placementClasses: string[];
};

export type RuntimeHostdConfig = {
  consoleUrl: string;
  controlToken: string;
  environment: "development" | "preview" | "production";
  hostProvider: string;
  imageName: string;
  imageVersion: string;
  organizationId: string;
  projectId: string | null;
  region: string | null;
  runtimeModel: string | null;
  runtimeProvider: string;
  sandboxDriver: "process";
  sessionKey: string | null;
  vercelBypassSecret: string | null;
};

export type RuntimeHostdSmokeSummary = {
  consoleUrl: string;
  driver: RuntimeHostdConfig["sandboxDriver"];
  hostId: string;
  imageId: string;
  leaseId: string;
  managedRuntimeSessionId: string;
  sandboxId: string;
  status: "completed";
};

type RuntimeHostdSmokeOptions = {
  fetchImpl?: RuntimeFetch;
  inventory?: RuntimeHostInventory;
  sandboxId?: string;
};

type RuntimeApiHostResponse = {
  host: {
    id: string;
  };
};

type RuntimeApiImageResponse = {
  image: {
    id: string;
  };
};

type RuntimeApiLeaseRequestResponse = {
  lease: {
    id: string;
  };
  leaseToken: string;
};

type RuntimeApiLeaseValidateResponse = {
  managedRuntimeSessionId: string;
};

type RuntimeApiEventsResponse = {
  accepted: number;
  managedRuntimeSessionId: string;
};

export class RuntimeHostdApiError extends Error {
  constructor(
    public readonly route: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId: string | null,
  ) {
    super(`runtime_hostd_api_error route=${route} status=${status} code=${code}`);
    this.name = "RuntimeHostdApiError";
  }
}

export async function readRuntimeHostInventory(hostnameOverride?: string): Promise<RuntimeHostInventory> {
  const architecture = normalizeArchitecture(os.arch());
  const cpuCount = os.cpus().length;
  const totalMemoryMb = Math.floor(os.totalmem() / 1024 / 1024);
  const freeMemoryMb = Math.floor(os.freemem() / 1024 / 1024);
  const kvmAvailable = await fileExists("/dev/kvm");
  const cpuinfo = await readOptionalText("/proc/cpuinfo");
  const virtualizationCount = cpuinfo
    ? (cpuinfo.match(/\b(vmx|svm)\b/g) ?? []).length
    : null;
  const firecrackerPath = await which("firecracker");
  const jailerPath = await which("jailer");
  const placementClasses = [
    "p0",
    "outbound-hostd",
    "process-smoke",
    architecture,
    ...(kvmAvailable ? ["kvm"] : []),
    ...(firecrackerPath ? ["firecracker"] : []),
  ];

  return {
    architecture,
    hostname: hostnameOverride?.trim() || os.hostname(),
    placementClasses,
    capacity: {
      cpuCount,
      freeMemoryMb,
      totalMemoryMb,
    },
    health: {
      firecrackerPath,
      jailerPath,
      kernel: `${os.type()} ${os.release()}`,
      kvmAvailable,
      platform: os.platform(),
      processUser: os.userInfo().username,
      virtualizationCount,
    },
  };
}

export async function runP0Smoke(
  config: RuntimeHostdConfig,
  options: RuntimeHostdSmokeOptions = {},
): Promise<RuntimeHostdSmokeSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const inventory = options.inventory ?? await readRuntimeHostInventory();
  const client = new RuntimeHostdClient(
    config.consoleUrl,
    config.controlToken,
    config.vercelBypassSecret,
    fetchImpl,
  );
  const sandboxId = options.sandboxId ?? `p0-smoke-${randomUUID()}`;

  const hostResponse = await client.controlPost<RuntimeApiHostResponse>(
    "/api/internal/runtime/hosts/register",
    {
      capacity: inventory.capacity,
      displayName: inventory.hostname,
      environment: config.environment,
      health: inventory.health,
      hostname: inventory.hostname,
      placementClasses: inventory.placementClasses,
      provider: config.hostProvider,
      region: config.region,
      status: "active",
    },
  );
  const hostId = requireRuntimeId(hostResponse.host?.id, "host.id");

  await client.controlPost("/api/internal/runtime/hosts/heartbeat", {
    capacity: inventory.capacity,
    health: {
      ...inventory.health,
      lastSmokeStartedAt: new Date().toISOString(),
    },
    hostId,
    placementClasses: inventory.placementClasses,
    status: "active",
  });

  const imageResponse = await client.controlPost<RuntimeApiImageResponse>(
    "/api/internal/runtime/images/register",
    {
      architecture: inventory.architecture,
      baseOs: "host-process-smoke",
      digest: stableSmokeImageDigest(config.imageName, config.imageVersion, inventory.architecture),
      kernelRef: "host-process-smoke",
      name: config.imageName,
      providerSupport: {
        [config.runtimeProvider]: true,
        smoke: true,
      },
      rootfsRef: "host-process-smoke",
      status: "active",
      version: config.imageVersion,
    },
  );
  const imageId = requireRuntimeId(imageResponse.image?.id, "image.id");

  const leaseResponse = await client.controlPost<RuntimeApiLeaseRequestResponse>(
    "/api/internal/runtime/leases/request",
    {
      hostId,
      imageId,
      leaseTtlSeconds: 900,
      limits: {
        driver: config.sandboxDriver,
        memoryMb: 512,
        vcpus: 1,
        wallClockSeconds: 60,
      },
      organizationId: config.organizationId,
      placement: "cloud",
      projectId: config.projectId,
      runtimeModel: config.runtimeModel,
      runtimeProvider: config.runtimeProvider,
      safeMetadata: {
        hostd: "p0",
        smoke: true,
      },
      sessionKey: config.sessionKey,
    },
  );
  const leaseId = requireRuntimeId(leaseResponse.lease?.id, "lease.id");
  const leaseToken = requireRuntimeToken(leaseResponse.leaseToken);

  await client.leasePost("/api/internal/runtime/leases/claim", {
    hostId,
    leaseToken,
    sandboxId,
  });

  const validateResponse = await client.leasePost<RuntimeApiLeaseValidateResponse>(
    "/api/internal/runtime/leases/validate",
    {
      leaseToken,
      sandboxId,
    },
  );
  const managedRuntimeSessionId = requireRuntimeId(
    validateResponse.managedRuntimeSessionId,
    "managedRuntimeSessionId",
  );

  const eventsResponse = await client.leasePost<RuntimeApiEventsResponse>(
    "/api/internal/runtime/events",
    {
      events: buildP0SmokeEvents({
        managedRuntimeSessionId,
        runtimeProvider: config.runtimeProvider,
        sandboxDriver: config.sandboxDriver,
        sandboxId,
      }),
      leaseToken,
      sandboxId,
    },
  );

  if (eventsResponse.accepted < 1) {
    throw new Error("runtime_hostd_no_events_accepted");
  }

  return {
    consoleUrl: config.consoleUrl,
    driver: config.sandboxDriver,
    hostId,
    imageId,
    leaseId,
    managedRuntimeSessionId,
    sandboxId,
    status: "completed",
  };
}

export function buildP0SmokeEvents(input: {
  managedRuntimeSessionId: string;
  runtimeProvider: string;
  sandboxDriver: RuntimeHostdConfig["sandboxDriver"];
  sandboxId: string;
}) {
  const eventPrefix = `hostd-p0-${input.sandboxId}`;
  return [
    {
      eventType: "thread.started",
      safePayload: {
        managedRuntimeSessionId: input.managedRuntimeSessionId,
        sandboxDriver: input.sandboxDriver,
        smoke: true,
      },
      sequence: 1,
      severity: "info",
      sourceEventId: `${eventPrefix}-thread-started`,
    },
    {
      eventType: "turn.started",
      safePayload: {
        runtimeProvider: input.runtimeProvider,
        sandboxDriver: input.sandboxDriver,
        smoke: true,
      },
      sequence: 2,
      severity: "info",
      sourceEventId: `${eventPrefix}-turn-started`,
    },
    {
      eventType: "status",
      safePayload: {
        message: "runtime-hostd process smoke executed",
        sandboxDriver: input.sandboxDriver,
        smoke: true,
      },
      sequence: 3,
      severity: "info",
      sourceEventId: `${eventPrefix}-status`,
    },
    {
      eventType: "assistant.message",
      safePayload: {
        text: "Ravi managed runtime P0 smoke completed.",
        smoke: true,
      },
      sequence: 4,
      severity: "info",
      sourceEventId: `${eventPrefix}-assistant-message`,
    },
    {
      eventType: "turn.complete",
      safePayload: {
        sandboxDriver: input.sandboxDriver,
        smoke: true,
      },
      sequence: 5,
      severity: "info",
      sourceEventId: `${eventPrefix}-turn-complete`,
    },
  ] as const;
}

export function parseRuntimeHostdArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex >= 0) {
      flags[trimmed.slice(0, equalsIndex)] = trimmed.slice(equalsIndex + 1);
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[trimmed] = next;
      index += 1;
    } else {
      flags[trimmed] = true;
    }
  }

  return {
    command: positionals[0] ?? "help",
    flags,
  };
}

export function loadRuntimeHostdConfig(flags: Record<string, string | boolean>): RuntimeHostdConfig {
  const sandboxDriver = stringFlag(flags, "sandbox-driver", process.env.RAVI_RUNTIME_SANDBOX_DRIVER ?? "process");
  if (sandboxDriver !== "process") {
    throw new Error("runtime_hostd_only_process_driver_is_enabled_for_p0");
  }

  return {
    consoleUrl: normalizeConsoleUrl(requiredConfig("console-url", flags, "CONSOLE_URL")),
    controlToken: requiredConfig("token", flags, "RAVI_RUNTIME_CONTROL_TOKEN"),
    environment: environmentFlag(flags),
    hostProvider: stringFlag(flags, "host-provider", process.env.RAVI_RUNTIME_HOST_PROVIDER ?? "ovh"),
    imageName: stringFlag(flags, "image-name", process.env.RAVI_RUNTIME_IMAGE_NAME ?? "ravi-runtime-hostd"),
    imageVersion: stringFlag(flags, "image-version", process.env.RAVI_RUNTIME_IMAGE_VERSION ?? "p0-smoke"),
    organizationId: requiredConfig("organization-id", flags, "RAVI_RUNTIME_ORGANIZATION_ID"),
    projectId: nullableStringFlag(flags, "project-id", process.env.RAVI_RUNTIME_PROJECT_ID),
    region: nullableStringFlag(flags, "region", process.env.RAVI_RUNTIME_REGION ?? "bhs"),
    runtimeModel: nullableStringFlag(flags, "runtime-model", process.env.RAVI_RUNTIME_MODEL),
    runtimeProvider: stringFlag(flags, "runtime-provider", process.env.RAVI_RUNTIME_PROVIDER ?? "codex"),
    sandboxDriver,
    sessionKey: nullableStringFlag(
      flags,
      "session-key",
      process.env.RAVI_RUNTIME_SESSION_KEY ?? "agent:ravi-agents-cloud:p0-smoke",
    ),
    vercelBypassSecret: nullableStringFlag(
      flags,
      "vercel-bypass-secret",
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    ),
  };
}

class RuntimeHostdClient {
  constructor(
    private readonly consoleUrl: string,
    private readonly controlToken: string,
    private readonly vercelBypassSecret: string | null,
    private readonly fetchImpl: RuntimeFetch,
  ) {}

  async controlPost<T = JsonRecord>(route: string, body: JsonRecord): Promise<T> {
    return this.post<T>(route, body, {
      authorization: `Bearer ${this.controlToken}`,
    });
  }

  async leasePost<T = JsonRecord>(route: string, body: JsonRecord): Promise<T> {
    return this.post<T>(route, body, {});
  }

  private async post<T>(route: string, body: JsonRecord, headers: Record<string, string>): Promise<T> {
    const response = await this.fetchImpl(`${this.consoleUrl}${route}`, {
      body: JSON.stringify(body),
      headers: {
        ...headers,
        "content-type": "application/json",
        ...this.protectionHeaders(),
      },
      method: "POST",
    });
    const payload = await parseRuntimeApiPayload(response);
    if (!response.ok) {
      throw new RuntimeHostdApiError(
        route,
        response.status,
        runtimeString(payload, "code") ?? "runtime_api_error",
        runtimeString(payload, "requestId"),
      );
    }
    return payload as T;
  }

  private protectionHeaders(): Record<string, string> {
    return this.vercelBypassSecret
      ? { "x-vercel-protection-bypass": this.vercelBypassSecret }
      : {};
  }
}

async function parseRuntimeApiPayload(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as JsonRecord;
}

async function main() {
  const parsed = parseRuntimeHostdArgs(process.argv.slice(2));

  if (parsed.command === "help") {
    printHelp();
    return;
  }

  if (parsed.command === "inventory") {
    const inventory = await readRuntimeHostInventory(stringFlag(parsed.flags, "hostname", ""));
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }

  if (parsed.command === "smoke") {
    const config = loadRuntimeHostdConfig(parsed.flags);
    const summary = await runP0Smoke(config, {
      inventory: await readRuntimeHostInventory(stringFlag(parsed.flags, "hostname", "")),
      sandboxId: nullableStringFlag(parsed.flags, "sandbox-id", null) ?? undefined,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  throw new Error(`runtime_hostd_unknown_command:${parsed.command}`);
}

function printHelp() {
  console.log(`Usage:
  bun run runtime-hostd inventory [--hostname <name>]
  bun run runtime-hostd smoke --console-url <url> --token <control-token> --organization-id <uuid>

Environment:
  CONSOLE_URL
  RAVI_RUNTIME_CONTROL_TOKEN
  RAVI_RUNTIME_ORGANIZATION_ID
  RAVI_RUNTIME_PROJECT_ID
  RAVI_RUNTIME_PROVIDER
  RAVI_RUNTIME_MODEL
  VERCEL_AUTOMATION_BYPASS_SECRET

P0 supports only --sandbox-driver process. The smoke command never prints lease tokens.`);
}

function normalizeArchitecture(value: string) {
  if (value === "x64") return "x86_64";
  return value;
}

function normalizeConsoleUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function environmentFlag(flags: Record<string, string | boolean>) {
  const value = stringFlag(flags, "environment", process.env.RAVI_RUNTIME_ENVIRONMENT ?? "development");
  if (value === "development" || value === "preview" || value === "production") return value;
  throw new Error("runtime_hostd_invalid_environment");
}

function requiredConfig(
  flagName: string,
  flags: Record<string, string | boolean>,
  envName: string,
) {
  const value = stringFlag(flags, flagName, process.env[envName]);
  if (!value) {
    throw new Error(`runtime_hostd_missing_config:${flagName}`);
  }
  return value;
}

function nullableStringFlag(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: string | null | undefined,
) {
  const value = stringFlag(flags, key, fallback ?? "");
  return value ? value : null;
}

function stringFlag(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: string | undefined,
) {
  const value = flags[key];
  if (typeof value === "string") return value.trim();
  return fallback?.trim() ?? "";
}

function runtimeString(payload: JsonRecord, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function requireRuntimeId(value: unknown, label: string) {
  if (typeof value !== "string" || !value) {
    throw new Error(`runtime_hostd_missing_response:${label}`);
  }
  return value;
}

function requireRuntimeToken(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("ravi_rlt_")) {
    throw new Error("runtime_hostd_invalid_lease_token_response");
  }
  return value;
}

function stableSmokeImageDigest(name: string, version: string, architecture: string) {
  const digest = createHash("sha256")
    .update(`ravi-runtime-hostd-p0:${name}:${version}:${architecture}`)
    .digest("hex");
  return `sha256:${digest}`;
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalText(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function which(binary: string) {
  const paths = process.env.PATH?.split(path.delimiter) ?? [];
  for (const dir of paths) {
    const candidate = path.join(dir, binary);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "runtime_hostd_failed");
    process.exitCode = 1;
  });
}
