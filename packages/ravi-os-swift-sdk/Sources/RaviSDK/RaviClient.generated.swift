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

  public var artifacts: ArtifactsNamespace {
    ArtifactsNamespace(transport: transport)
  }

  public var audio: AudioNamespace {
    AudioNamespace(transport: transport)
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

  public var tags: TagsNamespace {
    TagsNamespace(transport: transport)
  }

  public var tasks: TasksNamespace {
    TasksNamespace(transport: transport)
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
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["adapters"], command: "list", body: body, as: AdaptersListReturn.self)
  }

  public func show(_ adapterId: String) async throws -> AdaptersShowReturn {
    var body: [String: RaviJSON] = [:]
    body["adapterId"] = try RaviJSON.fromEncodable(adapterId)
    return try await transport.call(groupSegments: ["adapters"], command: "show", body: body, as: AdaptersShowReturn.self)
  }
}

public struct AgentsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func create(_ id: String, _ cwd: String, _ options: AgentsCreateOptions = .init()) async throws -> AgentsCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["cwd"] = try RaviJSON.fromEncodable(cwd)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["agents"], command: "create", body: body, as: AgentsCreateReturn.self)
  }

  public func debounce(_ id: String, _ ms: String? = nil) async throws -> AgentsDebounceReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    if let ms {
      body["ms"] = try RaviJSON.fromEncodable(ms)
    }
    return try await transport.call(groupSegments: ["agents"], command: "debounce", body: body, as: AgentsDebounceReturn.self)
  }

  public func debug(_ id: String, _ nameOrKey: String? = nil, _ options: AgentsDebugOptions = .init()) async throws -> AgentsDebugReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    if let nameOrKey {
      body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["agents"], command: "debug", body: body, as: AgentsDebugReturn.self)
  }

  public func delete(_ id: String) async throws -> AgentsDeleteReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["agents"], command: "delete", body: body, as: AgentsDeleteReturn.self)
  }

  public func list(_ options: AgentsListOptions = .init()) async throws -> AgentsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["agents"], command: "list", body: body, as: AgentsListReturn.self)
  }

  public func reset(_ id: String, _ nameOrKey: String? = nil) async throws -> AgentsResetReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    if let nameOrKey {
      body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    }
    return try await transport.call(groupSegments: ["agents"], command: "reset", body: body, as: AgentsResetReturn.self)
  }

  public func session(_ id: String) async throws -> AgentsSessionReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["agents"], command: "session", body: body, as: AgentsSessionReturn.self)
  }

  public func set(_ id: String, _ key: String, _ value: String) async throws -> AgentsSetReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["key"] = try RaviJSON.fromEncodable(key)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["agents"], command: "set", body: body, as: AgentsSetReturn.self)
  }

  public func show(_ id: String) async throws -> AgentsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["agents"], command: "show", body: body, as: AgentsShowReturn.self)
  }

  public func specMode(_ id: String, _ enabled: String? = nil) async throws -> AgentsSpecModeReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    if let enabled {
      body["enabled"] = try RaviJSON.fromEncodable(enabled)
    }
    return try await transport.call(groupSegments: ["agents"], command: "spec-mode", body: body, as: AgentsSpecModeReturn.self)
  }

  public func syncInstructions(_ options: AgentsSyncInstructionsOptions = .init()) async throws -> AgentsSyncInstructionsReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["agents"], command: "sync-instructions", body: body, as: AgentsSyncInstructionsReturn.self)
  }
}

public struct ArtifactsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func archive(_ id: String) async throws -> ArtifactsArchiveReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["artifacts"], command: "archive", body: body, as: ArtifactsArchiveReturn.self)
  }

  public func attach(_ id: String, _ targetType: String, _ targetId: String, _ options: ArtifactsAttachOptions = .init()) async throws -> ArtifactsAttachReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["targetType"] = try RaviJSON.fromEncodable(targetType)
    body["targetId"] = try RaviJSON.fromEncodable(targetId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["artifacts"], command: "attach", body: body, as: ArtifactsAttachReturn.self)
  }

  public func blob(_ id: String) async throws -> ArtifactsBlobReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.callBinary(groupSegments: ["artifacts"], command: "blob", body: body)
  }

  public func create(_ kind: String, _ options: ArtifactsCreateOptions = .init()) async throws -> ArtifactsCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["kind"] = try RaviJSON.fromEncodable(kind)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["artifacts"], command: "create", body: body, as: ArtifactsCreateReturn.self)
  }

  public func event(_ id: String, _ eventType: String, _ options: ArtifactsEventOptions = .init()) async throws -> ArtifactsEventReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["eventType"] = try RaviJSON.fromEncodable(eventType)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["artifacts"], command: "event", body: body, as: ArtifactsEventReturn.self)
  }

  public func events(_ id: String) async throws -> ArtifactsEventsReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["artifacts"], command: "events", body: body, as: ArtifactsEventsReturn.self)
  }

  public func list(_ options: ArtifactsListOptions = .init()) async throws -> ArtifactsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["artifacts"], command: "list", body: body, as: ArtifactsListReturn.self)
  }

  public func show(_ id: String) async throws -> ArtifactsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["artifacts"], command: "show", body: body, as: ArtifactsShowReturn.self)
  }

  public func update(_ id: String, _ options: ArtifactsUpdateOptions = .init()) async throws -> ArtifactsUpdateReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["artifacts"], command: "update", body: body, as: ArtifactsUpdateReturn.self)
  }
}

public struct AudioNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func generate(_ text: String, _ options: AudioGenerateOptions = .init()) async throws -> AudioGenerateReturn {
    var body: [String: RaviJSON] = [:]
    body["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["audio"], command: "generate", body: body, as: AudioGenerateReturn.self)
  }
}

public struct CommandsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func list(_ options: CommandsListOptions = .init()) async throws -> CommandsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["commands"], command: "list", body: body, as: CommandsListReturn.self)
  }

  public func run(_ name: String, _ args: [String]? = nil, _ options: CommandsRunOptions = .init()) async throws -> CommandsRunReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    if let args {
      body["args"] = try RaviJSON.fromEncodable(args)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["commands"], command: "run", body: body, as: CommandsRunReturn.self)
  }

  public func show(_ name: String, _ options: CommandsShowOptions = .init()) async throws -> CommandsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["commands"], command: "show", body: body, as: CommandsShowReturn.self)
  }

  public func validate(_ options: CommandsValidateOptions = .init()) async throws -> CommandsValidateReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["commands"], command: "validate", body: body, as: CommandsValidateReturn.self)
  }
}

