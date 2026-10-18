# Security policy

## Report a vulnerability

Report security problems privately through GitHub: [open a private report](https://github.com/filipexyz/ravi/security/advisories/new). If GitHub does not offer the form, open an issue that asks for a private security contact, without any details, and we will reply with a private channel. Please do not put details in a public issue.

Include the Ravi version (`ravi --version`), what you did, what happened and what an attacker could gain. We reply privately and keep you informed until a fix ships.

## Scope

- The `ravi.bot` package: the daemon, the CLI and the channel runner.
- The SDKs generated in `packages/` (`@ravi-os/sdk`, `ravi_sdk`, `RaviSDK`).
- The hosted Ravi Console at `console.ravi.bot` and Pages served on `ravi.page`.

## Supported versions

Fixes to the `ravi.bot` package ship in the newest release on the npm `next` tag, and on `latest` when it is promoted. Update with `ravi update`, or with `ravi update --next` to get a fix before it reaches `latest`; `--next` keeps the machine on `next` builds until you run `ravi update --stable`. Fixes to the SDKs land in their sources under `packages/`, which always match the CLI of the same commit; build an SDK from those sources to get a fix. `@ravi-os/sdk` on npm is released by hand, `ravi_sdk` on pub.dev has not been republished since 0.1.0, and the Swift package is not published. `ravi update` does not update an SDK. Older releases do not get backports.

## How Ravi limits damage

- [Security model](https://docs.ravi.bot/organizations/security): permission ceilings, the write brake, approvals, credentials and audit.
- [What leaves your machines](https://docs.ravi.bot/organizations/data-flow): what stays local, what goes to your model provider, your chat platforms and the Console.
