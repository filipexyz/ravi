# Ravi Apps Store / WHY

Apps were discovered from any folder under the state directory and ran with
whatever grants the caller had, and a wildcard grant covered a new app at once.
A marketplace on top of that would turn "install" into "give every broad agent
a new power", and a compromised index into code execution on every host.

So installing grants nothing: the operator exposes an app per agent. The index
takes only apps that are `ravi` itself, so an app can do nothing its caller
could not already do. The class is derived, because a declared class is a
claim. The index is signed with keys that never touch CI, with serials and
expiry so an old copy cannot be replayed, and a separate block key lets the
maintainer withdraw a version without the publication key.

Receipts live in files, not SQLite, because only the daemon migrates the
database and installs run from the operator's terminal.
