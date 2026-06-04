// GENERATED FILE - DO NOT EDIT.
// Run `ravi sdk swift generate` to regenerate.
// Drift is detected by `ravi sdk swift check`.

import Foundation

public final class RaviClient {
  private let transport: any RaviTransport

  public init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var adapters: AdaptersNamespace {
    AdaptersNamespace(transport: transport)
  }

  public var agents: AgentsNamespace {
    AgentsNamespace(transport: transport)
  }

  public var apps: AppsNamespace {
    AppsNamespace(transport: transport)
  }

  public var artifacts: ArtifactsNamespace {
    ArtifactsNamespace(transport: transport)
  }

  public var audio: AudioNamespace {
    AudioNamespace(transport: transport)
  }

  public var chats: ChatsNamespace {
    ChatsNamespace(transport: transport)
  }

  public var commands: CommandsNamespace {
    CommandsNamespace(transport: transport)
  }

  public var contacts: ContactsNamespace {
    ContactsNamespace(transport: transport)
  }

  public var context: ContextNamespace {
    ContextNamespace(transport: transport)
  }

  public var costs: CostsNamespace {
    CostsNamespace(transport: transport)
  }

  public var crm: CrmNamespace {
    CrmNamespace(transport: transport)
  }

  public var cron: CronNamespace {
    CronNamespace(transport: transport)
  }

  public var daemon: DaemonNamespace {
    DaemonNamespace(transport: transport)
  }

  public var devin: DevinNamespace {
    DevinNamespace(transport: transport)
  }

  public var eval: EvalNamespace {
    EvalNamespace(transport: transport)
  }

  public var heartbeat: HeartbeatNamespace {
    HeartbeatNamespace(transport: transport)
  }

  public var hooks: HooksNamespace {
    HooksNamespace(transport: transport)
  }

  public var image: ImageNamespace {
    ImageNamespace(transport: transport)
  }

  public var inbox: InboxNamespace {
    InboxNamespace(transport: transport)
  }

  public var insights: InsightsNamespace {
    InsightsNamespace(transport: transport)
  }

  public var instances: InstancesNamespace {
    InstancesNamespace(transport: transport)
  }

  public var media: MediaNamespace {
    MediaNamespace(transport: transport)
  }

  public var observers: ObserversNamespace {
    ObserversNamespace(transport: transport)
  }

  public var permissions: PermissionsNamespace {
    PermissionsNamespace(transport: transport)
  }

  public var projects: ProjectsNamespace {
    ProjectsNamespace(transport: transport)
  }

  public var prox: ProxNamespace {
    ProxNamespace(transport: transport)
  }

  public var react: ReactNamespace {
    ReactNamespace(transport: transport)
  }

  public var routes: RoutesNamespace {
    RoutesNamespace(transport: transport)
  }

  public var rules: RulesNamespace {
    RulesNamespace(transport: transport)
  }

  public var runtime: RuntimeNamespace {
    RuntimeNamespace(transport: transport)
  }

  public var sdk: SdkNamespace {
    SdkNamespace(transport: transport)
  }

  public var self_: SelfNamespace {
    SelfNamespace(transport: transport)
  }

  public var service: ServiceNamespace {
    ServiceNamespace(transport: transport)
  }

  public var sessions: SessionsNamespace {
    SessionsNamespace(transport: transport)
  }

  public var settings: SettingsNamespace {
    SettingsNamespace(transport: transport)
  }

  public var skillGates: SkillGatesNamespace {
    SkillGatesNamespace(transport: transport)
  }

  public var skills: SkillsNamespace {
    SkillsNamespace(transport: transport)
  }

  public var specs: SpecsNamespace {
    SpecsNamespace(transport: transport)
  }

  public var stickers: StickersNamespace {
    StickersNamespace(transport: transport)
  }

  public var tagRules: TagRulesNamespace {
    TagRulesNamespace(transport: transport)
  }

  public var tags: TagsNamespace {
    TagsNamespace(transport: transport)
  }

  public var tasks: TasksNamespace {
    TasksNamespace(transport: transport)
  }

  public var threads: ThreadsNamespace {
    ThreadsNamespace(transport: transport)
  }

  public var tools: ToolsNamespace {
    ToolsNamespace(transport: transport)
  }

  public var transcribe: TranscribeNamespace {
    TranscribeNamespace(transport: transport)
  }

  public var triggers: TriggersNamespace {
    TriggersNamespace(transport: transport)
  }

  public var video: VideoNamespace {
    VideoNamespace(transport: transport)
  }

  public var watch: WatchNamespace {
    WatchNamespace(transport: transport)
  }

  public var whatsapp: WhatsappNamespace {
    WhatsappNamespace(transport: transport)
  }

  public var workflows: WorkflowsNamespace {
    WorkflowsNamespace(transport: transport)
  }

}

public struct AdaptersNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func list(_ options: AdaptersListOptions = .init()) async throws -> AdaptersListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["adapters"], command: "list", body: requestBody, as: AdaptersListReturn.self)
  }

  public func show(_ adapterId: String) async throws -> AdaptersShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["adapterId"] = try RaviJSON.fromEncodable(adapterId)
    return try await transport.call(groupSegments: ["adapters"], command: "show", body: requestBody, as: AdaptersShowReturn.self)
  }
}

public struct AgentsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func create(_ id: String, _ cwd: String, _ options: AgentsCreateOptions = .init()) async throws -> AgentsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["cwd"] = try RaviJSON.fromEncodable(cwd)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["agents"], command: "create", body: requestBody, as: AgentsCreateReturn.self)
  }

  public func debounce(_ id: String, _ ms: String? = nil) async throws -> AgentsDebounceReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    if let ms {
      requestBody["ms"] = try RaviJSON.fromEncodable(ms)
    }
    return try await transport.call(groupSegments: ["agents"], command: "debounce", body: requestBody, as: AgentsDebounceReturn.self)
  }

  public func debug(_ id: String, _ nameOrKey: String? = nil, _ options: AgentsDebugOptions = .init()) async throws -> AgentsDebugReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    if let nameOrKey {
      requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["agents"], command: "debug", body: requestBody, as: AgentsDebugReturn.self)
  }

  public func delete(_ id: String) async throws -> AgentsDeleteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["agents"], command: "delete", body: requestBody, as: AgentsDeleteReturn.self)
  }

  public func list(_ options: AgentsListOptions = .init()) async throws -> AgentsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["agents"], command: "list", body: requestBody, as: AgentsListReturn.self)
  }

  public func reset(_ id: String, _ nameOrKey: String? = nil) async throws -> AgentsResetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    if let nameOrKey {
      requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    }
    return try await transport.call(groupSegments: ["agents"], command: "reset", body: requestBody, as: AgentsResetReturn.self)
  }

  public func session(_ id: String) async throws -> AgentsSessionReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["agents"], command: "session", body: requestBody, as: AgentsSessionReturn.self)
  }

  public func set(_ id: String, _ key: String, _ value: String) async throws -> AgentsSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["agents"], command: "set", body: requestBody, as: AgentsSetReturn.self)
  }

  public func show(_ id: String) async throws -> AgentsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["agents"], command: "show", body: requestBody, as: AgentsShowReturn.self)
  }

  public func specMode(_ id: String, _ enabled: String? = nil) async throws -> AgentsSpecModeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    if let enabled {
      requestBody["enabled"] = try RaviJSON.fromEncodable(enabled)
    }
    return try await transport.call(groupSegments: ["agents"], command: "spec-mode", body: requestBody, as: AgentsSpecModeReturn.self)
  }

  public func syncInstructions(_ options: AgentsSyncInstructionsOptions = .init()) async throws -> AgentsSyncInstructionsReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["agents"], command: "sync-instructions", body: requestBody, as: AgentsSyncInstructionsReturn.self)
  }
}

public struct AppsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func check(_ id: String? = nil) async throws -> AppsCheckReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let id {
      requestBody["id"] = try RaviJSON.fromEncodable(id)
    }
    return try await transport.call(groupSegments: ["apps"], command: "check", body: requestBody, as: AppsCheckReturn.self)
  }

  public func list(_ options: AppsListOptions = .init()) async throws -> AppsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["apps"], command: "list", body: requestBody, as: AppsListReturn.self)
  }

  public func show(_ id: String) async throws -> AppsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["apps"], command: "show", body: requestBody, as: AppsShowReturn.self)
  }
}

public struct ArtifactsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var release: ArtifactsReleaseNamespace {
    ArtifactsReleaseNamespace(transport: transport)
  }

  public func archive(_ id: String) async throws -> ArtifactsArchiveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["artifacts"], command: "archive", body: requestBody, as: ArtifactsArchiveReturn.self)
  }

  public func attach(_ id: String, _ targetType: String, _ targetId: String, _ options: ArtifactsAttachOptions = .init()) async throws -> ArtifactsAttachReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["targetType"] = try RaviJSON.fromEncodable(targetType)
    requestBody["targetId"] = try RaviJSON.fromEncodable(targetId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts"], command: "attach", body: requestBody, as: ArtifactsAttachReturn.self)
  }

  public func blob(_ id: String) async throws -> ArtifactsBlobReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.callBinary(groupSegments: ["artifacts"], command: "blob", body: requestBody)
  }

  public func create(_ options: ArtifactsCreateOptions = .init()) async throws -> ArtifactsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts"], command: "create", body: requestBody, as: ArtifactsCreateReturn.self)
  }

  public func event(_ id: String, _ eventType: String, _ options: ArtifactsEventOptions = .init()) async throws -> ArtifactsEventReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["eventType"] = try RaviJSON.fromEncodable(eventType)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts"], command: "event", body: requestBody, as: ArtifactsEventReturn.self)
  }

  public func events(_ id: String) async throws -> ArtifactsEventsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["artifacts"], command: "events", body: requestBody, as: ArtifactsEventsReturn.self)
  }

  public func list(_ options: ArtifactsListOptions = .init()) async throws -> ArtifactsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts"], command: "list", body: requestBody, as: ArtifactsListReturn.self)
  }

  public func publish(_ target: String, _ options: ArtifactsPublishOptions = .init()) async throws -> ArtifactsPublishReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts"], command: "publish", body: requestBody, as: ArtifactsPublishReturn.self)
  }

  public func restore(_ id: String, _ options: ArtifactsRestoreOptions = .init()) async throws -> ArtifactsRestoreReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts"], command: "restore", body: requestBody, as: ArtifactsRestoreReturn.self)
  }

  public func show(_ id: String) async throws -> ArtifactsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["artifacts"], command: "show", body: requestBody, as: ArtifactsShowReturn.self)
  }

  public func snapshot(_ id: String, _ options: ArtifactsSnapshotOptions = .init()) async throws -> ArtifactsSnapshotReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts"], command: "snapshot", body: requestBody, as: ArtifactsSnapshotReturn.self)
  }

  public func update(_ id: String, _ options: ArtifactsUpdateOptions = .init()) async throws -> ArtifactsUpdateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts"], command: "update", body: requestBody, as: ArtifactsUpdateReturn.self)
  }

  public func version(_ id: String, _ options: ArtifactsVersionOptions = .init()) async throws -> ArtifactsVersionReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts"], command: "version", body: requestBody, as: ArtifactsVersionReturn.self)
  }

  public func versions(_ id: String) async throws -> ArtifactsVersionsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["artifacts"], command: "versions", body: requestBody, as: ArtifactsVersionsReturn.self)
  }
}

public struct ArtifactsReleaseNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func activate(_ id: String, _ options: ArtifactsReleaseActivateOptions = .init()) async throws -> ArtifactsReleaseActivateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["artifacts","release"], command: "activate", body: requestBody, as: ArtifactsReleaseActivateReturn.self)
  }
}

public struct AudioNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func generate(_ text: String, _ options: AudioGenerateOptions = .init()) async throws -> AudioGenerateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["audio"], command: "generate", body: requestBody, as: AudioGenerateReturn.self)
  }
}

public struct ChatsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var lists: ChatsListsNamespace {
    ChatsListsNamespace(transport: transport)
  }

  public func backfillProviderTimestamps(_ options: ChatsBackfillProviderTimestampsOptions = .init()) async throws -> ChatsBackfillProviderTimestampsReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats"], command: "backfill-provider-timestamps", body: requestBody, as: ChatsBackfillProviderTimestampsReturn.self)
  }

  public func list(_ options: ChatsListOptions = .init()) async throws -> ChatsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats"], command: "list", body: requestBody, as: ChatsListReturn.self)
  }

  public func read(_ chat: String, _ options: ChatsReadOptions = .init()) async throws -> ChatsReadReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["chat"] = try RaviJSON.fromEncodable(chat)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats"], command: "read", body: requestBody, as: ChatsReadReturn.self)
  }
}

public struct ChatsListsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ list: String, _ chat: String, _ options: ChatsListsAddOptions = .init()) async throws -> ChatsListsAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["list"] = try RaviJSON.fromEncodable(list)
    requestBody["chat"] = try RaviJSON.fromEncodable(chat)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats","lists"], command: "add", body: requestBody, as: ChatsListsAddReturn.self)
  }

  public func create(_ name: String, _ options: ChatsListsCreateOptions = .init()) async throws -> ChatsListsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats","lists"], command: "create", body: requestBody, as: ChatsListsCreateReturn.self)
  }

  public func delta(_ list: String, _ chat: String, _ options: ChatsListsDeltaOptions = .init()) async throws -> ChatsListsDeltaReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["list"] = try RaviJSON.fromEncodable(list)
    requestBody["chat"] = try RaviJSON.fromEncodable(chat)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats","lists"], command: "delta", body: requestBody, as: ChatsListsDeltaReturn.self)
  }

  public func list(_ options: ChatsListsListOptions = .init()) async throws -> ChatsListsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats","lists"], command: "list", body: requestBody, as: ChatsListsListReturn.self)
  }

  public func markRead(_ list: String, _ chat: String, _ options: ChatsListsMarkReadOptions = .init()) async throws -> ChatsListsMarkReadReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["list"] = try RaviJSON.fromEncodable(list)
    requestBody["chat"] = try RaviJSON.fromEncodable(chat)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats","lists"], command: "mark-read", body: requestBody, as: ChatsListsMarkReadReturn.self)
  }

  public func members(_ list: String, _ options: ChatsListsMembersOptions = .init()) async throws -> ChatsListsMembersReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["list"] = try RaviJSON.fromEncodable(list)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats","lists"], command: "members", body: requestBody, as: ChatsListsMembersReturn.self)
  }

  public func remove(_ list: String, _ chat: String, _ options: ChatsListsRemoveOptions = .init()) async throws -> ChatsListsRemoveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["list"] = try RaviJSON.fromEncodable(list)
    requestBody["chat"] = try RaviJSON.fromEncodable(chat)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["chats","lists"], command: "remove", body: requestBody, as: ChatsListsRemoveReturn.self)
  }
}

