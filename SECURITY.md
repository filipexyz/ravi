# Security policy

## Report a vulnerability

Report security problems privately through GitHub: [open a private report](https://github.com/filipexyz/ravi/security/advisories/new). Please do not open a public issue for them.

Include the Ravi version (`ravi --version`), what you did, what happened and what an attacker could gain. We reply in the report and keep you informed until a fix ships.

## Scope

- The `ravi.bot` package: the daemon, the CLI and the channel runner.
- The SDKs generated in `packages/` (`@ravi-os/sdk`, `ravi_sdk`, `RaviSDK`).
- The hosted Ravi Console at `console.ravi.bot` and Pages served on `ravi.page`.

## Supported versions

Fixes ship in the newest release on the npm `next` tag, and on `latest` when it is promoted. Older releases do not get backports, so update with `ravi update`.

## How Ravi limits damage

- [Security model](https://docs.ravi.bot/organizations/security): permission ceilings, the write brake, approvals, credentials and audit.
- [What leaves your machines](https://docs.ravi.bot/organizations/data-flow): what stays local, what goes to your model provider, your chat platforms and the Console.