public struct ContactsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ identity: String, _ name: String? = nil, _ options: ContactsAddOptions = .init()) async throws -> ContactsAddReturn {
    var body: [String: RaviJSON] = [:]
    body["identity"] = try RaviJSON.fromEncodable(identity)
    if let name {
      body["name"] = try RaviJSON.fromEncodable(name)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["contacts"], command: "add", body: body, as: ContactsAddReturn.self)
  }

  public func allow(_ contact: String) async throws -> ContactsAllowReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "allow", body: body, as: ContactsAllowReturn.self)
  }

  public func approve(_ contact: String, _ mode: String? = nil, _ options: ContactsApproveOptions = .init()) async throws -> ContactsApproveReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    if let mode {
      body["mode"] = try RaviJSON.fromEncodable(mode)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["contacts"], command: "approve", body: body, as: ContactsApproveReturn.self)
  }

  public func block(_ contact: String) async throws -> ContactsBlockReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "block", body: body, as: ContactsBlockReturn.self)
  }

  public func check(_ contact: String) async throws -> ContactsCheckReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "check", body: body, as: ContactsCheckReturn.self)
  }

  public func duplicates() async throws -> ContactsDuplicatesReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["contacts"], command: "duplicates", body: body, as: ContactsDuplicatesReturn.self)
  }

  public func find(_ query: String, _ options: ContactsFindOptions = .init()) async throws -> ContactsFindReturn {
    var body: [String: RaviJSON] = [:]
    body["query"] = try RaviJSON.fromEncodable(query)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["contacts"], command: "find", body: body, as: ContactsFindReturn.self)
  }

  public func get(_ contact: String) async throws -> ContactsGetReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "get", body: body, as: ContactsGetReturn.self)
  }

  public func groupTag(_ contact: String, _ group: String, _ tag: String) async throws -> ContactsGroupTagReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    body["group"] = try RaviJSON.fromEncodable(group)
    body["tag"] = try RaviJSON.fromEncodable(tag)
    return try await transport.call(groupSegments: ["contacts"], command: "group-tag", body: body, as: ContactsGroupTagReturn.self)
  }

  public func groupUntag(_ contact: String, _ group: String) async throws -> ContactsGroupUntagReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    body["group"] = try RaviJSON.fromEncodable(group)
    return try await transport.call(groupSegments: ["contacts"], command: "group-untag", body: body, as: ContactsGroupUntagReturn.self)
  }

  public func identityAdd(_ contact: String, _ platform: String, _ value: String) async throws -> ContactsIdentityAddReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    body["platform"] = try RaviJSON.fromEncodable(platform)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["contacts"], command: "identity-add", body: body, as: ContactsIdentityAddReturn.self)
  }

  public func identityRemove(_ platform: String, _ value: String) async throws -> ContactsIdentityRemoveReturn {
    var body: [String: RaviJSON] = [:]
    body["platform"] = try RaviJSON.fromEncodable(platform)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["contacts"], command: "identity-remove", body: body, as: ContactsIdentityRemoveReturn.self)
  }

  public func info(_ contact: String) async throws -> ContactsInfoReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "info", body: body, as: ContactsInfoReturn.self)
  }

  public func link(_ contact: String, _ options: ContactsLinkOptions = .init()) async throws -> ContactsLinkReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["contacts"], command: "link", body: body, as: ContactsLinkReturn.self)
  }

  public func list(_ options: ContactsListOptions = .init()) async throws -> ContactsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["contacts"], command: "list", body: body, as: ContactsListReturn.self)
  }

  public func merge(_ source: String, _ target: String) async throws -> ContactsMergeReturn {
    var body: [String: RaviJSON] = [:]
    body["source"] = try RaviJSON.fromEncodable(source)
    body["target"] = try RaviJSON.fromEncodable(target)
    return try await transport.call(groupSegments: ["contacts"], command: "merge", body: body, as: ContactsMergeReturn.self)
  }

  public func pending(_ options: ContactsPendingOptions = .init()) async throws -> ContactsPendingReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["contacts"], command: "pending", body: body, as: ContactsPendingReturn.self)
  }

  public func remove(_ contact: String) async throws -> ContactsRemoveReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["contacts"], command: "remove", body: body, as: ContactsRemoveReturn.self)
  }

  public func set(_ contact: String, _ key: String, _ value: String) async throws -> ContactsSetReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    body["key"] = try RaviJSON.fromEncodable(key)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["contacts"], command: "set", body: body, as: ContactsSetReturn.self)
  }

  public func tag(_ contact: String, _ tag: String) async throws -> ContactsTagReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    body["tag"] = try RaviJSON.fromEncodable(tag)
    return try await transport.call(groupSegments: ["contacts"], command: "tag", body: body, as: ContactsTagReturn.self)
  }

  public func unlink(_ platformIdentity: String, _ options: ContactsUnlinkOptions = .init()) async throws -> ContactsUnlinkReturn {
    var body: [String: RaviJSON] = [:]
    body["platformIdentity"] = try RaviJSON.fromEncodable(platformIdentity)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["contacts"], command: "unlink", body: body, as: ContactsUnlinkReturn.self)
  }

  public func untag(_ contact: String, _ tag: String) async throws -> ContactsUntagReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    body["tag"] = try RaviJSON.fromEncodable(tag)
    return try await transport.call(groupSegments: ["contacts"], command: "untag", body: body, as: ContactsUntagReturn.self)
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
    var body: [String: RaviJSON] = [:]
    body["permission"] = try RaviJSON.fromEncodable(permission)
    body["objectType"] = try RaviJSON.fromEncodable(objectType)
    body["objectId"] = try RaviJSON.fromEncodable(objectId)
    return try await transport.call(groupSegments: ["context"], command: "authorize", body: body, as: ContextAuthorizeReturn.self)
  }

  public func capabilities() async throws -> ContextCapabilitiesReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["context"], command: "capabilities", body: body, as: ContextCapabilitiesReturn.self)
  }

  public func check(_ permission: String, _ objectType: String, _ objectId: String) async throws -> ContextCheckReturn {
    var body: [String: RaviJSON] = [:]
    body["permission"] = try RaviJSON.fromEncodable(permission)
    body["objectType"] = try RaviJSON.fromEncodable(objectType)
    body["objectId"] = try RaviJSON.fromEncodable(objectId)
    return try await transport.call(groupSegments: ["context"], command: "check", body: body, as: ContextCheckReturn.self)
  }

  public func cleanupAgentRuntime(_ options: ContextCleanupAgentRuntimeOptions = .init()) async throws -> ContextCleanupAgentRuntimeReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["context"], command: "cleanup-agent-runtime", body: body, as: ContextCleanupAgentRuntimeReturn.self)
  }

  public func codexBashHook() async throws -> ContextCodexBashHookReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["context"], command: "codex-bash-hook", body: body, as: ContextCodexBashHookReturn.self)
  }

  public func info(_ contextId: String) async throws -> ContextInfoReturn {
    var body: [String: RaviJSON] = [:]
    body["contextId"] = try RaviJSON.fromEncodable(contextId)
    return try await transport.call(groupSegments: ["context"], command: "info", body: body, as: ContextInfoReturn.self)
  }

  public func issue(_ cliName: String, _ options: ContextIssueOptions = .init()) async throws -> ContextIssueReturn {
    var body: [String: RaviJSON] = [:]
    body["cliName"] = try RaviJSON.fromEncodable(cliName)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["context"], command: "issue", body: body, as: ContextIssueReturn.self)
  }

  public func lineage(_ contextId: String) async throws -> ContextLineageReturn {
    var body: [String: RaviJSON] = [:]
    body["contextId"] = try RaviJSON.fromEncodable(contextId)
    return try await transport.call(groupSegments: ["context"], command: "lineage", body: body, as: ContextLineageReturn.self)
  }

  public func list(_ options: ContextListOptions = .init()) async throws -> ContextListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["context"], command: "list", body: body, as: ContextListReturn.self)
  }

  public func revoke(_ contextId: String, _ options: ContextRevokeOptions = .init()) async throws -> ContextRevokeReturn {
    var body: [String: RaviJSON] = [:]
    body["contextId"] = try RaviJSON.fromEncodable(contextId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["context"], command: "revoke", body: body, as: ContextRevokeReturn.self)
  }

  public func visibility() async throws -> ContextVisibilityReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["context"], command: "visibility", body: body, as: ContextVisibilityReturn.self)
  }

  public func whoami() async throws -> ContextWhoamiReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["context"], command: "whoami", body: body, as: ContextWhoamiReturn.self)
  }
}

public struct ContextCredentialsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ contextKey: String, _ options: ContextCredentialsAddOptions = .init()) async throws -> ContextCredentialsAddReturn {
    var body: [String: RaviJSON] = [:]
    body["contextKey"] = try RaviJSON.fromEncodable(contextKey)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["context","credentials"], command: "add", body: body, as: ContextCredentialsAddReturn.self)
  }

  public func list() async throws -> ContextCredentialsListReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["context","credentials"], command: "list", body: body, as: ContextCredentialsListReturn.self)
  }

  public func remove(_ contextKey: String) async throws -> ContextCredentialsRemoveReturn {
    var body: [String: RaviJSON] = [:]
    body["contextKey"] = try RaviJSON.fromEncodable(contextKey)
    return try await transport.call(groupSegments: ["context","credentials"], command: "remove", body: body, as: ContextCredentialsRemoveReturn.self)
  }

  public func setDefault(_ contextKey: String) async throws -> ContextCredentialsSetDefaultReturn {
    var body: [String: RaviJSON] = [:]
    body["contextKey"] = try RaviJSON.fromEncodable(contextKey)
    return try await transport.call(groupSegments: ["context","credentials"], command: "set-default", body: body, as: ContextCredentialsSetDefaultReturn.self)
  }
}

public struct CostsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func agent(_ agentId: String, _ options: CostsAgentOptions = .init()) async throws -> CostsAgentReturn {
    var body: [String: RaviJSON] = [:]
    body["agentId"] = try RaviJSON.fromEncodable(agentId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["costs"], command: "agent", body: body, as: CostsAgentReturn.self)
  }

  public func agents(_ options: CostsAgentsOptions = .init()) async throws -> CostsAgentsReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["costs"], command: "agents", body: body, as: CostsAgentsReturn.self)
  }

  public func session(_ nameOrKey: String) async throws -> CostsSessionReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["costs"], command: "session", body: body, as: CostsSessionReturn.self)
  }

  public func summary(_ options: CostsSummaryOptions = .init()) async throws -> CostsSummaryReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["costs"], command: "summary", body: body, as: CostsSummaryReturn.self)
  }

  public func topSessions(_ options: CostsTopSessionsOptions = .init()) async throws -> CostsTopSessionsReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["costs"], command: "top-sessions", body: body, as: CostsTopSessionsReturn.self)
  }
}

public struct CronNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ name: String, _ options: CronAddOptions = .init()) async throws -> CronAddReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["cron"], command: "add", body: body, as: CronAddReturn.self)
  }

  public func disable(_ id: String) async throws -> CronDisableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "disable", body: body, as: CronDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> CronEnableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "enable", body: body, as: CronEnableReturn.self)
  }

  public func list(_ options: CronListOptions = .init()) async throws -> CronListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["cron"], command: "list", body: body, as: CronListReturn.self)
  }

  public func rm(_ id: String) async throws -> CronRmReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "rm", body: body, as: CronRmReturn.self)
  }

  public func run(_ id: String) async throws -> CronRunReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "run", body: body, as: CronRunReturn.self)
  }

  public func set(_ id: String, _ key: String, _ value: String) async throws -> CronSetReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["key"] = try RaviJSON.fromEncodable(key)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["cron"], command: "set", body: body, as: CronSetReturn.self)
  }

  public func show(_ id: String) async throws -> CronShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["cron"], command: "show", body: body, as: CronShowReturn.self)
  }
}

public struct DaemonNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func env() async throws -> DaemonEnvReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "env", body: body, as: DaemonEnvReturn.self)
  }

  public func initAdminKey(_ options: DaemonInitAdminKeyOptions = .init()) async throws -> DaemonInitAdminKeyReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["daemon"], command: "init-admin-key", body: body, as: DaemonInitAdminKeyReturn.self)
  }

  public func install() async throws -> DaemonInstallReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "install", body: body, as: DaemonInstallReturn.self)
  }

  public func logs(_ options: DaemonLogsOptions = .init()) async throws -> DaemonLogsReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["daemon"], command: "logs", body: body, as: DaemonLogsReturn.self)
  }

  public func restart(_ options: DaemonRestartOptions = .init()) async throws -> DaemonRestartReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["daemon"], command: "restart", body: body, as: DaemonRestartReturn.self)
  }

  public func start() async throws -> DaemonStartReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "start", body: body, as: DaemonStartReturn.self)
  }

  public func status() async throws -> DaemonStatusReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "status", body: body, as: DaemonStatusReturn.self)
  }

  public func stop() async throws -> DaemonStopReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "stop", body: body, as: DaemonStopReturn.self)
  }

  public func uninstall() async throws -> DaemonUninstallReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["daemon"], command: "uninstall", body: body, as: DaemonUninstallReturn.self)
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
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["devin","auth"], command: "check", body: body, as: DevinAuthCheckReturn.self)
  }
}

public struct DevinSessionsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func archive(_ session: String) async throws -> DevinSessionsArchiveReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "archive", body: body, as: DevinSessionsArchiveReturn.self)
  }

  public func attachments(_ session: String, _ options: DevinSessionsAttachmentsOptions = .init()) async throws -> DevinSessionsAttachmentsReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "attachments", body: body, as: DevinSessionsAttachmentsReturn.self)
  }

  public func create(_ options: DevinSessionsCreateOptions = .init()) async throws -> DevinSessionsCreateReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "create", body: body, as: DevinSessionsCreateReturn.self)
  }

  public func insights(_ session: String, _ options: DevinSessionsInsightsOptions = .init()) async throws -> DevinSessionsInsightsReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "insights", body: body, as: DevinSessionsInsightsReturn.self)
  }

  public func list(_ options: DevinSessionsListOptions = .init()) async throws -> DevinSessionsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "list", body: body, as: DevinSessionsListReturn.self)
  }

  public func messages(_ session: String, _ options: DevinSessionsMessagesOptions = .init()) async throws -> DevinSessionsMessagesReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "messages", body: body, as: DevinSessionsMessagesReturn.self)
  }

  public func send(_ session: String, _ message: String, _ options: DevinSessionsSendOptions = .init()) async throws -> DevinSessionsSendReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    body["message"] = try RaviJSON.fromEncodable(message)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "send", body: body, as: DevinSessionsSendReturn.self)
  }

  public func show(_ session: String, _ options: DevinSessionsShowOptions = .init()) async throws -> DevinSessionsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "show", body: body, as: DevinSessionsShowReturn.self)
  }

  public func sync(_ session: String, _ options: DevinSessionsSyncOptions = .init()) async throws -> DevinSessionsSyncReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "sync", body: body, as: DevinSessionsSyncReturn.self)
  }

  public func terminate(_ session: String, _ options: DevinSessionsTerminateOptions = .init()) async throws -> DevinSessionsTerminateReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["devin","sessions"], command: "terminate", body: body, as: DevinSessionsTerminateReturn.self)
  }
}

