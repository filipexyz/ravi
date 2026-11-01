import "reflect-metadata";
import { z } from "zod";
import { Group, Command, CommandAccess, Returns, Arg, Option } from "../decorators.js";
import {
  desktopComputer,
  desktopLoops,
  desktopSetLoop,
  desktopChannels,
  desktopSetChannel,
  computerSchema,
  loopSchema,
  channelSchema,
} from "../../bridge/desktop-resources.js";
import { desktopSessionRead, desktopSessionConfigure, desktopSessionSchema } from "../../bridge/desktop-session.js";
import { RUNTIME_EFFORT_LEVELS } from "../../runtime/effort.js";
import { desktopWork, desktopWorkSchema } from "../../bridge/desktop-work.js";
import { BridgeError } from "../../bridge/protocol.js";
import { contractFail } from "../agent-contract.js";
async function invoke<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BridgeError)
      contractFail("desktop", error.code, error.code, { details: { effectState: error.effectState } });
    throw error;
  }
}

@Group({
  name: "desktop.computer",
  description: "Authorized conversation workspace and installation telemetry",
  scope: "resource",
})
export class DesktopComputerCommands {
  @Command({ name: "read", description: "Read bounded computer and conversation workspace telemetry" })
  @CommandAccess({
    kind: "read",
    resource: "desktop.computer",
    action: "read",
    risk: "low",
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(computerSchema)
  read(
    @Arg("conversationId", { required: true, schema: z.string().uuid() }) conversationId: string,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke(() => desktopComputer(conversationId));
  }
}
@Group({ name: "desktop.loops", description: "Authorized installation routine controls", scope: "resource" })
export class DesktopLoopsCommands {
  @Command({
    name: "list",
    description: "List agent-bound cron, trigger and heartbeat state without prompts or secrets",
  })
  @CommandAccess({
    kind: "read",
    resource: "desktop.loops",
    action: "list",
    risk: "low",
    localOperator: false,
    consoleOnly: true,
    consoleScope: "installation",
  })
  @Returns(z.array(loopSchema))
  list(@Option({ flags: "--json", description: "Print structured result" }) _asJson = false) {
    return invoke(() => desktopLoops());
  }
  @Command({ name: "set-enabled", description: "Set a permitted routine's enabled state" })
  @CommandAccess({
    kind: "mutate",
    resource: "desktop.loops",
    action: "set-enabled",
    risk: "high",
    localOperator: false,
    consoleOnly: true,
    consoleScope: "installation",
  })
  @Returns(z.array(loopSchema))
  setEnabled(
    @Arg("id", { required: true, schema: z.string().min(1).max(160) }) id: string,
    @Arg("enabled", { required: true, schema: z.boolean() }) enabled: boolean,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke(() => desktopSetLoop(id, enabled));
  }
}
@Group({
  name: "desktop.channels",
  description: "Configured native channel controls without credential access",
  scope: "resource",
})
export class DesktopChannelsCommands {
  @Command({ name: "list", description: "List configured native channels and observed availability" })
  @CommandAccess({
    kind: "read",
    resource: "desktop.channels",
    action: "list",
    risk: "low",
    localOperator: false,
    consoleOnly: true,
    consoleScope: "installation",
  })
  @Returns(z.array(channelSchema))
  list(@Option({ flags: "--json", description: "Print structured result" }) _asJson = false) {
    return invoke(() => desktopChannels());
  }
  @Command({ name: "set-enabled", description: "Enable or disable an already configured native channel" })
  @CommandAccess({
    kind: "mutate",
    resource: "desktop.channels",
    action: "set-enabled",
    risk: "high",
    localOperator: false,
    consoleOnly: true,
    consoleScope: "installation",
  })
  @Returns(z.array(channelSchema))
  setEnabled(
    @Arg("id", { required: true, schema: z.string().min(1).max(160) }) id: string,
    @Arg("enabled", { required: true, schema: z.boolean() }) enabled: boolean,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke(() => desktopSetChannel(id, enabled));
  }
}

@Group({ name: "desktop.session", description: "Current conversation runtime selection", scope: "resource" })
export class DesktopSessionCommands {
  @Command({ name: "read", description: "Read the effective model and supported selection for this conversation" })
  @CommandAccess({
    kind: "read",
    resource: "desktop.session",
    action: "read",
    risk: "low",
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(desktopSessionSchema)
  read(
    @Arg("conversationId", { required: true, schema: z.string().uuid() }) conversationId: string,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke(() => desktopSessionRead(conversationId));
  }
  @Command({ name: "configure", description: "Set this conversation model and effort for following turns" })
  @CommandAccess({
    kind: "mutate",
    resource: "desktop.session",
    action: "configure",
    risk: "medium",
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(desktopSessionSchema)
  configure(
    @Arg("conversationId", { required: true, schema: z.string().uuid() }) conversationId: string,
    @Arg("model", { required: true, schema: z.string().min(1).max(200) }) model: string,
    @Arg("effort", { required: true, schema: z.enum(RUNTIME_EFFORT_LEVELS) })
    effort: (typeof RUNTIME_EFFORT_LEVELS)[number],
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke(() => desktopSessionConfigure(conversationId, model, effort));
  }
}

@Group({ name: "desktop.work", description: "Work in the current conversation", scope: "resource" })
export class DesktopWorkCommands {
  @Command({ name: "list", description: "Read current turns, queued requests and agent handoffs in this conversation" })
  @CommandAccess({
    kind: "read",
    resource: "desktop.work",
    action: "list",
    risk: "low",
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(desktopWorkSchema)
  list(
    @Arg("conversationId", { required: true, schema: z.string().uuid() }) conversationId: string,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke(() => desktopWork(conversationId));
  }
}
