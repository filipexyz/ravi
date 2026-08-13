import { describe, expect, it } from "bun:test";
import { isAllowedSlackInteractionResponseUrl } from "./interactions.js";

describe("Slack interaction response boundary", () => {
  it("allows only action response handles hosted by Slack", () => {
    expect(isAllowedSlackInteractionResponseUrl("https://hooks.slack.com/actions/T1/B1/secret")).toBe(true);
    expect(isAllowedSlackInteractionResponseUrl("http://hooks.slack.com/actions/T1/B1/secret")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("https://hooks.slack.com.attacker.test/actions/T1/B1/secret")).toBe(
      false,
    );
    expect(isAllowedSlackInteractionResponseUrl("https://hooks.slack.com/services/T1/B1/secret")).toBe(false);
  });
});