public struct EvalNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func run(_ specPath: String, _ options: EvalRunOptions = .init()) async throws -> EvalRunReturn {
    var body: [String: RaviJSON] = [:]
    body["specPath"] = try RaviJSON.fromEncodable(specPath)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["eval"], command: "run", body: body, as: EvalRunReturn.self)
  }
}

public struct HeartbeatNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func disable(_ id: String) async throws -> HeartbeatDisableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["heartbeat"], command: "disable", body: body, as: HeartbeatDisableReturn.self)
  }

  public func enable(_ id: String, _ interval: String? = nil) async throws -> HeartbeatEnableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    if let interval {
      body["interval"] = try RaviJSON.fromEncodable(interval)
    }
    return try await transport.call(groupSegments: ["heartbeat"], command: "enable", body: body, as: HeartbeatEnableReturn.self)
  }

  public func set(_ id: String, _ key: String, _ value: String) async throws -> HeartbeatSetReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["key"] = try RaviJSON.fromEncodable(key)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["heartbeat"], command: "set", body: body, as: HeartbeatSetReturn.self)
  }

  public func show(_ id: String) async throws -> HeartbeatShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["heartbeat"], command: "show", body: body, as: HeartbeatShowReturn.self)
  }

  public func status() async throws -> HeartbeatStatusReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["heartbeat"], command: "status", body: body, as: HeartbeatStatusReturn.self)
  }

  public func trigger(_ id: String) async throws -> HeartbeatTriggerReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["heartbeat"], command: "trigger", body: body, as: HeartbeatTriggerReturn.self)
  }
}

public struct HooksNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func create(_ name: String, _ options: HooksCreateOptions = .init()) async throws -> HooksCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["hooks"], command: "create", body: body, as: HooksCreateReturn.self)
  }

  public func disable(_ id: String) async throws -> HooksDisableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "disable", body: body, as: HooksDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> HooksEnableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "enable", body: body, as: HooksEnableReturn.self)
  }

  public func list(_ options: HooksListOptions = .init()) async throws -> HooksListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["hooks"], command: "list", body: body, as: HooksListReturn.self)
  }

  public func rm(_ id: String) async throws -> HooksRmReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "rm", body: body, as: HooksRmReturn.self)
  }

  public func show(_ id: String) async throws -> HooksShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "show", body: body, as: HooksShowReturn.self)
  }

  public func test(_ id: String) async throws -> HooksTestReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["hooks"], command: "test", body: body, as: HooksTestReturn.self)
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
    var body: [String: RaviJSON] = [:]
    body["prompt"] = try RaviJSON.fromEncodable(prompt)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["image"], command: "generate", body: body, as: ImageGenerateReturn.self)
  }
}

public struct ImageAtlasNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func split(_ input: String, _ options: ImageAtlasSplitOptions = .init()) async throws -> ImageAtlasSplitReturn {
    var body: [String: RaviJSON] = [:]
    body["input"] = try RaviJSON.fromEncodable(input)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["image","atlas"], command: "split", body: body, as: ImageAtlasSplitReturn.self)
  }
}

public struct InsightsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func create(_ summary: String, _ options: InsightsCreateOptions = .init()) async throws -> InsightsCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["summary"] = try RaviJSON.fromEncodable(summary)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["insights"], command: "create", body: body, as: InsightsCreateReturn.self)
  }

  public func list(_ options: InsightsListOptions = .init()) async throws -> InsightsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["insights"], command: "list", body: body, as: InsightsListReturn.self)
  }

  public func search(_ text: String, _ options: InsightsSearchOptions = .init()) async throws -> InsightsSearchReturn {
    var body: [String: RaviJSON] = [:]
    body["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["insights"], command: "search", body: body, as: InsightsSearchReturn.self)
  }

  public func show(_ id: String) async throws -> InsightsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["insights"], command: "show", body: body, as: InsightsShowReturn.self)
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
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["instances"], command: "create", body: body, as: InstancesCreateReturn.self)
  }

  public func delete(_ name: String) async throws -> InstancesDeleteReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "delete", body: body, as: InstancesDeleteReturn.self)
  }

  public func deleted() async throws -> InstancesDeletedReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["instances"], command: "deleted", body: body, as: InstancesDeletedReturn.self)
  }

  public func disable(_ target: String) async throws -> InstancesDisableReturn {
    var body: [String: RaviJSON] = [:]
    body["target"] = try RaviJSON.fromEncodable(target)
    return try await transport.call(groupSegments: ["instances"], command: "disable", body: body, as: InstancesDisableReturn.self)
  }

  public func disconnect(_ name: String) async throws -> InstancesDisconnectReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "disconnect", body: body, as: InstancesDisconnectReturn.self)
  }

  public func enable(_ target: String) async throws -> InstancesEnableReturn {
    var body: [String: RaviJSON] = [:]
    body["target"] = try RaviJSON.fromEncodable(target)
    return try await transport.call(groupSegments: ["instances"], command: "enable", body: body, as: InstancesEnableReturn.self)
  }

  public func get(_ name: String, _ key: String) async throws -> InstancesGetReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["key"] = try RaviJSON.fromEncodable(key)
    return try await transport.call(groupSegments: ["instances"], command: "get", body: body, as: InstancesGetReturn.self)
  }

  public func list(_ options: InstancesListOptions = .init()) async throws -> InstancesListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["instances"], command: "list", body: body, as: InstancesListReturn.self)
  }

  public func restore(_ name: String) async throws -> InstancesRestoreReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "restore", body: body, as: InstancesRestoreReturn.self)
  }

  public func set(_ name: String, _ key: String, _ value: String) async throws -> InstancesSetReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["key"] = try RaviJSON.fromEncodable(key)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["instances"], command: "set", body: body, as: InstancesSetReturn.self)
  }

  public func show(_ name: String) async throws -> InstancesShowReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "show", body: body, as: InstancesShowReturn.self)
  }

  public func status(_ name: String) async throws -> InstancesStatusReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances"], command: "status", body: body, as: InstancesStatusReturn.self)
  }

  public func target(_ name: String, _ options: InstancesTargetOptions = .init()) async throws -> InstancesTargetReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["instances"], command: "target", body: body, as: InstancesTargetReturn.self)
  }
}

public struct InstancesPendingNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func approve(_ name: String, _ contact: String, _ options: InstancesPendingApproveOptions = .init()) async throws -> InstancesPendingApproveReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["instances","pending"], command: "approve", body: body, as: InstancesPendingApproveReturn.self)
  }

  public func list(_ name: String) async throws -> InstancesPendingListReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["instances","pending"], command: "list", body: body, as: InstancesPendingListReturn.self)
  }

  public func reject(_ name: String, _ contact: String) async throws -> InstancesPendingRejectReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["contact"] = try RaviJSON.fromEncodable(contact)
    return try await transport.call(groupSegments: ["instances","pending"], command: "reject", body: body, as: InstancesPendingRejectReturn.self)
  }
}

public struct InstancesRoutesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ name: String, _ pattern: String, _ agent: String, _ options: InstancesRoutesAddOptions = .init()) async throws -> InstancesRoutesAddReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["pattern"] = try RaviJSON.fromEncodable(pattern)
    body["agent"] = try RaviJSON.fromEncodable(agent)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["instances","routes"], command: "add", body: body, as: InstancesRoutesAddReturn.self)
  }

  public func deleted(_ name: String? = nil) async throws -> InstancesRoutesDeletedReturn {
    var body: [String: RaviJSON] = [:]
    if let name {
      body["name"] = try RaviJSON.fromEncodable(name)
    }
    return try await transport.call(groupSegments: ["instances","routes"], command: "deleted", body: body, as: InstancesRoutesDeletedReturn.self)
  }

  public func list(_ name: String, _ options: InstancesRoutesListOptions = .init()) async throws -> InstancesRoutesListReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["instances","routes"], command: "list", body: body, as: InstancesRoutesListReturn.self)
  }

  public func remove(_ name: String, _ pattern: String, _ options: InstancesRoutesRemoveOptions = .init()) async throws -> InstancesRoutesRemoveReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["pattern"] = try RaviJSON.fromEncodable(pattern)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["instances","routes"], command: "remove", body: body, as: InstancesRoutesRemoveReturn.self)
  }

  public func restore(_ name: String, _ pattern: String, _ options: InstancesRoutesRestoreOptions = .init()) async throws -> InstancesRoutesRestoreReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["pattern"] = try RaviJSON.fromEncodable(pattern)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["instances","routes"], command: "restore", body: body, as: InstancesRoutesRestoreReturn.self)
  }

  public func set(_ name: String, _ pattern: String, _ key: String, _ value: String, _ options: InstancesRoutesSetOptions = .init()) async throws -> InstancesRoutesSetReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["pattern"] = try RaviJSON.fromEncodable(pattern)
    body["key"] = try RaviJSON.fromEncodable(key)
    body["value"] = try RaviJSON.fromEncodable(value)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["instances","routes"], command: "set", body: body, as: InstancesRoutesSetReturn.self)
  }

  public func show(_ name: String, _ pattern: String) async throws -> InstancesRoutesShowReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["pattern"] = try RaviJSON.fromEncodable(pattern)
    return try await transport.call(groupSegments: ["instances","routes"], command: "show", body: body, as: InstancesRoutesShowReturn.self)
  }
}

public struct MediaNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func send(_ filePath: String, _ options: MediaSendOptions = .init()) async throws -> MediaSendReturn {
    var body: [String: RaviJSON] = [:]
    body["filePath"] = try RaviJSON.fromEncodable(filePath)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["media"], command: "send", body: body, as: MediaSendReturn.self)
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
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["observers"], command: "list", body: body, as: ObserversListReturn.self)
  }

  public func refresh(_ session: String) async throws -> ObserversRefreshReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    return try await transport.call(groupSegments: ["observers"], command: "refresh", body: body, as: ObserversRefreshReturn.self)
  }

  public func show(_ bindingId: String) async throws -> ObserversShowReturn {
    var body: [String: RaviJSON] = [:]
    body["bindingId"] = try RaviJSON.fromEncodable(bindingId)
    return try await transport.call(groupSegments: ["observers"], command: "show", body: body, as: ObserversShowReturn.self)
  }
}

