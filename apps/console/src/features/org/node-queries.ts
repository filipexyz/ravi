"use client";
import { useCallback, useMemo } from "react";
import { ConsoleClient, ConsoleSessionTransport } from "@ravi/console-sdk";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/features/shell/workspace";
import { useOrganizationAccess } from "./access";

export function useNodeClient() {
  const { organization, viewer } = useWorkspace();
  const sdk = useMemo(() => new ConsoleClient(new ConsoleSessionTransport({
    headers: () => ({ "x-ravi-org": organization.id }),
  })), [organization.id]);
  const key = useCallback((...parts: unknown[]) => ["fleet-nodes", organization.id, viewer.email, ...parts], [organization.id, viewer.email]);
  return { sdk, key };
}
export function useManagedNodes() {
  const { sdk, key } = useNodeClient(), access = useOrganizationAccess();
  const query = useQuery({ queryKey: key("installations"), queryFn: () => sdk.installations.list({}),
    enabled: access.allows("organization.installations.read"), staleTime: 0, retry: false, refetchInterval: 10_000 });
  return { sdk, key, access, query };
}
