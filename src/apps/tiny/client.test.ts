import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TinyApiError, TinyClient, type TinyFetch } from "./client.js";
import { loadTinyTenantConfig, tinyConfigDirectory } from "./config.js";
import { TINY_V2_QUOTA } from "./quota.js";
import { parseTinyReadInput } from "./read-contracts.js";
import { classifyTinyFailure } from "./cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Tiny App native connector", () => {
  test("keeps tenant config under the Ravi state directory", () => {
    expect(tinyConfigDirectory({ RAVI_STATE_DIR: "/var/lib/ravi-test" })).toBe("/var/lib/ravi-test/apps/tiny/tenants");
  });

  test("loads tenant-scoped config with a broker connection and no secret value", async () => {
    const directory = await createConfig("acme", { credentialConnection: "acme-primary" });
    const loaded = await loadTinyTenantConfig("acme", { RAVI_TINY_CONFIG_DIR: directory });

    expect(loaded.config.tenant).toBe("acme");
    expect(loaded.config.credentialProvider).toBe("tiny");
    expect(loaded.config.credentialConnection).toBe("acme-primary");
    expect(JSON.stringify(loaded)).not.toContain("secret");
  });

  test("defaults the broker connection to tenant and rejects credentialEnv compatibility", async () => {
    const defaultDirectory = await createConfig("acme-br");
    const loaded = await loadTinyTenantConfig("acme-br", { RAVI_TINY_CONFIG_DIR: defaultDirectory });
    expect(loaded.config.credentialConnection).toBe("acme-br");

    const directory = await createConfig("acme", { credentialEnv: "RAVI_CONTEXT_KEY" });
    await expect(loadTinyTenantConfig("acme", { RAVI_TINY_CONFIG_DIR: directory })).rejects.toThrow(
      "credentialEnv legado nao e aceito",
    );
  });

  test("rejects a non-Tiny live host before a credential can be sent", async () => {
    const directory = await createConfig("acme", { baseUrl: "https://example.invalid/api2" });

    await expect(loadTinyTenantConfig("acme", { RAVI_TINY_CONFIG_DIR: directory })).rejects.toThrow(
      "baseUrl Tiny v2 live deve ser https://api.tiny.com.br/api2",
    );
  });

  test("fails closed when a live read has no credential", async () => {
    const client = new TinyClient({
      config: {
        tenant: "acme",
        apiVersion: "v2",
        credentialProvider: "tiny",
        credentialConnection: "acme",
        baseUrl: "https://api.tiny.com.br/api2",
      },
      credential: null,
    });

    await expect(client.accountInfo()).rejects.toThrow("Credencial Tiny ausente");
  });

  test("does not describe a v2 info request for a v3 tenant", () => {
    const client = new TinyClient({
      config: {
        tenant: "acme-v3",
        apiVersion: "v3",
        credentialProvider: "tiny",
        credentialConnection: "acme-v3",
        baseUrl: "https://api.tiny.com.br/public-api/v3",
      },
      credential: null,
    });

    expect(() => client.accountInfoPlan()).toThrow("tiny.info suporta somente API v2");
  });

  test("performs account info without exposing the credential", async () => {
    let capturedBody = "";
    const client = new TinyClient({
      config: {
        tenant: "acme",
        apiVersion: "v2",
        credentialProvider: "tiny",
        credentialConnection: "acme",
        baseUrl: "https://api.tiny.com.br/api2",
      },
      credential: "test-secret",
      fetchImpl: (async (_input, init) => {
        capturedBody = String(init?.body);
        return Response.json({ retorno: { status: "OK", status_processamento: "3", conta: { fantasia: "Example" } } });
      }) as typeof fetch,
    });

    const result = await client.accountInfo();
    expect(result).toEqual({ retorno: { status: "OK", status_processamento: "3", conta: { fantasia: "Example" } } });
    expect(capturedBody).toContain("token=test-secret");
    expect(JSON.stringify(client.accountInfoPlan())).not.toContain("test-secret");
    expect(client.accountInfoPlan()).toMatchObject({
      credentialSource: "broker",
      credentialProvider: "tiny",
      credentialConnection: "acme",
    });
  });

  test("preserves nominal list payloads and sends the selected page", async () => {
    let capturedBody = "";
    const client = createReadClient("wave-page", async (_input, init) => {
      capturedBody = String(init?.body);
      return Response.json({
        retorno: {
          status: "OK",
          status_processamento: "3",
          pagina: 2,
          numero_paginas: 3,
          produtos: [{ produto: { id: "123" } }],
        },
      });
    });

    const result = await client.read(parseTinyReadInput("produtos", ["--pesquisa", "garrafa", "--pagina", "2"]));
    expect(result.data).toMatchObject({
      retorno: { status: "OK", status_processamento: "3", pagina: 2, numero_paginas: 3 },
    });
    expect(capturedBody).toContain("pesquisa=garrafa");
    expect(capturedBody).toContain("pagina=2");
    expect(capturedBody).toContain("token=test-secret");
  });

  test("treats an empty list as a successful parity state", async () => {
    const client = createReadClient("wave-empty", async () =>
      Response.json({
        retorno: {
          status: "Erro",
          status_processamento: "3",
          codigo_erro: 20,
          erros: [{ erro: "A consulta nao retornou registros" }],
        },
      }),
    );

    const result = await client.read(parseTinyReadInput("contatos", ["--pesquisa", "sem-resultado"]));
    expect(result.data).toEqual({
      retorno: { status: "OK", status_processamento: "3", pagina: 1, numero_paginas: 0, contatos: [] },
    });
  });

  test("normalizes Tiny errors without echoing credentials or upstream messages", async () => {
    const client = createReadClient("wave-error", async () =>
      Response.json({
        retorno: { status: "Erro", status_processamento: "3", codigo_erro: 2, erros: [{ erro: "upstream-sensitive" }] },
      }),
    );

    const error = await captureError(client.read(parseTinyReadInput("produto", ["999"])));
    expect(error.message).toContain("Tiny recusou produto");
    expect(error.message).toContain("codigo 2");
    expect(error.message).not.toContain("test-secret");
    expect(error.message).not.toContain("upstream-sensitive");
  });

  test("preserves typed HTTP status, retry metadata, and request id", async () => {
    const rateLimited = createReadClient("wave-rate-limit", async () =>
      Response.json(
        { error: "sensitive upstream body" },
        { status: 429, headers: { "retry-after": "2", "x-request-id": "req-429" } },
      ),
    );

    const error = await captureError(rateLimited.read(parseTinyReadInput("info", [])));
    expect(error).toBeInstanceOf(TinyApiError);
    expect(error).toMatchObject({
      code: "TINY_RATE_LIMIT",
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 2000,
      requestId: "req-429",
    });
    expect(error.message).not.toContain("sensitive upstream body");
  });

  test("distinguishes non-retryable request errors from retryable gateway failures", async () => {
    for (const [status, code, retryable] of [
      [400, "TINY_BAD_REQUEST", false],
      [401, "TINY_UNAUTHORIZED", false],
      [404, "TINY_NOT_FOUND", false],
      [500, "TINY_HTTP_ERROR", true],
      [503, "TINY_HTTP_ERROR", true],
    ] as const) {
      const client = createReadClient(`wave-http-${status}`, async () =>
        Response.json({ error: "redacted" }, { status }),
      );
      const error = await captureError(client.read(parseTinyReadInput("info", [])));
      expect(error).toMatchObject({ code, httpStatus: status, retryable });
    }
  });

  test.each([
    {
      label: "HTTP 429",
      connection: "failure-429",
      fetchImpl: async () => new Response("quota secret", { status: 429, headers: { "retry-after": "17" } }),
      expected: {
        code: "TINY_HTTP_RATE_LIMITED",
        category: "rate_limit",
        retryable: true,
        exitCode: 5,
        details: { source: "tiny", httpStatus: 429, retryAfterSeconds: 17 },
      },
    },
    {
      label: "HTTP 403",
      connection: "failure-403",
      fetchImpl: async () => new Response("forbidden secret", { status: 403 }),
      expected: {
        code: "TINY_HTTP_FORBIDDEN",
        category: "authorization",
        retryable: false,
        exitCode: 4,
        details: { source: "tiny", httpStatus: 403 },
      },
    },
    {
      label: "HTTP 500",
      connection: "failure-500",
      fetchImpl: async () => new Response("upstream secret", { status: 500 }),
      expected: {
        code: "TINY_HTTP_SERVER_ERROR",
        category: "upstream",
        retryable: true,
        exitCode: 6,
        details: { source: "tiny", httpStatus: 500 },
      },
    },
    {
      label: "parse",
      connection: "failure-parse",
      fetchImpl: async () => new Response("not-json-secret", { status: 200 }),
      expected: {
        code: "TINY_RESPONSE_PARSE_ERROR",
        category: "protocol",
        retryable: false,
        exitCode: 7,
        details: { source: "tiny" },
      },
    },
    {
      label: "timeout",
      connection: "failure-timeout",
      fetchImpl: async () => {
        const error = new Error("timeout with secret");
        error.name = "AbortError";
        throw error;
      },
      expected: {
        code: "TINY_REQUEST_TIMEOUT",
        category: "timeout",
        retryable: true,
        exitCode: 8,
        details: { source: "tiny" },
      },
    },
  ])("classifies $label with the versioned sanitized failure envelope", async ({ connection, fetchImpl, expected }) => {
    const client = createReadClient(connection, fetchImpl);
    const failure = classifyTinyFailure(await captureError(client.read(parseTinyReadInput("info", []))));
    expect(failure).toMatchObject({ version: "ravi.app.failure/v1", ...expected });
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  test("types timeout and malformed success responses without leaking payloads", async () => {
    let timeoutRequestCount = 0;
    const timeoutClient = new TinyClient({
      config: {
        tenant: "acme",
        apiVersion: "v2",
        credentialProvider: "tiny",
        credentialConnection: "wave-timeout",
        baseUrl: "https://api.tiny.com.br/api2",
      },
      credential: "test-secret",
      timeoutMs: 5,
      fetchImpl: (async (_input, init) => {
        timeoutRequestCount += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }) as TinyFetch,
    });
    const timeout = await captureError(timeoutClient.read(parseTinyReadInput("info", [])));
    expect(timeout).toMatchObject({ code: "TINY_TIMEOUT", retryable: true });
    expect(timeoutRequestCount).toBe(1);

    const invalidClient = createReadClient(
      "wave-invalid-response",
      async () => new Response("sensitive-not-json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const invalid = await captureError(invalidClient.read(parseTinyReadInput("info", [])));
    expect(invalid).toMatchObject({ code: "TINY_INVALID_RESPONSE", retryable: false });
    expect(invalid.message).not.toContain("sensitive-not-json");
  });

  test("holds the per-connection quota slot until the in-flight request finishes", async () => {
    const policy = TINY_V2_QUOTA.conservativePolicy as { minIntervalMs: number };
    const originalInterval = policy.minIntervalMs;
    policy.minIntervalMs = 0;
    let requestCount = 0;
    let releaseFirstRequest = () => {};
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const client = createReadClient("wave-concurrency", async () => {
      requestCount += 1;
      if (requestCount === 1) await firstRequestGate;
      return Response.json({ retorno: { status: "OK", status_processamento: "3" } });
    });

    try {
      const first = client.read(parseTinyReadInput("info", []));
      while (requestCount === 0) await Promise.resolve();
      const second = client.read(parseTinyReadInput("info", []));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(requestCount).toBe(1);
      releaseFirstRequest();
      await Promise.all([first, second]);
      expect(requestCount).toBe(2);
    } finally {
      releaseFirstRequest();
      policy.minIntervalMs = originalInterval;
    }
  });
});

function createReadClient(connection: string, fetchImpl: TinyFetch): TinyClient {
  return new TinyClient({
    config: {
      tenant: "acme",
      apiVersion: "v2",
      credentialProvider: "tiny",
      credentialConnection: connection,
      baseUrl: "https://api.tiny.com.br/api2",
    },
    credential: "test-secret",
    fetchImpl,
  });
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof Error) return caught;
    throw new Error("Expected an Error instance from Tiny read.");
  }
  throw new Error("Expected Tiny read to reject.");
}

async function createConfig(
  tenant: string,
  overrides: { credentialEnv?: string; credentialConnection?: string; baseUrl?: string } = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ravi-tiny-"));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, `${tenant}.json`),
    JSON.stringify({ tenant, apiVersion: "v2", ...overrides }, null, 2),
  );
  return directory;
}
