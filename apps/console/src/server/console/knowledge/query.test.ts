import { describe, expect, test } from "bun:test";

import { buildKnowledgeQuery } from "./query";

describe("buildKnowledgeQuery", () => {
  test("drops short terms and stopwords, keeps order", () => {
    const query = buildKnowledgeQuery("o que eu prometi pro Marcos?");
    expect(query?.terms).toEqual(["prometi", "pro", "marcos"]);
    expect(query?.simpleAnd).toBe("prometi:* & pro:* & marcos:*");
    expect(query?.simpleOr).toBe("prometi:* | pro:* | marcos:*");
    expect(query?.stemAnd).toBe(query?.simpleAnd);
    expect(query?.stemOr).toBe(query?.simpleOr);
    expect(query?.normalized).toBe("prometi pro marcos");
  });

  test("returns null when only stopwords remain", () => {
    expect(buildKnowledgeQuery("de da do")).toBeNull();
    expect(buildKnowledgeQuery("   ")).toBeNull();
  });

  test("falls back to two-character terms when nothing longer is left", () => {
    expect(buildKnowledgeQuery("ab de")?.terms).toEqual(["ab"]);
  });

  test("dedupes after folding and caps at 12 terms", () => {
    expect(buildKnowledgeQuery("Luís luis LUIS sexta")?.terms).toEqual(["luis", "sexta"]);
    const many = Array.from({ length: 20 }, (_, index) => `termo${index}`).join(" ");
    expect(buildKnowledgeQuery(many)?.terms).toHaveLength(12);
  });

  test("SQL and tsquery metacharacters never reach the query text", () => {
    const query = buildKnowledgeQuery("marcos'; DROP TABLE x; -- & | ! :* ( ) <-> \\ \" $1");
    expect(query).not.toBeNull();
    for (const field of [query?.simpleAnd, query?.simpleOr, query?.stemAnd, query?.stemOr]) {
      expect(field).toMatch(/^[a-z0-9]+:\*( [&|] [a-z0-9]+:\*)*$/);
      expect(field).not.toMatch(/[';"\\$()!<>-]/);
    }
  });
});
