import { describe, expect, it } from "bun:test";
import { ContractError, publicContractPath } from "./agent-contract.js";
import { sanitizePublicValue } from "./redaction.js";

describe("public contract redaction", () => {
  it("sanitizes content, contextual secrets and paths without mutating safe metadata", () => {
    const input = {
      caption: "PRIVATE_MESSAGE_8K2R",
      filePath: "C:/sentinel/private/file-9P3X.txt",
      key: "custom.password",
      value: "SENTINEL_SECRET_7M4Q",
      count: 2,
      captionPresent: true,
    };

    expect(sanitizePublicValue(input)).toEqual({
      caption: "[REDACTED:content length=20]",
      filePath: "[REDACTED:path]",
      key: "custom.password",
      value: "[REDACTED]",
      count: 2,
      captionPresent: true,
    });
    expect(input).toEqual({
      caption: "PRIVATE_MESSAGE_8K2R",
      filePath: "C:/sentinel/private/file-9P3X.txt",
      key: "custom.password",
      value: "SENTINEL_SECRET_7M4Q",
      count: 2,
      captionPresent: true,
    });
  });

  it("preserves structured validation issue paths without exempting messages", () => {
    const issues = [
      {
        path: ["content", 0],
        code: "custom",
        message: "Invalid redacted value.",
      },
    ];

    expect(sanitizePublicValue({ issues })).toEqual({
      issues: [
        {
          path: ["content", 0],
          code: "custom",
          message: "[REDACTED:content length=23]",
        },
      ],
    });
    expect(sanitizePublicValue({ payload: { path: [], code: "custom", message: "PRIVATE_MESSAGE_8K2R" } })).toEqual({
      payload: { path: [], code: "custom", message: "[REDACTED:content length=20]" },
    });
  });

  it("publishes only explicitly marked canonical field paths", () => {
    expect(
      sanitizePublicValue({
        fieldPath: publicContractPath("stages[0].key"),
        rootPath: publicContractPath(""),
        diskPath: publicContractPath("C:/private/customer.json"),
        tokenPath: publicContractPath("stages.rctx_SECRET_7M4Q.key"),
        ordinaryPath: "stages[0].key",
      }),
    ).toEqual({
      fieldPath: "stages[0].key",
      rootPath: "<root>",
      diskPath: "[REDACTED:path]",
      tokenPath: "stages.[REDACTED:rctx].key",
      ordinaryPath: "[REDACTED:path]",
    });
  });

  it("redacts compound secret keys without matching unrelated words", () => {
    expect(
      sanitizePublicValue({
        clientSecret: "secret-client-value",
        apiToken: "opaque-api-value",
        databasePassword: "database-passphrase",
        webhook_secret: "webhook-value",
        "custom.password": "custom-passphrase",
        secretary: "Alice",
        passwordless: true,
      }),
    ).toEqual({
      clientSecret: "[REDACTED]",
      apiToken: "[REDACTED]",
      databasePassword: "[REDACTED]",
      webhook_secret: "[REDACTED]",
      "custom.password": "[REDACTED]",
      secretary: "Alice",
      passwordless: true,
    });

    expect(sanitizePublicValue({ key: "custom.secretary", value: "Alice" })).toEqual({
      key: "custom.secretary",
      value: "Alice",
    });
  });

  it("preserves typed secret metadata while redacting plural secret containers", () => {
    expect(
      sanitizePublicValue({
        sessionSecretCount: 1,
        apiTokenChars: 32,
        credentialRefPresent: true,
        secretProvided: false,
        passwordConfigured: true,
        inputTokens: 42,
        revokesClientTokens: true,
        deleteBackendSecret: false,
        session_secrets: ["SENTINEL_SECRET_7M4Q"],
        tokens: ["SENTINEL_SECRET_7M4Q"],
      }),
    ).toEqual({
      sessionSecretCount: 1,
      apiTokenChars: 32,
      credentialRefPresent: true,
      secretProvided: false,
      passwordConfigured: true,
      inputTokens: 42,
      revokesClientTokens: true,
      deleteBackendSecret: false,
      session_secrets: "[REDACTED]",
      tokens: "[REDACTED]",
    });
  });

  it("minimizes semantic paths, URLs and content-like names", () => {
    expect(
      sanitizePublicValue({
        url: "C:/private/client-video.mp4",
        callbackUrl: "https://user:pass@example.com/private?token=secret#fragment",
        route: "/guide",
        fileName: "PRIVATE_CLIENT_FILENAME.pdf",
        sourceName: "PRIVATE_SOURCE_NAME",
        inputName: "PRIVATE_INPUT_NAME",
        subject: "PRIVATE_MAIL_SUBJECT",
      }),
    ).toEqual({
      url: "[REDACTED:path]",
      callbackUrl: "https://example.com",
      route: "/guide",
      fileName: "[REDACTED:content length=27]",
      sourceName: "[REDACTED:content length=19]",
      inputName: "[REDACTED:content length=18]",
      subject: "[REDACTED:content length=20]",
    });
  });

  it("sanitizes path, endpoint, credential and command aliases including URL path tokens", () => {
    const privateCommand = "ravi settings set custom.password SENTINEL_SECRET_7M4Q";

    expect(
      sanitizePublicValue({
        cwd: "C:/private/customer/project",
        outputDir: "C:/private/customer/output",
        endpoint: "https://user:pass@example.com/hooks/SENTINEL_SECRET_7M4Q/callback?token=private",
        credential: "SENTINEL_SECRET_7M4Q",
        credentials: "SENTINEL_SECRET_7M4Q",
        command: privateCommand,
        nestedPathByValue: "C:/private/customer/unlabelled.txt",
      }),
    ).toEqual({
      cwd: "[REDACTED:path]",
      outputDir: "[REDACTED:path]",
      endpoint: "https://example.com",
      credential: "[REDACTED]",
      credentials: "[REDACTED]",
      command: `[REDACTED:content length=${privateCommand.length}]`,
      nestedPathByValue: "[REDACTED:path]",
    });
  });

  it("applies the same aliases to ContractError details", () => {
    const error = new ContractError("demo run", "COMMAND_FAILED", "Command failed.", 1, {
      cwd: "C:/private/customer/project",
      outputDir: "C:/private/customer/output",
      endpoint: "https://example.com/SENTINEL_SECRET_7M4Q/result?token=private",
      credential: "SENTINEL_SECRET_7M4Q",
      credentials: "SENTINEL_SECRET_7M4Q",
    });

    expect(error.details).toEqual({
      cwd: "[REDACTED:path]",
      outputDir: "[REDACTED:path]",
      endpoint: "https://example.com",
      credential: "[REDACTED]",
      credentials: "[REDACTED]",
    });
  });
});
