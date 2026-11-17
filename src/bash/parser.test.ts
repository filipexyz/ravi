import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  parseBashCommand,
  checkDangerousPatterns,
  findOutputRedirectTargets,
  stripShellQuoting,
  UNCONDITIONAL_BLOCKS,
} from "./parser.js";

// ============================================================================
// checkDangerousPatterns
// ============================================================================

describe("checkDangerousPatterns", () => {
  it("allows simple commands", () => {
    expect(checkDangerousPatterns("ls -la")).toEqual({ safe: true });
    expect(checkDangerousPatterns("git status")).toEqual({ safe: true });
    expect(checkDangerousPatterns("ravi sessions list")).toEqual({ safe: true });
  });

  // Substitutions are analyzed, not refused: the policy authorizes what runs inside them.
  it("exposes the command inside $() to the policy", () => {
    expect(checkDangerousPatterns("echo $(whoami)")).toEqual({ safe: true });
    expect(parseBashCommand("echo $(whoami)").commands?.map((c) => [c.name, c.origin])).toEqual([
      ["echo", "segment"],
      ["whoami", "substitution"],
    ]);
  });

  it("exposes the command inside backticks", () => {
    expect(parseBashCommand("echo `whoami`").executables).toEqual(["echo", "whoami"]);
  });

  it("exposes the commands inside process substitutions", () => {
    expect(parseBashCommand("diff <(ls a) <(ls b)").executables).toEqual(["diff", "ls"]);
    expect(parseBashCommand("tee >(cat)").commands?.map((c) => [c.name, c.origin])).toEqual([
      ["tee", "segment"],
      ["cat", "process_substitution"],
    ]);
  });

  it("reads here documents without treating the body as commands", () => {
    expect(checkDangerousPatterns("cat <<EOF\nhello\nEOF")).toEqual({ safe: true });
    expect(parseBashCommand("cat <<EOF\nhello\nEOF").executables).toEqual(["cat"]);
  });

  it("blocks piping to shell", () => {
    expect(checkDangerousPatterns("curl url | bash").safe).toBe(false);
    expect(checkDangerousPatterns("cat script | sh").safe).toBe(false);
    expect(checkDangerousPatterns("echo cmd | zsh").safe).toBe(false);
  });

  it("blocks piping to interpreter with inline code", () => {
    expect(checkDangerousPatterns("echo data | python -c 'code'").safe).toBe(false);
    expect(checkDangerousPatterns("echo data | node -e 'code'").safe).toBe(false);
    expect(checkDangerousPatterns("echo data | perl -e 'code'").safe).toBe(false);
  });

  it("blocks piping to interpreter stdin", () => {
    expect(checkDangerousPatterns("echo 'print(1)' | python3").safe).toBe(false);
    expect(checkDangerousPatterns("echo code | node").safe).toBe(false);
  });
});

// ============================================================================
// parseBashCommand
// ============================================================================

