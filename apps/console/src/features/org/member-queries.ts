"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api/client";
import { useOrgKey } from "@/features/shell/workspace";
import type { MembershipChange, MembershipReceipt, OrganizationMembers } from "@/shared/organization-members";
import { useOrganizationAccess } from "./access";

export function useOrganizationMembers(options: { enabled?: boolean } = {}) {
  const key = useOrgKey(), access = useOrganizationAccess();
  return useQuery({ queryKey: key("members"), enabled: access.allows("organization.members.read") && options.enabled !== false,
    queryFn: () => api.get<OrganizationMembers>("/api/console/fleet/members"), retry: false });
}

/** Existing name-only consumers get no legacy roles, memberships or token data. */
export function useOrganizationMemberNames(options: { enabled?: boolean } = {}) {
  const query = useOrganizationMembers(options), access = useOrganizationAccess();
  const allowed = access.allows("organization.members.read");
  return { ...query, isPending: access.isPending || (allowed && query.isPending),
    isError: access.isError || (!access.isPending && !allowed) || query.isError,
    error: !access.isPending && !allowed ? new ApiError(403,"forbidden","Directory access was not granted") : query.error,
    data: allowed && query.data ? { currentUserId: query.data.currentUserId,
    members: query.data.members.map(m => ({ id: m.userId, name: m.name, email: m.email ?? "", status: m.status })) } : undefined };
}
export function useChangeMembership() {
  const key = useOrgKey(), client = useQueryClient();
  return useMutation({ mutationFn: (input: MembershipChange) => api.post<MembershipReceipt>("/api/console/fleet/members/status", input),
    onSuccess: async () => {
      await Promise.all([client.invalidateQueries({ queryKey: key("members") }),
        client.invalidateQueries({ queryKey: key("organization-access") }), client.invalidateQueries({ queryKey: key("events") })]);
    },
  });
}
