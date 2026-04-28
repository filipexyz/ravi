/**
 * Transport contract shared by the generated `RaviClient` and any
 * implementation (HTTP, in-process, mock).
 *
 * The generated client never touches HTTP details — it only calls
 * `transport.call({ groupSegments, command, body })` and `await`s the parsed
 * response. The transport layer is responsible for validation/scope/audit
 * (in-process) or the HTTP round-trip (http).
 */

export interface TransportCallInput {
  /** `cmd.groupSegments` from the registry; e.g. `["context", "credentials"]`. */
  groupSegments: readonly string[];
  /** `cmd.command`; e.g. `"list"`. */
  command: string;
  /**
   * Flat request body. Keys are arg names + option names merged at the top
   * level. The generated client always builds this shape; transports must
   * forward it without re-wrapping.
   */
  body: Record<string, unknown>;
}

export interface Transport {
  call<T = unknown>(input: TransportCallInput): Promise<T>;
}
