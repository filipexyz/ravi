# Console UI

The Console's design system. Screens are built from these components and
Tailwind 4 utilities over the tokens in `theme.css`. The legacy components in
`src/components/ui.tsx` and the classes in `src/app/globals.css` only serve
screens that were not redesigned; new code does not use them.

## Tokens

Use the semantic utilities, never raw colors:

| Role | Utilities |
|---|---|
| Page background | `bg-canvas` |
| Cards, lists, inputs | `bg-surface` |
| Hover and selected rows | `bg-hover` |
| Code blocks, skeletons, segmented controls | `bg-sunken` |
| Borders | `border-line`, `border-line-strong` |
| Text | `text-ink` (primary), `text-ink-2` (body), `text-ink-3` (meta) |
| Primary action | `bg-accent text-accent-ink` |
| States | `text-ok`/`bg-ok-soft`, `warn`, `err`, `info` |
| People in a recorded call | `bg-speaker-1` to `bg-speaker-6` (also `text-`, `border-`), one per speaker |
| Brand mark | `bg-brand text-brand-ink` |

Fonts: `font-sans` (Inter) for everything, `font-display` (Sora) for page
titles, `font-mono` (IBM Plex Mono) only for values people copy: hosts,
commands, ids. Light is the default; dark follows the system or the account
menu's theme switch (`data-rv-theme` on `<html>`).

## Components

- `button.tsx`: `Button` (`primary`, `secondary`, `ghost`, `danger`; `href` makes it a link, `external` a plain anchor), `IconButton`.
- `badge.tsx`: `Badge` (tones), `StatusDot`, `Avatar`.
- `layout.tsx`: `PageHeader`, `Section`, `Panel`, `DetailList`, `Mono`.
- `list.tsx`: `List` + `ListRow`, one row per thing with actions on the right.
- `tabs.tsx`: `TabNav` (tabs that are URLs), `Segmented` (local choice).
- `overlay.tsx`: `Dialog`, `Drawer`, `Menu` + `MenuItem`/`MenuLabel`/`MenuSeparator`/`MenuSlot`.
- `form.tsx`: `Field` (label, hint, error, ids), `Input`, `Textarea`, `Select`, `Switch` (on/off that applies at once), `FormMessage`.
- `copy.tsx`: `CopyButton`, `CodeBlock`, `CopyValue`.
- `states.tsx`: `EmptyState`, `ErrorState`, `NoAccess`, `Skeleton`, `ListSkeleton`, `Notice`.
- `time.tsx`: `RelativeTime`, `formatRelative`, `formatDate`.
- `toast.tsx`: `useToast().show(message, tone)` for short confirmations.

## Rules for screens

1. Content first: no metric grids, no uppercase labels, no decorative slash labels. The thing the person came for is the biggest element.
2. One row per thing in a `List`; details open in a `Drawer`. A thing people come back to, link to or that has its own sections (a published page, a meeting) gets its own route instead, and visual things (pages) may be cards in a grid.
3. Words, not enums: `protected_link` is "Protected", `not_configured` is "Not set up". Every state says the next step.
4. Every query renders loading (`ListSkeleton`/`Skeleton`), error (`ErrorState` with retry), empty (`EmptyState` with the next step) and no-access states.
5. Data goes through `api` from `@/lib/api/client`, which throws `ApiError` for every failure, and query keys come from `useOrgKey()` so the cache is scoped to the organization.
6. The workspace (organization, projects, features, viewer) comes from `useWorkspace()`. Gate navigation and sections with `useFeature()`; the server still enforces every call.
7. Destructive actions confirm in a `Dialog` that states the consequence.
8. Layouts work at 390 px wide: stack on small screens, hide secondary meta, never scroll the page sideways.
