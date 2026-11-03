// A widget's `widget.js` inlined in a page (`<script type="text/plain">`, the
// page kit) or in the Console's audit frame. Two sequences in the code could
// change how HTML reads the element: `</script` would close it early, and
// `<!--` followed by `<script` would make the real end tag not close it.
// Both get a backslash, which JavaScript reads as the same character in
// strings, templates, comments and regular expressions without the `u` or `v`
// flag; the static check (`check.ts`) refuses code where the escaped text no
// longer parses.

export function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** The id of the element that carries a widget's code in a page: `ravi-widget-js-<first 16 hex of its sha256>`. */
export function widgetScriptElementId(sha256: string) {
  return `ravi-widget-js-${sha256.slice(0, 16)}`;
}
