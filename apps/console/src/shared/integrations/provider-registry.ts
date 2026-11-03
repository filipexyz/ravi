export type ProviderImplementationStatus = "implemented" | "planned";

export type ProviderCategory =
  | "commerce"
  | "communication"
  | "content"
  | "developer"
  | "marketing"
  | "operations"
  | "productivity"
  | "search";

export type ProviderAuthMode =
  | "api_token"
  | "bot_token"
  | "github_app"
  | "oauth2"
  | "provider_push"
  | "ravi_channel"
  | "webhook_secret";

export type ProviderWatchDeliveryMode =
  | "manual_sync"
  | "poll"
  | "provider_push"
  | "scheduled_report"
  | "webhook";

export type ProviderEventFidelity =
  | "best_effort"
  | "derived"
  | "full"
  | "report"
  | "webhook_only";

export type ProviderActionClass = "read" | "write" | "destructive";

export interface ProviderResourceTypeDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly selectable: boolean;
}

export interface ProviderEventDefinition {
  readonly eventType: `watch.${string}`;
  readonly title: string;
  readonly category: string;
  readonly deliveryModes: readonly ProviderWatchDeliveryMode[];
  readonly fidelity: ProviderEventFidelity;
  readonly requiredCapabilities: readonly string[];
  readonly requiredProviderPermissions: readonly string[];
  readonly resourceTypes: readonly string[];
  readonly status: ProviderImplementationStatus;
}

export interface ProviderActionDefinition {
  readonly capability: string;
  readonly title: string;
  readonly class: ProviderActionClass;
  readonly requiredCapabilities: readonly string[];
  readonly requiredProviderScopes: readonly string[];
  readonly resourceTypes: readonly string[];
  readonly status: ProviderImplementationStatus;
}

export interface ProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly category: ProviderCategory;
  readonly eventNamespace: string;
  readonly connectionProviderId: string;
  readonly authModes: readonly ProviderAuthMode[];
  readonly status: ProviderImplementationStatus;
  readonly resourceTypes: readonly ProviderResourceTypeDefinition[];
  readonly events: readonly ProviderEventDefinition[];
  readonly actions: readonly ProviderActionDefinition[];
}

