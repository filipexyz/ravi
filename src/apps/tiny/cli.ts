#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { TinyApiError, TinyClient } from "./client.js";
import { loadTinyTenantConfig } from "./config.js";
import { inspectTinyCredential, resolveTinyReadCredential } from "./credential.js";
import { inspectTinyV3AuthPlan } from "./oauth.js";
import {
  buildTinyReadPlan,
  isTinyReadWaveOneOperation,
  parseTinyReadInput,
  type TinyReadWaveOneOperation,
} from "./read-contracts.js";
import { buildTinyWritePlan, isTinyWriteOperation, type TinyWriteOperation } from "./write-contracts.js";
import { RaviAppFailureError, toRaviAppFailure } from "../failure.js";
import type { RaviAppFailure, RaviAppFailureCategory } from "../types.js";

interface CliArgs {
  operation: "config-check" | "v3-auth-check" | TinyReadWaveOneOperation | TinyWriteOperation;
  tenant: string;
  dryRun: boolean;
  json: boolean;
  inputFile: string | null;
  operationArgs: string[];
}

export async function runTinyCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const args = asTinyValidation(() => parseArgs(argv));
  const loaded = await loadTinyTenantConfig(args.tenant, env);
  const credentialOptions = { env };

  if (args.operation === "config-check") {
    const credential = inspectTinyCredential(loaded.config, credentialOptions);
    return {
      ok: true,
      tenant: loaded.config.tenant,
      apiVersion: loaded.config.apiVersion,
      credentialSource: "broker",
      credentialProvider: credential.provider,
      credentialConnection: credential.connection,
      credentialConfigured: credential.configured,
      credentialActive: credential.active,
      credentialBackend: credential.backend,
      secretExposed: false,
    };
  }

  if (args.operation === "v3-auth-check") {
    if (!args.dryRun) {
      throw new Error(
        "v3-auth-check nesta fase exige --dry-run; nenhum segredo, refresh ou consentimento sera executado.",
      );
    }
    return inspectTinyV3AuthPlan(loaded.config, credentialOptions);
  }

  if (isTinyWriteOperation(args.operation)) {
    if (!args.dryRun) {
      throw new Error(
        `${args.operation} ainda nao executa writes. Use --dry-run; habilitacao live exige HITL, grant e cutover autorizado.`,
      );
    }
    if (!args.inputFile) {
      throw new RaviAppFailureError({
        code: "TINY_INPUT_REQUIRED",
        category: "validation",
        message: `--input-file e obrigatorio para ${args.operation}.`,
        retryable: false,
        details: { source: "tiny" },
      });
    }
    if (args.operationArgs.length > 0) throw new Error(`Argumentos posicionais nao sao aceitos em ${args.operation}.`);
    const input = JSON.parse(await readFile(args.inputFile, "utf8")) as unknown;
    return buildTinyWritePlan(loaded.config, args.operation, input);
  }

  const readOperation = args.operation;
  if (!isTinyReadWaveOneOperation(readOperation)) {
    throw new RaviAppFailureError({
      code: "TINY_INPUT_INVALID",
      category: "validation",
      message: `Operacao Tiny nao suportada: ${readOperation}.`,
      retryable: false,
      details: { source: "tiny" },
    });
  }
  const readInput = asTinyValidation(() => parseTinyReadInput(readOperation, args.operationArgs));
  const credentialStatus = inspectTinyCredential(loaded.config, credentialOptions);
  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      request: buildTinyReadPlan(
        readInput,
        loaded.config.tenant,
        loaded.config.credentialConnection,
        credentialStatus.active,
      ),
    };
  }
  let resolved: Awaited<ReturnType<typeof resolveTinyReadCredential>>;
  try {
    resolved = await resolveTinyReadCredential(loaded.config, readInput.operation, credentialOptions);
  } catch {
    throw new RaviAppFailureError({
      code: "TINY_CREDENTIAL_MISSING",
      category: "authentication",
      message: "Tiny credential is missing or inactive for this tenant.",
      retryable: false,
      details: { source: "tiny" },
    });
  }
  const client = new TinyClient({ config: loaded.config, credential: resolved.secret });
  const result = await client.read(readInput);
  return { ok: true, dryRun: false, tenant: loaded.config.tenant, data: result.data, quota: result.quota };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const wantsJson = argv.includes("--json");
  try {
    const result = await runTinyCli(argv, env);
    process.stdout.write(`${JSON.stringify(result, null, wantsJson ? 2 : 0)}\n`);
    return 0;
  } catch (error) {
    const failure = classifyTinyFailure(error);
    if (wantsJson) {
      process.stdout.write(`${JSON.stringify({ ok: false, failure }, null, 2)}\n`);
    } else {
      process.stderr.write(`${failure.message}\n`);
    }
    return failure.exitCode;
  }
}

