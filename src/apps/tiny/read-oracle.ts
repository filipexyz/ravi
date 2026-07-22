import type { LoadedRaviAppReadOracle, RaviAppReadOracleOperation } from "../read-oracle.js";
import { TinyClient, type TinyFetch } from "./client.js";
import {
  buildTinyReadPlan,
  isTinyReadWaveOneOperation,
  parseTinyReadInput,
  type TinyReadWaveOneOperation,
} from "./read-contracts.js";

const SANITIZED_CREDENTIAL = "__SANITIZED_ORACLE_CREDENTIAL__";

export const TINY_READ_ORACLE_DIMENSIONS = [
  "args",
  "endpoint",
  "input",
  "output",
  "nominal",
  "empty",
  "error",
  "pagination",
  "tenant",
  "schema",
] as const;

export type TinyReadOracleDimension = (typeof TINY_READ_ORACLE_DIMENSIONS)[number];

export interface TinyReadOracleOperationReport {
  operation: TinyReadWaveOneOperation;
  passed: TinyReadOracleDimension[];
  mismatches: Array<{ dimension: TinyReadOracleDimension; detail: string }>;
}

export interface TinyReadOracleReport {
  ok: boolean;
  oracleSha256: string;
  operations: TinyReadOracleOperationReport[];
}

export async function verifyTinyReadWaveOneOracle(loaded: LoadedRaviAppReadOracle): Promise<TinyReadOracleReport> {
  const reports: TinyReadOracleOperationReport[] = [];
  for (const [operationName, oracleOperation] of Object.entries(loaded.oracle.operations)) {
    if (!isTinyReadWaveOneOperation(operationName)) {
      throw new Error(`Tiny read oracle contains unsupported wave-1 operation: ${operationName}.`);
    }
    reports.push(await verifyOperation(operationName, oracleOperation));
  }
  return {
    ok: reports.every(({ mismatches }) => mismatches.length === 0),
    oracleSha256: loaded.sha256,
    operations: reports,
  };
}

