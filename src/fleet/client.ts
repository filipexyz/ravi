import { existsSync } from "node:fs";
import { spawn as spawnProcess } from "bun";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { parseSse } from "../../packages/ravi-os-sdk/src/streaming.js";
import {
  fleetDirectory,
  readFleetIdentity,
  prepareAssociation,
  writePrivateJson,
  readPrivateJson,
  generateNodeKey,
  fleetIdentitySchema,
  type FleetIdentity,
} from "./identity.js";
import { FleetJournal } from "./journal.js";
import type { RuntimeOperation, OperationResult } from "@ravi/operation-contracts/console";

export async function publicFleetRequest(consoleUrl: string, action: "start" | "poll", body: unknown) {
  const response = await fetch(new URL(`/api/fleet/associations/${action}`, consoleUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Association request refused (${response.status})`);
  return response.json();
}
export async function connectInstallation(options: {
  consoleUrl: string;
  name?: string;
  directory?: string;
  onLink: (url: string, fingerprint: string) => Promise<void>;
  signal?: AbortSignal;
}) {
  const directory = options.directory ?? fleetDirectory();
  const pending = await prepareAssociation(options.consoleUrl, options.name, directory);
  const started = (await publicFleetRequest(pending.consoleUrl, "start", {
    name: pending.name,
    platform: pending.platform,
    csr: pending.csr,
    challenge: pending.challenge,
  })) as { verificationUrl: string; fingerprint: string; associationId: string; expiresAt: string };
  const url = new URL(started.verificationUrl);
  if (url.origin !== new URL(pending.consoleUrl).origin || !/^\/[^/]+\/installations\/associate$/.test(url.pathname))
    throw new Error("Invalid verification destination");
  await options.onLink(url.href, started.fingerprint);
  while (!options.signal?.aborted && Date.now() < new Date(started.expiresAt).getTime()) {
    const result = (await publicFleetRequest(pending.consoleUrl, "poll", {
      associationId: started.associationId,
      challenge: pending.challenge,
    })) as Record<string, string>;
    if (result.status === "approved") {
      const identity = fleetIdentitySchema.parse({
        consoleUrl: pending.consoleUrl,
        privateKey: pending.privateKey,
        transportUrl: result.transportUrl,
        installationId: result.installationId,
        organizationId: result.organizationId,
        certificate: result.certificate,
        ca: result.ca,
        expiresAt: result.expiresAt,
      });
      await writePrivateJson("identity.json", identity, directory);
      await rm(join(directory, "association.json"));
      return { installationId: identity.installationId, consoleUrl: identity.consoleUrl };
    }
    if (result.status === "denied") throw new Error("Association denied");
    await delay(2000, undefined, { signal: options.signal });
  }
  if (!options.signal?.aborted) await rm(join(directory, "association.json"), { force: true });
  throw new Error(
    options.signal?.aborted
      ? "Association interrupted; run connect to resume"
      : "Association expired; run connect for a new request",
  );
}

export async function nodeRequest(
  identity: FleetIdentity,
  path: "/commands" | "/receipts" | "/rotate",
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  signal?.throwIfAborted();
  const compiled = join(import.meta.dir, "fleet-http.mjs");
  const entry = existsSync(compiled) ? compiled : join(import.meta.dir, "http-node.ts");
  const child = spawnProcess(["node", entry], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
  });
  const reader = child.stdout.getReader();
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {}
  };
  signal?.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(stop, path === "/commands" ? 85_000 : 20_000);
  const finish = () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", stop);
  };
  child.stdin.write(
    JSON.stringify({
      url: new URL(path, identity.transportUrl).href,
      body,
      key: identity.privateKey,
      cert: identity.certificate,
      ca: identity.ca,
    }),
  );
  child.stdin.end();
  let buffered = Buffer.alloc(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Native TLS transport stopped");
      buffered = Buffer.concat([buffered, value]);
      const separator = buffered.indexOf(10);
      if (separator < 0) {
        if (buffered.length > 8192) throw new Error("Invalid transport response");
        continue;
      }
      const meta = JSON.parse(buffered.subarray(0, separator).toString("utf8"));
      const pending = buffered.subarray(separator + 1);
      return new Response(
        new ReadableStream({
          start(controller) {
            if (pending.length) controller.enqueue(pending);
          },
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                finish();
                controller.close();
              } else controller.enqueue(next.value);
            } catch (error) {
              finish();
              stop();
              controller.error(error);
            }
          },
          async cancel() {
            finish();
            stop();
            await reader.cancel();
          },
        }),
        { status: meta.status, headers: meta.headers },
      );
    }
  } catch (error) {
    finish();
    stop();
    await reader.cancel().catch(() => {});
    throw error;
  }
}

async function rotate(identity: FleetIdentity, directory: string, signal?: AbortSignal) {
  const pending = ((await readPrivateJson("rotation.json", directory)) ?? {
    operationId: crypto.randomUUID(),
    ...(await generateNodeKey()),
  }) as { operationId: string; privateKey: string; csr: string };
  await writePrivateJson("rotation.json", pending, directory);
  const response = await nodeRequest(
    identity,
    "/rotate",
    { operationId: pending.operationId, csr: pending.csr },
    signal,
  );
  if (!response.ok) throw new Error(`Credential rotation refused (${response.status})`);
  const rotated = (await response.json()) as { certificate: string; expiresAt: string };
  const next = fleetIdentitySchema.parse({
    ...identity,
    privateKey: pending.privateKey,
    certificate: rotated.certificate,
    expiresAt: rotated.expiresAt,
  });
  await writePrivateJson("identity.json", next, directory);
  await rm(join(directory, "rotation.json"));
  return next;
}

export async function runFleetConnection(options: {
  directory?: string;
  signal: AbortSignal;
  execute: (command: RuntimeOperation) => Promise<OperationResult>;
  onState?: (state: "connected" | "reconnecting" | "revoked") => void;
  onError?: (error: unknown) => void;
}) {
  const directory = options.directory ?? fleetDirectory();
  const journal = new FleetJournal(join(directory, "receipts.sqlite"));
  let backoff = 1000;
  try {
    while (!options.signal.aborted) {
      try {
        let identity = await readFleetIdentity(directory);
        if (!identity) return;
        if (
          new Date(identity.expiresAt).getTime() - Date.now() < 6 * 60 * 60 * 1000 ||
          (await readPrivateJson("rotation.json", directory))
        )
          identity = await rotate(identity, directory, options.signal);
        // Reconcile durable results even if current human policy no longer allows
        // redelivery of the command. A receipt does not authorize another effect.
        for (const receipt of journal.pending(identity.installationId)) {
          const response = await nodeRequest(identity, "/receipts", receipt, options.signal);
          if ([401, 403].includes(response.status)) {
            const denial = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
            const code =
              typeof denial?.error?.code === "string" && /^[a-z_]{1,80}$/.test(denial.error.code)
                ? denial.error.code
                : "installation_refused";
            options.onError?.(new Error(code));
            options.onState?.("revoked");
            return;
          }
          const acknowledgement = (await response.json()) as { accepted?: unknown } | null;
          if (!response.ok || acknowledgement?.accepted !== true) throw new Error("Receipt not acknowledged");
          journal.acknowledge(receipt);
        }
        const stream = await nodeRequest(identity, "/commands", undefined, options.signal);
        if ([401, 403].includes(stream.status)) {
          options.onState?.("revoked");
          await stream.body?.cancel();
          return;
        }
        if (!stream.ok || !stream.headers.get("content-type")?.startsWith("text/event-stream"))
          throw new Error("Console unavailable");
        options.onState?.("connected");
        backoff = 1000;
        for await (const event of parseSse(stream.body)) {
          const current = await readFleetIdentity(directory);
          if (
            !current ||
            current.installationId !== identity.installationId ||
            current.certificate !== identity.certificate
          )
            return;
          if (event.event !== "command") continue;
          const receipt = await journal.execute(event.data, identity, options.execute);
          const response = await nodeRequest(identity, "/receipts", receipt, options.signal);
          const acknowledgement = (await response.json()) as { accepted?: unknown } | null;
          if (!response.ok || acknowledgement?.accepted !== true) throw new Error("Receipt not acknowledged");
          journal.acknowledge(receipt);
        }
      } catch (error) {
        options.onError?.(error);
        if (options.signal.aborted) break;
        options.onState?.("reconnecting");
      }
      await delay(backoff, undefined, { signal: options.signal }).catch(() => {});
      backoff = Math.min(backoff * 2, 30_000);
    }
  } finally {
    journal.close();
  }
}