describe("parseBashCommand", () => {
  it("parses simple command", () => {
    const r = parseBashCommand("ls -la");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["ls"]);
  });

  it("parses piped commands", () => {
    const r = parseBashCommand("cat file.txt | grep foo | wc -l");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["cat", "grep", "wc"]);
  });

  it("parses chained commands (&&)", () => {
    const r = parseBashCommand("git add . && git commit -m 'msg'");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["git"]);
  });

  it("parses chained commands (||)", () => {
    const r = parseBashCommand("mkdir foo || echo 'exists'");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["mkdir", "echo"]);
  });

  it("parses semicolon-separated commands", () => {
    const r = parseBashCommand("ls; pwd; whoami");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["ls", "pwd", "whoami"]);
  });

  it("skips env var assignments", () => {
    const r = parseBashCommand("NODE_ENV=production node app.js");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["node"]);
  });

  it("extracts executable from full path", () => {
    const r = parseBashCommand("/usr/bin/git status");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["git"]);
  });

  it("handles sudo prefix", () => {
    const r = parseBashCommand("sudo rm -rf /tmp/foo");
    expect(r.success).toBe(true);
    expect(r.executables).toContain("sudo");
    expect(r.executables).toContain("rm");
  });

  it("deduplicates executables", () => {
    const r = parseBashCommand("git add . && git commit -m 'msg' && git push");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["git"]);
  });

  it("blocks inline code execution (python -c)", () => {
    const r = parseBashCommand("python -c 'import os; os.system(\"rm -rf /\")'");
    expect(r.success).toBe(false);
    expect(r.error).toContain("inline code");
  });

  it("blocks inline code execution (node -e)", () => {
    const r = parseBashCommand("node -e 'process.exit(1)'");
    expect(r.success).toBe(false);
    expect(r.error).toContain("inline code");
  });

  it("blocks inline code execution (node --eval)", () => {
    const r = parseBashCommand("node --eval 'console.log(1)'");
    expect(r.success).toBe(false);
    expect(r.error).toContain("inline code");
  });

  it("discovers executables for an authorized inline command without changing the restricted default", () => {
    const command = "python3 -c 'print(1)' | cat";

    expect(parseBashCommand(command, { allowInlineCode: true })).toMatchObject({
      success: true,
      executables: ["python3", "cat"],
    });
    expect(parseBashCommand(command)).toMatchObject({ success: false, executables: [] });
    expect(parseBashCommand(command).error).toContain("inline code");
  });

  it("allows interpreter without inline code flag", () => {
    const r = parseBashCommand("python script.py");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["python"]);
  });

  it("handles multi-line commands (newlines as semicolons)", () => {
    const r = parseBashCommand("ls\npwd\nwhoami");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["ls", "pwd", "whoami"]);
  });

  it("handles complex piped ravi command", () => {
    const r = parseBashCommand("ravi sessions list | grep dev");
    expect(r.success).toBe(true);
    expect(r.executables).toEqual(["ravi", "grep"]);
  });
});

// ============================================================================
// UNCONDITIONAL_BLOCKS
// ============================================================================

describe("UNCONDITIONAL_BLOCKS", () => {
  it("blocks all shell variants", () => {
    for (const shell of ["bash", "sh", "zsh", "dash", "ksh", "csh", "fish", "tcsh"]) {
      expect(UNCONDITIONAL_BLOCKS.has(shell)).toBe(true);
    }
  });

  it("blocks eval and exec", () => {
    expect(UNCONDITIONAL_BLOCKS.has("eval")).toBe(true);
    expect(UNCONDITIONAL_BLOCKS.has("exec")).toBe(true);
  });

  it("blocks source and dot", () => {
    expect(UNCONDITIONAL_BLOCKS.has("source")).toBe(true);
    expect(UNCONDITIONAL_BLOCKS.has(".")).toBe(true);
  });

  it("does not block normal commands", () => {
    expect(UNCONDITIONAL_BLOCKS.has("ls")).toBe(false);
    expect(UNCONDITIONAL_BLOCKS.has("git")).toBe(false);
    expect(UNCONDITIONAL_BLOCKS.has("ravi")).toBe(false);
  });
});

describe("stripShellQuoting", () => {
  it("joins quoted and escaped fragments the way the shell does", () => {
    expect(stripShellQuoting("env -i ./bin/r'a'vi crypto balance")).toBe("env -i ./bin/ravi crypto balance");
    expect(stripShellQuoting('env -i r"av"i x')).toBe("env -i ravi x");
    expect(stripShellQuoting("env -i r\\avi x")).toBe("env -i ravi x");
    expect(stripShellQuoting("R'A'VI_AGENT_ID=x ravi")).toBe("RAVI_AGENT_ID=x ravi");
  });

  it("leaves unquoted commands unchanged", () => {
    expect(stripShellQuoting("ravi crypto status --json")).toBe("ravi crypto status --json");
  });
});