public struct ObserversProfilesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func init_(_ profileId: String, _ options: ObserversProfilesInitOptions = .init()) async throws -> ObserversProfilesInitReturn {
    var body: [String: RaviJSON] = [:]
    body["profileId"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["observers","profiles"], command: "init", body: body, as: ObserversProfilesInitReturn.self)
  }

  public func list() async throws -> ObserversProfilesListReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["observers","profiles"], command: "list", body: body, as: ObserversProfilesListReturn.self)
  }

  public func preview(_ profileId: String, _ options: ObserversProfilesPreviewOptions = .init()) async throws -> ObserversProfilesPreviewReturn {
    var body: [String: RaviJSON] = [:]
    body["profileId"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["observers","profiles"], command: "preview", body: body, as: ObserversProfilesPreviewReturn.self)
  }

  public func show(_ profileId: String) async throws -> ObserversProfilesShowReturn {
    var body: [String: RaviJSON] = [:]
    body["profileId"] = try RaviJSON.fromEncodable(profileId)
    return try await transport.call(groupSegments: ["observers","profiles"], command: "show", body: body, as: ObserversProfilesShowReturn.self)
  }

  public func validate(_ profileId: String? = nil) async throws -> ObserversProfilesValidateReturn {
    var body: [String: RaviJSON] = [:]
    if let profileId {
      body["profileId"] = try RaviJSON.fromEncodable(profileId)
    }
    return try await transport.call(groupSegments: ["observers","profiles"], command: "validate", body: body, as: ObserversProfilesValidateReturn.self)
  }
}

public struct ObserversRulesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func disable(_ id: String) async throws -> ObserversRulesDisableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["observers","rules"], command: "disable", body: body, as: ObserversRulesDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> ObserversRulesEnableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["observers","rules"], command: "enable", body: body, as: ObserversRulesEnableReturn.self)
  }

  public func explain(_ session: String) async throws -> ObserversRulesExplainReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    return try await transport.call(groupSegments: ["observers","rules"], command: "explain", body: body, as: ObserversRulesExplainReturn.self)
  }

  public func list() async throws -> ObserversRulesListReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["observers","rules"], command: "list", body: body, as: ObserversRulesListReturn.self)
  }

  public func rm(_ id: String) async throws -> ObserversRulesRmReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["observers","rules"], command: "rm", body: body, as: ObserversRulesRmReturn.self)
  }

  public func set(_ id: String, _ observerAgentId: String, _ options: ObserversRulesSetOptions = .init()) async throws -> ObserversRulesSetReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["observerAgentId"] = try RaviJSON.fromEncodable(observerAgentId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["observers","rules"], command: "set", body: body, as: ObserversRulesSetReturn.self)
  }

  public func show(_ id: String) async throws -> ObserversRulesShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["observers","rules"], command: "show", body: body, as: ObserversRulesShowReturn.self)
  }

  public func validate() async throws -> ObserversRulesValidateReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["observers","rules"], command: "validate", body: body, as: ObserversRulesValidateReturn.self)
  }
}

public struct PermissionsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func check(_ subject: String, _ permission: String, _ object: String) async throws -> PermissionsCheckReturn {
    var body: [String: RaviJSON] = [:]
    body["subject"] = try RaviJSON.fromEncodable(subject)
    body["permission"] = try RaviJSON.fromEncodable(permission)
    body["object"] = try RaviJSON.fromEncodable(object)
    return try await transport.call(groupSegments: ["permissions"], command: "check", body: body, as: PermissionsCheckReturn.self)
  }

  public func clear(_ options: PermissionsClearOptions = .init()) async throws -> PermissionsClearReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["permissions"], command: "clear", body: body, as: PermissionsClearReturn.self)
  }

  public func grant(_ subject: String, _ relation: String, _ object: String) async throws -> PermissionsGrantReturn {
    var body: [String: RaviJSON] = [:]
    body["subject"] = try RaviJSON.fromEncodable(subject)
    body["relation"] = try RaviJSON.fromEncodable(relation)
    body["object"] = try RaviJSON.fromEncodable(object)
    return try await transport.call(groupSegments: ["permissions"], command: "grant", body: body, as: PermissionsGrantReturn.self)
  }

  public func init_(_ subject: String, _ template: String) async throws -> PermissionsInitReturn {
    var body: [String: RaviJSON] = [:]
    body["subject"] = try RaviJSON.fromEncodable(subject)
    body["template"] = try RaviJSON.fromEncodable(template)
    return try await transport.call(groupSegments: ["permissions"], command: "init", body: body, as: PermissionsInitReturn.self)
  }

  public func list(_ options: PermissionsListOptions = .init()) async throws -> PermissionsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["permissions"], command: "list", body: body, as: PermissionsListReturn.self)
  }

  public func revoke(_ subject: String, _ relation: String, _ object: String) async throws -> PermissionsRevokeReturn {
    var body: [String: RaviJSON] = [:]
    body["subject"] = try RaviJSON.fromEncodable(subject)
    body["relation"] = try RaviJSON.fromEncodable(relation)
    body["object"] = try RaviJSON.fromEncodable(object)
    return try await transport.call(groupSegments: ["permissions"], command: "revoke", body: body, as: PermissionsRevokeReturn.self)
  }

  public func sync() async throws -> PermissionsSyncReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["permissions"], command: "sync", body: body, as: PermissionsSyncReturn.self)
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
    var body: [String: RaviJSON] = [:]
    body["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects"], command: "create", body: body, as: ProjectsCreateReturn.self)
  }

  public func init_(_ title: String, _ options: ProjectsInitOptions = .init()) async throws -> ProjectsInitReturn {
    var body: [String: RaviJSON] = [:]
    body["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects"], command: "init", body: body, as: ProjectsInitReturn.self)
  }

  public func link(_ assetType: String, _ project: String, _ target: String, _ options: ProjectsLinkOptions = .init()) async throws -> ProjectsLinkReturn {
    var body: [String: RaviJSON] = [:]
    body["assetType"] = try RaviJSON.fromEncodable(assetType)
    body["project"] = try RaviJSON.fromEncodable(project)
    body["target"] = try RaviJSON.fromEncodable(target)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects"], command: "link", body: body, as: ProjectsLinkReturn.self)
  }

  public func list(_ options: ProjectsListOptions = .init()) async throws -> ProjectsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects"], command: "list", body: body, as: ProjectsListReturn.self)
  }

  public func next(_ options: ProjectsNextOptions = .init()) async throws -> ProjectsNextReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects"], command: "next", body: body, as: ProjectsNextReturn.self)
  }

  public func show(_ project: String) async throws -> ProjectsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    return try await transport.call(groupSegments: ["projects"], command: "show", body: body, as: ProjectsShowReturn.self)
  }

  public func status(_ project: String) async throws -> ProjectsStatusReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    return try await transport.call(groupSegments: ["projects"], command: "status", body: body, as: ProjectsStatusReturn.self)
  }

  public func update(_ project: String, _ options: ProjectsUpdateOptions = .init()) async throws -> ProjectsUpdateReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects"], command: "update", body: body, as: ProjectsUpdateReturn.self)
  }
}

public struct ProjectsFixturesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func seed(_ options: ProjectsFixturesSeedOptions = .init()) async throws -> ProjectsFixturesSeedReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects","fixtures"], command: "seed", body: body, as: ProjectsFixturesSeedReturn.self)
  }
}

public struct ProjectsResourcesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ project: String, _ target: String, _ options: ProjectsResourcesAddOptions = .init()) async throws -> ProjectsResourcesAddReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    body["target"] = try RaviJSON.fromEncodable(target)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects","resources"], command: "add", body: body, as: ProjectsResourcesAddReturn.self)
  }

  public func import_(_ project: String, _ options: ProjectsResourcesImportOptions = .init()) async throws -> ProjectsResourcesImportReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects","resources"], command: "import", body: body, as: ProjectsResourcesImportReturn.self)
  }

  public func list(_ project: String, _ options: ProjectsResourcesListOptions = .init()) async throws -> ProjectsResourcesListReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects","resources"], command: "list", body: body, as: ProjectsResourcesListReturn.self)
  }

  public func show(_ project: String, _ resource: String) async throws -> ProjectsResourcesShowReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    body["resource"] = try RaviJSON.fromEncodable(resource)
    return try await transport.call(groupSegments: ["projects","resources"], command: "show", body: body, as: ProjectsResourcesShowReturn.self)
  }
}

public struct ProjectsTasksNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func attach(_ project: String, _ nodeKey: String, _ taskId: String, _ options: ProjectsTasksAttachOptions = .init()) async throws -> ProjectsTasksAttachReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    body["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects","tasks"], command: "attach", body: body, as: ProjectsTasksAttachReturn.self)
  }

  public func create(_ project: String, _ nodeKey: String, _ title: String, _ options: ProjectsTasksCreateOptions = .init()) async throws -> ProjectsTasksCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    body["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    body["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects","tasks"], command: "create", body: body, as: ProjectsTasksCreateReturn.self)
  }

  public func dispatch(_ project: String, _ taskId: String, _ options: ProjectsTasksDispatchOptions = .init()) async throws -> ProjectsTasksDispatchReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects","tasks"], command: "dispatch", body: body, as: ProjectsTasksDispatchReturn.self)
  }
}