public struct CommandsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func list(_ options: CommandsListOptions = .init()) async throws -> CommandsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["commands"], command: "list", body: requestBody, as: CommandsListReturn.self)
  }

  public func run(_ name: String, _ args: [String]? = nil, _ options: CommandsRunOptions = .init()) async throws -> CommandsRunReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    if let args {
      requestBody["args"] = try RaviJSON.fromEncodable(args)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["commands"], command: "run", body: requestBody, as: CommandsRunReturn.self)
  }

  public func show(_ name: String, _ options: CommandsShowOptions = .init()) async throws -> CommandsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["commands"], command: "show", body: requestBody, as: CommandsShowReturn.self)
  }

  public func validate(_ options: CommandsValidateOptions = .init()) async throws -> CommandsValidateReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["commands"], command: "validate", body: requestBody, as: CommandsValidateReturn.self)
  }
}

public struct ContactsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var metadata: ContactsMetadataNamespace {
    ContactsMetadataNamespace(transport: transport)
  }

  public func activity(_ contact: String, _ options: ContactsActivityOptions = .init()) async throws -> ContactsActivityReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "activity", body: requestBody, as: ContactsActivityReturn.self)
  }

  public func add(_ identity: String, _ name: String? = nil, _ options: ContactsAddOptions = .init()) async throws -> ContactsAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["identity"] = try RaviJSON.fromEncodable(identity)
    if let name {
      requestBody["name"] = try RaviJSON.fromEncodable(name)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "add", body: requestBody, as: ContactsAddReturn.self)
  }

  public func allow(_ contact: String) async throws -> ContactsAllowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "allow", body: requestBody, as: ContactsAllowReturn.self)
  }

  public func approve(_ contact: String, _ mode: String? = nil, _ options: ContactsApproveOptions = .init()) async throws -> ContactsApproveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    if let mode {
      requestBody["mode"] = try RaviJSON.fromEncodable(mode)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "approve", body: requestBody, as: ContactsApproveReturn.self)
  }

  public func backfill(_ options: ContactsBackfillOptions = .init()) async throws -> ContactsBackfillReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "backfill", body: requestBody, as: ContactsBackfillReturn.self)
  }

  public func block(_ contact: String) async throws -> ContactsBlockReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "block", body: requestBody, as: ContactsBlockReturn.self)
  }

  public func check(_ contact: String) async throws -> ContactsCheckReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "check", body: requestBody, as: ContactsCheckReturn.self)
  }

  public func duplicates() async throws -> ContactsDuplicatesReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["contacts"], command: "duplicates", body: requestBody, as: ContactsDuplicatesReturn.self)
  }

  public func find(_ query: String, _ options: ContactsFindOptions = .init()) async throws -> ContactsFindReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["query"] = try RaviJSON.fromEncodable(query)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "find", body: requestBody, as: ContactsFindReturn.self)
  }

  public func get(_ contact: String) async throws -> ContactsGetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "get", body: requestBody, as: ContactsGetReturn.self)
  }

  public func info(_ contact: String) async throws -> ContactsInfoReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "info", body: requestBody, as: ContactsInfoReturn.self)
  }

  public func link(_ contact: String, _ options: ContactsLinkOptions = .init()) async throws -> ContactsLinkReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "link", body: requestBody, as: ContactsLinkReturn.self)
  }

  public func list(_ options: ContactsListOptions = .init()) async throws -> ContactsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "list", body: requestBody, as: ContactsListReturn.self)
  }

  public func merge(_ source: String, _ target: String) async throws -> ContactsMergeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["source"] = try RaviJSON.fromEncodable(source)
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    return try await transport.call(groupSegments: ["contacts"], command: "merge", body: requestBody, as: ContactsMergeReturn.self)
  }

  public func messages(_ contact: String, _ options: ContactsMessagesOptions = .init()) async throws -> ContactsMessagesReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "messages", body: requestBody, as: ContactsMessagesReturn.self)
  }

  public func note(_ contact: String, _ text: String, _ options: ContactsNoteOptions = .init()) async throws -> ContactsNoteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    requestBody["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "note", body: requestBody, as: ContactsNoteReturn.self)
  }

  public func pending(_ options: ContactsPendingOptions = .init()) async throws -> ContactsPendingReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "pending", body: requestBody, as: ContactsPendingReturn.self)
  }

  public func profile(_ contact: String, _ options: ContactsProfileOptions = .init()) async throws -> ContactsProfileReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "profile", body: requestBody, as: ContactsProfileReturn.self)
  }

  public func remove(_ contact: String) async throws -> ContactsRemoveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "remove", body: requestBody, as: ContactsRemoveReturn.self)
  }

  public func sessions(_ contact: String, _ options: ContactsSessionsOptions = .init()) async throws -> ContactsSessionsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "sessions", body: requestBody, as: ContactsSessionsReturn.self)
  }

  public func set(_ contact: String, _ key: String, _ value: String) async throws -> ContactsSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["contacts"], command: "set", body: requestBody, as: ContactsSetReturn.self)
  }

  public func tag(_ contact: String, _ tag: String) async throws -> ContactsTagReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    requestBody["tag"] = try RaviJSON.fromEncodable(tag)
    return try await transport.call(groupSegments: ["contacts"], command: "tag", body: requestBody, as: ContactsTagReturn.self)
  }

  public func timeline(_ contact: String, _ options: ContactsTimelineOptions = .init()) async throws -> ContactsTimelineReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "timeline", body: requestBody, as: ContactsTimelineReturn.self)
  }

  public func unlink(_ platformIdentity: String, _ options: ContactsUnlinkOptions = .init()) async throws -> ContactsUnlinkReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["platformIdentity"] = try RaviJSON.fromEncodable(platformIdentity)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts"], command: "unlink", body: requestBody, as: ContactsUnlinkReturn.self)
  }

  public func untag(_ contact: String, _ tag: String) async throws -> ContactsUntagReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    requestBody["tag"] = try RaviJSON.fromEncodable(tag)
    return try await transport.call(groupSegments: ["contacts"], command: "untag", body: requestBody, as: ContactsUntagReturn.self)
  }
}

public struct ContactsMetadataNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func list(_ contact: String, _ options: ContactsMetadataListOptions = .init()) async throws -> ContactsMetadataListReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts","metadata"], command: "list", body: requestBody, as: ContactsMetadataListReturn.self)
  }

  public func remove(_ contact: String, _ key: String, _ options: ContactsMetadataRemoveOptions = .init()) async throws -> ContactsMetadataRemoveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts","metadata"], command: "remove", body: requestBody, as: ContactsMetadataRemoveReturn.self)
  }

  public func set(_ contact: String, _ key: String, _ value: String, _ options: ContactsMetadataSetOptions = .init()) async throws -> ContactsMetadataSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["contacts","metadata"], command: "set", body: requestBody, as: ContactsMetadataSetReturn.self)
  }
}

public struct ContextNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var credentials: ContextCredentialsNamespace {
    ContextCredentialsNamespace(transport: transport)
  }

  public func authorize(_ permission: String, _ objectType: String, _ objectId: String) async throws -> ContextAuthorizeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["permission"] = try RaviJSON.fromEncodable(permission)
    requestBody["objectType"] = try RaviJSON.fromEncodable(objectType)
    requestBody["objectId"] = try RaviJSON.fromEncodable(objectId)
    return try await transport.call(groupSegments: ["context"], command: "authorize", body: requestBody, as: ContextAuthorizeReturn.self)
  }

  public func capabilities() async throws -> ContextCapabilitiesReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["context"], command: "capabilities", body: requestBody, as: ContextCapabilitiesReturn.self)
  }

  public func check(_ permission: String, _ objectType: String, _ objectId: String) async throws -> ContextCheckReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["permission"] = try RaviJSON.fromEncodable(permission)
    requestBody["objectType"] = try RaviJSON.fromEncodable(objectType)
    requestBody["objectId"] = try RaviJSON.fromEncodable(objectId)
    return try await transport.call(groupSegments: ["context"], command: "check", body: requestBody, as: ContextCheckReturn.self)
  }

  public func cleanupAgentRuntime(_ options: ContextCleanupAgentRuntimeOptions = .init()) async throws -> ContextCleanupAgentRuntimeReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["context"], command: "cleanup-agent-runtime", body: requestBody, as: ContextCleanupAgentRuntimeReturn.self)
  }

  public func codexBashHook() async throws -> ContextCodexBashHookReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["context"], command: "codex-bash-hook", body: requestBody, as: ContextCodexBashHookReturn.self)
  }

  public func info(_ contextId: String) async throws -> ContextInfoReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contextId"] = try RaviJSON.fromEncodable(contextId)
    return try await transport.call(groupSegments: ["context"], command: "info", body: requestBody, as: ContextInfoReturn.self)
  }

  public func issue(_ cliName: String, _ options: ContextIssueOptions = .init()) async throws -> ContextIssueReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["cliName"] = try RaviJSON.fromEncodable(cliName)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["context"], command: "issue", body: requestBody, as: ContextIssueReturn.self)
  }

  public func lineage(_ contextId: String) async throws -> ContextLineageReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contextId"] = try RaviJSON.fromEncodable(contextId)
    return try await transport.call(groupSegments: ["context"], command: "lineage", body: requestBody, as: ContextLineageReturn.self)
  }

  public func list(_ options: ContextListOptions = .init()) async throws -> ContextListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["context"], command: "list", body: requestBody, as: ContextListReturn.self)
  }

  public func revoke(_ contextId: String, _ options: ContextRevokeOptions = .init()) async throws -> ContextRevokeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contextId"] = try RaviJSON.fromEncodable(contextId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["context"], command: "revoke", body: requestBody, as: ContextRevokeReturn.self)
  }

  public func visibility() async throws -> ContextVisibilityReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["context"], command: "visibility", body: requestBody, as: ContextVisibilityReturn.self)
  }

  public func whoami() async throws -> ContextWhoamiReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["context"], command: "whoami", body: requestBody, as: ContextWhoamiReturn.self)
  }
}

public struct ContextCredentialsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ contextKey: String, _ options: ContextCredentialsAddOptions = .init()) async throws -> ContextCredentialsAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contextKey"] = try RaviJSON.fromEncodable(contextKey)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["context","credentials"], command: "add", body: requestBody, as: ContextCredentialsAddReturn.self)
  }

  public func list(_ options: ContextCredentialsListOptions = .init()) async throws -> ContextCredentialsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["context","credentials"], command: "list", body: requestBody, as: ContextCredentialsListReturn.self)
  }

  public func remove(_ contextKey: String) async throws -> ContextCredentialsRemoveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contextKey"] = try RaviJSON.fromEncodable(contextKey)
    return try await transport.call(groupSegments: ["context","credentials"], command: "remove", body: requestBody, as: ContextCredentialsRemoveReturn.self)
  }

  public func setDefault(_ contextKey: String) async throws -> ContextCredentialsSetDefaultReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contextKey"] = try RaviJSON.fromEncodable(contextKey)
    return try await transport.call(groupSegments: ["context","credentials"], command: "set-default", body: requestBody, as: ContextCredentialsSetDefaultReturn.self)
  }
}

public struct CostsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func agent(_ agentId: String, _ options: CostsAgentOptions = .init()) async throws -> CostsAgentReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["agentId"] = try RaviJSON.fromEncodable(agentId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["costs"], command: "agent", body: requestBody, as: CostsAgentReturn.self)
  }

  public func agents(_ options: CostsAgentsOptions = .init()) async throws -> CostsAgentsReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["costs"], command: "agents", body: requestBody, as: CostsAgentsReturn.self)
  }

  public func session(_ nameOrKey: String) async throws -> CostsSessionReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["costs"], command: "session", body: requestBody, as: CostsSessionReturn.self)
  }

  public func summary(_ options: CostsSummaryOptions = .init()) async throws -> CostsSummaryReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["costs"], command: "summary", body: requestBody, as: CostsSummaryReturn.self)
  }

  public func topSessions(_ options: CostsTopSessionsOptions = .init()) async throws -> CostsTopSessionsReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["costs"], command: "top-sessions", body: requestBody, as: CostsTopSessionsReturn.self)
  }
}

public struct CrmNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var account: CrmAccountNamespace {
    CrmAccountNamespace(transport: transport)
  }

  public var contact: CrmContactNamespace {
    CrmContactNamespace(transport: transport)
  }

  public var fact: CrmFactNamespace {
    CrmFactNamespace(transport: transport)
  }

  public var opportunity: CrmOpportunityNamespace {
    CrmOpportunityNamespace(transport: transport)
  }

  public var pipeline: CrmPipelineNamespace {
    CrmPipelineNamespace(transport: transport)
  }

  public var task: CrmTaskNamespace {
    CrmTaskNamespace(transport: transport)
  }

  public func accountCommand(_ account: String) async throws -> CrmAccountReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["account"] = try RaviJSON.fromEncodable(account)
    return try await transport.call(groupSegments: ["crm"], command: "account", body: requestBody, as: CrmAccountReturn.self)
  }

  public func board(_ options: CrmBoardOptions = .init()) async throws -> CrmBoardReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm"], command: "board", body: requestBody, as: CrmBoardReturn.self)
  }

  public func contactCommand(_ contact: String) async throws -> CrmContactReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["crm"], command: "contact", body: requestBody, as: CrmContactReturn.self)
  }

  public func contacts(_ options: CrmContactsOptions = .init()) async throws -> CrmContactsReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm"], command: "contacts", body: requestBody, as: CrmContactsReturn.self)
  }

  public func next(_ options: CrmNextOptions = .init()) async throws -> CrmNextReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm"], command: "next", body: requestBody, as: CrmNextReturn.self)
  }

  public func opportunityCommand(_ opportunity: String) async throws -> CrmOpportunityReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["opportunity"] = try RaviJSON.fromEncodable(opportunity)
    return try await transport.call(groupSegments: ["crm"], command: "opportunity", body: requestBody, as: CrmOpportunityReturn.self)
  }
}

public struct CrmAccountNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func create(_ name: String, _ options: CrmAccountCreateOptions = .init()) async throws -> CrmAccountCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","account"], command: "create", body: requestBody, as: CrmAccountCreateReturn.self)
  }

  public func linkContact(_ account: String, _ contact: String, _ options: CrmAccountLinkContactOptions = .init()) async throws -> CrmAccountLinkContactReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["account"] = try RaviJSON.fromEncodable(account)
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","account"], command: "link-contact", body: requestBody, as: CrmAccountLinkContactReturn.self)
  }

  public func show(_ account: String) async throws -> CrmAccountShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["account"] = try RaviJSON.fromEncodable(account)
    return try await transport.call(groupSegments: ["crm","account"], command: "show", body: requestBody, as: CrmAccountShowReturn.self)
  }
}

