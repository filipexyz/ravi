import { describe, expect, it } from "bun:test";
import {
  FILE_NOT_FOUND_CODE,
  FILE_NOT_FOUND_MESSAGE,
  FILE_NOT_FOUND_SUGGESTED_ACTION,
  isOmniCliAuthFailure,
  localMediaSendCatalogCopy,
  mapMediaSendFailure,
  MediaSendAuthError,
  MEDIA_SEND_FAILED_CODE,
  MEDIA_SEND_FAILED_MESSAGE,
  MEDIA_SEND_FAILED_SUGGESTED_ACTION,
  OMNI_AUTH_FAILED_CODE,
  OMNI_AUTH_FAILED_SUGGESTED_ACTION,
} from "./media-send-auth.js";

describe("Omni CLI auth failure classification", () => {
  it("detects structured Invalid API key / 401 payloads", () => {
    expect(isOmniCliAuthFailure('{"success":false,"error":"Invalid API key"}')).toBe(true);
    expect(isOmniCliAuthFailure('{"error":{"message":"Invalid API key","status":401}}')).toBe(true);
    expect(isOmniCliAuthFailure('{"error":{"code":"UNAUTHORIZED","message":"API error: 401"}}')).toBe(true);
    expect(isOmniCliAuthFailure("API key is invalid")).toBe(true);
  });

  it("does not treat unrelated delivery failures or bare 401 tokens as auth", () => {
    expect(isOmniCliAuthFailure("Remote command failed.")).toBe(false);
    expect(isOmniCliAuthFailure("omni send failed with exit code 1.")).toBe(false);
    expect(isOmniCliAuthFailure("file 401.png missing")).toBe(false);
    expect(isOmniCliAuthFailure('{"error":"instance not found"}')).toBe(false);
  });

  it("maps MediaSendAuthError to OMNI_AUTH_FAILED with stable catalog copy", () => {
    const mapped = mapMediaSendFailure(new MediaSendAuthError());
    expect(mapped).toMatchObject({
      code: OMNI_AUTH_FAILED_CODE,
      message: "Omni rejected the API key used to send media.",
      retryable: false,
      suggestedAction: OMNI_AUTH_FAILED_SUGGESTED_ACTION,
    });
    expect(mapped.suggestedAction).toContain("servers.list.<active>.apiKey");
    expect(mapped.suggestedAction).toContain("OMNI_API_KEY");
    expect(mapped.suggestedAction).not.toMatch(/sk-|omni_sk_/);
  });

  it("preserves_omni_auth_provider_cause_and_code_beneath_catalog_error", () => {
    const original = Object.assign(new Error("The instance rejected this expired credential."), {
      code: "EXPIRED_API_KEY",
      status: 401,
    });
    const mapped = mapMediaSendFailure(new MediaSendAuthError(original));
    expect(mapped.code).toBe(OMNI_AUTH_FAILED_CODE);
    expect(mapped.cause).toBe(original.message);
    expect(mapped.context.code).toBe(original.code);
    expect(mapped.context.status).toBe(original.status);
  });

  it("exposes a local catalog copy for isolated remote media-send codes", () => {
    expect(localMediaSendCatalogCopy(MEDIA_SEND_FAILED_CODE)).toEqual({
      message: MEDIA_SEND_FAILED_MESSAGE,
      suggestedAction: MEDIA_SEND_FAILED_SUGGESTED_ACTION,
    });
    expect(localMediaSendCatalogCopy(FILE_NOT_FOUND_CODE)).toEqual({
      message: FILE_NOT_FOUND_MESSAGE,
      suggestedAction: FILE_NOT_FOUND_SUGGESTED_ACTION,
    });
    expect(localMediaSendCatalogCopy("COMMAND_FAILED")).toBeUndefined();
  });

  it("preserves_media_provider_exact_cause_and_code_without_secrets", () => {
    const original = Object.assign(new Error("Upload rejected: unsupported image encoding."), {
      code: "UNSUPPORTED_ENCODING",
      status: 415,
    });
    const mapped = mapMediaSendFailure(original);
    expect(mapped.cause).toBe(original.message);
    expect(mapped.context.code).toBe(original.code);
    expect(mapped.context.status).toBe(original.status);
  });

  it("preserves_media_provider_cause_without_its_credential", () => {
    const mapped = mapMediaSendFailure(
      new Error("Omni upload rejected: unsupported media format; api_key=sk-abcdefghijklmnop"),
    );
    expect(mapped.code).toBe(MEDIA_SEND_FAILED_CODE);
    expect(mapped.retryable).toBe(true);
    expect(mapped.message).toBe("Media delivery failed.");
    expect(mapped.cause).toContain("Omni upload rejected: unsupported media format");
    expect(mapped.context).toMatchObject({ operation: "media send", provider: "omni" });
    expect(JSON.stringify(mapped)).not.toContain("sk-abcdefghijklmnop");
  });
});
