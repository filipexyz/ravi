import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  EXECUTION_AUTHORITY_PROTOCOL,
  EXECUTION_AUTHORITY_PUBLIC_SCHEMAS,
  EXECUTION_AUTHORITY_SCHEMA_VERSION,
} from "../packages/ravi-os-sdk/src/execution-authority.js";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const sourcePath = path.join(
  repositoryRoot,
  "packages/ravi-os-sdk/src/execution-authority.ts",
);
const outputPath = path.join(
  repositoryRoot,
  "packages/ravi-os-sdk/src/generated/execution-authority.schema.json",
);
const fixturePaths = [
  "packages/ravi-os-sdk/src/__tests__/fixtures/execution-authority/approval-request.json",
  "packages/ravi-os-sdk/src/__tests__/fixtures/execution-authority/binding-envelope-claims.json",
  "packages/ravi-os-sdk/src/__tests__/fixtures/execution-authority/execution-grant-claims.json",
  "packages/ravi-os-sdk/src/__tests__/fixtures/execution-authority/route-lease-claims.json",
] as const;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

async function sourceDigest(): Promise<string> {
  const digest = createHash("sha256");
  for (const relativePath of [
    "packages/ravi-os-sdk/src/execution-authority.ts",
    ...fixturePaths,
  ]) {
    digest.update(relativePath);
    digest.update("\0");
    digest.update(await readFile(path.join(repositoryRoot, relativePath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function desiredOutput(): Promise<string> {
  const fixtureDigests = Object.fromEntries(
    await Promise.all(
      fixturePaths.map(async (relativePath) => [
        relativePath,
        createHash("sha256")
          .update(await readFile(path.join(repositoryRoot, relativePath)))
          .digest("hex"),
      ]),
    ),
  );
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:ravi:execution-authority:v${EXECUTION_AUTHORITY_SCHEMA_VERSION}`,
    title: "Ravi neutral execution authority contract",
    protocol: EXECUTION_AUTHORITY_PROTOCOL,
    schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
    sourcePath: path.relative(repositoryRoot, sourcePath),
    sourceDigest: await sourceDigest(),
    fixtureDigests,
    $defs: Object.fromEntries(
      Object.entries(EXECUTION_AUTHORITY_PUBLIC_SCHEMAS).map(
        ([name, schema]) => [
          name,
          z.toJSONSchema(schema, {
            target: "draft-2020-12",
            io: "input",
            unrepresentable: "throw",
          }),
        ],
      ),
    ),
  };
  return `${JSON.stringify(sortJson(document), null, 2)}\n`;
}

const desired = await desiredOutput();
if (process.argv.includes("--check")) {
  const existing = await Bun.file(outputPath).text();
  if (existing !== desired) {
    throw new Error(
      "execution-authority generated schema is stale; run bun run sdk:execution-authority:generate",
    );
  }
} else {
  await writeFile(outputPath, desired);
}