public struct CrmContactNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func set(_ contact: String, _ field: String, _ value: String, _ options: CrmContactSetOptions = .init()) async throws -> CrmContactSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    requestBody["field"] = try RaviJSON.fromEncodable(field)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","contact"], command: "set", body: requestBody, as: CrmContactSetReturn.self)
  }

  public func show(_ contact: String) async throws -> CrmContactShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["crm","contact"], command: "show", body: requestBody, as: CrmContactShowReturn.self)
  }
}

public struct CrmFactNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func confirm(_ fact: String) async throws -> CrmFactConfirmReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["fact"] = try RaviJSON.fromEncodable(fact)
    return try await transport.call(groupSegments: ["crm","fact"], command: "confirm", body: requestBody, as: CrmFactConfirmReturn.self)
  }

  public func list(_ options: CrmFactListOptions = .init()) async throws -> CrmFactListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","fact"], command: "list", body: requestBody, as: CrmFactListReturn.self)
  }

  public func propose(_ entityType: String, _ entity: String, _ key: String, _ value: String, _ options: CrmFactProposeOptions = .init()) async throws -> CrmFactProposeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["entityType"] = try RaviJSON.fromEncodable(entityType)
    requestBody["entity"] = try RaviJSON.fromEncodable(entity)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","fact"], command: "propose", body: requestBody, as: CrmFactProposeReturn.self)
  }

  public func reject(_ fact: String) async throws -> CrmFactRejectReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["fact"] = try RaviJSON.fromEncodable(fact)
    return try await transport.call(groupSegments: ["crm","fact"], command: "reject", body: requestBody, as: CrmFactRejectReturn.self)
  }
}

public struct CrmOpportunityNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func contacts(_ opportunity: String) async throws -> CrmOpportunityContactsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["opportunity"] = try RaviJSON.fromEncodable(opportunity)
    return try await transport.call(groupSegments: ["crm","opportunity"], command: "contacts", body: requestBody, as: CrmOpportunityContactsReturn.self)
  }

  public func create(_ title: String, _ options: CrmOpportunityCreateOptions = .init()) async throws -> CrmOpportunityCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","opportunity"], command: "create", body: requestBody, as: CrmOpportunityCreateReturn.self)
  }

  public func linkContact(_ opportunity: String, _ contact: String, _ options: CrmOpportunityLinkContactOptions = .init()) async throws -> CrmOpportunityLinkContactReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["opportunity"] = try RaviJSON.fromEncodable(opportunity)
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","opportunity"], command: "link-contact", body: requestBody, as: CrmOpportunityLinkContactReturn.self)
  }

  public func move(_ opportunity: String, _ stage: String, _ options: CrmOpportunityMoveOptions = .init()) async throws -> CrmOpportunityMoveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["opportunity"] = try RaviJSON.fromEncodable(opportunity)
    requestBody["stage"] = try RaviJSON.fromEncodable(stage)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","opportunity"], command: "move", body: requestBody, as: CrmOpportunityMoveReturn.self)
  }

  public func show(_ opportunity: String) async throws -> CrmOpportunityShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["opportunity"] = try RaviJSON.fromEncodable(opportunity)
    return try await transport.call(groupSegments: ["crm","opportunity"], command: "show", body: requestBody, as: CrmOpportunityShowReturn.self)
  }
}

public struct CrmPipelineNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var stage: CrmPipelineStageNamespace {
    CrmPipelineStageNamespace(transport: transport)
  }

  public func create(_ name: String, _ options: CrmPipelineCreateOptions = .init()) async throws -> CrmPipelineCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","pipeline"], command: "create", body: requestBody, as: CrmPipelineCreateReturn.self)
  }

  public func list(_ options: CrmPipelineListOptions = .init()) async throws -> CrmPipelineListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","pipeline"], command: "list", body: requestBody, as: CrmPipelineListReturn.self)
  }

  public func set(_ pipeline: String, _ field: String, _ value: String) async throws -> CrmPipelineSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    requestBody["field"] = try RaviJSON.fromEncodable(field)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["crm","pipeline"], command: "set", body: requestBody, as: CrmPipelineSetReturn.self)
  }

  public func show(_ pipeline: String) async throws -> CrmPipelineShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    return try await transport.call(groupSegments: ["crm","pipeline"], command: "show", body: requestBody, as: CrmPipelineShowReturn.self)
  }
}

public struct CrmPipelineStageNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var topic: CrmPipelineStageTopicNamespace {
    CrmPipelineStageTopicNamespace(transport: transport)
  }

  public func add(_ pipeline: String, _ key: String, _ options: CrmPipelineStageAddOptions = .init()) async throws -> CrmPipelineStageAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","pipeline","stage"], command: "add", body: requestBody, as: CrmPipelineStageAddReturn.self)
  }

  public func archive(_ pipeline: String, _ stage: String) async throws -> CrmPipelineStageArchiveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    requestBody["stage"] = try RaviJSON.fromEncodable(stage)
    return try await transport.call(groupSegments: ["crm","pipeline","stage"], command: "archive", body: requestBody, as: CrmPipelineStageArchiveReturn.self)
  }

  public func list(_ pipeline: String, _ options: CrmPipelineStageListOptions = .init()) async throws -> CrmPipelineStageListReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","pipeline","stage"], command: "list", body: requestBody, as: CrmPipelineStageListReturn.self)
  }

  public func set(_ pipeline: String, _ stage: String, _ field: String, _ value: String) async throws -> CrmPipelineStageSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    requestBody["stage"] = try RaviJSON.fromEncodable(stage)
    requestBody["field"] = try RaviJSON.fromEncodable(field)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["crm","pipeline","stage"], command: "set", body: requestBody, as: CrmPipelineStageSetReturn.self)
  }

  public func show(_ pipeline: String, _ stage: String) async throws -> CrmPipelineStageShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    requestBody["stage"] = try RaviJSON.fromEncodable(stage)
    return try await transport.call(groupSegments: ["crm","pipeline","stage"], command: "show", body: requestBody, as: CrmPipelineStageShowReturn.self)
  }

  public func topics(_ pipeline: String, _ stage: String, _ options: CrmPipelineStageTopicsOptions = .init()) async throws -> CrmPipelineStageTopicsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    requestBody["stage"] = try RaviJSON.fromEncodable(stage)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","pipeline","stage"], command: "topics", body: requestBody, as: CrmPipelineStageTopicsReturn.self)
  }
}

public struct CrmPipelineStageTopicNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ pipeline: String, _ stage: String, _ key: String, _ options: CrmPipelineStageTopicAddOptions = .init()) async throws -> CrmPipelineStageTopicAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    requestBody["stage"] = try RaviJSON.fromEncodable(stage)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","pipeline","stage","topic"], command: "add", body: requestBody, as: CrmPipelineStageTopicAddReturn.self)
  }

  public func archive(_ pipeline: String, _ stage: String, _ topic: String) async throws -> CrmPipelineStageTopicArchiveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    requestBody["stage"] = try RaviJSON.fromEncodable(stage)
    requestBody["topic"] = try RaviJSON.fromEncodable(topic)
    return try await transport.call(groupSegments: ["crm","pipeline","stage","topic"], command: "archive", body: requestBody, as: CrmPipelineStageTopicArchiveReturn.self)
  }

  public func set(_ pipeline: String, _ stage: String, _ topic: String, _ field: String, _ value: String) async throws -> CrmPipelineStageTopicSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["pipeline"] = try RaviJSON.fromEncodable(pipeline)
    requestBody["stage"] = try RaviJSON.fromEncodable(stage)
    requestBody["topic"] = try RaviJSON.fromEncodable(topic)
    requestBody["field"] = try RaviJSON.fromEncodable(field)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["crm","pipeline","stage","topic"], command: "set", body: requestBody, as: CrmPipelineStageTopicSetReturn.self)
  }
}

public struct CrmTaskNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func cancel(_ task: String, _ options: CrmTaskCancelOptions = .init()) async throws -> CrmTaskCancelReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["task"] = try RaviJSON.fromEncodable(task)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","task"], command: "cancel", body: requestBody, as: CrmTaskCancelReturn.self)
  }

  public func create(_ title: String, _ options: CrmTaskCreateOptions = .init()) async throws -> CrmTaskCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","task"], command: "create", body: requestBody, as: CrmTaskCreateReturn.self)
  }

  public func done(_ task: String) async throws -> CrmTaskDoneReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["task"] = try RaviJSON.fromEncodable(task)
    return try await transport.call(groupSegments: ["crm","task"], command: "done", body: requestBody, as: CrmTaskDoneReturn.self)
  }

  public func list(_ options: CrmTaskListOptions = .init()) async throws -> CrmTaskListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","task"], command: "list", body: requestBody, as: CrmTaskListReturn.self)
  }

  public func show(_ task: String) async throws -> CrmTaskShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["task"] = try RaviJSON.fromEncodable(task)
    return try await transport.call(groupSegments: ["crm","task"], command: "show", body: requestBody, as: CrmTaskShowReturn.self)
  }

  public func snooze(_ task: String, _ options: CrmTaskSnoozeOptions = .init()) async throws -> CrmTaskSnoozeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["task"] = try RaviJSON.fromEncodable(task)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["crm","task"], command: "snooze", body: requestBody, as: CrmTaskSnoozeReturn.self)
  }
}

public struct CronNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ name: String, _ options: CronAddOptions = .init()) async throws -> CronAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["cron"], command: "add", body: requestBody, as: CronAddReturn.self)
  }

  public func disable(_ id: String) async throws -> CronDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "disable", body: requestBody, as: CronDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> CronEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "enable", body: requestBody, as: CronEnableReturn.self)
  }

  public func list(_ options: CronListOptions = .init()) async throws -> CronListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["cron"], command: "list", body: requestBody, as: CronListReturn.self)
  }

  public func rm(_ id: String) async throws -> CronRmReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "rm", body: requestBody, as: CronRmReturn.self)
  }

  public func run(_ id: String) async throws -> CronRunReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "run", body: requestBody, as: CronRunReturn.self)
  }

  public func set(_ id: String, _ key: String, _ value: String) async throws -> CronSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["cron"], command: "set", body: requestBody, as: CronSetReturn.self)
  }

  public func show(_ id: String) async throws -> CronShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "show", body: requestBody, as: CronShowReturn.self)
  }
}

public struct DaemonNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func env() async throws -> DaemonEnvReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "env", body: requestBody, as: DaemonEnvReturn.self)
  }

  public func initAdminKey(_ options: DaemonInitAdminKeyOptions = .init()) async throws -> DaemonInitAdminKeyReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["daemon"], command: "init-admin-key", body: requestBody, as: DaemonInitAdminKeyReturn.self)
  }

  public func install() async throws -> DaemonInstallReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "install", body: requestBody, as: DaemonInstallReturn.self)
  }

  public func logs(_ options: DaemonLogsOptions = .init()) async throws -> DaemonLogsReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["daemon"], command: "logs", body: requestBody, as: DaemonLogsReturn.self)
  }

  public func restart(_ options: DaemonRestartOptions = .init()) async throws -> DaemonRestartReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["daemon"], command: "restart", body: requestBody, as: DaemonRestartReturn.self)
  }

  public func start() async throws -> DaemonStartReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "start", body: requestBody, as: DaemonStartReturn.self)
  }

  public func status() async throws -> DaemonStatusReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "status", body: requestBody, as: DaemonStatusReturn.self)
  }

  public func stop() async throws -> DaemonStopReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "stop", body: requestBody, as: DaemonStopReturn.self)
  }

  public func uninstall() async throws -> DaemonUninstallReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "uninstall", body: requestBody, as: DaemonUninstallReturn.self)
  }
}

public struct DevinNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var auth: DevinAuthNamespace {
    DevinAuthNamespace(transport: transport)
  }

  public var sessions: DevinSessionsNamespace {
    DevinSessionsNamespace(transport: transport)
  }
}

public struct DevinAuthNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func check() async throws -> DevinAuthCheckReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["devin","auth"], command: "check", body: requestBody, as: DevinAuthCheckReturn.self)
  }
}

public struct DevinSessionsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func archive(_ session: String) async throws -> DevinSessionsArchiveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "archive", body: requestBody, as: DevinSessionsArchiveReturn.self)
  }

  public func attachments(_ session: String, _ options: DevinSessionsAttachmentsOptions = .init()) async throws -> DevinSessionsAttachmentsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "attachments", body: requestBody, as: DevinSessionsAttachmentsReturn.self)
  }

  public func create(_ options: DevinSessionsCreateOptions = .init()) async throws -> DevinSessionsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "create", body: requestBody, as: DevinSessionsCreateReturn.self)
  }

  public func insights(_ session: String, _ options: DevinSessionsInsightsOptions = .init()) async throws -> DevinSessionsInsightsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "insights", body: requestBody, as: DevinSessionsInsightsReturn.self)
  }

  public func list(_ options: DevinSessionsListOptions = .init()) async throws -> DevinSessionsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "list", body: requestBody, as: DevinSessionsListReturn.self)
  }

  public func messages(_ session: String, _ options: DevinSessionsMessagesOptions = .init()) async throws -> DevinSessionsMessagesReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "messages", body: requestBody, as: DevinSessionsMessagesReturn.self)
  }

  public func send(_ session: String, _ message: String, _ options: DevinSessionsSendOptions = .init()) async throws -> DevinSessionsSendReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    requestBody["message"] = try RaviJSON.fromEncodable(message)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "send", body: requestBody, as: DevinSessionsSendReturn.self)
  }

  public func show(_ session: String, _ options: DevinSessionsShowOptions = .init()) async throws -> DevinSessionsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "show", body: requestBody, as: DevinSessionsShowReturn.self)
  }

  public func sync(_ session: String, _ options: DevinSessionsSyncOptions = .init()) async throws -> DevinSessionsSyncReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "sync", body: requestBody, as: DevinSessionsSyncReturn.self)
  }

  public func terminate(_ session: String, _ options: DevinSessionsTerminateOptions = .init()) async throws -> DevinSessionsTerminateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "terminate", body: requestBody, as: DevinSessionsTerminateReturn.self)
  }
}

public struct EvalNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func run(_ specPath: String, _ options: EvalRunOptions = .init()) async throws -> EvalRunReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["specPath"] = try RaviJSON.fromEncodable(specPath)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["eval"], command: "run", body: requestBody, as: EvalRunReturn.self)
  }
}

