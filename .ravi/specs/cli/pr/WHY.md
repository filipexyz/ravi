# Verified PR publication / WHY

The supported alternative to git push in a runtime session was manual Git
Data API work followed by a separate script. Incorrect raw-diff parsing could
upload the wrong tree; successful PR creation could still leave no CI follow.
One command owns the complete outcome and exposes partial states honestly.

Content-addressed objects make retries safe only when their hashes are checked.
GitHub's commit endpoint does not accept arbitrary raw commit bytes, so v1
refuses formats it cannot reproduce exactly. It never manufactures a replacement
commit or weakens independent review to make publication appear successful.

A row in the trigger table is not proof of a loaded subscription. The runner
health request confirms that the existing runner consumed this exact desired
follow configuration, without adding another watcher or scheduling system.
