"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "@/lib/api/client";
import { CONNECT_START_ENDPOINT, connectStartBody, type ConnectStartResponse } from "./model";

export type StartConnectInput = { key: string; body: ReturnType<typeof connectStartBody> };

/**
 * Connect, Reconnect and Allow writing all start the same way: the worker
 * starts and continues at once for the signed-in person, and the browser goes
 * straight to the provider. `key` tells which button is busy.
 */
export function useStartConnect(options: { onError?: (error: unknown) => void } = {}) {
  const [leaving, setLeaving] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (input: StartConnectInput) => api.post<ConnectStartResponse>(CONNECT_START_ENDPOINT, input.body),
    onError: (error) => options.onError?.(error),
    onSuccess: (result, input) => {
      setLeaving(input.key);
      window.location.assign(result.authorizationUrl);
    },
  });
  const busyKey = leaving ?? (mutation.isPending ? (mutation.variables?.key ?? null) : null);
  return {
    busyKey,
    error: mutation.error,
    errorKey: mutation.isError ? (mutation.variables?.key ?? null) : null,
    reset: mutation.reset,
    start: (input: StartConnectInput) => {
      if (busyKey) return;
      mutation.mutate(input);
    },
  };
}
