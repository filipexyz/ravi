import { describe, expect, it } from "bun:test";
import { startTurnLink } from "./turn-link.js";

describe("startTurnLink", () => {
  it("messages nobody for a cron run acting for its creator", async () => {
    let requested = false;
    const flow = await startTurnLink("c_ana", {
      isRoutineRun: () => true,
      requestLink: (async () => {
        requested = true;
        return { status: "dm_sent" };
      }) as never,
    });
    expect(flow).toBe("routine");
    expect(requested).toBe(false);
  });
});
