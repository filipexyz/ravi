import { describe, expect, it } from "bun:test";
import { chooseSlackRunnerConnection } from "./channels.js";

describe("channels command runner env", () => {
  it("uses an explicit Slack connection first", () => {
    expect(
      chooseSlackRunnerConnection({
        explicit: "  ravi-rbbt-slack  ",
        env: { RAVI_SLACK_CONNECTION: "other" },
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("preserves a Slack connection already present in the current env", () => {
    expect(
      chooseSlackRunnerConnection({
        env: { RAVI_SLACK_CONNECTION: "ravi-rbbt-slack" },
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("supports the legacy Slack credential connection env name", () => {
    expect(
      chooseSlackRunnerConnection({
        env: { RAVI_SLACK_CREDENTIAL_CONNECTION: "ravi-rbbt-slack" },
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("does not synthesize a Slack connection from credentials or routes", () => {
    expect(
      chooseSlackRunnerConnection({
        env: {},
      }),
    ).toBeUndefined();
  });
});
