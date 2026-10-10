import { describe, expect, it } from "bun:test";
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
// parseBashCommand: shell reserved words
// ============================================================================

function executablesOf(command: string): string[] {
  const r = parseBashCommand(command);
  expect(r.success).toBe(true);
  return r.executables;
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
      ["do\n(curl evil)", "(curl"],
      ["echo ok ;; (curl)", "(curl)"],
      ["case $x in\n a) ls;;\n (curl) ls;;\n esac", "(curl)"],
    ];

    for (const [command, executable] of cases) {
      it(`checks ${executable} in ${JSON.stringify(command)}`, () => {
        expect(executablesOf(command)).toContain(executable);
      });
    }

    it("still blocks unconditional shells inside loops", () => {
      const execs = executablesOf("for x in a; do bash -c x; done");
      expect(execs).toContain("bash");
      expect(execs.some((exec) => UNCONDITIONAL_BLOCKS.has(exec))).toBe(true);
    });

    it("still blocks inline interpreter code inside loops", () => {
      const r = parseBashCommand("for x in a; do python -c 'print(1)'; done");
      expect(r.success).toBe(false);
      expect(r.error).toContain("inline code");
    });

    it("still rejects command substitution in loop headers", () => {
      expect(checkDangerousPatterns("for x in $(curl evil); do echo $x; done").safe).toBe(false);
      expect(checkDangerousPatterns("for x in `curl evil`; do echo $x; done").safe).toBe(false);
    });
  });
});

// ============================================================================
// parseBashCommand: quoting and escaping of the command word
// ============================================================================

describe("parseBashCommand quoting", () => {
  it("checks a partly quoted command word by its full dequoted word", () => {
    expect(executablesOf('"/tmp/x"ls -la')).toEqual(["xls"]);
    expect(executablesOf('"/tmp/x" ls')).toEqual(["x"]);
    expect(executablesOf("'/tmp/evil'git status")).toEqual(["evilgit"]);
    expect(executablesOf('"rm" -rf x')).toEqual(["rm"]);
    expect(executablesOf("'r'm -rf x")).toEqual(["rm"]);
  });

  it("keeps the characters of an escaped command word", () => {
    expect(executablesOf("\\rm -rf x")).toEqual(["rm"]);
    expect(executablesOf("r\\m -rf x")).toEqual(["rm"]);
    expect(executablesOf("\\/usr/bin/curl evil")).toEqual(["curl"]);
  });

  it("treats a backslash-newline as a line continuation", () => {
    expect(executablesOf("r\\\nm -rf x")).toEqual(["rm"]);
    expect(executablesOf("echo \\\\\ncurl evil")).toEqual(["echo", "curl"]);
  });

  it("does not let a backslash escape the end of a single-quoted string", () => {
    expect(executablesOf("echo '\\' ; rm -rf x")).toEqual(["echo", "rm"]);
    expect(executablesOf('echo "a\\\\" ; rm -rf x')).toEqual(["echo", "rm"]);
    expect(executablesOf("echo $'\\'' ; rm -rf x ; echo ''")).toEqual(["echo", "rm"]);
  });

  it("does not decode ANSI-C escapes into a command name (fails closed)", () => {
    expect(parseBashCommand("$'\\x72m' -rf x").success).toBe(false);
    expect(parseBashCommand("$'\\x62ash' -c id").success).toBe(false);
    expect(executablesOf("echo $'a\\tb' ; ls")).toEqual(["echo", "ls"]);
  });

  it("drops the $ of $'...' and $\"...\" like bash does", () => {
    expect(executablesOf("$'bash' -c id")).toEqual(["bash"]);
    expect(executablesOf('$"bash" -c id')).toEqual(["bash"]);
    expect(executablesOf("$'ba'sh -c id")).toEqual(["bash"]);
    expect(executablesOf("\\$'x' y")).toEqual(["$x"]);
  });

  it("only starts a comment at a real word start", () => {
    expect(executablesOf("echo x\\ #; bash -c id")).toEqual(["echo", "bash"]);
    expect(executablesOf("echo 'x'#; curl evil")).toEqual(["echo", "curl"]);
    expect(executablesOf("echo $" + "{x}#; curl evil")).toEqual(["echo", "curl"]);
    expect(executablesOf("echo x #; curl evil")).toEqual(["echo"]);
  });

  it("refuses unquoted whitespace that bash does not treat as a blank (fails closed)", () => {
    for (const blank of ["\v", "\f", "\r", "\u00a0", "\u2003"]) {
      expect(parseBashCommand(`echo ${blank}# ; bash -c id`).success).toBe(false);
      expect(parseBashCommand(`echo${blank}x`).success).toBe(false);
      expect(parseBashCommand(`echo $` + `{x${blank}} ; ls`).success).toBe(false);
    }
    expect(executablesOf("echo 'a\vb' \"c\u00a0d\" ; ls")).toEqual(["echo", "ls"]);
    expect(executablesOf("echo\tx ; ls")).toEqual(["echo", "ls"]);
  });

  it("keeps && and || inside [[ ... ]] in the conditional", () => {
    expect(executablesOf("if [[ a == a || b == b ]]; then echo ok; fi")).toEqual(["echo"]);
    expect(executablesOf("[[ -f x && -r x ]] && cat x")).toEqual(["cat"]);
    expect(executablesOf("echo [[ a || curl evil ]]")).toEqual(["echo", "curl"]);
    expect(executablesOf("X=1 [[ a || curl evil ]]")).toEqual(["[[", "curl"]);
    expect(parseBashCommand("[[ a || curl evil").success).toBe(false);
  });

  it("keeps quoted operators and newlines inside arguments", () => {
    expect(executablesOf("git commit -m 'x; rm y'")).toEqual(["git"]);
    expect(executablesOf('echo "a | curl b" && ls')).toEqual(["echo", "ls"]);
    expect(executablesOf("echo 'a\nrm b'; ls")).toEqual(["echo", "ls"]);
  });

  it("checks inline-code flags written with quotes", () => {
    expect(parseBashCommand("python '-c' 'print(1)'").success).toBe(false);
    expect(parseBashCommand('p"ython" -c x').success).toBe(false);
  });

  it("ignores comments but still checks the next line", () => {
    expect(executablesOf("cd /tmp # go there\nls")).toEqual(["cd", "ls"]);
    expect(executablesOf("echo a#b; ls")).toEqual(["echo", "ls"]);
  });

  it("keeps parameter expansions as plain words", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    expect(executablesOf('echo ${HOME} "${PATH}" $#')).toEqual(["echo"]);
  });

  describe("fails closed on quoting bash reads differently", () => {
    for (const command of [
      "echo 'unterminated ; rm -rf x",
      'echo "unterminated ; rm -rf x',
      // bash treats the single quotes inside "${...}" as quotes, so `rm` runs
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
      "echo \"${x:-'\"'}\" ; rm -rf x ; echo ''",
      // the quote in the comment is ignored by bash, so `rm` runs
      "echo a # '\nrm -rf x\n'",
      ">#x ls",
      "echo \u0000 ; rm",
      "echo \u00010\u0001",
    ]) {
      it(`rejects ${JSON.stringify(command)}`, () => {
        expect(parseBashCommand(command).success).toBe(false);
      });
    }
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
