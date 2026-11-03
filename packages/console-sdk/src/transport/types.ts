export interface TransportCallInput {
  groupSegments: readonly string[]; command: string; body: Record<string, unknown>; binary?: boolean;
}
export interface Transport { call<T = unknown>(input: TransportCallInput): Promise<T> }
