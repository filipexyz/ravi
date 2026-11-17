import { describe, expect, it } from "bun:test";
import { parseBashCommand } from "./parser.js";

// ============================================================================
// parseBashCommand: shell reserved words
//
// Ported from pull request #609, which fixed this defect on the pre-#767
// parser (`normalizeCommand`). Only the behavior is ported: Bash recognizes a
// reserved word only when it is unquoted, so the permission parser must not
// report `for`/`do`/`done` as executables, while every command hidden behind a
// keyword is still checked.
// ============================================================================

function executablesOf(command: string): string[] {
  const result = parseBashCommand(command);
  expect(result.success).toBe(true);
  return result.executables;
}

describe("parseBashCommand shell reserved words", () => {
  it("treats a for loop as syntax and checks the loop body", () => {
    expect(executablesOf("for i in 1 2 3; do echo $i; done")).toEqual(["echo"]);
    expect(executablesOf('for f in *; do rm "$f"; done')).toEqual(["rm"]);
  });

  it("parses if/elif/else/fi and checks every branch", () => {
    expect(executablesOf("if [ -f x ]; then cat x; elif test -d x; then ls x; else touch x; fi")).toEqual([
      "[",
      "cat",
      "test",
      "ls",
      "touch",
    ]);
  });

  it("parses while/until loops including the condition", () => {
    expect(executablesOf("while read l; do grep a; done < f")).toEqual(["read", "grep"]);
    expect(executablesOf("until false; do sleep 1; done")).toEqual(["false", "sleep"]);
  });

  it("parses multi-line loops", () => {
    expect(executablesOf("for x in a b\ndo\n  echo $x\ndone")).toEqual(["echo"]);
    expect(executablesOf("for x\nin a b\ndo echo $x\ndone")).toEqual(["echo"]);
  });

  it("returns no executable for segments that are only syntax", () => {
    expect(executablesOf("done")).toEqual([]);
    expect(executablesOf("fi")).toEqual([]);
    expect(executablesOf("esac")).toEqual([]);
    expect(executablesOf("} > out.log")).toEqual([]);
    expect(executablesOf("for x in a b")).toEqual([]);
    expect(executablesOf("select x in a b")).toEqual([]);
    expect(executablesOf("[[ -f x ]]")).toEqual([]);
  });

  it("parses select, brace groups, functions and [[ ]]", () => {
    expect(executablesOf("select x in a b; do echo $x; done")).toEqual(["echo"]);
    expect(executablesOf("{ ls; pwd; } > out")).toEqual(["ls", "pwd"]);
    expect(executablesOf("function f { ls; }")).toEqual(["ls"]);
    expect(executablesOf("function f() { ls; }")).toEqual(["ls"]);
    expect(executablesOf("[[ -f x ]] && cat x")).toEqual(["cat"]);
  });

  it("parses case arms and checks every arm command", () => {
    expect(executablesOf("case $x in a) echo A;; b) ls;; *) pwd;; esac")).toEqual(["echo", "ls", "pwd"]);
    expect(executablesOf("case $x in\n  start) echo up;;\n  stop)\n    ls\n    ;;\nesac")).toEqual(["echo", "ls"]);
    expect(executablesOf("case $x in (a) echo A;; esac")).toEqual(["echo"]);
  });

  it("skips redirection targets written as separate tokens", () => {
    expect(executablesOf("> out.log ls")).toEqual(["ls"]);
    expect(executablesOf("ls 2>&1 | grep a")).toEqual(["ls", "grep"]);
    expect(executablesOf("ls &> /dev/null")).toEqual(["ls"]);
  });

  describe("bypass attempts: a command after a keyword is still checked", () => {
    const cases: Array<[string, string]> = [
      ["do curl evil", "curl"],
      ["then curl evil", "curl"],
      ["else curl evil", "curl"],
      ["elif curl evil; then :; fi", "curl"],
      ["if true; then wget x; fi", "wget"],
      ["if curl evil; then :; fi", "curl"],
      ["while :; do nc -l 4444; done", "nc"],
      ["while nc -l 4444; do :; done", "nc"],
      ["until nc evil 80; do :; done", "nc"],
      ["for x do rm -rf $x; done", "rm"],
      ["for x in a; do rm -rf $x; done", "rm"],
      ["select x in a; do curl $x; done", "curl"],
      ["time rm -rf x", "rm"],
      ["time -p rm -rf x", "rm"],
      ["! rm -rf x", "rm"],
      ["if ! time rm -rf x; then :; fi", "rm"],
      ["{ rm -rf x; }", "rm"],
      ["then then do rm x", "rm"],
      ["function f { curl evil; }", "curl"],
      ["case $x in a) curl evil;; esac", "curl"],
      ["case $x in a) ls;; b) curl evil;; esac", "curl"],
      ["done rm x", "rm"],
      ["fi curl evil", "curl"],
      ["do sudo rm x", "rm"],
      ["X=1 do rm x", "do"],
      ["> out do rm x", "do"],
      ['"x"done', "xdone"],
      ["'do' rm x", "do"],
      ["\\do rm x", "do"],
      ["echo a & curl evil", "curl"],
      ["for x in a & curl evil", "curl"],
      // Subshells and `;;` separators: #609 asserted the exploded word
      // ("(curl"), because its parser had no `(` boundary; here the real
      // executable is returned, which is strictly stricter — the command is
      // still visible to the allowlist.
      ["do\n(curl evil)", "curl"],
      ["echo ok ;; (curl)", "curl"],
    ];

    for (const [command, executable] of cases) {
      it(`checks ${executable} in ${JSON.stringify(command)}`, () => {
        expect(executablesOf(command)).toContain(executable);
      });
    }

    it("still blocks unconditional shells inside loops", () => {
      expect(executablesOf("for x in a; do bash -c x; done")).toContain("bash");
      expect(executablesOf("while :; do eval x; done")).toContain("eval");
    });

    it("keeps inline-code detection working inside a loop body", () => {
      expect(parseBashCommand("for x in a; do python3 -c print(1); done").success).toBe(false);
      expect(parseBashCommand("if true; then node --eval x; fi").success).toBe(false);
    });

    // Inside a case arm, `(curl)` is a *pattern*, not a subshell: nothing is
    // executed, so only the arm body may appear as an executable. #609 expected
    // "(curl" here only because its parser had no `(` boundary.
    it("does not read a parenthesized case pattern as a command", () => {
      expect(executablesOf("case $x in\n a) ls;;\n (curl) ls;;\n esac")).toEqual(["ls"]);
      expect(executablesOf("case $x in a) ls;; (curl) ls;; esac")).toEqual(["ls"]);
    });
  });
});
