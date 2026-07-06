import { describe, expect, it } from "bun:test";
import { chooseSlackRunnerConnection } from "./channels.js";

describe("channels command runner env", () => {
  it("uses an explicit Slack connection first", () => {
    expect(
      chooseSlackRunnerConnection({
        explicit: "  ravi-rbbt-slack  ",
        env: { RAVI_SLACK_CONNECTION: "other" },
        pm2Env: { RAVI_SLACK_CONNECTION: "pm2" },
        activeCredentialConnections: ["other", "pm2", "ravi-rbbt-slack"],
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("preserves a Slack connection already present in the current env", () => {
    expect(
      chooseSlackRunnerConnection({
        env: { RAVI_SLACK_CONNECTION: "ravi-rbbt-slack" },
        pm2Env: { RAVI_SLACK_CONNECTION: "pm2-slack" },
        activeCredentialConnections: ["ravi-rbbt-slack", "pm2-slack"],
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("preserves the previous PM2 Slack connection when the current env is empty", () => {
    expect(
      chooseSlackRunnerConnection({
        pm2Env: { RAVI_SLACK_CONNECTION: "ravi-rbbt-slack" },
        activeCredentialConnections: ["ravi-rbbt-slack", "ravi-slack-dev"],
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("selects the active Slack credential with configured Slack routes", () => {
    expect(
      chooseSlackRunnerConnection({
        activeCredentialConnections: ["ravi-rbbt-slack", "ravi-slack-dev"],
        enabledSlackInstanceNames: ["ravi-rbbt-slack", "ravi-slack-dev"],
        routedSlackAccountIds: ["ravi-rbbt-slack", "ravi-rbbt-slack"],
      }),
    ).toBe("ravi-rbbt-slack");
  });

  it("does not guess when multiple active Slack connections are equally plausible", () => {
    expect(
      chooseSlackRunnerConnection({
        activeCredentialConnections: ["ravi-rbbt-slack", "ravi-slack-dev"],
        enabledSlackInstanceNames: ["ravi-rbbt-slack", "ravi-slack-dev"],
      }),
    ).toBeUndefined();
  });
});