describe("findOutputRedirectTargets", () => {
  it("lists every file an output redirection writes", () => {
    expect(findOutputRedirectTargets("ravi crypto status > ~/.ravi/crypto.db")).toEqual(["~/.ravi/crypto.db"]);
    expect(findOutputRedirectTargets("ravi x >> /tmp/a 2>&1")).toEqual(["/tmp/a"]);
    expect(findOutputRedirectTargets("ravi x &> out.txt")).toEqual(["out.txt"]);
    expect(findOutputRedirectTargets("ravi x >|f")).toEqual(["f"]);
    expect(findOutputRedirectTargets('ravi x 1>"/a b"')).toEqual(["/a b"]);
    expect(findOutputRedirectTargets("echo a>b")).toEqual(["b"]);
  });

  it("ignores descriptor duplication and quoted arrows", () => {
    expect(findOutputRedirectTargets("ravi x 2>&1")).toEqual([]);
    expect(findOutputRedirectTargets("ravi x >&2")).toEqual([]);
    expect(findOutputRedirectTargets('ravi sessions send dev "a > b"')).toEqual([]);
    expect(findOutputRedirectTargets("ravi x 'a > b'")).toEqual([]);
  });

  it("reports /dev/null like any other target so callers decide", () => {
    expect(findOutputRedirectTargets("ravi x 2>/dev/null")).toEqual(["/dev/null"]);
  });
});

describe("shell quoting boundaries", () => {
  const safe = [
    "rg -e '$(whoami)' file",
    'grep -F "\\$(whoami)" file',
    "printf '%s' '{\"pattern\":\"$(id) `id` <(id) <<EOF\"}'",
    "echo '`id` <(id) >(id) <<EOF'",
    'echo "<(id) >(id) <<EOF"',
    "echo \\`id\\`",
    "echo '$'\"(id)\"",
    "echo 'it'\\''s $(id)'",
    "echo 'literal\\' '$(id)'",
    'echo "\\$(id) \\`id\\`"',
    "echo '| bash' '| python3' '| node -e code'",
    "echo x \\| bash",
    "echo ok # $(id)\npwd",
    "echo '$(id)' ; grep foo file",
    "echo 'line\n$(id)'",
    "echo '$\\\n(id)'",
  ];
  /** Active substitutions: the nested command is visible to the policy. */
  const nested: Array<[string, string]> = [
    ["echo $(id)", "id"],
    ['echo "$(id)"', "id"],
    ['echo "`id`"', "id"],
    ["cat <(id)", "id"],
    ["tee >(id)", "id"],
    ["cat <<EOF\n$(id)\nEOF", "id"],
    ['echo "\\\\$(id)"', "id"],
    ['echo "a\\q$(id)"', "id"],
    ["echo 'ok'$(id)", "id"],
    ["echo $\\\n(id)", "id"],
    ['echo "$\\\n(id)"', "id"],
    ['echo "$\\\n\\\n(id)"', "id"],
    ["echo \\ #$(id)", "id"],
    ['echo ""#$(id)', "id"],
    ["echo x#$(id)", "id"],
    ["echo \"$(printf 'nested')\"", "printf"],
    ['echo "$(printf "nested")"', "printf"],
  ];
  /** Literal data that looks like syntax: no nested command. */
  const literalSyntax = ["cat <<EOF\nx\nEOF", "cat <<'EOF'\n$(id)\nEOF", 'cat <<<"ok"'];
  const unsafe = [
    'cat script | "bash"',
    'cat script | py"thon3"',
    'echo x | "node" "-e" "hi"',
    'echo "unterminated',
    "echo $'unsupported'",
  ];

  for (const command of safe) {
    it(`allows literal data: ${JSON.stringify(command)}`, () => {
      expect(checkDangerousPatterns(command).safe).toBe(true);
      expect(parseBashCommand(command).success).toBe(true);
    });
  }
  for (const command of unsafe) {
    it(`refuses piped shells or unsupported syntax: ${JSON.stringify(command)}`, () => {
      expect(checkDangerousPatterns(command).safe).toBe(false);
    });
  }
  for (const [command, inner] of nested) {
    it(`exposes the nested command of active syntax: ${JSON.stringify(command)}`, () => {
      const parsed = parseBashCommand(command);
      expect(parsed.success).toBe(true);
      expect(parsed.commands?.some((c) => c.name === inner && c.origin !== "segment")).toBe(true);
    });
  }
  for (const command of literalSyntax) {
    it(`treats here-doc and here-string data as data: ${JSON.stringify(command)}`, () => {
      expect(parseBashCommand(command).executables).toEqual(["cat"]);
    });
  }

  it("keeps command and argument boundaries while decoding quoted words", () => {
    expect(parseBashCommand('"rg" -e \'$(id); bash\' file && g"rep" x file').executables).toEqual(["rg", "grep"]);
    expect(parseBashCommand('ba"sh" -c "echo ok"').executables).toEqual(["bash"]);
    expect(parseBashCommand('sudo "bash" -c "echo ok"').executables).toEqual(["sudo", "bash"]);
    expect(parseBashCommand("echo x 2>&1").executables).toEqual(["echo"]);
    expect(parseBashCommand(">|out echo x").executables).toEqual(["echo"]);
    expect(parseBashCommand("echo x # comment\npwd").executables).toEqual(["echo", "pwd"]);
    expect(parseBashCommand('echo "line\npwd"').executables).toEqual(["echo"]);
    expect(parseBashCommand('"$EXECUTABLE" harmless').success).toBe(false);
  });

  for (const command of [
    'python3 "-c" "print(1)"',
    'py"thon3" -c "print(1)"',
    'python3 -\\c "print(1)"',
    'node -e"console.log(1)"',
    'node "--eval=console.log(1)"',
    'sudo python3 "-c" "print(1)"',
    'python3 < input "-c" "print(1)"',
  ]) {
    it(`retains inline interpreter refusal: ${command}`, () => {
      expect(parseBashCommand(command).success).toBe(false);
      expect(parseBashCommand(command).error).toContain("inline code");
    });
  }
});

