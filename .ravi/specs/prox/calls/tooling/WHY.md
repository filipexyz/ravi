# Why

## Decision

prox call tools are a Ravi-owned contract, not provider-owned tool snippets.

Voice agents may call functions, but every function must be declared, bound to a profile, policy-checked, executed through Ravi, persisted, and normalized before the provider receives a result.

## Why Not Freeform Bash

Freeform Bash would be flexible but unsafe. A voice model could accidentally or maliciously execute broad commands, leak secrets, spam channels, or mutate state without audit.

The useful flexibility is not "run any command"; it is "define a typed function that can be implemented by any internal CLI".

## Why Bash-Backed Tools Still Exist

Ravi already has operational CLIs. Reimplementing every capability as native provider code would slow iteration and fragment behavior.

Bash-backed tools let prox calls reach those CLIs quickly while keeping:

- typed schemas;
- policy;
- lineage;
- timeout;
- redaction;
- audit trail.

## Why Profile Bindings

Global tool availability is too broad. A tool that is safe in an internal interview may be dangerous in an outbound follow-up.

Binding tools to `call_profile` keeps capability close to the call purpose.

## Why Provider-Neutral Bridge

Agora, ElevenLabs, and future providers expose tools differently. Business tools should not be rewritten for each provider.

The provider bridge normalizes all calls into the same Ravi executor.