export function classifyTinyFailure(error: unknown): RaviAppFailure {
  if (error instanceof RaviAppFailureError) {
    return toRaviAppFailure(error, { code: error.code, message: error.message, source: "tiny" });
  }
  if (error instanceof TinyApiError) {
    const { code, category } = classifyTinyApiError(error);
    return toRaviAppFailure(
      new RaviAppFailureError({
        code,
        category,
        message: publicTinyErrorMessage(category),
        retryable: error.retryable,
        details: {
          source: "tiny",
          ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
          ...(error.retryAfterMs !== undefined ? { retryAfterSeconds: error.retryAfterMs / 1000 } : {}),
        },
      }),
      { code, message: "Tiny operation failed.", source: "tiny" },
    );
  }
  return toRaviAppFailure(error, {
    code: "TINY_OPERATION_FAILED",
    message: "Tiny operation failed.",
    source: "tiny",
  });
}

function classifyTinyApiError(error: TinyApiError): { code: string; category: RaviAppFailureCategory } {
  if (error.code === "TINY_CREDENTIAL_MISSING" || error.httpStatus === 401) {
    return { code: "TINY_CREDENTIAL_MISSING", category: "authentication" };
  }
  if (error.code === "TINY_TIMEOUT") return { code: "TINY_REQUEST_TIMEOUT", category: "timeout" };
  if (error.code === "TINY_RATE_LIMIT" || error.code === "TINY_CIRCUIT_OPEN" || error.httpStatus === 429) {
    return {
      code: error.httpStatus === 429 ? "TINY_HTTP_RATE_LIMITED" : "TINY_RATE_LIMIT_CIRCUIT_OPEN",
      category: "rate_limit",
    };
  }
  if (error.code === "TINY_FORBIDDEN" || error.httpStatus === 403) {
    return { code: "TINY_HTTP_FORBIDDEN", category: "authorization" };
  }
  if (error.code === "TINY_INVALID_RESPONSE") {
    return { code: "TINY_RESPONSE_PARSE_ERROR", category: "protocol" };
  }
  if (error.httpStatus === 404) return { code: "TINY_NOT_FOUND", category: "not_found" };
  if (error.httpStatus !== undefined && error.httpStatus >= 500) {
    return { code: "TINY_HTTP_SERVER_ERROR", category: "upstream" };
  }
  if (error.httpStatus === 400) return { code: "TINY_BAD_REQUEST", category: "validation" };
  return { code: error.code, category: "upstream" };
}

function publicTinyErrorMessage(category: RaviAppFailureCategory): string {
  switch (category) {
    case "authentication":
      return "Tiny credential is missing or inactive for this tenant.";
    case "authorization":
      return "Tiny denied this operation.";
    case "rate_limit":
      return "Tiny rate limit was reached; no automatic retry was attempted.";
    case "timeout":
      return "Tiny request timed out.";
    case "protocol":
      return "Tiny returned an invalid response.";
    case "not_found":
      return "Tiny resource was not found.";
    case "validation":
      return "Tiny rejected the request input.";
    default:
      return "Tiny returned an unsuccessful response.";
  }
}

function asTinyValidation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RaviAppFailureError) throw error;
    throw new RaviAppFailureError({
      code: "TINY_INPUT_INVALID",
      category: "validation",
      message: error instanceof Error ? error.message : "Tiny input is invalid.",
      retryable: false,
      details: { source: "tiny" },
    });
  }
}

function parseArgs(argv: string[]): CliArgs {
  const operation = argv[0];
  if (!isTinyCliOperation(operation)) {
    throw new Error(
      "Uso: tiny <config-check|v3-auth-check|read-operation|write-operation> --tenant <tenant> [args] [--input-file <path>] [--dry-run] [--json]",
    );
  }

  let tenant = "";
  let dryRun = false;
  let json = false;
  let inputFile: string | null = null;
  const operationArgs: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tenant") {
      tenant = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--input-file") {
      inputFile = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--yes") {
      throw new Error("Execucao Tiny write esta desabilitada nesta fase; --yes nao e aceito. Use --dry-run.");
    } else {
      operationArgs.push(arg);
    }
  }
  if (!tenant) throw new Error("--tenant e obrigatorio para isolar a empresa Tiny.");
  if (operation === "config-check" && dryRun) {
    throw new Error("--dry-run e valido para info e para operacoes write em preview, nao para config-check.");
  }
  if (
    (operation === "config-check" || operation === "v3-auth-check" || isTinyReadWaveOneOperation(operation)) &&
    inputFile
  ) {
    throw new Error(`--input-file nao e valido para ${operation}.`);
  }
  if ((operation === "config-check" || operation === "v3-auth-check") && operationArgs.length > 0) {
    throw new Error(`Argumentos extras nao sao validos para ${operation}.`);
  }
  return { operation: operation as CliArgs["operation"], tenant, dryRun, json, inputFile, operationArgs };
}

function isTinyCliOperation(value: string | undefined): value is CliArgs["operation"] {
  return (
    value === "config-check" ||
    value === "v3-auth-check" ||
    isTinyReadWaveOneOperation(value ?? "") ||
    isTinyWriteOperation(value ?? "")
  );
}

if (import.meta.main) {
  process.exitCode = await main();
}
