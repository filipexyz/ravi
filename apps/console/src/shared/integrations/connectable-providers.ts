import { listProviderDefinitions } from "./provider-registry";

/** Keep discovery tied to both implemented provider contracts and Worker OAuth adapters. */
const WORKER_OAUTH_ADAPTERS = new Set(["google"]);
export function connectableProviders() {
  return listProviderDefinitions().filter((provider) =>
    provider.status === "implemented" && provider.authModes.includes("oauth2") &&
    WORKER_OAUTH_ADAPTERS.has(provider.connectionProviderId));
}
