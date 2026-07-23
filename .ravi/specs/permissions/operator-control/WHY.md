# Operator Control / WHY

The old local path was named `local-operator` and lived inline in the provider
registry. That made it look like a bootstrap exception instead of a real
authorization provider.

Ravi needs a clean place for management authority:

- agents should execute with agent identity authority;
- operators should manage policy through an operator authority provider;
- future remote management should attach authenticated operator identity
  without changing agent execution semantics.

`operator-control` is the local implementation of that control-plane branch.
It keeps local administration explicit while preventing a return to implicit
no-subject authority.