public struct ProjectsWorkflowsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func attach(_ project: String, _ runId: String, _ options: ProjectsWorkflowsAttachOptions = .init()) async throws -> ProjectsWorkflowsAttachReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    body["runId"] = try RaviJSON.fromEncodable(runId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects","workflows"], command: "attach", body: body, as: ProjectsWorkflowsAttachReturn.self)
  }

  public func start(_ project: String, _ specId: String, _ options: ProjectsWorkflowsStartOptions = .init()) async throws -> ProjectsWorkflowsStartReturn {
    var body: [String: RaviJSON] = [:]
    body["project"] = try RaviJSON.fromEncodable(project)
    body["specId"] = try RaviJSON.fromEncodable(specId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["projects","workflows"], command: "start", body: body, as: ProjectsWorkflowsStartReturn.self)
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
    var body: [String: RaviJSON] = [:]
    body["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls"], command: "cancel", body: body, as: ProxCallsCancelReturn.self)
  }

  public func events(_ callRequestId: String) async throws -> ProxCallsEventsReturn {
    var body: [String: RaviJSON] = [:]
    body["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    return try await transport.call(groupSegments: ["prox","calls"], command: "events", body: body, as: ProxCallsEventsReturn.self)
  }

  public func request(_ options: ProxCallsRequestOptions = .init()) async throws -> ProxCallsRequestReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls"], command: "request", body: body, as: ProxCallsRequestReturn.self)
  }

  public func rules(_ options: ProxCallsRulesOptions = .init()) async throws -> ProxCallsRulesReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls"], command: "rules", body: body, as: ProxCallsRulesReturn.self)
  }

  public func show(_ callRequestId: String) async throws -> ProxCallsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    return try await transport.call(groupSegments: ["prox","calls"], command: "show", body: body, as: ProxCallsShowReturn.self)
  }

  public func transcript(_ callRequestId: String, _ options: ProxCallsTranscriptOptions = .init()) async throws -> ProxCallsTranscriptReturn {
    var body: [String: RaviJSON] = [:]
    body["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls"], command: "transcript", body: body, as: ProxCallsTranscriptReturn.self)
  }
}

public struct ProxCallsProfilesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func configure(_ profileId: String, _ options: ProxCallsProfilesConfigureOptions = .init()) async throws -> ProxCallsProfilesConfigureReturn {
    var body: [String: RaviJSON] = [:]
    body["profile_id"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","profiles"], command: "configure", body: body, as: ProxCallsProfilesConfigureReturn.self)
  }

  public func list(_ options: ProxCallsProfilesListOptions = .init()) async throws -> ProxCallsProfilesListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","profiles"], command: "list", body: body, as: ProxCallsProfilesListReturn.self)
  }

  public func show(_ profileId: String) async throws -> ProxCallsProfilesShowReturn {
    var body: [String: RaviJSON] = [:]
    body["profile_id"] = try RaviJSON.fromEncodable(profileId)
    return try await transport.call(groupSegments: ["prox","calls","profiles"], command: "show", body: body, as: ProxCallsProfilesShowReturn.self)
  }
}

public struct ProxCallsToolsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func bind(_ profileId: String, _ toolId: String, _ options: ProxCallsToolsBindOptions = .init()) async throws -> ProxCallsToolsBindReturn {
    var body: [String: RaviJSON] = [:]
    body["profile_id"] = try RaviJSON.fromEncodable(profileId)
    body["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "bind", body: body, as: ProxCallsToolsBindReturn.self)
  }

  public func configure(_ toolId: String, _ options: ProxCallsToolsConfigureOptions = .init()) async throws -> ProxCallsToolsConfigureReturn {
    var body: [String: RaviJSON] = [:]
    body["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "configure", body: body, as: ProxCallsToolsConfigureReturn.self)
  }

  public func create(_ toolId: String, _ options: ProxCallsToolsCreateOptions = .init()) async throws -> ProxCallsToolsCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "create", body: body, as: ProxCallsToolsCreateReturn.self)
  }

  public func list(_ options: ProxCallsToolsListOptions = .init()) async throws -> ProxCallsToolsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "list", body: body, as: ProxCallsToolsListReturn.self)
  }

  public func run(_ toolId: String, _ options: ProxCallsToolsRunOptions = .init()) async throws -> ProxCallsToolsRunReturn {
    var body: [String: RaviJSON] = [:]
    body["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "run", body: body, as: ProxCallsToolsRunReturn.self)
  }

  public func runs(_ callRequestId: String) async throws -> ProxCallsToolsRunsReturn {
    var body: [String: RaviJSON] = [:]
    body["call_request_id"] = try RaviJSON.fromEncodable(callRequestId)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "runs", body: body, as: ProxCallsToolsRunsReturn.self)
  }

  public func show(_ toolId: String) async throws -> ProxCallsToolsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["tool_id"] = try RaviJSON.fromEncodable(toolId)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "show", body: body, as: ProxCallsToolsShowReturn.self)
  }

  public func unbind(_ profileId: String, _ toolId: String) async throws -> ProxCallsToolsUnbindReturn {
    var body: [String: RaviJSON] = [:]
    body["profile_id"] = try RaviJSON.fromEncodable(profileId)
    body["tool_id"] = try RaviJSON.fromEncodable(toolId)
    return try await transport.call(groupSegments: ["prox","calls","tools"], command: "unbind", body: body, as: ProxCallsToolsUnbindReturn.self)
  }
}

public struct ProxCallsVoiceAgentsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func bindTool(_ voiceAgentId: String, _ toolId: String, _ options: ProxCallsVoiceAgentsBindToolOptions = .init()) async throws -> ProxCallsVoiceAgentsBindToolReturn {
    var body: [String: RaviJSON] = [:]
    body["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    body["tool_id"] = try RaviJSON.fromEncodable(toolId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "bind-tool", body: body, as: ProxCallsVoiceAgentsBindToolReturn.self)
  }

  public func configure(_ voiceAgentId: String, _ options: ProxCallsVoiceAgentsConfigureOptions = .init()) async throws -> ProxCallsVoiceAgentsConfigureReturn {
    var body: [String: RaviJSON] = [:]
    body["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "configure", body: body, as: ProxCallsVoiceAgentsConfigureReturn.self)
  }

  public func create(_ voiceAgentId: String, _ options: ProxCallsVoiceAgentsCreateOptions = .init()) async throws -> ProxCallsVoiceAgentsCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "create", body: body, as: ProxCallsVoiceAgentsCreateReturn.self)
  }

  public func list(_ options: ProxCallsVoiceAgentsListOptions = .init()) async throws -> ProxCallsVoiceAgentsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "list", body: body, as: ProxCallsVoiceAgentsListReturn.self)
  }

  public func show(_ voiceAgentId: String) async throws -> ProxCallsVoiceAgentsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "show", body: body, as: ProxCallsVoiceAgentsShowReturn.self)
  }

  public func sync(_ voiceAgentId: String, _ options: ProxCallsVoiceAgentsSyncOptions = .init()) async throws -> ProxCallsVoiceAgentsSyncReturn {
    var body: [String: RaviJSON] = [:]
    body["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "sync", body: body, as: ProxCallsVoiceAgentsSyncReturn.self)
  }

  public func unbindTool(_ voiceAgentId: String, _ toolId: String) async throws -> ProxCallsVoiceAgentsUnbindToolReturn {
    var body: [String: RaviJSON] = [:]
    body["voice_agent_id"] = try RaviJSON.fromEncodable(voiceAgentId)
    body["tool_id"] = try RaviJSON.fromEncodable(toolId)
    return try await transport.call(groupSegments: ["prox","calls","voice-agents"], command: "unbind-tool", body: body, as: ProxCallsVoiceAgentsUnbindToolReturn.self)
  }
}

public struct ReactNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func send(_ messageId: String, _ emoji: String) async throws -> ReactSendReturn {
    var body: [String: RaviJSON] = [:]
    body["messageId"] = try RaviJSON.fromEncodable(messageId)
    body["emoji"] = try RaviJSON.fromEncodable(emoji)
    return try await transport.call(groupSegments: ["react"], command: "send", body: body, as: ReactSendReturn.self)
  }
}

public struct RoutesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func explain(_ name: String, _ pattern: String, _ options: RoutesExplainOptions = .init()) async throws -> RoutesExplainReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["pattern"] = try RaviJSON.fromEncodable(pattern)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["routes"], command: "explain", body: body, as: RoutesExplainReturn.self)
  }

  public func list(_ name: String? = nil, _ options: RoutesListOptions = .init()) async throws -> RoutesListReturn {
    var body: [String: RaviJSON] = [:]
    if let name {
      body["name"] = try RaviJSON.fromEncodable(name)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["routes"], command: "list", body: body, as: RoutesListReturn.self)
  }

  public func show(_ name: String, _ pattern: String) async throws -> RoutesShowReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["pattern"] = try RaviJSON.fromEncodable(pattern)
    return try await transport.call(groupSegments: ["routes"], command: "show", body: body, as: RoutesShowReturn.self)
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
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sdk","client"], command: "check", body: body, as: SdkClientCheckReturn.self)
  }

  public func generate(_ options: SdkClientGenerateOptions = .init()) async throws -> SdkClientGenerateReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sdk","client"], command: "generate", body: body, as: SdkClientGenerateReturn.self)
  }
}

public struct SdkOpenapiNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func check(_ options: SdkOpenapiCheckOptions = .init()) async throws -> SdkOpenapiCheckReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sdk","openapi"], command: "check", body: body, as: SdkOpenapiCheckReturn.self)
  }

  public func emit(_ options: SdkOpenapiEmitOptions = .init()) async throws -> SdkOpenapiEmitReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sdk","openapi"], command: "emit", body: body, as: SdkOpenapiEmitReturn.self)
  }
}

public struct SdkSwiftNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func check(_ options: SdkSwiftCheckOptions = .init()) async throws -> SdkSwiftCheckReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sdk","swift"], command: "check", body: body, as: SdkSwiftCheckReturn.self)
  }

  public func generate(_ options: SdkSwiftGenerateOptions = .init()) async throws -> SdkSwiftGenerateReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sdk","swift"], command: "generate", body: body, as: SdkSwiftGenerateReturn.self)
  }
}

public struct SelfNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func chat(_ options: SelfChatOptions = .init()) async throws -> SelfChatReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["self"], command: "chat", body: body, as: SelfChatReturn.self)
  }

  public func context(_ options: SelfContextOptions = .init()) async throws -> SelfContextReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["self"], command: "context", body: body, as: SelfContextReturn.self)
  }

  public func explain() async throws -> SelfExplainReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "explain", body: body, as: SelfExplainReturn.self)
  }

  public func knowledge() async throws -> SelfKnowledgeReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "knowledge", body: body, as: SelfKnowledgeReturn.self)
  }

  public func permissions() async throws -> SelfPermissionsReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "permissions", body: body, as: SelfPermissionsReturn.self)
  }

  public func recent(_ options: SelfRecentOptions = .init()) async throws -> SelfRecentReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["self"], command: "recent", body: body, as: SelfRecentReturn.self)
  }

  public func route() async throws -> SelfRouteReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "route", body: body, as: SelfRouteReturn.self)
  }

  public func whoami() async throws -> SelfWhoamiReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["self"], command: "whoami", body: body, as: SelfWhoamiReturn.self)
  }
}

