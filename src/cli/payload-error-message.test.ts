import { describe, expect, it } from "bun:test";
import {
  inferPayloadIssuePath,
  looksLikeProviderDump,
  payloadInvalidIssues,
  redactAbsolutePathsInText,
  sanitizePayloadInvalidMessage,
} from "./payload-error-message.js";

describe("payload invalid message sanitization", () => {
  it("keeps local CLI reasons and redacts absolute paths", () => {
    expect(sanitizePayloadInvalidMessage("--html file was not found: ./index.html")).toBe(
      "--html file was not found: ./index.html",
    );
    expect(sanitizePayloadInvalidMessage("--dir was not found: ../site")).toBe("--dir was not found: ../site");
    expect(sanitizePayloadInvalidMessage("--html file was not found: /tmp/secret/index.html")).toBe(
      "--html file was not found: [REDACTED:path]",
    );
    expect(sanitizePayloadInvalidMessage("Missing Console project. Set one with:\n  ravi cloud scope set")).toContain(
      "Missing Console project",
    );
    expect(
      sanitizePayloadInvalidMessage(
        'Console project "main" was not found. Use an existing Console project ref or set one with:\n  ravi cloud scope set --project <project-ref>',
      ),
    ).toContain("was not found");
    expect(
      inferPayloadIssuePath(
        'Console project "main" was not found. Use an existing Console project ref or set one with:\n  ravi cloud scope set --project <project-ref>',
      ),
    ).toEqual(["project"]);
  });

  it("drops provider dumps and unstructured secrets", () => {
    expect(sanitizePayloadInvalidMessage("PRIVATE_PROVIDER_BODY_8K2R:PAYLOAD_INVALID")).toBeUndefined();
    expect(sanitizePayloadInvalidMessage("https://user:secret@example.test/private")).toBeUndefined();
    expect(looksLikeProviderDump("PRIVATE_PROVIDER_BODY_8K2R")).toBe(true);
    expect(looksLikeProviderDump("CLI/runtime mismatch detected.")).toBe(false);
  });

  it("builds a structured issue from the sanitized local message", () => {
    expect(payloadInvalidIssues("--html file was not found: ./index.html")).toEqual([
      { path: ["html"], code: "invalid", message: "--html file was not found: ./index.html" },
    ]);
    expect(inferPayloadIssuePath("Missing --project.")).toEqual(["project"]);
    expect(redactAbsolutePathsInText("Missing --html /home/user/page.html")).toBe("Missing --html [REDACTED:path]");
  });
});
