import { describe, expect, test } from "bun:test";

import { formatTaxId, normalizeTaxId, taxIdKind } from "./tax-id";

describe("CPF and CNPJ", () => {
  test("accepts valid numbers with or without punctuation", () => {
    expect(taxIdKind("529.982.247-25")).toBe("cpf");
    expect(taxIdKind("52998224725")).toBe("cpf");
    expect(taxIdKind("11.222.333/0001-81")).toBe("cnpj");
  });

  test("refuses wrong check digits, repeated digits and other lengths", () => {
    expect(taxIdKind("529.982.247-24")).toBeNull();
    expect(taxIdKind("111.111.111-11")).toBeNull();
    expect(taxIdKind("11.222.333/0001-82")).toBeNull();
    expect(taxIdKind("1234")).toBeNull();
  });

  test("stores digits and shows the usual mask", () => {
    expect(normalizeTaxId("11.222.333/0001-81")).toBe("11222333000181");
    expect(formatTaxId("52998224725")).toBe("529.982.247-25");
    expect(formatTaxId("11222333000181")).toBe("11.222.333/0001-81");
  });
});
