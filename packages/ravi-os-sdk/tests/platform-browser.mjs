import {
  ChannelOutputSinkRegistry as RootRegistry,
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY as rootCapability,
} from "@ravi-os/sdk";
import {
  ChannelOutputSinkRegistry as DeepRegistry,
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY as deepCapability,
} from "@ravi-os/sdk/channel-backend";

// Both registries remain reachable: importing only RaviClient could tree-shake
// the digest branch and would not prove portability of channel handoff.
export const surfaces = [
  { name: "root", Registry: RootRegistry, capability: rootCapability },
  { name: "deep", Registry: DeepRegistry, capability: deepCapability },
];