public struct ServiceNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func start() async throws -> ServiceStartReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["service"], command: "start", body: body, as: ServiceStartReturn.self)
  }

  public func tui(_ session: String? = nil) async throws -> ServiceTuiReturn {
    var body: [String: RaviJSON] = [:]
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    return try await transport.call(groupSegments: ["service"], command: "tui", body: body, as: ServiceTuiReturn.self)
  }

  public func wa() async throws -> ServiceWaReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["service"], command: "wa", body: body, as: ServiceWaReturn.self)
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

  public func answer(_ target: String, _ message: String, _ sender: String? = nil, _ options: SessionsAnswerOptions = .init()) async throws -> SessionsAnswerReturn {
    var body: [String: RaviJSON] = [:]
    body["target"] = try RaviJSON.fromEncodable(target)
    body["message"] = try RaviJSON.fromEncodable(message)
    if let sender {
      body["sender"] = try RaviJSON.fromEncodable(sender)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "answer", body: body, as: SessionsAnswerReturn.self)
  }

  public func ask(_ target: String, _ message: String, _ sender: String? = nil, _ options: SessionsAskOptions = .init()) async throws -> SessionsAskReturn {
    var body: [String: RaviJSON] = [:]
    body["target"] = try RaviJSON.fromEncodable(target)
    body["message"] = try RaviJSON.fromEncodable(message)
    if let sender {
      body["sender"] = try RaviJSON.fromEncodable(sender)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "ask", body: body, as: SessionsAskReturn.self)
  }

  public func delete(_ nameOrKey: String) async throws -> SessionsDeleteReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "delete", body: body, as: SessionsDeleteReturn.self)
  }

  public func execute(_ target: String, _ message: String, _ options: SessionsExecuteOptions = .init()) async throws -> SessionsExecuteReturn {
    var body: [String: RaviJSON] = [:]
    body["target"] = try RaviJSON.fromEncodable(target)
    body["message"] = try RaviJSON.fromEncodable(message)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "execute", body: body, as: SessionsExecuteReturn.self)
  }

  public func extend(_ nameOrKey: String, _ duration: String? = nil) async throws -> SessionsExtendReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    if let duration {
      body["duration"] = try RaviJSON.fromEncodable(duration)
    }
    return try await transport.call(groupSegments: ["sessions"], command: "extend", body: body, as: SessionsExtendReturn.self)
  }

  public func goal(_ action: String, _ nameOrKey: String, _ objective: String? = nil, _ options: SessionsGoalOptions = .init()) async throws -> SessionsGoalReturn {
    var body: [String: RaviJSON] = [:]
    body["action"] = try RaviJSON.fromEncodable(action)
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    if let objective {
      body["objective"] = try RaviJSON.fromEncodable(objective)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "goal", body: body, as: SessionsGoalReturn.self)
  }

  public func info(_ nameOrKey: String) async throws -> SessionsInfoReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "info", body: body, as: SessionsInfoReturn.self)
  }

  public func inform(_ target: String, _ message: String, _ options: SessionsInformOptions = .init()) async throws -> SessionsInformReturn {
    var body: [String: RaviJSON] = [:]
    body["target"] = try RaviJSON.fromEncodable(target)
    body["message"] = try RaviJSON.fromEncodable(message)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "inform", body: body, as: SessionsInformReturn.self)
  }

  public func keep(_ nameOrKey: String) async throws -> SessionsKeepReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "keep", body: body, as: SessionsKeepReturn.self)
  }

  public func list(_ options: SessionsListOptions = .init()) async throws -> SessionsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "list", body: body, as: SessionsListReturn.self)
  }

  public func prune(_ options: SessionsPruneOptions = .init()) async throws -> SessionsPruneReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "prune", body: body, as: SessionsPruneReturn.self)
  }

  public func read(_ nameOrKey: String, _ options: SessionsReadOptions = .init()) async throws -> SessionsReadReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "read", body: body, as: SessionsReadReturn.self)
  }

  public func rename(_ nameOrKey: String, _ newName: String) async throws -> SessionsRenameReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    body["newName"] = try RaviJSON.fromEncodable(newName)
    return try await transport.call(groupSegments: ["sessions"], command: "rename", body: body, as: SessionsRenameReturn.self)
  }

  public func reset(_ nameOrKey: String) async throws -> SessionsResetReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "reset", body: body, as: SessionsResetReturn.self)
  }

  public func send(_ nameOrKey: String, _ prompt: String? = nil, _ options: SessionsSendOptions = .init()) async throws -> SessionsSendReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    if let prompt {
      body["prompt"] = try RaviJSON.fromEncodable(prompt)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "send", body: body, as: SessionsSendReturn.self)
  }

  public func setDisplay(_ nameOrKey: String, _ displayName: String) async throws -> SessionsSetDisplayReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    body["displayName"] = try RaviJSON.fromEncodable(displayName)
    return try await transport.call(groupSegments: ["sessions"], command: "set-display", body: body, as: SessionsSetDisplayReturn.self)
  }

  public func setModel(_ nameOrKey: String, _ model: String) async throws -> SessionsSetModelReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    body["model"] = try RaviJSON.fromEncodable(model)
    return try await transport.call(groupSegments: ["sessions"], command: "set-model", body: body, as: SessionsSetModelReturn.self)
  }

  public func setThinking(_ nameOrKey: String, _ level: String) async throws -> SessionsSetThinkingReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    body["level"] = try RaviJSON.fromEncodable(level)
    return try await transport.call(groupSegments: ["sessions"], command: "set-thinking", body: body, as: SessionsSetThinkingReturn.self)
  }

  public func setTtl(_ nameOrKey: String, _ duration: String) async throws -> SessionsSetTtlReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    body["duration"] = try RaviJSON.fromEncodable(duration)
    return try await transport.call(groupSegments: ["sessions"], command: "set-ttl", body: body, as: SessionsSetTtlReturn.self)
  }

  public func trace(_ nameOrKey: String, _ options: SessionsTraceOptions = .init()) async throws -> SessionsTraceReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions"], command: "trace", body: body, as: SessionsTraceReturn.self)
  }

  public func visibility(_ nameOrKey: String) async throws -> SessionsVisibilityReturn {
    var body: [String: RaviJSON] = [:]
    body["nameOrKey"] = try RaviJSON.fromEncodable(nameOrKey)
    return try await transport.call(groupSegments: ["sessions"], command: "visibility", body: body, as: SessionsVisibilityReturn.self)
  }
}

public struct SessionsRuntimeNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func followUp(_ session: String, _ text: String, _ options: SessionsRuntimeFollowUpOptions = .init()) async throws -> SessionsRuntimeFollowUpReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    body["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "follow-up", body: body, as: SessionsRuntimeFollowUpReturn.self)
  }

  public func fork(_ session: String, _ threadId: String? = nil, _ options: SessionsRuntimeForkOptions = .init()) async throws -> SessionsRuntimeForkReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    if let threadId {
      body["threadId"] = try RaviJSON.fromEncodable(threadId)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "fork", body: body, as: SessionsRuntimeForkReturn.self)
  }

  public func interrupt(_ session: String, _ options: SessionsRuntimeInterruptOptions = .init()) async throws -> SessionsRuntimeInterruptReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "interrupt", body: body, as: SessionsRuntimeInterruptReturn.self)
  }

  public func list(_ session: String, _ options: SessionsRuntimeListOptions = .init()) async throws -> SessionsRuntimeListReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "list", body: body, as: SessionsRuntimeListReturn.self)
  }

  public func read(_ session: String, _ threadId: String? = nil, _ options: SessionsRuntimeReadOptions = .init()) async throws -> SessionsRuntimeReadReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    if let threadId {
      body["threadId"] = try RaviJSON.fromEncodable(threadId)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "read", body: body, as: SessionsRuntimeReadReturn.self)
  }

  public func rollback(_ session: String, _ turns: String? = nil, _ options: SessionsRuntimeRollbackOptions = .init()) async throws -> SessionsRuntimeRollbackReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    if let turns {
      body["turns"] = try RaviJSON.fromEncodable(turns)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "rollback", body: body, as: SessionsRuntimeRollbackReturn.self)
  }

  public func steer(_ session: String, _ text: String, _ options: SessionsRuntimeSteerOptions = .init()) async throws -> SessionsRuntimeSteerReturn {
    var body: [String: RaviJSON] = [:]
    body["session"] = try RaviJSON.fromEncodable(session)
    body["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["sessions","runtime"], command: "steer", body: body, as: SessionsRuntimeSteerReturn.self)
  }
}

public struct SettingsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func delete(_ key: String) async throws -> SettingsDeleteReturn {
    var body: [String: RaviJSON] = [:]
    body["key"] = try RaviJSON.fromEncodable(key)
    return try await transport.call(groupSegments: ["settings"], command: "delete", body: body, as: SettingsDeleteReturn.self)
  }

  public func get(_ key: String) async throws -> SettingsGetReturn {
    var body: [String: RaviJSON] = [:]
    body["key"] = try RaviJSON.fromEncodable(key)
    return try await transport.call(groupSegments: ["settings"], command: "get", body: body, as: SettingsGetReturn.self)
  }

  public func list(_ options: SettingsListOptions = .init()) async throws -> SettingsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["settings"], command: "list", body: body, as: SettingsListReturn.self)
  }

  public func set(_ key: String, _ value: String) async throws -> SettingsSetReturn {
    var body: [String: RaviJSON] = [:]
    body["key"] = try RaviJSON.fromEncodable(key)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["settings"], command: "set", body: body, as: SettingsSetReturn.self)
  }
}

public struct SkillGatesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func disable(_ id: String) async throws -> SkillGatesDisableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "disable", body: body, as: SkillGatesDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> SkillGatesEnableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "enable", body: body, as: SkillGatesEnableReturn.self)
  }

  public func list(_ options: SkillGatesListOptions = .init()) async throws -> SkillGatesListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["skill-gates"], command: "list", body: body, as: SkillGatesListReturn.self)
  }

  public func reset(_ id: String) async throws -> SkillGatesResetReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "reset", body: body, as: SkillGatesResetReturn.self)
  }

  public func rm(_ id: String) async throws -> SkillGatesRmReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "rm", body: body, as: SkillGatesRmReturn.self)
  }

  public func set(_ id: String, _ skill: String, _ options: SkillGatesSetOptions = .init()) async throws -> SkillGatesSetReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["skill"] = try RaviJSON.fromEncodable(skill)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["skill-gates"], command: "set", body: body, as: SkillGatesSetReturn.self)
  }

  public func show(_ id: String) async throws -> SkillGatesShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["skill-gates"], command: "show", body: body, as: SkillGatesShowReturn.self)
  }
}

