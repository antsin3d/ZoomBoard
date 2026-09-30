# Remote collaboration preview

## Using a session

1. Open a board, open **Share / Join**, choose a display name, and start sharing.
2. Save the board after first sharing (and after rotating its invite). Its host
   identity and invite secret are stored in that `.board` file.
3. Send the invite link or code through Slack or another trusted channel.
   Both participants need the app. Installed desktop builds handle the
   `whiteboard://` scheme; pasting the link or code into Join also works.
4. Visitors can favorite the board, see other participants' cursors, and follow
   a participant. Panning or zooming locally stops following.
5. The host can enable guest editing and **Allow download**, disconnect a guest,
   or rotate the invite. Guests return to their original local document when
   they leave.

Sharing is explicitly opt-in each time. Closing the host or ending sharing ends
the session; reopening a file does not automatically expose it. Reuse its saved
invite by starting sharing again. Do not host copies of the same master file
simultaneously: their signaling addresses intentionally collide.

## No infrastructure to operate, but not infrastructure-free

The app uses PeerJS's public signaling service to locate peers and exchange
WebRTC connection information, plus Google's public STUN service for NAT
discovery. These services see connection metadata (including IP addresses and
the stable peer address), not board payloads. Board updates, credentials, and
presence travel through WebRTC encrypted data channels.

There is **no configured TURN relay**, no hosted board database, no LAN discovery,
and no hosted landing page. Some corporate networks, firewalls, and NAT
combinations cannot establish a connection. Public signaling has no availability
guarantee here. Before a production release, verify provider terms, quotas, and
cross-network connectivity on supported system webviews.

Favorites are stored locally, including their bearer invite tokens. Their status
is determined by a bounded, authenticated connection probe; probes do not fetch
board content. “Online” means the host answered recently. “Unreachable” can mean
offline, blocked NAT, a timeout, or unavailable signaling; it is not a definitive
offline assertion. A last-seen timestamp is this device's observation, not the
host's actual last-online time.

## Permissions and identity

Each master document has a random ID, a signing keypair, and a random invite
secret. Visitors verify a signed, fresh challenge against the public key in
their invite before disclosing the invite secret. This prevents another peer
from impersonating the host just by claiming its PeerJS address. It cannot
prevent address squatting / denial of service.

Anyone holding the invite can join with the host's current guest permissions.
Display names are unverified labels, not accounts. Treat invite links, favorites,
and the master `.board` file as sensitive. A master-file backup includes hosting
credentials; don't distribute it as a guest copy.

Rotating an invite preserves document identity but changes its bearer secret
and disconnects existing guests. Old favorites need the new invite.
Disconnecting one visitor does not revoke their invite: they can rejoin unless
the host rotates it. Guest downloads omit hosting credentials and become
independent documents with a new identity if shared later.

**Allow download is an app-level Save/Copy policy, not DRM.** Guests receive the
board and embedded images in order to display/edit it, so a modified client can
retain them. Withholding those bytes would require a distinct rendered-stream
mode. Toggling this policy does not reduce initial board-transfer bandwidth.

## Synchronization and limits

The initial implementation is host-authoritative, not a distributed Yjs editing
session. The existing Yjs file envelope remains the persistence layer.

- The initial snapshot is sent once; subsequent edits send bounded entity
  patches (elements, breakpoints, and ordering).
- The host validates guest data and permissions before applying it. Independent
  entity edits merge. Concurrent edits to the same entity or incompatible
  reorderings are rejected with a resync and visible notice; users may retry.
- Guests have one edit awaiting acknowledgment at a time. Further typing and
  gestures stay in a local draft and are rebased/sent after the acknowledgment,
  without interrupting input focus. Conflicting drafts are discarded with a
  notice; unacknowledged edits are rolled back on disconnection.
- Remote updates clear snapshot-based undo history so Undo cannot revert another
  participant's work. Guest multi-user undo and rich-text concurrent merging
  are not implemented.
- Presence is ephemeral and throttled separately; cursor coordinates and followed
  viewport centers are world-space. Presence never enters the `.board` file.
- This preview allows eight guests and board/messages up to 8 MiB (with protocol
  overhead reserved). Images remain embedded; editing an image-bearing entity
  can retransmit its image. Large asset streaming/deduplication is future work.
- Heartbeats, connection timeouts, message limits, and bounded send buffers
  clean up failed peers. A disconnected host session must be ended and restarted.

The protocol boundary leaves room for other participant implementations later,
but no AI provider, autonomous editor, credentials, or model integration is
included.

## Verification

Run `pnpm test` and `pnpm build`. Protocol tests cover invites, signed identity,
validation, conflict detection, permissions, and preserving the local document
when visiting. Transport tests use a simulated PeerJS endpoint; they do not
prove public-service availability or NAT traversal.

Before release, manually test two installed apps on different networks:
link delivery, admission and revocation, simultaneous edits, large embedded
images, cursors at different zooms, follow across different window sizes,
favorite probes, host shutdown, and guest file-copy isolation. Test native
scheme handling on each packaged OS (not just the browser development build).
