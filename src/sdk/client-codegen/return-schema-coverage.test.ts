import "reflect-metadata";
import { describe, expect, it } from "bun:test";

import { getRegistry } from "../../cli/registry-snapshot.js";
import { UNTYPED_PUBLIC_RETURN_COMMANDS_BASELINE } from "./return-schema-baseline.js";
import { WEAK_PUBLIC_RETURN_COMMANDS_BASELINE } from "./return-schema-quality-baseline.js";
import { currentWeakPublicReturnCommands } from "./return-schema-quality.js";

function currentUntypedPublicReturnCommands(): string[] {
  return getRegistry()
    .commands.filter((cmd) => !cmd.cliOnly && !cmd.binary && !cmd.returns)
    .map((cmd) => cmd.fullName)
    .sort((a, b) => a.localeCompare(b));
}

describe("CLI return schema coverage", () => {
  it("keeps the known untyped return baseline exact", () => {
    const current = currentUntypedPublicReturnCommands();
    const baseline: string[] = [...UNTYPED_PUBLIC_RETURN_COMMANDS_BASELINE];
    const baselineSet = new Set<string>(baseline);
    const currentSet = new Set(current);

    const newlyUntyped = current.filter((name) => !baselineSet.has(name));
    const resolvedButStillListed = baseline.filter((name) => !currentSet.has(name));

    expect(
      {
        current: current.length,
        baseline: baseline.length,
        newlyUntyped,
        resolvedButStillListed,
      },
      [
        "Every SDK/OpenAPI command must declare @Returns(...) or @Returns.binary().",
        "If newlyUntyped is non-empty, add return schemas before merging.",
        "If resolvedButStillListed is non-empty, remove those commands from return-schema-baseline.ts.",
      ].join(" "),
    ).toEqual({
      current: baseline.length,
      baseline: baseline.length,
      newlyUntyped: [],
      resolvedButStillListed: [],
    });
  });

  it("keeps the known weak public return-schema baseline exact", () => {
    const current = currentWeakPublicReturnCommands();
    const baseline: string[] = [...WEAK_PUBLIC_RETURN_COMMANDS_BASELINE];
    const baselineSet = new Set<string>(baseline);
    const currentSet = new Set(current);

    const newlyWeak = current.filter((name) => !baselineSet.has(name));
    const strengthenedButStillListed = baseline.filter((name) => !currentSet.has(name));

    expect(
      {
        current: current.length,
        baseline: baseline.length,
        newlyWeak,
        strengthenedButStillListed,
      },
      [
        "Public return schemas must be concrete enough for generated SDK types.",
        "If newlyWeak is non-empty, replace loose schemas such as unknown, unknown arrays, records of unknown, or passthrough objects.",
        "If strengthenedButStillListed is non-empty, remove those commands from return-schema-quality-baseline.ts.",
      ].join(" "),
    ).toEqual({
      current: baseline.length,
      baseline: baseline.length,
      newlyWeak: [],
      strengthenedButStillListed: [],
    });
  });
});
