import { describe, it, expect } from "bun:test";
import { evaluateFilter } from "../filter.js";

const data = {
  cwd: "/Users/luis/Dev/fm",
  session_id: "381f8b5c-3961-4bde-86d6-96e6a15c0176",
  permission_mode: "bypassPermissions",
  hook_event_name: "Stop",
  nested: { level: "deep" },
};

describe("evaluateFilter", () => {
  describe("no filter", () => {
    it("returns true for undefined filter", () => {
      expect(evaluateFilter(undefined, data)).toBe(true);
    });

    it("returns true for empty string filter", () => {
      expect(evaluateFilter("", data)).toBe(true);
    });

    it("returns true for whitespace-only filter", () => {
      expect(evaluateFilter("   ", data)).toBe(true);
    });
  });

  describe("== operator", () => {
    it("returns true when value matches (double quotes)", () => {
      expect(evaluateFilter(`data.cwd == "/Users/luis/Dev/fm"`, data)).toBe(true);
    });

    it("returns true when value matches (single quotes)", () => {
      expect(evaluateFilter(`data.cwd == '/Users/luis/Dev/fm'`, data)).toBe(true);
    });

    it("returns false when value does not match", () => {
      expect(evaluateFilter(`data.cwd == "/Users/luis/ravi"`, data)).toBe(false);
    });

    it("matches hook_event_name", () => {
      expect(evaluateFilter(`data.hook_event_name == "Stop"`, data)).toBe(true);
      expect(evaluateFilter(`data.hook_event_name == "Start"`, data)).toBe(false);
    });
  });

  describe("!= operator", () => {
    it("returns true when value is different", () => {
      expect(evaluateFilter(`data.cwd != "/Users/luis/ravi"`, data)).toBe(true);
    });

    it("returns false when value is the same", () => {
      expect(evaluateFilter(`data.cwd != "/Users/luis/Dev/fm"`, data)).toBe(false);
    });
  });

  describe("startsWith operator", () => {
    it("returns true when value starts with prefix", () => {
      expect(evaluateFilter(`data.cwd startsWith "/Users/luis/Dev"`, data)).toBe(true);
    });

    it("returns false when value does not start with prefix", () => {
      expect(evaluateFilter(`data.cwd startsWith "/Users/luis/ravi"`, data)).toBe(false);
    });
  });

  describe("endsWith operator", () => {
    it("returns true when value ends with suffix", () => {
      expect(evaluateFilter(`data.cwd endsWith "/fm"`, data)).toBe(true);
    });

    it("returns false when value does not end with suffix", () => {
      expect(evaluateFilter(`data.cwd endsWith "/copilot"`, data)).toBe(false);
    });
  });

  describe("includes operator", () => {
    it("returns true when value contains substring", () => {
      expect(evaluateFilter(`data.cwd includes "Dev"`, data)).toBe(true);
    });

    it("returns false when value does not contain substring", () => {
      expect(evaluateFilter(`data.cwd includes "ravi"`, data)).toBe(false);
    });
  });

  describe("path resolution", () => {
    it("resolves simple top-level path", () => {
      expect(evaluateFilter(`data.permission_mode == "bypassPermissions"`, data)).toBe(true);
    });

    it("returns false for non-existent path (no crash)", () => {
      expect(evaluateFilter(`data.nonexistent == "value"`, data)).toBe(false);
    });

    it("returns false for deeply non-existent path", () => {
      expect(evaluateFilter(`data.a.b.c == "value"`, data)).toBe(false);
    });
  });

  describe("invalid syntax", () => {
    it("returns true (fail open) for completely invalid expression", () => {
      expect(evaluateFilter("this is not valid", data)).toBe(true);
    });

    it("returns true (fail open) for missing quotes around value", () => {
      expect(evaluateFilter("data.cwd == /Users/luis", data)).toBe(true);
    });

    it("returns true (fail open) for unknown operator", () => {
      expect(evaluateFilter(`data.cwd contains "Dev"`, data)).toBe(true);
    });
  });

  describe("type coercion", () => {
    it("coerces non-string values to string for comparison", () => {
      const dataWithNum = { count: 42 };
      expect(evaluateFilter(`data.count == "42"`, dataWithNum)).toBe(true);
    });

    it("coerces boolean to string", () => {
      const dataWithBool = { active: true };
      expect(evaluateFilter(`data.active == "true"`, dataWithBool)).toBe(true);
    });
  });
});