const githubEvents = [
  {
    eventType: "watch.github.push.branch",
    title: "Branch push",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "full",
    requiredCapabilities: ["source.repo.metadata.read"],
    requiredProviderPermissions: ["metadata:read", "contents:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
  {
    eventType: "watch.github.push.default_branch",
    title: "Default branch push",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "derived",
    requiredCapabilities: ["source.repo.metadata.read"],
    requiredProviderPermissions: ["metadata:read", "contents:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
  {
    eventType: "watch.github.push.tag",
    title: "Tag push",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "full",
    requiredCapabilities: ["source.repo.metadata.read"],
    requiredProviderPermissions: ["metadata:read", "contents:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
  {
    eventType: "watch.github.pull_request.opened",
    title: "Pull request opened",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "full",
    requiredCapabilities: ["source.pull_request.read"],
    requiredProviderPermissions: ["metadata:read", "pull_requests:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
  {
    eventType: "watch.github.pull_request.closed",
    title: "Pull request closed",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "full",
    requiredCapabilities: ["source.pull_request.read"],
    requiredProviderPermissions: ["metadata:read", "pull_requests:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
  {
    eventType: "watch.github.pull_request.merged",
    title: "Pull request merged",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "derived",
    requiredCapabilities: ["source.pull_request.read"],
    requiredProviderPermissions: ["metadata:read", "pull_requests:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
  {
    eventType: "watch.github.pull_request.reopened",
    title: "Pull request reopened",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "full",
    requiredCapabilities: ["source.pull_request.read"],
    requiredProviderPermissions: ["metadata:read", "pull_requests:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
  {
    eventType: "watch.github.issue.opened",
    title: "Issue opened",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "full",
    requiredCapabilities: ["source.issue.read"],
    requiredProviderPermissions: ["metadata:read", "issues:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
  {
    eventType: "watch.github.issue.closed",
    title: "Issue closed",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "full",
    requiredCapabilities: ["source.issue.read"],
    requiredProviderPermissions: ["metadata:read", "issues:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
  {
    eventType: "watch.github.workflow_run.completed",
    title: "Workflow run completed",
    category: "source_control",
    deliveryModes: ["webhook"],
    fidelity: "full",
    requiredCapabilities: ["source.workflow_run.read"],
    requiredProviderPermissions: ["metadata:read", "actions:read"],
    resourceTypes: ["repository"],
    status: "implemented",
  },
] as const satisfies readonly ProviderEventDefinition[];

const googleActions = [
  {
    capability: "gmail.message.send",
    title: "Send Gmail message",
    class: "destructive",
    requiredCapabilities: ["mail.message.send"],
    requiredProviderScopes: ["https://www.googleapis.com/auth/gmail.send"],
    resourceTypes: ["google_account"],
    status: "implemented",
  },
  {
    capability: "gmail.message.list",
    title: "List Gmail messages",
    class: "read",
    requiredCapabilities: ["mail.message.read"],
    requiredProviderScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    resourceTypes: ["google_account"],
    status: "implemented",
  },
  {
    capability: "gmail.message.read",
    title: "Read Gmail message",
    class: "read",
    requiredCapabilities: ["mail.message.read"],
    requiredProviderScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    resourceTypes: ["google_account"],
    status: "implemented",
  },
  {
    capability: "gcal.event.list",
    title: "List Google Calendar events",
    class: "read",
    requiredCapabilities: ["calendar.event.read"],
    requiredProviderScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    resourceTypes: ["google_account", "calendar"],
    status: "implemented",
  },
  {
    capability: "gcal.freebusy.query",
    title: "Query Google Calendar free/busy",
    class: "read",
    requiredCapabilities: ["calendar.freebusy.read"],
    requiredProviderScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    resourceTypes: ["google_account", "calendar"],
    status: "implemented",
  },
] as const satisfies readonly ProviderActionDefinition[];

export const providerRegistry = {
  github: {
    id: "github",
    displayName: "GitHub",
    category: "developer",
    eventNamespace: "github",
    connectionProviderId: "github",
    authModes: ["github_app", "webhook_secret"],
    status: "implemented",
    resourceTypes: [
      { id: "repository", displayName: "Repository", selectable: true },
    ],
    events: githubEvents,
    actions: [],
  },
  google: {
    id: "google",
    displayName: "Google",
    category: "productivity",
    eventNamespace: "google",
    connectionProviderId: "google",
    authModes: ["oauth2"],
    status: "implemented",
    resourceTypes: [
      { id: "google_account", displayName: "Google account", selectable: false },
      { id: "calendar", displayName: "Calendar", selectable: true },
    ],
    events: [],
    actions: googleActions,
  },
  "google-merchant": {
    id: "google-merchant",
    displayName: "Google Merchant Center",
    category: "commerce",
    eventNamespace: "google_merchant",
    connectionProviderId: "google",
    authModes: ["oauth2", "provider_push"],
    status: "planned",
    resourceTypes: [
      { id: "merchant_account", displayName: "Merchant account", selectable: true },
      { id: "product", displayName: "Product", selectable: false },
    ],
    events: [
      {
        eventType: "watch.google_merchant.product.status_changed",
        title: "Product status changed",
        category: "commerce",
        deliveryModes: ["provider_push"],
        fidelity: "full",
        requiredCapabilities: ["merchant.product.read"],
        requiredProviderPermissions: ["https://www.googleapis.com/auth/content"],
        resourceTypes: ["merchant_account", "product"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "google_merchant.product.list",
        title: "List Merchant Center products",
        class: "read",
        requiredCapabilities: ["merchant.product.read"],
        requiredProviderScopes: ["https://www.googleapis.com/auth/content"],
        resourceTypes: ["merchant_account"],
        status: "planned",
      },
    ],
  },
  ga4: {
    id: "ga4",
    displayName: "Google Analytics 4",
    category: "marketing",
    eventNamespace: "ga4",
    connectionProviderId: "google",
    authModes: ["oauth2"],
    status: "planned",
    resourceTypes: [
      { id: "property", displayName: "GA4 property", selectable: true },
    ],
    events: [
      {
        eventType: "watch.ga4.report.anomaly_detected",
        title: "GA4 report anomaly detected",
        category: "analytics",
        deliveryModes: ["scheduled_report"],
        fidelity: "report",
        requiredCapabilities: ["analytics.report.read"],
        requiredProviderPermissions: ["https://www.googleapis.com/auth/analytics.readonly"],
        resourceTypes: ["property"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "ga4.report.run",
        title: "Run GA4 report",
        class: "read",
        requiredCapabilities: ["analytics.report.read"],
        requiredProviderScopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        resourceTypes: ["property"],
        status: "planned",
      },
    ],
  },
  "google-ads": {
    id: "google-ads",
    displayName: "Google Ads",
    category: "marketing",
    eventNamespace: "google_ads",
    connectionProviderId: "google",
    authModes: ["oauth2"],
    status: "planned",
    resourceTypes: [
      { id: "customer", displayName: "Ads customer", selectable: true },
      { id: "campaign", displayName: "Campaign", selectable: false },
    ],
    events: [
      {
        eventType: "watch.google_ads.change_status.changed",
        title: "Google Ads resource changed",
        category: "marketing",
        deliveryModes: ["poll"],
        fidelity: "best_effort",
        requiredCapabilities: ["ads.change_status.read"],
        requiredProviderPermissions: ["https://www.googleapis.com/auth/adwords"],
        resourceTypes: ["customer"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "google_ads.change_status.list",
        title: "List Google Ads change status",
        class: "read",
        requiredCapabilities: ["ads.change_status.read"],
        requiredProviderScopes: ["https://www.googleapis.com/auth/adwords"],
        resourceTypes: ["customer"],
        status: "planned",
      },
    ],
  },
  "google-search-console": {
    id: "google-search-console",
    displayName: "Google Search Console",
    category: "search",
    eventNamespace: "google_search_console",
    connectionProviderId: "google",
    authModes: ["oauth2"],
    status: "planned",
    resourceTypes: [
      { id: "site", displayName: "Search Console site", selectable: true },
    ],
    events: [
      {
        eventType: "watch.google_search_console.search_analytics.changed",
        title: "Search performance changed",
        category: "search",
        deliveryModes: ["scheduled_report"],
        fidelity: "report",
        requiredCapabilities: ["search.analytics.read"],
        requiredProviderPermissions: ["https://www.googleapis.com/auth/webmasters.readonly"],
        resourceTypes: ["site"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "google_search_console.search_analytics.query",
        title: "Query Search Console analytics",
        class: "read",
        requiredCapabilities: ["search.analytics.read"],
        requiredProviderScopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
        resourceTypes: ["site"],
        status: "planned",
      },
    ],
  },
  "google-business-profile": {
    id: "google-business-profile",
    displayName: "Google Business Profile",
    category: "commerce",
    eventNamespace: "google_business_profile",
    connectionProviderId: "google",
    authModes: ["oauth2", "provider_push"],
    status: "planned",
    resourceTypes: [
      { id: "location", displayName: "Business location", selectable: true },
    ],
    events: [
      {
        eventType: "watch.google_business_profile.review.created",
        title: "New business review",
        category: "reputation",
        deliveryModes: ["provider_push"],
        fidelity: "full",
        requiredCapabilities: ["business_profile.review.read"],
        requiredProviderPermissions: ["https://www.googleapis.com/auth/business.manage"],
        resourceTypes: ["location"],
        status: "planned",
      },
      {
        eventType: "watch.google_business_profile.question.created",
        title: "New business question",
        category: "reputation",
        deliveryModes: ["provider_push"],
        fidelity: "full",
        requiredCapabilities: ["business_profile.question.read"],
        requiredProviderPermissions: ["https://www.googleapis.com/auth/business.manage"],
        resourceTypes: ["location"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "google_business_profile.review.reply",
        title: "Reply to a Business Profile review",
        class: "destructive",
        requiredCapabilities: ["business_profile.review.write"],
        requiredProviderScopes: ["https://www.googleapis.com/auth/business.manage"],
        resourceTypes: ["location"],
        status: "planned",
      },
    ],
  },
  youtube: {
    id: "youtube",
    displayName: "YouTube",
    category: "content",
    eventNamespace: "youtube",
    connectionProviderId: "google",
    authModes: ["oauth2", "provider_push"],
    status: "planned",
    resourceTypes: [
      { id: "channel", displayName: "Channel", selectable: true },
      { id: "video", displayName: "Video", selectable: false },
    ],
    events: [
      {
        eventType: "watch.youtube.video.published",
        title: "YouTube video published",
        category: "content",
        deliveryModes: ["provider_push"],
        fidelity: "full",
        requiredCapabilities: ["youtube.video.read"],
        requiredProviderPermissions: ["https://www.googleapis.com/auth/youtube.readonly"],
        resourceTypes: ["channel", "video"],
        status: "planned",
      },
      {
        eventType: "watch.youtube.comment.created",
        title: "YouTube comment created",
        category: "content",
        deliveryModes: ["poll"],
        fidelity: "best_effort",
        requiredCapabilities: ["youtube.comment.read"],
        requiredProviderPermissions: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        resourceTypes: ["channel", "video"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "youtube.comment.reply",
        title: "Reply to a YouTube comment",
        class: "destructive",
        requiredCapabilities: ["youtube.comment.write"],
        requiredProviderScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        resourceTypes: ["video"],
        status: "planned",
      },
    ],
  },
  tiny: {
    id: "tiny",
    displayName: "Tiny",
    category: "operations",
    eventNamespace: "tiny",
    connectionProviderId: "tiny",
    authModes: ["api_token", "webhook_secret"],
    status: "planned",
    resourceTypes: [
      { id: "company", displayName: "Tiny company", selectable: true },
      { id: "order", displayName: "Order", selectable: false },
      { id: "product", displayName: "Product", selectable: false },
    ],
    events: [
      {
        eventType: "watch.tiny.order.status_changed",
        title: "Tiny order status changed",
        category: "operations",
        deliveryModes: ["webhook", "poll"],
        fidelity: "full",
        requiredCapabilities: ["erp.order.read"],
        requiredProviderPermissions: ["orders:read"],
        resourceTypes: ["company", "order"],
        status: "planned",
      },
      {
        eventType: "watch.tiny.stock.updated",
        title: "Tiny stock updated",
        category: "operations",
        deliveryModes: ["webhook", "poll"],
        fidelity: "full",
        requiredCapabilities: ["erp.stock.read"],
        requiredProviderPermissions: ["products:read"],
        resourceTypes: ["company", "product"],
        status: "planned",
      },
      {
        eventType: "watch.tiny.invoice.sent",
        title: "Tiny invoice sent",
        category: "operations",
        deliveryModes: ["webhook"],
        fidelity: "full",
        requiredCapabilities: ["erp.invoice.read"],
        requiredProviderPermissions: ["invoices:read"],
        resourceTypes: ["company", "order"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "tiny.order.get",
        title: "Get Tiny order",
        class: "read",
        requiredCapabilities: ["erp.order.read"],
        requiredProviderScopes: ["orders:read"],
        resourceTypes: ["company", "order"],
        status: "planned",
      },
      {
        capability: "tiny.order.update_status",
        title: "Update Tiny order status",
        class: "write",
        requiredCapabilities: ["erp.order.write"],
        requiredProviderScopes: ["orders:write"],
        resourceTypes: ["company", "order"],
        status: "planned",
      },
      {
        capability: "tiny.product.update_stock",
        title: "Update Tiny product stock",
        class: "write",
        requiredCapabilities: ["erp.stock.write"],
        requiredProviderScopes: ["products:write"],
        resourceTypes: ["company", "product"],
        status: "planned",
      },
    ],
  },
  whatsapp: {
    id: "whatsapp",
    displayName: "WhatsApp",
    category: "communication",
    eventNamespace: "whatsapp",
    connectionProviderId: "whatsapp",
    authModes: ["ravi_channel"],
    status: "planned",
    resourceTypes: [
      { id: "instance", displayName: "WhatsApp instance", selectable: true },
      { id: "chat", displayName: "Chat", selectable: false },
    ],
    events: [
      {
        eventType: "watch.whatsapp.message.received",
        title: "WhatsApp message received",
        category: "communication",
        deliveryModes: ["webhook"],
        fidelity: "full",
        requiredCapabilities: ["chat.message.read"],
        requiredProviderPermissions: ["ravi.channel.whatsapp.read"],
        resourceTypes: ["instance", "chat"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "whatsapp.message.send",
        title: "Send WhatsApp message",
        class: "destructive",
        requiredCapabilities: ["chat.message.send"],
        requiredProviderScopes: ["ravi.channel.whatsapp.send"],
        resourceTypes: ["instance", "chat"],
        status: "planned",
      },
    ],
  },
  telegram: {
    id: "telegram",
    displayName: "Telegram",
    category: "communication",
    eventNamespace: "telegram",
    connectionProviderId: "telegram",
    authModes: ["bot_token", "webhook_secret"],
    status: "planned",
    resourceTypes: [
      { id: "bot", displayName: "Telegram bot", selectable: true },
      { id: "chat", displayName: "Chat", selectable: false },
    ],
    events: [
      {
        eventType: "watch.telegram.message.received",
        title: "Telegram message received",
        category: "communication",
        deliveryModes: ["webhook"],
        fidelity: "full",
        requiredCapabilities: ["chat.message.read"],
        requiredProviderPermissions: ["bot:read"],
        resourceTypes: ["bot", "chat"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "telegram.message.send",
        title: "Send Telegram message",
        class: "destructive",
        requiredCapabilities: ["chat.message.send"],
        requiredProviderScopes: ["bot:send"],
        resourceTypes: ["bot", "chat"],
        status: "planned",
      },
    ],
  },
  "mercado-livre": {
    id: "mercado-livre",
    displayName: "Mercado Livre",
    category: "commerce",
    eventNamespace: "mercado_livre",
    connectionProviderId: "mercado-livre",
    authModes: ["oauth2", "webhook_secret"],
    status: "planned",
    resourceTypes: [
      { id: "seller", displayName: "Seller", selectable: true },
      { id: "order", displayName: "Order", selectable: false },
      { id: "question", displayName: "Question", selectable: false },
    ],
    events: [
      {
        eventType: "watch.mercado_livre.question.created",
        title: "Mercado Livre question created",
        category: "commerce",
        deliveryModes: ["webhook"],
        fidelity: "full",
        requiredCapabilities: ["marketplace.question.read"],
        requiredProviderPermissions: ["questions:read"],
        resourceTypes: ["seller", "question"],
        status: "planned",
      },
      {
        eventType: "watch.mercado_livre.order.created",
        title: "Mercado Livre order created",
        category: "commerce",
        deliveryModes: ["webhook"],
        fidelity: "full",
        requiredCapabilities: ["marketplace.order.read"],
        requiredProviderPermissions: ["orders:read"],
        resourceTypes: ["seller", "order"],
        status: "planned",
      },
    ],
    actions: [
      {
        capability: "mercado_livre.question.answer",
        title: "Answer Mercado Livre question",
        class: "destructive",
        requiredCapabilities: ["marketplace.question.write"],
        requiredProviderScopes: ["questions:write"],
        resourceTypes: ["seller", "question"],
        status: "planned",
      },
    ],
  },
} as const satisfies Record<string, ProviderDefinition>;

export type RegisteredProviderId = keyof typeof providerRegistry;

const actionRegistry = new Map<string, { action: ProviderActionDefinition; provider: ProviderDefinition }>(
  Object.values(providerRegistry).flatMap((provider) =>
    provider.actions.map((action) => [action.capability, { action, provider }] as const),
  ),
);

export function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

export function listProviderDefinitions(): ProviderDefinition[] {
  return Object.values(providerRegistry);
}

export function getProviderDefinition(provider: string): ProviderDefinition | null {
  return providerRegistry[normalizeProviderId(provider) as RegisteredProviderId] ?? null;
}

export function providerHasImplementedWatchEvents(provider: ProviderDefinition): boolean {
  return provider.events.some((event) => event.status === "implemented");
}

export function getProviderEventTypes(
  provider: ProviderDefinition,
  input: { implementedOnly?: boolean } = {},
): string[] {
  const implementedOnly = input.implementedOnly ?? false;
  return provider.events
    .filter((event) => !implementedOnly || event.status === "implemented")
    .map((event) => event.eventType);
}

export function getProviderEventDefinition(
  provider: ProviderDefinition,
  eventType: string,
): ProviderEventDefinition | null {
  const canonical = canonicalProviderEventType(provider, eventType);
  return provider.events.find((event) => event.eventType === canonical) ?? null;
}

export function normalizeProviderEventTypes(
  provider: ProviderDefinition,
  eventTypes: readonly string[],
): string[] {
  return [...new Set(
    eventTypes
      .map((eventType) => eventType.trim())
      .filter(Boolean)
      .map((eventType) => canonicalProviderEventType(provider, eventType)),
  )]
    .sort();
}

export function canonicalProviderEventType(provider: ProviderDefinition, eventType: string): `watch.${string}` {
  const trimmed = eventType.trim();
  if (trimmed.startsWith(`watch.${provider.eventNamespace}.`)) return trimmed as `watch.${string}`;
  if (trimmed.startsWith("watch.")) return trimmed as `watch.${string}`;
  if (trimmed.startsWith(`${provider.eventNamespace}.`)) return `watch.${trimmed}`;
  return `watch.${provider.eventNamespace}.${trimmed}`;
}

export function providerConnectorEventType(
  provider: ProviderDefinition,
  eventType: string,
): string {
  const canonical = canonicalProviderEventType(provider, eventType);
  const prefix = `watch.${provider.eventNamespace}.`;
  return canonical.startsWith(prefix) ? canonical.slice(prefix.length) : canonical;
}

export function watchEventSubject(eventType: string): string {
  return eventType.startsWith("watch.") ? `ravi.${eventType}` : `ravi.watch.${eventType}`;
}

export function getActionDefinition(capability: string): ProviderActionDefinition | null {
  return actionRegistry.get(capability)?.action ?? null;
}

export function requireActionDefinition(capability: string): ProviderActionDefinition {
  const action = getActionDefinition(capability);
  if (!action) throw new Error(`Unknown provider action: ${capability}`);
  return action;
}

export function getActionProviderDefinition(capability: string): ProviderDefinition | null {
  return actionRegistry.get(capability)?.provider ?? null;
}

export function requireActionProviderDefinition(capability: string): ProviderDefinition {
  const provider = getActionProviderDefinition(capability);
  if (!provider) throw new Error(`Unknown provider action: ${capability}`);
  return provider;
}
