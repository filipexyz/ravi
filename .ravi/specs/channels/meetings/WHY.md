# Meeting Channels / WHY

Meetings need to behave like a Ravi native channel, not an isolated recorder
script. A meeting has participants, lifecycle, transcript/media provenance,
artifacts, permissions, events, and an originating session that needs the
resulting context.

The P0 Google Meet path proves the channel shape by producing a raw meeting
artifact and handing it back to the requesting session without forcing the
meeting runtime to summarize or decide.
