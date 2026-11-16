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
    ["timeout -s KILL 5 python3 script.py", ["timeout", "python3"]],
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
