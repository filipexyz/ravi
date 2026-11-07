import { expect, test } from "bun:test";
import { bridgeExecutable } from "./command.js";
test("bridge argv adapter binds one literal executable without a local executable allowlist", () => {
  for (const [command, expected] of [
    ["sleep 30", "sleep"],
    ["printf 'some text'", "printf"],
    ["arbitrary_binary argument", "arbitrary_binary"],
  ])
    expect(bridgeExecutable(command!)).toBe(expected!);
  for (const command of [
    "sleep 1; printf hidden",
    "printf $(whoami)",
    "RAVI_CONTEXT_KEY=x sleep 1",
    "/bin/sleep 1",
    "sleep 1 > x",
    "printf $RAVI_CONTEXT_KEY",
    "printf 'unclosed",
    "sleep 1\nsleep 2",
    "printf =abc",
    "printf *",
    "printf ~/private",
    "printf /x/??",
    "printf [ab]",
    "printf x # ignored",
  ])
    expect(bridgeExecutable(command)).toBeNull();
});
