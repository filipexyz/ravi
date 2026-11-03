import { describe, expect, test } from "bun:test";

import {
  canonicalProviderEventType,
  getActionDefinition,
  getActionProviderDefinition,
  getProviderDefinition,
  getProviderEventTypes,
  normalizeProviderEventTypes,
  providerConnectorEventType,
  providerHasImplementedWatchEvents,
  providerRegistry,
  watchEventSubject,
} from "./provider-registry";

describe("provider registry", () => {
  test("keeps GitHub implemented watch events backward compatible", () => {
    const github = getProviderDefinition("github");
    expect(github).not.toBeNull();
    expect(providerHasImplementedWatchEvents(github!)).toBe(true);
    expect(getProviderEventTypes(github!, { implementedOnly: true })).toContain(
      "watch.github.pull_request.merged",
    );
    expect(normalizeProviderEventTypes(github!, ["pull_request.merged", "watch.github.push.branch"]))
      .toEqual(["watch.github.pull_request.merged", "watch.github.push.branch"]);
    expect(providerConnectorEventType(github!, "watch.github.push.default_branch"))
      .toBe("push.default_branch");
  });

  test("maps watch event types to local Ravi subjects", () => {
    expect(watchEventSubject("watch.github.push.branch"))
      .toBe("ravi.watch.github.push.branch");
    expect(watchEventSubject("tiny.order.status_changed"))
      .toBe("ravi.watch.tiny.order.status_changed");
  });

  test("uses separate Google product namespaces with a shared Google connection", () => {
    const merchant = getProviderDefinition("google-merchant");
    const ads = getProviderDefinition("google-ads");
    expect(merchant?.connectionProviderId).toBe("google");
    expect(ads?.connectionProviderId).toBe("google");
    expect(canonicalProviderEventType(merchant!, "product.status_changed"))
      .toBe("watch.google_merchant.product.status_changed");
  });

  test("registers implemented connector actions", () => {
    expect(getActionDefinition("gmail.message.send")).toMatchObject({
      class: "destructive",
      status: "implemented",
    });
    expect(getActionDefinition("gcal.event.list")).toMatchObject({
      class: "read",
      requiredProviderScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      status: "implemented",
    });
    expect(getActionDefinition("gcal.freebusy.query")).toMatchObject({
      class: "read",
      requiredCapabilities: ["calendar.freebusy.read"],
      requiredProviderScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      resourceTypes: ["google_account", "calendar"],
      status: "implemented",
    });
    expect(getActionProviderDefinition("gcal.freebusy.query")?.id).toBe("google");
    expect(getActionDefinition("gmail.message.read")?.requiredProviderScopes)
      .toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(getActionProviderDefinition("gmail.message.send")?.id).toBe("google");
  });

  test("keeps planned providers visible but not implemented", () => {
    expect(providerRegistry.tiny.status).toBe("planned");
    expect(providerHasImplementedWatchEvents(providerRegistry.tiny)).toBe(false);
    expect(getProviderEventTypes(providerRegistry.tiny)).toContain("watch.tiny.order.status_changed");
    expect(getProviderEventTypes(providerRegistry.tiny, { implementedOnly: true })).toEqual([]);
  });
});
