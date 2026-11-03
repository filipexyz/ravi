import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { sha256Hex, sha256HexBytes } from "./hash";

const nodeSha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("sha256Hex", () => {
  test("matches known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test.each([
    ["ascii", "The quick brown fox jumps over the lazy dog"],
    ["accents", "Configuração de páginas: ação, coração, pão, Ñandú, Ærøskøbing"],
    ["emoji", "Pedido pronto ✅ 🎉 👩🏽‍💻 🇧🇷"],
    ["cjk", "表示テスト 漢字 한국어"],
  ])("matches node:crypto for %s", (_label, text) => {
    expect(sha256Hex(text)).toBe(nodeSha256(text));
  });

  test("matches node:crypto across block boundaries", () => {
    for (let length = 50; length <= 130; length++) {
      const text = "a".repeat(length);
      expect(sha256Hex(text)).toBe(nodeSha256(text));
    }
  });

  test("matches node:crypto for a 100 KB string", () => {
    let text = "";
    for (let i = 0; text.length < 100 * 1024; i++) text += `linha ${i}: ação ✅ ${String.fromCharCode(32 + (i % 90))}\n`;
    expect(sha256Hex(text)).toBe(nodeSha256(text));
  });

  test("hashes raw bytes", () => {
    const bytes = new Uint8Array(300).map((_, index) => (index * 37) & 0xff);
    expect(sha256HexBytes(bytes)).toBe(nodeSha256(bytes));
  });
});
