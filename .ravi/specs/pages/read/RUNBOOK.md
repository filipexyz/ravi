# Read a Ravi Page from the CLI / RUNBOOK

## Read a page

```bash
ravi pages read https://acme-proj.ravi.page/weekly --json
ravi pages read https://acme-proj.ravi.page/weekly --format html
ravi pages read https://acme-proj.ravi.page/weekly --format zip --out ./weekly.zip
```

Expect `content.representation` to match the format (`extracted_markdown`,
`entry_source` or `file_list`) and, for zip/files, `download.files` with the
entry file marked.

## Exit codes

- `3` with `PAGE_ACCESS_DENIED`, `reason: public_only`: the turn is not the
  operator's own and the route is not public. Expected; the agent tells the
  person it cannot open that private Page. Run it from the terminal to check
  that the Page itself is readable.
- `1` with `PAGE_ACCESS_DENIED`: `org_forbidden` (the `ravi login` is in
  another org), `project_forbidden` (no read on the project) or
  `password_route`. Check `ravi login` and the project membership.
- `1` with `PAGE_NOT_FOUND`: nothing published at that URL. List live routes
  with `ravi pages published --json`.
- `1` with `PAGE_CONTENT_UNSUPPORTED`: the entry is not text, or the page is too
  large for that format. Use `--format zip|files`.
- `2`: a host that is not `*.ravi.page` without `--custom-domain`, a bad
  `--format`, `--out` missing for zip/files or present for a text format, or
  an existing zip / non-empty directory as `--out`.

## The agent still used a browser

1. Confirm the agent can run the `pages` group; the "Ravi Page Links" prompt
   section mounts only then.
2. Claude runtime: the PreToolUse guard denies WebFetch, browser tools and
   curl/wget on `*.ravi.page`. Codex: the bash hook denies the shell fetch.
   Other runtimes rely on the prompt section alone.
3. A browser tool with an unusual name is not matched by the guard. The
   prompt rule still applies.
