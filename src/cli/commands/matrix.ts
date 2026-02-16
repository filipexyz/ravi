/**
 * Matrix Commands - Matrix channel CLI management
 *
 * Provides account management, messaging, and room commands for Matrix.
 * Supports both regular users and agent accounts.
 */

import "reflect-metadata";
import readline from "node:readline";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  listAccountIds,
  loadAllCredentials,
} from "../../channels/matrix/credentials.js";
import {
  isMatrixConfigured,
} from "../../channels/matrix/config.js";
import { sessionManager } from "../../channels/matrix/session.js";
import { getAgent, getAllAgents } from "../../router/index.js";
import {
  dbGetMatrixAccount,
  dbListMatrixAccounts,
  dbUpsertMatrixAccount,
  dbDeleteMatrixAccount,
  dbListAgents,
  type MatrixAccount,
} from "../../router/router-db.js";
import { fetchWithTimeout } from "../../utils/paths.js";

/**
 * Validate that an agent exists in the router
 */
function validateAgent(agentId: string): void {
  const agent = getAgent(agentId);
  if (!agent) {
    fail(`Agent "${agentId}" not found. Run 'ravi agents list' or create one with 'ravi agents create <id> <cwd>'`);
  }
}

/**
 * Get Matrix account credentials from unified SQLite storage
 */
function getAccountCredentials(username: string): MatrixAccount | null {
  return dbGetMatrixAccount(username);
}

/**
 * List all available Matrix accounts from unified SQLite storage
 */
function listAllAccounts(): Array<MatrixAccount & { isAgent: boolean }> {
  const dbAccounts = dbListMatrixAccounts();
  const agents = dbListAgents();
  const agentMatrixUsernames = new Set(agents.map(a => a.matrixAccount).filter(Boolean));

  return dbAccounts.map(acc => ({
    ...acc,
    isAgent: agentMatrixUsernames.has(acc.username),
  }));
}

/**
 * Prompt for input
 */
async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    if (hidden) {
      // For password input, we need to handle it specially
      process.stdout.write(question);
      let input = "";

      const onData = (char: Buffer) => {
        const c = char.toString();
        if (c === "\n" || c === "\r") {
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          console.log();
          rl.close();
          resolve(input);
        } else if (c === "\u0003") {
          // Ctrl+C
          process.exit(1);
        } else if (c === "\u007F" || c === "\b") {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += c;
        }
      };

      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * Register a new Matrix user via the homeserver API
 */
async function registerUser(
  homeserver: string,
  username: string,
  password: string,
  adminToken?: string
): Promise<{ userId: string; accessToken: string; deviceId?: string }> {
  // Try registration with shared secret or open registration
  const registerUrl = `${homeserver}/_matrix/client/v3/register`;

  // First, get registration flows
  const flowsResponse = await fetchWithTimeout(registerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  const flowsData = (await flowsResponse.json()) as {
    session?: string;
    flows?: Array<{ stages: string[] }>;
  };

  // Check if dummy auth is available (open registration)
  const hasDummy = flowsData.flows?.some((f) =>
    f.stages.includes("m.login.dummy")
  );

  if (!hasDummy && !adminToken) {
    throw new Error(
      "Registration requires authentication. Use --admin-token or configure open registration on the server."
    );
  }

  // Try to register
  const registerResponse = await fetchWithTimeout(registerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
    },
    body: JSON.stringify({
      username,
      password,
      auth: flowsData.session
        ? {
            type: "m.login.dummy",
            session: flowsData.session,
          }
        : undefined,
      initial_device_display_name: `Ravi Bot (${username})`,
    }),
  });

  if (!registerResponse.ok) {
    const error = (await registerResponse.json()) as { error?: string };
    throw new Error(error.error || registerResponse.statusText);
  }

  const data = (await registerResponse.json()) as {
    user_id: string;
    access_token: string;
    device_id?: string;
  };

  return {
    userId: data.user_id,
    accessToken: data.access_token,
    deviceId: data.device_id,
  };
}

/**
 * Login to an existing Matrix account
 */
