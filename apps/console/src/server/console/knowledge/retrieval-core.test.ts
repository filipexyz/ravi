import { describe, expect, test } from "bun:test";

import { PgDialect } from "drizzle-orm/pg-core";

import { knowledgePrefilter, knowledgeQueryHash } from "./retrieval-core";

const dialect = new PgDialect();
const ORG = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const DOCUMENT = "00000000-0000-4000-8000-000000000003";

describe("retrieval core (pure parts)", () => {
  test("query_hash is an HMAC with the key, null without one", () => {
    expect(knowledgeQueryHash("luis sexta", {})).toBeNull();
    expect(knowledgeQueryHash("luis sexta", { RAVI_KNOWLEDGE_QUERY_HMAC_KEY: "short" })).toBeNull();
    const key = "k".repeat(32);
    const hash = knowledgeQueryHash("luis sexta", { RAVI_KNOWLEDGE_QUERY_HMAC_KEY: key });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(knowledgeQueryHash("luis sexta", { RAVI_KNOWLEDGE_QUERY_HMAC_KEY: key })).toBe(hash);
    expect(knowledgeQueryHash(null, { RAVI_KNOWLEDGE_QUERY_HMAC_KEY: key })).toBeNull();
  });

  test("the prefilter checks live chunk, source and document status and the project scope", () => {
    const rendered = dialect.sqlToQuery(
      knowledgePrefilter({ organizationId: ORG, projectIds: [PROJECT], includeOrgLevel: true }),
    );
    expect(rendered.sql).toContain('"knowledge_chunks"."organization_id" = $1');
    expect(rendered.sql).toContain('"knowledge_chunks"."project_id" in ($2)');
    expect(rendered.sql).toContain('"knowledge_chunks"."project_id" is null');
    expect(rendered.sql).toContain('"knowledge_chunks"."status" = $3');
    expect(rendered.sql).toContain('"knowledge_sources"."status" = $4');
    expect(rendered.params).toEqual([ORG, PROJECT, "active", "active", "chunked", "indexed"]);
  });

  test("pinned documents allow archived; an empty project list matches no project chunk", () => {
    const rendered = dialect.sqlToQuery(
      knowledgePrefilter({ organizationId: ORG, projectIds: [], includeOrgLevel: false, documentIds: [DOCUMENT] }),
    );
    expect(rendered.sql).toContain("false");
    expect(rendered.params).toContain("archived");
    expect(rendered.params).toContain(DOCUMENT);
  });

  test("kinds map to origin_key prefixes and who to a folded speaker substring", () => {
    const rendered = dialect.sqlToQuery(
      knowledgePrefilter(
        { organizationId: ORG, projectIds: [PROJECT], includeOrgLevel: false },
        { kinds: ["meeting", "manual"], who: "Luís", since: new Date("2026-10-09T00:00:00.000Z") },
      ),
    );
    expect(rendered.params).toContain("meeting:%");
    expect(rendered.sql).toContain('"knowledge_sources"."origin_key" is null');
    expect(rendered.params).toContain("%luis%");
    expect(rendered.params).toContain("2026-10-09T00:00:00.000Z");
  });
});
