import * as Sentry from "@sentry/nextjs";
import { fleetPrivateUrl } from "./src/lib/fleet-privacy";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const tracesSampleRate = Number.parseFloat(
  process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
);
const replaysSessionSampleRate = Number.parseFloat(
  process.env.NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE ?? "0",
);
const replaysOnErrorSampleRate = Number.parseFloat(
  process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE ?? "1",
);

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate,
    replaysSessionSampleRate,
    replaysOnErrorSampleRate,
    enableLogs: true,
    beforeSend: event => fleetPrivateUrl(location.href) || fleetPrivateUrl(event.request?.url) ? null : event,
    beforeSendTransaction: event => fleetPrivateUrl(location.href) || fleetPrivateUrl(event.request?.url) ? null : event,
    beforeBreadcrumb: breadcrumb => fleetPrivateUrl(location.href) || fleetPrivateUrl(breadcrumb.data?.url) ? null : breadcrumb,
    integrations: [Sentry.replayIntegration({ block: ["[data-fleet-private]"], maskAllInputs: true, maskAllText: true,
      networkDetailDenyUrls: [/\/api\/console\/fleet(?:\/|$)/, /\/api\/setup\//, /\/callback(?:\/|\?|$)/],
      beforeAddRecordingEvent: event => fleetPrivateUrl(location.href) ? null : event })],
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