public struct HeartbeatNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func disable(_ id: String) async throws -> HeartbeatDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["heartbeat"], command: "disable", body: requestBody, as: HeartbeatDisableReturn.self)
  }

  public func enable(_ id: String, _ interval: String? = nil) async throws -> HeartbeatEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    if let interval {
      requestBody["interval"] = try RaviJSON.fromEncodable(interval)
    }
    return try await transport.call(groupSegments: ["heartbeat"], command: "enable", body: requestBody, as: HeartbeatEnableReturn.self)
  }

  public func set(_ id: String, _ key: String, _ value: String) async throws -> HeartbeatSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["heartbeat"], command: "set", body: requestBody, as: HeartbeatSetReturn.self)
  }

  public func show(_ id: String) async throws -> HeartbeatShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["heartbeat"], command: "show", body: requestBody, as: HeartbeatShowReturn.self)
  }

  public func status() async throws -> HeartbeatStatusReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["heartbeat"], command: "status", body: requestBody, as: HeartbeatStatusReturn.self)
  }

  public func trigger(_ id: String) async throws -> HeartbeatTriggerReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["heartbeat"], command: "trigger", body: requestBody, as: HeartbeatTriggerReturn.self)
  }
}

public struct HooksNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func create(_ name: String, _ options: HooksCreateOptions = .init()) async throws -> HooksCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["hooks"], command: "create", body: requestBody, as: HooksCreateReturn.self)
  }

  public func disable(_ id: String) async throws -> HooksDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "disable", body: requestBody, as: HooksDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> HooksEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "enable", body: requestBody, as: HooksEnableReturn.self)
  }

  public func list(_ options: HooksListOptions = .init()) async throws -> HooksListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["hooks"], command: "list", body: requestBody, as: HooksListReturn.self)
  }

  public func rm(_ id: String) async throws -> HooksRmReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "rm", body: requestBody, as: HooksRmReturn.self)
  }

  public func show(_ id: String) async throws -> HooksShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "show", body: requestBody, as: HooksShowReturn.self)
  }

  public func test(_ id: String) async throws -> HooksTestReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "test", body: requestBody, as: HooksTestReturn.self)
  }
}

public struct ImageNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var atlas: ImageAtlasNamespace {
    ImageAtlasNamespace(transport: transport)
  }

  public func generate(_ prompt: String, _ options: ImageGenerateOptions = .init()) async throws -> ImageGenerateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["prompt"] = try RaviJSON.fromEncodable(prompt)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["image"], command: "generate", body: requestBody, as: ImageGenerateReturn.self)
  }
}

public struct ImageAtlasNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func split(_ input: String, _ options: ImageAtlasSplitOptions = .init()) async throws -> ImageAtlasSplitReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["input"] = try RaviJSON.fromEncodable(input)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["image","atlas"], command: "split", body: requestBody, as: ImageAtlasSplitReturn.self)
  }
}

public struct InboxNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func archive(_ item: String) async throws -> InboxArchiveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["item"] = try RaviJSON.fromEncodable(item)
    return try await transport.call(groupSegments: ["inbox"], command: "archive", body: requestBody, as: InboxArchiveReturn.self)
  }

  public func disable() async throws -> InboxDisableReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["inbox"], command: "disable", body: requestBody, as: InboxDisableReturn.self)
  }

  public func done(_ item: String) async throws -> InboxDoneReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["item"] = try RaviJSON.fromEncodable(item)
    return try await transport.call(groupSegments: ["inbox"], command: "done", body: requestBody, as: InboxDoneReturn.self)
  }

  public func enable() async throws -> InboxEnableReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["inbox"], command: "enable", body: requestBody, as: InboxEnableReturn.self)
  }

  public func items(_ options: InboxItemsOptions = .init()) async throws -> InboxItemsReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["inbox"], command: "items", body: requestBody, as: InboxItemsReturn.self)
  }

  public func list(_ options: InboxListOptions = .init()) async throws -> InboxListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["inbox"], command: "list", body: requestBody, as: InboxListReturn.self)
  }

  public func poll(_ options: InboxPollOptions = .init()) async throws -> InboxPollReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["inbox"], command: "poll", body: requestBody, as: InboxPollReturn.self)
  }

  public func read(_ item: String) async throws -> InboxReadReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["item"] = try RaviJSON.fromEncodable(item)
    return try await transport.call(groupSegments: ["inbox"], command: "read", body: requestBody, as: InboxReadReturn.self)
  }

  public func replay(_ ref: String) async throws -> InboxReplayReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["ref"] = try RaviJSON.fromEncodable(ref)
    return try await transport.call(groupSegments: ["inbox"], command: "replay", body: requestBody, as: InboxReplayReturn.self)
  }

  public func snooze(_ item: String, _ options: InboxSnoozeOptions = .init()) async throws -> InboxSnoozeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["item"] = try RaviJSON.fromEncodable(item)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["inbox"], command: "snooze", body: requestBody, as: InboxSnoozeReturn.self)
  }

  public func sources() async throws -> InboxSourcesReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["inbox"], command: "sources", body: requestBody, as: InboxSourcesReturn.self)
  }

  public func status() async throws -> InboxStatusReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["inbox"], command: "status", body: requestBody, as: InboxStatusReturn.self)
  }
}

public struct InsightsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func create(_ summary: String, _ options: InsightsCreateOptions = .init()) async throws -> InsightsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["summary"] = try RaviJSON.fromEncodable(summary)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["insights"], command: "create", body: requestBody, as: InsightsCreateReturn.self)
  }

  public func list(_ options: InsightsListOptions = .init()) async throws -> InsightsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["insights"], command: "list", body: requestBody, as: InsightsListReturn.self)
  }

  public func search(_ text: String, _ options: InsightsSearchOptions = .init()) async throws -> InsightsSearchReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["insights"], command: "search", body: requestBody, as: InsightsSearchReturn.self)
  }

  public func show(_ id: String) async throws -> InsightsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["insights"], command: "show", body: requestBody, as: InsightsShowReturn.self)
  }
}

public struct InstancesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var pending: InstancesPendingNamespace {
    InstancesPendingNamespace(transport: transport)
  }

  public var routes: InstancesRoutesNamespace {
    InstancesRoutesNamespace(transport: transport)
  }

  public func create(_ name: String, _ options: InstancesCreateOptions = .init()) async throws -> InstancesCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances"], command: "create", body: requestBody, as: InstancesCreateReturn.self)
  }

  public func delete(_ name: String) async throws -> InstancesDeleteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "delete", body: requestBody, as: InstancesDeleteReturn.self)
  }

  public func deleted() async throws -> InstancesDeletedReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["instances"], command: "deleted", body: requestBody, as: InstancesDeletedReturn.self)
  }

  public func disable(_ target: String) async throws -> InstancesDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    return try await transport.call(groupSegments: ["instances"], command: "disable", body: requestBody, as: InstancesDisableReturn.self)
  }

  public func disconnect(_ name: String) async throws -> InstancesDisconnectReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "disconnect", body: requestBody, as: InstancesDisconnectReturn.self)
  }

  public func enable(_ target: String) async throws -> InstancesEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    return try await transport.call(groupSegments: ["instances"], command: "enable", body: requestBody, as: InstancesEnableReturn.self)
  }

  public func get(_ name: String, _ key: String) async throws -> InstancesGetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    return try await transport.call(groupSegments: ["instances"], command: "get", body: requestBody, as: InstancesGetReturn.self)
  }

  public func list(_ options: InstancesListOptions = .init()) async throws -> InstancesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances"], command: "list", body: requestBody, as: InstancesListReturn.self)
  }

  public func restore(_ name: String) async throws -> InstancesRestoreReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "restore", body: requestBody, as: InstancesRestoreReturn.self)
  }

  public func set(_ name: String, _ key: String, _ value: String) async throws -> InstancesSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["instances"], command: "set", body: requestBody, as: InstancesSetReturn.self)
  }

  public func show(_ name: String) async throws -> InstancesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "show", body: requestBody, as: InstancesShowReturn.self)
  }

  public func status(_ name: String) async throws -> InstancesStatusReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "status", body: requestBody, as: InstancesStatusReturn.self)
  }

  public func target(_ name: String, _ options: InstancesTargetOptions = .init()) async throws -> InstancesTargetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances"], command: "target", body: requestBody, as: InstancesTargetReturn.self)
  }
}

public struct InstancesPendingNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func approve(_ name: String, _ contact: String, _ options: InstancesPendingApproveOptions = .init()) async throws -> InstancesPendingApproveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances","pending"], command: "approve", body: requestBody, as: InstancesPendingApproveReturn.self)
  }

  public func list(_ name: String, _ options: InstancesPendingListOptions = .init()) async throws -> InstancesPendingListReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances","pending"], command: "list", body: requestBody, as: InstancesPendingListReturn.self)
  }

  public func reject(_ name: String, _ contact: String) async throws -> InstancesPendingRejectReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["instances","pending"], command: "reject", body: requestBody, as: InstancesPendingRejectReturn.self)
  }
}

public struct InstancesRoutesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ name: String, _ pattern: String, _ agent: String, _ options: InstancesRoutesAddOptions = .init()) async throws -> InstancesRoutesAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["pattern"] = try RaviJSON.fromEncodable(pattern)
    requestBody["agent"] = try RaviJSON.fromEncodable(agent)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances","routes"], command: "add", body: requestBody, as: InstancesRoutesAddReturn.self)
  }

  public func deleted(_ name: String? = nil) async throws -> InstancesRoutesDeletedReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let name {
      requestBody["name"] = try RaviJSON.fromEncodable(name)
    }
    return try await transport.call(groupSegments: ["instances","routes"], command: "deleted", body: requestBody, as: InstancesRoutesDeletedReturn.self)
  }

  public func list(_ name: String, _ options: InstancesRoutesListOptions = .init()) async throws -> InstancesRoutesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances","routes"], command: "list", body: requestBody, as: InstancesRoutesListReturn.self)
  }

  public func remove(_ name: String, _ pattern: String, _ options: InstancesRoutesRemoveOptions = .init()) async throws -> InstancesRoutesRemoveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["pattern"] = try RaviJSON.fromEncodable(pattern)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances","routes"], command: "remove", body: requestBody, as: InstancesRoutesRemoveReturn.self)
  }

  public func restore(_ name: String, _ pattern: String, _ options: InstancesRoutesRestoreOptions = .init()) async throws -> InstancesRoutesRestoreReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["pattern"] = try RaviJSON.fromEncodable(pattern)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances","routes"], command: "restore", body: requestBody, as: InstancesRoutesRestoreReturn.self)
  }

  public func set(_ name: String, _ pattern: String, _ key: String, _ value: String, _ options: InstancesRoutesSetOptions = .init()) async throws -> InstancesRoutesSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["pattern"] = try RaviJSON.fromEncodable(pattern)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["instances","routes"], command: "set", body: requestBody, as: InstancesRoutesSetReturn.self)
  }

  public func show(_ name: String, _ pattern: String) async throws -> InstancesRoutesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["pattern"] = try RaviJSON.fromEncodable(pattern)
    return try await transport.call(groupSegments: ["instances","routes"], command: "show", body: requestBody, as: InstancesRoutesShowReturn.self)
  }
}

public struct MediaNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func send(_ filePath: String, _ options: MediaSendOptions = .init()) async throws -> MediaSendReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["filePath"] = try RaviJSON.fromEncodable(filePath)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["media"], command: "send", body: requestBody, as: MediaSendReturn.self)
  }
}

public struct ObserversNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var profiles: ObserversProfilesNamespace {
    ObserversProfilesNamespace(transport: transport)
  }

  public var rules: ObserversRulesNamespace {
    ObserversRulesNamespace(transport: transport)
  }

  public func list(_ options: ObserversListOptions = .init()) async throws -> ObserversListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["observers"], command: "list", body: requestBody, as: ObserversListReturn.self)
  }

  public func refresh(_ session: String) async throws -> ObserversRefreshReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    return try await transport.call(groupSegments: ["observers"], command: "refresh", body: requestBody, as: ObserversRefreshReturn.self)
  }

  public func show(_ bindingId: String) async throws -> ObserversShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["bindingId"] = try RaviJSON.fromEncodable(bindingId)
    return try await transport.call(groupSegments: ["observers"], command: "show", body: requestBody, as: ObserversShowReturn.self)
  }
}

public struct ObserversProfilesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func init_(_ profileId: String, _ options: ObserversProfilesInitOptions = .init()) async throws -> ObserversProfilesInitReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profileId"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["observers","profiles"], command: "init", body: requestBody, as: ObserversProfilesInitReturn.self)
  }

  public func list(_ options: ObserversProfilesListOptions = .init()) async throws -> ObserversProfilesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["observers","profiles"], command: "list", body: requestBody, as: ObserversProfilesListReturn.self)
  }

  public func preview(_ profileId: String, _ options: ObserversProfilesPreviewOptions = .init()) async throws -> ObserversProfilesPreviewReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profileId"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["observers","profiles"], command: "preview", body: requestBody, as: ObserversProfilesPreviewReturn.self)
  }

  public func show(_ profileId: String) async throws -> ObserversProfilesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profileId"] = try RaviJSON.fromEncodable(profileId)
    return try await transport.call(groupSegments: ["observers","profiles"], command: "show", body: requestBody, as: ObserversProfilesShowReturn.self)
  }

  public func validate(_ profileId: String? = nil) async throws -> ObserversProfilesValidateReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let profileId {
      requestBody["profileId"] = try RaviJSON.fromEncodable(profileId)
    }
    return try await transport.call(groupSegments: ["observers","profiles"], command: "validate", body: requestBody, as: ObserversProfilesValidateReturn.self)
  }
}

public struct ObserversRulesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func disable(_ id: String) async throws -> ObserversRulesDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["observers","rules"], command: "disable", body: requestBody, as: ObserversRulesDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> ObserversRulesEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["observers","rules"], command: "enable", body: requestBody, as: ObserversRulesEnableReturn.self)
  }

  public func explain(_ session: String) async throws -> ObserversRulesExplainReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    return try await transport.call(groupSegments: ["observers","rules"], command: "explain", body: requestBody, as: ObserversRulesExplainReturn.self)
  }

  public func list(_ options: ObserversRulesListOptions = .init()) async throws -> ObserversRulesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["observers","rules"], command: "list", body: requestBody, as: ObserversRulesListReturn.self)
  }

  public func rm(_ id: String) async throws -> ObserversRulesRmReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["observers","rules"], command: "rm", body: requestBody, as: ObserversRulesRmReturn.self)
  }

  public func set(_ id: String, _ observerAgentId: String, _ options: ObserversRulesSetOptions = .init()) async throws -> ObserversRulesSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["observerAgentId"] = try RaviJSON.fromEncodable(observerAgentId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["observers","rules"], command: "set", body: requestBody, as: ObserversRulesSetReturn.self)
  }

  public func show(_ id: String) async throws -> ObserversRulesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["observers","rules"], command: "show", body: requestBody, as: ObserversRulesShowReturn.self)
  }

  public func validate() async throws -> ObserversRulesValidateReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["observers","rules"], command: "validate", body: requestBody, as: ObserversRulesValidateReturn.self)
  }
}