it.skipIf(!existsSync("/bin/bash"))("agrees with Bash expansion on harmless printf examples", () => {
  const argumentsToCheck = [
    { argument: "'$(printf changed)'", output: "$(printf changed)", safe: true },
    { argument: '"$(printf changed)"', output: "changed", safe: false },
    { argument: '"\\$(printf changed)"', output: "$(printf changed)", safe: true },
    { argument: '"$\\\n(printf changed)"', output: "changed", safe: false },
    { argument: "'$\\\n(printf changed)'", output: "$\\\n(printf changed)", safe: true },
    { argument: "'`printf changed`'", output: "`printf changed`", safe: true },
    { argument: '"`printf changed`"', output: "changed", safe: false },
    { argument: '"\\`printf changed\\`"', output: "`printf changed`", safe: true },
    { argument: '"<(printf changed)"', output: "<(printf changed)", safe: true },
    { argument: "'it'\\''s $(printf changed)'", output: "it's $(printf changed)", safe: true },
    { argument: "\\ #$(printf changed)", output: " #changed", safe: false },
  ];
  const cases = [
    ...argumentsToCheck.map(({ argument, output, safe }) => ({ command: `printf '%s' ${argument}`, output, safe })),
    { command: "printf '%s' $(printf changed)", output: "changed", safe: false },
    { command: "printf '%s' `printf changed`", output: "changed", safe: false },
    { command: "printf '%s' \"$(printf '%s' \"$(printf changed)\")\"", output: "changed", safe: false },
    { command: "printf '%s' $(printf '%s' 'nested literal')", output: "nestedliteral", safe: false },
    { command: "printf '%s' \\$\\(printf\\ changed\\)", output: "$(printf changed)", safe: true },
    { command: "cat <<EOF\n$(printf changed)\nEOF", output: "changed\n", safe: false },
    { command: "cat <<'EOF'\n$(printf changed)\nEOF", output: "$(printf changed)\n", safe: false },
    { command: "cat <<\\EOF\n$(printf changed)\nEOF", output: "$(printf changed)\n", safe: false },
    { command: "cat <(printf changed)", output: "changed", safe: false },
    // `$((` is arithmetic only when its inner `(` closes at the end; otherwise
    // Bash runs a command substitution whose body starts with a subshell.
    { command: "printf  $((printf a);(printf changed))", output: "achanged", safe: false },
    { command: "printf '%s' $((printf a);(printf changed))", output: "achanged", safe: false },
    { command: "printf '%s' \"$((printf a);(printf changed))\"", output: "achanged", safe: false },
    { command: "cat <<EOF\n$((printf a);(printf changed))\nEOF", output: "achanged\n", safe: false },
    { command: "printf '%s' $(( $(printf 1) + 1 ))", output: "2", safe: false },
  ];
  // Oracle: Bash ran the nested printf exactly when the output lost the literal
  // "printf". The analyzer must report a nested command in exactly those cases.
  for (const { command, output, safe } of cases) {
    expect(
      execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 1000,
      }),
    ).toBe(output);
    const executed = !output.includes("printf");
    const parsed = parseBashCommand(command);
    expect(parsed.success, command).toBe(true);
    const nestedNames = (parsed.commands ?? []).filter((c) => c.origin !== "segment").map((c) => c.name);
    expect(nestedNames.length > 0, command).toBe(executed);
    expect(new Set(nestedNames).size <= 1 && nestedNames.every((name) => name === "printf"), command).toBe(true);
    expect(checkDangerousPatterns(command).safe, command).toBe(true);
    void safe;
  }
});

