# Postmortem 0004: specs CLI smoke script misread the public contract

**Date:** 2026-08-21  
**Severity:** low  
**Status:** resolved locally  
**Project:** Ravi

## Summary

The first two real-process smoke attempts stopped on assertions in the
temporary PowerShell verifier, not on Ravi failures. No repository, package,
remote, or VPS state was changed by those verifier errors.

## What happened

The first attempt read `status` from `specs facade apply`; the documented return
field is `state`. The second attempt expected a blocked `plan` to exit with code
1. Planning intentionally succeeds with `executable:false` and structured
blockers so an agent can inspect the refusal; the matching `apply` exits with
code 1.

## Root cause

The ad hoc verifier duplicated assumptions instead of reading the generated
return type and the native facade test before asserting the process response.

## Resolution

The verifier was corrected to assert the published fields and two-phase
behavior. A clean third run passed the complete process sequence, including
`SPEC_ANCESTORS_MISSING`, failed apply, and confirmation that no blocked target
was written.

## Prevention

- Derive process assertions from generated return schemas and native tests.
- Distinguish a successful diagnostic plan from authorization to apply it.
- Treat verifier failures as unclassified until product output is captured and
  compared with the public contract.
