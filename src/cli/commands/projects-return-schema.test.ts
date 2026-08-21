import { describe, expect, it } from "bun:test";
import {
  projectResourcesListReturnSchema,
  projectsListReturnSchema,
  projectsNextReturnSchema,
} from "./operational-return-schemas.js";

const pagination = {
  limit: 20,
  offset: 0,
  returned: 1,
  total: 1,
  hasMore: false,
  nextOffset: null,
  nextCommand: null,
};

describe("projects generated return contracts", () => {
  it("accepts a non-empty compact project projection", () => {
    const payload = {
      total: 1,
      pagination,
      filters: { status: null, tagSlug: null },
      items: [{ slug: "alpha", status: "active" }],
      projects: [{ slug: "alpha", status: "active" }],
    };
    expect(projectsListReturnSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects empty and unknown project projections", () => {
    const base = {
      total: 1,
      pagination,
      filters: { status: null, tagSlug: null },
    };
    expect(projectsListReturnSchema.safeParse({ ...base, items: [{}], projects: [{}] }).success).toBe(false);
    expect(
      projectsListReturnSchema.safeParse({
        ...base,
        items: [{ invented: true }],
        projects: [{ invented: true }],
      }).success,
    ).toBe(false);
  });

  it("requires pagination and a non-empty status projection on next", () => {
    const filters = { status: "active", tagSlug: null };
    expect(
      projectsNextReturnSchema.safeParse({
        total: 1,
        pagination,
        filters,
        items: [
          {
            project: {
              id: "p",
              slug: "p",
              title: "P",
              status: "active",
              summary: "S",
              hypothesis: "H",
              nextStep: "N",
              lastSignalAt: 1,
              createdAt: 1,
              updatedAt: 1,
              linkCount: 0,
            },
          },
        ],
        projects: [{ operational: null }],
      }).success,
    ).toBe(true);
    expect(projectsNextReturnSchema.safeParse({ total: 1, filters, items: [{}], projects: [{}] }).success).toBe(false);
  });

  it("rejects empty resource projections", () => {
    expect(
      projectResourcesListReturnSchema.safeParse({
        total: 1,
        pagination,
        items: [{}],
        resources: [{}],
      }).success,
    ).toBe(false);
  });
});
