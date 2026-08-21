# Postmortem 0003: specs facade failed SDK return-schema quality

**Date:** 2026-08-21  
**Severity:** medium  
**Status:** resolved locally; full gate rerun pending  
**Project:** Ravi

## Summary

The first official `test:sdk` run rejected all five new specs facade commands.
They declared `@Returns`, but nested targets, bindings, effects, observations,
files, and index objects used permissive schemas. The gate reported five new
weak public contracts. No commit, push, package, or deployment had occurred.

## Expected behavior

Every facade command must generate concrete TypeScript, OpenAPI, and Swift
types that tell an agent exactly which fields can appear.

## Actual behavior

Seventy-four SDK tests passed and one quality test failed. The generated SDK
could name each top-level return but lowered important nested objects to broad
records, which would force consumers to guess their shape.

## Root cause

The first schema pass optimized for runtime validation reuse with
`looseObjectSchema`. That was sufficient for Zod parsing but insufficient for
the repository's stronger public-contract gate. Presence of `@Returns` was
mistaken for completeness of the generated type.

## Resolution

The five returns now define closed schemas for:

- workspace/specs/database binding;
- normalized new/sync inputs and targets;
- create-file and compare-before-replace effects;
- blockers and creation observations;
- file-hash, ancestor, index, verification, and recovery results.

The sync plan also exposes `{source:"workspace"}` instead of an empty object so
its public input projection remains explicit. The focused return-schema quality
test now passes with no baseline exception.

## Prevention

- New SDK-visible commands must run the weak-schema gate before artifact
  generation.
- A schema is complete only when every nested object and array item is closed
  and meaningful to a generated client.
- Baseline exception files are not an approval path for newly introduced
  commands.

## Revision note — 2026-08-21

The correction passed the focused two-test return-schema gate and typecheck.
SDK TypeScript, OpenAPI, Swift, and the complete SDK suite must be regenerated
and rerun before this incident can be marked fully closed.

## Revision note — 2026-08-21 (closure)

The corrected schemas were regenerated for TypeScript, OpenAPI, and Swift.
The complete official SDK suite then passed with 75 tests and 297 assertions,
including `sdk:check`, with no new weak-schema baseline exception. This closes
the schema incident; the domain candidate still requires its remaining native,
package, independent-review, and CI gates.
