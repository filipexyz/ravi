# Task decisions

```bash
ravi decisions ask --task <task-id> --key window --ask "Which window?" --owner human:<contact-id> --blocks --json
ravi tasks attention --owner human --json
ravi tasks show <task-id> --json
ravi decisions answer <decision-id> --text "After 18h" --json
```

Task writes remain immediate. Answer from an authorized session other than the active assignment. Re-ask after answer creates a new id; old answers cannot be edited. Generic decision history is authoritative, task_events contains task automation projections. See the decisions runbook for migration/recovery; never recreate task_decisions or drop generic history.
