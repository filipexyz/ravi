// GENERATED FILE — DO NOT EDIT.
// Run `ravi sdk client generate` to regenerate.
// Drift is detected by `ravi sdk client check` (CI).
/**
 * `RaviClient` exposes every registry command as a typed method.
 *
 * The class is generated 1:1 from `getRegistry()`. Every method calls into
 * the supplied `Transport`, which is responsible for validation, scope
 * enforcement, and audit (see `transport/http.ts` and
 * `transport/in-process.ts`).
 */
export class RaviClient {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    adapters = {
        /** List session adapters with health and bind state */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["adapters"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Show a session adapter debug snapshot */
        show: async (adapterId) => {
            return this.transport.call({
                groupSegments: ["adapters"],
                command: "show",
                body: { adapterId },
            });
        }
    };
    agents = {
        /** Create a new agent */
        create: async (id, cwd, options) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "create",
                body: { id, cwd, ...(options ?? {}) },
            });
        },
        /** Set message debounce time */
        debounce: async (id, ms) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "debounce",
                body: { id, ms },
            });
        },
        /** Show last turns of an agent session (what it received, what it responded) */
        debug: async (id, nameOrKey, options) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "debug",
                body: { id, nameOrKey, ...(options ?? {}) },
            });
        },
        /** Delete an agent */
        delete: async (id) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "delete",
                body: { id },
            });
        },
        /** List all agents */
        list: async () => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "list",
                body: {},
            });
        },
        /** Reset agent session */
        reset: async (id, nameOrKey) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "reset",
                body: { id, nameOrKey },
            });
        },
        /** Show agent session status */
        session: async (id) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "session",
                body: { id },
            });
        },
        /** Set agent property */
        set: async (id, key, value) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "set",
                body: { id, key, value },
            });
        },
        /** Show agent details */
        show: async (id) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "show",
                body: { id },
            });
        },
        /** Enable or disable spec mode for an agent */
        specMode: async (id, enabled) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "spec-mode",
                body: { id, enabled },
            });
        },
        /** Migrate agent workspaces to AGENTS.md as the canonical file */
        syncInstructions: async (options) => {
            return this.transport.call({
                groupSegments: ["agents"],
                command: "sync-instructions",
                body: { ...(options ?? {}) },
            });
        }
    };
    artifacts = {
        /** Soft-archive an artifact */
        archive: async (id) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "archive",
                body: { id },
            });
        },
        /** Attach an artifact to a task, session, message or any target */
        attach: async (id, targetType, targetId, options) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "attach",
                body: { id, targetType, targetId, ...(options ?? {}) },
            });
        },
        /** Stream raw artifact bytes */
        blob: async (id) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "blob",
                body: { id },
                binary: true,
            });
        },
        /** Create a generic Ravi artifact record */
        create: async (kind, options) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "create",
                body: { kind, ...(options ?? {}) },
            });
        },
        /** Append an artifact lifecycle event */
        event: async (id, eventType, options) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "event",
                body: { id, eventType, ...(options ?? {}) },
            });
        },
        /** List artifact lifecycle events */
        events: async (id) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "events",
                body: { id },
            });
        },
        /** List artifacts */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Show artifact details, links and events */
        show: async (id) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "show",
                body: { id },
            });
        },
        /** Edit artifact metadata and high-level fields */
        update: async (id, options) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "update",
                body: { id, ...(options ?? {}) },
            });
        },
        /** Watch artifact lifecycle until a terminal status */
        watch: async (id, options) => {
            return this.transport.call({
                groupSegments: ["artifacts"],
                command: "watch",
                body: { id, ...(options ?? {}) },
            });
        }
    };
    audio = {
        /** Generate speech from text using ElevenLabs TTS */
        generate: async (text, options) => {
            return this.transport.call({
                groupSegments: ["audio"],
                command: "generate",
                body: { text, ...(options ?? {}) },
            });
        }
    };
    contacts = {
        /** Add/allow a contact */
        add: async (identity, name, options) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "add",
                body: { identity, name, ...(options ?? {}) },
            });
        },
        /** Allow a contact */
        allow: async (contact) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "allow",
                body: { contact },
            });
        },
        /** Approve pending contact */
        approve: async (contact, mode, options) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "approve",
                body: { contact, mode, ...(options ?? {}) },
            });
        },
        /** Block a contact */
        block: async (contact) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "block",
                body: { contact },
            });
        },
        /** Check contact status (alias for info) */
        check: async (contact) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "check",
                body: { contact },
            });
        },
        /** Find likely duplicate contacts */
        duplicates: async () => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "duplicates",
                body: {},
            });
        },
        /** Find contacts by tag or search query */
        find: async (query, options) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "find",
                body: { query, ...(options ?? {}) },
            });
        },
        /** Show canonical contact details */
        get: async (contact) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "get",
                body: { contact },
            });
        },
        /** Set a contact's tag in a specific group */
        groupTag: async (contact, group, tag) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "group-tag",
                body: { contact, group, tag },
            });
        },
        /** Remove a contact's tag from a specific group */
        groupUntag: async (contact, group) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "group-untag",
                body: { contact, group },
            });
        },
        /** Add an identity to a contact (legacy alias for link) */
        identityAdd: async (contact, platform, value) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "identity-add",
                body: { contact, platform, value },
            });
        },
        /** Remove an identity (legacy alias for unlink) */
        identityRemove: async (platform, value) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "identity-remove",
                body: { platform, value },
            });
        },
        /** Show contact details with all identities */
        info: async (contact) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "info",
                body: { contact },
            });
        },
        /** Link a platform identity to a contact */
        link: async (contact, options) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "link",
                body: { contact, ...(options ?? {}) },
            });
        },
        /** List all contacts */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Merge two contacts (move identities from source to target) */
        merge: async (source, target) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "merge",
                body: { source, target },
            });
        },
        /** List pending contacts */
        pending: async (options) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "pending",
                body: { ...(options ?? {}) },
            });
        },
        /** Remove a contact */
        remove: async (contact) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "remove",
                body: { contact },
            });
        },
        /** Set contact property */
        set: async (contact, key, value) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "set",
                body: { contact, key, value },
            });
        },
        /** Add a tag to a contact */
        tag: async (contact, tag) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "tag",
                body: { contact, tag },
            });
        },
        /** Unlink a platform identity from its contact */
        unlink: async (platformIdentity, options) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "unlink",
                body: { platformIdentity, ...(options ?? {}) },
            });
        },
        /** Remove a tag from a contact */
        untag: async (contact, tag) => {
            return this.transport.call({
                groupSegments: ["contacts"],
                command: "untag",
                body: { contact, tag },
            });
        }
    };
    context = {
        /** Request approval and extend the current runtime context if approved */
        authorize: async (permission, objectType, objectId) => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "authorize",
                body: { permission, objectType, objectId },
            });
        },
        /** List inherited capabilities for the current runtime context */
        capabilities: async () => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "capabilities",
                body: {},
            });
        },
        /** Check whether the current runtime context allows an action */
        check: async (permission, objectType, objectId) => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "check",
                body: { permission, objectType, objectId },
            });
        },
        /** Evaluate a Codex PreToolUse Bash hook payload from stdin using the current Ravi context */
        codexBashHook: async () => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "codex-bash-hook",
                body: {},
            });
        },
        credentials: {
            /** Add a runtime context-key to the local credentials store */
            add: async (contextKey, options) => {
                return this.transport.call({
                    groupSegments: ["context", "credentials"],
                    command: "add",
                    body: { contextKey, ...(options ?? {}) },
                });
            },
            /** List entries in the local credentials store */
            list: async () => {
                return this.transport.call({
                    groupSegments: ["context", "credentials"],
                    command: "list",
                    body: {},
                });
            },
            /** Remove a stored context-key from the credentials store */
            remove: async (contextKey) => {
                return this.transport.call({
                    groupSegments: ["context", "credentials"],
                    command: "remove",
                    body: { contextKey },
                });
            },
            /** Mark a stored context-key as the default */
            setDefault: async (contextKey) => {
                return this.transport.call({
                    groupSegments: ["context", "credentials"],
                    command: "set-default",
                    body: { contextKey },
                });
            }
        },
        /** Show full runtime context details without exposing the context key */
        info: async (contextId) => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "info",
                body: { contextId },
            });
        },
        /** Issue a least-privilege child context for an external CLI */
        issue: async (cliName, options) => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "issue",
                body: { cliName, ...(options ?? {}) },
            });
        },
        /** Show ancestor chain and descendant tree for a runtime context */
        lineage: async (contextId) => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "lineage",
                body: { contextId },
            });
        },
        /** List issued runtime contexts without exposing context keys */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Revoke a runtime context by context ID */
        revoke: async (contextId, options) => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "revoke",
                body: { contextId, ...(options ?? {}) },
            });
        },
        /** Resolve the current runtime context */
        whoami: async () => {
            return this.transport.call({
                groupSegments: ["context"],
                command: "whoami",
                body: {},
            });
        }
    };
    costs = {
        /** Show detailed cost summary for one agent */
        agent: async (agentId, options) => {
            return this.transport.call({
                groupSegments: ["costs"],
                command: "agent",
                body: { agentId, ...(options ?? {}) },
            });
        },
        /** Show cost breakdown by agent */
        agents: async (options) => {
            return this.transport.call({
                groupSegments: ["costs"],
                command: "agents",
                body: { ...(options ?? {}) },
            });
        },
        /** Show detailed cost summary for one session */
        session: async (nameOrKey) => {
            return this.transport.call({
                groupSegments: ["costs"],
                command: "session",
                body: { nameOrKey },
            });
        },
        /** Show total cost summary for a recent window */
        summary: async (options) => {
            return this.transport.call({
                groupSegments: ["costs"],
                command: "summary",
                body: { ...(options ?? {}) },
            });
        },
        /** Show most expensive sessions */
        topSessions: async (options) => {
            return this.transport.call({
                groupSegments: ["costs"],
                command: "top-sessions",
                body: { ...(options ?? {}) },
            });
        }
    };
    cron = {
        /** Add a new scheduled job */
        add: async (name, options) => {
            return this.transport.call({
                groupSegments: ["cron"],
                command: "add",
                body: { name, ...(options ?? {}) },
            });
        },
        /** Disable a job */
        disable: async (id) => {
            return this.transport.call({
                groupSegments: ["cron"],
                command: "disable",
                body: { id },
            });
        },
        /** Enable a job */
        enable: async (id) => {
            return this.transport.call({
                groupSegments: ["cron"],
                command: "enable",
                body: { id },
            });
        },
        /** List all scheduled jobs */
        list: async () => {
            return this.transport.call({
                groupSegments: ["cron"],
                command: "list",
                body: {},
            });
        },
        /** Delete a job */
        rm: async (id) => {
            return this.transport.call({
                groupSegments: ["cron"],
                command: "rm",
                body: { id },
            });
        },
        /** Manually run a job (ignores schedule) */
        run: async (id) => {
            return this.transport.call({
                groupSegments: ["cron"],
                command: "run",
                body: { id },
            });
        },
        /** Set job property */
        set: async (id, key, value) => {
            return this.transport.call({
                groupSegments: ["cron"],
                command: "set",
                body: { id, key, value },
            });
        },
        /** Show job details */
        show: async (id) => {
            return this.transport.call({
                groupSegments: ["cron"],
                command: "show",
                body: { id },
            });
        }
    };
    daemon = {
        /** Run daemon in dev mode with auto-rebuild on file changes */
        dev: async () => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "dev",
                body: {},
            });
        },
        /** Edit environment file (~/.ravi/.env) */
        env: async () => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "env",
                body: {},
            });
        },
        /** Bootstrap the admin runtime context-key. Refuses to run if any live admin context already exists. */
        initAdminKey: async (options) => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "init-admin-key",
                body: { ...(options ?? {}) },
            });
        },
        /** Save PM2 process list and suggest startup */
        install: async () => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "install",
                body: {},
            });
        },
        /** Show daemon logs (PM2) */
        logs: async (options) => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "logs",
                body: { ...(options ?? {}) },
            });
        },
        /** Restart the daemon */
        restart: async (options) => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "restart",
                body: { ...(options ?? {}) },
            });
        },
        /** Run daemon in foreground (used by PM2) */
        run: async () => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "run",
                body: {},
            });
        },
        /** Start the daemon via PM2 */
        start: async () => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "start",
                body: {},
            });
        },
        /** Show daemon and infrastructure status */
        status: async () => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "status",
                body: {},
            });
        },
        /** Stop the daemon */
        stop: async () => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "stop",
                body: {},
            });
        },
        /** Remove ravi from PM2 and clean up */
        uninstall: async () => {
            return this.transport.call({
                groupSegments: ["daemon"],
                command: "uninstall",
                body: {},
            });
        }
    };
    devin = {
        auth: {
            /** Validate Devin API credentials */
            check: async () => {
                return this.transport.call({
                    groupSegments: ["devin", "auth"],
                    command: "check",
                    body: {},
                });
            }
        },
        sessions: {
            /** Archive a Devin session */
            archive: async (session) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "archive",
                    body: { session },
                });
            },
            /** List and cache session attachments */
            attachments: async (session, options) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "attachments",
                    body: { session, ...(options ?? {}) },
                });
            },
            /** Create a Devin session */
            create: async (options) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "create",
                    body: { ...(options ?? {}) },
                });
            },
            /** Show Devin session insights/activity summary */
            insights: async (session, options) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "insights",
                    body: { session, ...(options ?? {}) },
                });
            },
            /** List local or remote Devin sessions */
            list: async (options) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "list",
                    body: { ...(options ?? {}) },
                });
            },
            /** List and cache session messages */
            messages: async (session, options) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "messages",
                    body: { session, ...(options ?? {}) },
                });
            },
            /** Send a message to a Devin session */
            send: async (session, message, options) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "send",
                    body: { session, message, ...(options ?? {}) },
                });
            },
            /** Show one Devin session */
            show: async (session, options) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "show",
                    body: { session, ...(options ?? {}) },
                });
            },
            /** Sync session status, messages and attachments */
            sync: async (session, options) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "sync",
                    body: { session, ...(options ?? {}) },
                });
            },
            /** Terminate a Devin session */
            terminate: async (session, options) => {
                return this.transport.call({
                    groupSegments: ["devin", "sessions"],
                    command: "terminate",
                    body: { session, ...(options ?? {}) },
                });
            }
        }
    };
    eval = {
        /** Run an eval task spec and persist artifacts */
        run: async (specPath, options) => {
            return this.transport.call({
                groupSegments: ["eval"],
                command: "run",
                body: { specPath, ...(options ?? {}) },
            });
        }
    };
    events = {
        /** Replay persisted JetStream events with filters */
        replay: async (options) => {
            return this.transport.call({
                groupSegments: ["events"],
                command: "replay",
                body: { ...(options ?? {}) },
            });
        },
        /** Stream all events in real-time (default command) */
        stream: async (options) => {
            return this.transport.call({
                groupSegments: ["events"],
                command: "stream",
                body: { ...(options ?? {}) },
            });
        }
    };
    heartbeat = {
        /** Disable heartbeat for an agent */
        disable: async (id) => {
            return this.transport.call({
                groupSegments: ["heartbeat"],
                command: "disable",
                body: { id },
            });
        },
        /** Enable heartbeat for an agent */
        enable: async (id, interval) => {
            return this.transport.call({
                groupSegments: ["heartbeat"],
                command: "enable",
                body: { id, interval },
            });
        },
        /** Set heartbeat property */
        set: async (id, key, value) => {
            return this.transport.call({
                groupSegments: ["heartbeat"],
                command: "set",
                body: { id, key, value },
            });
        },
        /** Show heartbeat config for an agent */
        show: async (id) => {
            return this.transport.call({
                groupSegments: ["heartbeat"],
                command: "show",
                body: { id },
            });
        },
        /** Show heartbeat status for all agents */
        status: async () => {
            return this.transport.call({
                groupSegments: ["heartbeat"],
                command: "status",
                body: {},
            });
        },
        /** Manually trigger a heartbeat */
        trigger: async (id) => {
            return this.transport.call({
                groupSegments: ["heartbeat"],
                command: "trigger",
                body: { id },
            });
        }
    };
    hooks = {
        /** Create a new runtime hook */
        create: async (name, options) => {
            return this.transport.call({
                groupSegments: ["hooks"],
                command: "create",
                body: { name, ...(options ?? {}) },
            });
        },
        /** Disable a hook */
        disable: async (id) => {
            return this.transport.call({
                groupSegments: ["hooks"],
                command: "disable",
                body: { id },
            });
        },
        /** Enable a hook */
        enable: async (id) => {
            return this.transport.call({
                groupSegments: ["hooks"],
                command: "enable",
                body: { id },
            });
        },
        /** List configured hooks */
        list: async () => {
            return this.transport.call({
                groupSegments: ["hooks"],
                command: "list",
                body: {},
            });
        },
        /** Delete a hook */
        rm: async (id) => {
            return this.transport.call({
                groupSegments: ["hooks"],
                command: "rm",
                body: { id },
            });
        },
        /** Show hook details */
        show: async (id) => {
            return this.transport.call({
                groupSegments: ["hooks"],
                command: "show",
                body: { id },
            });
        },
        /** Execute a hook once with a synthetic event */
        test: async (id) => {
            return this.transport.call({
                groupSegments: ["hooks"],
                command: "test",
                body: { id },
            });
        }
    };
    image = {
        atlas: {
            /** Split an image atlas/contact sheet into deterministic crop artifacts */
            split: async (input, options) => {
                return this.transport.call({
                    groupSegments: ["image", "atlas"],
                    command: "split",
                    body: { input, ...(options ?? {}) },
                });
            }
        },
        /** Generate an image from a text prompt */
        generate: async (prompt, options) => {
            return this.transport.call({
                groupSegments: ["image"],
                command: "generate",
                body: { prompt, ...(options ?? {}) },
            });
        }
    };
    insights = {
        /** Create a new insight with lineage captured from the current runtime context */
        create: async (summary, options) => {
            return this.transport.call({
                groupSegments: ["insights"],
                command: "create",
                body: { summary, ...(options ?? {}) },
            });
        },
        /** List recent insights with optional filters */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["insights"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Search insights by free text */
        search: async (text, options) => {
            return this.transport.call({
                groupSegments: ["insights"],
                command: "search",
                body: { text, ...(options ?? {}) },
            });
        },
        /** Show one insight with lineage and comments */
        show: async (id) => {
            return this.transport.call({
                groupSegments: ["insights"],
                command: "show",
                body: { id },
            });
        }
    };
    instances = {
        /** Connect an instance to omni (QR code for WhatsApp) */
        connect: async (name, options) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "connect",
                body: { name, ...(options ?? {}) },
            });
        },
        /** Create a new instance */
        create: async (name, options) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "create",
                body: { name, ...(options ?? {}) },
            });
        },
        /** Delete an instance (soft-delete, recoverable) */
        delete: async (name) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "delete",
                body: { name },
            });
        },
        /** List soft-deleted instances */
        deleted: async () => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "deleted",
                body: {},
            });
        },
        /** Disable an instance in Ravi without changing omni */
        disable: async (target) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "disable",
                body: { target },
            });
        },
        /** Disconnect an instance from omni */
        disconnect: async (name) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "disconnect",
                body: { name },
            });
        },
        /** Enable an instance in Ravi without changing omni */
        enable: async (target) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "enable",
                body: { target },
            });
        },
        /** Get an instance property */
        get: async (name, key) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "get",
                body: { name, key },
            });
        },
        /** List all instances */
        list: async () => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "list",
                body: {},
            });
        },
        pending: {
            /** Approve a pending contact or chat */
            approve: async (name, contact, options) => {
                return this.transport.call({
                    groupSegments: ["instances", "pending"],
                    command: "approve",
                    body: { name, contact, ...(options ?? {}) },
                });
            },
            /** List pending contacts and chats for an instance */
            list: async (name) => {
                return this.transport.call({
                    groupSegments: ["instances", "pending"],
                    command: "list",
                    body: { name },
                });
            },
            /** Reject and remove a pending contact or chat */
            reject: async (name, contact) => {
                return this.transport.call({
                    groupSegments: ["instances", "pending"],
                    command: "reject",
                    body: { name, contact },
                });
            }
        },
        /** Restore a soft-deleted instance */
        restore: async (name) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "restore",
                body: { name },
            });
        },
        routes: {
            /** Add a route to an instance */
            add: async (name, pattern, agent, options) => {
                return this.transport.call({
                    groupSegments: ["instances", "routes"],
                    command: "add",
                    body: { name, pattern, agent, ...(options ?? {}) },
                });
            },
            /** List soft-deleted routes */
            deleted: async (name) => {
                return this.transport.call({
                    groupSegments: ["instances", "routes"],
                    command: "deleted",
                    body: { name },
                });
            },
            /** List routes for an instance */
            list: async (name) => {
                return this.transport.call({
                    groupSegments: ["instances", "routes"],
                    command: "list",
                    body: { name },
                });
            },
            /** Remove a route (soft-delete, recoverable) */
            remove: async (name, pattern, options) => {
                return this.transport.call({
                    groupSegments: ["instances", "routes"],
                    command: "remove",
                    body: { name, pattern, ...(options ?? {}) },
                });
            },
            /** Restore a soft-deleted route */
            restore: async (name, pattern, options) => {
                return this.transport.call({
                    groupSegments: ["instances", "routes"],
                    command: "restore",
                    body: { name, pattern, ...(options ?? {}) },
                });
            },
            /** Set a route property */
            set: async (name, pattern, key, value, options) => {
                return this.transport.call({
                    groupSegments: ["instances", "routes"],
                    command: "set",
                    body: { name, pattern, key, value, ...(options ?? {}) },
                });
            },
            /** Show route details */
            show: async (name, pattern) => {
                return this.transport.call({
                    groupSegments: ["instances", "routes"],
                    command: "show",
                    body: { name, pattern },
                });
            }
        },
        /** Set an instance property */
        set: async (name, key, value) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "set",
                body: { name, key, value },
            });
        },
        /** Show instance details */
        show: async (name) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "show",
                body: { name },
            });
        },
        /** Show connection status for an instance */
        status: async (name) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "status",
                body: { name },
            });
        },
        /** Explain which runtime, DB, and live instance this CLI would affect */
        target: async (name, options) => {
            return this.transport.call({
                groupSegments: ["instances"],
                command: "target",
                body: { name, ...(options ?? {}) },
            });
        }
    };
    media = {
        /** Send a media file (image, video, audio, document) */
        send: async (filePath, options) => {
            return this.transport.call({
                groupSegments: ["media"],
                command: "send",
                body: { filePath, ...(options ?? {}) },
            });
        }
    };
    permissions = {
        /** Check if a subject has a permission on an object */
        check: async (subject, permission, object) => {
            return this.transport.call({
                groupSegments: ["permissions"],
                command: "check",
                body: { subject, permission, object },
            });
        },
        /** Clear all manual relations */
        clear: async (options) => {
            return this.transport.call({
                groupSegments: ["permissions"],
                command: "clear",
                body: { ...(options ?? {}) },
            });
        },
        /** Grant a relation */
        grant: async (subject, relation, object) => {
            return this.transport.call({
                groupSegments: ["permissions"],
                command: "grant",
                body: { subject, relation, object },
            });
        },
        /** Apply a permission template to an agent */
        init: async (subject, template) => {
            return this.transport.call({
                groupSegments: ["permissions"],
                command: "init",
                body: { subject, template },
            });
        },
        /** List relations */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["permissions"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Revoke a relation */
        revoke: async (subject, relation, object) => {
            return this.transport.call({
                groupSegments: ["permissions"],
                command: "revoke",
                body: { subject, relation, object },
            });
        },
        /** Re-sync relations from agent configs */
        sync: async () => {
            return this.transport.call({
                groupSegments: ["permissions"],
                command: "sync",
                body: {},
            });
        }
    };
    projects = {
        /** Create one project */
        create: async (title, options) => {
            return this.transport.call({
                groupSegments: ["projects"],
                command: "create",
                body: { title, ...(options ?? {}) },
            });
        },
        fixtures: {
            /** Reset and seed the canonical project fixtures used in demos and smoke tests */
            seed: async (options) => {
                return this.transport.call({
                    groupSegments: ["projects", "fixtures"],
                    command: "seed",
                    body: { ...(options ?? {}) },
                });
            }
        },
        /** Materialize a project with cheap links and optional canonical workflows */
        init: async (title, options) => {
            return this.transport.call({
                groupSegments: ["projects"],
                command: "init",
                body: { title, ...(options ?? {}) },
            });
        },
        /** Link workflow/session/agent/resource/spec context to a project */
        link: async (assetType, project, target, options) => {
            return this.transport.call({
                groupSegments: ["projects"],
                command: "link",
                body: { assetType, project, target, ...(options ?? {}) },
            });
        },
        /** List projects */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["projects"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** List projects as an operational next-work surface */
        next: async (options) => {
            return this.transport.call({
                groupSegments: ["projects"],
                command: "next",
                body: { ...(options ?? {}) },
            });
        },
        resources: {
            /** Add one resource link to a project */
            add: async (project, target, options) => {
                return this.transport.call({
                    groupSegments: ["projects", "resources"],
                    command: "add",
                    body: { project, target, ...(options ?? {}) },
                });
            },
            /** Import multiple cheap resources into a project */
            import: async (project, options) => {
                return this.transport.call({
                    groupSegments: ["projects", "resources"],
                    command: "import",
                    body: { project, ...(options ?? {}) },
                });
            },
            /** List resource links for a project */
            list: async (project, options) => {
                return this.transport.call({
                    groupSegments: ["projects", "resources"],
                    command: "list",
                    body: { project, ...(options ?? {}) },
                });
            },
            /** Show one resource link on a project */
            show: async (project, resource) => {
                return this.transport.call({
                    groupSegments: ["projects", "resources"],
                    command: "show",
                    body: { project, resource },
                });
            }
        },
        /** Show one project with linked context */
        show: async (project) => {
            return this.transport.call({
                groupSegments: ["projects"],
                command: "show",
                body: { project },
            });
        },
        /** Show one project with workflow runtime rollup */
        status: async (project) => {
            return this.transport.call({
                groupSegments: ["projects"],
                command: "status",
                body: { project },
            });
        },
        tasks: {
            /** Attach an existing task to a project workflow node */
            attach: async (project, nodeKey, taskId, options) => {
                return this.transport.call({
                    groupSegments: ["projects", "tasks"],
                    command: "attach",
                    body: { project, nodeKey, taskId, ...(options ?? {}) },
                });
            },
            /** Create a task attempt from a project workflow node */
            create: async (project, nodeKey, title, options) => {
                return this.transport.call({
                    groupSegments: ["projects", "tasks"],
                    command: "create",
                    body: { project, nodeKey, title, ...(options ?? {}) },
                });
            },
            /** Dispatch a task using project owner/session defaults */
            dispatch: async (project, taskId, options) => {
                return this.transport.call({
                    groupSegments: ["projects", "tasks"],
                    command: "dispatch",
                    body: { project, taskId, ...(options ?? {}) },
                });
            }
        },
        /** Update one project */
        update: async (project, options) => {
            return this.transport.call({
                groupSegments: ["projects"],
                command: "update",
                body: { project, ...(options ?? {}) },
            });
        },
        workflows: {
            /** Attach one existing workflow run to a project in one step */
            attach: async (project, runId, options) => {
                return this.transport.call({
                    groupSegments: ["projects", "workflows"],
                    command: "attach",
                    body: { project, runId, ...(options ?? {}) },
                });
            },
            /** Start one workflow run from a project and link it in one step */
            start: async (project, specId, options) => {
                return this.transport.call({
                    groupSegments: ["projects", "workflows"],
                    command: "start",
                    body: { project, specId, ...(options ?? {}) },
                });
            }
        }
    };
    prox = {
        calls: {
            /** Cancel a pending call request */
            cancel: async (call_request_id, options) => {
                return this.transport.call({
                    groupSegments: ["prox", "calls"],
                    command: "cancel",
                    body: { call_request_id, ...(options ?? {}) },
                });
            },
            /** Show event timeline for a call request */
            events: async (call_request_id) => {
                return this.transport.call({
                    groupSegments: ["prox", "calls"],
                    command: "events",
                    body: { call_request_id },
                });
            },
            profiles: {
                /** Configure a call profile's provider settings */
                configure: async (profile_id, options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "profiles"],
                        command: "configure",
                        body: { profile_id, ...(options ?? {}) },
                    });
                },
                /** List available call profiles */
                list: async () => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "profiles"],
                        command: "list",
                        body: {},
                    });
                },
                /** Show a call profile by ID */
                show: async (profile_id) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "profiles"],
                        command: "show",
                        body: { profile_id },
                    });
                }
            },
            /** Request a call to a person */
            request: async (options) => {
                return this.transport.call({
                    groupSegments: ["prox", "calls"],
                    command: "request",
                    body: { ...(options ?? {}) },
                });
            },
            /** Show active call rules */
            rules: async (options) => {
                return this.transport.call({
                    groupSegments: ["prox", "calls"],
                    command: "rules",
                    body: { ...(options ?? {}) },
                });
            },
            /** Show details of a call request */
            show: async (call_request_id) => {
                return this.transport.call({
                    groupSegments: ["prox", "calls"],
                    command: "show",
                    body: { call_request_id },
                });
            },
            tools: {
                /** Bind a tool to a profile */
                bind: async (profile_id, tool_id, options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "tools"],
                        command: "bind",
                        body: { profile_id, tool_id, ...(options ?? {}) },
                    });
                },
                /** Configure a call tool */
                configure: async (tool_id, options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "tools"],
                        command: "configure",
                        body: { tool_id, ...(options ?? {}) },
                    });
                },
                /** Create a new call tool */
                create: async (tool_id, options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "tools"],
                        command: "create",
                        body: { tool_id, ...(options ?? {}) },
                    });
                },
                /** List call tools */
                list: async (options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "tools"],
                        command: "list",
                        body: { ...(options ?? {}) },
                    });
                },
                /** Execute a tool (dry-run validates without side effects) */
                run: async (tool_id, options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "tools"],
                        command: "run",
                        body: { tool_id, ...(options ?? {}) },
                    });
                },
                /** List tool runs for a call request */
                runs: async (call_request_id) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "tools"],
                        command: "runs",
                        body: { call_request_id },
                    });
                },
                /** Show a call tool by ID */
                show: async (tool_id) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "tools"],
                        command: "show",
                        body: { tool_id },
                    });
                },
                /** Unbind a tool from a profile */
                unbind: async (profile_id, tool_id) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "tools"],
                        command: "unbind",
                        body: { profile_id, tool_id },
                    });
                }
            },
            /** Show call transcript, syncing provider state when needed */
            transcript: async (call_request_id, options) => {
                return this.transport.call({
                    groupSegments: ["prox", "calls"],
                    command: "transcript",
                    body: { call_request_id, ...(options ?? {}) },
                });
            },
            voiceAgents: {
                /** Bind a tool to a voice agent */
                bindTool: async (voice_agent_id, tool_id, options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "voice-agents"],
                        command: "bind-tool",
                        body: { voice_agent_id, tool_id, ...(options ?? {}) },
                    });
                },
                /** Configure a voice agent */
                configure: async (voice_agent_id, options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "voice-agents"],
                        command: "configure",
                        body: { voice_agent_id, ...(options ?? {}) },
                    });
                },
                /** Create a new voice agent */
                create: async (voice_agent_id, options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "voice-agents"],
                        command: "create",
                        body: { voice_agent_id, ...(options ?? {}) },
                    });
                },
                /** List voice agents */
                list: async () => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "voice-agents"],
                        command: "list",
                        body: {},
                    });
                },
                /** Show a voice agent by ID */
                show: async (voice_agent_id) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "voice-agents"],
                        command: "show",
                        body: { voice_agent_id },
                    });
                },
                /** Sync voice agent to provider (dry-run by default) */
                sync: async (voice_agent_id, options) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "voice-agents"],
                        command: "sync",
                        body: { voice_agent_id, ...(options ?? {}) },
                    });
                },
                /** Unbind a tool from a voice agent */
                unbindTool: async (voice_agent_id, tool_id) => {
                    return this.transport.call({
                        groupSegments: ["prox", "calls", "voice-agents"],
                        command: "unbind-tool",
                        body: { voice_agent_id, tool_id },
                    });
                }
            }
        }
    };
    react = {
        /** Send an emoji reaction to a message */
        send: async (messageId, emoji) => {
            return this.transport.call({
                groupSegments: ["react"],
                command: "send",
                body: { messageId, emoji },
            });
        }
    };
    routes = {
        /** Explain how a pattern resolves in config and the live router */
        explain: async (name, pattern, options) => {
            return this.transport.call({
                groupSegments: ["routes"],
                command: "explain",
                body: { name, pattern, ...(options ?? {}) },
            });
        },
        /** List routes across all instances or for one instance */
        list: async (name) => {
            return this.transport.call({
                groupSegments: ["routes"],
                command: "list",
                body: { name },
            });
        },
        /** Show route details */
        show: async (name, pattern) => {
            return this.transport.call({
                groupSegments: ["routes"],
                command: "show",
                body: { name, pattern },
            });
        }
    };
    sdk = {
        client: {
            /** Compare on-disk @ravi-os/sdk sources to a fresh emit; exit 1 on drift */
            check: async (options) => {
                return this.transport.call({
                    groupSegments: ["sdk", "client"],
                    command: "check",
                    body: { ...(options ?? {}) },
                });
            },
            /** Generate the four @ravi-os/sdk source files from the live registry */
            generate: async (options) => {
                return this.transport.call({
                    groupSegments: ["sdk", "client"],
                    command: "generate",
                    body: { ...(options ?? {}) },
                });
            }
        },
        openapi: {
            /** Diff a stored OpenAPI spec against the live registry */
            check: async (options) => {
                return this.transport.call({
                    groupSegments: ["sdk", "openapi"],
                    command: "check",
                    body: { ...(options ?? {}) },
                });
            },
            /** Emit OpenAPI 3.1 spec from the CLI registry */
            emit: async (options) => {
                return this.transport.call({
                    groupSegments: ["sdk", "openapi"],
                    command: "emit",
                    body: { ...(options ?? {}) },
                });
            }
        }
    };
    service = {
        /** Start the bot server */
        start: async () => {
            return this.transport.call({
                groupSegments: ["service"],
                command: "start",
                body: {},
            });
        },
        /** Start the TUI interface */
        tui: async (session) => {
            return this.transport.call({
                groupSegments: ["service"],
                command: "tui",
                body: { session },
            });
        },
        /** Start WhatsApp gateway (deprecated — use daemon start) */
        wa: async () => {
            return this.transport.call({
                groupSegments: ["service"],
                command: "wa",
                body: {},
            });
        }
    };
    sessions = {
        /** Answer a question from another session (fire-and-forget) */
        answer: async (target, message, sender, options) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "answer",
                body: { target, message, sender, ...(options ?? {}) },
            });
        },
        /** Ask a question to another session (fire-and-forget) */
        ask: async (target, message, sender, options) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "ask",
                body: { target, message, sender, ...(options ?? {}) },
            });
        },
        /** Tail live runtime events for a session (defaults to current session when available) */
        debug: async (nameOrKey, options) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "debug",
                body: { nameOrKey, ...(options ?? {}) },
            });
        },
        /** Delete a session permanently */
        delete: async (nameOrKey) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "delete",
                body: { nameOrKey },
            });
        },
        /** Send an execute command to another session (fire-and-forget) */
        execute: async (target, message, options) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "execute",
                body: { target, message, ...(options ?? {}) },
            });
        },
        /** Extend an ephemeral session's TTL */
        extend: async (nameOrKey, duration) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "extend",
                body: { nameOrKey, duration },
            });
        },
        /** Show unified session inspection details */
        info: async (nameOrKey) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "info",
                body: { nameOrKey },
            });
        },
        /** Send an informational message to another session (fire-and-forget) */
        inform: async (target, message, options) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "inform",
                body: { target, message, ...(options ?? {}) },
            });
        },
        /** Make an ephemeral session permanent */
        keep: async (nameOrKey) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "keep",
                body: { nameOrKey },
            });
        },
        /** List all sessions */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Read message history of a session (normalized) */
        read: async (nameOrKey, options) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "read",
                body: { nameOrKey, ...(options ?? {}) },
            });
        },
        /** Rename canonical session name */
        rename: async (nameOrKey, newName) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "rename",
                body: { nameOrKey, newName },
            });
        },
        /** Reset a session (fresh start) */
        reset: async (nameOrKey) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "reset",
                body: { nameOrKey },
            });
        },
        runtime: {
            /** Queue a follow-up after the active runtime turn */
            followUp: async (session, text, options) => {
                return this.transport.call({
                    groupSegments: ["sessions", "runtime"],
                    command: "follow-up",
                    body: { session, text, ...(options ?? {}) },
                });
            },
            /** Fork a runtime thread if the provider supports it */
            fork: async (session, threadId, options) => {
                return this.transport.call({
                    groupSegments: ["sessions", "runtime"],
                    command: "fork",
                    body: { session, threadId, ...(options ?? {}) },
                });
            },
            /** Interrupt the active runtime turn */
            interrupt: async (session, options) => {
                return this.transport.call({
                    groupSegments: ["sessions", "runtime"],
                    command: "interrupt",
                    body: { session, ...(options ?? {}) },
                });
            },
            /** List runtime threads through an active session */
            list: async (session, options) => {
                return this.transport.call({
                    groupSegments: ["sessions", "runtime"],
                    command: "list",
                    body: { session, ...(options ?? {}) },
                });
            },
            /** Read a runtime thread through an active session */
            read: async (session, threadId, options) => {
                return this.transport.call({
                    groupSegments: ["sessions", "runtime"],
                    command: "read",
                    body: { session, threadId, ...(options ?? {}) },
                });
            },
            /** Rollback completed runtime turns */
            rollback: async (session, turns, options) => {
                return this.transport.call({
                    groupSegments: ["sessions", "runtime"],
                    command: "rollback",
                    body: { session, turns, ...(options ?? {}) },
                });
            },
            /** Steer the active runtime turn */
            steer: async (session, text, options) => {
                return this.transport.call({
                    groupSegments: ["sessions", "runtime"],
                    command: "steer",
                    body: { session, text, ...(options ?? {}) },
                });
            }
        },
        /** Send a prompt to a session (fire-and-forget). Use -w to wait for response, -i for interactive. */
        send: async (nameOrKey, prompt, options) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "send",
                body: { nameOrKey, prompt, ...(options ?? {}) },
            });
        },
        /** Set session display label */
        setDisplay: async (nameOrKey, displayName) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "set-display",
                body: { nameOrKey, displayName },
            });
        },
        /** Set session model override */
        setModel: async (nameOrKey, model) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "set-model",
                body: { nameOrKey, model },
            });
        },
        /** Set session thinking level */
        setThinking: async (nameOrKey, level) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "set-thinking",
                body: { nameOrKey, level },
            });
        },
        /** Make a session ephemeral with a TTL */
        setTtl: async (nameOrKey, duration) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "set-ttl",
                body: { nameOrKey, duration },
            });
        },
        /** Read the SQLite session trace timeline */
        trace: async (nameOrKey, options) => {
            return this.transport.call({
                groupSegments: ["sessions"],
                command: "trace",
                body: { nameOrKey, ...(options ?? {}) },
            });
        }
    };
    settings = {
        /** Delete a setting */
        delete: async (key) => {
            return this.transport.call({
                groupSegments: ["settings"],
                command: "delete",
                body: { key },
            });
        },
        /** Get a setting value */
        get: async (key) => {
            return this.transport.call({
                groupSegments: ["settings"],
                command: "get",
                body: { key },
            });
        },
        /** List live settings (legacy account.* hidden by default) */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["settings"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Set a setting value */
        set: async (key, value) => {
            return this.transport.call({
                groupSegments: ["settings"],
                command: "set",
                body: { key, value },
            });
        }
    };
    skills = {
        /** Install Ravi catalog skills or skills from an explicit source */
        install: async (name, options) => {
            return this.transport.call({
                groupSegments: ["skills"],
                command: "install",
                body: { name, ...(options ?? {}) },
            });
        },
        /** List Ravi catalog skills, installed skills or source skills */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["skills"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Show a Ravi catalog skill, installed skill or source skill */
        show: async (name, options) => {
            return this.transport.call({
                groupSegments: ["skills"],
                command: "show",
                body: { name, ...(options ?? {}) },
            });
        },
        /** Sync Ravi plugin skills into the Codex skills directory */
        sync: async () => {
            return this.transport.call({
                groupSegments: ["skills"],
                command: "sync",
                body: {},
            });
        }
    };
    specs = {
        /** Get inherited spec context */
        get: async (id, options) => {
            return this.transport.call({
                groupSegments: ["specs"],
                command: "get",
                body: { id, ...(options ?? {}) },
            });
        },
        /** List specs from .ravi/specs */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["specs"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        /** Create a new spec under .ravi/specs */
        new: async (id, options) => {
            return this.transport.call({
                groupSegments: ["specs"],
                command: "new",
                body: { id, ...(options ?? {}) },
            });
        },
        /** Rebuild the specs SQLite index from Markdown */
        sync: async () => {
            return this.transport.call({
                groupSegments: ["specs"],
                command: "sync",
                body: {},
            });
        }
    };
    stickers = {
        /** Add or update a sticker catalog entry */
        add: async (id, mediaPath, options) => {
            return this.transport.call({
                groupSegments: ["stickers"],
                command: "add",
                body: { id, mediaPath, ...(options ?? {}) },
            });
        },
        /** List stickers in the typed catalog */
        list: async () => {
            return this.transport.call({
                groupSegments: ["stickers"],
                command: "list",
                body: {},
            });
        },
        /** Remove a sticker catalog entry */
        remove: async (id) => {
            return this.transport.call({
                groupSegments: ["stickers"],
                command: "remove",
                body: { id },
            });
        },
        /** Send a sticker to the current WhatsApp chat */
        send: async (id, options) => {
            return this.transport.call({
                groupSegments: ["stickers"],
                command: "send",
                body: { id, ...(options ?? {}) },
            });
        },
        /** Show one sticker catalog entry */
        show: async (id) => {
            return this.transport.call({
                groupSegments: ["stickers"],
                command: "show",
                body: { id },
            });
        }
    };
    tags = {
        /** Attach a tag to an agent or session */
        attach: async (slug, options) => {
            return this.transport.call({
                groupSegments: ["tags"],
                command: "attach",
                body: { slug, ...(options ?? {}) },
            });
        },
        /** Create a new tag definition */
        create: async (slug, options) => {
            return this.transport.call({
                groupSegments: ["tags"],
                command: "create",
                body: { slug, ...(options ?? {}) },
            });
        },
        /** Detach a tag from an agent or session */
        detach: async (slug, options) => {
            return this.transport.call({
                groupSegments: ["tags"],
                command: "detach",
                body: { slug, ...(options ?? {}) },
            });
        },
        /** List tag definitions */
        list: async () => {
            return this.transport.call({
                groupSegments: ["tags"],
                command: "list",
                body: {},
            });
        },
        /** Search bindings by tag or asset */
        search: async (options) => {
            return this.transport.call({
                groupSegments: ["tags"],
                command: "search",
                body: { ...(options ?? {}) },
            });
        },
        /** Show one tag and its bindings */
        show: async (slug) => {
            return this.transport.call({
                groupSegments: ["tags"],
                command: "show",
                body: { slug },
            });
        }
    };
    tasks = {
        /** Archive a task without changing its execution status */
        archive: async (taskId, options) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "archive",
                body: { taskId, ...(options ?? {}) },
            });
        },
        automations: {
            /** Create a new task automation */
            add: async (name, options) => {
                return this.transport.call({
                    groupSegments: ["tasks", "automations"],
                    command: "add",
                    body: { name, ...(options ?? {}) },
                });
            },
            /** Disable a task automation */
            disable: async (id) => {
                return this.transport.call({
                    groupSegments: ["tasks", "automations"],
                    command: "disable",
                    body: { id },
                });
            },
            /** Enable a task automation */
            enable: async (id) => {
                return this.transport.call({
                    groupSegments: ["tasks", "automations"],
                    command: "enable",
                    body: { id },
                });
            },
            /** List configured task automations */
            list: async () => {
                return this.transport.call({
                    groupSegments: ["tasks", "automations"],
                    command: "list",
                    body: {},
                });
            },
            /** Delete a task automation */
            rm: async (id) => {
                return this.transport.call({
                    groupSegments: ["tasks", "automations"],
                    command: "rm",
                    body: { id },
                });
            },
            /** Show one task automation and its recent runs */
            show: async (id) => {
                return this.transport.call({
                    groupSegments: ["tasks", "automations"],
                    command: "show",
                    body: { id },
                });
            }
        },
        /** Mark a task as blocked */
        block: async (taskId, options) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "block",
                body: { taskId, ...(options ?? {}) },
            });
        },
        /** Add a comment to a task and steer the assignee if it is active */
        comment: async (taskId, body) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "comment",
                body: { taskId, body },
            });
        },
        /** Create a tracked task; unresolved dependencies arm launch plans instead of dispatching early */
        create: async (title, options) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "create",
                body: { title, ...(options ?? {}) },
            });
        },
        deps: {
            /** Add one gating dependency to a task */
            add: async (taskId, dependencyTaskId) => {
                return this.transport.call({
                    groupSegments: ["tasks", "deps"],
                    command: "add",
                    body: { taskId, dependencyTaskId },
                });
            },
            /** List gating dependencies and dependents for a task */
            ls: async (taskId) => {
                return this.transport.call({
                    groupSegments: ["tasks", "deps"],
                    command: "ls",
                    body: { taskId },
                });
            },
            /** Remove one gating dependency from a task */
            rm: async (taskId, dependencyTaskId) => {
                return this.transport.call({
                    groupSegments: ["tasks", "deps"],
                    command: "rm",
                    body: { taskId, dependencyTaskId },
                });
            }
        },
        /** Dispatch a task now, or arm a launch plan if dependencies still gate start */
        dispatch: async (taskId, options) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "dispatch",
                body: { taskId, ...(options ?? {}) },
            });
        },
        /** Mark a task as done */
        done: async (taskId, options) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "done",
                body: { taskId, ...(options ?? {}) },
            });
        },
        /** Mark a task as failed */
        fail: async (taskId, options) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "fail",
                body: { taskId, ...(options ?? {}) },
            });
        },
        /** List tasks */
        list: async (options) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "list",
                body: { ...(options ?? {}) },
            });
        },
        profiles: {
            /** Create a profile scaffold in the workspace or user catalog */
            init: async (profileId, options) => {
                return this.transport.call({
                    groupSegments: ["tasks", "profiles"],
                    command: "init",
                    body: { profileId, ...(options ?? {}) },
                });
            },
            /** List resolved task profiles from all catalog sources */
            list: async () => {
                return this.transport.call({
                    groupSegments: ["tasks", "profiles"],
                    command: "list",
                    body: {},
                });
            },
            /** Render a profile preview with the resolved template context */
            preview: async (profileId, options) => {
                return this.transport.call({
                    groupSegments: ["tasks", "profiles"],
                    command: "preview",
                    body: { profileId, ...(options ?? {}) },
                });
            },
            /** Show the resolved manifest for one task profile */
            show: async (profileId) => {
                return this.transport.call({
                    groupSegments: ["tasks", "profiles"],
                    command: "show",
                    body: { profileId },
                });
            },
            /** Validate one profile or the whole resolved catalog */
            validate: async (profileId) => {
                return this.transport.call({
                    groupSegments: ["tasks", "profiles"],
                    command: "validate",
                    body: { profileId },
                });
            }
        },
        /** Report task progress from a CLI or agent session */
        report: async (taskId, options) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "report",
                body: { taskId, ...(options ?? {}) },
            });
        },
        /** Show task details and history */
        show: async (taskId, options) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "show",
                body: { taskId, ...(options ?? {}) },
            });
        },
        /** Restore an archived task to the default list */
        unarchive: async (taskId) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "unarchive",
                body: { taskId },
            });
        },
        /** Watch task events live */
        watch: async (taskId) => {
            return this.transport.call({
                groupSegments: ["tasks"],
                command: "watch",
                body: { taskId },
            });
        }
    };
    tmux = {
        /** Attach or switch to an agent/session inside tmux */
        attach: async (agent, session) => {
            return this.transport.call({
                groupSegments: ["tmux"],
                command: "attach",
                body: { agent, session },
            });
        },
        /** List Ravi-managed tmux sessions and windows */
        list: async () => {
            return this.transport.call({
                groupSegments: ["tmux"],
                command: "list",
                body: {},
            });
        },
        /** Ensure a tmux session/window exists for an agent or session */
        open: async (agent, session) => {
            return this.transport.call({
                groupSegments: ["tmux"],
                command: "open",
                body: { agent, session },
            });
        },
        /** Listen to NATS prompts and open tmux windows automatically */
        watch: async (options) => {
            return this.transport.call({
                groupSegments: ["tmux"],
                command: "watch",
                body: { ...(options ?? {}) },
            });
        }
    };
    tools = {
        /** List all available CLI tools */
        list: async () => {
            return this.transport.call({
                groupSegments: ["tools"],
                command: "list",
                body: {},
            });
        },
        /** Export tools as JSON manifest */
        manifest: async () => {
            return this.transport.call({
                groupSegments: ["tools"],
                command: "manifest",
                body: {},
            });
        },
        /** Export tools as JSON Schema */
        schema: async () => {
            return this.transport.call({
                groupSegments: ["tools"],
                command: "schema",
                body: {},
            });
        },
        /** Show details for a specific tool */
        show: async (name) => {
            return this.transport.call({
                groupSegments: ["tools"],
                command: "show",
                body: { name },
            });
        },
        /** Test a tool execution */
        test: async (name, args) => {
            return this.transport.call({
                groupSegments: ["tools"],
                command: "test",
                body: { name, args },
            });
        }
    };
    transcribe = {
        /** Transcribe a local audio file */
        file: async (path, options) => {
            return this.transport.call({
                groupSegments: ["transcribe"],
                command: "file",
                body: { path, ...(options ?? {}) },
            });
        }
    };
    triggers = {
        /** Add a new event trigger */
        add: async (name, options) => {
            return this.transport.call({
                groupSegments: ["triggers"],
                command: "add",
                body: { name, ...(options ?? {}) },
            });
        },
        /** Disable a trigger */
        disable: async (id) => {
            return this.transport.call({
                groupSegments: ["triggers"],
                command: "disable",
                body: { id },
            });
        },
        /** Enable a trigger */
        enable: async (id) => {
            return this.transport.call({
                groupSegments: ["triggers"],
                command: "enable",
                body: { id },
            });
        },
        /** List all event triggers */
        list: async () => {
            return this.transport.call({
                groupSegments: ["triggers"],
                command: "list",
                body: {},
            });
        },
        /** Delete a trigger */
        rm: async (id) => {
            return this.transport.call({
                groupSegments: ["triggers"],
                command: "rm",
                body: { id },
            });
        },
        /** Set trigger property */
        set: async (id, key, value) => {
            return this.transport.call({
                groupSegments: ["triggers"],
                command: "set",
                body: { id, key, value },
            });
        },
        /** Show trigger details */
        show: async (id) => {
            return this.transport.call({
                groupSegments: ["triggers"],
                command: "show",
                body: { id },
            });
        },
        /** Test trigger with fake event data */
        test: async (id) => {
            return this.transport.call({
                groupSegments: ["triggers"],
                command: "test",
                body: { id },
            });
        }
    };
    video = {
        /** Analyze a video (YouTube URL or local file) and save to markdown */
        analyze: async (url, options) => {
            return this.transport.call({
                groupSegments: ["video"],
                command: "analyze",
                body: { url, ...(options ?? {}) },
            });
        }
    };
    whatsapp = {
        dm: {
            /** Send read receipt (blue ticks) for a specific message */
            ack: async (contact, messageId, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "dm"],
                    command: "ack",
                    body: { contact, messageId, ...(options ?? {}) },
                });
            },
            /** Read recent messages from a DM chat */
            read: async (contact, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "dm"],
                    command: "read",
                    body: { contact, ...(options ?? {}) },
                });
            },
            /** Send a direct message to a contact */
            send: async (contact, message, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "dm"],
                    command: "send",
                    body: { contact, message, ...(options ?? {}) },
                });
            }
        },
        group: {
            /** Add participants to a group */
            add: async (groupId, participants, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "add",
                    body: { groupId, participants, ...(options ?? {}) },
                });
            },
            /** Create a new group */
            create: async (name, participants, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "create",
                    body: { name, participants, ...(options ?? {}) },
                });
            },
            /** Demote participants from admin */
            demote: async (groupId, participants, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "demote",
                    body: { groupId, participants, ...(options ?? {}) },
                });
            },
            /** Update group description */
            description: async (groupId, text, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "description",
                    body: { groupId, text, ...(options ?? {}) },
                });
            },
            /** Show group metadata */
            info: async (groupId, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "info",
                    body: { groupId, ...(options ?? {}) },
                });
            },
            /** Get group invite link */
            invite: async (groupId, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "invite",
                    body: { groupId, ...(options ?? {}) },
                });
            },
            /** Join a group via invite link/code */
            join: async (code, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "join",
                    body: { code, ...(options ?? {}) },
                });
            },
            /** Leave a group */
            leave: async (groupId, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "leave",
                    body: { groupId, ...(options ?? {}) },
                });
            },
            /** List all groups the bot participates in */
            list: async (options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "list",
                    body: { ...(options ?? {}) },
                });
            },
            /** Promote participants to admin */
            promote: async (groupId, participants, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "promote",
                    body: { groupId, participants, ...(options ?? {}) },
                });
            },
            /** Remove participants from a group */
            remove: async (groupId, participants, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "remove",
                    body: { groupId, participants, ...(options ?? {}) },
                });
            },
            /** Rename a group */
            rename: async (groupId, name, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "rename",
                    body: { groupId, name, ...(options ?? {}) },
                });
            },
            /** Revoke current invite link */
            revokeInvite: async (groupId, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "revoke-invite",
                    body: { groupId, ...(options ?? {}) },
                });
            },
            /** Update group settings (announcement, not_announcement, locked, unlocked) */
            settings: async (groupId, setting, options) => {
                return this.transport.call({
                    groupSegments: ["whatsapp", "group"],
                    command: "settings",
                    body: { groupId, setting, ...(options ?? {}) },
                });
            }
        }
    };
    workflows = {
        runs: {
            /** Archive one node run from workflow aggregate state */
            archiveNode: async (runId, nodeKey) => {
                return this.transport.call({
                    groupSegments: ["workflows", "runs"],
                    command: "archive-node",
                    body: { runId, nodeKey },
                });
            },
            /** Cancel one workflow node run */
            cancel: async (runId, nodeKey) => {
                return this.transport.call({
                    groupSegments: ["workflows", "runs"],
                    command: "cancel",
                    body: { runId, nodeKey },
                });
            },
            /** List workflow runs */
            list: async () => {
                return this.transport.call({
                    groupSegments: ["workflows", "runs"],
                    command: "list",
                    body: {},
                });
            },
            /** Release a manual node transition or gate */
            release: async (runId, nodeKey) => {
                return this.transport.call({
                    groupSegments: ["workflows", "runs"],
                    command: "release",
                    body: { runId, nodeKey },
                });
            },
            /** Show one workflow run with node state */
            show: async (runId) => {
                return this.transport.call({
                    groupSegments: ["workflows", "runs"],
                    command: "show",
                    body: { runId },
                });
            },
            /** Skip one optional workflow node */
            skip: async (runId, nodeKey) => {
                return this.transport.call({
                    groupSegments: ["workflows", "runs"],
                    command: "skip",
                    body: { runId, nodeKey },
                });
            },
            /** Instantiate one workflow run from a spec */
            start: async (specId, options) => {
                return this.transport.call({
                    groupSegments: ["workflows", "runs"],
                    command: "start",
                    body: { specId, ...(options ?? {}) },
                });
            },
            /** Attach an existing task to a workflow task node */
            taskAttach: async (runId, nodeKey, taskId) => {
                return this.transport.call({
                    groupSegments: ["workflows", "runs"],
                    command: "task-attach",
                    body: { runId, nodeKey, taskId },
                });
            },
            /** Create a new task attempt for one workflow task node */
            taskCreate: async (runId, nodeKey, options) => {
                return this.transport.call({
                    groupSegments: ["workflows", "runs"],
                    command: "task-create",
                    body: { runId, nodeKey, ...(options ?? {}) },
                });
            }
        },
        specs: {
            /** Create one workflow spec from narrow JSON definition */
            create: async (specId, options) => {
                return this.transport.call({
                    groupSegments: ["workflows", "specs"],
                    command: "create",
                    body: { specId, ...(options ?? {}) },
                });
            },
            /** List workflow specs */
            list: async () => {
                return this.transport.call({
                    groupSegments: ["workflows", "specs"],
                    command: "list",
                    body: {},
                });
            },
            /** Show one workflow spec */
            show: async (specId) => {
                return this.transport.call({
                    groupSegments: ["workflows", "specs"],
                    command: "show",
                    body: { specId },
                });
            }
        }
    };
}
//# sourceMappingURL=client.js.map