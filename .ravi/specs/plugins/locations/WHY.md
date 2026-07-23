# Why Internal Plugins Use Immutable Snapshots

Ravi may run several versions at once: the daemon, operator CLIs, cron shell commands, and rolling updates can all discover embedded plugins concurrently. A shared mutable directory lets one process delete files while another process is reading them, and it also lets an older bundle silently replace newer plugin content.

Content-addressed snapshots give every artifact a stable filesystem path. Private staging plus atomic publication ensures readers observe either no snapshot or a complete snapshot, never a partially copied tree. Keeping published snapshots immutable also preserves paths already handed to long-lived provider sessions.
