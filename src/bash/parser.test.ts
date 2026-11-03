import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBashCommand,
  checkDangerousPatterns,
  findOutputRedirectTargets,
  stripShellQuoting,
  UNCONDITIONAL_BLOCKS,
  INTERPRETERS,
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

  it("blocks command substitution $()", () => {
    const r = checkDangerousPatterns("echo $(whoami)");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("command substitution");
  });

  it("blocks backtick substitution", () => {
    const r = checkDangerousPatterns("echo `whoami`");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("backtick");
  });

  it("blocks process substitution <()", () => {
    const r = checkDangerousPatterns("diff <(ls a) <(ls b)");
    expect(r.safe).toBe(false);
  });

  it("blocks process substitution >()", () => {
    const r = checkDangerousPatterns("tee >(cat)");
    expect(r.safe).toBe(false);
  });

  it("blocks here documents", () => {
    const r = checkDangerousPatterns("cat <<EOF\nhello\nEOF");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("here document");
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
  const unsafe = [
    "echo $(id)",
    'echo "$(id)"',
    'echo "`id`"',
    "cat <(id)",
    "tee >(id)",
    "cat <<EOF\nx\nEOF",
    "cat <<'EOF'\n$(id)\nEOF",
    'cat <<<"ok"',
    'echo "\\\\$(id)"',
    'echo "a\\q$(id)"',
    "echo 'ok'$(id)",
    "echo $\\\n(id)",
    'echo "$\\\n(id)"',
    'echo "$\\\n\\\n(id)"',
    "echo \\ #$(id)",
    'echo ""#$(id)',
    "echo x#$(id)",
    "echo \"$(printf 'nested')\"",
    'echo "$(printf "nested")"',
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
    it(`refuses active or unsupported syntax: ${JSON.stringify(command)}`, () => {
      expect(checkDangerousPatterns(command).safe).toBe(false);
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
  ];
  for (const { command, output, safe } of cases) {
    expect(
      execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 1000,
      }),
    ).toBe(output);
    expect(checkDangerousPatterns(command).safe).toBe(safe);
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

  it("denies a file script as a pipe receiver despite redirects and comments", () => {
    expect(checkDangerousPatterns("cat input | python3 script.py 2>/dev/null # comment")).toEqual({
      safe: false,
      reason: "piping to an interpreter is not allowed",
    });
  });
});

describe("piped interpreters are denied regardless of script arguments", () => {
  const stdinReceivers = [
    "python3 -u",
    "python3 -",
    "python3 -I -",
    "node --no-warnings",
    "node --input-type=module -",
    "perl -w",
    "ruby -",
    "php -d x=1",
    "python3 - script.py",
    "python3 -- - script.py",
    "python3 -W ignore",
    "python3 -X dev",
    "php -d script.php",
    "python3 --unknown script.py",
    "python3 -i script.py",
    "python3 -m module",
    "node --require build.js",
    "python3 $SCRIPT",
    'python3 "$SCRIPT"',
    "python3 *.py",
    "python3 {,-}",
    "python3 ''",
    "python3 /dev/stdin",
    "python3 /dev/./fd/0",
    'py"thon3" "-u"',
    "python3 -\\u",
  ];
  for (const receiver of stdinReceivers) {
    for (const decorated of [
      receiver,
      `${receiver} 2>/dev/null`,
      `FOO=1 ${receiver}`,
      `FOO=1 ${receiver} 2>/dev/null`,
    ]) {
      it(`refuses ${decorated}`, () => {
        const command = `printf code | ${decorated}`;
        expect(checkDangerousPatterns(command).safe).toBe(false);
        expect(parseBashCommand(command).success).toBe(false);
      });
    }
  }
  for (const receiver of [
    "python3 script.py",
    "python3 ./a.py arg",
    "node build.js",
    "node --no-warnings build.js",
    "python3 -u script.py",
    "python3 -W ignore -X dev script.py",
    "php -d x=1 script.php",
    "perl -w script.pl",
    "ruby -w script.rb",
    "python3 -- ./a.py -",
    'python3 "a b.py"',
    "python /abs/path/script.py",
    "python3 /abs/path/script.py",
    "python3 /tmp/a.py arg",
    "node /abs/build.js",
    "perl /abs/script.pl",
    "ruby /abs/script.rb",
    "php /abs/script.php",
  ]) {
    it(`deliberately denies a file-script receiver: ${receiver}`, () => {
      for (const decorated of [
        receiver,
        `${receiver} 2>/dev/null`,
        `FOO=1 ${receiver}`,
        `FOO=1 ${receiver} 2>/dev/null`,
      ]) {
        const command = `printf data | ${decorated}`;
        expect(checkDangerousPatterns(command)).toEqual({
          safe: false,
          reason: "piping to an interpreter is not allowed",
        });
        expect(parseBashCommand(command).success).toBe(false);
      }
    });
  }
});

describe("piped interpreter descriptor aliases and receiver segments", () => {
  for (const path of [
    "/dev/stdin",
    "/dev/stdout",
    "/dev/stderr",
    ...[0, 3, 7, 42, 65535].flatMap((fd) => [
      `/dev/fd/${fd}`,
      `/proc/self/fd/${fd}`,
      `/proc/thread-self/fd/${fd}`,
      `/proc/123/fd/${fd}`,
      `/proc/123/task/456/fd/${fd}`,
    ]),
    "/dev/./fd/3",
    "/proc/self/fd/../fd/7",
  ]) {
    it(`refuses descriptor aliases by shape: ${path}`, () => {
      for (const interpreter of ["python3", "node", "perl", "ruby", "php"]) {
        for (const redirect of ["", " 3<&0", " 7<&0"]) {
          const command = `printf code | ${interpreter} '${path}'${redirect}`;
          expect(checkDangerousPatterns(command).safe).toBe(false);
          expect(parseBashCommand(command).success).toBe(false);
        }
      }
    });
  }

  for (const receiver of [
    "# c\n python3 -u",
    "# c\n\n # another comment\n python3 -u",
    "\n\n python3 -u",
    "# c\n python3 - 2>/dev/null",
    "# c\n node --no-warnings",
    "# c\n bash",
    "# c\n python3 -c 'print(731)'",
  ]) {
    it(`continues checking all receiver segments: ${JSON.stringify(receiver)}`, () => {
      const command = `printf 'print(731)\\n' | ${receiver}`;
      expect(checkDangerousPatterns(command).safe).toBe(false);
      expect(parseBashCommand(command).success).toBe(false);
    });
  }

  it("allows direct scripts but denies script receivers after empty and comment-only segments", () => {
    for (const receiver of [
      "python3 script.py",
      "python3 ./a.py arg",
      "node build.js",
      "node --no-warnings build.js",
    ]) {
      for (const prefix of ["", "printf data | ", "printf data | # c\n\n # another comment\n "]) {
        const command = prefix + receiver;
        expect(checkDangerousPatterns(command).safe).toBe(prefix === "");
        expect(parseBashCommand(command).success).toBe(prefix === "");
      }
    }
  });
});

describe("pipeline receiver scope and directory changes", () => {
  for (const command of [
    "cd /dev && printf 'print(731)\\n' | python3 fd/3 3<&0",
    "cd /dev && printf 'print(731)\\n' | python3 stdin",
    "builtin cd /dev && printf 'print(731)\\n' | python3 fd/3 3<&0",
    "command cd /dev && printf 'print(731)\\n' | python3 stdin",
    "pushd /dev && printf 'print(731)\\n' | python3 stdin",
    "env -C /dev printf 'print(731)\\n' | python3 fd/3",
    "printf data | python3 build.js",
    "printf cd | python3 script.py # cd /dev",
    "printf data |& python3 script.py",
    "cd /tmp && printf data | python3 build.js",
    "printf data | python3 script.py; cd /tmp",
    "'cd' /tmp && printf data | # c\n python3 script.py",
    "printf data | # c\n python3 -u",
    "printf a | tee x | python3 -u",
    "printf a |& python3 -u",
    "printf data | python3 /dev/stdout 1<&0",
    "printf data | python3 /proc/$$/fd/0",
    "printf data | python3 /proc/self/task/1/fd/0",
  ]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(checkDangerousPatterns(command).safe).toBe(false);
      expect(parseBashCommand(command).success).toBe(false);
    });
  }

  for (const command of [
    "python3 build.js",
    "printf data | cat; python3 --version",
    "printf data | cat && python3 script.py",
    "printf data | cat || python3 --version",
    "printf data | cat\n python3 --version",
    "printf data | cat; # c\n python3 -u",
    "printf data | # c\n cat; python3 --version",
    "cd /tmp && printf data | cat; python3 build.js",
  ]) {
    it(`preserves ${JSON.stringify(command)}`, () => {
      expect(checkDangerousPatterns(command).safe).toBe(true);
      expect(parseBashCommand(command).success).toBe(true);
    });
  }

  for (const boundary of [";", "&&", "||"]) {
    it(`does not scan past ${boundary} after an assignment-only receiver`, () => {
      const command = `printf data | FOO=bar ${boundary} python3 --version`;
      expect(checkDangerousPatterns(command).safe).toBe(true);
      expect(parseBashCommand(command).success).toBe(true);
    });
  }
});