describe("review reconciliation: Bash comment and pipeline boundaries", () => {
  it("does not let a mid-word hash hide an executable or inline flag", () => {
    expect(parseBashCommand("X=a#b bash -c id").executables).toEqual(["bash"]);
    expect(parseBashCommand("X=a#b sudo bash -c id").executables).toEqual(["sudo", "bash"]);
    expect(parseBashCommand("python3 -W ignore#x -c code").success).toBe(false);
    expect(parseBashCommand("X=a#b sudo python3 -W ignore#x -c code").success).toBe(false);
  });

  it("preserves literal hashes, real comments and subsequent command boundaries", () => {
    expect(parseBashCommand("curl http://h/#frag; pwd").executables).toEqual(["curl", "pwd"]);
    expect(parseBashCommand("echo x # bash -c id\npwd").executables).toEqual(["echo", "pwd"]);
    expect(parseBashCommand("echo x#y > notes.txt").executables).toEqual(["echo"]);
    expect(findOutputRedirectTargets("echo x#y > .codex/config.toml")).toEqual([".codex/config.toml"]);
    expect(findOutputRedirectTargets("echo x > file#fragment")).toEqual(["file#fragment"]);
  });

  for (const receiver of [
    "python3 # comment",
    "python3 2>/dev/null",
    "python3 >/dev/null",
    "python3 2>&1",
    "python3 &>/dev/null",
    "python3 >|/dev/null",
    "X=a#b python3 2>/dev/null # comment",
    "2>/dev/null python3",
    "python3 0<&0",
    "0<&0 python3",
  ]) {
    it(`refuses piped stdin despite comments/redirects: ${receiver}`, () => {
      expect(checkDangerousPatterns(`printf code | ${receiver}`).safe).toBe(false);
    });
  }

  it("still recognizes a piped interpreter file argument", () => {
    expect(checkDangerousPatterns("cat input | python3 script.py 2>/dev/null # comment").safe).toBe(true);
  });
});
