/**
 * The channels that take part in cloning a session register here. The core
 * (src/sessions/clone.ts) only knows the registry: a channel missing from it
 * is refused with CLONE_CHANNEL_UNSUPPORTED.
 *
 * Spec: sessions/clone.
 */

import { getSessionCloneProvisioner, registerSessionCloneProvisioner } from "../sessions/clone.js";
import { createSlackSessionCloneProvisioner, SLACK_CLONE_CHANNEL } from "./slack/session-clone-provisioner.js";

export function ensureSessionCloneProvisioners(): void {
  if (!getSessionCloneProvisioner(SLACK_CLONE_CHANNEL)) {
    registerSessionCloneProvisioner(createSlackSessionCloneProvisioner());
  }
}
