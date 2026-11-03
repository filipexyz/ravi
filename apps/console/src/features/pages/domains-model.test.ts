import { describe, expect, test } from "bun:test";

import { globalHostRecord, pagesHostnameRecord } from "./domains-model";

describe("Pages custom domain records", () => {
  test("points one hostname to Ravi Pages", () => {
    expect(pagesHostnameRecord("www.customer.com")).toEqual({
      name: "www.customer.com",
      type: "CNAME",
      value: "cname.ravi.page",
    });
  });

  test("offers the global host only next to a subdomain of the proven domain", () => {
    expect(globalHostRecord("nba-ui.rbbt.page", "rbbt.page")).toEqual({
      name: "*.rbbt.page",
      type: "CNAME",
      value: "cname.ravi.page",
    });
    expect(globalHostRecord("docs.customer.co.uk", "customer.co.uk")?.name).toBe("*.customer.co.uk");
    expect(globalHostRecord("customer.co.uk", "customer.co.uk")).toBeNull();
    expect(globalHostRecord("*.customer.com", "customer.com")).toBeNull();
    expect(globalHostRecord("www.customer.com", null)).toBeNull();
  });
});
