import { describe, expect, test } from "bun:test";

import { PgDialect } from "drizzle-orm/pg-core";

import { knowledgeSearchVectorSql } from "./search-vector";

const dialect = new PgDialect();

describe("knowledgeSearchVectorSql", () => {
  test("binds folded parts and coalesces every one, so a null heading never nulls the vector", () => {
    const { searchVector, searchVectorStem } = knowledgeSearchVectorSql({
      title: "Kickoff Acme",
      heading: null,
      text: "Luís: mando até sexta",
      speakers: ["Luís"],
    });
    const simple = dialect.sqlToQuery(searchVector);
    const stem = dialect.sqlToQuery(searchVectorStem);

    expect(simple.params).toEqual(["kickoff acme", "", "luis mando ate sexta", "luis"]);
    expect(simple.sql.match(/coalesce\(/g)).toHaveLength(4);
    expect(simple.sql).toContain("'simple'::regconfig");
    expect(simple.sql).toContain("'A'");
    expect(simple.sql).toContain("'B'");
    expect(simple.sql).toContain("'C'");
    expect(stem.sql).toContain("'portuguese'::regconfig");
    expect(stem.params).toEqual(simple.params);
  });
});
