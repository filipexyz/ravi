/**
 * Bash guard: launchers, real executable identity and analysis/authority split
 * (bug 2233cbee, bypass study). Every bypass here ran arbitrary shell under the
 * bootstrap profile on dev before this change.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateBashPermission, type BashPermissionContext } from "./hook.js";
import { checkDangerousPatterns, parseBashCommand } from "./parser.js";
import { checkExecutablePath } from "./executable-path.js";
import { ShellAnalysisError } from "./shell-structure.js";
import { bootstrapCapabilitiesFor } from "../permissions/runtime-bootstrap-provider.js";
import type { ContextCapability } from "../router/router-db.js";

const SHELL = existsSync("/bin/sh") ? "/bin/sh" : null;
let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ravi-bash-realpath-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const grant = (...names: string[]): ContextCapability[] =>
  names.map((objectId) => ({ permission: "execute", objectType: "executable", objectId }));

function bootstrap(...extra: string[]): BashPermissionContext {
  return {
    agentId: "bash-bootstrap",
    kind: "test-runtime",
    cwd: scratch || tmpdir(),
    capabilities: [...bootstrapCapabilitiesFor("agent"), ...grant(...extra)],
  };
}

function named(...names: string[]): BashPermissionContext {
  return { agentId: "bash-named", kind: "test-runtime", cwd: scratch || tmpdir(), capabilities: grant(...names) };
}

function withWrite(ctx: BashPermissionContext): BashPermissionContext {
  return {
    ...ctx,
    capabilities: [...(ctx.capabilities ?? []), { permission: "use", objectType: "tool", objectId: "Write" }],
  };
}

const arbitrary: BashPermissionContext = {
  agentId: "bash-arbitrary",
  kind: "test-runtime",
  capabilities: grant("*"),
};

describe("bootstrap_denies_shell_launchers", () => {
  // The launcher itself is granted where bootstrap lacks it: a grant on the
  // launcher never authorizes the interpreter it would start.
  it.each([
    ["ls | xargs sh -c 'id'", []],
    ["xargs -0 -n1 bash -c id", []],
    ["find . -maxdepth 0 -exec sh -c id \\;", []],
    ["find . -execdir zsh -c id +", []],
    ["env sh -c id", ["env"]],
    ["/usr/bin/env -i FOO=1 bash -c id", ["env"]],
    ["timeout 5 bash -c id", ["timeout"]],
    ["nice -n 5 sh -c id", ["nice"]],
    ["nohup sh -c id", ["nohup"]],
    ["xargs node script.js", ["node"]],
    ["xargs bun run x.ts", []],
    ["env timeout 5 sh -c id", ["env", "timeout"]],
    ["parallel echo ::: a b", ["parallel", "echo"]],
    ["watch -n1 date", ["watch", "date"]],
  ] as Array<[string, string[]]>)("%s", (command, extra) => {
    const decision = evaluateBashPermission(command, bootstrap(...extra));
    expect(decision.allowed, command).toBe(false);
    expect(decision.denialType, command).toBe("shell_syntax");
    expect(decision.syntaxRule, command).toBe("shell_launcher");
    expect(decision.reason, command).toContain("execute:executable:*");
  });

  it("still lets a launcher run an authorized, non-interpreter command", () => {
    expect(evaluateBashPermission("ls | xargs grep -l foo", bootstrap("grep")).allowed).toBe(true);
    expect(evaluateBashPermission("find . -name '*.ts' -exec grep -l foo {} +", bootstrap("grep")).allowed).toBe(true);
    expect(evaluateBashPermission("ls | xargs wc -l", bootstrap()).allowed).toBe(true);
    expect(evaluateBashPermission("find . -name '*.md'", bootstrap()).allowed).toBe(true);
  });

  it("checks the launched command's own grant", () => {
    const decision = evaluateBashPermission("ls | xargs rm", bootstrap());
    expect(decision.allowed).toBe(false);
    expect(decision.denialType).toBe("executable");
    expect(decision.deniedCapabilities).toEqual([{ relation: "execute", objectType: "executable", objectId: "rm" }]);
    expect(parseBashCommand("find . -exec rm {} \\;").commands?.find((c) => c.name === "rm")).toMatchObject({
      origin: "launcher",
      launcher: "find",
    });
  });

  it("admits launchers only with arbitrary execution authority", () => {
    for (const command of [
      "ls | xargs sh -c id",
      "find . -exec sh -c id \\;",
      "env sh -c id",
      "timeout 5 bash -c id",
    ]) {
      expect(evaluateBashPermission(command, arbitrary).allowed, command).toBe(true);
    }
  });
});

describe.skipIf(!SHELL)("realpath_not_basename_defeats_copied_binary", () => {
  let copiedDir = "";
  let linkedDir = "";

  beforeAll(() => {
    copiedDir = join(scratch, "copied");
    linkedDir = join(scratch, "linked");
    mkdirSync(copiedDir, { recursive: true });
    mkdirSync(linkedDir, { recursive: true });
    for (const name of ["git", "ravi", "rg"]) {
      copyFileSync(SHELL!, join(copiedDir, name));
      chmodSync(join(copiedDir, name), 0o755);
      symlinkSync(SHELL!, join(linkedDir, name));
    }
  });

  it("denies a shell copied under an authorized name outside trusted directories", () => {
    for (const command of [`${copiedDir}/git -c id`, `${copiedDir}/git status`, `${copiedDir}/rg foo`]) {
      const decision = evaluateBashPermission(command, bootstrap());
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("untrusted_executable_path");
    }
  });

  it("denies a copied shell named after the always-allowed ravi CLI", () => {
    const decision = evaluateBashPermission(`${copiedDir}/ravi -c id`, named());
    expect(decision.allowed).toBe(false);
    expect(decision.syntaxRule).toBe("untrusted_executable_path");
  });

  it("denies a symlink whose real path is a shell, even inside trusted directories", () => {
    const decision = evaluateBashPermission(`${linkedDir}/git -c id`, bootstrap());
    expect(decision.allowed).toBe(false);
    expect(decision.syntaxRule).toBe("indirect_execution");
    expect(decision.reason).toContain("resolves to the shell");
  });

  it("denies the copy-then-run form, whose binary does not exist yet at check time", () => {
    const decision = evaluateBashPermission("cp /bin/sh /tmp/ravi-p/git && /tmp/ravi-p/git -c id", bootstrap("cp"));
    expect(decision.allowed).toBe(false);
    expect(decision.syntaxRule).toBe("untrusted_executable_path");
  });

  it("denies relative executables and cwd-relative PATH entries", () => {
    expect(evaluateBashPermission("./copied/git status", bootstrap()).syntaxRule).toBe("untrusted_executable_path");
    expect(evaluateBashPermission("cd copied && ./git status", bootstrap()).syntaxRule).toBe(
      "untrusted_executable_path",
    );
    expect(checkExecutablePath("git", { pathEnv: `copied:/usr/bin:/bin`, cwd: scratch })).toMatchObject({
      ok: false,
      rule: "untrusted_executable_path",
    });
  });

  it("denies a bare name that PATH resolves to a disguised shell", () => {
    expect(checkExecutablePath("git", { pathEnv: `${linkedDir}:/usr/bin:/bin` })).toMatchObject({
      ok: false,
      rule: "indirect_execution",
    });
  });

  it("denies changing PATH so a bare name resolves elsewhere", () => {
    for (const command of [
      `PATH=${copiedDir}:/usr/bin git status`,
      `export PATH=${copiedDir}:/usr/bin; git status`,
      `env PATH=${copiedDir} git status`,
      `for PATH in ${copiedDir}; do git status; done`,
      "LD_PRELOAD=/tmp/x.so ls",
      "DYLD_INSERT_LIBRARIES=/tmp/x.dylib ls",
      "GIT_PAGER='sh -c id' git log",
    ]) {
      const decision = evaluateBashPermission(command, bootstrap("env"));
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("execution_override");
    }
  });

  it("keeps real binaries in trusted directories working", () => {
    for (const path of ["/usr/bin/git", "/bin/ls", "/usr/bin/sort"]) {
      if (!existsSync(path)) continue;
      expect(evaluateBashPermission(`${path} --version`, bootstrap()).allowed, path).toBe(true);
    }
    expect(evaluateBashPermission("git status", bootstrap()).allowed).toBe(true);
  });
});

describe("heredoc_quoted_body_is_not_commands", () => {
  const body = "$(sh -c id)\n`sh -c id`\nsh -c id\nRAVI_AGENT_ID=main\n";

  it.each([
    `cat <<'EOF'\n${body}EOF`,
    `cat <<"EOF"\n${body}EOF`,
    `cat <<\\EOF\n${body}EOF`,
    `cat <<-'EOF'\n\t${body.replace(/\n/g, "\n\t")}EOF`,
    `cat > notes.md <<'EOF'\n${body}EOF`,
  ])("treats a quoted body as data: %j", (command) => {
    const parsed = parseBashCommand(command);
    expect(parsed.success).toBe(true);
    expect(parsed.executables).toEqual(["cat"]);
    const decision = evaluateBashPermission(command, withWrite(named("cat")));
    expect(decision.allowed, decision.reason).toBe(true);
  });

  it("analyzes the substitutions of an unquoted body as commands", () => {
    const parsed = parseBashCommand("cat <<EOF\nhello $(date) and `id`\nEOF");
    expect(parsed.commands?.map((c) => [c.name, c.origin])).toEqual([
      ["cat", "segment"],
      ["date", "heredoc"],
      ["id", "heredoc"],
    ]);
    const decision = evaluateBashPermission("cat <<EOF\n$(sh -c id)\nEOF", named("cat"));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("sh");
  });

  it("keeps commands after the body visible", () => {
    expect(parseBashCommand("cat <<'EOF'\nliteral\nEOF\nsh -c id").executables).toEqual(["cat", "sh"]);
  });
});

describe("substitution_and_redirect_allowed_when_command_authorized", () => {
  const ctx = withWrite(named("printf", "date", "echo", "git", "ls", "sort", "diff", "cat", "wc"));

  it.each([
    'printf "$(date)"',
    "printf '%s' $(date)",
    "printf '%s' `date`",
    "echo $(git rev-parse HEAD)",
    'echo "branch: $(git branch --show-current)"',
    "ls | sort > out.txt",
    "ls | sort | wc -l > count.txt",
    "diff <(sort a.txt) <(sort b.txt)",
    "echo $((1 + 2))",
    "cat > notes.md <<'EOF'\nhello\nEOF",
    "ls\nsort a.txt > sorted.txt",
  ])("%s", (command) => {
    const decision = evaluateBashPermission(command, ctx);
    expect(decision.allowed, decision.reason).toBe(true);
  });

  it("names the unauthorized command inside a substitution, as an approvable executable grant", () => {
    const decision = evaluateBashPermission('printf "$(whoami)"', ctx);
    expect(decision.allowed).toBe(false);
    expect(decision.denialType).toBe("executable");
    expect(decision.deniedCapabilities).toEqual([
      { relation: "execute", objectType: "executable", objectId: "whoami" },
    ]);
  });

  it("still requires Write for redirects in pipelines and inside substitutions", () => {
    const readOnly = named("printf", "date", "echo", "ls", "sort");
    for (const command of ["ls | sort > out.txt", "echo $(ls > out.txt)", "ls\nsort a > b"]) {
      const decision = evaluateBashPermission(command, readOnly);
      expect(decision.allowed, command).toBe(false);
      expect(decision.deniedCapabilities, command).toEqual([
        { relation: "use", objectType: "tool", objectId: "Write" },
      ]);
    }
  });
});

describe("unknown_parse_fails_closed_with_named_error", () => {
  it.each([
    "echo $(case x in a) sh -c id;; esac)",
    '"$CMD" arg',
    "$(echo rm) -rf x",
    "xargs -I{} {} < list",
    "find . -exec {} \\;",
    "env -S 'sh -c id'",
    "echo $'x'",
    "cat <<EOF\nno terminator",
    'echo "unterminated',
    "echo $(unterminated",
    "xargs --frobnicate sh",
    "timeout",
  ])("%j", (command) => {
    const parsed = parseBashCommand(command);
    expect(parsed.success, command).toBe(false);
    const decision = evaluateBashPermission(command, bootstrap("echo", "env", "timeout"));
    expect(decision.allowed, command).toBe(false);
    expect(decision.denialType, command).toBe("shell_syntax");
    expect(decision.syntaxRule, command).toBe("unknown_parse");
    expect(decision.reason, command).toContain("unknown_parse");
    expect(decision.reason, command).not.toContain("Permission denied");
  });

  it("reports unknown_parse from the analysis entry points", () => {
    expect(parseBashCommand('"$CMD" arg').code).toBe("unknown_parse");
    expect(checkDangerousPatterns("echo $(case x in a) id;; esac)")).toMatchObject({
      safe: false,
      code: "unknown_parse",
    });
  });
});

describe("regressions", () => {
  it("keyword boundaries (#813): commands behind reserved words are still checked", () => {
    expect(evaluateBashPermission("for i in 1 2; do sh -c id; done", arbitrary).allowed).toBe(true);
    expect(evaluateBashPermission("for i in 1 2; do sh -c id; done", bootstrap()).syntaxRule).toBe(
      "indirect_execution",
    );
    expect(parseBashCommand("if true; then curl x; fi").executables).toContain("curl");
    expect(parseBashCommand('"do" x').executables).toEqual(["do"]);
    expect(parseBashCommand("echo $(for i in 1; do sh -c id; done)").executables).toContain("sh");
  });

  it("disguised substitution (#767/#776): quoting, escapes and continuations", () => {
    expect(parseBashCommand("grep '$(id)' file; ba'sh' script").executables).toEqual(["grep", "bash"]);
    expect(parseBashCommand('echo "\\$(id) \\`id\\`"').executables).toEqual(["echo"]);
    expect(parseBashCommand('printf "%s" "$(printf "$(sh -c id)")"').executables).toContain("sh");
    expect(parseBashCommand("echo $\\\n(sh -c id)").executables).toContain("sh");
    expect(parseBashCommand('echo "$\\\n\\\n(sh -c id)"').executables).toContain("sh");
    expect(parseBashCommand("echo x#$(sh -c id)").executables).toContain("sh");
    expect(parseBashCommand('echo ""#`sh -c id`').executables).toContain("sh");
    expect(parseBashCommand("echo ok # $(sh -c id)\npwd").executables).toEqual(["echo", "pwd"]);
    expect(parseBashCommand("echo 'it'\\''s $(id)'").executables).toEqual(["echo"]);
    for (const command of ['echo "$(sh -c id)"', "cat <(sh -c id)", "tee >(sh -c id)", "echo `sh -c id`"]) {
      expect(evaluateBashPermission(command, named("echo", "cat", "tee")).syntaxRule, command).toBe(
        "indirect_execution",
      );
    }
  });

  it("an assignment with a quoted value does not hide the command after it", () => {
    for (const command of ['X="1" sh -c id', "X='a b' bash -c id", 'X="$(date)" zsh -c id']) {
      expect(parseBashCommand(command).executables, command).toContain(command.split(" ").at(-3)!);
      expect(evaluateBashPermission(command, bootstrap("date")).allowed, command).toBe(false);
    }
    expect(parseBashCommand('"X=1" ls').executables).toEqual(["X=1"]);
  });

  it("env spoofing: RAVI_* overrides are refused in substitutions, not in quoted here-doc data", () => {
    const ctx = named("echo", "cat", "env");
    expect(evaluateBashPermission("echo $(RAVI_AGENT_ID=main ravi sessions list)", ctx).denialType).toBe(
      "env_spoofing",
    );
    expect(evaluateBashPermission("cat <<EOF\n$(RAVI_AGENT_ID=main ravi sessions list)\nEOF", ctx).denialType).toBe(
      "env_spoofing",
    );
    expect(evaluateBashPermission("env -u RAVI_CONTEXT_KEY ravi sessions list", ctx).denialType).toBe("env_spoofing");
    expect(evaluateBashPermission("cat <<'EOF'\nRAVI_AGENT_ID=main\nEOF", ctx).allowed).toBe(true);
  });

  it("inline interpreter code stays refused, including bun -e", () => {
    for (const command of ["bun -e 'console.log(1)'", "bun --print 1", "python3.11 -c 'print(1)'"]) {
      const decision = evaluateBashPermission(command, bootstrap("python3.11"));
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("unparseable_command");
    }
    expect(evaluateBashPermission("bun test src/bash/", bootstrap()).allowed).toBe(true);
  });

  it("git options that run a program need arbitrary execution", () => {
    for (const command of [
      "git -c core.pager='sh -c id' log",
      "git -c alias.x='!sh -c id' x",
      "git -c core.sshCommand=id fetch",
      "git --config-env=core.pager=X log",
      "git rebase -x 'sh -c id' HEAD~1",
      "git bisect run sh -c id",
      "git submodule foreach 'sh -c id'",
      "git difftool --extcmd=id",
      "git fetch --upload-pack='sh -c id' origin",
    ]) {
      const decision = evaluateBashPermission(command, bootstrap());
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("execution_override");
      expect(evaluateBashPermission(command, arbitrary).allowed, command).toBe(true);
    }
    for (const command of ["git -c color.ui=always log", "git -C . status", "git log --oneline -5", "git rebase dev"]) {
      expect(evaluateBashPermission(command, bootstrap()).allowed, command).toBe(true);
    }
  });
});

// PR #846 review (Devin job e4cdea1d): code the command line hands to an
// interpreter on stdin or as a file is inline code, like `python3 -c`.
function expectInlineCodeRefusal(command: string, ctx: BashPermissionContext): void {
  const decision = evaluateBashPermission(command, ctx);
  expect(decision.allowed, command).toBe(false);
  expect(decision.denialType, command).toBe("shell_syntax");
  expect(decision.reason, command).toContain("inline code");
}

describe("interpreter_heredoc_requires_inline_code_grant", () => {
  it.each([
    ["python3 <<'EOF'\nimport os\nos.system('id')\nEOF", ["python3"]],
    ["python3 <<EOF\nimport os\nEOF", ["python3"]],
    ["python3 <<-EOF\n\timport os\n\tEOF", ["python3"]],
    ["python3 - <<'EOF'\nimport os\nEOF", ["python3"]],
    ["python3 script.py <<'EOF'\nimport os\nEOF", ["python3"]],
    ["python3 /dev/fd/3 3<<'EOF'\nimport os\nEOF", ["python3"]],
    ["<<'EOF' python3\nimport os\nEOF", ["python3"]],
    ["python3.11 <<'EOF'\nimport os\nEOF", ["python3.11"]],
    ["node <<'EOF'\nrequire('child_process')\nEOF", ["node"]],
    ["bun <<'EOF'\nBun.spawn(['id'])\nEOF", ["bun"]],
    ["ruby <<'EOF'\nsystem('id')\nEOF", ["ruby"]],
    ["perl <<'EOF'\nsystem('id')\nEOF", ["perl"]],
    ["awk -f - <<'EOF'\nBEGIN { system(\"id\") }\nEOF", ["awk"]],
    ["echo $(python3 <<'EOF'\nimport os\nEOF\n)", ["python3", "echo"]],
    // Stdin a compound command or function passes down reaches the interpreter inside.
    ["{ cat; python3; } <<'EOF'\nimport os\nEOF", ["python3", "cat"]],
    ["(python3; cat) <<'EOF'\nimport os\nEOF", ["python3", "cat"]],
    ["while read -r l; do python3; done <<'EOF'\nimport os\nEOF", ["python3"]],
    ["cat() { python3; }; cat <<'EOF'\nimport os\nEOF", ["python3", "cat"]],
    ["printf 'import os' | (cat; python3)", ["python3", "cat", "printf"]],
    ["python3 <(printf 'import os')", ["python3", "printf"]],
    ["python3 < <(printf 'import os')", ["python3", "printf"]],
  ] as Array<[string, string[]]>)("%s", (command, grants) => {
    expectInlineCodeRefusal(command, named(...grants));
    expect(parseBashCommand(command).code, command).toBe("inline_code");
    expect(evaluateBashPermission(command, arbitrary).allowed, command).toBe(true);
  });

  it("shells fed a here-document stay refused", () => {
    for (const command of ["sh <<'EOF'\nid\nEOF", "bash -s <<'EOF'\nid\nEOF"]) {
      expect(evaluateBashPermission(command, named("sh", "bash")).allowed, command).toBe(false);
      expect(evaluateBashPermission(command, arbitrary).allowed, command).toBe(true);
    }
  });
});

describe("interpreter_here_string_requires_inline_code_grant", () => {
  it.each([
    ["python3 <<<'import os'", ["python3"]],
    ['python3 <<< "import os"', ["python3"]],
    ["<<<'import os' python3", ["python3"]],
    ["python3 - <<<'import os'", ["python3"]],
    ["node <<<'process.exit(0)'", ["node"]],
    ["bun <<<'console.log(1)'", ["bun"]],
    ["env python3 <<<'import os'", ["python3", "env"]],
  ] as Array<[string, string[]]>)("%s", (command, grants) => {
    const decision = evaluateBashPermission(command, named(...grants));
    expect(decision.allowed, command).toBe(false);
    expect(decision.denialType, command).toBe("shell_syntax");
    expect(evaluateBashPermission(command, arbitrary).allowed, command).toBe(true);
  });

  it("piping code into an interpreter that reads stdin is refused", () => {
    for (const command of [
      "printf 'import os' | python3 -",
      "printf 'import os' | python3 -u",
      "printf 'import os' | python3 /dev/stdin",
      "printf 'x' | node -",
    ]) {
      const decision = evaluateBashPermission(command, named("python3", "node", "printf"));
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("restricted_syntax");
    }
    expect(evaluateBashPermission("printf x | python3 script.py", named("python3", "printf")).allowed).toBe(true);
  });
});

describe("heredoc_to_non_interpreter_still_allowed", () => {
  it.each([
    ["cat <<'EOF'\nimport os\nEOF", ["cat"]],
    ["cat <<EOF\nhello\nEOF", ["cat"]],
    ["cat <<<'import os'", ["cat"]],
    ["grep import <<'EOF'\nimport os\nEOF", ["grep"]],
    ["awk '{ print $1 }' <<'EOF'\na b\nEOF", ["awk"]],
    ["cat <<'EOF'\nimport os\nEOF\npython3 script.py", ["cat", "python3"]],
    ["diff <(printf a) <(printf b)", ["diff", "printf"]],
  ] as Array<[string, string[]]>)("%s", (command, grants) => {
    expect(evaluateBashPermission(command, named(...grants)).allowed, command).toBe(true);
  });
});

describe("subshell_substitution_is_not_arithmetic", () => {
  it("a $(( that does not close as one group runs its commands", () => {
    for (const command of [
      'ls "$((sh -c id);(true))"',
      "ls $((sh -c id);(true))",
      'ls "$( (sh -c id) )"',
      "echo $((echo a);(sh -c id))",
      "cat <<EOF\n$((echo a);(sh -c id))\nEOF",
    ]) {
      const decision = evaluateBashPermission(command, bootstrap());
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("indirect_execution");
    }
    expect(parseBashCommand("ls $((sh -c id);(true))").executables).toEqual(["ls", "sh", "true"]);
  });

  it("arithmetic stays data", () => {
    for (const command of ["ls $((1 + 2))", 'ls "$(( (1 + 2) * 3 ))"', "ls $(( $(date +%s) % 2 ))"]) {
      expect(parseBashCommand(command).success, command).toBe(true);
    }
    expect(parseBashCommand("ls $((1 + 2))").executables).toEqual(["ls"]);
    expect(parseBashCommand("ls $(( $(date +%s) % 2 ))").executables).toEqual(["ls", "date"]);
  });
});

describe("function_body_commands_are_checked", () => {
  it.each(["ls() { sh -c id; }; ls", "ls() { sh -c id; }", "ls () ( sh -c id ); ls", "function ls { sh -c id; }; ls"])(
    "%s",
    (command) => {
      const decision = evaluateBashPermission(command, bootstrap());
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("indirect_execution");
    },
  );
});

describe("find_predicate_operands_are_not_actions", () => {
  it("an operand that spells an action is a pattern", () => {
    for (const command of [
      "find . -maxdepth 0 -name '-exec'",
      "find . -path '-ok' -o -name x",
      "find . -iname -execdir -print",
      "find . -newermt -okdir",
    ]) {
      const parsed = parseBashCommand(command);
      expect(parsed.success, command).toBe(true);
      expect(parsed.executables, command).toEqual(["find"]);
      expect(evaluateBashPermission(command, bootstrap()).allowed, command).toBe(true);
    }
  });

  it("a real action after a predicate is still a payload", () => {
    expect(parseBashCommand("find . -name '-exec' -exec grep -l x {} +").executables).toEqual(["find", "grep"]);
    const decision = evaluateBashPermission("find . -name x -exec sh -c id \\;", bootstrap());
    expect(decision.syntaxRule).toBe("shell_launcher");
  });

  it("a dynamic word could expand to an action and fails closed", () => {
    for (const command of [
      'X="-exec sh -c id ;"; find . $X',
      "find . -name $X",
      "find . -name x -exec grep $X {} +",
      "find . *",
    ]) {
      const decision = evaluateBashPermission(command, bootstrap("grep"));
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("unknown_parse");
    }
  });
});

// Review of #846 at 4258954d (CodeRabbit 4590852306): `git config` stores the
// same keys `git -c` would set, and later git commands run them.
describe("git_config_write_needs_execution_authority", () => {
  it("refuses storing a key that makes git run a program", () => {
    for (const command of [
      "git config core.fsmonitor 'sh -c id'",
      "git config alias.x '!sh -c id'",
      "git config --global core.pager id",
      "git config --add alias.y '!id'",
      "git config set core.pager id",
      "git -C . config core.hooksPath /tmp/hooks",
      "git config include.path /tmp/evil.config",
      "git config -e",
      "git config --rename-section foo alias",
      "git config $KEY id",
    ]) {
      const decision = evaluateBashPermission(command, bootstrap());
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("execution_override");
    }
  });

  it("allows reads, removals and keys that cannot run a program", () => {
    for (const command of [
      "git config --get core.pager",
      "git config --list",
      "git config -l --show-origin",
      "git config core.pager",
      "git config get core.pager",
      "git config --unset core.pager",
      "git config user.name Ravi",
      "git config --global color.ui auto",
    ]) {
      expect(evaluateBashPermission(command, bootstrap()).allowed, command).toBe(true);
    }
  });
});

// CodeRabbit 4590852332: `xargs -I R` replaces R in the command word too.
describe("xargs_replace_string_cannot_rewrite_command_word", () => {
  it("refuses a replace string that occurs in the payload command word", () => {
    for (const command of [
      "printf sh | xargs -I ls ls -c id",
      "printf sh | xargs -Ils ls -c id",
      "printf sh | xargs -ils ls -c id",
      "printf sh | xargs --replace=ls ls -c id",
      "printf sh | xargs -J ls ls -c id",
      "printf sh | xargs -i {} -c id",
    ]) {
      const decision = evaluateBashPermission(command, bootstrap("printf"));
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("unknown_parse");
    }
  });

  it("GNU optional-value options never swallow the payload command", () => {
    for (const command of ["xargs --replace sh -c id", "xargs --eof sh -c id", "xargs --max-lines sh -c id"]) {
      expect(parseBashCommand(command).executables, command).toEqual(["xargs", "sh"]);
      expect(evaluateBashPermission(command, bootstrap()).syntaxRule, command).toBe("shell_launcher");
    }
  });

  it("a replace string in the arguments is still allowed", () => {
    expect(evaluateBashPermission("ls | xargs -I {} ls -l {}", bootstrap()).allowed).toBe(true);
    expect(evaluateBashPermission("ls | xargs --replace=F ls -l F", bootstrap()).allowed).toBe(true);
  });
});

// CodeRabbit 4590852344: xargs appends what it reads to git's argv.
describe("xargs_input_arguments_reach_git_checks", () => {
  it("refuses git whose arguments come from xargs input", () => {
    for (const command of [
      "printf '%s\\n' -c core.pager=id log | xargs git",
      "ls | xargs git add",
      "ls | xargs -I {} git add {}",
      "ls | xargs -n1 git -C",
    ]) {
      const decision = evaluateBashPermission(command, bootstrap("printf"));
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("execution_override");
    }
    expect(parseBashCommand("ls | xargs git add").commands?.find((c) => c.name === "git")?.openArgs).toBe(true);
  });

  it("git with fixed arguments under xargs -I is checked as written", () => {
    expect(evaluateBashPermission("ls | xargs -I {} git status", bootstrap()).allowed).toBe(true);
    expect(evaluateBashPermission("ls | xargs -I {} git -c core.pager=id log", bootstrap()).syntaxRule).toBe(
      "execution_override",
    );
  });
});

// CodeRabbit 4590852353: NAME=VALUE after sudo is the command's environment.
describe("sudo_assignments_reach_execution_override", () => {
  const cases: Array<[string, string]> = [
    ["sudo GIT_PAGER='sh -c id' git log", "GIT_PAGER"],
    ["sudo -u root GIT_PAGER=id git log", "GIT_PAGER"],
    ["sudo -- LD_PRELOAD=/tmp/x.so git status", "LD_PRELOAD"],
    ["doas PATH=/tmp git status", "PATH"],
  ];

  it("the analysis reports the assignments sudo passes to the command", () => {
    for (const [command, name] of cases) {
      const parsed = parseBashCommand(command);
      expect(parsed.success, command).toBe(true);
      expect(parsed.assignments, command).toContain(name);
      expect(parsed.executables.at(-1), command).toBe("git");
    }
    expect(parseBashCommand("sudo LANG=C git status").assignments).toEqual(["LANG"]);
  });

  // Where /usr/bin/sudo is not readable (macOS), the path check refuses first.
  it.skipIf(!checkExecutablePath("sudo").ok)("the policy refuses them as execution_override", () => {
    for (const [command] of cases.filter(([command]) => command.startsWith("sudo"))) {
      const decision = evaluateBashPermission(command, named("sudo", "git"));
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("execution_override");
    }
    expect(evaluateBashPermission("sudo LANG=C git status", named("sudo", "git")).allowed).toBe(true);
  });
});

// CodeRabbit 4590852364: `node -p` and `perl -E` run code like `bun --print`;
// bundled short flags (`perl -ne`) hid the inline flag.
describe("inline_code_print_and_bundled_flags", () => {
  it("refuses print/evaluate flags and inline flags inside a bundle", () => {
    for (const command of [
      "node -p \"require('child_process').execSync('id')\"",
      "node --print 1",
      "node -pe 1",
      "perl -E 'say 1'",
      "perl -ne 'print'",
      "perl -wle 'print 1'",
      "python3 -Ic 'print(1)'",
      "ruby -we 'p 1'",
    ]) {
      const parsed = parseBashCommand(command);
      expect(parsed.success, command).toBe(false);
      expect(parsed.error, command).toContain("inline code");
    }
  });

  it("scripts and long options are not inline code", () => {
    for (const command of [
      "node script.js",
      "perl script.pl",
      "python3 -m http.server",
      "python3 -W error script.py",
      "node --inspect script.js",
    ]) {
      expect(parseBashCommand(command).success, command).toBe(true);
    }
  });
});

// CodeRabbit 4590852367 and the error-cause ratchet: the analyzer's refusal
// keeps its typed cause up to the verdict.
describe("analyzer_refusal_keeps_its_cause", () => {
  it("parseBashCommand returns the typed refusal as cause", () => {
    const parsed = parseBashCommand("echo 'unterminated");
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe("unknown_parse");
    expect(parsed.cause).toBeInstanceOf(ShellAnalysisError);
    expect(parsed.cause?.message).toBe(parsed.error);
  });

  it("ShellAnalysisError forwards a cause", () => {
    const original = new TypeError("boom");
    expect(new ShellAnalysisError("wrapped", { cause: original }).cause).toBe(original);
  });

  it("the dangerous-pattern verdict and the permission decision stay named", () => {
    expect(checkDangerousPatterns("echo 'unterminated")).toMatchObject({ safe: false, code: "unknown_parse" });
    expect(evaluateBashPermission("ls 'unterminated", bootstrap()).syntaxRule).toBe("unknown_parse");
  });
});

// CodeRabbit 4590852269: a relative PATH entry resolves where the shell is,
// which the guard does not know without cwd or after `cd`.
describe("relative_path_entry_fails_closed_without_cwd", () => {
  it.skipIf(!existsSync("/usr/bin/git"))("refuses when cwd is unknown or changes", () => {
    for (const options of [
      { pathEnv: ".:/usr/bin" },
      { pathEnv: ":/usr/bin" },
      { pathEnv: ".:/usr/bin", cwd: scratch, changesDirectory: true },
    ]) {
      const check = checkExecutablePath("git", options);
      expect(check.ok, JSON.stringify(options)).toBe(false);
      if (!check.ok) expect(check.rule).toBe("untrusted_executable_path");
    }
  });

  it.skipIf(!existsSync("/usr/bin/git"))("a known cwd without the binary falls through to a later entry", () => {
    const check = checkExecutablePath("git", { pathEnv: ".:/usr/bin", cwd: scratch });
    expect(check.ok).toBe(true);
  });

  it.skipIf(!existsSync("/usr/bin/git"))("an absolute entry that matches first is unaffected", () => {
    expect(checkExecutablePath("git", { pathEnv: "/usr/bin:." }).ok).toBe(true);
  });
});

// Independent review of b212f7d3, finding 1: a here-document read by a shell
// is code; RAVI_* in it is spoofing, also for a context with execute:executable:*.
describe("heredoc_to_shell_is_checked_for_env_spoofing", () => {
  it("refuses RAVI_* in a body a shell or interpreter reads", () => {
    for (const command of [
      "sh <<'EOF'\nRAVI_AGENT_ID=main ravi sessions list\nEOF",
      "sh <<EOF\nRAVI_AGENT_ID=main ravi sessions list\nEOF",
      "cat <<'EOF' | sh\nRAVI_AGENT_ID=main ravi sessions list\nEOF",
      "bash <<'EOF'\nexport RAVI_CONTEXT_KEY=x\nEOF",
      "bash <<< 'RAVI_AGENT_ID=main ravi sessions list'",
    ]) {
      const decision = evaluateBashPermission(command, arbitrary);
      expect(decision.allowed, command).toBe(false);
      expect(decision.denialType, command).toBe("env_spoofing");
    }
  });

  it("a body only data readers see stays data", () => {
    for (const command of [
      "cat <<'EOF'\nRAVI_AGENT_ID=main is documentation\nEOF",
      "grep RAVI_ <<'EOF'\nRAVI_AGENT_ID=main\nEOF",
    ]) {
      expect(evaluateBashPermission(command, arbitrary).allowed, command).toBe(true);
    }
  });
});

// Finding 2: xargs input becomes the argv of the launcher it runs, so that
// launcher's payload (`-exec sh -c id ;`) cannot be known.
describe("launcher_with_open_args_is_unresolvable", () => {
  it("refuses a launcher that receives xargs input as arguments", () => {
    for (const [command, extra] of [
      ["date '+. -maxdepth 0 -exec sh -c id ;' | xargs find", []],
      ["cat list.txt | xargs find", []],
      ["xargs find < list.txt", []],
      ["xargs -a list.txt find", []],
      ["ls | xargs find", []],
      ["ls | xargs xargs", []],
      ["find . -name list.txt -exec xargs find {} +", []],
      ["xargs find <<< '. -maxdepth 0 -exec sh -c id ;'", []],
      ["cat <<EOF | xargs find\n. -exec sh -c id ;\nEOF", []],
      ["ls | xargs env", ["env"]],
      ["ls | xargs nice", ["nice"]],
      ["ls | xargs command", ["command"]],
    ] as Array<[string, string[]]>) {
      const decision = evaluateBashPermission(command, bootstrap(...extra));
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("unknown_parse");
    }
  });

  it("a non-launcher receiving xargs input is still checked by its own grant", () => {
    expect(evaluateBashPermission("ls | xargs grep x", bootstrap("grep")).allowed).toBe(true);
    expect(evaluateBashPermission("ls | xargs wc -l", bootstrap()).allowed).toBe(true);
    expect(parseBashCommand("ls | xargs wc -l").commands?.find((c) => c.name === "wc")?.openArgs).toBe(true);
  });
});

// Finding 3: `xargs -I R` substitutes input into every initial argument,
// including the command word of a launcher nested in the payload.
describe("xargs_replace_string_cannot_rewrite_nested_launcher", () => {
  it("refuses a replace string that reaches a nested launcher", () => {
    for (const [command, extra] of [
      ["date +sh | xargs -Ils find . -maxdepth 0 -exec ls -c id \\;", []],
      ["date +sh | xargs -I ls xargs ls -c id", []],
      ["echo sh | xargs -Ils env ls -c id", ["env", "echo"]],
      ["ls | xargs -I{} find {} -name x", []],
    ] as Array<[string, string[]]>) {
      const decision = evaluateBashPermission(command, bootstrap(...extra));
      expect(decision.allowed, command).toBe(false);
      expect(decision.syntaxRule, command).toBe("unknown_parse");
    }
  });

  it("a nested launcher whose arguments the replace string does not touch is resolved", () => {
    expect(parseBashCommand("ls | xargs -I{} find . -name x").executables).toEqual(["ls", "xargs", "find"]);
  });
});

// Finding 4: a copy of a shell in a writable PATH directory, under a harmless name.
describe("copied_shell_in_writable_path_dir_is_identified_by_content", () => {
  it.skipIf(!SHELL)("a byte copy of /bin/sh named ls is a shell", () => {
    const dir = join(scratch, "planted-bin");
    mkdirSync(dir, { recursive: true });
    const planted = join(dir, "ls");
    copyFileSync(SHELL!, planted);
    chmodSync(planted, 0o755);
    const check = checkExecutablePath("ls", { pathEnv: `${dir}:/usr/bin:/bin`, cwd: scratch });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.rule).toBe("indirect_execution");
      expect(check.reason).toContain("copy of the shell");
    }
    const byPath = checkExecutablePath(planted, { trustedRoots: [dir], cwd: scratch });
    expect(byPath.ok).toBe(false);
  });

  it("a different file of another size in the same directory is not flagged", () => {
    const dir = join(scratch, "planted-bin-ok");
    mkdirSync(dir, { recursive: true });
    const tool = join(dir, "mytool");
    copyFileSync(join(import.meta.dir, "launchers.ts"), tool);
    chmodSync(tool, 0o755);
    expect(checkExecutablePath("mytool", { pathEnv: `${dir}:/usr/bin`, cwd: scratch }).ok).toBe(true);
  });

  it.skipIf(!existsSync("/usr/bin/git"))("system multi-call shims are not copies (macOS git = python3 = make)", () => {
    expect(checkExecutablePath("git", { pathEnv: "/usr/bin:/bin" }).ok).toBe(true);
  });
});

// Review item 5: forms the dev branch allowed and the workspace requires.
describe("no_op_editor_and_granted_interpreter_behind_launcher", () => {
  it("GIT_EDITOR / GIT_SEQUENCE_EDITOR set to true or : run nothing", () => {
    for (const command of [
      "GIT_EDITOR=true git rebase --continue",
      "GIT_SEQUENCE_EDITOR=: git rebase -i HEAD~2",
      "GIT_EDITOR=':' git commit --amend --no-edit",
    ]) {
      expect(evaluateBashPermission(command, bootstrap()).allowed, command).toBe(true);
    }
    for (const command of [
      "GIT_EDITOR=vim git rebase --continue",
      "GIT_EDITOR=$X git rebase --continue",
      "env GIT_EDITOR=true git rebase --continue",
      "export GIT_EDITOR=true; git rebase --continue",
    ]) {
      expect(evaluateBashPermission(command, bootstrap("env")).syntaxRule, command).toBe("execution_override");
    }
  });

  it("a granted non-shell interpreter behind a granted launcher runs as if direct", () => {
    for (const [command, extra] of [
      ["timeout 120 bun test src/bash/", ["timeout"]],
      ["nohup bun run dev", ["nohup"]],
      ["env FOO=1 bun run x.ts", ["env"]],
      ["timeout -s KILL 5 python3 script.py", ["timeout", "python3"]],
    ] as Array<[string, string[]]>) {
      expect(evaluateBashPermission(command, bootstrap(...extra)).allowed, command).toBe(true);
    }
  });

  it("shells behind launchers, ungranted interpreters and interpreters fed xargs input stay refused", () => {
    expect(evaluateBashPermission("timeout 5 sh -c id", bootstrap("timeout", "sh")).syntaxRule).toBe("shell_launcher");
    expect(evaluateBashPermission("timeout 5 python3 x.py", bootstrap("timeout")).allowed).toBe(false);
    expect(evaluateBashPermission("ls | xargs bun", bootstrap()).allowed).toBe(false);
    expect(parseBashCommand("timeout 5 bun -e 'x'").success).toBe(false);
  });
});

// Review item 9: a defect inside the guard is a refusal, never an exception.
describe("guard_failure_is_a_refusal", () => {
  it("a thrown error while deciding becomes an unknown_parse denial with its cause", () => {
    const poisoned = {
      ...bootstrap(),
      get capabilities(): never {
        throw new TypeError("capability store unavailable");
      },
    } as unknown as BashPermissionContext;
    const decision = evaluateBashPermission("ls", poisoned);
    expect(decision.allowed).toBe(false);
    expect(decision.syntaxRule).toBe("unknown_parse");
    expect(decision.cause).toBeInstanceOf(TypeError);
  });
});

// CodeRabbit 4592919009 on 5cf8bd9f: the pipe check sees the launcher, but the
// interpreter it starts inherits the pipe as stdin and runs it as its program.
describe("piped_stdin_reaches_interpreter_through_launcher", () => {
  const grants = ["printf", "python3", "timeout", "env", "nice", "command", "nohup"];

  it.each([
    ["timeout", "printf 'print(1)' | timeout 5 python3"],
    ["env", "printf 'print(1)' | env python3"],
    ["nice", "printf 'print(1)' | nice python3"],
    ["command", "printf 'print(1)' | command python3"],
    ["nohup", "printf 'print(1)' | nohup python3"],
    ["stdin path", "printf 'print(1)' | timeout 5 python3 -"],
  ])("refuses an interpreter fed piped stdin through %s", (_launcher, command) => {
    const decision = evaluateBashPermission(command, bootstrap(...grants));
    expect(decision.allowed, command).toBe(false);
    const parsed = parseBashCommand(command);
    expect(parsed.success, command).toBe(false);
    expect(parsed.error, command).toContain("piped stdin");
  });

  it.each([
    ["here-string", "env python3 <<< 'print(1)'"],
    ["here-document", "timeout 5 python3 <<'EOF'\nprint(1)\nEOF"],
  ])("a %s through a launcher stays refused", (_form, command) => {
    expect(evaluateBashPermission(command, bootstrap(...grants)).allowed, command).toBe(false);
  });

  it("a named script reads the pipe as data, through a launcher too", () => {
    for (const command of [
      "printf x | timeout 5 python3 script.py",
      "printf x | env python3 script.py",
      "timeout 5 python3 script.py",
      "printf x | timeout 120 bun test src/bash/",
    ]) {
      expect(evaluateBashPermission(command, bootstrap(...grants, "bun")).allowed, command).toBe(true);
    }
  });
});
