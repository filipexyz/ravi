# Widgets agent-first CLI contract / WHY

A widget is a template the organization's pages reuse, so the surface follows
the same split as themes: reading and local work run at once, Library writes
are braked, and agents propose instead of publishing.

- **`catalog` is for agents first.** It prints the pieces, filters, field
  types and the org's widgets in one text, so an agent can write a page with
  `ravi-*` tags or a new widget without reading the Console's source.
- **`check` and `preview` ask the Console.** The Console owns the template
  compiler, the accessibility lint and the renderer. A preview from a local
  copy would pass things publish then rejects. `preview` writes one local
  HTML file without scripts, so it is safe to open anywhere.
- **`init --from-view` reads the view's schema, never its rows.** The
  scaffold needs field names and types; copying records into a local folder
  would leak data into files nobody tracks.
- **`publish` and `propose` are braked.** A published version changes what
  pages get on their next ship, and a proposal notifies reviewers.
- **Accessibility errors fail the command.** A widget that renders an image
  without `alt` or a button without a name is refused with its line
  (`WIDGET_INVALID`, exit 2): other people and other agents read these pages.
