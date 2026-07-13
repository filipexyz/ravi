# Checks

- Synthetic providers prove ordered selection without provider-name branches.
- Missing capabilities, permissions, cooldown and open circuits reject targets.
- Credential failure first enters credential recovery; target failure switches.
- Unsafe side-effect boundary blocks every automatic replay.
- Exhaustion is terminal and occurs once.
- A switched target receives no incompatible provider session id.
- Restart resumes from durable attempt state and never duplicates an attempt.
- CLI explains effective policy, rejected targets and provenance without secrets.
