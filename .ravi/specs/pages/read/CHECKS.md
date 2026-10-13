# Read a Ravi Page from the CLI / CHECKS

- `readPage` POSTs `/api/cli/pages/read` with the normalized URL, `publicOnly`
  and `format`, and returns the normalized page.
- A non-`*.ravi.page` host without `--custom-domain` fails before any Console
  call.
- A turn with a runtime context the classifier refuses reads with
  `publicOnly: true`; the terminal reads with `publicOnly: false`.
- A 403 with reason `public_only` maps to `PAGE_ACCESS_DENIED` exit 3; other
  reasons exit 1; 404 maps to `PAGE_NOT_FOUND`; 413/415 to
  `PAGE_CONTENT_UNSUPPORTED`.
- `fencePageText` wraps text between two markers with the same nonce.
- The guard denies `WebFetch` and `*navigate*` tools with a `*.ravi.page` URL
  and `curl https://x.ravi.page/...`, and allows `ravi pages read ...`, plain
  `echo`, other hosts and non-fetch tools.
- "Ravi Page Links" mounts for full access and for the `pages` group, not for
  unrelated groups, no capabilities, or sentinels.
