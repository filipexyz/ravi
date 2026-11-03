/**
 * Runtime environment for the `ravi-channel-control` Worker.
 *
 * Vercel can authenticate to this Worker with HMAC, but only this Worker
 * receives the Omni service key and channel root wrap key.
 */
export interface ChannelsWorkerEnv {
  RAVI_CONSOLE_DB: HyperdriveBinding;

  RAVI_CHANNELS_ROOT_WRAP_KEY_BASE64: string;
  RAVI_CHANNELS_VERCEL_HMAC_KEY_CURRENT: string;
  RAVI_CHANNELS_VERCEL_HMAC_KEY_CURRENT_ID: string;
  RAVI_CHANNELS_VERCEL_HMAC_KEY_PREVIOUS?: string;
  RAVI_CHANNELS_VERCEL_HMAC_KEY_PREVIOUS_ID?: string;
  RAVI_CHANNELS_OMNI_BASE_URL: string;
  RAVI_CHANNELS_OMNI_SERVICE_API_KEY: string;
  RAVI_CHANNELS_OMNI_ACCESS_CLIENT_ID?: string;
  RAVI_CHANNELS_OMNI_ACCESS_CLIENT_SECRET?: string;

  RAVI_CHANNELS_KEY_VERSION: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
}

export interface HyperdriveBinding {
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}
