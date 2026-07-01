export interface SlackWebApiClientOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface SlackPostMessageInput {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
}

export interface SlackPostMessageResult {
  readonly channel: string;
  readonly ts: string;
  readonly messageId: string;
  readonly raw: Record<string, unknown>;
}

interface SlackApiResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

interface SlackConnectionsOpenResponse extends SlackApiResponse {
  readonly url?: string;
}

interface SlackPostMessageResponse extends SlackApiResponse {
  readonly channel?: string;
  readonly ts?: string;
}

export class SlackWebApiClient {
  private readonly appToken: string;
  private readonly botToken: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackWebApiClientOptions) {
    this.appToken = options.appToken;
    this.botToken = options.botToken;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://slack.com/api";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async openSocketConnection(): Promise<string> {
    const response = await this.apiRequest<SlackConnectionsOpenResponse>("apps.connections.open", this.appToken, {});
    if (!response.url) {
      throw new Error("Slack apps.connections.open did not return a WebSocket URL");
    }
    return response.url;
  }

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult> {
    const body: Record<string, unknown> = {
      channel: input.channel,
      text: input.text,
    };
    if (input.threadTs) {
      body.thread_ts = input.threadTs;
    }

    const response = await this.apiRequest<SlackPostMessageResponse>("chat.postMessage", this.botToken, body);
    if (!response.channel || !response.ts) {
      throw new Error("Slack chat.postMessage did not return channel and ts");
    }

    return {
      channel: response.channel,
      ts: response.ts,
      messageId: response.ts,
      raw: response,
    };
  }

  private async apiRequest<T extends SlackApiResponse>(
    method: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    const payload = (await res.json()) as T;
    if (!res.ok || payload.ok !== true) {
      const error = payload.error ?? `${res.status} ${res.statusText}`;
      throw new Error(`Slack ${method} failed: ${error}`);
    }
    return payload;
  }
}
