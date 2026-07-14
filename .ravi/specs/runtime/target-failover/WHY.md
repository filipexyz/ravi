# Why

Credential rotation only recovers credentials inside one selected runtime
provider. Provider adapters cannot safely choose another provider because they
do not own permissions, task constraints, side-effect history or session
continuity. The host needs one explicit target-policy state machine.
