# YouTube agent-first CLI contract / WHY

Every `yt` write is an EXTERNAL write on a public platform: a reply is a
public comment under the channel's name, `video-update` changes what viewers
see, and the deletes are irreversible on Google's side. None of these calls is
idempotent — a blindly retried `reply` or `playlist-create` duplicates public
state. That is the strongest possible case for the write brake, so all seven
mutations got it, including the two the migration mandate left to judgment:

- `playlist-create` and `playlist-add` are braked BY PRINCIPLE: external
  provider writes, non-idempotent (blind retries duplicate playlists/items),
  and potentially public (`--privacy public`, shared playlists). The
  reversibility argument (delete/remove exist) lost to the externality +
  non-idempotency prongs — the same reasoning that braked mail send despite
  outbox retry controls.

`VIDEO_NOT_FOUND` intentionally carries no `suggestions`: the only source of
candidate ids is the Data API itself, and the contract's suggestion sources
must be cheap local reads. Teaching the listing ops via `suggestedAction` is
the honest fallback.

One structural finding: this domain funnels every provider error through
`fail(youtubeError(...))` appended with a `yt health` hint. Without an
explicit `ContractError` rethrow in that funnel, the brake and the not-found
envelope would be flattened into exit-1 text — the same class of bug the mail
migration fixed in its CloudAuthError funnel.

No `youtube` skill ships yet; the gap is registered in SPEC.md so the skill
wave can close it.
