export const REDACTION_TEXT_CORPUS = [
  { input: 'authToken="synthetic auth token value"', secret: "synthetic auth token value" },
  { input: "credential=synthetic-credential-value", secret: "synthetic-credential-value" },
  { input: "Authorization: Basic dXNlcjpzeW50aGV0aWM=", secret: "dXNlcjpzeW50aGV0aWM=" },
  { input: "Cookie: session=synthetic-session; Path=/", secret: "synthetic-session" },
  {
    input: "provider returned eyJzeW50aGV0aWMx.eyJzeW50aGV0aWMy.c3ludGhldGljLXNpZ25hdHVyZQ",
    secret: "eyJzeW50aGV0aWMx.eyJzeW50aGV0aWMy.c3ludGhldGljLXNpZ25hdHVyZQ",
  },
  { input: "oauth=ya29.syntheticOAuthTokenValue123456", secret: "ya29.syntheticOAuthTokenValue123456" },
] as const;

export const REDACTION_STRUCTURED_KEY_CORPUS = [
  "authToken",
  "sessionToken",
  "idToken",
  "authorizationHeader",
  "setCookie",
  "credentialValue",
  "oauthToken",
] as const;
