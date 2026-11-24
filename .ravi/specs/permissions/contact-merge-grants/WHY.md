# Why

On 24/11/2026 two `permission-full-access` grants were found on a Slack channel, left on contact ids that had been merged into other contacts weeks before. `permissions deny` could not reach them: the old id no longer exists (`CONTACT_NOT_FOUND`) and the new id has no grant. They were inert, but only by accident of how grants are looked up, and nothing could remove them.

Break-glass is dropped instead of moved because a merge is not an approval. Since #950, `admin:system` power only comes from an approved request; a merge that carried it over would be another way around that rule.
