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
  /**
   * When true, the dispatcher returns a raw `Response` (e.g. binary blob).
   * Transports must skip JSON parsing for 2xx and yield the `Response` to the
   * caller; error responses (>= 400) still parse JSON to surface gateway error
   * bodies. Set by the generated client per `@Returns.binary()` command.
   */
  binary?: boolean;
}

export interface Transport {
  call<T = unknown>(input: TransportCallInput): Promise<T>;
}
