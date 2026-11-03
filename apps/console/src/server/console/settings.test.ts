import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { parseConsoleMemberRemoveInput, parseConsoleMemberUpsertInput } from "./members";
import { parseUpdateSettingsInput } from "./settings";

describe("Console settings input", () => {
  test("parses organization settings without project-only fields", () => {
    expect(
      parseUpdateSettingsInput({
        name: " Filipe Labs ",
        scope: "org",
        slug: "filipe-labs ",
      }),
    ).toEqual({
      name: "Filipe Labs",
      projectId: null,
      scope: "org",
      slug: "filipe-labs",
      visibility: null,
    });
  });

  test("requires a project ref for project settings", () => {
    expect(() =>
      parseUpdateSettingsInput({
        name: "Ravi Console",
        scope: "project",
        slug: "ravi-console",
      }),
    ).toThrow(ConsoleApiError);
  });

  test("accepts project visibility values only from the Console visibility enum", () => {
    expect(
      parseUpdateSettingsInput({
        name: "Ravi Console",
        projectId: "project_1",
        scope: "project",
        slug: "ravi-console",
        visibility: "private",
      }),
    ).toMatchObject({
      visibility: "private",
    });

    expect(() =>
      parseUpdateSettingsInput({
        name: "Ravi Console",
        projectId: "project_1",
        scope: "project",
        slug: "ravi-console",
        visibility: "enterprise",
      }),
    ).toThrow(ConsoleApiError);
  });
});

describe("Console settings member input", () => {
  test("normalizes add-member email and accepts organization roles", () => {
    expect(
      parseConsoleMemberUpsertInput({
        email: " Thiago@RbbtLab.ai ",
        role: "developer",
      }),
    ).toEqual({
      email: "thiago@rbbtlab.ai",
      role: "developer",
    });
  });

  test("rejects invalid member email and role", () => {
    expect(() =>
      parseConsoleMemberUpsertInput({
        email: "not-an-email",
        role: "root",
      }),
    ).toThrow(ConsoleApiError);
  });

  test("parses member removal by user ref", () => {
    expect(parseConsoleMemberRemoveInput({ userRef: " user_123 " })).toEqual({
      userRef: "user_123",
    });
  });
});
