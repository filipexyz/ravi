import type { ChannelConfig } from "../../router/router-db.js";
import { readRemoteInstallationCredential } from "../../cloud-auth/installation-storage.js";
import {
  RemoteInstallationCredentialSchema,
  type RemoteInstallationCredential,
} from "../../cloud-auth/remote-login.js";
import {
  ChannelBackendOpaqueIdSchema,
  ChannelBackendWireKindSchema,
  ChannelIngressRequestSchema,
  acceptChannelIngress,
  channelOutputSinks,
} from "../backend.js";
import {
  ChannelInterruptRequestSchema,
  ChannelRuntimeReadbackRequestSchema,
  channelRuntimeEventSinks,
  readChannelRuntime,
  requestChannelRuntimeInterrupt,
} from "../runtime-events.js";
import type { NativeChannelDriverHost } from "./driver.js";

export interface NativeChannelDriverHostLease {
  readonly host: NativeChannelDriverHost;
  dispose(): void;
}

export type NativeChannelInstallationCredentialResolver = (input: {
  readonly provider: string;
  readonly connection?: string;
}) => RemoteInstallationCredential | null | Promise<RemoteInstallationCredential | null>;

export function createNativeChannelDriverHostLease(options: {
  channel: ChannelConfig;
  provider: string;
  resolveInstallationCredential?: NativeChannelInstallationCredentialResolver;
}): NativeChannelDriverHostLease {
  const channelInstanceId = ChannelBackendOpaqueIdSchema.parse(options.channel.name);
  const provider = ChannelBackendWireKindSchema.parse(options.provider);
  const unregister: Array<() => void> = [];
  let disposed = false;

  const ensureActive = () => {
    if (disposed) throw new Error("native_channel_driver_host_disposed");
  };
  const register = (dispose: () => void) => {
    let registered = true;
    unregister.push(() => {
      if (!registered) return;
      registered = false;
      dispose();
    });
    return () => {
      if (!registered) return;
      registered = false;
      dispose();
    };
  };

  const host: NativeChannelDriverHost = {
    async readInstallationCredential() {
      ensureActive();
      const resolve =
        options.resolveInstallationCredential ??
        ((input: { readonly provider: string; readonly connection?: string }) => {
          const stored = readRemoteInstallationCredential(input.connection);
          return stored?.credential ?? null;
        });
      const resolved = await resolve({
        provider,
        ...(options.channel.credentialConnection ? { connection: options.channel.credentialConnection } : {}),
      });
      if (resolved === null) return null;
      const credential = RemoteInstallationCredentialSchema.parse(resolved);
      if (credential.provider !== provider) {
        throw new Error("native_channel_driver_scope_mismatch");
      }
      return structuredClone(credential);
    },
    async ingress(input) {
      ensureActive();
      const request = ChannelIngressRequestSchema.parse(input);
      if (request.channelInstanceId !== channelInstanceId || request.external.channelKind !== provider) {
        throw new Error("native_channel_driver_scope_mismatch");
      }
      return acceptChannelIngress(request);
    },
    async interrupt(input) {
      ensureActive();
      const request = ChannelInterruptRequestSchema.parse(input);
      if (request.binding.channelInstanceId !== channelInstanceId) {
        throw new Error("native_channel_driver_scope_mismatch");
      }
      return requestChannelRuntimeInterrupt(request);
    },
    async readback(input) {
      ensureActive();
      const request = ChannelRuntimeReadbackRequestSchema.parse(input);
      if (request.binding.channelInstanceId !== channelInstanceId) {
        throw new Error("native_channel_driver_scope_mismatch");
      }
      return readChannelRuntime(request);
    },
    registerOutputSink(target, sink) {
      ensureActive();
      if (ChannelBackendWireKindSchema.parse(target.channelKind) !== provider) {
        throw new Error("native_channel_driver_scope_mismatch");
      }
      return register(channelOutputSinks.register(target, sink));
    },
    registerRuntimeEventSink(target, sink) {
      ensureActive();
      if (ChannelBackendWireKindSchema.parse(target.channelKind) !== provider) {
        throw new Error("native_channel_driver_scope_mismatch");
      }
      return register(channelRuntimeEventSinks.register(target, sink));
    },
  };

  return {
    host,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of unregister.reverse()) dispose();
      unregister.length = 0;
    },
  };
}
