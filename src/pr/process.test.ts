import { describe, expect, it } from "bun:test";
import { runProcess } from "./process.js";

const script = (source: string) => ["-e", source];
const idle = script("setTimeout(() => {}, 30_000)");

describe("runProcess limits", () => {
  it("deadline_abort_reports_publication_timeout", async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, idle, { signal: controller.signal, timeoutMs: 20_000 });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "PUBLICATION_TIMEOUT", details: { retryable: true } });
  }, 15_000);

  it("request_timeout_has_its_own_code_and_no_budget_advice", async () => {
    const controller = new AbortController();
    const error = await runProcess(process.execPath, idle, { signal: controller.signal, timeoutMs: 200 }).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({ code: "PUBLICATION_REQUEST_TIMEOUT", details: { retryable: true } });
    expect(error.message).toContain("while the publication still had budget left");
    expect(error.message).toContain("RAVI_PR_PUBLISH_TIMEOUT_MS does not change it");
    expect(controller.signal.aborted).toBe(false);
  }, 15_000);

  it("response_cap_is_not_reported_as_timeout", async () => {
    const error = await runProcess(
      process.execPath,
      script("process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 30_000)"),
      { maxBytes: 1024, timeoutMs: 20_000 },
    ).catch((caught) => caught);
    expect(error).toMatchObject({ code: "PUBLICATION_RESPONSE_TOO_LARGE", details: { retryable: false } });
    expect(error.message).toContain("This is not a time budget");
  }, 15_000);
});
