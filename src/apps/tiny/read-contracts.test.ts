import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTinyCli } from "./cli.js";
import {
  TINY_READ_OPERATIONS,
  TINY_READ_WAVE_1_OPERATIONS,
  parseTinyReadInput,
  type TinyReadOperation,
} from "./read-contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Tiny v2 read contracts", () => {
  test("maps every current-demand read to a distinct official v2 contract", () => {
    const paths = new Set<string>();
    for (const operation of TINY_READ_OPERATIONS) {
      const input = parseTinyReadInput(operation, validArgs(operation));
      expect(input.operation).toBe(operation);
      expect(input.path).toMatch(/^\/[a-z.]+\.php$/);
      expect(input.officialDoc).toMatch(/^https:\/\/tiny\.com\.br\/api-docs\/api2-/);
      paths.add(input.path);
    }
    expect(paths.size).toBe(TINY_READ_OPERATIONS.length);
  });

  test("dry-runs every promoted wave-1 read without resolving a secret or calling the network", async () => {
    const fixture = await createFixture();
    for (const operation of TINY_READ_WAVE_1_OPERATIONS) {
      const result = await runTinyCli(
        [operation, ...validArgs(operation), "--tenant", "acme", "--dry-run", "--json"],
        fixture.env,
      );
      expect(result).toMatchObject({
        ok: true,
        dryRun: true,
        request: {
          operation,
          apiVersion: "v2",
          networkCalled: false,
          secretResolved: false,
          credentialConfigured: false,
          quota: {
            apiVersion: "v2",
            conservativePolicy: { maxInFlight: 1, minIntervalMs: 3000, maxAttempts: 1 },
          },
        },
      });
    }
  });

  test("fails closed on unbounded searches, invalid ids and invalid pagination", () => {
    expect(() => parseTinyReadInput("pedidos", [])).toThrow("consulta irrestrita foi bloqueada");
    expect(() => parseTinyReadInput("contatos", [])).toThrow("exige --pesquisa");
    expect(() => parseTinyReadInput("produtos", [])).toThrow("exige --pesquisa");
    expect(() => parseTinyReadInput("pedido", ["not-an-id"])).toThrow("use numero inteiro");
    expect(() => parseTinyReadInput("produtos", ["--pesquisa", "example", "--pagina", "0"])).toThrow(
      "inteiro positivo",
    );
  });

  test("keeps official filters on the operation that documents them", () => {
    expect(() => parseTinyReadInput("contatos", ["--pesquisa", "acme", "--id-forma-envio", "3"])).toThrow(
      "Opcao desconhecida",
    );
    expect(parseTinyReadInput("notas", ["--numero", "1", "--id-forma-envio", "3"]).params).toMatchObject({
      numero: "1",
      idFormaEnvio: "3",
    });
  });
});

function validArgs(operation: TinyReadOperation): string[] {
  switch (operation) {
    case "info":
      return [];
    case "pedidos":
    case "notas":
      return ["--numero", "1"];
    case "contatos":
    case "produtos":
    case "listas-precos":
      return ["--pesquisa", "example"];
    case "contas-receber":
    case "contas-pagar":
      return ["--numero-doc", "1"];
    case "pedido":
    case "contato":
    case "produto":
    case "estoque":
    case "nota":
    case "nota-xml":
    case "conta-receber":
    case "conta-pagar":
      return ["123456789"];
  }
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ravi-tiny-read-"));
  temporaryDirectories.push(directory);
  const configDirectory = join(directory, "tenants");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "acme.json"),
    JSON.stringify({ tenant: "acme", apiVersion: "v2", credentialConnection: "acme" }),
  );
  return {
    env: {
      RAVI_TINY_CONFIG_DIR: configDirectory,
      RAVI_CREDENTIALS_DB_PATH: join(directory, "credentials.db"),
    },
  };
}