public struct PermissionsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func check(_ subject: String, _ permission: String, _ object: String) async throws -> PermissionsCheckReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["subject"] = try RaviJSON.fromEncodable(subject)
    requestBody["permission"] = try RaviJSON.fromEncodable(permission)
    requestBody["object"] = try RaviJSON.fromEncodable(object)
    return try await transport.call(groupSegments: ["permissions"], command: "check", body: requestBody, as: PermissionsCheckReturn.self)
  }

  public func clear(_ options: PermissionsClearOptions = .init()) async throws -> PermissionsClearReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["permissions"], command: "clear", body: requestBody, as: PermissionsClearReturn.self)
  }

  public func grant(_ subject: String, _ relation: String, _ object: String) async throws -> PermissionsGrantReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["subject"] = try RaviJSON.fromEncodable(subject)
    requestBody["relation"] = try RaviJSON.fromEncodable(relation)
    requestBody["object"] = try RaviJSON.fromEncodable(object)
    return try await transport.call(groupSegments: ["permissions"], command: "grant", body: requestBody, as: PermissionsGrantReturn.self)
  }

  public func init_(_ subject: String, _ template: String) async throws -> PermissionsInitReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["subject"] = try RaviJSON.fromEncodable(subject)
    requestBody["template"] = try RaviJSON.fromEncodable(template)
    return try await transport.call(groupSegments: ["permissions"], command: "init", body: requestBody, as: PermissionsInitReturn.self)
  }

  public func list(_ options: PermissionsListOptions = .init()) async throws -> PermissionsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["permissions"], command: "list", body: requestBody, as: PermissionsListReturn.self)
  }

  public func revoke(_ subject: String, _ relation: String, _ object: String) async throws -> PermissionsRevokeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["subject"] = try RaviJSON.fromEncodable(subject)
    requestBody["relation"] = try RaviJSON.fromEncodable(relation)
    requestBody["object"] = try RaviJSON.fromEncodable(object)
    return try await transport.call(groupSegments: ["permissions"], command: "revoke", body: requestBody, as: PermissionsRevokeReturn.self)
  }

  public func sync() async throws -> PermissionsSyncReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["permissions"], command: "sync", body: requestBody, as: PermissionsSyncReturn.self)
  }
}

public struct ProjectsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var fixtures: ProjectsFixturesNamespace {
    ProjectsFixturesNamespace(transport: transport)
  }

  public var resources: ProjectsResourcesNamespace {
    ProjectsResourcesNamespace(transport: transport)
  }

  public var tasks: ProjectsTasksNamespace {
    ProjectsTasksNamespace(transport: transport)
  }

  public var workflows: ProjectsWorkflowsNamespace {
    ProjectsWorkflowsNamespace(transport: transport)
  }

  public func create(_ title: String, _ options: ProjectsCreateOptions = .init()) async throws -> ProjectsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects"], command: "create", body: requestBody, as: ProjectsCreateReturn.self)
  }

  public func init_(_ title: String, _ options: ProjectsInitOptions = .init()) async throws -> ProjectsInitReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects"], command: "init", body: requestBody, as: ProjectsInitReturn.self)
  }

  public func link(_ assetType: String, _ project: String, _ target: String, _ options: ProjectsLinkOptions = .init()) async throws -> ProjectsLinkReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["assetType"] = try RaviJSON.fromEncodable(assetType)
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects"], command: "link", body: requestBody, as: ProjectsLinkReturn.self)
  }

  public func list(_ options: ProjectsListOptions = .init()) async throws -> ProjectsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects"], command: "list", body: requestBody, as: ProjectsListReturn.self)
  }

  public func next(_ options: ProjectsNextOptions = .init()) async throws -> ProjectsNextReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects"], command: "next", body: requestBody, as: ProjectsNextReturn.self)
  }

  public func show(_ project: String) async throws -> ProjectsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    return try await transport.call(groupSegments: ["projects"], command: "show", body: requestBody, as: ProjectsShowReturn.self)
  }

  public func status(_ project: String) async throws -> ProjectsStatusReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    return try await transport.call(groupSegments: ["projects"], command: "status", body: requestBody, as: ProjectsStatusReturn.self)
  }

  public func update(_ project: String, _ options: ProjectsUpdateOptions = .init()) async throws -> ProjectsUpdateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects"], command: "update", body: requestBody, as: ProjectsUpdateReturn.self)
  }
}

public struct ProjectsFixturesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func seed(_ options: ProjectsFixturesSeedOptions = .init()) async throws -> ProjectsFixturesSeedReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects","fixtures"], command: "seed", body: requestBody, as: ProjectsFixturesSeedReturn.self)
  }
}

public struct ProjectsResourcesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ project: String, _ target: String, _ options: ProjectsResourcesAddOptions = .init()) async throws -> ProjectsResourcesAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects","resources"], command: "add", body: requestBody, as: ProjectsResourcesAddReturn.self)
  }

  public func import_(_ project: String, _ options: ProjectsResourcesImportOptions = .init()) async throws -> ProjectsResourcesImportReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects","resources"], command: "import", body: requestBody, as: ProjectsResourcesImportReturn.self)
  }

  public func list(_ project: String, _ options: ProjectsResourcesListOptions = .init()) async throws -> ProjectsResourcesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects","resources"], command: "list", body: requestBody, as: ProjectsResourcesListReturn.self)
  }

  public func show(_ project: String, _ resource: String) async throws -> ProjectsResourcesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    requestBody["resource"] = try RaviJSON.fromEncodable(resource)
    return try await transport.call(groupSegments: ["projects","resources"], command: "show", body: requestBody, as: ProjectsResourcesShowReturn.self)
  }
}

public struct ProjectsTasksNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func attach(_ project: String, _ nodeKey: String, _ taskId: String, _ options: ProjectsTasksAttachOptions = .init()) async throws -> ProjectsTasksAttachReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    requestBody["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects","tasks"], command: "attach", body: requestBody, as: ProjectsTasksAttachReturn.self)
  }

  public func create(_ project: String, _ nodeKey: String, _ title: String, _ options: ProjectsTasksCreateOptions = .init()) async throws -> ProjectsTasksCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    requestBody["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    requestBody["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects","tasks"], command: "create", body: requestBody, as: ProjectsTasksCreateReturn.self)
  }

  public func dispatch(_ project: String, _ taskId: String, _ options: ProjectsTasksDispatchOptions = .init()) async throws -> ProjectsTasksDispatchReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects","tasks"], command: "dispatch", body: requestBody, as: ProjectsTasksDispatchReturn.self)
  }
}

public struct ProjectsWorkflowsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func attach(_ project: String, _ runId: String, _ options: ProjectsWorkflowsAttachOptions = .init()) async throws -> ProjectsWorkflowsAttachReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    requestBody["runId"] = try RaviJSON.fromEncodable(runId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects","workflows"], command: "attach", body: requestBody, as: ProjectsWorkflowsAttachReturn.self)
  }

  public func start(_ project: String, _ specId: String, _ options: ProjectsWorkflowsStartOptions = .init()) async throws -> ProjectsWorkflowsStartReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["project"] = try RaviJSON.fromEncodable(project)
    requestBody["specId"] = try RaviJSON.fromEncodable(specId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["projects","workflows"], command: "start", body: requestBody, as: ProjectsWorkflowsStartReturn.self)
  }
}

public struct ProxNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var calls: ProxCallsNamespace {
    ProxCallsNamespace(transport: transport)
  }
}

public struct ProxCallsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var profiles: ProxCallsProfilesNamespace {
    ProxCallsProfilesNamespace(transport: transport)
  }

  public var tools: ProxCallsToolsNamespace {
    ProxCallsToolsNamespace(transport: transport)
  }

  public var voiceAgents: ProxCallsVoiceAgentsNamespace {
    ProxCallsVoiceAgentsNamespace(transport: transport)
  }

  public func cancel(_ callRequestId: String, _ options: ProxCallsCancelOptions = .init()) async throws -> ProxCallsCancelReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls"], command: "cancel", body: requestBody, as: ProxCallsCancelReturn.self)
  }

  public func events(_ callRequestId: String) async throws -> ProxCallsEventsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    return try await transport.call(groupSegments: ["prox","calls"], command: "events", body: requestBody, as: ProxCallsEventsReturn.self)
  }

  public func request(_ options: ProxCallsRequestOptions = .init()) async throws -> ProxCallsRequestReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls"], command: "request", body: requestBody, as: ProxCallsRequestReturn.self)
  }

  public func rules(_ options: ProxCallsRulesOptions = .init()) async throws -> ProxCallsRulesReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls"], command: "rules", body: requestBody, as: ProxCallsRulesReturn.self)
  }

  public func show(_ callRequestId: String) async throws -> ProxCallsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    return try await transport.call(groupSegments: ["prox","calls"], command: "show", body: requestBody, as: ProxCallsShowReturn.self)
  }

  public func transcript(_ callRequestId: String, _ options: ProxCallsTranscriptOptions = .init()) async throws -> ProxCallsTranscriptReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls"], command: "transcript", body: requestBody, as: ProxCallsTranscriptReturn.self)
  }
}

public struct ProxCallsProfilesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func configure(_ profileId: String, _ options: ProxCallsProfilesConfigureOptions = .init()) async throws -> ProxCallsProfilesConfigureReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profile_id"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","profiles"], command: "configure", body: requestBody, as: ProxCallsProfilesConfigureReturn.self)
  }

  public func list(_ options: ProxCallsProfilesListOptions = .init()) async throws -> ProxCallsProfilesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","profiles"], command: "list", body: requestBody, as: ProxCallsProfilesListReturn.self)
  }

  public func show(_ profileId: String) async throws -> ProxCallsProfilesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profile_id"] = try RaviJSON.fromEncodable(profileId)
    return try await transport.call(groupSegments: ["prox","calls","profiles"], command: "show", body: requestBody, as: ProxCallsProfilesShowReturn.self)
  }
}

public struct ProxCallsToolsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func bind(_ profileId: String, _ toolId: String, _ options: ProxCallsToolsBindOptions = .init()) async throws -> ProxCallsToolsBindReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profile_id"] = try RaviJSON.fromEncodable(profileId)
    requestBody["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "bind", body: requestBody, as: ProxCallsToolsBindReturn.self)
  }

  public func configure(_ toolId: String, _ options: ProxCallsToolsConfigureOptions = .init()) async throws -> ProxCallsToolsConfigureReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "configure", body: requestBody, as: ProxCallsToolsConfigureReturn.self)
  }

  public func create(_ toolId: String, _ options: ProxCallsToolsCreateOptions = .init()) async throws -> ProxCallsToolsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "create", body: requestBody, as: ProxCallsToolsCreateReturn.self)
  }

  public func list(_ options: ProxCallsToolsListOptions = .init()) async throws -> ProxCallsToolsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "list", body: requestBody, as: ProxCallsToolsListReturn.self)
  }

  public func run(_ toolId: String, _ options: ProxCallsToolsRunOptions = .init()) async throws -> ProxCallsToolsRunReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "run", body: requestBody, as: ProxCallsToolsRunReturn.self)
  }

  public func runs(_ callRequestId: String) async throws -> ProxCallsToolsRunsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "runs", body: requestBody, as: ProxCallsToolsRunsReturn.self)
  }

  public func show(_ toolId: String) async throws -> ProxCallsToolsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["tool_id"] = try RaviJSON.fromEncodable(toolId)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "show", body: requestBody, as: ProxCallsToolsShowReturn.self)
  }

  public func unbind(_ profileId: String, _ toolId: String) async throws -> ProxCallsToolsUnbindReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profile_id"] = try RaviJSON.fromEncodable(profileId)
    requestBody["tool_id"] = try RaviJSON.fromEncodable(toolId)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "unbind", body: requestBody, as: ProxCallsToolsUnbindReturn.self)
  }
}

public struct ProxCallsVoiceAgentsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func bindTool(_ voiceAgentId: String, _ toolId: String, _ options: ProxCallsVoiceAgentsBindToolOptions = .init()) async throws -> ProxCallsVoiceAgentsBindToolReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    requestBody["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "bind-tool", body: requestBody, as: ProxCallsVoiceAgentsBindToolReturn.self)
  }

  public func configure(_ voiceAgentId: String, _ options: ProxCallsVoiceAgentsConfigureOptions = .init()) async throws -> ProxCallsVoiceAgentsConfigureReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "configure", body: requestBody, as: ProxCallsVoiceAgentsConfigureReturn.self)
  }

  public func create(_ voiceAgentId: String, _ options: ProxCallsVoiceAgentsCreateOptions = .init()) async throws -> ProxCallsVoiceAgentsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "create", body: requestBody, as: ProxCallsVoiceAgentsCreateReturn.self)
  }

  public func list(_ options: ProxCallsVoiceAgentsListOptions = .init()) async throws -> ProxCallsVoiceAgentsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "list", body: requestBody, as: ProxCallsVoiceAgentsListReturn.self)
  }

  public func show(_ voiceAgentId: String) async throws -> ProxCallsVoiceAgentsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "show", body: requestBody, as: ProxCallsVoiceAgentsShowReturn.self)
  }

  public func sync(_ voiceAgentId: String, _ options: ProxCallsVoiceAgentsSyncOptions = .init()) async throws -> ProxCallsVoiceAgentsSyncReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "sync", body: requestBody, as: ProxCallsVoiceAgentsSyncReturn.self)
  }

  public func unbindTool(_ voiceAgentId: String, _ toolId: String) async throws -> ProxCallsVoiceAgentsUnbindToolReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    requestBody["tool_id"] = try RaviJSON.fromEncodable(toolId)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "unbind-tool", body: requestBody, as: ProxCallsVoiceAgentsUnbindToolReturn.self)
  }
}

public struct ReactNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func send(_ messageId: String, _ emoji: String) async throws -> ReactSendReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["messageId"] = try RaviJSON.fromEncodable(messageId)
    requestBody["emoji"] = try RaviJSON.fromEncodable(emoji)
    return try await transport.call(groupSegments: ["react"], command: "send", body: requestBody, as: ReactSendReturn.self)
  }
}

public struct RoutesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func explain(_ name: String, _ pattern: String, _ options: RoutesExplainOptions = .init()) async throws -> RoutesExplainReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["pattern"] = try RaviJSON.fromEncodable(pattern)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["routes"], command: "explain", body: requestBody, as: RoutesExplainReturn.self)
  }

  public func list(_ name: String? = nil, _ options: RoutesListOptions = .init()) async throws -> RoutesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let name {
      requestBody["name"] = try RaviJSON.fromEncodable(name)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["routes"], command: "list", body: requestBody, as: RoutesListReturn.self)
  }

  public func show(_ name: String, _ pattern: String) async throws -> RoutesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["pattern"] = try RaviJSON.fromEncodable(pattern)
    return try await transport.call(groupSegments: ["routes"], command: "show", body: requestBody, as: RoutesShowReturn.self)
  }
}

