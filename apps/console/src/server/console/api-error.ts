export type ConsoleApiErrorPayload = {
  error: string;
  fieldErrors?: Record<string, string>;
  reason?: string;
};

export class ConsoleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: ConsoleApiErrorPayload,
  ) {
    super(payload.error);
  }
}
