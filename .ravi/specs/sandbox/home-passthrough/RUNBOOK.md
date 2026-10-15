# Home Passthrough / RUNBOOK

## Before editing

```bash
ravi specs get sandbox/home-passthrough --mode full --json
```

The transport lives in `src/cli/remote-gateway.ts` (`getHomeGatewayConfig`,
`dispatchHome`, `homeGatewayErrorToContractError`); targeting and the
allowlist in `src/cli/home-mode.ts`; the branch in `src/cli/registry.ts` runs
before any other transport choice. The Gate's expectations are in Console's
`console/sandbox-gateway/gate` spec (§Pipeline, §Errors) and the listener's in
`console/sandbox-gateway/listener`.

## Trying it without a sandbox

```bash
HOME=$(mktemp -d) ./bin/ravi home --help
HOME=$(mktemp -d) ./bin/ravi home tasks comment t1 hi; echo $?      # 3
HOME=$(mktemp -d) RAVI_HOME_GATEWAY_URL=http://x ./bin/ravi home tasks show t1 --json; echo $?   # 2
```

A real request needs a connected run (`ravi sandbox run --connected`), which
sets `RAVI_HOME_GATEWAY_URL` and `RAVI_HOME_COMMANDS` in the sandbox env and
the grant in the egress proxy rule for the Gate host.

## Reading a HOME error

The message ends with `Request id: <uuid>` when the Gate or the listener sent
one. Look it up in the Gate audit (`sandbox_gate.*`, metadata `requestId`) and
in HOME's daemon log (`Sandbox listener request`, field `requestId`).

| Code | Usual cause |
| --- | --- |
| `HOME_GRANT_MISSING` | the proxy rule for the Gate host is missing and no env fallback |
| `HOME_GRANT_HEADER_INVALID` | both the proxy and `RAVI_SANDBOX_GRANT` sent a grant |
| `HOME_GRANT_REVOKED` | the run ended, was revoked, or is not attached yet |
| `HOME_COMMAND_NOT_ALLOWED` | command outside the grant's `cmds` |
| `HOME_TASK_NOT_ALLOWED`, `HOME_RESOURCE_FORBIDDEN` | `taskId` is not the run's home task |
| `HOME_DAEMON_OFFLINE` | HOME's tunnel or daemon is down |
| `HOME_GATEWAY_FAILED` | edge or Access answered instead of the Gate or listener |

## Changing the allowlist

The list exists in three places that must change together: Console
`SANDBOX_COMMAND_ALLOWLIST`, the HOME listener's contract, and
`HOME_STATIC_COMMANDS` here (pinned by `home-mode.test.ts`). Adding a command
also needs the Console spec change the Gate spec requires.

## Open live checks

- With E2B header injection on the Gate host and `RAVI_SANDBOX_GRANT` set,
  does the request carry one grant header or two? If two, 06b must refuse to
  set the env fallback when injection is active.
- Does the E2B egress proxy add or strip any header (`Proxy-Authorization`,
  `X-Forwarded-*`) on the way to the Gate? The Gate drops them; record what
  was observed here.
