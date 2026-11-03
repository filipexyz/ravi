export async function checkRateLimit(input: {
  namespace: DurableObjectNamespace;
  key: string;
  limit: number;
  windowSeconds: number;
}) {
  const id = input.namespace.idFromName(input.key);
  const response = await input.namespace.get(id).fetch("https://rate-limit/check", {
    method: "POST",
    body: JSON.stringify({
      limit: input.limit,
      windowSeconds: input.windowSeconds,
    }),
  });
  return response.status !== 429;
}

export class SlidingWindowRateLimitDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      windowSeconds?: number;
    };
    const limit = body.limit ?? 60;
    const windowSeconds = body.windowSeconds ?? 60;
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const storage = this.state.storage;
    const hits = ((await storage.get<number[]>("hits")) ?? []).filter((hit) => hit >= windowStart);
    if (hits.length >= limit) {
      await storage.put("hits", hits);
      return new Response(JSON.stringify({ allowed: false }), { status: 429 });
    }
    hits.push(now);
    await storage.put("hits", hits);
    return new Response(JSON.stringify({ allowed: true }), { status: 200 });
  }
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}
