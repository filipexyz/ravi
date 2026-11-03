import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  ALWAYS_ALLOWLISTED_ACTION_IDS,
  assertValidCatalogEntry,
  BASES_CHARTS_DATA_ACTION_ID,
  BASES_CONNECTOR_ACTION_IDS,
  BASES_VIEWS_DESCRIBE_ACTION_ID,
  BASES_VIEWS_QUERY_ACTION_ID,
  BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID,
  BASES_VIEWS_ROWS_CREATE_ACTION_ID,
  BASES_VIEWS_ROWS_GET_ACTION_ID,
  BASES_VIEWS_ROWS_UPDATE_ACTION_ID,
  BASES_VIEWS_VERSION_ACTION_ID,
  curatedPlatformUsesSnapshot,
  getPagesConnectorCatalogEntry,
  listPagesConnectorCatalogEntries,
  PAGES_CONNECTOR_CATALOG_SCHEMA_VERSION,
  IDENTITY_ASSERTION_ACTION_ID,
  KNOWLEDGE_SEARCH_ACTION_ID,
  PAGES_PUBLISHED_LIST_ACTION_ID,
  PAGES_SITES_LIST_ACTION_ID,
  PAGES_THEME_GET_ACTION_ID,
  PROJECTS_LIST_ACTION_ID,
  pagesPublishedListInputSchema,
  pagesSitesListInputSchema,
  pagesSitesListOutputSchema,
  parseStoredConnectorUsesSnapshot,
  projectBasesErrorDetails,
  projectCatalogOutput,
  projectsListInputSchema,
  projectsListOutputSchema,
  publicCatalogEntry,
  snapshotConnectorUsesFromManifest,
  unionConnectorUsesSnapshots,
  validateCatalogInput,
  withAlwaysAllowlistedUses,
} from "./catalog";

