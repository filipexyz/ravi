import { describe, expect, it } from "bun:test";
import { chooseSlackRunnerConnection, chooseSlackRunnerConnections } from "./channels.js";

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

  it("preserves multiple Slack runner connections from env", () => {
    expect(
      chooseSlackRunnerConnections({
        env: { RAVI_SLACK_CONNECTIONS: "ravi-rbbt-slack, hana-slack" },
      }),
    ).toEqual(["ravi-rbbt-slack", "hana-slack"]);
  });

  it("prefers explicit multiple Slack runner connections over single env fallback", () => {
    expect(
      chooseSlackRunnerConnections({
        explicit: "ravi-rbbt-slack,hana-slack",
        env: { RAVI_SLACK_CONNECTION: "other" },
      }),
    ).toEqual(["ravi-rbbt-slack", "hana-slack"]);
  });

  it("falls back to an existing PM2 Slack connection list", () => {
    expect(
      chooseSlackRunnerConnections({
        env: {},
        fallbackEnv: { RAVI_SLACK_CONNECTIONS: "ravi-rbbt-slack,hana-slack" },
      }),
    ).toEqual(["ravi-rbbt-slack", "hana-slack"]);
  });
});
