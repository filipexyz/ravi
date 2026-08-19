# Why `apps/ravi_desk`

Ravi Desk is a host UI, not a generated SDK and not a Ravi in-runtime app.

| Location | Role |
| --- | --- |
| `packages/` | Generated first-class SDKs only (TypeScript, Swift) |
| `src/apps/` | Ravi command-registry "apps" (YouTube, …) |
| `extensions/` | Browser overlays |
| `apps/ravi_desk` | Flutter product shell |

The package name is `ravi_desk` (Dart snake_case) so it can stay the same app
when iOS and Android targets are built later.
