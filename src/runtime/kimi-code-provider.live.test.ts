import { createKimiCodeRuntimeProvider } from "./kimi-code-provider.js";
import { registerLiveProviderSuite } from "./live-test-helpers.js";

const liveEnabled = process.env.RAVI_LIVE_TESTS === "1";
const hasKimiMembershipKey = Boolean(process.env.KIMI_API_KEY);

registerLiveProviderSuite({
  providerId: "kimi-code",
  enabled: liveEnabled && hasKimiMembershipKey,
  model: process.env.RAVI_LIVE_KIMI_CODE_MODEL ?? "k3",
  createProvider: () => createKimiCodeRuntimeProvider(),
});