async function verifyOperation(
  operation: TinyReadWaveOneOperation,
  oracle: RaviAppReadOracleOperation,
): Promise<TinyReadOracleOperationReport> {
  const passed: TinyReadOracleDimension[] = [];
  const mismatches: TinyReadOracleOperationReport["mismatches"] = [];
  const fixtures = requireRecord(oracle.fixtures, `${operation}.fixtures`);
  let input: ReturnType<typeof parseTinyReadInput> | null = null;

  await check("args", async () => {
    const args = requireStringArray(fixtures.args, `${operation}.fixtures.args`);
    input = parseTinyReadInput(operation, args);
  });

  await check("input", async () => {
    if (!input) throw new Error("args did not produce parsed input");
    const expected = requireRecord(fixtures.input, `${operation}.fixtures.input`);
    if (input.path !== expected.path || !sameJsonValue(input.params, expected.params)) {
      throw new Error("parsed path/params differ from oracle");
    }
  });

  await check("endpoint", async () => {
    if (!input) throw new Error("args did not produce parsed input");
    const plan = buildTinyReadPlan(input, "oracle-tenant", "oracle-connection", false);
    if (
      plan.method !== oracle.endpoint.method ||
      plan.endpointPath !== oracle.endpoint.path ||
      `${oracle.endpoint.baseUrl}${plan.endpointPath}` !== `${oracle.endpoint.baseUrl}${oracle.endpoint.path}`
    ) {
      throw new Error("request method/path differ from oracle");
    }
  });

  await check("nominal", async () => {
    if (!input) throw new Error("args did not produce parsed input");
    const fixture = requireRecord(fixtures.nominal, `${operation}.fixtures.nominal`);
    const observed = await executeFixture(operation, input, fixture.upstream);
    if (!sameJsonValue(observed.data, fixture.expected)) throw new Error("nominal output differs from oracle");
    assertRequestShape(observed.url, observed.body, oracle, input.params);
  });

  await check("output", async () => {
    if (!input) throw new Error("args did not produce parsed input");
    const fixture = requireRecord(fixtures.nominal, `${operation}.fixtures.nominal`);
    const observed = await executeFixture(operation, input, fixture.upstream, "output");
    if (!isRecord(observed.result) || !("data" in observed.result) || !("quota" in observed.result)) {
      throw new Error("client output is not the expected data/quota envelope");
    }
    const quota = isRecord(observed.result.quota) ? observed.result.quota : null;
    if (!quota || !isRecord(quota.policy) || !isRecord(quota.observed)) {
      throw new Error("client output quota is not structured");
    }
  });

  await check("empty", async () => {
    if (!input) throw new Error("args did not produce parsed input");
    const fixture = requireRecord(fixtures.empty, `${operation}.fixtures.empty`);
    if (fixture.mode === "error") {
      const error = await captureError(readFixture(operation, input, fixture.upstream, "empty"));
      assertRedactedError(error, operation, fixture.expectedCode);
      return;
    }
    const observed = await executeFixture(operation, input, fixture.upstream, "empty");
    if (!sameJsonValue(observed.data, fixture.expected)) throw new Error("empty output differs from oracle");
  });

  await check("error", async () => {
    if (!input) throw new Error("args did not produce parsed input");
    const fixture = requireRecord(fixtures.error, `${operation}.fixtures.error`);
    const error = await captureError(readFixture(operation, input, fixture.upstream, "error"));
    assertRedactedError(error, operation, fixture.expectedCode);
  });

  await check("pagination", async () => {
    const fixture = requireRecord(fixtures.pagination, `${operation}.fixtures.pagination`);
    if (fixture.mode === "not-applicable") {
      const args = requireStringArray(fixtures.args, `${operation}.fixtures.args`);
      let rejected = false;
      try {
        parseTinyReadInput(operation, [...args, "--pagina", "2"]);
      } catch (error) {
        rejected = error instanceof Error && error.message.includes("Opcao desconhecida");
      }
      if (!rejected) throw new Error("pagination should be rejected as not-applicable");
      return;
    }
    const args = requireStringArray(fixture.args, `${operation}.fixtures.pagination.args`);
    const paginationInput = parseTinyReadInput(operation, args);
    const observed = await executeFixture(operation, paginationInput, fixture.upstream, "pagination");
    if (!sameJsonValue(observed.data, fixture.expected) || new URLSearchParams(observed.body).get("pagina") !== "2") {
      throw new Error("pagination output/request differ from oracle");
    }
  });

  await check("tenant", async () => {
    if (!input) throw new Error("args did not produce parsed input");
    const fixture = requireRecord(fixtures.tenant, `${operation}.fixtures.tenant`);
    const first = requireTuple(fixture.first, `${operation}.fixtures.tenant.first`);
    const second = requireTuple(fixture.second, `${operation}.fixtures.tenant.second`);
    const firstPlan = buildTinyReadPlan(input, first[0], first[1], false);
    const secondPlan = buildTinyReadPlan(input, second[0], second[1], false);
    if (
      firstPlan.tenant !== first[0] ||
      firstPlan.credentialConnection !== first[1] ||
      secondPlan.tenant !== second[0] ||
      secondPlan.credentialConnection !== second[1] ||
      firstPlan.credentialConnection === secondPlan.credentialConnection ||
      firstPlan.networkCalled !== false ||
      firstPlan.secretResolved !== false
    ) {
      throw new Error("tenant/connection isolation differs from oracle");
    }
  });

  await check("schema", async () => {
    if (!/^[a-f0-9]{64}$/.test(oracle.outputSchema.sha256)) throw new Error("output schema hash is not pinned");
    if (oracle.outputSchema.path !== "schemas/read-output.schema.json") {
      throw new Error("unexpected output schema path");
    }
  });

  return { operation, passed, mismatches };

  async function check(dimension: TinyReadOracleDimension, assertion: () => Promise<void>): Promise<void> {
    try {
      await assertion();
      passed.push(dimension);
    } catch (error) {
      mismatches.push({ dimension, detail: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function executeFixture(
  operation: TinyReadWaveOneOperation,
  input: ReturnType<typeof parseTinyReadInput>,
  upstream: unknown,
  suffix = "nominal",
): Promise<{ data: unknown; result: unknown; url: string; body: string }> {
  let url = "";
  let body = "";
  const result = await createClient(`${suffix}-${operation}`, async (request, init) => {
    url = String(request);
    body = String(init?.body ?? "");
    return Response.json(upstream);
  }).read(input);
  return { data: result.data, result, url, body };
}

function readFixture(
  operation: TinyReadWaveOneOperation,
  input: ReturnType<typeof parseTinyReadInput>,
  upstream: unknown,
  suffix: string,
): Promise<unknown> {
  return createClient(`${suffix}-${operation}`, async () => Response.json(upstream)).read(input);
}

function createClient(connection: string, fetchImpl: TinyFetch): TinyClient {
  return new TinyClient({
    config: {
      tenant: "oracle-tenant",
      apiVersion: "v2",
      credentialProvider: "tiny",
      credentialConnection: connection,
      baseUrl: "https://api.tiny.com.br/api2",
    },
    credential: SANITIZED_CREDENTIAL,
    fetchImpl,
  });
}

function assertRequestShape(
  url: string,
  body: string,
  oracle: RaviAppReadOracleOperation,
  params: Record<string, string>,
): void {
  if (url !== `${oracle.endpoint.baseUrl}${oracle.endpoint.path}`) throw new Error("request URL differs from oracle");
  const bodyNames = Array.from(new URLSearchParams(body).keys()).sort();
  const expectedNames = ["formato", "token", ...Object.keys(params)].sort();
  if (!sameJsonValue(bodyNames, expectedNames)) throw new Error("request parameter names differ from oracle");
}

function assertRedactedError(error: Error, operation: string, expectedCode: unknown): void {
  if (
    !error.message.includes(`Tiny recusou ${operation}`) ||
    !error.message.includes(`codigo ${String(expectedCode)}`)
  ) {
    throw new Error("error code/operation differ from oracle");
  }
  if (error.message.includes("sanitized-upstream-error") || error.message.includes("sanitized-empty")) {
    throw new Error("upstream error text was not redacted");
  }
  if (error.message.includes(SANITIZED_CREDENTIAL)) throw new Error("credential leaked in error text");
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Tiny oracle expected Error instance.");
  }
  throw new Error("Tiny oracle expected rejection.");
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be a string array.`);
  }
  return value as string[];
}

function requireTuple(value: unknown, path: string): [string, string] {
  if (!Array.isArray(value) || value.length !== 2 || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be [tenant, connection].`);
  }
  return value as [string, string];
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