describe("direct interpreter descriptor paths and named input", () => {
  for (const command of [
    "python3 /dev/fd/3 3<&0",
    "python3 /dev/fd/4 4<&0",
    "python3 /dev/fd/4 4</tmp/x.py",
    "python3 /dev/stdin",
    "python3 -u /dev/stdout 1<&0",
    "python3 -W ignore -- /dev/./fd/7 7<&0",
    "node --no-warnings /proc/self/fd/0",
    "php -d x=1 /dev/stderr 2<&0",
    "perl -w /dev/fd/99",
    "ruby /proc/123/task/456/fd/7",
  ]) {
    it(`denies a direct descriptor script: ${command}`, () => {
      expect(checkDangerousPatterns(command)).toEqual({
        safe: false,
        reason: "interpreter descriptor arguments are not allowed",
      });
      expect(parseBashCommand(command).success).toBe(false);
    });
  }

  for (const command of [
    "python3 script.py",
    "python3 ./a.py arg",
    "node --no-warnings build.js",
    "python3 /abs/script.py",
    "python3 /abs/s.py < dados.txt",
    "cd /tmp && python3 /abs/s.py < dados.txt",
    "printf data | cat; python3 /abs/s.py < dados.txt",
  ]) {
    it(`preserves direct file execution: ${command}`, () => {
      expect(checkDangerousPatterns(command).safe).toBe(true);
      expect(parseBashCommand(command).success).toBe(true);
    });
  }

  it.skipIf(!existsSync("/dev/stdin"))("denies a pipe to an absolute symlink to stdin", () => {
    const directory = mkdtempSync(join(tmpdir(), "ravi-bash-symlink-test-"));
    try {
      const path = join(directory, "script.py");
      symlinkSync("/dev/stdin", path);
      const command = `printf 'print(731)\\n' | python3 "${path}"`;
      expect(checkDangerousPatterns(command)).toEqual({
        safe: false,
        reason: "piping to an interpreter is not allowed",
      });
      expect(parseBashCommand(command).success).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("interpreter registry, option arity and script-only resolution", () => {
  for (const executable of INTERPRETERS) {
    it(`denies every registered pipe receiver: ${executable}`, () => {
      for (const receiver of [executable, `"${executable}" /abs/script`, `/usr/bin/${executable} /abs/script`]) {
        const command = `printf data | ${receiver}`;
        expect(checkDangerousPatterns(command)).toEqual({
          safe: false,
          reason: "piping to an interpreter is not allowed",
        });
        expect(parseBashCommand(command).success).toBe(false);
      }
    });
  }

  for (const command of [
    "printf 'console.log(731)\\n' | bun run -",
    "python3 --check-hash-based-pycs always /dev/stdin",
    "python3 -X importtime /dev/stdin",
    "node --require helper.js /dev/stdin",
    "node -r helper.js /dev/stdin",
    "nodejs --require helper.js /dev/stdin",
    'python3 --check-hash-based-pycs "$MODE" /dev/stdin',
    'python3 "$SCRIPT_PATH"',
    'python3 "/abs/$SCRIPT_PATH"',
    "python3 *.py",
    "printf data | python3 script.py",
  ]) {
    it(`denies ${JSON.stringify(command)}`, () => {
      expect(checkDangerousPatterns(command).safe).toBe(false);
      expect(parseBashCommand(command).success).toBe(false);
    });
  }

  for (const command of [
    'python3 script.py "$INPUT"',
    "node build.js *.json",
    'python3 --check-hash-based-pycs always script.py "$INPUT"',
    "node --require helper.js build.js *.json",
    "python3 /abs/s.py < dados.txt",
  ]) {
    it(`allows later argument expansion: ${JSON.stringify(command)}`, () => {
      expect(checkDangerousPatterns(command).safe).toBe(true);
      expect(parseBashCommand(command).success).toBe(true);
    });
  }
});

describe("descriptor-shaped arguments are denied even when used as data", () => {
  for (const command of [
    "perl -I /tmp /dev/stdin",
    "node --conditions testing /dev/stdin",
    "bun run /dev/stdin",
    "python3 --check-hash-based-pycs always /dev/stdin",
    "bun --bun run /dev/stdin",
    "deno run /dev/stdin",
    "python3 script.py /dev/stdin",
    'python3 script.py "$INPUT" /dev/stdin',
    "python3 -W /dev/stdin script.py",
    "python3 script.py /dev/fd/4",
    "python3 script.py /proc/self/fd/9",
    "node build.js /dev/stdout",
    "node build.js /dev/stderr",
  ]) {
    it(`deliberately denies any descriptor argument: ${command}`, () => {
      expect(checkDangerousPatterns(command)).toEqual({
        safe: false,
        reason: "interpreter descriptor arguments are not allowed",
      });
      expect(parseBashCommand(command).success).toBe(false);
    });
  }
});

describe("versioned interpreter basenames", () => {
  for (const receiver of [
    "python3.12 -",
    "python3.11 -",
    "python3.11 /dev/stdin",
    "php8.2 -r 'echo 1;'",
    "perl5.36 -e 'print 1'",
    "lua5.4 -",
    "ruby3.2 -",
    "node20 /abs/build.js",
    "node20 -e 1",
    '"/usr/bin/python3.12" /abs/script.py',
  ]) {
    it(`denies a pipe into ${receiver}`, () => {
      const command = `printf 'print(1)\\n' | ${receiver}`;
      expect(checkDangerousPatterns(command)).toEqual({
        safe: false,
        reason: "piping to an interpreter is not allowed",
      });
      expect(parseBashCommand(command).success).toBe(false);
    });
  }

  for (const command of [
    "python3.11 /dev/stdin",
    "python3.12 --check-hash-based-pycs always /dev/stdin",
    "node20 --require helper.js /dev/stdin",
    "php8.2 -r 'echo 1;'",
    "perl5.36 -e 'print 1'",
  ]) {
    it(`applies direct interpreter rules to ${command}`, () => {
      expect(parseBashCommand(command).success).toBe(false);
    });
  }

  for (const command of [
    "nodejs build.js",
    "Rscript script.R",
    "ts-node script.ts",
    "python3.12 script.py",
    'python3.12 script.py "$INPUT"',
    "printf data | Python3.12 script.py",
    "printf data | rscript script.R",
  ]) {
    it(`preserves direct execution and case-sensitive names: ${command}`, () => {
      expect(parseBashCommand(command).success).toBe(true);
    });
  }

  it("retains the versioned executable as the permission target", () => {
    expect(parseBashCommand("/usr/bin/python3.12 script.py")).toEqual({
      executables: ["python3.12"],
      success: true,
    });
  });
});
