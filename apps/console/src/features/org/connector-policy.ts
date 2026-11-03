"use client";

import { useQuery } from "@tanstack/react-query";

import { ADMIN_POLICY_ENDPOINT, retryConnectorQuery, type OrgPolicyResponse } from "@/features/connectors/model";
import { useOrgKey } from "@/features/shell/workspace";
import { api } from "@/lib/api/client";

/** Cache key of one connector's organization rules. */
export function useOrgPolicyKey(providerId: string) {
  const orgKey = useOrgKey();
  return orgKey("connectors", "admin", "policy", providerId);
}

/** One connector's organization rules; the rules panel and the organization accounts section share the cache. */
export function useOrgPolicy(providerId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () => api.post<OrgPolicyResponse>(ADMIN_POLICY_ENDPOINT, { provider: providerId }),
    queryKey: useOrgPolicyKey(providerId),
    retry: retryConnectorQuery,
    select: (response) => response.policy,
  });
}
