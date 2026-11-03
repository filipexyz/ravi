import * as Sentry from "@sentry/nextjs";
import { fleetPrivateUrl } from "./src/lib/fleet-privacy";

const dsn = process.env.SENTRY_DSN;
const tracesSampleRate = Number.parseFloat(
  process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
);

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate,
    enableLogs: true,
    beforeSend: event => fleetPrivateUrl(event.request?.url) ? null : event,
    beforeSendTransaction: event => fleetPrivateUrl(event.request?.url) ? null : event,
    beforeBreadcrumb: breadcrumb => fleetPrivateUrl(breadcrumb.data?.url) ? null : breadcrumb,
  });
}