public struct RulesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func import_(_ source: String? = nil, _ options: RulesImportOptions = .init()) async throws -> RulesImportReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let source {
      requestBody["source"] = try RaviJSON.fromEncodable(source)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["rules"], command: "import", body: requestBody, as: RulesImportReturn.self)
  }

  public func sources(_ source: String? = nil, _ options: RulesSourcesOptions = .init()) async throws -> RulesSourcesReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let source {
      requestBody["source"] = try RaviJSON.fromEncodable(source)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["rules"], command: "sources", body: requestBody, as: RulesSourcesReturn.self)
  }
}

public struct RuntimeNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var credentials: RuntimeCredentialsNamespace {
    RuntimeCredentialsNamespace(transport: transport)
  }
}

public struct RuntimeCredentialsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ options: RuntimeCredentialsAddOptions = .init()) async throws -> RuntimeCredentialsAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "add", body: requestBody, as: RuntimeCredentialsAddReturn.self)
  }

  public func classify(_ options: RuntimeCredentialsClassifyOptions = .init()) async throws -> RuntimeCredentialsClassifyReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "classify", body: requestBody, as: RuntimeCredentialsClassifyReturn.self)
  }

  public func disable(_ id: String) async throws -> RuntimeCredentialsDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "disable", body: requestBody, as: RuntimeCredentialsDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> RuntimeCredentialsEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "enable", body: requestBody, as: RuntimeCredentialsEnableReturn.self)
  }

  public func import_(_ options: RuntimeCredentialsImportOptions = .init()) async throws -> RuntimeCredentialsImportReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "import", body: requestBody, as: RuntimeCredentialsImportReturn.self)
  }

  public func list(_ options: RuntimeCredentialsListOptions = .init()) async throws -> RuntimeCredentialsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "list", body: requestBody, as: RuntimeCredentialsListReturn.self)
  }

  public func refresh(_ id: String? = nil, _ options: RuntimeCredentialsRefreshOptions = .init()) async throws -> RuntimeCredentialsRefreshReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let id {
      requestBody["id"] = try RaviJSON.fromEncodable(id)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "refresh", body: requestBody, as: RuntimeCredentialsRefreshReturn.self)
  }

  public func resetHealth(_ id: String) async throws -> RuntimeCredentialsResetHealthReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "reset-health", body: requestBody, as: RuntimeCredentialsResetHealthReturn.self)
  }

  public func select(_ options: RuntimeCredentialsSelectOptions = .init()) async throws -> RuntimeCredentialsSelectReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "select", body: requestBody, as: RuntimeCredentialsSelectReturn.self)
  }

  public func status(_ id: String? = nil) async throws -> RuntimeCredentialsStatusReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let id {
      requestBody["id"] = try RaviJSON.fromEncodable(id)
    }
    return try await transport.call(groupSegments: ["runtime","credentials"], command: "status", body: requestBody, as: RuntimeCredentialsStatusReturn.self)
  }
}

public struct SdkNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var client: SdkClientNamespace {
    SdkClientNamespace(transport: transport)
  }

  public var openapi: SdkOpenapiNamespace {
    SdkOpenapiNamespace(transport: transport)
  }

  public var swift: SdkSwiftNamespace {
    SdkSwiftNamespace(transport: transport)
  }
}

public struct SdkClientNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func check(_ options: SdkClientCheckOptions = .init()) async throws -> SdkClientCheckReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sdk","client"], command: "check", body: requestBody, as: SdkClientCheckReturn.self)
  }

  public func generate(_ options: SdkClientGenerateOptions = .init()) async throws -> SdkClientGenerateReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sdk","client"], command: "generate", body: requestBody, as: SdkClientGenerateReturn.self)
  }
}

public struct SdkOpenapiNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func check(_ options: SdkOpenapiCheckOptions = .init()) async throws -> SdkOpenapiCheckReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sdk","openapi"], command: "check", body: requestBody, as: SdkOpenapiCheckReturn.self)
  }

  public func emit(_ options: SdkOpenapiEmitOptions = .init()) async throws -> SdkOpenapiEmitReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sdk","openapi"], command: "emit", body: requestBody, as: SdkOpenapiEmitReturn.self)
  }
}

public struct SdkSwiftNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func check(_ options: SdkSwiftCheckOptions = .init()) async throws -> SdkSwiftCheckReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sdk","swift"], command: "check", body: requestBody, as: SdkSwiftCheckReturn.self)
  }

  public func generate(_ options: SdkSwiftGenerateOptions = .init()) async throws -> SdkSwiftGenerateReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sdk","swift"], command: "generate", body: requestBody, as: SdkSwiftGenerateReturn.self)
  }
}

public struct SelfNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func chat(_ options: SelfChatOptions = .init()) async throws -> SelfChatReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["self"], command: "chat", body: requestBody, as: SelfChatReturn.self)
  }

  public func context(_ options: SelfContextOptions = .init()) async throws -> SelfContextReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["self"], command: "context", body: requestBody, as: SelfContextReturn.self)
  }

  public func explain() async throws -> SelfExplainReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "explain", body: requestBody, as: SelfExplainReturn.self)
  }

  public func knowledge() async throws -> SelfKnowledgeReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "knowledge", body: requestBody, as: SelfKnowledgeReturn.self)
  }

  public func permissions() async throws -> SelfPermissionsReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "permissions", body: requestBody, as: SelfPermissionsReturn.self)
  }

  public func recent(_ options: SelfRecentOptions = .init()) async throws -> SelfRecentReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["self"], command: "recent", body: requestBody, as: SelfRecentReturn.self)
  }

  public func route() async throws -> SelfRouteReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "route", body: requestBody, as: SelfRouteReturn.self)
  }

  public func whoami() async throws -> SelfWhoamiReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "whoami", body: requestBody, as: SelfWhoamiReturn.self)
  }
}

public struct ServiceNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func start() async throws -> ServiceStartReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["service"], command: "start", body: requestBody, as: ServiceStartReturn.self)
  }

  public func tui(_ session: String? = nil) async throws -> ServiceTuiReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let session {
      requestBody["session"] = try RaviJSON.fromEncodable(session)
    }
    return try await transport.call(groupSegments: ["service"], command: "tui", body: requestBody, as: ServiceTuiReturn.self)
  }

  public func wa() async throws -> ServiceWaReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["service"], command: "wa", body: requestBody, as: ServiceWaReturn.self)
  }
}

public struct SessionsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var runtime: SessionsRuntimeNamespace {
    SessionsRuntimeNamespace(transport: transport)
  }

  public func actions(_ nameOrKey: String? = nil, _ options: SessionsActionsOptions = .init()) async throws -> SessionsActionsReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let nameOrKey {
      requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "actions", body: requestBody, as: SessionsActionsReturn.self)
  }

  public func answer(_ target: String, _ message: String, _ sender: String? = nil, _ options: SessionsAnswerOptions = .init()) async throws -> SessionsAnswerReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    requestBody["message"] = try RaviJSON.fromEncodable(message)
    if let sender {
      requestBody["sender"] = try RaviJSON.fromEncodable(sender)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "answer", body: requestBody, as: SessionsAnswerReturn.self)
  }

  public func ask(_ target: String, _ message: String, _ sender: String? = nil, _ options: SessionsAskOptions = .init()) async throws -> SessionsAskReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    requestBody["message"] = try RaviJSON.fromEncodable(message)
    if let sender {
      requestBody["sender"] = try RaviJSON.fromEncodable(sender)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "ask", body: requestBody, as: SessionsAskReturn.self)
  }

  public func attach(_ nameOrKey: String, _ options: SessionsAttachOptions = .init()) async throws -> SessionsAttachReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "attach", body: requestBody, as: SessionsAttachReturn.self)
  }

  public func delete(_ nameOrKey: String) async throws -> SessionsDeleteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "delete", body: requestBody, as: SessionsDeleteReturn.self)
  }

  public func deleteMessage(_ sessionOrMessage: String, _ messageRef: String? = nil) async throws -> SessionsDeleteMessageReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["sessionOrMessage"] = try RaviJSON.fromEncodable(sessionOrMessage)
    if let messageRef {
      requestBody["messageRef"] = try RaviJSON.fromEncodable(messageRef)
    }
    return try await transport.call(groupSegments: ["sessions"], command: "delete-message", body: requestBody, as: SessionsDeleteMessageReturn.self)
  }

  public func detach(_ nameOrKey: String, _ options: SessionsDetachOptions = .init()) async throws -> SessionsDetachReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "detach", body: requestBody, as: SessionsDetachReturn.self)
  }

  public func editMessage(_ sessionOrMessage: String, _ messageOrText: String? = nil, _ textArg: String? = nil, _ options: SessionsEditMessageOptions = .init()) async throws -> SessionsEditMessageReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["sessionOrMessage"] = try RaviJSON.fromEncodable(sessionOrMessage)
    if let messageOrText {
      requestBody["messageOrText"] = try RaviJSON.fromEncodable(messageOrText)
    }
    if let textArg {
      requestBody["textArg"] = try RaviJSON.fromEncodable(textArg)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "edit-message", body: requestBody, as: SessionsEditMessageReturn.self)
  }

  public func execute(_ target: String, _ message: String, _ options: SessionsExecuteOptions = .init()) async throws -> SessionsExecuteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    requestBody["message"] = try RaviJSON.fromEncodable(message)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "execute", body: requestBody, as: SessionsExecuteReturn.self)
  }

  public func extend(_ nameOrKey: String, _ duration: String? = nil) async throws -> SessionsExtendReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    if let duration {
      requestBody["duration"] = try RaviJSON.fromEncodable(duration)
    }
    return try await transport.call(groupSegments: ["sessions"], command: "extend", body: requestBody, as: SessionsExtendReturn.self)
  }

  public func goal(_ action: String, _ nameOrKey: String, _ objective: String? = nil, _ options: SessionsGoalOptions = .init()) async throws -> SessionsGoalReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["action"] = try RaviJSON.fromEncodable(action)
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    if let objective {
      requestBody["objective"] = try RaviJSON.fromEncodable(objective)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "goal", body: requestBody, as: SessionsGoalReturn.self)
  }

  public func info(_ nameOrKey: String) async throws -> SessionsInfoReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "info", body: requestBody, as: SessionsInfoReturn.self)
  }

  public func inform(_ target: String, _ message: String, _ options: SessionsInformOptions = .init()) async throws -> SessionsInformReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    requestBody["message"] = try RaviJSON.fromEncodable(message)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "inform", body: requestBody, as: SessionsInformReturn.self)
  }

  public func keep(_ nameOrKey: String) async throws -> SessionsKeepReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "keep", body: requestBody, as: SessionsKeepReturn.self)
  }

  public func list(_ options: SessionsListOptions = .init()) async throws -> SessionsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "list", body: requestBody, as: SessionsListReturn.self)
  }

  public func mute(_ nameOrKey: String, _ options: SessionsMuteOptions = .init()) async throws -> SessionsMuteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "mute", body: requestBody, as: SessionsMuteReturn.self)
  }

  public func prune(_ options: SessionsPruneOptions = .init()) async throws -> SessionsPruneReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "prune", body: requestBody, as: SessionsPruneReturn.self)
  }

  public func read(_ nameOrKey: String? = nil, _ options: SessionsReadOptions = .init()) async throws -> SessionsReadReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let nameOrKey {
      requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "read", body: requestBody, as: SessionsReadReturn.self)
  }

  public func rename(_ nameOrKey: String, _ newName: String) async throws -> SessionsRenameReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    requestBody["newName"] = try RaviJSON.fromEncodable(newName)
    return try await transport.call(groupSegments: ["sessions"], command: "rename", body: requestBody, as: SessionsRenameReturn.self)
  }

  public func reset(_ nameOrKey: String) async throws -> SessionsResetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "reset", body: requestBody, as: SessionsResetReturn.self)
  }

  public func send(_ nameOrKey: String, _ prompt: String? = nil, _ options: SessionsSendOptions = .init()) async throws -> SessionsSendReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    if let prompt {
      requestBody["prompt"] = try RaviJSON.fromEncodable(prompt)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "send", body: requestBody, as: SessionsSendReturn.self)
  }

  public func setDisplay(_ nameOrKey: String, _ displayName: String) async throws -> SessionsSetDisplayReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    requestBody["displayName"] = try RaviJSON.fromEncodable(displayName)
    return try await transport.call(groupSegments: ["sessions"], command: "set-display", body: requestBody, as: SessionsSetDisplayReturn.self)
  }

  public func setModel(_ nameOrKey: String, _ model: String) async throws -> SessionsSetModelReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    requestBody["model"] = try RaviJSON.fromEncodable(model)
    return try await transport.call(groupSegments: ["sessions"], command: "set-model", body: requestBody, as: SessionsSetModelReturn.self)
  }

  public func setThinking(_ nameOrKey: String, _ level: String) async throws -> SessionsSetThinkingReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    requestBody["level"] = try RaviJSON.fromEncodable(level)
    return try await transport.call(groupSegments: ["sessions"], command: "set-thinking", body: requestBody, as: SessionsSetThinkingReturn.self)
  }

  public func setTtl(_ nameOrKey: String, _ duration: String) async throws -> SessionsSetTtlReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    requestBody["duration"] = try RaviJSON.fromEncodable(duration)
    return try await transport.call(groupSegments: ["sessions"], command: "set-ttl", body: requestBody, as: SessionsSetTtlReturn.self)
  }

  public func subscriptions(_ nameOrKey: String) async throws -> SessionsSubscriptionsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "subscriptions", body: requestBody, as: SessionsSubscriptionsReturn.self)
  }

  public func trace(_ nameOrKey: String, _ options: SessionsTraceOptions = .init()) async throws -> SessionsTraceReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "trace", body: requestBody, as: SessionsTraceReturn.self)
  }

  public func unmute(_ nameOrKey: String, _ options: SessionsUnmuteOptions = .init()) async throws -> SessionsUnmuteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions"], command: "unmute", body: requestBody, as: SessionsUnmuteReturn.self)
  }

  public func visibility(_ nameOrKey: String) async throws -> SessionsVisibilityReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "visibility", body: requestBody, as: SessionsVisibilityReturn.self)
  }
}

