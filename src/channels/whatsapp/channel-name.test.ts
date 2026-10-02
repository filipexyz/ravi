import { describe, expect, it } from "bun:test";
import { ChannelBackendOpaqueIdSchema } from "../backend.js";
import { isValidWhatsAppChannelName, WHATSAPP_CHANNEL_NAME_RE, whatsappChannelNameFor } from "./channel-name.js";

const INSTANCE_ID = "0b7c3d1e-1111-4222-8333-944455556666";
const never = () => false;

const CORPUS = [
  "main",
  "vendas",
  "Loja-Sao-Paulo",
  "a.b_c~d-e",
  "0starts-with-digit",
  "Loja São Paulo",
  "",
  " ",
  "-leading-dash",
  ".leading-dot",
  "_leading-underscore",
  "has space",
  "slash/name",
  "colon:name",
  "emoji-😀",
  "ção",
  "a".repeat(128),
  "a".repeat(129),
  "é".repeat(64),
  "tab\tname",
];

describe("isValidWhatsAppChannelName", () => {
  it("accepts exactly what ChannelBackendOpaqueIdSchema accepts", () => {
    for (const name of CORPUS) {
      expect({ name, valid: isValidWhatsAppChannelName(name) }).toEqual({
        name,
        valid: ChannelBackendOpaqueIdSchema.safeParse(name).success,
      });
    }
  });

  it("exposes the opaque id pattern", () => {
    expect(WHATSAPP_CHANNEL_NAME_RE.test("main")).toBe(true);
    expect(WHATSAPP_CHANNEL_NAME_RE.test("-main")).toBe(false);
  });
});

describe("whatsappChannelNameFor", () => {
  it("keeps a valid, free account name unchanged", () => {
    expect(whatsappChannelNameFor("main", INSTANCE_ID, never)).toBe("main");
    expect(whatsappChannelNameFor("vendas.sp", INSTANCE_ID, never)).toBe("vendas.sp");
  });

  it("strips accents and replaces invalid characters", () => {
    expect(whatsappChannelNameFor("Loja São Paulo", INSTANCE_ID, never)).toBe("Loja-Sao-Paulo");
    expect(whatsappChannelNameFor("  --Ação  Social!! ", INSTANCE_ID, never)).toBe("Acao-Social-");
    expect(whatsappChannelNameFor("a / b : c", INSTANCE_ID, never)).toBe("a-b-c");
  });

  it("truncates sanitized names to 120 bytes", () => {
    const name = whatsappChannelNameFor(`${"x".repeat(200)} y`, INSTANCE_ID, never);
    expect(name).toBe("x".repeat(120));
  });

  it("falls back to the instance id prefix when nothing usable is left", () => {
    expect(whatsappChannelNameFor("😀😀", INSTANCE_ID, never)).toBe("whatsapp-0b7c3d1e");
    expect(whatsappChannelNameFor("", INSTANCE_ID, never)).toBe("whatsapp-0b7c3d1e");
  });

  it("falls back when the name is taken, then adds a numeric suffix", () => {
    const taken = new Set(["main", "whatsapp-0b7c3d1e", "whatsapp-0b7c3d1e-2"]);
    expect(whatsappChannelNameFor("main", INSTANCE_ID, (name) => taken.has(name))).toBe("whatsapp-0b7c3d1e-3");
  });

  it("uses the sanitized name when only the raw name is unusable", () => {
    const taken = new Set(["Loja São Paulo"]);
    expect(whatsappChannelNameFor("Loja São Paulo", INSTANCE_ID, (name) => taken.has(name))).toBe("Loja-Sao-Paulo");
    expect(whatsappChannelNameFor("Loja São Paulo", INSTANCE_ID, (name) => name === "Loja-Sao-Paulo")).toBe(
      "whatsapp-0b7c3d1e",
    );
  });

  it("always produces a valid opaque channel id", () => {
    const taken = new Set(CORPUS);
    for (const name of CORPUS) {
      for (const isTaken of [never, (candidate: string) => taken.has(candidate)]) {
        const result = whatsappChannelNameFor(name, INSTANCE_ID, isTaken);
        expect(ChannelBackendOpaqueIdSchema.safeParse(result).success).toBe(true);
      }
    }
  });
});
