import { describe, it, expect } from "bun:test";
import { resolveTemplate } from "../template.js";

const context = {
  topic: "ravi.copilot.stop",
  data: {
    session_id: "abc123",
    cwd: "/Users/luis/Dev/filipelabs/ravi.bot",
    permission_mode: "bypassPermissions",
    hook_event_name: "Stop",
    last_assistant_message: "Tô aqui, na escuta.",
    prompt: "oi",
    nested: { level: "deep" },
  },
};

describe("resolveTemplate", () => {
  describe("no variables", () => {
    it("returns message unchanged when no variables", () => {
      expect(resolveTemplate("Hello world", context)).toBe("Hello world");
    });

    it("returns empty string unchanged", () => {
      expect(resolveTemplate("", context)).toBe("");
    });
  });

  describe("{{topic}}", () => {
    it("resolves topic variable", () => {
      expect(resolveTemplate("Topic: {{topic}}", context)).toBe("Topic: ravi.copilot.stop");
    });
  });

  describe("{{data.*}}", () => {
    it("resolves simple data field", () => {
      expect(resolveTemplate("CWD: {{data.cwd}}", context)).toBe(
        "CWD: /Users/luis/Dev/filipelabs/ravi.bot"
      );
    });

    it("resolves last_assistant_message", () => {
      expect(resolveTemplate("Última msg: {{data.last_assistant_message}}", context)).toBe(
        "Última msg: Tô aqui, na escuta."
      );
    });

    it("resolves prompt field", () => {
      expect(resolveTemplate("Prompt: {{data.prompt}}", context)).toBe("Prompt: oi");
    });

    it("resolves hook_event_name", () => {
      expect(resolveTemplate("Evento: {{data.hook_event_name}}", context)).toBe("Evento: Stop");
    });
  });

  describe("multiple variables", () => {
    it("resolves multiple variables in one message", () => {
      const msg = "CC parou em {{data.cwd}}. Último output: {{data.last_assistant_message}}";
      expect(resolveTemplate(msg, context)).toBe(
        "CC parou em /Users/luis/Dev/filipelabs/ravi.bot. Último output: Tô aqui, na escuta."
      );
    });
  });

  describe("unresolved variables", () => {
    it("leaves unknown variable unchanged", () => {
      expect(resolveTemplate("{{unknown}}", context)).toBe("{{unknown}}");
    });

    it("leaves non-existent data path unchanged", () => {
      expect(resolveTemplate("{{data.nonexistent}}", context)).toBe("{{data.nonexistent}}");
    });

    it("leaves deeply non-existent path unchanged", () => {
      expect(resolveTemplate("{{data.a.b.c}}", context)).toBe("{{data.a.b.c}}");
    });
  });

  describe("truncation", () => {
    it("truncates long string values to 300 chars", () => {
      const longMsg = "x".repeat(400);
      const ctx = { topic: "t", data: { msg: longMsg } };
      const result = resolveTemplate("{{data.msg}}", ctx);
      expect(result).toBe("x".repeat(300) + "...");
    });

    it("does not truncate strings within limit", () => {
      const shortMsg = "x".repeat(100);
      const ctx = { topic: "t", data: { msg: shortMsg } };
      expect(resolveTemplate("{{data.msg}}", ctx)).toBe(shortMsg);
    });
  });

  describe("whitespace in variable names", () => {
    it("trims whitespace around variable name", () => {
      expect(resolveTemplate("{{ topic }}", context)).toBe("ravi.copilot.stop");
      expect(resolveTemplate("{{ data.cwd }}", context)).toBe(
        "/Users/luis/Dev/filipelabs/ravi.bot"
      );
    });
  });

  describe("non-string data values", () => {
    it("serializes boolean as string", () => {
      const ctx = { topic: "t", data: { active: true } };
      expect(resolveTemplate("{{data.active}}", ctx)).toBe("true");
    });

    it("serializes number as string", () => {
      const ctx = { topic: "t", data: { count: 42 } };
      expect(resolveTemplate("{{data.count}}", ctx)).toBe("42");
    });

    it("serializes object as JSON", () => {
      const ctx = { topic: "t", data: { obj: { a: 1 } } };
      const result = resolveTemplate("{{data.obj}}", ctx);
      expect(result).toBe('{"a":1}');
    });
  });
});