describe("Pages connector catalog", () => {
  test("exposes unified platform entries for projects.list, sites.list, and published.list", () => {
    const entries = listPagesConnectorCatalogEntries();
    expect(entries.map((entry) => entry.id)).toEqual([
      PROJECTS_LIST_ACTION_ID,
      PAGES_SITES_LIST_ACTION_ID,
      PAGES_PUBLISHED_LIST_ACTION_ID,
      IDENTITY_ASSERTION_ACTION_ID,
      BASES_VIEWS_DESCRIBE_ACTION_ID,
      BASES_VIEWS_QUERY_ACTION_ID,
      BASES_VIEWS_VERSION_ACTION_ID,
      BASES_VIEWS_ROWS_GET_ACTION_ID,
      BASES_VIEWS_ROWS_CREATE_ACTION_ID,
      BASES_VIEWS_ROWS_UPDATE_ACTION_ID,
      BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID,
      BASES_CHARTS_DATA_ACTION_ID,
      PAGES_THEME_GET_ACTION_ID,
      KNOWLEDGE_SEARCH_ACTION_ID,
    ]);

    const projectsList = getPagesConnectorCatalogEntry(PROJECTS_LIST_ACTION_ID);
    expect(projectsList).toMatchObject({
      id: PROJECTS_LIST_ACTION_ID,
      title: "List Console projects",
      auth: "platform",
      providerId: "ravi",
      class: "read",
      revision: 1,
      status: "implemented",
      requiresStepUp: false,
      requiredRoles: [],
      requiredScopes: ["console.projects.read"],
      backedBy: "listProjects",
    });
    expect(projectsList).not.toHaveProperty("connect");
    assertValidCatalogEntry(projectsList!);

    const sitesList = getPagesConnectorCatalogEntry(PAGES_SITES_LIST_ACTION_ID);
    expect(sitesList).toMatchObject({
      id: PAGES_SITES_LIST_ACTION_ID,
      title: "List Pages sites",
      auth: "platform",
      providerId: "ravi",
      class: "read",
      revision: 1,
      status: "implemented",
      requiresStepUp: false,
      requiredRoles: [],
      requiredScopes: ["console.projects.read"],
    });
    expect(sitesList).not.toHaveProperty("connect");
    expect(sitesList?.inputSchema.additionalProperties).toBe(false);
    expect(sitesList?.inputSchema.properties).toHaveProperty("projectRef");
    expect(sitesList?.outputSchema.required).toEqual(["items"]);
    assertValidCatalogEntry(sitesList!);
  });

  test("snapshots manifesto uses to catalog revisions", () => {
    expect(snapshotConnectorUsesFromManifest(undefined)).toBeUndefined();
    expect(snapshotConnectorUsesFromManifest([PAGES_SITES_LIST_ACTION_ID, PAGES_SITES_LIST_ACTION_ID])).toEqual({
      catalogSchemaVersion: PAGES_CONNECTOR_CATALOG_SCHEMA_VERSION,
      uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
    });
  });

  test("rejects unknown, planned, or secret-like uses ids", () => {
    expect(() => snapshotConnectorUsesFromManifest(["not.a.tool"])).toThrow(ConsoleApiError);
    expect(() => snapshotConnectorUsesFromManifest(["https://www.googleapis.com/auth/gmail.readonly"])).toThrow(
      ConsoleApiError,
    );
    try {
      snapshotConnectorUsesFromManifest(["gmail.message.send"]);
      throw new Error("expected unknown oauth id to fail in this slice");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).payload.error).toBe("connector_capability_unsupported");
    }
  });

  test("validates sites.list input against the locked schema", () => {
    expect(validateCatalogInput(getPagesConnectorCatalogEntry(PAGES_SITES_LIST_ACTION_ID)!, {})).toEqual({
      limit: 50,
    });
    expect(pagesSitesListInputSchema.parse({ limit: 10 })).toEqual({ limit: 10 });
    expect(pagesSitesListInputSchema.parse({ projectRef: " other-project " })).toEqual({
      limit: 50,
      projectRef: "other-project",
    });
    expect(() => pagesSitesListInputSchema.parse({ limit: 0 })).toThrow();
    expect(() => pagesSitesListInputSchema.parse({ projectId: "proj_other" })).toThrow();
    expect(() => pagesPublishedListInputSchema.parse({ projectId: "proj_other" })).toThrow();
  });

  test("validates projects.list input and projects a tight output", () => {
    expect(validateCatalogInput(getPagesConnectorCatalogEntry(PROJECTS_LIST_ACTION_ID)!, {})).toEqual({
      limit: 50,
    });
    expect(projectsListInputSchema.parse({ limit: 10 })).toEqual({ limit: 10 });
    expect(() => projectsListInputSchema.parse({ projectRef: "proj_other" })).toThrow();
    expect(
      projectsListOutputSchema.parse({
        items: [
          {
            id: "proj_1",
            slug: "demo",
            name: "Demo",
            description: "Hub",
            orgId: "org_1",
          },
        ],
        extra: true,
      }),
    ).toEqual({
      items: [{ id: "proj_1", slug: "demo", name: "Demo", description: "Hub" }],
    });
  });

  test("projects sites.list output and drops extra fields", () => {
    const parsed = pagesSitesListOutputSchema.parse({
      items: [
        {
          id: "site_1",
          slug: "demo",
          defaultHostname: "demo.ravi.page",
          defaultVisibility: "private",
          status: "active",
          updatedAt: 1,
          extra: "nope",
        },
      ],
      extra: true,
    });
    expect(parsed).toEqual({
      items: [
        {
          id: "site_1",
          slug: "demo",
          defaultHostname: "demo.ravi.page",
          defaultVisibility: "private",
          status: "active",
          updatedAt: 1,
        },
      ],
    });
  });

  test("reads stored release snapshots from artifact or publish metadata", () => {
    expect(
      parseStoredConnectorUsesSnapshot({
        connectors: {
          catalogSchemaVersion: 1,
          uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
        },
      }),
    ).toEqual({
      catalogSchemaVersion: 1,
      uses: [{ id: PAGES_SITES_LIST_ACTION_ID, revision: 1 }],
    });
    expect(curatedPlatformUsesSnapshot().uses.map((item) => item.id)).toContain(PAGES_SITES_LIST_ACTION_ID);
    expect(curatedPlatformUsesSnapshot().uses.map((item) => item.id)).not.toContain(IDENTITY_ASSERTION_ACTION_ID);
  });

  test("the host allowlist is the union of route snapshots, highest revision per id", () => {
    const routeA = {
      catalogSchemaVersion: 1,
      uses: [
        { id: BASES_VIEWS_DESCRIBE_ACTION_ID, revision: 1 },
        { id: BASES_VIEWS_ROWS_CREATE_ACTION_ID, revision: 1 },
      ],
    };
    const routeB = {
      catalogSchemaVersion: 1,
      uses: [
        { id: BASES_VIEWS_DESCRIBE_ACTION_ID, revision: 2 },
        { id: BASES_VIEWS_QUERY_ACTION_ID, revision: 1 },
      ],
    };
    expect(unionConnectorUsesSnapshots([routeA, null, routeB, undefined])).toEqual({
      catalogSchemaVersion: 1,
      uses: [
        { id: BASES_VIEWS_DESCRIBE_ACTION_ID, revision: 2 },
        { id: BASES_VIEWS_ROWS_CREATE_ACTION_ID, revision: 1 },
        { id: BASES_VIEWS_QUERY_ACTION_ID, revision: 1 },
      ],
    });
    // A route without uses adds nothing and removes nothing.
    expect(unionConnectorUsesSnapshots([routeA, null])).toEqual(routeA);
    expect(unionConnectorUsesSnapshots([null, undefined])).toBeNull();
    expect(unionConnectorUsesSnapshots([])).toBeNull();
  });

  test("publicCatalogEntry copies the public fields by name and drops every other entry field", () => {
    const entry = getPagesConnectorCatalogEntry(PAGES_SITES_LIST_ACTION_ID)!;
    // A field added to entries later (an implementer note like backedBy) must not reach Pages by default.
    const withNotes = { ...entry, backedBy: "listPageSitesForProject", reviewNotes: "internal" } as typeof entry;
    const projected = publicCatalogEntry(withNotes);
    expect(Object.keys(projected).sort()).toEqual(
      [
        "auth",
        "class",
        "description",
        "id",
        "inputSchema",
        "outputSchema",
        "providerId",
        "requiredRoles",
        "requiredScopes",
        "requiresStepUp",
        "revision",
        "status",
        "title",
      ].sort(),
    );
    const connect = { connectionProviderId: "google", requiredProviderScopes: ["gmail.send"], resourceTypes: ["mailbox"] };
    expect(publicCatalogEntry({ ...withNotes, auth: "oauth", providerId: "google", connect }).connect).toEqual(connect);
  });

  test("keeps viewer assertion output to the token and opts it out of the curated allowlist", () => {
    const entry = getPagesConnectorCatalogEntry(IDENTITY_ASSERTION_ACTION_ID);
    expect(entry).toMatchObject({
      id: IDENTITY_ASSERTION_ACTION_ID,
      auth: "platform",
      providerId: "ravi",
      class: "read",
      revision: 1,
      status: "implemented",
      requiredScopes: ["console.projects.read"],
    });
    expect(entry).not.toHaveProperty("connect");
    expect(validateCatalogInput(entry!, { aud: " https://api.customer.example " })).toEqual({
      aud: "https://api.customer.example",
    });
    expect(() => validateCatalogInput(entry!, { aud: "https://api.customer.example/*" })).toThrow();
    expect(() =>
      projectCatalogOutput(entry!, {
        token: "aaa.bbb.ccc",
        consoleUserId: "nope",
      }),
    ).toThrow();
    expect(projectCatalogOutput(entry!, { token: "aaa.bbb.ccc" })).toEqual({ token: "aaa.bbb.ccc" });
    expect(snapshotConnectorUsesFromManifest([IDENTITY_ASSERTION_ACTION_ID])).toEqual({
      catalogSchemaVersion: PAGES_CONNECTOR_CATALOG_SCHEMA_VERSION,
      uses: [{ id: IDENTITY_ASSERTION_ACTION_ID, revision: 1 }],
    });
  });

  describe("Bases actions", () => {
    const VIEW_ID = "6e0b4f3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    const ROW_ID = "0c7a4f3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    const entry = (id: string) => getPagesConnectorCatalogEntry(id)!;

    test("are valid implemented platform entries with locked classes and JSON Schemas", () => {
      const classes: Record<string, string> = {
        [BASES_VIEWS_DESCRIBE_ACTION_ID]: "read",
        [BASES_VIEWS_QUERY_ACTION_ID]: "read",
        [BASES_VIEWS_VERSION_ACTION_ID]: "read",
        [BASES_VIEWS_ROWS_GET_ACTION_ID]: "read",
        [BASES_VIEWS_ROWS_CREATE_ACTION_ID]: "write",
        [BASES_VIEWS_ROWS_UPDATE_ACTION_ID]: "write",
        [BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID]: "write",
        [BASES_CHARTS_DATA_ACTION_ID]: "read",
      };
      expect([...BASES_CONNECTOR_ACTION_IDS].sort()).toEqual(Object.keys(classes).sort());
      for (const [id, actionClass] of Object.entries(classes)) {
        const action = entry(id);
        expect(action).toMatchObject({
          id,
          auth: "platform",
          providerId: "ravi",
          class: actionClass,
          revision: 1,
          status: "implemented",
          requiresStepUp: false,
          requiredRoles: [],
          requiredScopes: [actionClass === "read" ? "console.bases.read" : "console.bases.write"],
        });
        expect(action).not.toHaveProperty("connect");
        assertValidCatalogEntry(action);
        expect(action.inputSchema).toMatchObject({ $id: `${id}.input.1`, type: "object", additionalProperties: false });
        expect(action.outputSchema).toMatchObject({ $id: `${id}.output.1`, type: "object", additionalProperties: false });
        expect(JSON.parse(JSON.stringify(action.inputSchema))).toEqual(action.inputSchema);
        expect(JSON.parse(JSON.stringify(action.outputSchema))).toEqual(action.outputSchema);
      }
      expect(entry(BASES_VIEWS_QUERY_ACTION_ID).inputSchema.required).toEqual(["viewId"]);
      expect(entry(BASES_VIEWS_ROWS_CREATE_ACTION_ID).inputSchema.required).toEqual(["viewId", "values", "idempotencyKey"]);
      expect(entry(BASES_VIEWS_ROWS_UPDATE_ACTION_ID).inputSchema.required).toEqual([
        "viewId",
        "rowId",
        "values",
        "expectedVersion",
        "idempotencyKey",
      ]);
      expect(entry(BASES_VIEWS_ROWS_UPDATE_ACTION_ID).inputSchema.properties).not.toHaveProperty("lastWriteWins");
      expect(entry(BASES_VIEWS_ROWS_GET_ACTION_ID).inputSchema.required).toEqual(["viewId", "rowId"]);
      expect(entry(BASES_VIEWS_ROWS_GET_ACTION_ID).outputSchema.required).toEqual(["rowId", "version", "values", "users"]);
      expect(entry(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID).inputSchema.required).toEqual(["viewId", "rowId", "expectedVersion"]);
      expect(entry(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID).inputSchema.properties).not.toHaveProperty("lastWriteWins");
      expect(entry(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID).outputSchema.required).toEqual(["rowId", "version"]);
      expect(entry(BASES_VIEWS_QUERY_ACTION_ID).inputSchema.$defs).toHaveProperty("filter");
    });

    test("are excluded from the curated implicit allowlist and must be declared in uses", () => {
      const curated = curatedPlatformUsesSnapshot().uses.map((item) => item.id);
      for (const id of BASES_CONNECTOR_ACTION_IDS) expect(curated).not.toContain(id);
      expect(snapshotConnectorUsesFromManifest([BASES_VIEWS_QUERY_ACTION_ID, BASES_VIEWS_ROWS_CREATE_ACTION_ID])).toEqual({
        catalogSchemaVersion: PAGES_CONNECTOR_CATALOG_SCHEMA_VERSION,
        uses: [
          { id: BASES_VIEWS_QUERY_ACTION_ID, revision: 1 },
          { id: BASES_VIEWS_ROWS_CREATE_ACTION_ID, revision: 1 },
        ],
      });
    });

    test("validate input strictly", () => {
      expect(validateCatalogInput(entry(BASES_VIEWS_DESCRIBE_ACTION_ID), { viewId: VIEW_ID })).toEqual({ viewId: VIEW_ID });
      expect(() => validateCatalogInput(entry(BASES_VIEWS_DESCRIBE_ACTION_ID), { viewId: "view_1" })).toThrow();
      expect(() => validateCatalogInput(entry(BASES_VIEWS_DESCRIBE_ACTION_ID), { viewId: VIEW_ID, projectId: "p" })).toThrow();

      const query = entry(BASES_VIEWS_QUERY_ACTION_ID);
      expect(
        validateCatalogInput(query, {
          viewId: VIEW_ID,
          filter: { and: [{ prop: "status", op: "eq", value: "Open" }] },
          sort: [{ prop: "amount" }],
          limit: 20,
          cursor: null,
        }),
      ).toEqual({
        viewId: VIEW_ID,
        filter: { and: [{ prop: "status", op: "eq", value: "Open" }] },
        sort: [{ prop: "amount", dir: "asc" }],
        limit: 20,
        cursor: null,
      });
      expect(() => validateCatalogInput(query, { viewId: VIEW_ID, sql: "select 1" })).toThrow();
      expect(() => validateCatalogInput(query, { viewId: VIEW_ID, limit: 501 })).toThrow();
      expect(() => validateCatalogInput(query, { viewId: VIEW_ID, includeArchived: true })).toThrow();
      expect(validateCatalogInput(query, { viewId: VIEW_ID, search: "  acme " })).toEqual({ viewId: VIEW_ID, search: "acme" });
      expect(() => validateCatalogInput(query, { viewId: VIEW_ID, search: "x".repeat(201) })).toThrow();
      expect(() => validateCatalogInput(query, { viewId: VIEW_ID, asUserId: VIEW_ID })).toThrow();

      const version = entry(BASES_VIEWS_VERSION_ACTION_ID);
      expect(version).toMatchObject({ class: "read", revision: 1, requiredScopes: ["console.bases.read"] });
      expect(validateCatalogInput(version, { viewId: VIEW_ID })).toEqual({ viewId: VIEW_ID });
      expect(() => validateCatalogInput(version, {})).toThrow();
      expect(() => validateCatalogInput(version, { viewId: VIEW_ID, filter: null })).toThrow();
      expect(projectCatalogOutput(version, { fingerprint: "ab".repeat(16), extra: 1 })).toEqual({ fingerprint: "ab".repeat(16) });
      // The filter grammar (operators, node keys, depth) is left to the Bases compiler, which
      // answers invalid_filter as on every other surface, not payload_invalid here.
      let deep: unknown = { prop: "a", op: "is_empty" };
      for (let i = 0; i < 8; i += 1) deep = { not: deep };
      for (const filter of [{ prop: "a", op: "like", value: "%" }, { prop: "a", op: "eq", value: 1, extra: true }, deep]) {
        expect(validateCatalogInput(query, { viewId: VIEW_ID, filter })).toEqual({ viewId: VIEW_ID, filter });
      }

      const create = entry(BASES_VIEWS_ROWS_CREATE_ACTION_ID);
      expect(
        validateCatalogInput(create, { viewId: VIEW_ID, values: { name: "Ada" }, idempotencyKey: "form-submit-0001" }),
      ).toEqual({ viewId: VIEW_ID, values: { name: "Ada" }, idempotencyKey: "form-submit-0001" });
      expect(() => validateCatalogInput(create, { viewId: VIEW_ID, values: {} })).toThrow();
      expect(() => validateCatalogInput(create, { viewId: VIEW_ID, values: {}, idempotencyKey: "short" })).toThrow();
      expect(() =>
        validateCatalogInput(create, { viewId: VIEW_ID, rows: [{ values: {} }], idempotencyKey: "form-submit-0001" }),
      ).toThrow();

      const update = entry(BASES_VIEWS_ROWS_UPDATE_ACTION_ID);
      const updateInput = { viewId: VIEW_ID, rowId: ROW_ID, values: { status: "Won" }, expectedVersion: 3, idempotencyKey: "row-edit-00001" };
      expect(validateCatalogInput(update, updateInput)).toEqual(updateInput);
      expect(() => validateCatalogInput(update, { ...updateInput, expectedVersion: undefined })).toThrow();
      expect(() => validateCatalogInput(update, { ...updateInput, lastWriteWins: true })).toThrow();

      const get = entry(BASES_VIEWS_ROWS_GET_ACTION_ID);
      expect(validateCatalogInput(get, { viewId: VIEW_ID, rowId: ROW_ID })).toEqual({ viewId: VIEW_ID, rowId: ROW_ID });
      expect(() => validateCatalogInput(get, { viewId: VIEW_ID })).toThrow();
      expect(() => validateCatalogInput(get, { viewId: VIEW_ID, rowId: "row_1" })).toThrow();
      expect(() => validateCatalogInput(get, { viewId: VIEW_ID, rowId: ROW_ID, includeArchived: true })).toThrow();

      const archive = entry(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID);
      const archiveInput = { viewId: VIEW_ID, rowId: ROW_ID, expectedVersion: 2 };
      expect(validateCatalogInput(archive, archiveInput)).toEqual(archiveInput);
      expect(() => validateCatalogInput(archive, { viewId: VIEW_ID, rowId: ROW_ID })).toThrow();
      expect(() => validateCatalogInput(archive, { viewId: VIEW_ID, rowId: ROW_ID, lastWriteWins: true })).toThrow();
      expect(() => validateCatalogInput(archive, { ...archiveInput, expectedVersion: 0 })).toThrow();
      expect(() => validateCatalogInput(archive, { ...archiveInput, idempotencyKey: "row-archive-0001" })).toThrow();

      expect(validateCatalogInput(entry(BASES_CHARTS_DATA_ACTION_ID), { chartId: VIEW_ID })).toEqual({ chartId: VIEW_ID });
      expect(() => validateCatalogInput(entry(BASES_CHARTS_DATA_ACTION_ID), { chartId: VIEW_ID, filter: null })).toThrow();
    });

    test("project outputs to the declared shapes", () => {
      expect(
        projectCatalogOutput(entry(BASES_VIEWS_DESCRIBE_ACTION_ID), {
          id: VIEW_ID,
          baseId: ROW_ID,
          name: "Pipeline",
          description: null,
          layout: { type: "table" },
          version: 2,
          columns: [{ key: "name", name: "Name", type: "text", config: {}, required: true }],
          capabilities: { read: true, aggregateOnly: false, writeColumns: [], create: false, archive: false, manage: false, approve: [] },
          valid: true,
          view: { query: { filter: { prop: "owner", op: "eq", value: "secret" } }, access: {} },
        }),
      ).toEqual({
        id: VIEW_ID,
        baseId: ROW_ID,
        name: "Pipeline",
        description: null,
        layout: { type: "table" },
        version: 2,
        columns: [{ key: "name", name: "Name", type: "text", config: {}, required: true }],
        capabilities: { read: true, aggregateOnly: false, writeColumns: [], create: false, archive: false, approve: [] },
        valid: true,
      });

      expect(
        projectCatalogOutput(entry(BASES_VIEWS_QUERY_ACTION_ID), {
          columns: ["name"],
          rows: [{ rowId: ROW_ID, version: 1, values: { name: "Ada" }, archivedAt: null }],
          nextCursor: null,
          users: {},
        }),
      ).toEqual({ columns: ["name"], rows: [{ rowId: ROW_ID, version: 1, values: { name: "Ada" } }], nextCursor: null, users: {} });

      expect(
        projectCatalogOutput(entry(BASES_VIEWS_ROWS_CREATE_ACTION_ID), { rowId: ROW_ID, version: 1, values: { name: "Ada" } }),
      ).toEqual({ rowId: ROW_ID, version: 1 });

      const users = { user_1: { id: "user_1", displayName: "Ada", avatarUrl: null } };
      expect(
        projectCatalogOutput(entry(BASES_VIEWS_ROWS_GET_ACTION_ID), {
          rowId: ROW_ID,
          version: 3,
          values: { name: "Ada", owner: ["user_1"] },
          body: "Notes",
          archivedAt: null,
          users,
          idempotentReplay: false,
        }),
      ).toEqual({ rowId: ROW_ID, version: 3, values: { name: "Ada", owner: ["user_1"] }, body: "Notes", users });
      expect(() => projectCatalogOutput(entry(BASES_VIEWS_ROWS_GET_ACTION_ID), { rowId: ROW_ID, version: 3, values: {} })).toThrow();

      expect(
        projectCatalogOutput(entry(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID), { rowId: ROW_ID, version: 4, values: { name: "Ada" } }),
      ).toEqual({ rowId: ROW_ID, version: 4 });

      expect(
        projectCatalogOutput(entry(BASES_CHARTS_DATA_ACTION_ID), {
          chart: {
            id: VIEW_ID,
            baseId: ROW_ID,
            viewId: VIEW_ID,
            name: "By status",
            description: null,
            spec: { mark: "bar", encoding: {} },
            version: 1,
            status: "active",
          },
          groups: [{ x: "opt_1", y: 7 }],
          fields: {},
          suppressedGroups: 1,
          users: {},
          data: [{ x: "leak" }],
        }),
      ).toEqual({
        chart: {
          id: VIEW_ID,
          baseId: ROW_ID,
          viewId: VIEW_ID,
          name: "By status",
          description: null,
          spec: { mark: "bar", encoding: {} },
          version: 1,
        },
        groups: [{ x: "opt_1", y: 7 }],
        fields: {},
        suppressedGroups: 1,
        users: {},
      });
    });

    test("project error details by code", () => {
      const current = { rowId: ROW_ID, version: 5, values: { status: "opt_1" } };
      expect(projectBasesErrorDetails({ error: "validation_failed", fieldErrors: { email: "Invalid." } })).toEqual({
        fieldErrors: { email: "Invalid." },
      });
      expect(projectBasesErrorDetails({ error: "version_conflict", current: { ...current, archivedAt: null } })).toEqual({ current });
      expect(projectBasesErrorDetails({ error: "validation_failed", current })).toEqual({});
      expect(projectBasesErrorDetails({ error: "version_conflict", fieldErrors: { email: "Invalid." } })).toEqual({});
      expect(projectBasesErrorDetails({ error: "payload_invalid", fieldErrors: { values: "Bad." } })).toEqual({});
      expect(projectBasesErrorDetails({ error: "validation_failed", fieldErrors: { email: ["Invalid."] } })).toEqual({});
      expect(projectBasesErrorDetails({ error: "version_conflict", current: { rowId: ROW_ID } })).toEqual({});
    });
  });

  describe("ravi.pages.theme.get", () => {
    const entry = () => getPagesConnectorCatalogEntry(PAGES_THEME_GET_ACTION_ID)!;
    const theme = { hash: "a".repeat(64), css: "@layer ravi.theme;", locale: "pt-BR", version: 3, ref: "org/marca" };

    test("is a platform read with a strict empty input and the theme or { none: true } as output", () => {
      expect(entry()).toMatchObject({
        id: PAGES_THEME_GET_ACTION_ID,
        auth: "platform",
        providerId: "ravi",
        class: "read",
        revision: 1,
        status: "implemented",
        requiredRoles: [],
        requiredScopes: ["console.projects.read"],
        requiresStepUp: false,
      });
      expect(entry().inputSchema).toEqual({ $id: "ravi.pages.theme.get.input.1", type: "object", additionalProperties: false, properties: {} });
      expect(entry().outputSchema.oneOf?.map((shape) => shape.required)).toEqual([["hash", "css", "locale", "version", "ref"], ["none"]]);
      expect(validateCatalogInput(entry(), undefined)).toEqual({});
      expect(() => validateCatalogInput(entry(), { project: "other" })).toThrow();
      expect(projectCatalogOutput(entry(), theme)).toEqual(theme);
      expect(projectCatalogOutput(entry(), { none: true })).toEqual({ none: true });
      expect(() => projectCatalogOutput(entry(), { ...theme, files: [] })).toThrow();
      expect(() => projectCatalogOutput(entry(), { none: false })).toThrow();
      expect(() => projectCatalogOutput(entry(), { ...theme, hash: "not-a-hash" })).toThrow();
    });

    test("is always allowlisted: in the curated fallback and added to every stored snapshot", () => {
      expect([...ALWAYS_ALLOWLISTED_ACTION_IDS]).toEqual([PAGES_THEME_GET_ACTION_ID]);
      expect(curatedPlatformUsesSnapshot().uses).toContainEqual({ id: PAGES_THEME_GET_ACTION_ID, revision: 1 });
      const stored = { catalogSchemaVersion: 1, uses: [{ id: BASES_VIEWS_DESCRIBE_ACTION_ID, revision: 1 }] };
      expect(withAlwaysAllowlistedUses(stored)).toEqual({
        catalogSchemaVersion: 1,
        uses: [
          { id: BASES_VIEWS_DESCRIBE_ACTION_ID, revision: 1 },
          { id: PAGES_THEME_GET_ACTION_ID, revision: 1 },
        ],
      });
      expect(withAlwaysAllowlistedUses({ catalogSchemaVersion: 1, uses: [] }).uses).toEqual([{ id: PAGES_THEME_GET_ACTION_ID, revision: 1 }]);
      // An id the snapshot already lists keeps the snapshot's revision; nothing else is added.
      const pinned = { catalogSchemaVersion: 1, uses: [{ id: PAGES_THEME_GET_ACTION_ID, revision: 7 }] };
      expect(withAlwaysAllowlistedUses(pinned)).toEqual(pinned);
      const everything = withAlwaysAllowlistedUses({ catalogSchemaVersion: 1, uses: [] }).uses.map((item) => item.id);
      for (const id of [...BASES_CONNECTOR_ACTION_IDS, IDENTITY_ASSERTION_ACTION_ID]) expect(everything).not.toContain(id);
    });
  });

  test("ravi.knowledge.search is a platform read built-in, never implicitly allowlisted", () => {
    const entry = getPagesConnectorCatalogEntry(KNOWLEDGE_SEARCH_ACTION_ID);
    expect(entry).toMatchObject({
      id: "ravi.knowledge.search",
      auth: "platform",
      providerId: "ravi",
      class: "read",
      requiredRoles: [],
      requiredScopes: [],
      revision: 1,
      status: "implemented",
      backedBy: "searchMarkedPagesForViewer",
    });
    assertValidCatalogEntry(entry!);
    expect(publicCatalogEntry(entry!)).not.toHaveProperty("backedBy");
    expect(curatedPlatformUsesSnapshot().uses.map((item) => item.id)).not.toContain(KNOWLEDGE_SEARCH_ACTION_ID);

    expect(validateCatalogInput(entry!, { query: "  prazo de troca " })).toEqual({ query: "prazo de troca", limit: 4 });
    expect(validateCatalogInput(entry!, { query: "x", limit: 5 })).toEqual({ query: "x", limit: 5 });
    for (const bad of [{}, { query: "" }, { query: "a".repeat(501) }, { query: "x", limit: 6 }, { query: "x", extra: 1 }]) {
      expect(() => validateCatalogInput(entry!, bad)).toThrow();
    }
    expect(
      projectCatalogOutput(entry!, {
        results: [{ path: "/trocas", url: "https://demo.ravi.page/trocas#prazo", anchor: "prazo", heading: "Prazo", text: "30 dias" }],
        issues: [],
      }),
    ).toEqual({
      results: [{ path: "/trocas", url: "https://demo.ravi.page/trocas#prazo", anchor: "prazo", heading: "Prazo", text: "30 dias" }],
      issues: [],
    });
  });
});
