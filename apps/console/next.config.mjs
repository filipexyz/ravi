import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs";
import { withWorkflow } from "workflow/next";

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.RAVI_SELFHOST_BUILD === "1" ? "standalone" : undefined,
  experimental: process.env.RAVI_SELFHOST_BUILD === "1" ? { cpus: 1 } : undefined,
  reactStrictMode: true,
  // Authorization codes/setup tokens must not appear in dev access logs either.
  logging: { incomingRequests: { ignore: [/^\/callback(?:\/|\?|$)/, /^\/api\/setup\//, /^\/api\/console\/fleet(?:\/|\?|$)/] } },
  outputFileTracingRoot: resolve(root, "../.."),
  transpilePackages: ["@ravi/console-sdk", "@ravi/operation-contracts"],
  turbopack: { root: resolve(root, "../..") },
};

// Vercel Workflows (Page chat agent turns) compile `"use workflow"` / `"use step"` files.
export default withSentryConfig(withWorkflow(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
});
