import { describe, expect, it, mock } from "bun:test";
import { SlackGatewayModeService } from "./gateway-mode.js";

describe("Slack Hub gateway mode", () => {
  it("claims one event, processes it and confirms the exact lease", async () => {
    const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
    let delivered!: () => void;
    const completed = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url: String(url), body, headers });
      if (String(url).endsWith("/claim")) {
        if (requests.filter((item) => item.url.endsWith("/claim")).length > 1) {
          return Response.json({ event: null });
        }
        return Response.json({
          event: {
            id: "11111111-1111-4111-8111-111111111111",
            claimId: "22222222-2222-4222-8222-222222222222",
            envelope: { envelope_id: "Ev1", type: "events_api", payload: { type: "event_callback" } },
          },
        });
      }
      delivered();
      return Response.json({ accepted: true });
    }) as unknown as typeof fetch;
    const handleEnvelope = mock(async () => "processed" as const);
    const service = new SlackGatewayModeService({
      claimUrl: "https://hub.test/claim",
      completionBaseUrl: "https://hub.test/events",
      requestHeaders: { authorization: "Bearer runtime", "x-ravi-runtime-id": "runtime-1" },
      processor: {
        handleEnvelope,
        resumePendingInboundEnvelopes: async () => ({}),
      },
      fetchImpl,
    });

    service.start();
    await completed;
    await service.stop();

    expect(handleEnvelope).toHaveBeenCalledWith({
      envelope_id: "Ev1",
      type: "events_api",
      payload: { type: "event_callback" },
    });
    const completion = requests.find((request) => request.url.includes("/complete"));
    expect(completion?.url).toBe("https://hub.test/events/11111111-1111-4111-8111-111111111111/complete");
    expect(completion?.body).toEqual({
      claimId: "22222222-2222-4222-8222-222222222222",
      status: "delivered",
    });
    expect(completion?.headers.get("authorization")).toBe("Bearer runtime");
    expect(service.status().state).toBe("stopped");
  });

  it("does not misreport a processed event as failed when only its acknowledgement fails", async () => {
    const completions: unknown[] = [];
    let completionAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => {
      completionAttempted = resolve;
    });
    let claimed = false;
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/claim")) {
        if (claimed) return Response.json({ event: null });
        claimed = true;
        return Response.json({
          event: {
            id: "11111111-1111-4111-8111-111111111111",
            claimId: "22222222-2222-4222-8222-222222222222",
            envelope: { envelope_id: "Ev1", type: "events_api", payload: { type: "event_callback" } },
          },
        });
      }
      completions.push(JSON.parse(String(init?.body ?? "{}")));
      completionAttempted();
      return Response.json({ error: "unavailable" }, { status: 502 });
    }) as unknown as typeof fetch;
    const service = new SlackGatewayModeService({
      claimUrl: "https://hub.test/claim",
      completionBaseUrl: "https://hub.test/events",
      requestHeaders: { authorization: "Bearer runtime" },
      processor: {
        handleEnvelope: async () => "processed",
        resumePendingInboundEnvelopes: async () => ({}),
      },
      fetchImpl,
      retryDelayMs: 60_000,
    });

    service.start();
    await attempted;
    await service.stop();

    expect(completions).toEqual([{ claimId: "22222222-2222-4222-8222-222222222222", status: "delivered" }]);
  });
});