public struct SkillsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func install(_ name: String? = nil, _ options: SkillsInstallOptions = .init()) async throws -> SkillsInstallReturn {
    var body: [String: RaviJSON] = [:]
    if let name {
      body["name"] = try RaviJSON.fromEncodable(name)
    }
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["skills"], command: "install", body: body, as: SkillsInstallReturn.self)
  }

  public func list(_ options: SkillsListOptions = .init()) async throws -> SkillsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["skills"], command: "list", body: body, as: SkillsListReturn.self)
  }

  public func show(_ name: String, _ options: SkillsShowOptions = .init()) async throws -> SkillsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["skills"], command: "show", body: body, as: SkillsShowReturn.self)
  }

  public func sync() async throws -> SkillsSyncReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["skills"], command: "sync", body: body, as: SkillsSyncReturn.self)
  }
}

public struct SpecsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func get(_ id: String, _ options: SpecsGetOptions = .init()) async throws -> SpecsGetReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["specs"], command: "get", body: body, as: SpecsGetReturn.self)
  }

  public func list(_ options: SpecsListOptions = .init()) async throws -> SpecsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["specs"], command: "list", body: body, as: SpecsListReturn.self)
  }

  public func new(_ id: String, _ options: SpecsNewOptions = .init()) async throws -> SpecsNewReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["specs"], command: "new", body: body, as: SpecsNewReturn.self)
  }

  public func sync() async throws -> SpecsSyncReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["specs"], command: "sync", body: body, as: SpecsSyncReturn.self)
  }
}

public struct StickersNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ id: String, _ mediaPath: String, _ options: StickersAddOptions = .init()) async throws -> StickersAddReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["mediaPath"] = try RaviJSON.fromEncodable(mediaPath)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["stickers"], command: "add", body: body, as: StickersAddReturn.self)
  }

  public func list() async throws -> StickersListReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["stickers"], command: "list", body: body, as: StickersListReturn.self)
  }

  public func remove(_ id: String) async throws -> StickersRemoveReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["stickers"], command: "remove", body: body, as: StickersRemoveReturn.self)
  }

  public func send(_ id: String, _ options: StickersSendOptions = .init()) async throws -> StickersSendReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["stickers"], command: "send", body: body, as: StickersSendReturn.self)
  }

  public func show(_ id: String) async throws -> StickersShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["stickers"], command: "show", body: body, as: StickersShowReturn.self)
  }
}

public struct TagsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func attach(_ slug: String, _ options: TagsAttachOptions = .init()) async throws -> TagsAttachReturn {
    var body: [String: RaviJSON] = [:]
    body["slug"] = try RaviJSON.fromEncodable(slug)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tags"], command: "attach", body: body, as: TagsAttachReturn.self)
  }

  public func create(_ slug: String, _ options: TagsCreateOptions = .init()) async throws -> TagsCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["slug"] = try RaviJSON.fromEncodable(slug)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tags"], command: "create", body: body, as: TagsCreateReturn.self)
  }

  public func detach(_ slug: String, _ options: TagsDetachOptions = .init()) async throws -> TagsDetachReturn {
    var body: [String: RaviJSON] = [:]
    body["slug"] = try RaviJSON.fromEncodable(slug)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tags"], command: "detach", body: body, as: TagsDetachReturn.self)
  }

  public func list(_ options: TagsListOptions = .init()) async throws -> TagsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tags"], command: "list", body: body, as: TagsListReturn.self)
  }

  public func search(_ options: TagsSearchOptions = .init()) async throws -> TagsSearchReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tags"], command: "search", body: body, as: TagsSearchReturn.self)
  }

  public func set(_ slug: String, _ key: String, _ value: String) async throws -> TagsSetReturn {
    var body: [String: RaviJSON] = [:]
    body["slug"] = try RaviJSON.fromEncodable(slug)
    body["key"] = try RaviJSON.fromEncodable(key)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["tags"], command: "set", body: body, as: TagsSetReturn.self)
  }

  public func show(_ slug: String) async throws -> TagsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["slug"] = try RaviJSON.fromEncodable(slug)
    return try await transport.call(groupSegments: ["tags"], command: "show", body: body, as: TagsShowReturn.self)
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
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks"], command: "archive", body: body, as: TasksArchiveReturn.self)
  }

  public func block(_ taskId: String, _ options: TasksBlockOptions = .init()) async throws -> TasksBlockReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks"], command: "block", body: body, as: TasksBlockReturn.self)
  }

  public func comment(_ taskId: String, _ body: String) async throws -> TasksCommentReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    body["body"] = try RaviJSON.fromEncodable(body)
    return try await transport.call(groupSegments: ["tasks"], command: "comment", body: body, as: TasksCommentReturn.self)
  }

  public func create(_ title: String, _ options: TasksCreateOptions = .init()) async throws -> TasksCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["title"] = try RaviJSON.fromEncodable(title)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks"], command: "create", body: body, as: TasksCreateReturn.self)
  }

  public func dispatch(_ taskId: String, _ options: TasksDispatchOptions = .init()) async throws -> TasksDispatchReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks"], command: "dispatch", body: body, as: TasksDispatchReturn.self)
  }

  public func done(_ taskId: String, _ options: TasksDoneOptions = .init()) async throws -> TasksDoneReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks"], command: "done", body: body, as: TasksDoneReturn.self)
  }

  public func fail(_ taskId: String, _ options: TasksFailOptions = .init()) async throws -> TasksFailReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks"], command: "fail", body: body, as: TasksFailReturn.self)
  }

  public func list(_ options: TasksListOptions = .init()) async throws -> TasksListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks"], command: "list", body: body, as: TasksListReturn.self)
  }

  public func report(_ taskId: String, _ options: TasksReportOptions = .init()) async throws -> TasksReportReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks"], command: "report", body: body, as: TasksReportReturn.self)
  }

  public func show(_ taskId: String, _ options: TasksShowOptions = .init()) async throws -> TasksShowReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks"], command: "show", body: body, as: TasksShowReturn.self)
  }

  public func unarchive(_ taskId: String) async throws -> TasksUnarchiveReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    return try await transport.call(groupSegments: ["tasks"], command: "unarchive", body: body, as: TasksUnarchiveReturn.self)
  }
}

public struct TasksAutomationsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ name: String, _ options: TasksAutomationsAddOptions = .init()) async throws -> TasksAutomationsAddReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "add", body: body, as: TasksAutomationsAddReturn.self)
  }

  public func disable(_ id: String) async throws -> TasksAutomationsDisableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "disable", body: body, as: TasksAutomationsDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> TasksAutomationsEnableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "enable", body: body, as: TasksAutomationsEnableReturn.self)
  }

  public func list(_ options: TasksAutomationsListOptions = .init()) async throws -> TasksAutomationsListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "list", body: body, as: TasksAutomationsListReturn.self)
  }

  public func rm(_ id: String) async throws -> TasksAutomationsRmReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "rm", body: body, as: TasksAutomationsRmReturn.self)
  }

  public func show(_ id: String) async throws -> TasksAutomationsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["tasks","automations"], command: "show", body: body, as: TasksAutomationsShowReturn.self)
  }
}

public struct TasksDepsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ taskId: String, _ dependencyTaskId: String) async throws -> TasksDepsAddReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    body["dependencyTaskId"] = try RaviJSON.fromEncodable(dependencyTaskId)
    return try await transport.call(groupSegments: ["tasks","deps"], command: "add", body: body, as: TasksDepsAddReturn.self)
  }

  public func ls(_ taskId: String) async throws -> TasksDepsLsReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    return try await transport.call(groupSegments: ["tasks","deps"], command: "ls", body: body, as: TasksDepsLsReturn.self)
  }

  public func rm(_ taskId: String, _ dependencyTaskId: String) async throws -> TasksDepsRmReturn {
    var body: [String: RaviJSON] = [:]
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    body["dependencyTaskId"] = try RaviJSON.fromEncodable(dependencyTaskId)
    return try await transport.call(groupSegments: ["tasks","deps"], command: "rm", body: body, as: TasksDepsRmReturn.self)
  }
}

public struct TasksProfilesNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func init_(_ profileId: String, _ options: TasksProfilesInitOptions = .init()) async throws -> TasksProfilesInitReturn {
    var body: [String: RaviJSON] = [:]
    body["profileId"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "init", body: body, as: TasksProfilesInitReturn.self)
  }

  public func list() async throws -> TasksProfilesListReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "list", body: body, as: TasksProfilesListReturn.self)
  }

  public func preview(_ profileId: String, _ options: TasksProfilesPreviewOptions = .init()) async throws -> TasksProfilesPreviewReturn {
    var body: [String: RaviJSON] = [:]
    body["profileId"] = try RaviJSON.fromEncodable(profileId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "preview", body: body, as: TasksProfilesPreviewReturn.self)
  }

  public func show(_ profileId: String) async throws -> TasksProfilesShowReturn {
    var body: [String: RaviJSON] = [:]
    body["profileId"] = try RaviJSON.fromEncodable(profileId)
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "show", body: body, as: TasksProfilesShowReturn.self)
  }

  public func validate(_ profileId: String? = nil) async throws -> TasksProfilesValidateReturn {
    var body: [String: RaviJSON] = [:]
    if let profileId {
      body["profileId"] = try RaviJSON.fromEncodable(profileId)
    }
    return try await transport.call(groupSegments: ["tasks","profiles"], command: "validate", body: body, as: TasksProfilesValidateReturn.self)
  }
}

public struct ToolsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func list() async throws -> ToolsListReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["tools"], command: "list", body: body, as: ToolsListReturn.self)
  }

  public func manifest() async throws -> ToolsManifestReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["tools"], command: "manifest", body: body, as: ToolsManifestReturn.self)
  }

  public func schema() async throws -> ToolsSchemaReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["tools"], command: "schema", body: body, as: ToolsSchemaReturn.self)
  }

  public func show(_ name: String) async throws -> ToolsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    return try await transport.call(groupSegments: ["tools"], command: "show", body: body, as: ToolsShowReturn.self)
  }

  public func test(_ name: String, _ args: String? = nil) async throws -> ToolsTestReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    if let args {
      body["args"] = try RaviJSON.fromEncodable(args)
    }
    return try await transport.call(groupSegments: ["tools"], command: "test", body: body, as: ToolsTestReturn.self)
  }
}