async function loginUser(
  homeserver: string,
  username: string,
  password: string
): Promise<{ userId: string; accessToken: string; deviceId?: string }> {
  const loginUrl = `${homeserver}/_matrix/client/v3/login`;

  const response = await fetchWithTimeout(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: {
        type: "m.id.user",
        user: username,
      },
      password,
      initial_device_display_name: `Ravi Bot (${username})`,
    }),
  });

  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new Error(error.error || response.statusText);
  }

  const data = (await response.json()) as {
    user_id: string;
    access_token: string;
    device_id?: string;
  };

  return {
    userId: data.user_id,
    accessToken: data.access_token,
    deviceId: data.device_id,
  };
}

/**
 * Remove shell escapes from text (zsh adds \ before !)
 */
function removeShellEscapes(text: string): string {
  return text.replace(/\\!/g, "!");
}

/**
 * Normalize a room ID - removes shell escapes and handles encoding
 */
function normalizeRoomId(roomId: string): string {
  let normalized = removeShellEscapes(roomId);
  // If already encoded, decode first for consistency
  if (normalized.startsWith("%21")) {
    normalized = decodeURIComponent(normalized);
  }
  return normalized;
}

/**
 * Encode a room ID for use in URL paths
 */
function encodeRoomId(roomId: string): string {
  const normalized = normalizeRoomId(roomId);
  return encodeURIComponent(normalized);
}


@Group({
  name: "matrix",
  description: "Matrix channel management",
  scope: "admin",
})
export class MatrixCommands {
  @Command({ name: "register", description: "Register a new Matrix account for an agent" })
  async register(
    @Arg("agent", { required: true, description: "Agent ID to create Matrix account for" }) agentId: string,
    @Option({ flags: "-h, --homeserver <url>", description: "Matrix homeserver URL" }) homeserver?: string,
    @Option({ flags: "-u, --username <name>", description: "Matrix username (default: agent ID)" }) username?: string,
    @Option({ flags: "-p, --password <pass>", description: "Password for the new account" }) password?: string
  ) {
    console.log("\nMatrix Account Registration");
    console.log("───────────────────────────\n");

    // Verify agent exists
    validateAgent(agentId);

    // Check if already has credentials
    const existing = loadCredentials(agentId);
    if (existing) {
      console.log(`Agent "${agentId}" already has Matrix credentials:`);
      console.log(`  User ID: ${existing.userId}`);
      console.log(`  Homeserver: ${existing.homeserver}`);
      console.log(`\nTo use a different account, first run: ravi matrix logout ${agentId}`);
      return;
    }

    // Get homeserver
    let resolvedHomeserver = homeserver;
    if (!resolvedHomeserver) {
      // Try from env
      resolvedHomeserver = process.env.MATRIX_HOMESERVER;
    }
    if (!resolvedHomeserver) {
      // Try from existing credentials (use same server as other accounts)
      const store = loadAllCredentials();
      if (store) {
        const firstAccount = Object.values(store.accounts)[0];
        if (firstAccount) {
          resolvedHomeserver = firstAccount.homeserver;
          console.log(`Using homeserver from existing accounts: ${resolvedHomeserver}\n`);
        }
      }
    }
    if (!resolvedHomeserver) {
      resolvedHomeserver = await prompt("Homeserver URL (e.g., http://localhost:8008): ");
    }
    resolvedHomeserver = resolvedHomeserver.trim();
    if (!resolvedHomeserver) {
      fail("Error: Homeserver URL is required");
    }

    // Use agent ID as default username
    const resolvedUsername = username?.trim() || agentId;

    // Get password
    let resolvedPassword = password;
    if (!resolvedPassword) {
      resolvedPassword = await prompt(`Password for @${resolvedUsername}: `, true);
    }
    if (!resolvedPassword) {
      fail("Error: Password is required");
    }

    console.log(`\nRegistering @${resolvedUsername} on ${resolvedHomeserver}...`);

    try {
      // Try to register new user
      const result = await registerUser(
        resolvedHomeserver,
        resolvedUsername,
        resolvedPassword
      );

      // Save credentials
      saveCredentials(agentId, {
        homeserver: resolvedHomeserver,
        accessToken: result.accessToken,
        userId: result.userId,
        deviceId: result.deviceId,
      });

      console.log(`\n✓ Registered ${result.userId}`);
      console.log(`  Device ID: ${result.deviceId || "unknown"}`);
      console.log(`  Credentials saved for agent: ${agentId}`);
      console.log(`\nRestart the daemon to activate: ravi daemon restart`);
    } catch (err) {
      // Registration failed, try login (user might already exist)
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (errorMsg.includes("User ID already taken") || errorMsg.includes("M_USER_IN_USE")) {
        console.log(`\nUser @${resolvedUsername} already exists, trying login...`);

        try {
          const result = await loginUser(
            resolvedHomeserver,
            resolvedUsername,
            resolvedPassword
          );

          // Save credentials
          saveCredentials(agentId, {
            homeserver: resolvedHomeserver,
            accessToken: result.accessToken,
            userId: result.userId,
            deviceId: result.deviceId,
          });

          console.log(`\n✓ Logged in as ${result.userId}`);
          console.log(`  Device ID: ${result.deviceId || "unknown"}`);
          console.log(`  Credentials saved for agent: ${agentId}`);
          console.log(`\nRestart the daemon to activate: ravi daemon restart`);
        } catch (loginErr) {
          fail(`Login failed: ${loginErr instanceof Error ? loginErr.message : loginErr}`);
        }
      } else {
        fail(`Registration failed: ${errorMsg}`);
      }
    }
  }

