import { expect, it, spyOn } from "bun:test";
import * as natsConnection from "../nats.js";

it("propagates the original leadership release failure to shutdown", async () => {
  const cause = new Error("leader KV delete failed");
  const roles: string[] = [];
  const connection = spyOn(natsConnection, "getNats").mockReturnValue({
    jetstream: () => ({
      views: {
        kv: async () => ({
          delete: async (role: string) => {
            roles.push(role);
            throw cause;
          },
        }),
      },
    }),
  } as unknown as ReturnType<typeof natsConnection.getNats>);
  try {
    // Keep the cached fake KV confined to this module instance.
    const leader: typeof import("./index.js") = await import(
      new URL(`./index.ts?shutdown-test=${crypto.randomUUID()}`, import.meta.url).href
    );
    await expect(leader.releaseLeadership("runners")).rejects.toBe(cause);
    expect(roles).toEqual(["runners"]);
  } finally {
    connection.mockRestore();
  }
});