public struct SessionsRuntimeNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func followUp(_ session: String, _ text: String, _ options: SessionsRuntimeFollowUpOptions = .init()) async throws -> SessionsRuntimeFollowUpReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    requestBody["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "follow-up", body: requestBody, as: SessionsRuntimeFollowUpReturn.self)
  }

  public func fork(_ session: String, _ threadId: String? = nil, _ options: SessionsRuntimeForkOptions = .init()) async throws -> SessionsRuntimeForkReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    if let threadId {
      requestBody["threadId"] = try RaviJSON.fromEncodable(threadId)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "fork", body: requestBody, as: SessionsRuntimeForkReturn.self)
  }

  public func interrupt(_ session: String, _ options: SessionsRuntimeInterruptOptions = .init()) async throws -> SessionsRuntimeInterruptReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "interrupt", body: requestBody, as: SessionsRuntimeInterruptReturn.self)
  }

  public func list(_ session: String, _ options: SessionsRuntimeListOptions = .init()) async throws -> SessionsRuntimeListReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "list", body: requestBody, as: SessionsRuntimeListReturn.self)
  }

  public func read(_ session: String, _ threadId: String? = nil, _ options: SessionsRuntimeReadOptions = .init()) async throws -> SessionsRuntimeReadReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    if let threadId {
      requestBody["threadId"] = try RaviJSON.fromEncodable(threadId)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "read", body: requestBody, as: SessionsRuntimeReadReturn.self)
  }

  public func rollback(_ session: String, _ turns: String? = nil, _ options: SessionsRuntimeRollbackOptions = .init()) async throws -> SessionsRuntimeRollbackReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    if let turns {
      requestBody["turns"] = try RaviJSON.fromEncodable(turns)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "rollback", body: requestBody, as: SessionsRuntimeRollbackReturn.self)
  }

  public func steer(_ session: String, _ text: String, _ options: SessionsRuntimeSteerOptions = .init()) async throws -> SessionsRuntimeSteerReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["session"] = try RaviJSON.fromEncodable(session)
    requestBody["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "steer", body: requestBody, as: SessionsRuntimeSteerReturn.self)
  }
}

public struct SettingsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func delete(_ key: String) async throws -> SettingsDeleteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    return try await transport.call(groupSegments: ["settings"], command: "delete", body: requestBody, as: SettingsDeleteReturn.self)
  }

  public func get(_ key: String) async throws -> SettingsGetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    return try await transport.call(groupSegments: ["settings"], command: "get", body: requestBody, as: SettingsGetReturn.self)
  }

  public func list(_ options: SettingsListOptions = .init()) async throws -> SettingsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["settings"], command: "list", body: requestBody, as: SettingsListReturn.self)
  }

  public func set(_ key: String, _ value: String) async throws -> SettingsSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["settings"], command: "set", body: requestBody, as: SettingsSetReturn.self)
  }
}

public struct SkillGatesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func disable(_ id: String) async throws -> SkillGatesDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "disable", body: requestBody, as: SkillGatesDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> SkillGatesEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "enable", body: requestBody, as: SkillGatesEnableReturn.self)
  }

  public func list(_ options: SkillGatesListOptions = .init()) async throws -> SkillGatesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["skill-gates"], command: "list", body: requestBody, as: SkillGatesListReturn.self)
  }

  public func reset(_ id: String) async throws -> SkillGatesResetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "reset", body: requestBody, as: SkillGatesResetReturn.self)
  }

  public func rm(_ id: String) async throws -> SkillGatesRmReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "rm", body: requestBody, as: SkillGatesRmReturn.self)
  }

  public func set(_ id: String, _ skill: String, _ options: SkillGatesSetOptions = .init()) async throws -> SkillGatesSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["skill"] = try RaviJSON.fromEncodable(skill)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["skill-gates"], command: "set", body: requestBody, as: SkillGatesSetReturn.self)
  }

  public func show(_ id: String) async throws -> SkillGatesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "show", body: requestBody, as: SkillGatesShowReturn.self)
  }
}

public struct SkillsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func install(_ name: String? = nil, _ options: SkillsInstallOptions = .init()) async throws -> SkillsInstallReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let name {
      requestBody["name"] = try RaviJSON.fromEncodable(name)
    }
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["skills"], command: "install", body: requestBody, as: SkillsInstallReturn.self)
  }

  public func list(_ options: SkillsListOptions = .init()) async throws -> SkillsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["skills"], command: "list", body: requestBody, as: SkillsListReturn.self)
  }

  public func show(_ name: String, _ options: SkillsShowOptions = .init()) async throws -> SkillsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["skills"], command: "show", body: requestBody, as: SkillsShowReturn.self)
  }

  public func sync() async throws -> SkillsSyncReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["skills"], command: "sync", body: requestBody, as: SkillsSyncReturn.self)
  }
}

public struct SpecsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func get(_ id: String, _ options: SpecsGetOptions = .init()) async throws -> SpecsGetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["specs"], command: "get", body: requestBody, as: SpecsGetReturn.self)
  }

  public func list(_ options: SpecsListOptions = .init()) async throws -> SpecsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["specs"], command: "list", body: requestBody, as: SpecsListReturn.self)
  }

  public func new(_ id: String, _ options: SpecsNewOptions = .init()) async throws -> SpecsNewReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["specs"], command: "new", body: requestBody, as: SpecsNewReturn.self)
  }

  public func sync() async throws -> SpecsSyncReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["specs"], command: "sync", body: requestBody, as: SpecsSyncReturn.self)
  }
}

public struct StickersNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ id: String, _ mediaPath: String, _ options: StickersAddOptions = .init()) async throws -> StickersAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["mediaPath"] = try RaviJSON.fromEncodable(mediaPath)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["stickers"], command: "add", body: requestBody, as: StickersAddReturn.self)
  }

  public func list(_ options: StickersListOptions = .init()) async throws -> StickersListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["stickers"], command: "list", body: requestBody, as: StickersListReturn.self)
  }

  public func remove(_ id: String) async throws -> StickersRemoveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["stickers"], command: "remove", body: requestBody, as: StickersRemoveReturn.self)
  }

  public func send(_ id: String, _ options: StickersSendOptions = .init()) async throws -> StickersSendReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["stickers"], command: "send", body: requestBody, as: StickersSendReturn.self)
  }

  public func show(_ id: String) async throws -> StickersShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["stickers"], command: "show", body: requestBody, as: StickersShowReturn.self)
  }
}

public struct TagRulesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func evaluate(_ ruleId: String, _ options: TagRulesEvaluateOptions = .init()) async throws -> TagRulesEvaluateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["ruleId"] = try RaviJSON.fromEncodable(ruleId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tag-rules"], command: "evaluate", body: requestBody, as: TagRulesEvaluateReturn.self)
  }

  public func explain(_ options: TagRulesExplainOptions = .init()) async throws -> TagRulesExplainReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tag-rules"], command: "explain", body: requestBody, as: TagRulesExplainReturn.self)
  }

  public func list(_ options: TagRulesListOptions = .init()) async throws -> TagRulesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tag-rules"], command: "list", body: requestBody, as: TagRulesListReturn.self)
  }

  public func show(_ id: String) async throws -> TagRulesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["tag-rules"], command: "show", body: requestBody, as: TagRulesShowReturn.self)
  }

  public func tick(_ options: TagRulesTickOptions = .init()) async throws -> TagRulesTickReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tag-rules"], command: "tick", body: requestBody, as: TagRulesTickReturn.self)
  }

  public func validate() async throws -> TagRulesValidateReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["tag-rules"], command: "validate", body: requestBody, as: TagRulesValidateReturn.self)
  }
}

public struct TagsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func attach(_ slug: String, _ options: TagsAttachOptions = .init()) async throws -> TagsAttachReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["slug"] = try RaviJSON.fromEncodable(slug)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tags"], command: "attach", body: requestBody, as: TagsAttachReturn.self)
  }

  public func create(_ slug: String, _ options: TagsCreateOptions = .init()) async throws -> TagsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["slug"] = try RaviJSON.fromEncodable(slug)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tags"], command: "create", body: requestBody, as: TagsCreateReturn.self)
  }

  public func detach(_ slug: String, _ options: TagsDetachOptions = .init()) async throws -> TagsDetachReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["slug"] = try RaviJSON.fromEncodable(slug)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tags"], command: "detach", body: requestBody, as: TagsDetachReturn.self)
  }

  public func list(_ options: TagsListOptions = .init()) async throws -> TagsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tags"], command: "list", body: requestBody, as: TagsListReturn.self)
  }

  public func search(_ options: TagsSearchOptions = .init()) async throws -> TagsSearchReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tags"], command: "search", body: requestBody, as: TagsSearchReturn.self)
  }

  public func set(_ slug: String, _ key: String, _ value: String) async throws -> TagsSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["slug"] = try RaviJSON.fromEncodable(slug)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["tags"], command: "set", body: requestBody, as: TagsSetReturn.self)
  }

  public func show(_ slug: String) async throws -> TagsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["slug"] = try RaviJSON.fromEncodable(slug)
    return try await transport.call(groupSegments: ["tags"], command: "show", body: requestBody, as: TagsShowReturn.self)
  }
}

public struct TasksNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var automations: TasksAutomationsNamespace {
    TasksAutomationsNamespace(transport: transport)
  }

  public var deps: TasksDepsNamespace {
    TasksDepsNamespace(transport: transport)
  }

  public var profiles: TasksProfilesNamespace {
    TasksProfilesNamespace(transport: transport)
  }

  public func archive(_ taskId: String, _ options: TasksArchiveOptions = .init()) async throws -> TasksArchiveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks"], command: "archive", body: requestBody, as: TasksArchiveReturn.self)
  }

  public func block(_ taskId: String, _ options: TasksBlockOptions = .init()) async throws -> TasksBlockReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks"], command: "block", body: requestBody, as: TasksBlockReturn.self)
  }

  public func comment(_ taskId: String, _ body: String) async throws -> TasksCommentReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    requestBody["body"] = try RaviJSON.fromEncodable(body)
    return try await transport.call(groupSegments: ["tasks"], command: "comment", body: requestBody, as: TasksCommentReturn.self)
  }

  public func create(_ title: String, _ options: TasksCreateOptions = .init()) async throws -> TasksCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks"], command: "create", body: requestBody, as: TasksCreateReturn.self)
  }

  public func dispatch(_ taskId: String, _ options: TasksDispatchOptions = .init()) async throws -> TasksDispatchReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks"], command: "dispatch", body: requestBody, as: TasksDispatchReturn.self)
  }

  public func done(_ taskId: String, _ options: TasksDoneOptions = .init()) async throws -> TasksDoneReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks"], command: "done", body: requestBody, as: TasksDoneReturn.self)
  }

  public func fail(_ taskId: String, _ options: TasksFailOptions = .init()) async throws -> TasksFailReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks"], command: "fail", body: requestBody, as: TasksFailReturn.self)
  }

  public func list(_ options: TasksListOptions = .init()) async throws -> TasksListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks"], command: "list", body: requestBody, as: TasksListReturn.self)
  }

  public func report(_ taskId: String, _ options: TasksReportOptions = .init()) async throws -> TasksReportReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks"], command: "report", body: requestBody, as: TasksReportReturn.self)
  }

  public func show(_ taskId: String, _ options: TasksShowOptions = .init()) async throws -> TasksShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks"], command: "show", body: requestBody, as: TasksShowReturn.self)
  }

  public func unarchive(_ taskId: String) async throws -> TasksUnarchiveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    return try await transport.call(groupSegments: ["tasks"], command: "unarchive", body: requestBody, as: TasksUnarchiveReturn.self)
  }
}

public struct TasksAutomationsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ name: String, _ options: TasksAutomationsAddOptions = .init()) async throws -> TasksAutomationsAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "add", body: requestBody, as: TasksAutomationsAddReturn.self)
  }

  public func disable(_ id: String) async throws -> TasksAutomationsDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "disable", body: requestBody, as: TasksAutomationsDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> TasksAutomationsEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "enable", body: requestBody, as: TasksAutomationsEnableReturn.self)
  }

  public func list(_ options: TasksAutomationsListOptions = .init()) async throws -> TasksAutomationsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "list", body: requestBody, as: TasksAutomationsListReturn.self)
  }

  public func rm(_ id: String) async throws -> TasksAutomationsRmReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "rm", body: requestBody, as: TasksAutomationsRmReturn.self)
  }

  public func show(_ id: String) async throws -> TasksAutomationsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "show", body: requestBody, as: TasksAutomationsShowReturn.self)
  }
}

public struct TasksDepsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ taskId: String, _ dependencyTaskId: String) async throws -> TasksDepsAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    requestBody["dependencyTaskId"] = try RaviJSON.fromEncodable(dependencyTaskId)
    return try await transport.call(groupSegments: ["tasks","deps"], command: "add", body: requestBody, as: TasksDepsAddReturn.self)
  }

  public func ls(_ taskId: String, _ options: TasksDepsLsOptions = .init()) async throws -> TasksDepsLsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks","deps"], command: "ls", body: requestBody, as: TasksDepsLsReturn.self)
  }

  public func rm(_ taskId: String, _ dependencyTaskId: String) async throws -> TasksDepsRmReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    requestBody["dependencyTaskId"] = try RaviJSON.fromEncodable(dependencyTaskId)
    return try await transport.call(groupSegments: ["tasks","deps"], command: "rm", body: requestBody, as: TasksDepsRmReturn.self)
  }
}

public struct TasksProfilesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func init_(_ profileId: String, _ options: TasksProfilesInitOptions = .init()) async throws -> TasksProfilesInitReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profileId"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "init", body: requestBody, as: TasksProfilesInitReturn.self)
  }

  public func list(_ options: TasksProfilesListOptions = .init()) async throws -> TasksProfilesListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "list", body: requestBody, as: TasksProfilesListReturn.self)
  }

  public func preview(_ profileId: String, _ options: TasksProfilesPreviewOptions = .init()) async throws -> TasksProfilesPreviewReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profileId"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "preview", body: requestBody, as: TasksProfilesPreviewReturn.self)
  }

  public func show(_ profileId: String) async throws -> TasksProfilesShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["profileId"] = try RaviJSON.fromEncodable(profileId)
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "show", body: requestBody, as: TasksProfilesShowReturn.self)
  }

  public func validate(_ profileId: String? = nil) async throws -> TasksProfilesValidateReturn {
    var requestBody: [String: RaviJSON] = [:]
    if let profileId {
      requestBody["profileId"] = try RaviJSON.fromEncodable(profileId)
    }
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "validate", body: requestBody, as: TasksProfilesValidateReturn.self)
  }
}

