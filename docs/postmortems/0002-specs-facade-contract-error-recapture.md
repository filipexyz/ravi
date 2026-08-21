# Postmortem 0002: specs facade recaptured a typed usage error

**Date:** 2026-08-21
**Severity:** low
**Status:** resolved before commit
**Project:** Ravi

## Summary

The first native CLI test for an invalid specs facade operation showed that a
typed `USAGE_ERROR` was being caught inside the facade command and converted to
a generic error. No commit, push, package, or deployment had occurred.

## Expected behavior

Invalid facade operations and enum values must preserve `ContractError`, exit
code `2`, `acceptedValues`, and the public JSON envelope.

## Actual behavior

The validation helper correctly raised `ContractError`, but the surrounding
command caught every thrown value and passed it to a generic failure helper.
The test received a plain `Error` with the right text but lost the typed
contract.

## Root cause

The facade error funnel distinguished domain resolution errors from generic
errors but did not recognize the CLI boundary's private typed termination
signal. This repeated the catch-order failure previously found in the shared
SDK path.

## Resolution

The facade funnel now rethrows the exact `ContractError` instance before any
domain or generic conversion. The native CLI test covers both an unsupported
operation and an invalid kind.

## Prevention

- Typed CLI signals must be checked before broad error conversion.
- Every new facade command group must test usage errors through its outermost
  catch path, not only through the validation helper.
- A green text message is not evidence that exit taxonomy and JSON structure
  survived the dispatcher.

## Revision note — 2026-08-21

After the fix, the focused command suite preserved `USAGE_ERROR` for both
cases. A separate cold-start setup timeout was classified as a known Windows
test-environment fluctuation; the specs-native files now use the repository's
established 20-second setup allowance, without weakening operation assertions.
