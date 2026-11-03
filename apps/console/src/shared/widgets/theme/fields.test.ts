import { describe, expect, test } from "bun:test";

import { FIELD_ROLE_DISPLAYS, FIELD_TYPE_DISPLAYS } from "../types";
import { defaultFieldDisplayRules, fieldsJsonFromRules, parseFieldsJson } from "./fields";

describe("defaultFieldDisplayRules", () => {
  test("takes the first display of every closed list", () => {
    const rules = defaultFieldDisplayRules();
    expect(Object.keys(rules.types)).toEqual(Object.keys(FIELD_TYPE_DISPLAYS));
    expect(Object.keys(rules.roles)).toEqual(Object.keys(FIELD_ROLE_DISPLAYS));
    expect(rules.types.status).toBe("pill");
    expect(rules.types.date).toBe("date");
    expect(rules.types.person).toBe("avatar-name");
    expect(rules.roles.progress).toBe("bar");
    expect(rules.roles.rating).toBe("stars");
  });
});

describe("parseFieldsJson", () => {
  test("absent file → defaults", () => {
    expect(parseFieldsJson(undefined)).toEqual({ rules: defaultFieldDisplayRules(), diagnostics: [] });
  });

  test("overrides chosen keys and keeps the rest", () => {
    const { rules, diagnostics } = parseFieldsJson(
      JSON.stringify({
        types: { status: "steps", currency: "compact", date: "relative", person: "initials" },
        roles: { progress: "ring", rating: "number" },
      }),
    );
    expect(diagnostics).toEqual([]);
    expect(rules.types).toMatchObject({ status: "steps", currency: "compact", date: "relative", person: "initials", select: "pill" });
    expect(rules.roles).toMatchObject({ progress: "ring", rating: "number", image: "cover" });
  });

  test("unknown keys and displays are errors with lines; valid entries still apply", () => {
    const text = [
      "{",
      '  "types": {',
      '    "status": "badge",',
      '    "money": "compact",',
      '    "url": "domain"',
      "  },",
      '  "roles": { "highlight": "huge", "cover": "thumb" },',
      '  "layout": {}',
      "}",
    ].join("\n");
    const { rules, diagnostics } = parseFieldsJson(text);
    expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.line, diagnostic.file])).toEqual([
      ["FIELDS_UNKNOWN_DISPLAY", 3, "fields.json"],
      ["FIELDS_UNKNOWN_KEY", 4, "fields.json"],
      ["FIELDS_UNKNOWN_DISPLAY", 7, "fields.json"],
      ["FIELDS_UNKNOWN_KEY", 7, "fields.json"],
      ["FIELDS_UNKNOWN_KEY", 8, "fields.json"],
    ]);
    expect(diagnostics[0]!.message).toContain("pill, steps, text");
    expect(rules.types.status).toBe("pill");
    expect(rules.types.url).toBe("domain");
    expect(rules.roles.highlight).toBe("big");
  });

  test.each([
    ["not json", "FIELDS_JSON_INVALID"],
    ["[]", "FIELDS_JSON_INVALID"],
    ['{"types": []}', "FIELDS_JSON_INVALID"],
    ['{"types": {"checkbox": true}}', "FIELDS_UNKNOWN_DISPLAY"],
    ['{"types": {"toString": "x"}}', "FIELDS_UNKNOWN_KEY"],
  ])("%s → %s", (text, code) => {
    const result = parseFieldsJson(text);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(result.rules).toEqual(defaultFieldDisplayRules());
  });

  test("fieldsJsonFromRules round-trips", () => {
    const rules = parseFieldsJson('{"types": {"checkbox": "yes-no"}, "roles": {"avatar": "square"}}').rules;
    expect(parseFieldsJson(fieldsJsonFromRules(rules))).toEqual({ rules, diagnostics: [] });
  });
});