public struct TranscribeNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func file(_ path: String, _ options: TranscribeFileOptions = .init()) async throws -> TranscribeFileReturn {
    var body: [String: RaviJSON] = [:]
    body["path"] = try RaviJSON.fromEncodable(path)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["transcribe"], command: "file", body: body, as: TranscribeFileReturn.self)
  }
}

public struct TriggersNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ name: String, _ options: TriggersAddOptions = .init()) async throws -> TriggersAddReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["triggers"], command: "add", body: body, as: TriggersAddReturn.self)
  }

  public func disable(_ id: String) async throws -> TriggersDisableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "disable", body: body, as: TriggersDisableReturn.self)
  }

  public func enable(_ id: String) async throws -> TriggersEnableReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "enable", body: body, as: TriggersEnableReturn.self)
  }

  public func list(_ options: TriggersListOptions = .init()) async throws -> TriggersListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["triggers"], command: "list", body: body, as: TriggersListReturn.self)
  }

  public func rm(_ id: String) async throws -> TriggersRmReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "rm", body: body, as: TriggersRmReturn.self)
  }

  public func set(_ id: String, _ key: String, _ value: String) async throws -> TriggersSetReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    body["key"] = try RaviJSON.fromEncodable(key)
    body["value"] = try RaviJSON.fromEncodable(value)
    return try await transport.call(groupSegments: ["triggers"], command: "set", body: body, as: TriggersSetReturn.self)
  }

  public func show(_ id: String) async throws -> TriggersShowReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "show", body: body, as: TriggersShowReturn.self)
  }

  public func test(_ id: String) async throws -> TriggersTestReturn {
    var body: [String: RaviJSON] = [:]
    body["id"] = try RaviJSON.fromEncodable(id)
    return try await transport.call(groupSegments: ["triggers"], command: "test", body: body, as: TriggersTestReturn.self)
  }
}

public struct VideoNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func analyze(_ url: String, _ options: VideoAnalyzeOptions = .init()) async throws -> VideoAnalyzeReturn {
    var body: [String: RaviJSON] = [:]
    body["url"] = try RaviJSON.fromEncodable(url)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["video"], command: "analyze", body: body, as: VideoAnalyzeReturn.self)
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
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    body["messageId"] = try RaviJSON.fromEncodable(messageId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","dm"], command: "ack", body: body, as: WhatsappDmAckReturn.self)
  }

  public func read(_ contact: String, _ options: WhatsappDmReadOptions = .init()) async throws -> WhatsappDmReadReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","dm"], command: "read", body: body, as: WhatsappDmReadReturn.self)
  }

  public func send(_ contact: String, _ message: String, _ options: WhatsappDmSendOptions = .init()) async throws -> WhatsappDmSendReturn {
    var body: [String: RaviJSON] = [:]
    body["contact"] = try RaviJSON.fromEncodable(contact)
    body["message"] = try RaviJSON.fromEncodable(message)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","dm"], command: "send", body: body, as: WhatsappDmSendReturn.self)
  }
}

public struct WhatsappGroupNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func add(_ groupId: String, _ participants: String, _ options: WhatsappGroupAddOptions = .init()) async throws -> WhatsappGroupAddReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    body["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "add", body: body, as: WhatsappGroupAddReturn.self)
  }

  public func create(_ name: String, _ participants: String, _ options: WhatsappGroupCreateOptions = .init()) async throws -> WhatsappGroupCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["name"] = try RaviJSON.fromEncodable(name)
    body["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "create", body: body, as: WhatsappGroupCreateReturn.self)
  }

  public func demote(_ groupId: String, _ participants: String, _ options: WhatsappGroupDemoteOptions = .init()) async throws -> WhatsappGroupDemoteReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    body["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "demote", body: body, as: WhatsappGroupDemoteReturn.self)
  }

  public func description(_ groupId: String, _ text: String, _ options: WhatsappGroupDescriptionOptions = .init()) async throws -> WhatsappGroupDescriptionReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    body["text"] = try RaviJSON.fromEncodable(text)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "description", body: body, as: WhatsappGroupDescriptionReturn.self)
  }

  public func info(_ groupId: String, _ options: WhatsappGroupInfoOptions = .init()) async throws -> WhatsappGroupInfoReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "info", body: body, as: WhatsappGroupInfoReturn.self)
  }

  public func invite(_ groupId: String, _ options: WhatsappGroupInviteOptions = .init()) async throws -> WhatsappGroupInviteReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "invite", body: body, as: WhatsappGroupInviteReturn.self)
  }

  public func join(_ code: String, _ options: WhatsappGroupJoinOptions = .init()) async throws -> WhatsappGroupJoinReturn {
    var body: [String: RaviJSON] = [:]
    body["code"] = try RaviJSON.fromEncodable(code)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "join", body: body, as: WhatsappGroupJoinReturn.self)
  }

  public func leave(_ groupId: String, _ options: WhatsappGroupLeaveOptions = .init()) async throws -> WhatsappGroupLeaveReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "leave", body: body, as: WhatsappGroupLeaveReturn.self)
  }

  public func list(_ options: WhatsappGroupListOptions = .init()) async throws -> WhatsappGroupListReturn {
    var body: [String: RaviJSON] = [:]
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "list", body: body, as: WhatsappGroupListReturn.self)
  }

  public func promote(_ groupId: String, _ participants: String, _ options: WhatsappGroupPromoteOptions = .init()) async throws -> WhatsappGroupPromoteReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    body["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "promote", body: body, as: WhatsappGroupPromoteReturn.self)
  }

  public func remove(_ groupId: String, _ participants: String, _ options: WhatsappGroupRemoveOptions = .init()) async throws -> WhatsappGroupRemoveReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    body["participants"] = try RaviJSON.fromEncodable(participants)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "remove", body: body, as: WhatsappGroupRemoveReturn.self)
  }

  public func rename(_ groupId: String, _ name: String, _ options: WhatsappGroupRenameOptions = .init()) async throws -> WhatsappGroupRenameReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    body["name"] = try RaviJSON.fromEncodable(name)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "rename", body: body, as: WhatsappGroupRenameReturn.self)
  }

  public func revokeInvite(_ groupId: String, _ options: WhatsappGroupRevokeInviteOptions = .init()) async throws -> WhatsappGroupRevokeInviteReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "revoke-invite", body: body, as: WhatsappGroupRevokeInviteReturn.self)
  }

  public func settings(_ groupId: String, _ setting: String, _ options: WhatsappGroupSettingsOptions = .init()) async throws -> WhatsappGroupSettingsReturn {
    var body: [String: RaviJSON] = [:]
    body["groupId"] = try RaviJSON.fromEncodable(groupId)
    body["setting"] = try RaviJSON.fromEncodable(setting)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["whatsapp","group"], command: "settings", body: body, as: WhatsappGroupSettingsReturn.self)
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
    var body: [String: RaviJSON] = [:]
    body["runId"] = try RaviJSON.fromEncodable(runId)
    body["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "archive-node", body: body, as: WorkflowsRunsArchiveNodeReturn.self)
  }

  public func cancel(_ runId: String, _ nodeKey: String) async throws -> WorkflowsRunsCancelReturn {
    var body: [String: RaviJSON] = [:]
    body["runId"] = try RaviJSON.fromEncodable(runId)
    body["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "cancel", body: body, as: WorkflowsRunsCancelReturn.self)
  }

  public func list() async throws -> WorkflowsRunsListReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["workflows","runs"], command: "list", body: body, as: WorkflowsRunsListReturn.self)
  }

  public func release(_ runId: String, _ nodeKey: String) async throws -> WorkflowsRunsReleaseReturn {
    var body: [String: RaviJSON] = [:]
    body["runId"] = try RaviJSON.fromEncodable(runId)
    body["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "release", body: body, as: WorkflowsRunsReleaseReturn.self)
  }

  public func show(_ runId: String) async throws -> WorkflowsRunsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["runId"] = try RaviJSON.fromEncodable(runId)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "show", body: body, as: WorkflowsRunsShowReturn.self)
  }

  public func skip(_ runId: String, _ nodeKey: String) async throws -> WorkflowsRunsSkipReturn {
    var body: [String: RaviJSON] = [:]
    body["runId"] = try RaviJSON.fromEncodable(runId)
    body["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "skip", body: body, as: WorkflowsRunsSkipReturn.self)
  }

  public func start(_ specId: String, _ options: WorkflowsRunsStartOptions = .init()) async throws -> WorkflowsRunsStartReturn {
    var body: [String: RaviJSON] = [:]
    body["specId"] = try RaviJSON.fromEncodable(specId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "start", body: body, as: WorkflowsRunsStartReturn.self)
  }

  public func taskAttach(_ runId: String, _ nodeKey: String, _ taskId: String) async throws -> WorkflowsRunsTaskAttachReturn {
    var body: [String: RaviJSON] = [:]
    body["runId"] = try RaviJSON.fromEncodable(runId)
    body["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    body["taskId"] = try RaviJSON.fromEncodable(taskId)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "task-attach", body: body, as: WorkflowsRunsTaskAttachReturn.self)
  }

  public func taskCreate(_ runId: String, _ nodeKey: String, _ options: WorkflowsRunsTaskCreateOptions = .init()) async throws -> WorkflowsRunsTaskCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["runId"] = try RaviJSON.fromEncodable(runId)
    body["nodeKey"] = try RaviJSON.fromEncodable(nodeKey)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["workflows","runs"], command: "task-create", body: body, as: WorkflowsRunsTaskCreateReturn.self)
  }
}

public struct WorkflowsSpecsNamespace: Sendable {
  private let transport: any RaviTransport

  init(transport: any RaviTransport) {
    self.transport = transport
  }

  public func create(_ specId: String, _ options: WorkflowsSpecsCreateOptions = .init()) async throws -> WorkflowsSpecsCreateReturn {
    var body: [String: RaviJSON] = [:]
    body["specId"] = try RaviJSON.fromEncodable(specId)
    try options.encodeBody(into: &body)
    return try await transport.call(groupSegments: ["workflows","specs"], command: "create", body: body, as: WorkflowsSpecsCreateReturn.self)
  }

  public func list() async throws -> WorkflowsSpecsListReturn {
    let body: [String: RaviJSON] = [:]
    return try await transport.call(groupSegments: ["workflows","specs"], command: "list", body: body, as: WorkflowsSpecsListReturn.self)
  }

  public func show(_ specId: String) async throws -> WorkflowsSpecsShowReturn {
    var body: [String: RaviJSON] = [:]
    body["specId"] = try RaviJSON.fromEncodable(specId)
    return try await transport.call(groupSegments: ["workflows","specs"], command: "show", body: body, as: WorkflowsSpecsShowReturn.self)
  }
}