public struct ThreadsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func brief(_ thread: String, _ options: ThreadsBriefOptions = .init()) async throws -> ThreadsBriefReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["thread"] = try RaviJSON.fromEncodable(thread)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["threads"], command: "brief", body: requestBody, as: ThreadsBriefReturn.self)
  }

  public func close(_ thread: String, _ options: ThreadsCloseOptions = .init()) async throws -> ThreadsCloseReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["thread"] = try RaviJSON.fromEncodable(thread)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["threads"], command: "close", body: requestBody, as: ThreadsCloseReturn.self)
  }

  public func comment(_ thread: String, _ body: String, _ options: ThreadsCommentOptions = .init()) async throws -> ThreadsCommentReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["thread"] = try RaviJSON.fromEncodable(thread)
    requestBody["body"] = try RaviJSON.fromEncodable(body)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["threads"], command: "comment", body: requestBody, as: ThreadsCommentReturn.self)
  }

  public func create(_ slug: String, _ options: ThreadsCreateOptions = .init()) async throws -> ThreadsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["slug"] = try RaviJSON.fromEncodable(slug)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["threads"], command: "create", body: requestBody, as: ThreadsCreateReturn.self)
  }

  public func entries(_ thread: String, _ options: ThreadsEntriesOptions = .init()) async throws -> ThreadsEntriesReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["thread"] = try RaviJSON.fromEncodable(thread)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["threads"], command: "entries", body: requestBody, as: ThreadsEntriesReturn.self)
  }

  public func link(_ thread: String, _ target: String, _ options: ThreadsLinkOptions = .init()) async throws -> ThreadsLinkReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["thread"] = try RaviJSON.fromEncodable(thread)
    requestBody["target"] = try RaviJSON.fromEncodable(target)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["threads"], command: "link", body: requestBody, as: ThreadsLinkReturn.self)
  }

  public func list(_ options: ThreadsListOptions = .init()) async throws -> ThreadsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["threads"], command: "list", body: requestBody, as: ThreadsListReturn.self)
  }

  public func note(_ thread: String, _ body: String, _ options: ThreadsNoteOptions = .init()) async throws -> ThreadsNoteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["thread"] = try RaviJSON.fromEncodable(thread)
    requestBody["body"] = try RaviJSON.fromEncodable(body)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["threads"], command: "note", body: requestBody, as: ThreadsNoteReturn.self)
  }

  public func show(_ thread: String, _ options: ThreadsShowOptions = .init()) async throws -> ThreadsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["thread"] = try RaviJSON.fromEncodable(thread)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["threads"], command: "show", body: requestBody, as: ThreadsShowReturn.self)
  }
}

public struct ToolsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func list(_ options: ToolsListOptions = .init()) async throws -> ToolsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["tools"], command: "list", body: requestBody, as: ToolsListReturn.self)
  }

  public func manifest() async throws -> ToolsManifestReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["tools"], command: "manifest", body: requestBody, as: ToolsManifestReturn.self)
  }

  public func schema() async throws -> ToolsSchemaReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["tools"], command: "schema", body: requestBody, as: ToolsSchemaReturn.self)
  }

  public func show(_ name: String) async throws -> ToolsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["tools"], command: "show", body: requestBody, as: ToolsShowReturn.self)
  }

  public func test(_ name: String, _ args: String? = nil) async throws -> ToolsTestReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    if let args {
      requestBody["args"] = try RaviJSON.fromEncodable(args)
    }
    return try await transport.call(groupSegments: ["tools"], command: "test", body: requestBody, as: ToolsTestReturn.self)
  }
}

public struct TranscribeNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func file(_ path: String, _ options: TranscribeFileOptions = .init()) async throws -> TranscribeFileReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["path"] = try RaviJSON.fromEncodable(path)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["transcribe"], command: "file", body: requestBody, as: TranscribeFileReturn.self)
  }
}

public struct TriggersNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ name: String, _ options: TriggersAddOptions = .init()) async throws -> TriggersAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["triggers"], command: "add", body: requestBody, as: TriggersAddReturn.self)
  }

  public func disable(_ id: String) async throws -> TriggersDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "disable", body: requestBody, as: TriggersDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> TriggersEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "enable", body: requestBody, as: TriggersEnableReturn.self)
  }

  public func list(_ options: TriggersListOptions = .init()) async throws -> TriggersListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["triggers"], command: "list", body: requestBody, as: TriggersListReturn.self)
  }

  public func rm(_ id: String) async throws -> TriggersRmReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "rm", body: requestBody, as: TriggersRmReturn.self)
  }

  public func set(_ id: String, _ key: String, _ value: String) async throws -> TriggersSetReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    requestBody["key"] = try RaviJSON.fromEncodable(key)
    requestBody["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["triggers"], command: "set", body: requestBody, as: TriggersSetReturn.self)
  }

  public func show(_ id: String) async throws -> TriggersShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "show", body: requestBody, as: TriggersShowReturn.self)
  }

  public func test(_ id: String) async throws -> TriggersTestReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "test", body: requestBody, as: TriggersTestReturn.self)
  }

  public func topics() async throws -> TriggersTopicsReturn {
    let requestBody: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["triggers"], command: "topics", body: requestBody, as: TriggersTopicsReturn.self)
  }
}

public struct VideoNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func analyze(_ url: String, _ options: VideoAnalyzeOptions = .init()) async throws -> VideoAnalyzeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["url"] = try RaviJSON.fromEncodable(url)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["video"], command: "analyze", body: requestBody, as: VideoAnalyzeReturn.self)
  }
}

public struct WatchNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func connectors(_ options: WatchConnectorsOptions = .init()) async throws -> WatchConnectorsReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["watch"], command: "connectors", body: requestBody, as: WatchConnectorsReturn.self)
  }

  public func create(_ provider: String, _ resource: String, _ options: WatchCreateOptions = .init()) async throws -> WatchCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["provider"] = try RaviJSON.fromEncodable(provider)
    requestBody["resource"] = try RaviJSON.fromEncodable(resource)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["watch"], command: "create", body: requestBody, as: WatchCreateReturn.self)
  }

  public func disable(_ id: String) async throws -> WatchDisableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["watch"], command: "disable", body: requestBody, as: WatchDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> WatchEnableReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["watch"], command: "enable", body: requestBody, as: WatchEnableReturn.self)
  }

  public func events(_ id: String) async throws -> WatchEventsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["watch"], command: "events", body: requestBody, as: WatchEventsReturn.self)
  }

  public func list(_ options: WatchListOptions = .init()) async throws -> WatchListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["watch"], command: "list", body: requestBody, as: WatchListReturn.self)
  }

  public func rm(_ id: String) async throws -> WatchRmReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["watch"], command: "rm", body: requestBody, as: WatchRmReturn.self)
  }

  public func show(_ id: String) async throws -> WatchShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["watch"], command: "show", body: requestBody, as: WatchShowReturn.self)
  }

  public func trigger(_ id: String, _ options: WatchTriggerOptions = .init()) async throws -> WatchTriggerReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["watch"], command: "trigger", body: requestBody, as: WatchTriggerReturn.self)
  }
}

public struct WhatsappNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var dm: WhatsappDmNamespace {
    WhatsappDmNamespace(transport: transport)
  }

  public var group: WhatsappGroupNamespace {
    WhatsappGroupNamespace(transport: transport)
  }
}

public struct WhatsappDmNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func ack(_ contact: String, _ messageId: String, _ options: WhatsappDmAckOptions = .init()) async throws -> WhatsappDmAckReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    requestBody["messageId"] = try RaviJSON.fromEncodable(messageId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","dm"], command: "ack", body: requestBody, as: WhatsappDmAckReturn.self)
  }

  public func read(_ contact: String, _ options: WhatsappDmReadOptions = .init()) async throws -> WhatsappDmReadReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","dm"], command: "read", body: requestBody, as: WhatsappDmReadReturn.self)
  }

  public func send(_ contact: String, _ message: String, _ options: WhatsappDmSendOptions = .init()) async throws -> WhatsappDmSendReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["contact"] = try RaviJSON.fromEncodable(contact)
    requestBody["message"] = try RaviJSON.fromEncodable(message)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","dm"], command: "send", body: requestBody, as: WhatsappDmSendReturn.self)
  }
}

public struct WhatsappGroupNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ groupId: String, _ participants: String, _ options: WhatsappGroupAddOptions = .init()) async throws -> WhatsappGroupAddReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    requestBody["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "add", body: requestBody, as: WhatsappGroupAddReturn.self)
  }

  public func create(_ name: String, _ participants: String, _ options: WhatsappGroupCreateOptions = .init()) async throws -> WhatsappGroupCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    requestBody["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "create", body: requestBody, as: WhatsappGroupCreateReturn.self)
  }

  public func demote(_ groupId: String, _ participants: String, _ options: WhatsappGroupDemoteOptions = .init()) async throws -> WhatsappGroupDemoteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    requestBody["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "demote", body: requestBody, as: WhatsappGroupDemoteReturn.self)
  }

  public func description(_ groupId: String, _ text: String, _ options: WhatsappGroupDescriptionOptions = .init()) async throws -> WhatsappGroupDescriptionReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    requestBody["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "description", body: requestBody, as: WhatsappGroupDescriptionReturn.self)
  }

  public func info(_ groupId: String, _ options: WhatsappGroupInfoOptions = .init()) async throws -> WhatsappGroupInfoReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "info", body: requestBody, as: WhatsappGroupInfoReturn.self)
  }

  public func invite(_ groupId: String, _ options: WhatsappGroupInviteOptions = .init()) async throws -> WhatsappGroupInviteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "invite", body: requestBody, as: WhatsappGroupInviteReturn.self)
  }

  public func join(_ code: String, _ options: WhatsappGroupJoinOptions = .init()) async throws -> WhatsappGroupJoinReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["code"] = try RaviJSON.fromEncodable(code)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "join", body: requestBody, as: WhatsappGroupJoinReturn.self)
  }

  public func leave(_ groupId: String, _ options: WhatsappGroupLeaveOptions = .init()) async throws -> WhatsappGroupLeaveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "leave", body: requestBody, as: WhatsappGroupLeaveReturn.self)
  }

  public func list(_ options: WhatsappGroupListOptions = .init()) async throws -> WhatsappGroupListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "list", body: requestBody, as: WhatsappGroupListReturn.self)
  }

  public func promote(_ groupId: String, _ participants: String, _ options: WhatsappGroupPromoteOptions = .init()) async throws -> WhatsappGroupPromoteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    requestBody["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "promote", body: requestBody, as: WhatsappGroupPromoteReturn.self)
  }

  public func remove(_ groupId: String, _ participants: String, _ options: WhatsappGroupRemoveOptions = .init()) async throws -> WhatsappGroupRemoveReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    requestBody["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "remove", body: requestBody, as: WhatsappGroupRemoveReturn.self)
  }

  public func rename(_ groupId: String, _ name: String, _ options: WhatsappGroupRenameOptions = .init()) async throws -> WhatsappGroupRenameReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    requestBody["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "rename", body: requestBody, as: WhatsappGroupRenameReturn.self)
  }

  public func revokeInvite(_ groupId: String, _ options: WhatsappGroupRevokeInviteOptions = .init()) async throws -> WhatsappGroupRevokeInviteReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "revoke-invite", body: requestBody, as: WhatsappGroupRevokeInviteReturn.self)
  }

  public func send(_ groupId: String, _ message: String, _ options: WhatsappGroupSendOptions = .init()) async throws -> WhatsappGroupSendReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    requestBody["message"] = try RaviJSON.fromEncodable(message)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "send", body: requestBody, as: WhatsappGroupSendReturn.self)
  }

  public func settings(_ groupId: String, _ setting: String, _ options: WhatsappGroupSettingsOptions = .init()) async throws -> WhatsappGroupSettingsReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["groupId"] = try RaviJSON.fromEncodable(groupId)
    requestBody["setting"] = try RaviJSON.fromEncodable(setting)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "settings", body: requestBody, as: WhatsappGroupSettingsReturn.self)
  }
}

public struct WorkflowsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public var runs: WorkflowsRunsNamespace {
    WorkflowsRunsNamespace(transport: transport)
  }

  public var specs: WorkflowsSpecsNamespace {
    WorkflowsSpecsNamespace(transport: transport)
  }
}

public struct WorkflowsRunsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func archiveNode(_ runId: String, _ nodeKey: String) async throws -> WorkflowsRunsArchiveNodeReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["runId"] = try RaviJSON.fromEncodable(runId)
    requestBody["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "archive-node", body: requestBody, as: WorkflowsRunsArchiveNodeReturn.self)
  }

  public func cancel(_ runId: String, _ nodeKey: String) async throws -> WorkflowsRunsCancelReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["runId"] = try RaviJSON.fromEncodable(runId)
    requestBody["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "cancel", body: requestBody, as: WorkflowsRunsCancelReturn.self)
  }

  public func list(_ options: WorkflowsRunsListOptions = .init()) async throws -> WorkflowsRunsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "list", body: requestBody, as: WorkflowsRunsListReturn.self)
  }

  public func release(_ runId: String, _ nodeKey: String) async throws -> WorkflowsRunsReleaseReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["runId"] = try RaviJSON.fromEncodable(runId)
    requestBody["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "release", body: requestBody, as: WorkflowsRunsReleaseReturn.self)
  }

  public func show(_ runId: String) async throws -> WorkflowsRunsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["runId"] = try RaviJSON.fromEncodable(runId)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "show", body: requestBody, as: WorkflowsRunsShowReturn.self)
  }

  public func skip(_ runId: String, _ nodeKey: String) async throws -> WorkflowsRunsSkipReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["runId"] = try RaviJSON.fromEncodable(runId)
    requestBody["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "skip", body: requestBody, as: WorkflowsRunsSkipReturn.self)
  }

  public func start(_ specId: String, _ options: WorkflowsRunsStartOptions = .init()) async throws -> WorkflowsRunsStartReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["specId"] = try RaviJSON.fromEncodable(specId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "start", body: requestBody, as: WorkflowsRunsStartReturn.self)
  }

  public func taskAttach(_ runId: String, _ nodeKey: String, _ taskId: String) async throws -> WorkflowsRunsTaskAttachReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["runId"] = try RaviJSON.fromEncodable(runId)
    requestBody["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    requestBody["taskId"] = try RaviJSON.fromEncodable(taskId)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "task-attach", body: requestBody, as: WorkflowsRunsTaskAttachReturn.self)
  }

  public func taskCreate(_ runId: String, _ nodeKey: String, _ options: WorkflowsRunsTaskCreateOptions = .init()) async throws -> WorkflowsRunsTaskCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["runId"] = try RaviJSON.fromEncodable(runId)
    requestBody["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "task-create", body: requestBody, as: WorkflowsRunsTaskCreateReturn.self)
  }
}

public struct WorkflowsSpecsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func create(_ specId: String, _ options: WorkflowsSpecsCreateOptions = .init()) async throws -> WorkflowsSpecsCreateReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["specId"] = try RaviJSON.fromEncodable(specId)
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["workflows","specs"], command: "create", body: requestBody, as: WorkflowsSpecsCreateReturn.self)
  }

  public func list(_ options: WorkflowsSpecsListOptions = .init()) async throws -> WorkflowsSpecsListReturn {
    var requestBody: [String: RaviJSON] = [:]
    try options.encodeBody(into: &requestBody)
    return try await transport.call(groupSegments: ["workflows","specs"], command: "list", body: requestBody, as: WorkflowsSpecsListReturn.self)
  }

  public func show(_ specId: String) async throws -> WorkflowsSpecsShowReturn {
    var requestBody: [String: RaviJSON] = [:]
    requestBody["specId"] = try RaviJSON.fromEncodable(specId)
    return try await transport.call(groupSegments: ["workflows","specs"], command: "show", body: requestBody, as: WorkflowsSpecsShowReturn.self)
  }
}