  @Command({ name: "login", description: "Login to Matrix homeserver for an agent" })
  async login(
    @Arg("agent", { required: true, description: "Agent ID to login with" }) agentId: string,
    @Option({ flags: "-h, --homeserver <url>", description: "Matrix homeserver URL" }) homeserver?: string,
    @Option({ flags: "-u, --username <name>", description: "Username or user ID" }) username?: string
  ) {
    console.log("\nMatrix Login");
    console.log("────────────\n");

    // Validate agent exists
    validateAgent(agentId);

    // Check if already have credentials
    const existing = loadCredentials(agentId);
    if (existing) {
      console.log(`Agent "${agentId}" already logged in as ${existing.userId}`);
      console.log(`Homeserver: ${existing.homeserver}`);
      console.log(`\nTo use a different account, run: ravi matrix logout ${agentId}`);
      return;
    }

    // Get homeserver
    let resolvedHomeserver = homeserver;
    if (!resolvedHomeserver) {
      // Try from existing credentials (use same server as other accounts)
      const store = loadAllCredentials();
      if (store) {
        const firstAccount = Object.values(store.accounts)[0];
        if (firstAccount) {
          resolvedHomeserver = firstAccount.homeserver;
          console.log(`Using homeserver from existing accounts: ${resolvedHomeserver}\n`);
        }
      }
    }
    if (!resolvedHomeserver) {
      resolvedHomeserver = await prompt("Homeserver URL (e.g., https://matrix.org): ");
    }
    resolvedHomeserver = resolvedHomeserver.trim();
    if (!resolvedHomeserver) {
      fail("Error: Homeserver URL is required");
    }

    // Ensure https (unless localhost)
    if (!resolvedHomeserver.startsWith("http://") && !resolvedHomeserver.startsWith("https://")) {
      resolvedHomeserver = `https://${resolvedHomeserver}`;
    }

    // Get username
    let resolvedUsername = username;
    if (!resolvedUsername) {
      resolvedUsername = await prompt("Username or user ID: ");
    }
    resolvedUsername = resolvedUsername.trim();
    if (!resolvedUsername) {
      fail("Error: Username is required");
    }

    // Format as full user ID if needed
    let userId = resolvedUsername;
    if (!userId.startsWith("@")) {
      // Extract server from homeserver URL
      try {
        const url = new URL(resolvedHomeserver);
        userId = `@${userId}:${url.host}`;
      } catch {
        fail("Error: Invalid homeserver URL");
      }
    }

    // Get password
    const password = await prompt("Password: ", true);
    if (!password) {
      fail("Error: Password is required");
    }

    console.log("\nLogging in...");

    try {
      const result = await loginUser(resolvedHomeserver, userId, password);

      // Save credentials for this agent
      saveCredentials(agentId, {
        homeserver: resolvedHomeserver,
        accessToken: result.accessToken,
        userId: result.userId,
        deviceId: result.deviceId,
      });

      console.log(`\n✓ Logged in as ${result.userId}`);
      console.log(`  Agent: ${agentId}`);
      console.log(`  Device ID: ${result.deviceId || "unknown"}`);
      console.log("\nRestart the daemon to activate: ravi daemon restart");
    } catch (err) {
      fail(`Login failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "status", description: "Show Matrix connection status" })
  async status(
    @Arg("agent", { required: false, description: "Agent ID (shows all if not specified)" }) agentId?: string
  ) {
    console.log("\nMatrix Status");
    console.log("─────────────\n");

    // If specific agent requested, validate it exists
    if (agentId) {
      validateAgent(agentId);
    }

    const agentIds = agentId ? [agentId] : listAccountIds();

    if (agentIds.length === 0) {
      console.log("No Matrix accounts configured");
      console.log("\nTo add an account: ravi matrix register <agent>");
      return;
    }

    for (const id of agentIds) {
      const credentials = loadCredentials(id);
      if (!credentials) {
        console.log(`${id}: Not configured`);
        continue;
      }

      console.log(`Agent: ${id}`);
      console.log(`  User ID:     ${credentials.userId}`);
      console.log(`  Homeserver:  ${credentials.homeserver}`);
      console.log(`  Device ID:   ${credentials.deviceId || "unknown"}`);
      console.log(`  Created:     ${credentials.createdAt}`);
      console.log(`  Last Used:   ${credentials.lastUsedAt || "never"}`);

      // Check session state
      const state = sessionManager.getState(id);
      console.log(`  Session:     ${state}`);

      if (state === "connected") {
        const userId = sessionManager.getUserId(id);
        console.log(`  Connected:   ${userId}`);
      }

      console.log();
    }

    // Check environment config
    const isConfigured = isMatrixConfigured();
    console.log(`Environment: ${isConfigured ? "configured" : "not configured"}`);
  }

  @Command({ name: "logout", description: "Clear Matrix credentials for an agent" })
  async logout(
    @Arg("agent", { required: true, description: "Agent ID" }) agentId: string
  ) {
    // Validate agent exists
    validateAgent(agentId);

    const credentials = loadCredentials(agentId);
    if (!credentials) {
      console.log(`No Matrix credentials for agent: ${agentId}`);
      return;
    }

    // Stop session if running
    const state = sessionManager.getState(agentId);
    if (state !== "disconnected") {
      console.log("Stopping session...");
      await sessionManager.stop(agentId);
    }

    // Clear credentials
    clearCredentials(agentId);
    console.log(`✓ Logged out from ${credentials.userId} (agent: ${agentId})`);
    console.log(`\nTo login again: ravi matrix login ${agentId}`);
  }

  @Command({ name: "accounts", description: "List all Matrix accounts" })
  async accounts() {
    console.log("\nMatrix Accounts");
    console.log("───────────────\n");

    const store = loadAllCredentials();
    if (!store || Object.keys(store.accounts).length === 0) {
      console.log("No accounts configured");
      console.log("\nTo add an account: ravi matrix register <agent>");
      return;
    }

    console.log("  AGENT            USER ID                    HOMESERVER");
    console.log("  ───────────────  ─────────────────────────  ────────────────────────────");

    for (const [agentId, creds] of Object.entries(store.accounts)) {
      const agent = agentId.padEnd(15);
      const userId = creds.userId.length > 25 ? creds.userId.slice(0, 22) + "..." : creds.userId.padEnd(25);
      const homeserver = creds.homeserver.length > 28 ? creds.homeserver.slice(0, 25) + "..." : creds.homeserver;

      console.log(`  ${agent}  ${userId}  ${homeserver}`);
    }

    console.log(`\n  Total: ${Object.keys(store.accounts).length} account(s)`);
  }

  @Command({ name: "rooms", description: "List joined Matrix rooms" })
  async rooms(
    @Arg("account", { required: true, description: "Account username (user or agent)" }) accountName: string
  ) {
    const credentials = getAccountCredentials(accountName);
    if (!credentials) {
      console.error(`No Matrix account found: ${accountName}`);
      console.log(`\nAdd account: ravi matrix users-add ${accountName} -p <password>`);
      return;
    }

    console.log(`\nJoined Rooms (${credentials.userId})`);
    console.log("─".repeat(40) + "\n");

    try {
      // Get joined rooms via API
      const url = `${credentials.homeserver}/_matrix/client/v3/joined_rooms`;
      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
        },
      });

      if (!response.ok) {
        console.error(`Failed to fetch rooms: ${response.statusText}`);
        return;
      }

      const data = (await response.json()) as { joined_rooms: string[] };
      const rooms = data.joined_rooms;

      if (rooms.length === 0) {
        console.log("No rooms joined");
        return;
      }

      console.log(`  ID                                           NAME`);
      console.log(`  ───────────────────────────────────────────  ────────────────────────────`);

      // Fetch room names
      for (const roomId of rooms) {
        let name = "(unnamed)";
        try {
          const stateUrl = `${credentials.homeserver}/_matrix/client/v3/rooms/${encodeRoomId(roomId)}/state/m.room.name`;
          const stateResponse = await fetchWithTimeout(stateUrl, {
            headers: {
              Authorization: `Bearer ${credentials.accessToken}`,
            },
          });
          if (stateResponse.ok) {
            const stateData = (await stateResponse.json()) as { name?: string };
            if (stateData.name) {
              name = stateData.name;
            }
          }
        } catch {
          // Ignore errors fetching room name
        }

        // Truncate for display
        const displayId = roomId.length > 45 ? roomId.slice(0, 42) + "..." : roomId.padEnd(45);
        const displayName = name.length > 28 ? name.slice(0, 25) + "..." : name;

        console.log(`  ${displayId}  ${displayName}`);
      }

      console.log(`\n  Total: ${rooms.length}`);
    } catch (err) {
      console.error(`Failed to list rooms: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "send", description: "Send a message from a Matrix account" })
  async send(
    @Arg("account", { required: true, description: "Account username (user or agent)" }) accountName: string,
    @Arg("target", { required: true, description: "Room ID, alias, or user ID" }) target: string,
    @Arg("message", { required: true, description: "Message to send" }) message: string
  ) {
    const credentials = getAccountCredentials(accountName);
    if (!credentials) {
      fail(`No Matrix account found: ${accountName}. Add with: ravi matrix users-add ${accountName} -p <password>`);
    }

    try {
      // Resolve target to room ID
      let roomId = target;

      // If target is a user ID, create/get DM room
      if (target.startsWith("@")) {
        console.log(`Creating/finding DM with ${target}...`);
        const createResponse = await fetchWithTimeout(
          `${credentials.homeserver}/_matrix/client/v3/createRoom`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${credentials.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              is_direct: true,
              invite: [target],
              preset: "trusted_private_chat",
            }),
          }
        );

        if (!createResponse.ok) {
          const error = (await createResponse.json()) as { error?: string };
          throw new Error(error.error || createResponse.statusText);
        }

        const data = (await createResponse.json()) as { room_id: string };
        roomId = data.room_id;
        console.log(`Room: ${roomId}`);
      }

      // Send message
      const txnId = `cli_${Date.now()}`;
      const cleanMessage = removeShellEscapes(message);
      const sendResponse = await fetchWithTimeout(
        `${credentials.homeserver}/_matrix/client/v3/rooms/${encodeRoomId(roomId)}/send/m.room.message/${txnId}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            msgtype: "m.text",
            body: cleanMessage,
          }),
        }
      );

      if (!sendResponse.ok) {
        const error = (await sendResponse.json()) as { error?: string };
        throw new Error(error.error || sendResponse.statusText);
      }

      const result = (await sendResponse.json()) as { event_id: string };
      console.log(`✓ Sent from ${credentials.userId}`);
      console.log(`  Event ID: ${result.event_id}`);
    } catch (err) {
      fail(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "messages", description: "Show recent messages in a room" })
  async messages(
    @Arg("account", { required: true, description: "Account username (user or agent)" }) accountName: string,
    @Arg("room", { required: true, description: "Room ID or alias" }) roomId: string,
    @Option({ flags: "-n, --limit <count>", description: "Number of messages", defaultValue: "10" }) limit?: string
  ) {
    const credentials = getAccountCredentials(accountName);
    if (!credentials) {
      fail(`No Matrix account found: ${accountName}. Add with: ravi matrix users-add ${accountName} -p <password>`);
    }

    try {
      // Get messages
      const url = `${credentials.homeserver}/_matrix/client/v3/rooms/${encodeRoomId(roomId)}/messages?dir=b&limit=${limit}`;
      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
        },
      });

      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error || response.statusText);
      }

      const data = (await response.json()) as {
        chunk: Array<{
          type: string;
          sender: string;
          content: { msgtype?: string; body?: string };
          origin_server_ts: number;
        }>;
      };

      console.log(`\nMessages in ${normalizeRoomId(roomId)}`);
      console.log("─".repeat(60) + "\n");

      // Filter to m.room.message events and reverse for chronological order
      const messages = data.chunk
        .filter((e) => e.type === "m.room.message")
        .reverse();

      if (messages.length === 0) {
        console.log("No messages found");
        return;
      }

      for (const msg of messages) {
        const time = new Date(msg.origin_server_ts).toLocaleTimeString("pt-BR");
        const sender = msg.sender.split(":")[0]?.replace("@", "") || msg.sender;
        const body = msg.content.body || "[no body]";
        const preview = body.length > 80 ? body.slice(0, 77) + "..." : body;

        console.log(`[${time}] ${sender}: ${preview.replace(/\n/g, " ")}`);
      }

      console.log(`\nTotal: ${messages.length} message(s)`);
    } catch (err) {
      fail(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "invite", description: "Invite an account to a room" })
  async invite(
    @Arg("target", { required: true, description: "Account username or user ID to invite" }) target: string,
    @Arg("room", { required: true, description: "Room ID or alias" }) roomId: string,
    @Option({ flags: "--from <account>", description: "Account to send invite from (required)" }) fromAccount?: string
  ) {
    if (!fromAccount) {
      fail("Error: --from <account> is required. Usage: ravi matrix invite <target> <room> --from <account>");
    }

    const fromCreds = getAccountCredentials(fromAccount);
    if (!fromCreds) {
      fail(`No Matrix account found: ${fromAccount}. Add with: ravi matrix users-add ${fromAccount} -p <password>`);
    }

    // Resolve target user ID
    let targetUserId = target;
    if (!target.startsWith("@")) {
      const targetCreds = getAccountCredentials(target);
      if (!targetCreds) {
        fail(`No Matrix account found: ${target}. Add with: ravi matrix users-add ${target} -p <password>`);
      }
      targetUserId = targetCreds.userId;
    }

    try {
      // Send invite
      const response = await fetchWithTimeout(
        `${fromCreds.homeserver}/_matrix/client/v3/rooms/${encodeRoomId(roomId)}/invite`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fromCreds.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            user_id: targetUserId,
          }),
        }
      );

      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error || response.statusText);
      }

      console.log(`✓ Invited ${targetUserId} to ${roomId}`);
    } catch (err) {
      fail(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "join", description: "Join a room" })
  async join(
    @Arg("account", { required: true, description: "Account username" }) accountName: string,
    @Arg("room", { required: true, description: "Room ID or alias" }) roomId: string
  ) {
    const credentials = getAccountCredentials(accountName);
    if (!credentials) {
      fail(`No Matrix account found: ${accountName}. Add with: ravi matrix users-add ${accountName} -p <password>`);
    }

    try {
      const response = await fetchWithTimeout(
        `${credentials.homeserver}/_matrix/client/v3/join/${encodeRoomId(roomId)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        }
      );

      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error || response.statusText);
      }

      const data = (await response.json()) as { room_id: string };
      console.log(`✓ Joined ${data.room_id} as ${credentials.userId}`);
    } catch (err) {
      fail(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "dm", description: "Create or get a DM room between two accounts" })
  async dm(
    @Arg("from", { required: true, description: "Account username to create DM from" }) fromAccount: string,
    @Arg("to", { required: true, description: "Account username or user ID to DM" }) toTarget: string
  ) {
    const fromCreds = getAccountCredentials(fromAccount);
    if (!fromCreds) {
      fail(`No Matrix account found: ${fromAccount}. Add with: ravi matrix users-add ${fromAccount} -p <password>`);
    }

    // Resolve target user ID
    let targetUserId = toTarget;
    if (!toTarget.startsWith("@")) {
      // It's an account username, get credentials
      const toCreds = getAccountCredentials(toTarget);
      if (!toCreds) {
        fail(`No Matrix account found: ${toTarget}. Add with: ravi matrix users-add ${toTarget} -p <password>`);
      }
      targetUserId = toCreds.userId;
    }

    try {
      const response = await fetchWithTimeout(
        `${fromCreds.homeserver}/_matrix/client/v3/createRoom`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fromCreds.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            is_direct: true,
            invite: [targetUserId],
            preset: "trusted_private_chat",
          }),
        }
      );

      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error || response.statusText);
      }

      const data = (await response.json()) as { room_id: string };
      console.log(`✓ DM room created/found`);
      console.log(`  Room ID: ${data.room_id}`);
      console.log(`  From: ${fromCreds.userId}`);
      console.log(`  To: ${targetUserId}`);
    } catch (err) {
      fail(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "users-list", description: "List all Matrix accounts" })
  async usersList() {
    console.log("\nMatrix Accounts");
    console.log("───────────────\n");

    const accounts = listAllAccounts();

    if (accounts.length === 0) {
      console.log("No accounts configured");
      console.log("\nTo add an account: ravi matrix users-add <username> -p <password>");
      return;
    }

    console.log("  USERNAME         USER ID                    AGENT");
    console.log("  ───────────────  ─────────────────────────  ─────");

    for (const acc of accounts) {
      const username = acc.username.length > 15 ? acc.username.slice(0, 12) + "..." : acc.username.padEnd(15);
      const userId = acc.userId.length > 25 ? acc.userId.slice(0, 22) + "..." : acc.userId.padEnd(25);
      const isAgent = acc.isAgent ? "yes" : "no";

      console.log(`  ${username}  ${userId}  ${isAgent}`);
    }

    console.log(`\n  Total: ${accounts.length} account(s)`);
  }

  @Command({ name: "users-add", description: "Add a Matrix account (login or register)" })
  async usersAdd(
    @Arg("username", { required: true, description: "Username for this account" }) username: string,
    @Option({ flags: "-p, --password <pass>", description: "Password (required)" }) password?: string,
    @Option({ flags: "-h, --homeserver <url>", description: "Homeserver URL" }) homeserver?: string
  ) {
    if (!password) {
      fail("Error: Password is required (-p <password>)");
    }

    // Get homeserver from existing accounts or use default
    let resolvedHomeserver = homeserver;
    if (!resolvedHomeserver) {
      const existingAccounts = listAllAccounts();
      if (existingAccounts.length > 0) {
        resolvedHomeserver = existingAccounts[0].homeserver;
        console.log(`Using homeserver: ${resolvedHomeserver}`);
      } else {
        resolvedHomeserver = "http://localhost:8008";
        console.log(`Using default homeserver: ${resolvedHomeserver}`);
      }
    }

    console.log(`\nLogging in as ${username}...`);

    try {
      // Try login first
      const result = await loginUser(resolvedHomeserver, username, password);

      // Save to database
      dbUpsertMatrixAccount({
        username,
        userId: result.userId,
        homeserver: resolvedHomeserver,
        accessToken: result.accessToken,
        deviceId: result.deviceId,
      });

      console.log(`\n✓ Added account: ${username}`);
      console.log(`  User ID: ${result.userId}`);
      console.log(`  Device ID: ${result.deviceId || "unknown"}`);
    } catch (loginErr) {
      // Try registration if login fails
      const loginErrMsg = loginErr instanceof Error ? loginErr.message : String(loginErr);

      if (loginErrMsg.includes("Invalid username or password") || loginErrMsg.includes("M_FORBIDDEN")) {
        console.log("Login failed, trying to register...");

        try {
          const result = await registerUser(resolvedHomeserver, username, password);

          dbUpsertMatrixAccount({
            username,
            userId: result.userId,
            homeserver: resolvedHomeserver,
            accessToken: result.accessToken,
            deviceId: result.deviceId,
          });

          console.log(`\n✓ Registered and added account: ${username}`);
          console.log(`  User ID: ${result.userId}`);
          console.log(`  Device ID: ${result.deviceId || "unknown"}`);
        } catch (regErr) {
          fail(`Failed to register: ${regErr instanceof Error ? regErr.message : regErr}`);
        }
      } else {
        fail(`Failed to login: ${loginErrMsg}`);
      }
    }
  }

  @Command({ name: "users-remove", description: "Remove a Matrix account" })
  async usersRemove(
    @Arg("username", { required: true, description: "Username to remove" }) username: string
  ) {
    const account = dbGetMatrixAccount(username);
    if (!account) {
      fail(`Account not found: ${username}`);
    }

    try {
      dbDeleteMatrixAccount(username);
      console.log(`✓ Removed account: ${username} (${account.userId})`);
    } catch (err) {
      fail(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "create-room", description: "Create a new Matrix room" })
  async createRoom(
    @Arg("account", { required: true, description: "Account username that creates the room" }) accountName: string,
    @Arg("name", { required: true, description: "Room name" }) roomName: string,
    @Option({ flags: "-i, --invite <users>", description: "Users to invite (comma-separated)" }) inviteList?: string,
    @Option({ flags: "-p, --public", description: "Make room public (default: private)" }) isPublic?: boolean,
    @Option({ flags: "-a, --alias <alias>", description: "Room alias (e.g., 'my-room' → #my-room:server)" }) alias?: string
  ) {
    const credentials = getAccountCredentials(accountName);
    if (!credentials) {
      console.error(`No Matrix account found: ${accountName}`);
      console.log(`\nAdd account: ravi matrix users-add ${accountName} -p <password>`);
      return;
    }

    try {
      // Parse invite list
      const invites = inviteList ? inviteList.split(",").map(u => u.trim()) : [];

      // Extract server from user ID for alias
      const server = credentials.userId.split(":")[1];

      // Create room
      const url = `${credentials.homeserver}/_matrix/client/v3/createRoom`;
      const body: Record<string, unknown> = {
        name: roomName,
        preset: isPublic ? "public_chat" : "private_chat",
        invite: invites,
      };

      if (alias) {
        body.room_alias_name = alias;
      }

      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error || response.statusText);
      }

      const data = (await response.json()) as { room_id: string; room_alias?: string };

      console.log("\n✓ Room created!");
      console.log(`  Name:     ${roomName}`);
      console.log(`  Room ID:  ${data.room_id}`);
      if (alias) {
        console.log(`  Alias:    #${alias}:${server}`);
      }
      if (invites.length > 0) {
        console.log(`  Invited:  ${invites.join(", ")}`);
      }
      console.log(`  Created by: ${credentials.userId}`);
    } catch (err) {
      fail(`Failed to create room: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "whoami", description: "Show current Matrix identity" })
  async whoami(
    @Arg("account", { required: true, description: "Account username" }) accountName: string
  ) {
    const credentials = getAccountCredentials(accountName);
    if (!credentials) {
      console.error(`No Matrix account found: ${accountName}`);
      console.log(`\nAdd account: ravi matrix users-add ${accountName} -p <password>`);
      return;
    }

    try {
      // Call whoami API
      const url = `${credentials.homeserver}/_matrix/client/v3/account/whoami`;
      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          console.log("Token expired or invalid.");
          console.log(`Run: ravi matrix users-remove ${accountName} && ravi matrix users-add ${accountName} -p <password>`);
        } else {
          console.error(`Failed: ${response.statusText}`);
        }
        return;
      }

      const data = (await response.json()) as {
        user_id: string;
        device_id?: string;
        is_guest?: boolean;
      };

      console.log(`Account:   ${accountName}`);
      console.log(`User ID:   ${data.user_id}`);
      console.log(`Device ID: ${data.device_id || "unknown"}`);
      console.log(`Guest:     ${data.is_guest ? "yes" : "no"}`);
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
