"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { useOrgKey } from "@/features/shell/workspace";
import type { OrganizationAccess, OrganizationAction } from "@/shared/organization-access";

export function useOrganizationAccess() {
  const key = useOrgKey();
  const query = useQuery({ queryKey: key("organization-access"),
    queryFn: () => api.get<OrganizationAccess>("/api/console/fleet/access"),
    staleTime: 0, retry: false, refetchOnWindowFocus: "always" });
  return { ...query, allows: (action: OrganizationAction) => !query.isError && query.data?.actions[action] === true };
}
