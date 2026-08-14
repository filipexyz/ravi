// GENERATED FILE - DO NOT EDIT.
// Run `ravi sdk swift generate` to regenerate.
// Drift is detected by `ravi sdk swift check`.

import Foundation

public struct AdaptersListOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?
  public var session: String?
  public var status: String?

  public init(limit: String? = nil, offset: String? = nil, session: String? = nil, status: String? = nil) {
    self.limit = limit
    self.offset = offset
    self.session = session
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
    case session = "session"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AdaptersListReturn: Codable, Sendable {
  public var adapters: [RaviJSON]
  public var count: Double
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var total: Double

  public init(adapters: [RaviJSON], count: Double, items: [RaviJSON], pagination: RaviJSON, total: Double) {
    self.adapters = adapters
    self.count = count
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case adapters = "adapters"
    case count = "count"
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct AdaptersShowReturn: Codable, Sendable {
  public var adapterId: String
  public var adapterName: String
  public var bind: RaviJSON
  public var diagnosticState: String
  public var health: [String: RaviJSON]
  public var lastCommand: RaviJSON
  public var lastEvent: RaviJSON
  public var lastProtocolError: RaviJSON
  public var sessionKey: String
  public var sessionName: RaviJSON
  public var status: String
  public var transport: String
  public var updatedAt: Double

  public init(adapterId: String, adapterName: String, bind: RaviJSON, diagnosticState: String, health: [String: RaviJSON], lastCommand: RaviJSON, lastEvent: RaviJSON, lastProtocolError: RaviJSON, sessionKey: String, sessionName: RaviJSON, status: String, transport: String, updatedAt: Double) {
    self.adapterId = adapterId
    self.adapterName = adapterName
    self.bind = bind
    self.diagnosticState = diagnosticState
    self.health = health
    self.lastCommand = lastCommand
    self.lastEvent = lastEvent
    self.lastProtocolError = lastProtocolError
    self.sessionKey = sessionKey
    self.sessionName = sessionName
    self.status = status
    self.transport = transport
    self.updatedAt = updatedAt
  }

  enum CodingKeys: String, CodingKey {
    case adapterId = "adapterId"
    case adapterName = "adapterName"
    case bind = "bind"
    case diagnosticState = "diagnosticState"
    case health = "health"
    case lastCommand = "lastCommand"
    case lastEvent = "lastEvent"
    case lastProtocolError = "lastProtocolError"
    case sessionKey = "sessionKey"
    case sessionName = "sessionName"
    case status = "status"
    case transport = "transport"
    case updatedAt = "updatedAt"
  }
}

public struct AgentsCreateOptions: Codable, Sendable {
  public var allowRuntimeMismatch: Bool?
  public var model: String?
  public var modelPreset: String?
  public var provider: String?

  public init(allowRuntimeMismatch: Bool? = nil, model: String? = nil, modelPreset: String? = nil, provider: String? = nil) {
    self.allowRuntimeMismatch = allowRuntimeMismatch
    self.model = model
    self.modelPreset = modelPreset
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case allowRuntimeMismatch = "allowRuntimeMismatch"
    case model = "model"
    case modelPreset = "modelPreset"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.modelPreset {
      body["modelPreset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AgentsCreateReturn: Codable, Sendable {
  public var action: String
  public var agent: [String: RaviJSON]
  public var changed: Bool
  public var permissions: [String: RaviJSON]
  public var runtimeTarget: [String: RaviJSON]

  public init(action: String, agent: [String: RaviJSON], changed: Bool, permissions: [String: RaviJSON], runtimeTarget: [String: RaviJSON]) {
    self.action = action
    self.agent = agent
    self.changed = changed
    self.permissions = permissions
    self.runtimeTarget = runtimeTarget
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case agent = "agent"
    case changed = "changed"
    case permissions = "permissions"
    case runtimeTarget = "runtimeTarget"
  }
}

public struct AgentsDebounceReturn: Codable, Sendable {
  public var action: String?
  public var agentId: String
  public var changed: Bool?
  public var debounceMs: RaviJSON
  public var enabled: Bool

  public init(action: String? = nil, agentId: String, changed: Bool? = nil, debounceMs: RaviJSON, enabled: Bool) {
    self.action = action
    self.agentId = agentId
    self.changed = changed
    self.debounceMs = debounceMs
    self.enabled = enabled
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case agentId = "agentId"
    case changed = "changed"
    case debounceMs = "debounceMs"
    case enabled = "enabled"
  }
}

public struct AgentsDebugOptions: Codable, Sendable {
  public var turns: String?

  public init(turns: String? = nil) {
    self.turns = turns
  }

  enum CodingKeys: String, CodingKey {
    case turns = "turns"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.turns {
      body["turns"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias AgentsDebugReturn = RaviJSON

public struct AgentsDeleteOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AgentsDeleteReturn: Codable, Sendable {
  public var action: String
  public var agentId: String
  public var before: [String: RaviJSON]?
  public var changed: Bool

  public init(action: String, agentId: String, before: [String: RaviJSON]? = nil, changed: Bool) {
    self.action = action
    self.agentId = agentId
    self.before = before
    self.changed = changed
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case agentId = "agentId"
    case before = "before"
    case changed = "changed"
  }
}

public struct AgentsIntelligenceOptions: Codable, Sendable {
  public var clear: Bool?
  public var connections: String?
  public var execute: Bool?
  public var profile: String?
  public var required: String?

  public init(clear: Bool? = nil, connections: String? = nil, execute: Bool? = nil, profile: String? = nil, required: String? = nil) {
    self.clear = clear
    self.connections = connections
    self.execute = execute
    self.profile = profile
    self.required = required
  }

  enum CodingKeys: String, CodingKey {
    case clear = "clear"
    case connections = "connections"
    case execute = "execute"
    case profile = "profile"
    case required = "required"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.clear {
      body["clear"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.connections {
      body["connections"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.required {
      body["required"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AgentsIntelligenceReturn: Codable, Sendable {
  public var action: String
  public var agent: RaviJSON?
  public var agentId: String
  public var changed: Bool
  public var defaults: RaviJSON?
  public var intelligence: RaviJSON

  public init(action: String, agent: RaviJSON? = nil, agentId: String, changed: Bool, defaults: RaviJSON? = nil, intelligence: RaviJSON) {
    self.action = action
    self.agent = agent
    self.agentId = agentId
    self.changed = changed
    self.defaults = defaults
    self.intelligence = intelligence
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case agent = "agent"
    case agentId = "agentId"
    case changed = "changed"
    case defaults = "defaults"
    case intelligence = "intelligence"
  }
}

public struct AgentsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AgentsListReturn: Codable, Sendable {
  public var agents: [RaviJSON]
  public var defaultAgent: String
  public var filters: RaviJSON
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var total: Double

  public init(agents: [RaviJSON], defaultAgent: String, filters: RaviJSON, items: [RaviJSON], pagination: RaviJSON, total: Double) {
    self.agents = agents
    self.defaultAgent = defaultAgent
    self.filters = filters
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case agents = "agents"
    case defaultAgent = "defaultAgent"
    case filters = "filters"
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct AgentsPermissionsOptions: Codable, Sendable {
  public var capabilities: String?
  public var clearCapabilities: Bool?
  public var execute: Bool?

  public init(capabilities: String? = nil, clearCapabilities: Bool? = nil, execute: Bool? = nil) {
    self.capabilities = capabilities
    self.clearCapabilities = clearCapabilities
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case capabilities = "capabilities"
    case clearCapabilities = "clearCapabilities"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.capabilities {
      body["capabilities"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.clearCapabilities {
      body["clearCapabilities"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AgentsPermissionsReturn: Codable, Sendable {
  public var action: String
  public var after: RaviJSON?
  public var agent: RaviJSON?
  public var agentId: String
  public var before: RaviJSON?
  public var changed: Bool
  public var command: String?
  public var defaults: RaviJSON?
  public var profile: String?
  public var runtimePermissions: RaviJSON?

  public init(action: String, after: RaviJSON? = nil, agent: RaviJSON? = nil, agentId: String, before: RaviJSON? = nil, changed: Bool, command: String? = nil, defaults: RaviJSON? = nil, profile: String? = nil, runtimePermissions: RaviJSON? = nil) {
    self.action = action
    self.after = after
    self.agent = agent
    self.agentId = agentId
    self.before = before
    self.changed = changed
    self.command = command
    self.defaults = defaults
    self.profile = profile
    self.runtimePermissions = runtimePermissions
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case after = "after"
    case agent = "agent"
    case agentId = "agentId"
    case before = "before"
    case changed = "changed"
    case command = "command"
    case defaults = "defaults"
    case profile = "profile"
    case runtimePermissions = "runtimePermissions"
  }
}

public struct AgentsResetOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AgentsResetReturn: Codable, Sendable {
  public var action: String
  public var agentId: String
  public var availableSessions: [String]?
  public var changed: Bool
  public var count: Double?
  public var reason: String?
  public var resetSessions: [[String: RaviJSON]]?
  public var session: [String: RaviJSON]?
  public var target: String

  public init(action: String, agentId: String, availableSessions: [String]? = nil, changed: Bool, count: Double? = nil, reason: String? = nil, resetSessions: [[String: RaviJSON]]? = nil, session: [String: RaviJSON]? = nil, target: String) {
    self.action = action
    self.agentId = agentId
    self.availableSessions = availableSessions
    self.changed = changed
    self.count = count
    self.reason = reason
    self.resetSessions = resetSessions
    self.session = session
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case agentId = "agentId"
    case availableSessions = "availableSessions"
    case changed = "changed"
    case count = "count"
    case reason = "reason"
    case resetSessions = "resetSessions"
    case session = "session"
    case target = "target"
  }
}

public struct AgentsSessionReturn: Codable, Sendable {
  public var agent: [String: RaviJSON]
  public var sessions: [[String: RaviJSON]]
  public var total: Double

  public init(agent: [String: RaviJSON], sessions: [[String: RaviJSON]], total: Double) {
    self.agent = agent
    self.sessions = sessions
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case sessions = "sessions"
    case total = "total"
  }
}

public struct AgentsSetReturn: Codable, Sendable {
  public var action: String
  public var agent: [String: RaviJSON]?
  public var agentId: String
  public var changed: Bool
  public var key: String
  public var sessionOverrides: [RaviJSON]
  public var value: RaviJSON

  public init(action: String, agent: [String: RaviJSON]? = nil, agentId: String, changed: Bool, key: String, sessionOverrides: [RaviJSON], value: RaviJSON) {
    self.action = action
    self.agent = agent
    self.agentId = agentId
    self.changed = changed
    self.key = key
    self.sessionOverrides = sessionOverrides
    self.value = value
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case agent = "agent"
    case agentId = "agentId"
    case changed = "changed"
    case key = "key"
    case sessionOverrides = "sessionOverrides"
    case value = "value"
  }
}

public struct AgentsShowReturn: Codable, Sendable {
  public var agent: RaviJSON
  public var permissionsCommand: String
  public var runtimePermissions: RaviJSON

  public init(agent: RaviJSON, permissionsCommand: String, runtimePermissions: RaviJSON) {
    self.agent = agent
    self.permissionsCommand = permissionsCommand
    self.runtimePermissions = runtimePermissions
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case permissionsCommand = "permissionsCommand"
    case runtimePermissions = "runtimePermissions"
  }
}

public struct AgentsSpecModeReturn: Codable, Sendable {
  public var action: String?
  public var agentId: String
  public var changed: Bool?
  public var specMode: Bool

  public init(action: String? = nil, agentId: String, changed: Bool? = nil, specMode: Bool) {
    self.action = action
    self.agentId = agentId
    self.changed = changed
    self.specMode = specMode
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case agentId = "agentId"
    case changed = "changed"
    case specMode = "specMode"
  }
}

public struct AgentsSyncInstructionsOptions: Codable, Sendable {
  public var agent: String?
  public var materializeMissing: Bool?

  public init(agent: String? = nil, materializeMissing: Bool? = nil) {
    self.agent = agent
    self.materializeMissing = materializeMissing
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case materializeMissing = "materializeMissing"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.materializeMissing {
      body["materializeMissing"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AgentsSyncInstructionsReturn: Codable, Sendable {
  public var alreadyCanonical: Double
  public var incomplete: Double
  public var manualReview: Double
  public var migrated: Double
  public var missing: Double
  public var results: [[String: RaviJSON]]
  public var total: Double

  public init(alreadyCanonical: Double, incomplete: Double, manualReview: Double, migrated: Double, missing: Double, results: [[String: RaviJSON]], total: Double) {
    self.alreadyCanonical = alreadyCanonical
    self.incomplete = incomplete
    self.manualReview = manualReview
    self.migrated = migrated
    self.missing = missing
    self.results = results
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case alreadyCanonical = "alreadyCanonical"
    case incomplete = "incomplete"
    case manualReview = "manualReview"
    case migrated = "migrated"
    case missing = "missing"
    case results = "results"
    case total = "total"
  }
}

public struct AppsCheckReturn: Codable, Sendable {
  public var checked: Double
  public var ok: Bool
  public var results: [RaviJSON]

  public init(checked: Double, ok: Bool, results: [RaviJSON]) {
    self.checked = checked
    self.ok = ok
    self.results = results
  }

  enum CodingKeys: String, CodingKey {
    case checked = "checked"
    case ok = "ok"
    case results = "results"
  }
}

public struct AppsDeleteOptions: Codable, Sendable {
  public var dryRun: Bool?

  public init(dryRun: Bool? = nil) {
    self.dryRun = dryRun
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AppsDeleteReturn: Codable, Sendable {
  public var dryRun: Bool
  public var files: [RaviJSON]
  public var id: String
  public var nextCommands: [String]
  public var removedDirs: [String]

  public init(dryRun: Bool, files: [RaviJSON], id: String, nextCommands: [String], removedDirs: [String]) {
    self.dryRun = dryRun
    self.files = files
    self.id = id
    self.nextCommands = nextCommands
    self.removedDirs = removedDirs
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
    case files = "files"
    case id = "id"
    case nextCommands = "nextCommands"
    case removedDirs = "removedDirs"
  }
}

public struct AppsGuideReturn: Codable, Sendable {
  public var app: RaviJSON
  public var appId: RaviJSON
  public var builder: RaviJSON
  public var nextCommands: [String]
  public var prompts: [RaviJSON]
  public var skill: String
  public var skillGate: RaviJSON

  public init(app: RaviJSON, appId: RaviJSON, builder: RaviJSON, nextCommands: [String], prompts: [RaviJSON], skill: String, skillGate: RaviJSON) {
    self.app = app
    self.appId = appId
    self.builder = builder
    self.nextCommands = nextCommands
    self.prompts = prompts
    self.skill = skill
    self.skillGate = skillGate
  }

  enum CodingKeys: String, CodingKey {
    case app = "app"
    case appId = "appId"
    case builder = "builder"
    case nextCommands = "nextCommands"
    case prompts = "prompts"
    case skill = "skill"
    case skillGate = "skillGate"
  }
}

public struct AppsImportCliOptions: Codable, Sendable {
  public var description: String?
  public var dryRun: Bool?
  public var force: Bool?
  public var id: String?
  public var name: String?
  public var skipSkill: Bool?
  public var skipSpec: Bool?
  public var skipUi: Bool?
  public var source: String?

  public init(description: String? = nil, dryRun: Bool? = nil, force: Bool? = nil, id: String? = nil, name: String? = nil, skipSkill: Bool? = nil, skipSpec: Bool? = nil, skipUi: Bool? = nil, source: String? = nil) {
    self.description = description
    self.dryRun = dryRun
    self.force = force
    self.id = id
    self.name = name
    self.skipSkill = skipSkill
    self.skipSpec = skipSpec
    self.skipUi = skipUi
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case description = "description"
    case dryRun = "dryRun"
    case force = "force"
    case id = "id"
    case name = "name"
    case skipSkill = "skipSkill"
    case skipSpec = "skipSpec"
    case skipUi = "skipUi"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.force {
      body["force"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.id {
      body["id"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipSkill {
      body["skipSkill"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipSpec {
      body["skipSpec"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipUi {
      body["skipUi"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AppsImportCliReturn: Codable, Sendable {
  public var builder: RaviJSON
  public var cliPath: RaviJSON
  public var command: String
  public var confidence: String
  public var debugCandidates: [RaviJSON]
  public var description: String
  public var dryRun: Bool
  public var files: [RaviJSON]
  public var force: Bool
  public var id: String
  public var manifest: [String: RaviJSON]
  public var manifestPath: String
  public var name: String
  public var nextCommands: [String]
  public var operationCandidates: [RaviJSON]
  public var reviewRequired: [String]
  public var skill: RaviJSON
  public var skillPath: RaviJSON
  public var source: String
  public var sourceCommand: String
  public var specPath: RaviJSON
  public var warnings: [String]

  public init(builder: RaviJSON, cliPath: RaviJSON, command: String, confidence: String, debugCandidates: [RaviJSON], description: String, dryRun: Bool, files: [RaviJSON], force: Bool, id: String, manifest: [String: RaviJSON], manifestPath: String, name: String, nextCommands: [String], operationCandidates: [RaviJSON], reviewRequired: [String], skill: RaviJSON, skillPath: RaviJSON, source: String, sourceCommand: String, specPath: RaviJSON, warnings: [String]) {
    self.builder = builder
    self.cliPath = cliPath
    self.command = command
    self.confidence = confidence
    self.debugCandidates = debugCandidates
    self.description = description
    self.dryRun = dryRun
    self.files = files
    self.force = force
    self.id = id
    self.manifest = manifest
    self.manifestPath = manifestPath
    self.name = name
    self.nextCommands = nextCommands
    self.operationCandidates = operationCandidates
    self.reviewRequired = reviewRequired
    self.skill = skill
    self.skillPath = skillPath
    self.source = source
    self.sourceCommand = sourceCommand
    self.specPath = specPath
    self.warnings = warnings
  }

  enum CodingKeys: String, CodingKey {
    case builder = "builder"
    case cliPath = "cliPath"
    case command = "command"
    case confidence = "confidence"
    case debugCandidates = "debugCandidates"
    case description = "description"
    case dryRun = "dryRun"
    case files = "files"
    case force = "force"
    case id = "id"
    case manifest = "manifest"
    case manifestPath = "manifestPath"
    case name = "name"
    case nextCommands = "nextCommands"
    case operationCandidates = "operationCandidates"
    case reviewRequired = "reviewRequired"
    case skill = "skill"
    case skillPath = "skillPath"
    case source = "source"
    case sourceCommand = "sourceCommand"
    case specPath = "specPath"
    case warnings = "warnings"
  }
}

public struct AppsListOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?
  public var source: String?

  public init(limit: String? = nil, offset: String? = nil, source: String? = nil) {
    self.limit = limit
    self.offset = offset
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AppsListReturn: Codable, Sendable {
  public var apps: [RaviJSON]
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var total: Double

  public init(apps: [RaviJSON], items: [RaviJSON], pagination: RaviJSON, total: Double) {
    self.apps = apps
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case apps = "apps"
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct AppsPromptsReturn: Codable, Sendable {
  public var app: RaviJSON
  public var appId: RaviJSON
  public var builder: RaviJSON
  public var nextCommands: [String]
  public var prompts: [RaviJSON]
  public var skill: String
  public var skillGate: RaviJSON

  public init(app: RaviJSON, appId: RaviJSON, builder: RaviJSON, nextCommands: [String], prompts: [RaviJSON], skill: String, skillGate: RaviJSON) {
    self.app = app
    self.appId = appId
    self.builder = builder
    self.nextCommands = nextCommands
    self.prompts = prompts
    self.skill = skill
    self.skillGate = skillGate
  }

  enum CodingKeys: String, CodingKey {
    case app = "app"
    case appId = "appId"
    case builder = "builder"
    case nextCommands = "nextCommands"
    case prompts = "prompts"
    case skill = "skill"
    case skillGate = "skillGate"
  }
}

public struct AppsRunOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AppsRunReturn: Codable, Sendable {
  public var appId: RaviJSON
  public var callerContextId: String?
  public var channel: String?
  public var childContextId: String?
  public var command: String?
  public var dryRun: Bool?
  public var durationMs: Double
  public var error: String?
  public var errorCode: String?
  public var exitCode: RaviJSON?
  public var handler: String?
  public var interface: RaviJSON
  public var mutating: Bool
  public var ok: Bool
  public var operation: RaviJSON
  public var operationId: RaviJSON
  public var permissionProvider: RaviJSON?
  public var plan: RaviJSON?
  public var result: RaviJSON?
  public var status: String
  public var stderr: String?
  public var stdout: String?

  public init(appId: RaviJSON, callerContextId: String? = nil, channel: String? = nil, childContextId: String? = nil, command: String? = nil, dryRun: Bool? = nil, durationMs: Double, error: String? = nil, errorCode: String? = nil, exitCode: RaviJSON? = nil, handler: String? = nil, interface: RaviJSON, mutating: Bool, ok: Bool, operation: RaviJSON, operationId: RaviJSON, permissionProvider: RaviJSON? = nil, plan: RaviJSON? = nil, result: RaviJSON? = nil, status: String, stderr: String? = nil, stdout: String? = nil) {
    self.appId = appId
    self.callerContextId = callerContextId
    self.channel = channel
    self.childContextId = childContextId
    self.command = command
    self.dryRun = dryRun
    self.durationMs = durationMs
    self.error = error
    self.errorCode = errorCode
    self.exitCode = exitCode
    self.handler = handler
    self.interface = interface
    self.mutating = mutating
    self.ok = ok
    self.operation = operation
    self.operationId = operationId
    self.permissionProvider = permissionProvider
    self.plan = plan
    self.result = result
    self.status = status
    self.stderr = stderr
    self.stdout = stdout
  }

  enum CodingKeys: String, CodingKey {
    case appId = "appId"
    case callerContextId = "callerContextId"
    case channel = "channel"
    case childContextId = "childContextId"
    case command = "command"
    case dryRun = "dryRun"
    case durationMs = "durationMs"
    case error = "error"
    case errorCode = "errorCode"
    case exitCode = "exitCode"
    case handler = "handler"
    case interface = "interface"
    case mutating = "mutating"
    case ok = "ok"
    case operation = "operation"
    case operationId = "operationId"
    case permissionProvider = "permissionProvider"
    case plan = "plan"
    case result = "result"
    case status = "status"
    case stderr = "stderr"
    case stdout = "stdout"
  }
}

public struct AppsScaffoldOptions: Codable, Sendable {
  public var command: String?
  public var description: String?
  public var dryRun: Bool?
  public var force: Bool?
  public var name: String?
  public var skipSkill: Bool?
  public var skipSpec: Bool?
  public var skipUi: Bool?

  public init(command: String? = nil, description: String? = nil, dryRun: Bool? = nil, force: Bool? = nil, name: String? = nil, skipSkill: Bool? = nil, skipSpec: Bool? = nil, skipUi: Bool? = nil) {
    self.command = command
    self.description = description
    self.dryRun = dryRun
    self.force = force
    self.name = name
    self.skipSkill = skipSkill
    self.skipSpec = skipSpec
    self.skipUi = skipUi
  }

  enum CodingKeys: String, CodingKey {
    case command = "command"
    case description = "description"
    case dryRun = "dryRun"
    case force = "force"
    case name = "name"
    case skipSkill = "skipSkill"
    case skipSpec = "skipSpec"
    case skipUi = "skipUi"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.command {
      body["command"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.force {
      body["force"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipSkill {
      body["skipSkill"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipSpec {
      body["skipSpec"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipUi {
      body["skipUi"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AppsScaffoldReturn: Codable, Sendable {
  public var builder: RaviJSON
  public var cliPath: RaviJSON
  public var command: String
  public var description: String
  public var dryRun: Bool
  public var files: [RaviJSON]
  public var force: Bool
  public var id: String
  public var manifest: [String: RaviJSON]
  public var manifestPath: String
  public var name: String
  public var nextCommands: [String]
  public var skill: RaviJSON
  public var skillPath: RaviJSON
  public var specPath: RaviJSON

  public init(builder: RaviJSON, cliPath: RaviJSON, command: String, description: String, dryRun: Bool, files: [RaviJSON], force: Bool, id: String, manifest: [String: RaviJSON], manifestPath: String, name: String, nextCommands: [String], skill: RaviJSON, skillPath: RaviJSON, specPath: RaviJSON) {
    self.builder = builder
    self.cliPath = cliPath
    self.command = command
    self.description = description
    self.dryRun = dryRun
    self.files = files
    self.force = force
    self.id = id
    self.manifest = manifest
    self.manifestPath = manifestPath
    self.name = name
    self.nextCommands = nextCommands
    self.skill = skill
    self.skillPath = skillPath
    self.specPath = specPath
  }

  enum CodingKeys: String, CodingKey {
    case builder = "builder"
    case cliPath = "cliPath"
    case command = "command"
    case description = "description"
    case dryRun = "dryRun"
    case files = "files"
    case force = "force"
    case id = "id"
    case manifest = "manifest"
    case manifestPath = "manifestPath"
    case name = "name"
    case nextCommands = "nextCommands"
    case skill = "skill"
    case skillPath = "skillPath"
    case specPath = "specPath"
  }
}

public struct AppsShowReturn: Codable, Sendable {
  public var app: RaviJSON

  public init(app: RaviJSON) {
    self.app = app
  }

  enum CodingKeys: String, CodingKey {
    case app = "app"
  }
}

public struct ArtifactsArchiveReturn: Codable, Sendable {
  public var success: Bool

  public init(success: Bool) {
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case success = "success"
  }
}

public struct ArtifactsAttachOptions: Codable, Sendable {
  public var metadata: String?
  public var relation: String?

  public init(metadata: String? = nil, relation: String? = nil) {
    self.metadata = metadata
    self.relation = relation
  }

  enum CodingKeys: String, CodingKey {
    case metadata = "metadata"
    case relation = "relation"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.metadata {
      body["metadata"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.relation {
      body["relation"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ArtifactsAttachReturn: Codable, Sendable {
  public var success: Bool

  public init(success: Bool) {
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case success = "success"
  }
}

public typealias ArtifactsBlobReturn = RaviBinaryResponse

public struct ArtifactsCreateOptions: Codable, Sendable {
  public var assetBase: String?
  public var basePath: String?
  public var command: String?
  public var costUsd: String?
  public var durationMs: String?
  public var entrypoint: String?
  public var input: String?
  public var inputTokens: String?
  public var kind: String?
  public var lineage: String?
  public var message: String?
  public var metadata: String?
  public var metrics: String?
  public var mime: String?
  public var model: String?
  public var output: String?
  public var outputTokens: String?
  public var path: String?
  public var prompt: String?
  public var provider: String?
  public var session: String?
  public var summary: String?
  public var tags: String?
  public var task: String?
  public var title: String?
  public var totalTokens: String?
  public var uri: String?

  public init(assetBase: String? = nil, basePath: String? = nil, command: String? = nil, costUsd: String? = nil, durationMs: String? = nil, entrypoint: String? = nil, input: String? = nil, inputTokens: String? = nil, kind: String? = nil, lineage: String? = nil, message: String? = nil, metadata: String? = nil, metrics: String? = nil, mime: String? = nil, model: String? = nil, output: String? = nil, outputTokens: String? = nil, path: String? = nil, prompt: String? = nil, provider: String? = nil, session: String? = nil, summary: String? = nil, tags: String? = nil, task: String? = nil, title: String? = nil, totalTokens: String? = nil, uri: String? = nil) {
    self.assetBase = assetBase
    self.basePath = basePath
    self.command = command
    self.costUsd = costUsd
    self.durationMs = durationMs
    self.entrypoint = entrypoint
    self.input = input
    self.inputTokens = inputTokens
    self.kind = kind
    self.lineage = lineage
    self.message = message
    self.metadata = metadata
    self.metrics = metrics
    self.mime = mime
    self.model = model
    self.output = output
    self.outputTokens = outputTokens
    self.path = path
    self.prompt = prompt
    self.provider = provider
    self.session = session
    self.summary = summary
    self.tags = tags
    self.task = task
    self.title = title
    self.totalTokens = totalTokens
    self.uri = uri
  }

  enum CodingKeys: String, CodingKey {
    case assetBase = "assetBase"
    case basePath = "basePath"
    case command = "command"
    case costUsd = "costUsd"
    case durationMs = "durationMs"
    case entrypoint = "entrypoint"
    case input = "input"
    case inputTokens = "inputTokens"
    case kind = "kind"
    case lineage = "lineage"
    case message = "message"
    case metadata = "metadata"
    case metrics = "metrics"
    case mime = "mime"
    case model = "model"
    case output = "output"
    case outputTokens = "outputTokens"
    case path = "path"
    case prompt = "prompt"
    case provider = "provider"
    case session = "session"
    case summary = "summary"
    case tags = "tags"
    case task = "task"
    case title = "title"
    case totalTokens = "totalTokens"
    case uri = "uri"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.assetBase {
      body["assetBase"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.basePath {
      body["basePath"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.command {
      body["command"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.costUsd {
      body["costUsd"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.durationMs {
      body["durationMs"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.entrypoint {
      body["entrypoint"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.input {
      body["input"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.inputTokens {
      body["inputTokens"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.lineage {
      body["lineage"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metadata {
      body["metadata"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metrics {
      body["metrics"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mime {
      body["mime"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.output {
      body["output"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.outputTokens {
      body["outputTokens"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.path {
      body["path"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.prompt {
      body["prompt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.summary {
      body["summary"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tags {
      body["tags"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.totalTokens {
      body["totalTokens"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.uri {
      body["uri"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ArtifactsCreateReturn: Codable, Sendable {
  public var artifact: [String: RaviJSON]
  public var package: [String: RaviJSON]?
  public var success: Bool
  public var version: [String: RaviJSON]?

  public init(artifact: [String: RaviJSON], package: [String: RaviJSON]? = nil, success: Bool, version: [String: RaviJSON]? = nil) {
    self.artifact = artifact
    self.package = package
    self.success = success
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case package = "package"
    case success = "success"
    case version = "version"
  }
}

public struct ArtifactsEventOptions: Codable, Sendable {
  public var message: String?
  public var payload: String?
  public var source: String?
  public var status: String?

  public init(message: String? = nil, payload: String? = nil, source: String? = nil, status: String? = nil) {
    self.message = message
    self.payload = payload
    self.source = source
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case message = "message"
    case payload = "payload"
    case source = "source"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.payload {
      body["payload"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ArtifactsEventReturn: Codable, Sendable {
  public var artifact: [String: RaviJSON]?
  public var event: [String: RaviJSON]
  public var success: Bool

  public init(artifact: [String: RaviJSON]? = nil, event: [String: RaviJSON], success: Bool) {
    self.artifact = artifact
    self.event = event
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case event = "event"
    case success = "success"
  }
}

public struct ArtifactsEventsReturn: Codable, Sendable {
  public var artifactId: String
  public var events: [[String: RaviJSON]]
  public var total: Double

  public init(artifactId: String, events: [[String: RaviJSON]], total: Double) {
    self.artifactId = artifactId
    self.events = events
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case artifactId = "artifactId"
    case events = "events"
    case total = "total"
  }
}

public struct ArtifactsListOptions: Codable, Sendable {
  public var agent: String?
  public var fields: String?
  public var includeDeleted: Bool?
  public var kind: String?
  public var lifecycle: String?
  public var limit: String?
  public var offset: String?
  public var orderBy: String?
  public var rich: Bool?
  public var session: String?
  public var tag: String?
  public var task: String?

  public init(agent: String? = nil, fields: String? = nil, includeDeleted: Bool? = nil, kind: String? = nil, lifecycle: String? = nil, limit: String? = nil, offset: String? = nil, orderBy: String? = nil, rich: Bool? = nil, session: String? = nil, tag: String? = nil, task: String? = nil) {
    self.agent = agent
    self.fields = fields
    self.includeDeleted = includeDeleted
    self.kind = kind
    self.lifecycle = lifecycle
    self.limit = limit
    self.offset = offset
    self.orderBy = orderBy
    self.rich = rich
    self.session = session
    self.tag = tag
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case fields = "fields"
    case includeDeleted = "includeDeleted"
    case kind = "kind"
    case lifecycle = "lifecycle"
    case limit = "limit"
    case offset = "offset"
    case orderBy = "orderBy"
    case rich = "rich"
    case session = "session"
    case tag = "tag"
    case task = "task"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeDeleted {
      body["includeDeleted"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.lifecycle {
      body["lifecycle"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.orderBy {
      body["orderBy"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.rich {
      body["rich"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ArtifactsListReturn = RaviJSON

public struct ArtifactsPublishOptions: Codable, Sendable {
  public var artifactVersion: String?
  public var assetBase: String?
  public var basePath: String?
  public var console: String?
  public var description: String?
  public var entrypoint: String?
  public var execute: Bool?
  public var idempotencyKey: String?
  public var name: String?
  public var noActivate: Bool?
  public var project: String?
  public var reason: String?
  public var replaceRelease: Bool?
  public var route: String?
  public var site: String?
  public var slug: String?
  public var uploadSession: String?
  public var visibility: String?

  public init(artifactVersion: String? = nil, assetBase: String? = nil, basePath: String? = nil, console: String? = nil, description: String? = nil, entrypoint: String? = nil, execute: Bool? = nil, idempotencyKey: String? = nil, name: String? = nil, noActivate: Bool? = nil, project: String? = nil, reason: String? = nil, replaceRelease: Bool? = nil, route: String? = nil, site: String? = nil, slug: String? = nil, uploadSession: String? = nil, visibility: String? = nil) {
    self.artifactVersion = artifactVersion
    self.assetBase = assetBase
    self.basePath = basePath
    self.console = console
    self.description = description
    self.entrypoint = entrypoint
    self.execute = execute
    self.idempotencyKey = idempotencyKey
    self.name = name
    self.noActivate = noActivate
    self.project = project
    self.reason = reason
    self.replaceRelease = replaceRelease
    self.route = route
    self.site = site
    self.slug = slug
    self.uploadSession = uploadSession
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case artifactVersion = "artifactVersion"
    case assetBase = "assetBase"
    case basePath = "basePath"
    case console = "console"
    case description = "description"
    case entrypoint = "entrypoint"
    case execute = "execute"
    case idempotencyKey = "idempotencyKey"
    case name = "name"
    case noActivate = "noActivate"
    case project = "project"
    case reason = "reason"
    case replaceRelease = "replaceRelease"
    case route = "route"
    case site = "site"
    case slug = "slug"
    case uploadSession = "uploadSession"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.artifactVersion {
      body["artifactVersion"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.assetBase {
      body["assetBase"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.basePath {
      body["basePath"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.entrypoint {
      body["entrypoint"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.noActivate {
      body["noActivate"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.replaceRelease {
      body["replaceRelease"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.route {
      body["route"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.site {
      body["site"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.slug {
      body["slug"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.uploadSession {
      body["uploadSession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ArtifactsPublishReturn: Codable, Sendable {
  public var artifact: RaviJSON
  public var artifactVersion: RaviJSON
  public var authenticated: Bool
  public var consoleUrl: String
  public var localSync: RaviJSON
  public var publish: RaviJSON
  public var release: RaviJSON
  public var routes: [[String: RaviJSON]]
  public var site: RaviJSON
  public var success: Bool
  public var upload: RaviJSON
  public var uploadSession: RaviJSON
  public var url: RaviJSON

  public init(artifact: RaviJSON, artifactVersion: RaviJSON, authenticated: Bool, consoleUrl: String, localSync: RaviJSON, publish: RaviJSON, release: RaviJSON, routes: [[String: RaviJSON]], site: RaviJSON, success: Bool, upload: RaviJSON, uploadSession: RaviJSON, url: RaviJSON) {
    self.artifact = artifact
    self.artifactVersion = artifactVersion
    self.authenticated = authenticated
    self.consoleUrl = consoleUrl
    self.localSync = localSync
    self.publish = publish
    self.release = release
    self.routes = routes
    self.site = site
    self.success = success
    self.upload = upload
    self.uploadSession = uploadSession
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case artifactVersion = "artifactVersion"
    case authenticated = "authenticated"
    case consoleUrl = "consoleUrl"
    case localSync = "localSync"
    case publish = "publish"
    case release = "release"
    case routes = "routes"
    case site = "site"
    case success = "success"
    case upload = "upload"
    case uploadSession = "uploadSession"
    case url = "url"
  }
}

public struct ArtifactsReleaseActivateOptions: Codable, Sendable {
  public var console: String?
  public var execute: Bool?
  public var release: String?
  public var site: String?
  public var version: String?

  public init(console: String? = nil, execute: Bool? = nil, release: String? = nil, site: String? = nil, version: String? = nil) {
    self.console = console
    self.execute = execute
    self.release = release
    self.site = site
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case execute = "execute"
    case release = "release"
    case site = "site"
    case version = "version"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.release {
      body["release"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.site {
      body["site"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.version {
      body["version"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ArtifactsReleaseActivateReturn: Codable, Sendable {
  public var localSync: [String: RaviJSON]?
  public var release: RaviJSON
  public var routes: [RaviJSON]
  public var site: RaviJSON
  public var url: RaviJSON

  public init(localSync: [String: RaviJSON]? = nil, release: RaviJSON, routes: [RaviJSON], site: RaviJSON, url: RaviJSON) {
    self.localSync = localSync
    self.release = release
    self.routes = routes
    self.site = site
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case localSync = "localSync"
    case release = "release"
    case routes = "routes"
    case site = "site"
    case url = "url"
  }
}

public struct ArtifactsRestoreOptions: Codable, Sendable {
  public var message: String?
  public var version: String?

  public init(message: String? = nil, version: String? = nil) {
    self.message = message
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case message = "message"
    case version = "version"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.version {
      body["version"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ArtifactsRestoreReturn: Codable, Sendable {
  public var artifact: [String: RaviJSON]
  public var restoreVersion: [String: RaviJSON]
  public var restoredFrom: [String: RaviJSON]
  public var success: Bool

  public init(artifact: [String: RaviJSON], restoreVersion: [String: RaviJSON], restoredFrom: [String: RaviJSON], success: Bool) {
    self.artifact = artifact
    self.restoreVersion = restoreVersion
    self.restoredFrom = restoredFrom
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case restoreVersion = "restoreVersion"
    case restoredFrom = "restoredFrom"
    case success = "success"
  }
}

public struct ArtifactsShowReturn: Codable, Sendable {
  public var artifact: [String: RaviJSON]
  public var events: [[String: RaviJSON]]
  public var links: [[String: RaviJSON]]
  public var versions: [[String: RaviJSON]]

  public init(artifact: [String: RaviJSON], events: [[String: RaviJSON]], links: [[String: RaviJSON]], versions: [[String: RaviJSON]]) {
    self.artifact = artifact
    self.events = events
    self.links = links
    self.versions = versions
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case events = "events"
    case links = "links"
    case versions = "versions"
  }
}

public struct ArtifactsSnapshotOptions: Codable, Sendable {
  public var label: String?
  public var manifest: String?
  public var message: String?
  public var metadata: String?
  public var source: String?
  public var status: String?

  public init(label: String? = nil, manifest: String? = nil, message: String? = nil, metadata: String? = nil, source: String? = nil, status: String? = nil) {
    self.label = label
    self.manifest = manifest
    self.message = message
    self.metadata = metadata
    self.source = source
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case label = "label"
    case manifest = "manifest"
    case message = "message"
    case metadata = "metadata"
    case source = "source"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.manifest {
      body["manifest"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metadata {
      body["metadata"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ArtifactsSnapshotReturn: Codable, Sendable {
  public var success: Bool
  public var version: [String: RaviJSON]

  public init(success: Bool, version: [String: RaviJSON]) {
    self.success = success
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case success = "success"
    case version = "version"
  }
}

public struct ArtifactsUpdateOptions: Codable, Sendable {
  public var command: String?
  public var costUsd: String?
  public var durationMs: String?
  public var input: String?
  public var inputTokens: String?
  public var lineage: String?
  public var message: String?
  public var metadata: String?
  public var metrics: String?
  public var mime: String?
  public var model: String?
  public var output: String?
  public var outputTokens: String?
  public var path: String?
  public var prompt: String?
  public var provider: String?
  public var session: String?
  public var status: String?
  public var summary: String?
  public var tags: String?
  public var task: String?
  public var title: String?
  public var totalTokens: String?
  public var uri: String?

  public init(command: String? = nil, costUsd: String? = nil, durationMs: String? = nil, input: String? = nil, inputTokens: String? = nil, lineage: String? = nil, message: String? = nil, metadata: String? = nil, metrics: String? = nil, mime: String? = nil, model: String? = nil, output: String? = nil, outputTokens: String? = nil, path: String? = nil, prompt: String? = nil, provider: String? = nil, session: String? = nil, status: String? = nil, summary: String? = nil, tags: String? = nil, task: String? = nil, title: String? = nil, totalTokens: String? = nil, uri: String? = nil) {
    self.command = command
    self.costUsd = costUsd
    self.durationMs = durationMs
    self.input = input
    self.inputTokens = inputTokens
    self.lineage = lineage
    self.message = message
    self.metadata = metadata
    self.metrics = metrics
    self.mime = mime
    self.model = model
    self.output = output
    self.outputTokens = outputTokens
    self.path = path
    self.prompt = prompt
    self.provider = provider
    self.session = session
    self.status = status
    self.summary = summary
    self.tags = tags
    self.task = task
    self.title = title
    self.totalTokens = totalTokens
    self.uri = uri
  }

  enum CodingKeys: String, CodingKey {
    case command = "command"
    case costUsd = "costUsd"
    case durationMs = "durationMs"
    case input = "input"
    case inputTokens = "inputTokens"
    case lineage = "lineage"
    case message = "message"
    case metadata = "metadata"
    case metrics = "metrics"
    case mime = "mime"
    case model = "model"
    case output = "output"
    case outputTokens = "outputTokens"
    case path = "path"
    case prompt = "prompt"
    case provider = "provider"
    case session = "session"
    case status = "status"
    case summary = "summary"
    case tags = "tags"
    case task = "task"
    case title = "title"
    case totalTokens = "totalTokens"
    case uri = "uri"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.command {
      body["command"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.costUsd {
      body["costUsd"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.durationMs {
      body["durationMs"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.input {
      body["input"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.inputTokens {
      body["inputTokens"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.lineage {
      body["lineage"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metadata {
      body["metadata"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metrics {
      body["metrics"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mime {
      body["mime"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.output {
      body["output"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.outputTokens {
      body["outputTokens"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.path {
      body["path"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.prompt {
      body["prompt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.summary {
      body["summary"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tags {
      body["tags"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.totalTokens {
      body["totalTokens"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.uri {
      body["uri"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ArtifactsUpdateReturn: Codable, Sendable {
  public var success: Bool

  public init(success: Bool) {
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case success = "success"
  }
}

public struct ArtifactsVersionOptions: Codable, Sendable {
  public var version: String?

  public init(version: String? = nil) {
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case version = "version"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.version {
      body["version"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ArtifactsVersionReturn: Codable, Sendable {
  public var artifactId: String
  public var version: [String: RaviJSON]

  public init(artifactId: String, version: [String: RaviJSON]) {
    self.artifactId = artifactId
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case artifactId = "artifactId"
    case version = "version"
  }
}

public struct ArtifactsVersionsReturn: Codable, Sendable {
  public var artifactId: String
  public var total: Double
  public var versions: [[String: RaviJSON]]

  public init(artifactId: String, total: Double, versions: [[String: RaviJSON]]) {
    self.artifactId = artifactId
    self.total = total
    self.versions = versions
  }

  enum CodingKeys: String, CodingKey {
    case artifactId = "artifactId"
    case total = "total"
    case versions = "versions"
  }
}

public typealias AudioBlobReturn = RaviBinaryResponse

public struct AudioGenerateOptions: Codable, Sendable {
  public var caption: String?
  public var execute: Bool?
  public var format: String?
  public var lang: String?
  public var model: String?
  public var output: String?
  public var send: Bool?
  public var speed: String?
  public var textFile: String?
  public var voice: String?

  public init(caption: String? = nil, execute: Bool? = nil, format: String? = nil, lang: String? = nil, model: String? = nil, output: String? = nil, send: Bool? = nil, speed: String? = nil, textFile: String? = nil, voice: String? = nil) {
    self.caption = caption
    self.execute = execute
    self.format = format
    self.lang = lang
    self.model = model
    self.output = output
    self.send = send
    self.speed = speed
    self.textFile = textFile
    self.voice = voice
  }

  enum CodingKeys: String, CodingKey {
    case caption = "caption"
    case execute = "execute"
    case format = "format"
    case lang = "lang"
    case model = "model"
    case output = "output"
    case send = "send"
    case speed = "speed"
    case textFile = "textFile"
    case voice = "voice"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.caption {
      body["caption"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.format {
      body["format"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.lang {
      body["lang"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.output {
      body["output"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.send {
      body["send"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.speed {
      body["speed"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.textFile {
      body["textFile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.voice {
      body["voice"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AudioGenerateReturn: Codable, Sendable {
  public var audio: RaviJSON
  public var options: [String: RaviJSON]
  public var sent: RaviJSON?
  public var success: Bool

  public init(audio: RaviJSON, options: [String: RaviJSON], sent: RaviJSON? = nil, success: Bool) {
    self.audio = audio
    self.options = options
    self.sent = sent
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case audio = "audio"
    case options = "options"
    case sent = "sent"
    case success = "success"
  }
}

public struct AudioPendingOptions: Codable, Sendable {
  public var agent: String?
  public var chat: String?
  public var clientId: String?
  public var fields: String?
  public var id: String?
  public var includeFailed: Bool?
  public var limit: String?
  public var requestId: String?
  public var session: String?
  public var sessionKey: String?
  public var since: String?

  public init(agent: String? = nil, chat: String? = nil, clientId: String? = nil, fields: String? = nil, id: String? = nil, includeFailed: Bool? = nil, limit: String? = nil, requestId: String? = nil, session: String? = nil, sessionKey: String? = nil, since: String? = nil) {
    self.agent = agent
    self.chat = chat
    self.clientId = clientId
    self.fields = fields
    self.id = id
    self.includeFailed = includeFailed
    self.limit = limit
    self.requestId = requestId
    self.session = session
    self.sessionKey = sessionKey
    self.since = since
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case chat = "chat"
    case clientId = "clientId"
    case fields = "fields"
    case id = "id"
    case includeFailed = "includeFailed"
    case limit = "limit"
    case requestId = "requestId"
    case session = "session"
    case sessionKey = "sessionKey"
    case since = "since"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.chat {
      body["chat"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.clientId {
      body["clientId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.id {
      body["id"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeFailed {
      body["includeFailed"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.requestId {
      body["requestId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sessionKey {
      body["sessionKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.since {
      body["since"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AudioPendingReturn: Codable, Sendable {
  public var generatedAt: Double
  public var items: [RaviJSON]
  public var ok: Bool

  public init(generatedAt: Double, items: [RaviJSON], ok: Bool) {
    self.generatedAt = generatedAt
    self.items = items
    self.ok = ok
  }

  enum CodingKeys: String, CodingKey {
    case generatedAt = "generatedAt"
    case items = "items"
    case ok = "ok"
  }
}

public struct AudioTtsOptions: Codable, Sendable {
  public var account: String?
  public var agent: String?
  public var channel: String?
  public var chat: String?
  public var clientId: String?
  public var elevenlabs: String?
  public var execute: Bool?
  public var format: String?
  public var id: String?
  public var lang: String?
  public var model: String?
  public var noAutoplay: Bool?
  public var session: String?
  public var sessionKey: String?
  public var speed: String?
  public var voice: String?
  public var voiceSettings: String?

  public init(account: String? = nil, agent: String? = nil, channel: String? = nil, chat: String? = nil, clientId: String? = nil, elevenlabs: String? = nil, execute: Bool? = nil, format: String? = nil, id: String? = nil, lang: String? = nil, model: String? = nil, noAutoplay: Bool? = nil, session: String? = nil, sessionKey: String? = nil, speed: String? = nil, voice: String? = nil, voiceSettings: String? = nil) {
    self.account = account
    self.agent = agent
    self.channel = channel
    self.chat = chat
    self.clientId = clientId
    self.elevenlabs = elevenlabs
    self.execute = execute
    self.format = format
    self.id = id
    self.lang = lang
    self.model = model
    self.noAutoplay = noAutoplay
    self.session = session
    self.sessionKey = sessionKey
    self.speed = speed
    self.voice = voice
    self.voiceSettings = voiceSettings
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case agent = "agent"
    case channel = "channel"
    case chat = "chat"
    case clientId = "clientId"
    case elevenlabs = "elevenlabs"
    case execute = "execute"
    case format = "format"
    case id = "id"
    case lang = "lang"
    case model = "model"
    case noAutoplay = "noAutoplay"
    case session = "session"
    case sessionKey = "sessionKey"
    case speed = "speed"
    case voice = "voice"
    case voiceSettings = "voiceSettings"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.chat {
      body["chat"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.clientId {
      body["clientId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.elevenlabs {
      body["elevenlabs"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.format {
      body["format"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.id {
      body["id"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.lang {
      body["lang"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.noAutoplay {
      body["noAutoplay"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sessionKey {
      body["sessionKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.speed {
      body["speed"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.voice {
      body["voice"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.voiceSettings {
      body["voiceSettings"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AudioTtsReturn: Codable, Sendable {
  public var ok: Bool
  public var request: RaviJSON
  public var topic: String

  public init(ok: Bool, request: RaviJSON, topic: String) {
    self.ok = ok
    self.request = request
    self.topic = topic
  }

  enum CodingKeys: String, CodingKey {
    case ok = "ok"
    case request = "request"
    case topic = "topic"
  }
}

public struct AudioVoicesOptions: Codable, Sendable {
  public var category: String?
  public var fields: String?
  public var limit: String?
  public var search: String?
  public var voiceType: String?

  public init(category: String? = nil, fields: String? = nil, limit: String? = nil, search: String? = nil, voiceType: String? = nil) {
    self.category = category
    self.fields = fields
    self.limit = limit
    self.search = search
    self.voiceType = voiceType
  }

  enum CodingKeys: String, CodingKey {
    case category = "category"
    case fields = "fields"
    case limit = "limit"
    case search = "search"
    case voiceType = "voiceType"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.category {
      body["category"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.search {
      body["search"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.voiceType {
      body["voiceType"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct AudioVoicesReturn: Codable, Sendable {
  public var generatedAt: Double
  public var hasMore: Bool
  public var nextPageToken: String?
  public var ok: Bool
  public var provider: String
  public var totalCount: Double?
  public var voices: [RaviJSON]

  public init(generatedAt: Double, hasMore: Bool, nextPageToken: String? = nil, ok: Bool, provider: String, totalCount: Double? = nil, voices: [RaviJSON]) {
    self.generatedAt = generatedAt
    self.hasMore = hasMore
    self.nextPageToken = nextPageToken
    self.ok = ok
    self.provider = provider
    self.totalCount = totalCount
    self.voices = voices
  }

  enum CodingKeys: String, CodingKey {
    case generatedAt = "generatedAt"
    case hasMore = "hasMore"
    case nextPageToken = "nextPageToken"
    case ok = "ok"
    case provider = "provider"
    case totalCount = "totalCount"
    case voices = "voices"
  }
}

public struct BridgesCreateOptions: Codable, Sendable {
  public var allow: String?
  public var console: String?
  public var description: String?
  public var name: String?
  public var project: String?
  public var session: String?

  public init(allow: String? = nil, console: String? = nil, description: String? = nil, name: String? = nil, project: String? = nil, session: String? = nil) {
    self.allow = allow
    self.console = console
    self.description = description
    self.name = name
    self.project = project
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case allow = "allow"
    case console = "console"
    case description = "description"
    case name = "name"
    case project = "project"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.allow {
      body["allow"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct BridgesCreateReturn: Codable, Sendable {
  public var bridge: [String: RaviJSON]
  public var bridgeToken: RaviJSON
  public var bridgeUrl: RaviJSON
  public var consoleUrl: String
  public var projectRef: String
  public var success: Bool

  public init(bridge: [String: RaviJSON], bridgeToken: RaviJSON, bridgeUrl: RaviJSON, consoleUrl: String, projectRef: String, success: Bool) {
    self.bridge = bridge
    self.bridgeToken = bridgeToken
    self.bridgeUrl = bridgeUrl
    self.consoleUrl = consoleUrl
    self.projectRef = projectRef
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case bridge = "bridge"
    case bridgeToken = "bridgeToken"
    case bridgeUrl = "bridgeUrl"
    case consoleUrl = "consoleUrl"
    case projectRef = "projectRef"
    case success = "success"
  }
}

public struct BridgesListOptions: Codable, Sendable {
  public var console: String?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var project: String?

  public init(console: String? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, project: String? = nil) {
    self.console = console
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.project = project
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case project = "project"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct BridgesListReturn: Codable, Sendable {
  public var bridges: [[String: RaviJSON]]
  public var consoleUrl: String
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var projectRef: String
  public var success: Bool
  public var total: Double

  public init(bridges: [[String: RaviJSON]], consoleUrl: String, items: [[String: RaviJSON]], pagination: RaviJSON, projectRef: String, success: Bool, total: Double) {
    self.bridges = bridges
    self.consoleUrl = consoleUrl
    self.items = items
    self.pagination = pagination
    self.projectRef = projectRef
    self.success = success
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case bridges = "bridges"
    case consoleUrl = "consoleUrl"
    case items = "items"
    case pagination = "pagination"
    case projectRef = "projectRef"
    case success = "success"
    case total = "total"
  }
}

public struct BridgesRevokeOptions: Codable, Sendable {
  public var console: String?
  public var execute: Bool?
  public var yes: Bool?

  public init(console: String? = nil, execute: Bool? = nil, yes: Bool? = nil) {
    self.console = console
    self.execute = execute
    self.yes = yes
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case execute = "execute"
    case yes = "yes"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.yes {
      body["yes"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct BridgesRevokeReturn: Codable, Sendable {
  public var bridgeId: String
  public var consoleUrl: String
  public var revoked: Bool
  public var success: Bool

  public init(bridgeId: String, consoleUrl: String, revoked: Bool, success: Bool) {
    self.bridgeId = bridgeId
    self.consoleUrl = consoleUrl
    self.revoked = revoked
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case bridgeId = "bridgeId"
    case consoleUrl = "consoleUrl"
    case revoked = "revoked"
    case success = "success"
  }
}

public struct CalendarsAvailabilityOptions: Codable, Sendable {
  public var calendar: String?
  public var fields: String?
  public var from: String?
  public var limit: String?
  public var to: String?

  public init(calendar: String? = nil, fields: String? = nil, from: String? = nil, limit: String? = nil, to: String? = nil) {
    self.calendar = calendar
    self.fields = fields
    self.from = from
    self.limit = limit
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case calendar = "calendar"
    case fields = "fields"
    case from = "from"
    case limit = "limit"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.calendar {
      body["calendar"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.from {
      body["from"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsAvailabilityReturn: Codable, Sendable {
  public var busy: [RaviJSON]
  public var window: RaviJSON

  public init(busy: [RaviJSON], window: RaviJSON) {
    self.busy = busy
    self.window = window
  }

  enum CodingKeys: String, CodingKey {
    case busy = "busy"
    case window = "window"
  }
}

public struct CalendarsCreateOptions: Codable, Sendable {
  public var account: String?
  public var color: String?
  public var default_: Bool?
  public var description: String?
  public var name: String?
  public var owner: String?
  public var providerCalendarId: String?
  public var role: String?
  public var timezone: String?
  public var visibility: String?

  public init(account: String? = nil, color: String? = nil, default_: Bool? = nil, description: String? = nil, name: String? = nil, owner: String? = nil, providerCalendarId: String? = nil, role: String? = nil, timezone: String? = nil, visibility: String? = nil) {
    self.account = account
    self.color = color
    self.default_ = default_
    self.description = description
    self.name = name
    self.owner = owner
    self.providerCalendarId = providerCalendarId
    self.role = role
    self.timezone = timezone
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case color = "color"
    case default_ = "default"
    case description = "description"
    case name = "name"
    case owner = "owner"
    case providerCalendarId = "providerCalendarId"
    case role = "role"
    case timezone = "timezone"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.color {
      body["color"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.default_ {
      body["default"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.providerCalendarId {
      body["providerCalendarId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.timezone {
      body["timezone"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsCreateReturn: Codable, Sendable {
  public var calendar: RaviJSON

  public init(calendar: RaviJSON) {
    self.calendar = calendar
  }

  enum CodingKeys: String, CodingKey {
    case calendar = "calendar"
  }
}

public struct CalendarsDisableReturn: Codable, Sendable {
  public var calendar: RaviJSON

  public init(calendar: RaviJSON) {
    self.calendar = calendar
  }

  enum CodingKeys: String, CodingKey {
    case calendar = "calendar"
  }
}

public struct CalendarsEventsCancelOptions: Codable, Sendable {
  public var execute: Bool?
  public var idempotencyKey: String?

  public init(execute: Bool? = nil, idempotencyKey: String? = nil) {
    self.execute = execute
    self.idempotencyKey = idempotencyKey
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case idempotencyKey = "idempotencyKey"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsEventsCancelReturn: Codable, Sendable {
  public var event: RaviJSON
  public var outbox: RaviJSON

  public init(event: RaviJSON, outbox: RaviJSON) {
    self.event = event
    self.outbox = outbox
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case outbox = "outbox"
  }
}

public struct CalendarsEventsCreateOptions: Codable, Sendable {
  public var attendee: String?
  public var calendar: String?
  public var description: String?
  public var end: String?
  public var idempotencyKey: String?
  public var location: String?
  public var start: String?
  public var timezone: String?
  public var title: String?

  public init(attendee: String? = nil, calendar: String? = nil, description: String? = nil, end: String? = nil, idempotencyKey: String? = nil, location: String? = nil, start: String? = nil, timezone: String? = nil, title: String? = nil) {
    self.attendee = attendee
    self.calendar = calendar
    self.description = description
    self.end = end
    self.idempotencyKey = idempotencyKey
    self.location = location
    self.start = start
    self.timezone = timezone
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case attendee = "attendee"
    case calendar = "calendar"
    case description = "description"
    case end = "end"
    case idempotencyKey = "idempotencyKey"
    case location = "location"
    case start = "start"
    case timezone = "timezone"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.attendee {
      body["attendee"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.calendar {
      body["calendar"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.end {
      body["end"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.location {
      body["location"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.start {
      body["start"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.timezone {
      body["timezone"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsEventsCreateReturn: Codable, Sendable {
  public var event: RaviJSON
  public var outbox: RaviJSON

  public init(event: RaviJSON, outbox: RaviJSON) {
    self.event = event
    self.outbox = outbox
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case outbox = "outbox"
  }
}

public struct CalendarsEventsListOptions: Codable, Sendable {
  public var calendar: String?
  public var fields: String?
  public var from: String?
  public var includeCancelled: Bool?
  public var limit: String?
  public var offset: String?
  public var query: String?
  public var status: String?
  public var to: String?

  public init(calendar: String? = nil, fields: String? = nil, from: String? = nil, includeCancelled: Bool? = nil, limit: String? = nil, offset: String? = nil, query: String? = nil, status: String? = nil, to: String? = nil) {
    self.calendar = calendar
    self.fields = fields
    self.from = from
    self.includeCancelled = includeCancelled
    self.limit = limit
    self.offset = offset
    self.query = query
    self.status = status
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case calendar = "calendar"
    case fields = "fields"
    case from = "from"
    case includeCancelled = "includeCancelled"
    case limit = "limit"
    case offset = "offset"
    case query = "query"
    case status = "status"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.calendar {
      body["calendar"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.from {
      body["from"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeCancelled {
      body["includeCancelled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.query {
      body["query"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsEventsListReturn: Codable, Sendable {
  public var events: [RaviJSON]
  public var window: RaviJSON

  public init(events: [RaviJSON], window: RaviJSON) {
    self.events = events
    self.window = window
  }

  enum CodingKeys: String, CodingKey {
    case events = "events"
    case window = "window"
  }
}

public struct CalendarsEventsReadReturn: Codable, Sendable {
  public var event: RaviJSON

  public init(event: RaviJSON) {
    self.event = event
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
  }
}

public struct CalendarsEventsRespondOptions: Codable, Sendable {
  public var attendeeAgent: String?
  public var attendeeEmail: String?
  public var execute: Bool?
  public var idempotencyKey: String?
  public var status: String?

  public init(attendeeAgent: String? = nil, attendeeEmail: String? = nil, execute: Bool? = nil, idempotencyKey: String? = nil, status: String? = nil) {
    self.attendeeAgent = attendeeAgent
    self.attendeeEmail = attendeeEmail
    self.execute = execute
    self.idempotencyKey = idempotencyKey
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case attendeeAgent = "attendeeAgent"
    case attendeeEmail = "attendeeEmail"
    case execute = "execute"
    case idempotencyKey = "idempotencyKey"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.attendeeAgent {
      body["attendeeAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.attendeeEmail {
      body["attendeeEmail"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsEventsRespondReturn: Codable, Sendable {
  public var event: RaviJSON
  public var outbox: RaviJSON

  public init(event: RaviJSON, outbox: RaviJSON) {
    self.event = event
    self.outbox = outbox
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case outbox = "outbox"
  }
}

public struct CalendarsEventsUpdateOptions: Codable, Sendable {
  public var busy: String?
  public var description: String?
  public var end: String?
  public var idempotencyKey: String?
  public var location: String?
  public var start: String?
  public var status: String?
  public var title: String?
  public var visibility: String?

  public init(busy: String? = nil, description: String? = nil, end: String? = nil, idempotencyKey: String? = nil, location: String? = nil, start: String? = nil, status: String? = nil, title: String? = nil, visibility: String? = nil) {
    self.busy = busy
    self.description = description
    self.end = end
    self.idempotencyKey = idempotencyKey
    self.location = location
    self.start = start
    self.status = status
    self.title = title
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case busy = "busy"
    case description = "description"
    case end = "end"
    case idempotencyKey = "idempotencyKey"
    case location = "location"
    case start = "start"
    case status = "status"
    case title = "title"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.busy {
      body["busy"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.end {
      body["end"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.location {
      body["location"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.start {
      body["start"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsEventsUpdateReturn: Codable, Sendable {
  public var event: RaviJSON
  public var outbox: RaviJSON

  public init(event: RaviJSON, outbox: RaviJSON) {
    self.event = event
    self.outbox = outbox
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case outbox = "outbox"
  }
}

public struct CalendarsListOptions: Codable, Sendable {
  public var account: String?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var status: String?

  public init(account: String? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, status: String? = nil) {
    self.account = account
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsListReturn: Codable, Sendable {
  public var calendars: [RaviJSON]

  public init(calendars: [RaviJSON]) {
    self.calendars = calendars
  }

  enum CodingKeys: String, CodingKey {
    case calendars = "calendars"
  }
}

public struct CalendarsShareOptions: Codable, Sendable {
  public var execute: Bool?
  public var expiresAt: String?
  public var relation: String?
  public var with: String?

  public init(execute: Bool? = nil, expiresAt: String? = nil, relation: String? = nil, with: String? = nil) {
    self.execute = execute
    self.expiresAt = expiresAt
    self.relation = relation
    self.with = with
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case expiresAt = "expiresAt"
    case relation = "relation"
    case with = "with"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.expiresAt {
      body["expiresAt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.relation {
      body["relation"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.with {
      body["with"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsShareReturn: Codable, Sendable {
  public var calendar: RaviJSON
  public var member: RaviJSON

  public init(calendar: RaviJSON, member: RaviJSON) {
    self.calendar = calendar
    self.member = member
  }

  enum CodingKeys: String, CodingKey {
    case calendar = "calendar"
    case member = "member"
  }
}

public struct CalendarsShowOptions: Codable, Sendable {
  public var members: Bool?

  public init(members: Bool? = nil) {
    self.members = members
  }

  enum CodingKeys: String, CodingKey {
    case members = "members"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.members {
      body["members"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CalendarsShowReturn: Codable, Sendable {
  public var calendar: RaviJSON
  public var members: [RaviJSON]?

  public init(calendar: RaviJSON, members: [RaviJSON]? = nil) {
    self.calendar = calendar
    self.members = members
  }

  enum CodingKeys: String, CodingKey {
    case calendar = "calendar"
    case members = "members"
  }
}

public struct ChannelsBackendIngressReturn: Codable, Sendable {
  public var acceptedAt: String
  public var binding: RaviJSON?
  public var disposition: String
  public var error: RaviJSON?
  public var protocol_: String
  public var requestId: String
  public var schemaVersion: Int

  public init(acceptedAt: String, binding: RaviJSON? = nil, disposition: String, error: RaviJSON? = nil, protocol_: String, requestId: String, schemaVersion: Int) {
    self.acceptedAt = acceptedAt
    self.binding = binding
    self.disposition = disposition
    self.error = error
    self.protocol_ = protocol_
    self.requestId = requestId
    self.schemaVersion = schemaVersion
  }

  enum CodingKeys: String, CodingKey {
    case acceptedAt = "acceptedAt"
    case binding = "binding"
    case disposition = "disposition"
    case error = "error"
    case protocol_ = "protocol"
    case requestId = "requestId"
    case schemaVersion = "schemaVersion"
  }
}

public struct ChannelsBackendRuntimeInterruptReturn: Codable, Sendable {
  public var acceptedAt: String
  public var disposition: String
  public var error: RaviJSON?
  public var protocol_: String
  public var requestId: String
  public var schemaVersion: Int

  public init(acceptedAt: String, disposition: String, error: RaviJSON? = nil, protocol_: String, requestId: String, schemaVersion: Int) {
    self.acceptedAt = acceptedAt
    self.disposition = disposition
    self.error = error
    self.protocol_ = protocol_
    self.requestId = requestId
    self.schemaVersion = schemaVersion
  }

  enum CodingKeys: String, CodingKey {
    case acceptedAt = "acceptedAt"
    case disposition = "disposition"
    case error = "error"
    case protocol_ = "protocol"
    case requestId = "requestId"
    case schemaVersion = "schemaVersion"
  }
}

public struct ChannelsBackendRuntimeReadbackReturn: Codable, Sendable {
  public var assistantMessageId: String?
  public var binding: RaviJSON
  public var lastEventRuntimeGenerationId: String?
  public var lastSequence: Int
  public var observedAt: String
  public var protocol_: String
  public var requestId: String
  public var runtimeGenerationId: String?
  public var schemaVersion: Int
  public var state: String
  public var terminalEvent: RaviJSON?

  public init(assistantMessageId: String? = nil, binding: RaviJSON, lastEventRuntimeGenerationId: String? = nil, lastSequence: Int, observedAt: String, protocol_: String, requestId: String, runtimeGenerationId: String? = nil, schemaVersion: Int, state: String, terminalEvent: RaviJSON? = nil) {
    self.assistantMessageId = assistantMessageId
    self.binding = binding
    self.lastEventRuntimeGenerationId = lastEventRuntimeGenerationId
    self.lastSequence = lastSequence
    self.observedAt = observedAt
    self.protocol_ = protocol_
    self.requestId = requestId
    self.runtimeGenerationId = runtimeGenerationId
    self.schemaVersion = schemaVersion
    self.state = state
    self.terminalEvent = terminalEvent
  }

  enum CodingKeys: String, CodingKey {
    case assistantMessageId = "assistantMessageId"
    case binding = "binding"
    case lastEventRuntimeGenerationId = "lastEventRuntimeGenerationId"
    case lastSequence = "lastSequence"
    case observedAt = "observedAt"
    case protocol_ = "protocol"
    case requestId = "requestId"
    case runtimeGenerationId = "runtimeGenerationId"
    case schemaVersion = "schemaVersion"
    case state = "state"
    case terminalEvent = "terminalEvent"
  }
}

public struct ChannelsCreateOptions: Codable, Sendable {
  public var credentialConnection: String?
  public var provider: String?

  public init(credentialConnection: String? = nil, provider: String? = nil) {
    self.credentialConnection = credentialConnection
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case credentialConnection = "credentialConnection"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.credentialConnection {
      body["credentialConnection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ChannelsCreateReturn: Codable, Sendable {
  public var changedCount: Double
  public var channel: RaviJSON
  public var status: String

  public init(changedCount: Double, channel: RaviJSON, status: String) {
    self.changedCount = changedCount
    self.channel = channel
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case channel = "channel"
    case status = "status"
  }
}

public struct ChannelsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var provider: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, provider: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ChannelsListReturn: Codable, Sendable {
  public var channels: [RaviJSON]
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var total: Double

  public init(channels: [RaviJSON], items: [RaviJSON], pagination: RaviJSON, total: Double) {
    self.channels = channels
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case channels = "channels"
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct ChannelsProbeReturn: Codable, Sendable {
  public var adapters: [[String: RaviJSON]]
  public var outbound: [String: RaviJSON]
  public var pid: Double
  public var running: Bool
  public var startedAt: RaviJSON

  public init(adapters: [[String: RaviJSON]], outbound: [String: RaviJSON], pid: Double, running: Bool, startedAt: RaviJSON) {
    self.adapters = adapters
    self.outbound = outbound
    self.pid = pid
    self.running = running
    self.startedAt = startedAt
  }

  enum CodingKeys: String, CodingKey {
    case adapters = "adapters"
    case outbound = "outbound"
    case pid = "pid"
    case running = "running"
    case startedAt = "startedAt"
  }
}

public struct ChannelsRestartOptions: Codable, Sendable {
  public var build: Bool?

  public init(build: Bool? = nil) {
    self.build = build
  }

  enum CodingKeys: String, CodingKey {
    case build = "build"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.build {
      body["build"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ChannelsRestartReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool
  public var pm2Status: RaviJSON?
  public var reason: String?
  public var runnerEnv: RaviJSON?
  public var status: RaviJSON?
  public var target: RaviJSON?

  public init(action: String, changed: Bool, pm2Status: RaviJSON? = nil, reason: String? = nil, runnerEnv: RaviJSON? = nil, status: RaviJSON? = nil, target: RaviJSON? = nil) {
    self.action = action
    self.changed = changed
    self.pm2Status = pm2Status
    self.reason = reason
    self.runnerEnv = runnerEnv
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
    case pm2Status = "pm2Status"
    case reason = "reason"
    case runnerEnv = "runnerEnv"
    case status = "status"
    case target = "target"
  }
}

public struct ChannelsSetReturn: Codable, Sendable {
  public var changedCount: Double
  public var channel: RaviJSON
  public var status: String

  public init(changedCount: Double, channel: RaviJSON, status: String) {
    self.changedCount = changedCount
    self.channel = channel
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case channel = "channel"
    case status = "status"
  }
}

public struct ChannelsShowReturn: Codable, Sendable {
  public var createdAt: Double
  public var credentialConnection: String?
  public var defaults: [String: RaviJSON]?
  public var deletedAt: Double?
  public var enabled: Bool?
  public var name: String
  public var provider: String
  public var updatedAt: Double

  public init(createdAt: Double, credentialConnection: String? = nil, defaults: [String: RaviJSON]? = nil, deletedAt: Double? = nil, enabled: Bool? = nil, name: String, provider: String, updatedAt: Double) {
    self.createdAt = createdAt
    self.credentialConnection = credentialConnection
    self.defaults = defaults
    self.deletedAt = deletedAt
    self.enabled = enabled
    self.name = name
    self.provider = provider
    self.updatedAt = updatedAt
  }

  enum CodingKeys: String, CodingKey {
    case createdAt = "createdAt"
    case credentialConnection = "credentialConnection"
    case defaults = "defaults"
    case deletedAt = "deletedAt"
    case enabled = "enabled"
    case name = "name"
    case provider = "provider"
    case updatedAt = "updatedAt"
  }
}

public struct ChannelsStartOptions: Codable, Sendable {
  public var build: Bool?

  public init(build: Bool? = nil) {
    self.build = build
  }

  enum CodingKeys: String, CodingKey {
    case build = "build"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.build {
      body["build"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ChannelsStartReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool
  public var pm2Status: RaviJSON?
  public var reason: String?
  public var runnerEnv: RaviJSON?
  public var status: RaviJSON?
  public var target: RaviJSON?

  public init(action: String, changed: Bool, pm2Status: RaviJSON? = nil, reason: String? = nil, runnerEnv: RaviJSON? = nil, status: RaviJSON? = nil, target: RaviJSON? = nil) {
    self.action = action
    self.changed = changed
    self.pm2Status = pm2Status
    self.reason = reason
    self.runnerEnv = runnerEnv
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
    case pm2Status = "pm2Status"
    case reason = "reason"
    case runnerEnv = "runnerEnv"
    case status = "status"
    case target = "target"
  }
}

public struct ChannelsStatusReturn: Codable, Sendable {
  public var channels: RaviJSON
  public var health: RaviJSON?
  public var pm2Available: Bool
  public var processName: String
  public var processes: [RaviJSON]
  public var runner: RaviJSON?

  public init(channels: RaviJSON, health: RaviJSON? = nil, pm2Available: Bool, processName: String, processes: [RaviJSON], runner: RaviJSON? = nil) {
    self.channels = channels
    self.health = health
    self.pm2Available = pm2Available
    self.processName = processName
    self.processes = processes
    self.runner = runner
  }

  enum CodingKeys: String, CodingKey {
    case channels = "channels"
    case health = "health"
    case pm2Available = "pm2Available"
    case processName = "processName"
    case processes = "processes"
    case runner = "runner"
  }
}

public struct ChannelsStopReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool
  public var pm2Status: RaviJSON?
  public var reason: String?
  public var runnerEnv: RaviJSON?
  public var status: RaviJSON?
  public var target: RaviJSON?

  public init(action: String, changed: Bool, pm2Status: RaviJSON? = nil, reason: String? = nil, runnerEnv: RaviJSON? = nil, status: RaviJSON? = nil, target: RaviJSON? = nil) {
    self.action = action
    self.changed = changed
    self.pm2Status = pm2Status
    self.reason = reason
    self.runnerEnv = runnerEnv
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
    case pm2Status = "pm2Status"
    case reason = "reason"
    case runnerEnv = "runnerEnv"
    case status = "status"
    case target = "target"
  }
}

public struct ChatsBackfillProviderTimestampsOptions: Codable, Sendable {
  public var apply: Bool?
  public var dryRun: Bool?
  public var limit: String?

  public init(apply: Bool? = nil, dryRun: Bool? = nil, limit: String? = nil) {
    self.apply = apply
    self.dryRun = dryRun
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case apply = "apply"
    case dryRun = "dryRun"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.apply {
      body["apply"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ChatsBackfillProviderTimestampsReturn = [String: RaviJSON]

public struct ChatsEnsureReturn: Codable, Sendable {
  public var chat: RaviJSON
  public var clientRequestId: String
  public var disposition: String

  public init(chat: RaviJSON, clientRequestId: String, disposition: String) {
    self.chat = chat
    self.clientRequestId = clientRequestId
    self.disposition = disposition
  }

  enum CodingKeys: String, CodingKey {
    case chat = "chat"
    case clientRequestId = "clientRequestId"
    case disposition = "disposition"
  }
}

public struct ChatsListOptions: Codable, Sendable {
  public var agent: String?
  public var channel: String?
  public var contact: String?
  public var fields: String?
  public var includeRaw: Bool?
  public var instance: String?
  public var limit: String?
  public var offset: String?
  public var query: String?
  public var type: String?

  public init(agent: String? = nil, channel: String? = nil, contact: String? = nil, fields: String? = nil, includeRaw: Bool? = nil, instance: String? = nil, limit: String? = nil, offset: String? = nil, query: String? = nil, type: String? = nil) {
    self.agent = agent
    self.channel = channel
    self.contact = contact
    self.fields = fields
    self.includeRaw = includeRaw
    self.instance = instance
    self.limit = limit
    self.offset = offset
    self.query = query
    self.type = type
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case channel = "channel"
    case contact = "contact"
    case fields = "fields"
    case includeRaw = "includeRaw"
    case instance = "instance"
    case limit = "limit"
    case offset = "offset"
    case query = "query"
    case type = "type"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeRaw {
      body["includeRaw"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.query {
      body["query"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.type {
      body["type"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ChatsListReturn: Codable, Sendable {
  public var chats: [RaviJSON]
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var total: Double

  public init(chats: [RaviJSON], items: [RaviJSON], pagination: RaviJSON, total: Double) {
    self.chats = chats
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case chats = "chats"
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct ChatsListsAddOptions: Codable, Sendable {
  public var channel: String?
  public var includeRaw: Bool?
  public var instance: String?
  public var owner: String?
  public var priority: String?
  public var reason: String?

  public init(channel: String? = nil, includeRaw: Bool? = nil, instance: String? = nil, owner: String? = nil, priority: String? = nil, reason: String? = nil) {
    self.channel = channel
    self.includeRaw = includeRaw
    self.instance = instance
    self.owner = owner
    self.priority = priority
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case includeRaw = "includeRaw"
    case instance = "instance"
    case owner = "owner"
    case priority = "priority"
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeRaw {
      body["includeRaw"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ChatsListsAddReturn = [String: RaviJSON]

public struct ChatsListsCreateOptions: Codable, Sendable {
  public var description: String?
  public var mode: String?
  public var owner: String?
  public var visibility: String?

  public init(description: String? = nil, mode: String? = nil, owner: String? = nil, visibility: String? = nil) {
    self.description = description
    self.mode = mode
    self.owner = owner
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case description = "description"
    case mode = "mode"
    case owner = "owner"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mode {
      body["mode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ChatsListsCreateReturn = [String: RaviJSON]

public struct ChatsListsDeltaOptions: Codable, Sendable {
  public var channel: String?
  public var includeRaw: Bool?
  public var instance: String?
  public var limit: String?
  public var markRead: Bool?
  public var owner: String?
  public var reader: String?

  public init(channel: String? = nil, includeRaw: Bool? = nil, instance: String? = nil, limit: String? = nil, markRead: Bool? = nil, owner: String? = nil, reader: String? = nil) {
    self.channel = channel
    self.includeRaw = includeRaw
    self.instance = instance
    self.limit = limit
    self.markRead = markRead
    self.owner = owner
    self.reader = reader
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case includeRaw = "includeRaw"
    case instance = "instance"
    case limit = "limit"
    case markRead = "markRead"
    case owner = "owner"
    case reader = "reader"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeRaw {
      body["includeRaw"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.markRead {
      body["markRead"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reader {
      body["reader"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ChatsListsDeltaReturn = [String: RaviJSON]

public struct ChatsListsListOptions: Codable, Sendable {
  public var fields: String?
  public var includeArchived: Bool?
  public var limit: String?
  public var offset: String?
  public var owner: String?

  public init(fields: String? = nil, includeArchived: Bool? = nil, limit: String? = nil, offset: String? = nil, owner: String? = nil) {
    self.fields = fields
    self.includeArchived = includeArchived
    self.limit = limit
    self.offset = offset
    self.owner = owner
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case includeArchived = "includeArchived"
    case limit = "limit"
    case offset = "offset"
    case owner = "owner"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeArchived {
      body["includeArchived"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ChatsListsListReturn = [String: RaviJSON]

public struct ChatsListsMarkReadOptions: Codable, Sendable {
  public var channel: String?
  public var includeRaw: Bool?
  public var instance: String?
  public var message: String?
  public var owner: String?
  public var reader: String?
  public var reason: String?

  public init(channel: String? = nil, includeRaw: Bool? = nil, instance: String? = nil, message: String? = nil, owner: String? = nil, reader: String? = nil, reason: String? = nil) {
    self.channel = channel
    self.includeRaw = includeRaw
    self.instance = instance
    self.message = message
    self.owner = owner
    self.reader = reader
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case includeRaw = "includeRaw"
    case instance = "instance"
    case message = "message"
    case owner = "owner"
    case reader = "reader"
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeRaw {
      body["includeRaw"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reader {
      body["reader"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ChatsListsMarkReadReturn = [String: RaviJSON]

public struct ChatsListsMembersOptions: Codable, Sendable {
  public var fields: String?
  public var includeRaw: Bool?
  public var limit: String?
  public var offset: String?
  public var owner: String?
  public var reader: String?

  public init(fields: String? = nil, includeRaw: Bool? = nil, limit: String? = nil, offset: String? = nil, owner: String? = nil, reader: String? = nil) {
    self.fields = fields
    self.includeRaw = includeRaw
    self.limit = limit
    self.offset = offset
    self.owner = owner
    self.reader = reader
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case includeRaw = "includeRaw"
    case limit = "limit"
    case offset = "offset"
    case owner = "owner"
    case reader = "reader"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeRaw {
      body["includeRaw"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reader {
      body["reader"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ChatsListsMembersReturn = [String: RaviJSON]

public struct ChatsListsPreviewOptions: Codable, Sendable {
  public var owner: String?

  public init(owner: String? = nil) {
    self.owner = owner
  }

  enum CodingKeys: String, CodingKey {
    case owner = "owner"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ChatsListsPreviewReturn: Codable, Sendable {
  public var list: RaviJSON
  public var preview: RaviJSON

  public init(list: RaviJSON, preview: RaviJSON) {
    self.list = list
    self.preview = preview
  }

  enum CodingKeys: String, CodingKey {
    case list = "list"
    case preview = "preview"
  }
}

public struct ChatsListsRecomputeOptions: Codable, Sendable {
  public var owner: String?

  public init(owner: String? = nil) {
    self.owner = owner
  }

  enum CodingKeys: String, CodingKey {
    case owner = "owner"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ChatsListsRecomputeReturn: Codable, Sendable {
  public var list: RaviJSON
  public var recompute: RaviJSON

  public init(list: RaviJSON, recompute: RaviJSON) {
    self.list = list
    self.recompute = recompute
  }

  enum CodingKeys: String, CodingKey {
    case list = "list"
    case recompute = "recompute"
  }
}

public struct ChatsListsRemoveOptions: Codable, Sendable {
  public var channel: String?
  public var instance: String?
  public var owner: String?

  public init(channel: String? = nil, instance: String? = nil, owner: String? = nil) {
    self.channel = channel
    self.instance = instance
    self.owner = owner
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case instance = "instance"
    case owner = "owner"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ChatsListsRemoveReturn = [String: RaviJSON]

public struct ChatsListsShowOptions: Codable, Sendable {
  public var owner: String?

  public init(owner: String? = nil) {
    self.owner = owner
  }

  enum CodingKeys: String, CodingKey {
    case owner = "owner"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ChatsListsShowReturn: Codable, Sendable {
  public var current: RaviJSON
  public var list: RaviJSON
  public var validation: RaviJSON

  public init(current: RaviJSON, list: RaviJSON, validation: RaviJSON) {
    self.current = current
    self.list = list
    self.validation = validation
  }

  enum CodingKeys: String, CodingKey {
    case current = "current"
    case list = "list"
    case validation = "validation"
  }
}

public struct ChatsMessagesCreateReturn: Codable, Sendable {
  public var clientMessageId: String
  public var disposition: String
  public var message: RaviJSON
  public var messageId: String

  public init(clientMessageId: String, disposition: String, message: RaviJSON, messageId: String) {
    self.clientMessageId = clientMessageId
    self.disposition = disposition
    self.message = message
    self.messageId = messageId
  }

  enum CodingKeys: String, CodingKey {
    case clientMessageId = "clientMessageId"
    case disposition = "disposition"
    case message = "message"
    case messageId = "messageId"
  }
}

public struct ChatsReadOptions: Codable, Sendable {
  public var channel: String?
  public var includeRaw: Bool?
  public var instance: String?
  public var limit: String?
  public var offset: String?
  public var order: String?
  public var type: String?

  public init(channel: String? = nil, includeRaw: Bool? = nil, instance: String? = nil, limit: String? = nil, offset: String? = nil, order: String? = nil, type: String? = nil) {
    self.channel = channel
    self.includeRaw = includeRaw
    self.instance = instance
    self.limit = limit
    self.offset = offset
    self.order = order
    self.type = type
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case includeRaw = "includeRaw"
    case instance = "instance"
    case limit = "limit"
    case offset = "offset"
    case order = "order"
    case type = "type"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeRaw {
      body["includeRaw"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.order {
      body["order"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.type {
      body["type"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ChatsReadReturn: Codable, Sendable {
  public var chat: RaviJSON
  public var messages: [RaviJSON]
  public var pagination: RaviJSON
  public var total: Double

  public init(chat: RaviJSON, messages: [RaviJSON], pagination: RaviJSON, total: Double) {
    self.chat = chat
    self.messages = messages
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case chat = "chat"
    case messages = "messages"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CloudProjectsCreateOptions: Codable, Sendable {
  public var console: String?
  public var defaultPageSite: String?
  public var description: String?
  public var execute: Bool?
  public var name: String?
  public var visibility: String?

  public init(console: String? = nil, defaultPageSite: String? = nil, description: String? = nil, execute: Bool? = nil, name: String? = nil, visibility: String? = nil) {
    self.console = console
    self.defaultPageSite = defaultPageSite
    self.description = description
    self.execute = execute
    self.name = name
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case defaultPageSite = "defaultPageSite"
    case description = "description"
    case execute = "execute"
    case name = "name"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.defaultPageSite {
      body["defaultPageSite"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CloudProjectsCreateReturn: Codable, Sendable {
  public var consoleUrl: String
  public var project: [String: RaviJSON]
  public var redirectTo: RaviJSON
  public var success: Bool

  public init(consoleUrl: String, project: [String: RaviJSON], redirectTo: RaviJSON, success: Bool) {
    self.consoleUrl = consoleUrl
    self.project = project
    self.redirectTo = redirectTo
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case consoleUrl = "consoleUrl"
    case project = "project"
    case redirectTo = "redirectTo"
    case success = "success"
  }
}

public struct CloudProjectsListOptions: Codable, Sendable {
  public var console: String?
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(console: String? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.console = console
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CloudProjectsListReturn: Codable, Sendable {
  public var consoleUrl: String
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var projects: [[String: RaviJSON]]
  public var success: Bool
  public var total: Double

  public init(consoleUrl: String, items: [[String: RaviJSON]], pagination: RaviJSON, projects: [[String: RaviJSON]], success: Bool, total: Double) {
    self.consoleUrl = consoleUrl
    self.items = items
    self.pagination = pagination
    self.projects = projects
    self.success = success
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case consoleUrl = "consoleUrl"
    case items = "items"
    case pagination = "pagination"
    case projects = "projects"
    case success = "success"
    case total = "total"
  }
}

public struct CloudScopeClearOptions: Codable, Sendable {
  public var agent: String?
  public var console: String?
  public var global: Bool?
  public var session: String?
  public var workspace: String?

  public init(agent: String? = nil, console: String? = nil, global: Bool? = nil, session: String? = nil, workspace: String? = nil) {
    self.agent = agent
    self.console = console
    self.global = global
    self.session = session
    self.workspace = workspace
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case console = "console"
    case global = "global"
    case session = "session"
    case workspace = "workspace"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.global {
      body["global"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workspace {
      body["workspace"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CloudScopeClearReturn: Codable, Sendable {
  public var action: String
  public var cleared: Bool
  public var success: Bool
  public var target: RaviJSON

  public init(action: String, cleared: Bool, success: Bool, target: RaviJSON) {
    self.action = action
    self.cleared = cleared
    self.success = success
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case cleared = "cleared"
    case success = "success"
    case target = "target"
  }
}

public struct CloudScopeExplainOptions: Codable, Sendable {
  public var console: String?
  public var project: String?

  public init(console: String? = nil, project: String? = nil) {
    self.console = console
    self.project = project
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case project = "project"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CloudScopeExplainReturn: Codable, Sendable {
  public var candidates: [RaviJSON]
  public var consoleUrl: String
  public var missingProjectCommand: RaviJSON?
  public var organization: RaviJSON?
  public var resolved: RaviJSON
  public var success: Bool

  public init(candidates: [RaviJSON], consoleUrl: String, missingProjectCommand: RaviJSON? = nil, organization: RaviJSON? = nil, resolved: RaviJSON, success: Bool) {
    self.candidates = candidates
    self.consoleUrl = consoleUrl
    self.missingProjectCommand = missingProjectCommand
    self.organization = organization
    self.resolved = resolved
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case candidates = "candidates"
    case consoleUrl = "consoleUrl"
    case missingProjectCommand = "missingProjectCommand"
    case organization = "organization"
    case resolved = "resolved"
    case success = "success"
  }
}

public struct CloudScopeSetOptions: Codable, Sendable {
  public var agent: String?
  public var console: String?
  public var global: Bool?
  public var project: String?
  public var session: String?
  public var workspace: String?

  public init(agent: String? = nil, console: String? = nil, global: Bool? = nil, project: String? = nil, session: String? = nil, workspace: String? = nil) {
    self.agent = agent
    self.console = console
    self.global = global
    self.project = project
    self.session = session
    self.workspace = workspace
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case console = "console"
    case global = "global"
    case project = "project"
    case session = "session"
    case workspace = "workspace"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.global {
      body["global"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workspace {
      body["workspace"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CloudScopeSetReturn: Codable, Sendable {
  public var action: String
  public var scope: RaviJSON
  public var success: Bool
  public var target: RaviJSON

  public init(action: String, scope: RaviJSON, success: Bool, target: RaviJSON) {
    self.action = action
    self.scope = scope
    self.success = success
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case scope = "scope"
    case success = "success"
    case target = "target"
  }
}

public struct CloudScopeShowOptions: Codable, Sendable {
  public var console: String?

  public init(console: String? = nil) {
    self.console = console
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CloudScopeShowReturn: Codable, Sendable {
  public var scope: RaviJSON
  public var success: Bool

  public init(scope: RaviJSON, success: Bool) {
    self.scope = scope
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case scope = "scope"
    case success = "success"
  }
}

public struct CommandsListOptions: Codable, Sendable {
  public var agent: String?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(agent: String? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.agent = agent
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CommandsListReturn: Codable, Sendable {
  public var agent: [String: RaviJSON]
  public var commands: [RaviJSON]
  public var issues: [RaviJSON]
  public var items: [[String: RaviJSON]]
  public var locations: [String: RaviJSON]
  public var pagination: RaviJSON
  public var total: Double

  public init(agent: [String: RaviJSON], commands: [RaviJSON], issues: [RaviJSON], items: [[String: RaviJSON]], locations: [String: RaviJSON], pagination: RaviJSON, total: Double) {
    self.agent = agent
    self.commands = commands
    self.issues = issues
    self.items = items
    self.locations = locations
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case commands = "commands"
    case issues = "issues"
    case items = "items"
    case locations = "locations"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CommandsRunOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CommandsRunReturn: Codable, Sendable {
  public var agent: [String: RaviJSON]
  public var command: RaviJSON
  public var metadata: [String: RaviJSON]
  public var positionalArguments: [RaviJSON]
  public var prompt: String

  public init(agent: [String: RaviJSON], command: RaviJSON, metadata: [String: RaviJSON], positionalArguments: [RaviJSON], prompt: String) {
    self.agent = agent
    self.command = command
    self.metadata = metadata
    self.positionalArguments = positionalArguments
    self.prompt = prompt
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case command = "command"
    case metadata = "metadata"
    case positionalArguments = "positionalArguments"
    case prompt = "prompt"
  }
}

public struct CommandsShowOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CommandsShowReturn: Codable, Sendable {
  public var agent: [String: RaviJSON]
  public var command: RaviJSON

  public init(agent: [String: RaviJSON], command: RaviJSON) {
    self.agent = agent
    self.command = command
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case command = "command"
  }
}

public struct CommandsValidateOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CommandsValidateReturn: Codable, Sendable {
  public var agent: [String: RaviJSON]
  public var effectiveTotal: Double
  public var errors: [RaviJSON]
  public var total: Double
  public var valid: Bool
  public var warnings: [RaviJSON]

  public init(agent: [String: RaviJSON], effectiveTotal: Double, errors: [RaviJSON], total: Double, valid: Bool, warnings: [RaviJSON]) {
    self.agent = agent
    self.effectiveTotal = effectiveTotal
    self.errors = errors
    self.total = total
    self.valid = valid
    self.warnings = warnings
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case effectiveTotal = "effectiveTotal"
    case errors = "errors"
    case total = "total"
    case valid = "valid"
    case warnings = "warnings"
  }
}

public struct ConnectorsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var project: String?
  public var provider: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, project: String? = nil, provider: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.project = project
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case project = "project"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ConnectorsListReturn: Codable, Sendable {
  public var connections: [RaviJSON]
  public var pagination: RaviJSON

  public init(connections: [RaviJSON], pagination: RaviJSON) {
    self.connections = connections
    self.pagination = pagination
  }

  enum CodingKeys: String, CodingKey {
    case connections = "connections"
    case pagination = "pagination"
  }
}

public struct ConnectorsRevokeOptions: Codable, Sendable {
  public var execute: Bool?
  public var yes: Bool?

  public init(execute: Bool? = nil, yes: Bool? = nil) {
    self.execute = execute
    self.yes = yes
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case yes = "yes"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.yes {
      body["yes"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ConnectorsRevokeReturn: Codable, Sendable {
  public var id: String
  public var revoked: Bool

  public init(id: String, revoked: Bool) {
    self.id = id
    self.revoked = revoked
  }

  enum CodingKeys: String, CodingKey {
    case id = "id"
    case revoked = "revoked"
  }
}

public struct ConnectorsShowReturn: Codable, Sendable {
  public var connection: RaviJSON

  public init(connection: RaviJSON) {
    self.connection = connection
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
  }
}

public struct ContactsActivityOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?
  public var raw: Bool?

  public init(limit: String? = nil, offset: String? = nil, raw: Bool? = nil) {
    self.limit = limit
    self.offset = offset
    self.raw = raw
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
    case raw = "raw"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.raw {
      body["raw"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsActivityReturn = [String: RaviJSON]

public struct ContactsAddOptions: Codable, Sendable {
  public var agent: String?
  public var kind: String?

  public init(agent: String? = nil, kind: String? = nil) {
    self.agent = agent
    self.kind = kind
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case kind = "kind"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsAddReturn = [String: RaviJSON]

public typealias ContactsAllowReturn = [String: RaviJSON]

public struct ContactsApproveOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsApproveReturn = [String: RaviJSON]

public struct ContactsBackfillOptions: Codable, Sendable {
  public var apply: Bool?
  public var channel: String?
  public var createList: String?
  public var dryRun: Bool?
  public var instance: String?
  public var limit: String?
  public var listOwner: String?
  public var mode: String?

  public init(apply: Bool? = nil, channel: String? = nil, createList: String? = nil, dryRun: Bool? = nil, instance: String? = nil, limit: String? = nil, listOwner: String? = nil, mode: String? = nil) {
    self.apply = apply
    self.channel = channel
    self.createList = createList
    self.dryRun = dryRun
    self.instance = instance
    self.limit = limit
    self.listOwner = listOwner
    self.mode = mode
  }

  enum CodingKeys: String, CodingKey {
    case apply = "apply"
    case channel = "channel"
    case createList = "createList"
    case dryRun = "dryRun"
    case instance = "instance"
    case limit = "limit"
    case listOwner = "listOwner"
    case mode = "mode"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.apply {
      body["apply"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.createList {
      body["createList"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.listOwner {
      body["listOwner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mode {
      body["mode"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsBackfillReturn = [String: RaviJSON]

public typealias ContactsBlockReturn = [String: RaviJSON]

public typealias ContactsCheckReturn = [String: RaviJSON]

public typealias ContactsDuplicatesReturn = [String: RaviJSON]

public struct ContactsFindOptions: Codable, Sendable {
  public var fields: String?
  public var tag: Bool?

  public init(fields: String? = nil, tag: Bool? = nil) {
    self.fields = fields
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsFindReturn = [String: RaviJSON]

public typealias ContactsGetReturn = [String: RaviJSON]

public typealias ContactsInfoReturn = [String: RaviJSON]

public struct ContactsLinkOptions: Codable, Sendable {
  public var channel: String?
  public var id: String?
  public var instance: String?
  public var reason: String?

  public init(channel: String? = nil, id: String? = nil, instance: String? = nil, reason: String? = nil) {
    self.channel = channel
    self.id = id
    self.instance = instance
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case id = "id"
    case instance = "instance"
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.id {
      body["id"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsLinkReturn = [String: RaviJSON]

public struct ContactsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var status: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, status: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsListReturn = [String: RaviJSON]

public struct ContactsMergeOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsMergeReturn = [String: RaviJSON]

public struct ContactsMessagesOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?

  public init(limit: String? = nil, offset: String? = nil) {
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsMessagesReturn = [String: RaviJSON]

public struct ContactsMetadataListOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?
  public var scope: String?

  public init(limit: String? = nil, offset: String? = nil, scope: String? = nil) {
    self.limit = limit
    self.offset = offset
    self.scope = scope
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
    case scope = "scope"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsMetadataListReturn = [String: RaviJSON]

public struct ContactsMetadataRemoveOptions: Codable, Sendable {
  public var scope: String?
  public var source: String?

  public init(scope: String? = nil, source: String? = nil) {
    self.scope = scope
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case scope = "scope"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsMetadataRemoveReturn = [String: RaviJSON]

public struct ContactsMetadataSetOptions: Codable, Sendable {
  public var scope: String?
  public var source: String?

  public init(scope: String? = nil, source: String? = nil) {
    self.scope = scope
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case scope = "scope"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsMetadataSetReturn = [String: RaviJSON]

public struct ContactsNoteOptions: Codable, Sendable {
  public var scope: String?
  public var source: String?

  public init(scope: String? = nil, source: String? = nil) {
    self.scope = scope
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case scope = "scope"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsNoteReturn = [String: RaviJSON]

public struct ContactsPendingOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsPendingReturn = [String: RaviJSON]

public struct ContactsProfileOptions: Codable, Sendable {
  public var includeCrm: Bool?
  public var limit: String?

  public init(includeCrm: Bool? = nil, limit: String? = nil) {
    self.includeCrm = includeCrm
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case includeCrm = "includeCrm"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.includeCrm {
      body["includeCrm"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsProfileReturn = [String: RaviJSON]

public struct ContactsRemoveOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsRemoveReturn = [String: RaviJSON]

public struct ContactsSessionsOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?

  public init(limit: String? = nil, offset: String? = nil) {
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsSessionsReturn = [String: RaviJSON]

public typealias ContactsSetReturn = [String: RaviJSON]

public typealias ContactsTagReturn = [String: RaviJSON]

public struct ContactsTimelineOptions: Codable, Sendable {
  public var event: String?
  public var limit: String?
  public var offset: String?
  public var scope: String?

  public init(event: String? = nil, limit: String? = nil, offset: String? = nil, scope: String? = nil) {
    self.event = event
    self.limit = limit
    self.offset = offset
    self.scope = scope
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case limit = "limit"
    case offset = "offset"
    case scope = "scope"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.event {
      body["event"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsTimelineReturn = [String: RaviJSON]

public struct ContactsUnlinkOptions: Codable, Sendable {
  public var channel: String?
  public var instance: String?
  public var reason: String?

  public init(channel: String? = nil, instance: String? = nil, reason: String? = nil) {
    self.channel = channel
    self.instance = instance
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case instance = "instance"
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ContactsUnlinkReturn = [String: RaviJSON]

public typealias ContactsUntagReturn = [String: RaviJSON]

public struct ContextAuthorizeReturn: Codable, Sendable {
  public var agentId: RaviJSON
  public var allowed: Bool
  public var approved: Bool
  public var capabilitiesCount: Double
  public var contextId: String
  public var inherited: Bool
  public var objectId: String
  public var objectType: String
  public var permission: String
  public var reason: RaviJSON

  public init(agentId: RaviJSON, allowed: Bool, approved: Bool, capabilitiesCount: Double, contextId: String, inherited: Bool, objectId: String, objectType: String, permission: String, reason: RaviJSON) {
    self.agentId = agentId
    self.allowed = allowed
    self.approved = approved
    self.capabilitiesCount = capabilitiesCount
    self.contextId = contextId
    self.inherited = inherited
    self.objectId = objectId
    self.objectType = objectType
    self.permission = permission
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case allowed = "allowed"
    case approved = "approved"
    case capabilitiesCount = "capabilitiesCount"
    case contextId = "contextId"
    case inherited = "inherited"
    case objectId = "objectId"
    case objectType = "objectType"
    case permission = "permission"
    case reason = "reason"
  }
}

public struct ContextCapabilitiesReturn: Codable, Sendable {
  public var agentId: RaviJSON
  public var capabilities: [RaviJSON]
  public var contextId: String
  public var kind: String
  public var sessionKey: RaviJSON
  public var sessionName: RaviJSON

  public init(agentId: RaviJSON, capabilities: [RaviJSON], contextId: String, kind: String, sessionKey: RaviJSON, sessionName: RaviJSON) {
    self.agentId = agentId
    self.capabilities = capabilities
    self.contextId = contextId
    self.kind = kind
    self.sessionKey = sessionKey
    self.sessionName = sessionName
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case capabilities = "capabilities"
    case contextId = "contextId"
    case kind = "kind"
    case sessionKey = "sessionKey"
    case sessionName = "sessionName"
  }
}

public struct ContextCheckReturn: Codable, Sendable {
  public var agentId: RaviJSON
  public var allowed: Bool
  public var capabilitiesCount: Double
  public var contextId: String
  public var objectId: String
  public var objectType: String
  public var permission: String

  public init(agentId: RaviJSON, allowed: Bool, capabilitiesCount: Double, contextId: String, objectId: String, objectType: String, permission: String) {
    self.agentId = agentId
    self.allowed = allowed
    self.capabilitiesCount = capabilitiesCount
    self.contextId = contextId
    self.objectId = objectId
    self.objectType = objectType
    self.permission = permission
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case allowed = "allowed"
    case capabilitiesCount = "capabilitiesCount"
    case contextId = "contextId"
    case objectId = "objectId"
    case objectType = "objectType"
    case permission = "permission"
  }
}

public struct ContextCleanupAgentRuntimeOptions: Codable, Sendable {
  public var agent: String?
  public var olderThan: String?
  public var reason: String?
  public var revoke: Bool?
  public var session: String?

  public init(agent: String? = nil, olderThan: String? = nil, reason: String? = nil, revoke: Bool? = nil, session: String? = nil) {
    self.agent = agent
    self.olderThan = olderThan
    self.reason = reason
    self.revoke = revoke
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case olderThan = "olderThan"
    case reason = "reason"
    case revoke = "revoke"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.olderThan {
      body["olderThan"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.revoke {
      body["revoke"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ContextCleanupAgentRuntimeReturn: Codable, Sendable {
  public var candidates: [RaviJSON]
  public var candidatesCount: Double
  public var cutoffAt: Double
  public var dryRun: Bool
  public var olderThan: String
  public var olderThanMs: Double
  public var reason: RaviJSON
  public var revoked: [RaviJSON]
  public var revokedCount: Double
  public var scanned: RaviJSON

  public init(candidates: [RaviJSON], candidatesCount: Double, cutoffAt: Double, dryRun: Bool, olderThan: String, olderThanMs: Double, reason: RaviJSON, revoked: [RaviJSON], revokedCount: Double, scanned: RaviJSON) {
    self.candidates = candidates
    self.candidatesCount = candidatesCount
    self.cutoffAt = cutoffAt
    self.dryRun = dryRun
    self.olderThan = olderThan
    self.olderThanMs = olderThanMs
    self.reason = reason
    self.revoked = revoked
    self.revokedCount = revokedCount
    self.scanned = scanned
  }

  enum CodingKeys: String, CodingKey {
    case candidates = "candidates"
    case candidatesCount = "candidatesCount"
    case cutoffAt = "cutoffAt"
    case dryRun = "dryRun"
    case olderThan = "olderThan"
    case olderThanMs = "olderThanMs"
    case reason = "reason"
    case revoked = "revoked"
    case revokedCount = "revokedCount"
    case scanned = "scanned"
  }
}

public struct ContextCodexBashHookReturn: Codable, Sendable {
  public var hookSpecificOutput: RaviJSON?

  public init(hookSpecificOutput: RaviJSON? = nil) {
    self.hookSpecificOutput = hookSpecificOutput
  }

  enum CodingKeys: String, CodingKey {
    case hookSpecificOutput = "hookSpecificOutput"
  }
}

public struct ContextCredentialsAddOptions: Codable, Sendable {
  public var label: String?
  public var setDefault: Bool?

  public init(label: String? = nil, setDefault: Bool? = nil) {
    self.label = label
    self.setDefault = setDefault
  }

  enum CodingKeys: String, CodingKey {
    case label = "label"
    case setDefault = "setDefault"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.setDefault {
      body["setDefault"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ContextCredentialsAddReturn: Codable, Sendable {
  public var added: String
  public var default_: RaviJSON
  public var path: String

  public init(added: String, default_: RaviJSON, path: String) {
    self.added = added
    self.default_ = default_
    self.path = path
  }

  enum CodingKeys: String, CodingKey {
    case added = "added"
    case default_ = "default"
    case path = "path"
  }
}

public struct ContextCredentialsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ContextCredentialsListReturn: Codable, Sendable {
  public var default_: RaviJSON
  public var entries: [RaviJSON]
  public var exists: Bool
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var path: String
  public var total: Double

  public init(default_: RaviJSON, entries: [RaviJSON], exists: Bool, items: [RaviJSON], pagination: RaviJSON, path: String, total: Double) {
    self.default_ = default_
    self.entries = entries
    self.exists = exists
    self.items = items
    self.pagination = pagination
    self.path = path
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case default_ = "default"
    case entries = "entries"
    case exists = "exists"
    case items = "items"
    case pagination = "pagination"
    case path = "path"
    case total = "total"
  }
}

public struct ContextCredentialsRemoveOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ContextCredentialsRemoveReturn: Codable, Sendable {
  public var default_: RaviJSON
  public var path: String
  public var removed: String

  public init(default_: RaviJSON, path: String, removed: String) {
    self.default_ = default_
    self.path = path
    self.removed = removed
  }

  enum CodingKeys: String, CodingKey {
    case default_ = "default"
    case path = "path"
    case removed = "removed"
  }
}

public struct ContextCredentialsSetDefaultReturn: Codable, Sendable {
  public var default_: RaviJSON
  public var path: String

  public init(default_: RaviJSON, path: String) {
    self.default_ = default_
    self.path = path
  }

  enum CodingKeys: String, CodingKey {
    case default_ = "default"
    case path = "path"
  }
}

public struct ContextInfoReturn: Codable, Sendable {
  public var agentId: RaviJSON
  public var capabilities: [RaviJSON]
  public var capabilitiesCount: Double
  public var contextId: String
  public var createdAt: Double
  public var expiresAt: RaviJSON
  public var issuanceMode: RaviJSON
  public var issuedFor: RaviJSON
  public var kind: String
  public var lastUsedAt: RaviJSON
  public var lineage: RaviJSON
  public var metadata: RaviJSON
  public var parentContextId: RaviJSON
  public var revokedAt: RaviJSON
  public var sessionKey: RaviJSON
  public var sessionName: RaviJSON
  public var source: RaviJSON
  public var status: String

  public init(agentId: RaviJSON, capabilities: [RaviJSON], capabilitiesCount: Double, contextId: String, createdAt: Double, expiresAt: RaviJSON, issuanceMode: RaviJSON, issuedFor: RaviJSON, kind: String, lastUsedAt: RaviJSON, lineage: RaviJSON, metadata: RaviJSON, parentContextId: RaviJSON, revokedAt: RaviJSON, sessionKey: RaviJSON, sessionName: RaviJSON, source: RaviJSON, status: String) {
    self.agentId = agentId
    self.capabilities = capabilities
    self.capabilitiesCount = capabilitiesCount
    self.contextId = contextId
    self.createdAt = createdAt
    self.expiresAt = expiresAt
    self.issuanceMode = issuanceMode
    self.issuedFor = issuedFor
    self.kind = kind
    self.lastUsedAt = lastUsedAt
    self.lineage = lineage
    self.metadata = metadata
    self.parentContextId = parentContextId
    self.revokedAt = revokedAt
    self.sessionKey = sessionKey
    self.sessionName = sessionName
    self.source = source
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case capabilities = "capabilities"
    case capabilitiesCount = "capabilitiesCount"
    case contextId = "contextId"
    case createdAt = "createdAt"
    case expiresAt = "expiresAt"
    case issuanceMode = "issuanceMode"
    case issuedFor = "issuedFor"
    case kind = "kind"
    case lastUsedAt = "lastUsedAt"
    case lineage = "lineage"
    case metadata = "metadata"
    case parentContextId = "parentContextId"
    case revokedAt = "revokedAt"
    case sessionKey = "sessionKey"
    case sessionName = "sessionName"
    case source = "source"
    case status = "status"
  }
}

public struct ContextIssueOptions: Codable, Sendable {
  public var allow: String?
  public var inherit: Bool?
  public var ttl: String?

  public init(allow: String? = nil, inherit: Bool? = nil, ttl: String? = nil) {
    self.allow = allow
    self.inherit = inherit
    self.ttl = ttl
  }

  enum CodingKeys: String, CodingKey {
    case allow = "allow"
    case inherit = "inherit"
    case ttl = "ttl"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.allow {
      body["allow"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.inherit {
      body["inherit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ttl {
      body["ttl"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ContextIssueReturn: Codable, Sendable {
  public var agentId: RaviJSON
  public var capabilities: [RaviJSON]
  public var capabilitiesCount: Double
  public var cliName: String
  public var contextId: String
  public var contextKey: String
  public var createdAt: Double
  public var env: [String: String]
  public var expiresAt: RaviJSON
  public var kind: String
  public var metadata: RaviJSON
  public var parentContextId: String
  public var sessionKey: RaviJSON
  public var sessionName: RaviJSON
  public var source: RaviJSON

  public init(agentId: RaviJSON, capabilities: [RaviJSON], capabilitiesCount: Double, cliName: String, contextId: String, contextKey: String, createdAt: Double, env: [String: String], expiresAt: RaviJSON, kind: String, metadata: RaviJSON, parentContextId: String, sessionKey: RaviJSON, sessionName: RaviJSON, source: RaviJSON) {
    self.agentId = agentId
    self.capabilities = capabilities
    self.capabilitiesCount = capabilitiesCount
    self.cliName = cliName
    self.contextId = contextId
    self.contextKey = contextKey
    self.createdAt = createdAt
    self.env = env
    self.expiresAt = expiresAt
    self.kind = kind
    self.metadata = metadata
    self.parentContextId = parentContextId
    self.sessionKey = sessionKey
    self.sessionName = sessionName
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case capabilities = "capabilities"
    case capabilitiesCount = "capabilitiesCount"
    case cliName = "cliName"
    case contextId = "contextId"
    case contextKey = "contextKey"
    case createdAt = "createdAt"
    case env = "env"
    case expiresAt = "expiresAt"
    case kind = "kind"
    case metadata = "metadata"
    case parentContextId = "parentContextId"
    case sessionKey = "sessionKey"
    case sessionName = "sessionName"
    case source = "source"
  }
}

public struct ContextLineageReturn: Codable, Sendable {
  public var ancestors: [RaviJSON]
  public var context: RaviJSON
  public var descendants: [RaviJSON]

  public init(ancestors: [RaviJSON], context: RaviJSON, descendants: [RaviJSON]) {
    self.ancestors = ancestors
    self.context = context
    self.descendants = descendants
  }

  enum CodingKeys: String, CodingKey {
    case ancestors = "ancestors"
    case context = "context"
    case descendants = "descendants"
  }
}

public struct ContextListOptions: Codable, Sendable {
  public var agent: String?
  public var all: Bool?
  public var fields: String?
  public var kind: String?
  public var limit: String?
  public var offset: String?
  public var session: String?

  public init(agent: String? = nil, all: Bool? = nil, fields: String? = nil, kind: String? = nil, limit: String? = nil, offset: String? = nil, session: String? = nil) {
    self.agent = agent
    self.all = all
    self.fields = fields
    self.kind = kind
    self.limit = limit
    self.offset = offset
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case all = "all"
    case fields = "fields"
    case kind = "kind"
    case limit = "limit"
    case offset = "offset"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.all {
      body["all"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ContextListReturn: Codable, Sendable {
  public var contexts: [RaviJSON]
  public var count: Double
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var total: Double

  public init(contexts: [RaviJSON], count: Double, items: [RaviJSON], pagination: RaviJSON, total: Double) {
    self.contexts = contexts
    self.count = count
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case contexts = "contexts"
    case count = "count"
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct ContextPruneOptions: Codable, Sendable {
  public var apply: Bool?
  public var confirm: String?
  public var olderThan: String?

  public init(apply: Bool? = nil, confirm: String? = nil, olderThan: String? = nil) {
    self.apply = apply
    self.confirm = confirm
    self.olderThan = olderThan
  }

  enum CodingKeys: String, CodingKey {
    case apply = "apply"
    case confirm = "confirm"
    case olderThan = "olderThan"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.apply {
      body["apply"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.confirm {
      body["confirm"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.olderThan {
      body["olderThan"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ContextPruneReturn: Codable, Sendable {
  public var changedCount: Double
  public var dryRun: Bool
  public var matchedCount: Double
  public var olderThan: String
  public var status: String

  public init(changedCount: Double, dryRun: Bool, matchedCount: Double, olderThan: String, status: String) {
    self.changedCount = changedCount
    self.dryRun = dryRun
    self.matchedCount = matchedCount
    self.olderThan = olderThan
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case dryRun = "dryRun"
    case matchedCount = "matchedCount"
    case olderThan = "olderThan"
    case status = "status"
  }
}

public struct ContextRevokeOptions: Codable, Sendable {
  public var noCascade: Bool?
  public var reason: String?

  public init(noCascade: Bool? = nil, reason: String? = nil) {
    self.noCascade = noCascade
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case noCascade = "noCascade"
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.noCascade {
      body["noCascade"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ContextRevokeReturn: Codable, Sendable {
  public var cascaded: [RaviJSON]
  public var context: RaviJSON
  public var revokedAt: Double

  public init(cascaded: [RaviJSON], context: RaviJSON, revokedAt: Double) {
    self.cascaded = cascaded
    self.context = context
    self.revokedAt = revokedAt
  }

  enum CodingKeys: String, CodingKey {
    case cascaded = "cascaded"
    case context = "context"
    case revokedAt = "revokedAt"
  }
}

public struct ContextVisibilityReturn: Codable, Sendable {
  public var agentId: String
  public var compact: RaviJSON
  public var lastUpdatedAt: Double
  public var loadedSkills: [String]
  public var provider: RaviJSON
  public var sessionKey: String
  public var skills: [RaviJSON]
  public var tokens: RaviJSON

  public init(agentId: String, compact: RaviJSON, lastUpdatedAt: Double, loadedSkills: [String], provider: RaviJSON, sessionKey: String, skills: [RaviJSON], tokens: RaviJSON) {
    self.agentId = agentId
    self.compact = compact
    self.lastUpdatedAt = lastUpdatedAt
    self.loadedSkills = loadedSkills
    self.provider = provider
    self.sessionKey = sessionKey
    self.skills = skills
    self.tokens = tokens
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case compact = "compact"
    case lastUpdatedAt = "lastUpdatedAt"
    case loadedSkills = "loadedSkills"
    case provider = "provider"
    case sessionKey = "sessionKey"
    case skills = "skills"
    case tokens = "tokens"
  }
}

public struct ContextWhoamiReturn: Codable, Sendable {
  public var agentId: RaviJSON
  public var capabilities: [RaviJSON]
  public var capabilitiesCount: Double
  public var contextId: String
  public var createdAt: Double
  public var expiresAt: RaviJSON
  public var issuanceMode: RaviJSON
  public var issuedFor: RaviJSON
  public var kind: String
  public var lastUsedAt: RaviJSON
  public var lineage: RaviJSON
  public var metadata: RaviJSON
  public var parentContextId: RaviJSON
  public var revokedAt: RaviJSON
  public var sessionKey: RaviJSON
  public var sessionName: RaviJSON
  public var source: RaviJSON
  public var status: String

  public init(agentId: RaviJSON, capabilities: [RaviJSON], capabilitiesCount: Double, contextId: String, createdAt: Double, expiresAt: RaviJSON, issuanceMode: RaviJSON, issuedFor: RaviJSON, kind: String, lastUsedAt: RaviJSON, lineage: RaviJSON, metadata: RaviJSON, parentContextId: RaviJSON, revokedAt: RaviJSON, sessionKey: RaviJSON, sessionName: RaviJSON, source: RaviJSON, status: String) {
    self.agentId = agentId
    self.capabilities = capabilities
    self.capabilitiesCount = capabilitiesCount
    self.contextId = contextId
    self.createdAt = createdAt
    self.expiresAt = expiresAt
    self.issuanceMode = issuanceMode
    self.issuedFor = issuedFor
    self.kind = kind
    self.lastUsedAt = lastUsedAt
    self.lineage = lineage
    self.metadata = metadata
    self.parentContextId = parentContextId
    self.revokedAt = revokedAt
    self.sessionKey = sessionKey
    self.sessionName = sessionName
    self.source = source
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case capabilities = "capabilities"
    case capabilitiesCount = "capabilitiesCount"
    case contextId = "contextId"
    case createdAt = "createdAt"
    case expiresAt = "expiresAt"
    case issuanceMode = "issuanceMode"
    case issuedFor = "issuedFor"
    case kind = "kind"
    case lastUsedAt = "lastUsedAt"
    case lineage = "lineage"
    case metadata = "metadata"
    case parentContextId = "parentContextId"
    case revokedAt = "revokedAt"
    case sessionKey = "sessionKey"
    case sessionName = "sessionName"
    case source = "source"
    case status = "status"
  }
}

public struct CostsAgentOptions: Codable, Sendable {
  public var hours: String?

  public init(hours: String? = nil) {
    self.hours = hours
  }

  enum CodingKeys: String, CodingKey {
    case hours = "hours"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.hours {
      body["hours"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CostsAgentReturn: Codable, Sendable {
  public var agentId: String
  public var summary: RaviJSON
  public var window: RaviJSON

  public init(agentId: String, summary: RaviJSON, window: RaviJSON) {
    self.agentId = agentId
    self.summary = summary
    self.window = window
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case summary = "summary"
    case window = "window"
  }
}

public struct CostsAgentsOptions: Codable, Sendable {
  public var fields: String?
  public var hours: String?
  public var limit: String?

  public init(fields: String? = nil, hours: String? = nil, limit: String? = nil) {
    self.fields = fields
    self.hours = hours
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case hours = "hours"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.hours {
      body["hours"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CostsAgentsReturn: Codable, Sendable {
  public var agents: [RaviJSON]
  public var limit: Double
  public var totalAgents: Double
  public var window: RaviJSON

  public init(agents: [RaviJSON], limit: Double, totalAgents: Double, window: RaviJSON) {
    self.agents = agents
    self.limit = limit
    self.totalAgents = totalAgents
    self.window = window
  }

  enum CodingKeys: String, CodingKey {
    case agents = "agents"
    case limit = "limit"
    case totalAgents = "totalAgents"
    case window = "window"
  }
}

public struct CostsPricingOptions: Codable, Sendable {
  public var dryRun: Bool?
  public var fields: String?
  public var hours: String?
  public var includePriced: Bool?
  public var limit: String?
  public var recompute: Bool?

  public init(dryRun: Bool? = nil, fields: String? = nil, hours: String? = nil, includePriced: Bool? = nil, limit: String? = nil, recompute: Bool? = nil) {
    self.dryRun = dryRun
    self.fields = fields
    self.hours = hours
    self.includePriced = includePriced
    self.limit = limit
    self.recompute = recompute
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
    case fields = "fields"
    case hours = "hours"
    case includePriced = "includePriced"
    case limit = "limit"
    case recompute = "recompute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.hours {
      body["hours"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includePriced {
      body["includePriced"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.recompute {
      body["recompute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CostsPricingReturn: Codable, Sendable {
  public var recompute: RaviJSON?
  public var rows: [RaviJSON]
  public var window: RaviJSON

  public init(recompute: RaviJSON? = nil, rows: [RaviJSON], window: RaviJSON) {
    self.recompute = recompute
    self.rows = rows
    self.window = window
  }

  enum CodingKeys: String, CodingKey {
    case recompute = "recompute"
    case rows = "rows"
    case window = "window"
  }
}

public struct CostsSessionReturn: Codable, Sendable {
  public var agentId: RaviJSON
  public var sessionKey: String
  public var sessionName: RaviJSON
  public var summary: RaviJSON

  public init(agentId: RaviJSON, sessionKey: String, sessionName: RaviJSON, summary: RaviJSON) {
    self.agentId = agentId
    self.sessionKey = sessionKey
    self.sessionName = sessionName
    self.summary = summary
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case sessionKey = "sessionKey"
    case sessionName = "sessionName"
    case summary = "summary"
  }
}

public struct CostsSummaryOptions: Codable, Sendable {
  public var hours: String?

  public init(hours: String? = nil) {
    self.hours = hours
  }

  enum CodingKeys: String, CodingKey {
    case hours = "hours"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.hours {
      body["hours"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CostsSummaryReturn: Codable, Sendable {
  public var summary: RaviJSON
  public var window: RaviJSON

  public init(summary: RaviJSON, window: RaviJSON) {
    self.summary = summary
    self.window = window
  }

  enum CodingKeys: String, CodingKey {
    case summary = "summary"
    case window = "window"
  }
}

public struct CostsTopSessionsOptions: Codable, Sendable {
  public var fields: String?
  public var hours: String?
  public var limit: String?

  public init(fields: String? = nil, hours: String? = nil, limit: String? = nil) {
    self.fields = fields
    self.hours = hours
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case hours = "hours"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.hours {
      body["hours"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CostsTopSessionsReturn: Codable, Sendable {
  public var limit: Double
  public var sessions: [RaviJSON]
  public var window: RaviJSON

  public init(limit: Double, sessions: [RaviJSON], window: RaviJSON) {
    self.limit = limit
    self.sessions = sessions
    self.window = window
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case sessions = "sessions"
    case window = "window"
  }
}

public struct CredentialsConnectionsDisableOptions: Codable, Sendable {
  public var connection: String?
  public var provider: String?

  public init(connection: String? = nil, provider: String? = nil) {
    self.connection = connection
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CredentialsConnectionsDisableReturn: Codable, Sendable {
  public var connection: RaviJSON

  public init(connection: RaviJSON) {
    self.connection = connection
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
  }
}

public struct CredentialsConnectionsEnableOptions: Codable, Sendable {
  public var connection: String?
  public var provider: String?

  public init(connection: String? = nil, provider: String? = nil) {
    self.connection = connection
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CredentialsConnectionsEnableReturn: Codable, Sendable {
  public var connection: RaviJSON

  public init(connection: RaviJSON) {
    self.connection = connection
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
  }
}

public struct CredentialsConnectionsListOptions: Codable, Sendable {
  public var all: Bool?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var provider: String?
  public var status: String?

  public init(all: Bool? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, provider: String? = nil, status: String? = nil) {
    self.all = all
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.provider = provider
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case all = "all"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case provider = "provider"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.all {
      body["all"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CredentialsConnectionsListReturn: Codable, Sendable {
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [RaviJSON], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CredentialsConnectionsShowOptions: Codable, Sendable {
  public var connection: String?
  public var provider: String?

  public init(connection: String? = nil, provider: String? = nil) {
    self.connection = connection
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CredentialsConnectionsShowReturn: Codable, Sendable {
  public var connection: RaviJSON

  public init(connection: RaviJSON) {
    self.connection = connection
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
  }
}

public struct CredentialsPoliciesExplainOptions: Codable, Sendable {
  public var action: String?
  public var connection: String?
  public var provider: String?

  public init(action: String? = nil, connection: String? = nil, provider: String? = nil) {
    self.action = action
    self.connection = connection
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case connection = "connection"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.action {
      body["action"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CredentialsPoliciesExplainReturn: Codable, Sendable {
  public var action: String
  public var approval: RaviJSON
  public var connection: String
  public var provider: String
  public var requiredCapabilities: [String]

  public init(action: String, approval: RaviJSON, connection: String, provider: String, requiredCapabilities: [String]) {
    self.action = action
    self.approval = approval
    self.connection = connection
    self.provider = provider
    self.requiredCapabilities = requiredCapabilities
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case approval = "approval"
    case connection = "connection"
    case provider = "provider"
    case requiredCapabilities = "requiredCapabilities"
  }
}

public struct CrmAccountReturn: Codable, Sendable {
  public var crm: [String: RaviJSON]
  public var target: String

  public init(crm: [String: RaviJSON], target: String) {
    self.crm = crm
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case crm = "crm"
    case target = "target"
  }
}

public struct CrmAccountCreateOptions: Codable, Sendable {
  public var contact: String?
  public var domain: String?
  public var idempotencyKey: String?
  public var owner: String?

  public init(contact: String? = nil, domain: String? = nil, idempotencyKey: String? = nil, owner: String? = nil) {
    self.contact = contact
    self.domain = domain
    self.idempotencyKey = idempotencyKey
    self.owner = owner
  }

  enum CodingKeys: String, CodingKey {
    case contact = "contact"
    case domain = "domain"
    case idempotencyKey = "idempotencyKey"
    case owner = "owner"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.domain {
      body["domain"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmAccountCreateReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmAccountLinkContactOptions: Codable, Sendable {
  public var primary: Bool?
  public var role: String?

  public init(primary: Bool? = nil, role: String? = nil) {
    self.primary = primary
    self.role = role
  }

  enum CodingKeys: String, CodingKey {
    case primary = "primary"
    case role = "role"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.primary {
      body["primary"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmAccountLinkContactReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmAccountShowReturn: Codable, Sendable {
  public var crm: [String: RaviJSON]
  public var target: String

  public init(crm: [String: RaviJSON], target: String) {
    self.crm = crm
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case crm = "crm"
    case target = "target"
  }
}

public struct CrmBoardOptions: Codable, Sendable {
  public var fields: String?
  public var includeEmptyStages: Bool?
  public var pipeline: String?

  public init(fields: String? = nil, includeEmptyStages: Bool? = nil, pipeline: String? = nil) {
    self.fields = fields
    self.includeEmptyStages = includeEmptyStages
    self.pipeline = pipeline
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case includeEmptyStages = "includeEmptyStages"
    case pipeline = "pipeline"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeEmptyStages {
      body["includeEmptyStages"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.pipeline {
      body["pipeline"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmBoardReturn: Codable, Sendable {
  public var opportunities: [[String: RaviJSON]]
  public var stages: [[String: RaviJSON]]?
  public var total: Double

  public init(opportunities: [[String: RaviJSON]], stages: [[String: RaviJSON]]? = nil, total: Double) {
    self.opportunities = opportunities
    self.stages = stages
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case opportunities = "opportunities"
    case stages = "stages"
    case total = "total"
  }
}

public struct CrmContactReturn: Codable, Sendable {
  public var crm: [String: RaviJSON]
  public var target: String

  public init(crm: [String: RaviJSON], target: String) {
    self.crm = crm
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case crm = "crm"
    case target = "target"
  }
}

public struct CrmContactSetOptions: Codable, Sendable {
  public var source: String?

  public init(source: String? = nil) {
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmContactSetReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmContactShowReturn: Codable, Sendable {
  public var crm: [String: RaviJSON]
  public var target: String

  public init(crm: [String: RaviJSON], target: String) {
    self.crm = crm
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case crm = "crm"
    case target = "target"
  }
}

public struct CrmContactsOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var owner: String?
  public var status: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, owner: String? = nil, status: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.owner = owner
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case owner = "owner"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmContactsReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CrmFactConfirmReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmFactListOptions: Codable, Sendable {
  public var account: String?
  public var contact: String?
  public var entity: String?
  public var entityType: String?
  public var key: String?
  public var limit: String?
  public var offset: String?
  public var opportunity: String?
  public var status: String?

  public init(account: String? = nil, contact: String? = nil, entity: String? = nil, entityType: String? = nil, key: String? = nil, limit: String? = nil, offset: String? = nil, opportunity: String? = nil, status: String? = nil) {
    self.account = account
    self.contact = contact
    self.entity = entity
    self.entityType = entityType
    self.key = key
    self.limit = limit
    self.offset = offset
    self.opportunity = opportunity
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case contact = "contact"
    case entity = "entity"
    case entityType = "entityType"
    case key = "key"
    case limit = "limit"
    case offset = "offset"
    case opportunity = "opportunity"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.entity {
      body["entity"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.entityType {
      body["entityType"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.key {
      body["key"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.opportunity {
      body["opportunity"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmFactListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CrmFactProposeOptions: Codable, Sendable {
  public var account: String?
  public var confidence: String?
  public var contact: String?
  public var idempotencyKey: String?
  public var opportunity: String?
  public var status: String?

  public init(account: String? = nil, confidence: String? = nil, contact: String? = nil, idempotencyKey: String? = nil, opportunity: String? = nil, status: String? = nil) {
    self.account = account
    self.confidence = confidence
    self.contact = contact
    self.idempotencyKey = idempotencyKey
    self.opportunity = opportunity
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case confidence = "confidence"
    case contact = "contact"
    case idempotencyKey = "idempotencyKey"
    case opportunity = "opportunity"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.confidence {
      body["confidence"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.opportunity {
      body["opportunity"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmFactProposeReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmFactRejectReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmNextOptions: Codable, Sendable {
  public var account: String?
  public var contact: String?
  public var dueAfter: String?
  public var dueBefore: String?
  public var dueToday: Bool?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var opportunity: String?
  public var owner: String?
  public var taskType: String?

  public init(account: String? = nil, contact: String? = nil, dueAfter: String? = nil, dueBefore: String? = nil, dueToday: Bool? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, opportunity: String? = nil, owner: String? = nil, taskType: String? = nil) {
    self.account = account
    self.contact = contact
    self.dueAfter = dueAfter
    self.dueBefore = dueBefore
    self.dueToday = dueToday
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.opportunity = opportunity
    self.owner = owner
    self.taskType = taskType
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case contact = "contact"
    case dueAfter = "dueAfter"
    case dueBefore = "dueBefore"
    case dueToday = "dueToday"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case opportunity = "opportunity"
    case owner = "owner"
    case taskType = "taskType"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dueAfter {
      body["dueAfter"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dueBefore {
      body["dueBefore"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dueToday {
      body["dueToday"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.opportunity {
      body["opportunity"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.taskType {
      body["taskType"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmNextReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CrmOpportunityReturn: Codable, Sendable {
  public var opportunity: [String: RaviJSON]
  public var target: String

  public init(opportunity: [String: RaviJSON], target: String) {
    self.opportunity = opportunity
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case opportunity = "opportunity"
    case target = "target"
  }
}

public struct CrmOpportunityContactsReturn: Codable, Sendable {
  public var contacts: [[String: RaviJSON]]
  public var total: Double

  public init(contacts: [[String: RaviJSON]], total: Double) {
    self.contacts = contacts
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case contacts = "contacts"
    case total = "total"
  }
}

public struct CrmOpportunityCreateOptions: Codable, Sendable {
  public var account: String?
  public var contact: String?
  public var currency: String?
  public var idempotencyKey: String?
  public var owner: String?
  public var pipeline: String?
  public var stage: String?
  public var value: String?

  public init(account: String? = nil, contact: String? = nil, currency: String? = nil, idempotencyKey: String? = nil, owner: String? = nil, pipeline: String? = nil, stage: String? = nil, value: String? = nil) {
    self.account = account
    self.contact = contact
    self.currency = currency
    self.idempotencyKey = idempotencyKey
    self.owner = owner
    self.pipeline = pipeline
    self.stage = stage
    self.value = value
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case contact = "contact"
    case currency = "currency"
    case idempotencyKey = "idempotencyKey"
    case owner = "owner"
    case pipeline = "pipeline"
    case stage = "stage"
    case value = "value"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.currency {
      body["currency"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.pipeline {
      body["pipeline"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.stage {
      body["stage"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.value {
      body["value"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmOpportunityCreateReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmOpportunityLinkContactOptions: Codable, Sendable {
  public var account: String?
  public var primary: Bool?
  public var role: String?

  public init(account: String? = nil, primary: Bool? = nil, role: String? = nil) {
    self.account = account
    self.primary = primary
    self.role = role
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case primary = "primary"
    case role = "role"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.primary {
      body["primary"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmOpportunityLinkContactReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmOpportunityMoveOptions: Codable, Sendable {
  public var lostReason: String?

  public init(lostReason: String? = nil) {
    self.lostReason = lostReason
  }

  enum CodingKeys: String, CodingKey {
    case lostReason = "lostReason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.lostReason {
      body["lostReason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmOpportunityMoveReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmOpportunityShowReturn: Codable, Sendable {
  public var opportunity: [String: RaviJSON]
  public var target: String

  public init(opportunity: [String: RaviJSON], target: String) {
    self.opportunity = opportunity
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case opportunity = "opportunity"
    case target = "target"
  }
}

public struct CrmPipelineCreateOptions: Codable, Sendable {
  public var analystAvoid: String?
  public var analystMentions: String?
  public var analystTone: String?
  public var consumer: String?
  public var default_: Bool?
  public var entityType: String?
  public var hitlRequiredWhen: String?
  public var idempotencyKey: String?
  public var messagePrefix: String?
  public var messageSuffix: String?
  public var metadata: String?
  public var objetivo: String?
  public var priorityGlobal: String?
  public var producer: String?
  public var readingListId: String?
  public var reguaTag: [String]?
  public var relatedCron: String?
  public var relatedTrigger: String?
  public var sendWindow: String?
  public var versao: String?
  public var vipGuardAction: String?
  public var vipGuardLtv: String?
  public var vipGuardTag: String?

  public init(analystAvoid: String? = nil, analystMentions: String? = nil, analystTone: String? = nil, consumer: String? = nil, default_: Bool? = nil, entityType: String? = nil, hitlRequiredWhen: String? = nil, idempotencyKey: String? = nil, messagePrefix: String? = nil, messageSuffix: String? = nil, metadata: String? = nil, objetivo: String? = nil, priorityGlobal: String? = nil, producer: String? = nil, readingListId: String? = nil, reguaTag: [String]? = nil, relatedCron: String? = nil, relatedTrigger: String? = nil, sendWindow: String? = nil, versao: String? = nil, vipGuardAction: String? = nil, vipGuardLtv: String? = nil, vipGuardTag: String? = nil) {
    self.analystAvoid = analystAvoid
    self.analystMentions = analystMentions
    self.analystTone = analystTone
    self.consumer = consumer
    self.default_ = default_
    self.entityType = entityType
    self.hitlRequiredWhen = hitlRequiredWhen
    self.idempotencyKey = idempotencyKey
    self.messagePrefix = messagePrefix
    self.messageSuffix = messageSuffix
    self.metadata = metadata
    self.objetivo = objetivo
    self.priorityGlobal = priorityGlobal
    self.producer = producer
    self.readingListId = readingListId
    self.reguaTag = reguaTag
    self.relatedCron = relatedCron
    self.relatedTrigger = relatedTrigger
    self.sendWindow = sendWindow
    self.versao = versao
    self.vipGuardAction = vipGuardAction
    self.vipGuardLtv = vipGuardLtv
    self.vipGuardTag = vipGuardTag
  }

  enum CodingKeys: String, CodingKey {
    case analystAvoid = "analystAvoid"
    case analystMentions = "analystMentions"
    case analystTone = "analystTone"
    case consumer = "consumer"
    case default_ = "default"
    case entityType = "entityType"
    case hitlRequiredWhen = "hitlRequiredWhen"
    case idempotencyKey = "idempotencyKey"
    case messagePrefix = "messagePrefix"
    case messageSuffix = "messageSuffix"
    case metadata = "metadata"
    case objetivo = "objetivo"
    case priorityGlobal = "priorityGlobal"
    case producer = "producer"
    case readingListId = "readingListId"
    case reguaTag = "reguaTag"
    case relatedCron = "relatedCron"
    case relatedTrigger = "relatedTrigger"
    case sendWindow = "sendWindow"
    case versao = "versao"
    case vipGuardAction = "vipGuardAction"
    case vipGuardLtv = "vipGuardLtv"
    case vipGuardTag = "vipGuardTag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.analystAvoid {
      body["analystAvoid"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.analystMentions {
      body["analystMentions"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.analystTone {
      body["analystTone"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.consumer {
      body["consumer"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.default_ {
      body["default"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.entityType {
      body["entityType"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.hitlRequiredWhen {
      body["hitlRequiredWhen"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.messagePrefix {
      body["messagePrefix"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.messageSuffix {
      body["messageSuffix"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metadata {
      body["metadata"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.objetivo {
      body["objetivo"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priorityGlobal {
      body["priorityGlobal"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.producer {
      body["producer"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.readingListId {
      body["readingListId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reguaTag {
      body["reguaTag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.relatedCron {
      body["relatedCron"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.relatedTrigger {
      body["relatedTrigger"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sendWindow {
      body["sendWindow"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.versao {
      body["versao"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.vipGuardAction {
      body["vipGuardAction"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.vipGuardLtv {
      body["vipGuardLtv"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.vipGuardTag {
      body["vipGuardTag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelineCreateReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmPipelineListOptions: Codable, Sendable {
  public var entityType: String?
  public var fields: String?
  public var includeArchived: Bool?
  public var limit: String?
  public var offset: String?

  public init(entityType: String? = nil, fields: String? = nil, includeArchived: Bool? = nil, limit: String? = nil, offset: String? = nil) {
    self.entityType = entityType
    self.fields = fields
    self.includeArchived = includeArchived
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case entityType = "entityType"
    case fields = "fields"
    case includeArchived = "includeArchived"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.entityType {
      body["entityType"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeArchived {
      body["includeArchived"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelineListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CrmPipelinePolicyHitlCheckOptions: Codable, Sendable {
  public var context: String?

  public init(context: String? = nil) {
    self.context = context
  }

  enum CodingKeys: String, CodingKey {
    case context = "context"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.context {
      body["context"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelinePolicyHitlCheckReturn: Codable, Sendable {
  public var decision: RaviJSON
  public var errors: [RaviJSON]
  public var ok: Bool
  public var pipelineId: String
  public var warnings: [RaviJSON]

  public init(decision: RaviJSON, errors: [RaviJSON], ok: Bool, pipelineId: String, warnings: [RaviJSON]) {
    self.decision = decision
    self.errors = errors
    self.ok = ok
    self.pipelineId = pipelineId
    self.warnings = warnings
  }

  enum CodingKeys: String, CodingKey {
    case decision = "decision"
    case errors = "errors"
    case ok = "ok"
    case pipelineId = "pipelineId"
    case warnings = "warnings"
  }
}

public struct CrmPipelinePolicySendWindowCheckOptions: Codable, Sendable {
  public var at: String?

  public init(at: String? = nil) {
    self.at = at
  }

  enum CodingKeys: String, CodingKey {
    case at = "at"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.at {
      body["at"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelinePolicySendWindowCheckReturn: Codable, Sendable {
  public var decision: RaviJSON
  public var errors: [RaviJSON]
  public var ok: Bool
  public var pipelineId: String
  public var warnings: [RaviJSON]

  public init(decision: RaviJSON, errors: [RaviJSON], ok: Bool, pipelineId: String, warnings: [RaviJSON]) {
    self.decision = decision
    self.errors = errors
    self.ok = ok
    self.pipelineId = pipelineId
    self.warnings = warnings
  }

  enum CodingKeys: String, CodingKey {
    case decision = "decision"
    case errors = "errors"
    case ok = "ok"
    case pipelineId = "pipelineId"
    case warnings = "warnings"
  }
}

public struct CrmPipelineReviewReturn: Codable, Sendable {
  public var fields: [RaviJSON]
  public var highSeverityGaps: Double
  public var pipelineId: String
  public var pipelineName: String
  public var totalGaps: Double

  public init(fields: [RaviJSON], highSeverityGaps: Double, pipelineId: String, pipelineName: String, totalGaps: Double) {
    self.fields = fields
    self.highSeverityGaps = highSeverityGaps
    self.pipelineId = pipelineId
    self.pipelineName = pipelineName
    self.totalGaps = totalGaps
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case highSeverityGaps = "highSeverityGaps"
    case pipelineId = "pipelineId"
    case pipelineName = "pipelineName"
    case totalGaps = "totalGaps"
  }
}

public struct CrmPipelineSetOptions: Codable, Sendable {
  public var analystAvoid: String?
  public var analystMentions: String?
  public var analystTone: String?
  public var consumer: String?
  public var hitlRequiredWhen: String?
  public var messagePrefix: String?
  public var messageSuffix: String?
  public var objetivo: String?
  public var priorityGlobal: String?
  public var producer: String?
  public var readingListId: String?
  public var reguaTag: [String]?
  public var relatedCron: String?
  public var relatedTrigger: String?
  public var sendWindow: String?
  public var versao: String?
  public var vipGuardAction: String?
  public var vipGuardLtv: String?
  public var vipGuardTag: String?

  public init(analystAvoid: String? = nil, analystMentions: String? = nil, analystTone: String? = nil, consumer: String? = nil, hitlRequiredWhen: String? = nil, messagePrefix: String? = nil, messageSuffix: String? = nil, objetivo: String? = nil, priorityGlobal: String? = nil, producer: String? = nil, readingListId: String? = nil, reguaTag: [String]? = nil, relatedCron: String? = nil, relatedTrigger: String? = nil, sendWindow: String? = nil, versao: String? = nil, vipGuardAction: String? = nil, vipGuardLtv: String? = nil, vipGuardTag: String? = nil) {
    self.analystAvoid = analystAvoid
    self.analystMentions = analystMentions
    self.analystTone = analystTone
    self.consumer = consumer
    self.hitlRequiredWhen = hitlRequiredWhen
    self.messagePrefix = messagePrefix
    self.messageSuffix = messageSuffix
    self.objetivo = objetivo
    self.priorityGlobal = priorityGlobal
    self.producer = producer
    self.readingListId = readingListId
    self.reguaTag = reguaTag
    self.relatedCron = relatedCron
    self.relatedTrigger = relatedTrigger
    self.sendWindow = sendWindow
    self.versao = versao
    self.vipGuardAction = vipGuardAction
    self.vipGuardLtv = vipGuardLtv
    self.vipGuardTag = vipGuardTag
  }

  enum CodingKeys: String, CodingKey {
    case analystAvoid = "analystAvoid"
    case analystMentions = "analystMentions"
    case analystTone = "analystTone"
    case consumer = "consumer"
    case hitlRequiredWhen = "hitlRequiredWhen"
    case messagePrefix = "messagePrefix"
    case messageSuffix = "messageSuffix"
    case objetivo = "objetivo"
    case priorityGlobal = "priorityGlobal"
    case producer = "producer"
    case readingListId = "readingListId"
    case reguaTag = "reguaTag"
    case relatedCron = "relatedCron"
    case relatedTrigger = "relatedTrigger"
    case sendWindow = "sendWindow"
    case versao = "versao"
    case vipGuardAction = "vipGuardAction"
    case vipGuardLtv = "vipGuardLtv"
    case vipGuardTag = "vipGuardTag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.analystAvoid {
      body["analystAvoid"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.analystMentions {
      body["analystMentions"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.analystTone {
      body["analystTone"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.consumer {
      body["consumer"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.hitlRequiredWhen {
      body["hitlRequiredWhen"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.messagePrefix {
      body["messagePrefix"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.messageSuffix {
      body["messageSuffix"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.objetivo {
      body["objetivo"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priorityGlobal {
      body["priorityGlobal"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.producer {
      body["producer"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.readingListId {
      body["readingListId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reguaTag {
      body["reguaTag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.relatedCron {
      body["relatedCron"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.relatedTrigger {
      body["relatedTrigger"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sendWindow {
      body["sendWindow"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.versao {
      body["versao"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.vipGuardAction {
      body["vipGuardAction"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.vipGuardLtv {
      body["vipGuardLtv"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.vipGuardTag {
      body["vipGuardTag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelineSetReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmPipelineShowOptions: Codable, Sendable {
  public var explain: Bool?

  public init(explain: Bool? = nil) {
    self.explain = explain
  }

  enum CodingKeys: String, CodingKey {
    case explain = "explain"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.explain {
      body["explain"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias CrmPipelineShowReturn = [String: RaviJSON]

public struct CrmPipelineStageAddOptions: Codable, Sendable {
  public var category: String?
  public var idempotencyKey: String?
  public var metadata: String?
  public var name: String?
  public var order: String?
  public var probability: String?
  public var terminal: Bool?

  public init(category: String? = nil, idempotencyKey: String? = nil, metadata: String? = nil, name: String? = nil, order: String? = nil, probability: String? = nil, terminal: Bool? = nil) {
    self.category = category
    self.idempotencyKey = idempotencyKey
    self.metadata = metadata
    self.name = name
    self.order = order
    self.probability = probability
    self.terminal = terminal
  }

  enum CodingKeys: String, CodingKey {
    case category = "category"
    case idempotencyKey = "idempotencyKey"
    case metadata = "metadata"
    case name = "name"
    case order = "order"
    case probability = "probability"
    case terminal = "terminal"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.category {
      body["category"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metadata {
      body["metadata"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.order {
      body["order"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.probability {
      body["probability"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.terminal {
      body["terminal"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelineStageAddReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmPipelineStageArchiveReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmPipelineStageListOptions: Codable, Sendable {
  public var includeArchived: Bool?
  public var limit: String?
  public var offset: String?

  public init(includeArchived: Bool? = nil, limit: String? = nil, offset: String? = nil) {
    self.includeArchived = includeArchived
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case includeArchived = "includeArchived"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.includeArchived {
      body["includeArchived"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelineStageListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CrmPipelineStageSetReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public typealias CrmPipelineStageShowReturn = [String: RaviJSON]

public struct CrmPipelineStageTopicAddOptions: Codable, Sendable {
  public var description: String?
  public var idempotencyKey: String?
  public var metadata: String?
  public var order: String?
  public var title: String?
  public var type: String?

  public init(description: String? = nil, idempotencyKey: String? = nil, metadata: String? = nil, order: String? = nil, title: String? = nil, type: String? = nil) {
    self.description = description
    self.idempotencyKey = idempotencyKey
    self.metadata = metadata
    self.order = order
    self.title = title
    self.type = type
  }

  enum CodingKeys: String, CodingKey {
    case description = "description"
    case idempotencyKey = "idempotencyKey"
    case metadata = "metadata"
    case order = "order"
    case title = "title"
    case type = "type"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metadata {
      body["metadata"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.order {
      body["order"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.type {
      body["type"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelineStageTopicAddReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmPipelineStageTopicArchiveReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmPipelineStageTopicSetReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmPipelineStageTopicsOptions: Codable, Sendable {
  public var includeArchived: Bool?
  public var limit: String?
  public var offset: String?

  public init(includeArchived: Bool? = nil, limit: String? = nil, offset: String? = nil) {
    self.includeArchived = includeArchived
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case includeArchived = "includeArchived"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.includeArchived {
      body["includeArchived"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelineStageTopicsReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CrmPipelineValidateOptions: Codable, Sendable {
  public var schemaJson: Bool?

  public init(schemaJson: Bool? = nil) {
    self.schemaJson = schemaJson
  }

  enum CodingKeys: String, CodingKey {
    case schemaJson = "schemaJson"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.schemaJson {
      body["schemaJson"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmPipelineValidateReturn: Codable, Sendable {
  public var errors: [RaviJSON]
  public var ok: Bool
  public var pipelineId: String
  public var schema: [String: RaviJSON]?
  public var warnings: [RaviJSON]

  public init(errors: [RaviJSON], ok: Bool, pipelineId: String, schema: [String: RaviJSON]? = nil, warnings: [RaviJSON]) {
    self.errors = errors
    self.ok = ok
    self.pipelineId = pipelineId
    self.schema = schema
    self.warnings = warnings
  }

  enum CodingKeys: String, CodingKey {
    case errors = "errors"
    case ok = "ok"
    case pipelineId = "pipelineId"
    case schema = "schema"
    case warnings = "warnings"
  }
}

public struct CrmTaskCancelOptions: Codable, Sendable {
  public var reason: String?

  public init(reason: String? = nil) {
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmTaskCancelReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmTaskCreateOptions: Codable, Sendable {
  public var account: String?
  public var body: String?
  public var confidence: String?
  public var contact: String?
  public var due: String?
  public var evidence: String?
  public var idempotencyKey: String?
  public var metadata: String?
  public var opportunity: String?
  public var owner: String?
  public var priority: String?
  public var source: String?
  public var taskType: String?

  public init(account: String? = nil, body: String? = nil, confidence: String? = nil, contact: String? = nil, due: String? = nil, evidence: String? = nil, idempotencyKey: String? = nil, metadata: String? = nil, opportunity: String? = nil, owner: String? = nil, priority: String? = nil, source: String? = nil, taskType: String? = nil) {
    self.account = account
    self.body = body
    self.confidence = confidence
    self.contact = contact
    self.due = due
    self.evidence = evidence
    self.idempotencyKey = idempotencyKey
    self.metadata = metadata
    self.opportunity = opportunity
    self.owner = owner
    self.priority = priority
    self.source = source
    self.taskType = taskType
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case body = "body"
    case confidence = "confidence"
    case contact = "contact"
    case due = "due"
    case evidence = "evidence"
    case idempotencyKey = "idempotencyKey"
    case metadata = "metadata"
    case opportunity = "opportunity"
    case owner = "owner"
    case priority = "priority"
    case source = "source"
    case taskType = "taskType"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.body {
      body["body"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.confidence {
      body["confidence"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.due {
      body["due"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.evidence {
      body["evidence"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metadata {
      body["metadata"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.opportunity {
      body["opportunity"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.taskType {
      body["taskType"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmTaskCreateReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmTaskDoneReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CrmTaskListOptions: Codable, Sendable {
  public var account: String?
  public var contact: String?
  public var dueAfter: String?
  public var dueBefore: String?
  public var dueToday: Bool?
  public var limit: String?
  public var offset: String?
  public var opportunity: String?
  public var owner: String?
  public var status: String?
  public var taskType: String?

  public init(account: String? = nil, contact: String? = nil, dueAfter: String? = nil, dueBefore: String? = nil, dueToday: Bool? = nil, limit: String? = nil, offset: String? = nil, opportunity: String? = nil, owner: String? = nil, status: String? = nil, taskType: String? = nil) {
    self.account = account
    self.contact = contact
    self.dueAfter = dueAfter
    self.dueBefore = dueBefore
    self.dueToday = dueToday
    self.limit = limit
    self.offset = offset
    self.opportunity = opportunity
    self.owner = owner
    self.status = status
    self.taskType = taskType
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case contact = "contact"
    case dueAfter = "dueAfter"
    case dueBefore = "dueBefore"
    case dueToday = "dueToday"
    case limit = "limit"
    case offset = "offset"
    case opportunity = "opportunity"
    case owner = "owner"
    case status = "status"
    case taskType = "taskType"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dueAfter {
      body["dueAfter"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dueBefore {
      body["dueBefore"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dueToday {
      body["dueToday"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.opportunity {
      body["opportunity"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.taskType {
      body["taskType"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmTaskListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CrmTaskShowReturn: Codable, Sendable {
  public var target: String
  public var task: [String: RaviJSON]

  public init(target: String, task: [String: RaviJSON]) {
    self.target = target
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case target = "target"
    case task = "task"
  }
}

public struct CrmTaskSnoozeOptions: Codable, Sendable {
  public var reason: String?
  public var until: String?

  public init(reason: String? = nil, until: String? = nil) {
    self.reason = reason
    self.until = until
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
    case until = "until"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.until {
      body["until"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CrmTaskSnoozeReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String

  public init(changedCount: Double, status: String) {
    self.changedCount = changedCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
  }
}

public struct CronAddOptions: Codable, Sendable {
  public var account: String?
  public var agent: String?
  public var at: String?
  public var cron: String?
  public var deleteAfter: Bool?
  public var description: String?
  public var envFile: String?
  public var every: String?
  public var exec: String?
  public var idempotencyKey: String?
  public var isolated: Bool?
  public var message: String?
  public var onError: String?
  public var shell: String?
  public var timeout: String?
  public var tz: String?

  public init(account: String? = nil, agent: String? = nil, at: String? = nil, cron: String? = nil, deleteAfter: Bool? = nil, description: String? = nil, envFile: String? = nil, every: String? = nil, exec: String? = nil, idempotencyKey: String? = nil, isolated: Bool? = nil, message: String? = nil, onError: String? = nil, shell: String? = nil, timeout: String? = nil, tz: String? = nil) {
    self.account = account
    self.agent = agent
    self.at = at
    self.cron = cron
    self.deleteAfter = deleteAfter
    self.description = description
    self.envFile = envFile
    self.every = every
    self.exec = exec
    self.idempotencyKey = idempotencyKey
    self.isolated = isolated
    self.message = message
    self.onError = onError
    self.shell = shell
    self.timeout = timeout
    self.tz = tz
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case agent = "agent"
    case at = "at"
    case cron = "cron"
    case deleteAfter = "deleteAfter"
    case description = "description"
    case envFile = "envFile"
    case every = "every"
    case exec = "exec"
    case idempotencyKey = "idempotencyKey"
    case isolated = "isolated"
    case message = "message"
    case onError = "onError"
    case shell = "shell"
    case timeout = "timeout"
    case tz = "tz"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.at {
      body["at"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cron {
      body["cron"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.deleteAfter {
      body["deleteAfter"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.envFile {
      body["envFile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.every {
      body["every"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.exec {
      body["exec"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.isolated {
      body["isolated"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.onError {
      body["onError"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.shell {
      body["shell"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.timeout {
      body["timeout"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tz {
      body["tz"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CronAddReturn: Codable, Sendable {
  public var changedCount: Double
  public var job: RaviJSON
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, job: RaviJSON, status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.job = job
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case job = "job"
    case status = "status"
    case target = "target"
  }
}

public struct CronDisableReturn: Codable, Sendable {
  public var changedCount: Double
  public var job: RaviJSON
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, job: RaviJSON, status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.job = job
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case job = "job"
    case status = "status"
    case target = "target"
  }
}

public struct CronEnableReturn: Codable, Sendable {
  public var changedCount: Double
  public var job: RaviJSON
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, job: RaviJSON, status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.job = job
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case job = "job"
    case status = "status"
    case target = "target"
  }
}

public struct CronListOptions: Codable, Sendable {
  public var agent: String?
  public var allAgents: Bool?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(agent: String? = nil, allAgents: Bool? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.agent = agent
    self.allAgents = allAgents
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case allAgents = "allAgents"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.allAgents {
      body["allAgents"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CronListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var jobs: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], jobs: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.jobs = jobs
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case jobs = "jobs"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct CronRmOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CronRmReturn: Codable, Sendable {
  public var changedCount: Double
  public var job: RaviJSON
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, job: RaviJSON, status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.job = job
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case job = "job"
    case status = "status"
    case target = "target"
  }
}

public struct CronRunOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct CronRunReturn: Codable, Sendable {
  public var changedCount: Double
  public var job: RaviJSON
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, job: RaviJSON, status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.job = job
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case job = "job"
    case status = "status"
    case target = "target"
  }
}

public struct CronSetReturn: Codable, Sendable {
  public var changedCount: Double
  public var job: RaviJSON
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, job: RaviJSON, status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.job = job
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case job = "job"
    case status = "status"
    case target = "target"
  }
}

public struct CronShowReturn: Codable, Sendable {
  public var job: [String: RaviJSON]

  public init(job: [String: RaviJSON]) {
    self.job = job
  }

  enum CodingKeys: String, CodingKey {
    case job = "job"
  }
}

public struct DaemonEnvReturn: Codable, Sendable {
  public var action: String
  public var created: Bool
  public var existedBefore: Bool
  public var openedEditor: Bool
  public var path: String

  public init(action: String, created: Bool, existedBefore: Bool, openedEditor: Bool, path: String) {
    self.action = action
    self.created = created
    self.existedBefore = existedBefore
    self.openedEditor = openedEditor
    self.path = path
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case created = "created"
    case existedBefore = "existedBefore"
    case openedEditor = "openedEditor"
    case path = "path"
  }
}

public struct DaemonInitAdminKeyOptions: Codable, Sendable {
  public var fromEnv: Bool?
  public var label: String?
  public var noStore: Bool?
  public var printOnly: Bool?

  public init(fromEnv: Bool? = nil, label: String? = nil, noStore: Bool? = nil, printOnly: Bool? = nil) {
    self.fromEnv = fromEnv
    self.label = label
    self.noStore = noStore
    self.printOnly = printOnly
  }

  enum CodingKeys: String, CodingKey {
    case fromEnv = "fromEnv"
    case label = "label"
    case noStore = "noStore"
    case printOnly = "printOnly"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fromEnv {
      body["fromEnv"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.noStore {
      body["noStore"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.printOnly {
      body["printOnly"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DaemonInitAdminKeyReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool

  public init(action: String, changed: Bool) {
    self.action = action
    self.changed = changed
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
  }
}

public struct DaemonInstallReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool

  public init(action: String, changed: Bool) {
    self.action = action
    self.changed = changed
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
  }
}

public struct DaemonLogsOptions: Codable, Sendable {
  public var clear: Bool?
  public var execute: Bool?
  public var follow: Bool?
  public var path: Bool?
  public var tail: String?

  public init(clear: Bool? = nil, execute: Bool? = nil, follow: Bool? = nil, path: Bool? = nil, tail: String? = nil) {
    self.clear = clear
    self.execute = execute
    self.follow = follow
    self.path = path
    self.tail = tail
  }

  enum CodingKeys: String, CodingKey {
    case clear = "clear"
    case execute = "execute"
    case follow = "follow"
    case path = "path"
    case tail = "tail"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.clear {
      body["clear"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.follow {
      body["follow"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.path {
      body["path"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tail {
      body["tail"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DaemonLogsReturn: Codable, Sendable {
  public var action: String

  public init(action: String) {
    self.action = action
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
  }
}

public struct DaemonRestartOptions: Codable, Sendable {
  public var build: Bool?
  public var message: String?

  public init(build: Bool? = nil, message: String? = nil) {
    self.build = build
    self.message = message
  }

  enum CodingKeys: String, CodingKey {
    case build = "build"
    case message = "message"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.build {
      body["build"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DaemonRestartReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool

  public init(action: String, changed: Bool) {
    self.action = action
    self.changed = changed
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
  }
}

public struct DaemonStartReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool

  public init(action: String, changed: Bool) {
    self.action = action
    self.changed = changed
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
  }
}

public struct DaemonStatusReturn: Codable, Sendable {
  public var infrastructure: [String: RaviJSON]
  public var pm2Available: Bool
  public var processName: String
  public var processes: [[String: RaviJSON]]
  public var ravi: [String: RaviJSON]
  public var runtime: RaviJSON

  public init(infrastructure: [String: RaviJSON], pm2Available: Bool, processName: String, processes: [[String: RaviJSON]], ravi: [String: RaviJSON], runtime: RaviJSON) {
    self.infrastructure = infrastructure
    self.pm2Available = pm2Available
    self.processName = processName
    self.processes = processes
    self.ravi = ravi
    self.runtime = runtime
  }

  enum CodingKeys: String, CodingKey {
    case infrastructure = "infrastructure"
    case pm2Available = "pm2Available"
    case processName = "processName"
    case processes = "processes"
    case ravi = "ravi"
    case runtime = "runtime"
  }
}

public struct DaemonStopReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool

  public init(action: String, changed: Bool) {
    self.action = action
    self.changed = changed
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
  }
}

public struct DaemonUninstallReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool

  public init(action: String, changed: Bool) {
    self.action = action
    self.changed = changed
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
  }
}

public struct DevinAuthCheckReturn: Codable, Sendable {
  public var baseUrl: String
  public var configuredOrgId: String?
  public var ok: Bool
  public var self_: RaviJSON

  public init(baseUrl: String, configuredOrgId: String? = nil, ok: Bool, self_: RaviJSON) {
    self.baseUrl = baseUrl
    self.configuredOrgId = configuredOrgId
    self.ok = ok
    self.self_ = self_
  }

  enum CodingKeys: String, CodingKey {
    case baseUrl = "baseUrl"
    case configuredOrgId = "configuredOrgId"
    case ok = "ok"
    case self_ = "self"
  }
}

public struct DevinSessionsArchiveOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsArchiveReturn: Codable, Sendable {
  public var session: RaviJSON
  public var status: String

  public init(session: RaviJSON, status: String) {
    self.session = session
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case session = "session"
    case status = "status"
  }
}

public struct DevinSessionsAttachmentsOptions: Codable, Sendable {
  public var cached: Bool?

  public init(cached: Bool? = nil) {
    self.cached = cached
  }

  enum CodingKeys: String, CodingKey {
    case cached = "cached"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cached {
      body["cached"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsAttachmentsReturn: Codable, Sendable {
  public var attachments: [RaviJSON]
  public var devinId: String
  public var total: Double

  public init(attachments: [RaviJSON], devinId: String, total: Double) {
    self.attachments = attachments
    self.devinId = devinId
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case attachments = "attachments"
    case devinId = "devinId"
    case total = "total"
  }
}

public struct DevinSessionsCreateOptions: Codable, Sendable {
  public var advancedMode: String?
  public var asUser: String?
  public var attachmentUrl: [String]?
  public var bypassApproval: Bool?
  public var childPlaybook: String?
  public var devinId: String?
  public var devinMode: String?
  public var execute: Bool?
  public var knowledge: [String]?
  public var maxAcu: String?
  public var noMaxAcuLimit: Bool?
  public var noResumable: Bool?
  public var platform: String?
  public var playbook: String?
  public var project: String?
  public var prompt: String?
  public var promptFile: String?
  public var proxRun: String?
  public var repo: [String]?
  public var resumable: Bool?
  public var secret: [String]?
  public var sessionLink: [String]?
  public var sessionSecret: [String]?
  public var structuredOutputRequired: Bool?
  public var structuredOutputSchema: String?
  public var tag: [String]?
  public var task: String?
  public var title: String?

  public init(advancedMode: String? = nil, asUser: String? = nil, attachmentUrl: [String]? = nil, bypassApproval: Bool? = nil, childPlaybook: String? = nil, devinId: String? = nil, devinMode: String? = nil, execute: Bool? = nil, knowledge: [String]? = nil, maxAcu: String? = nil, noMaxAcuLimit: Bool? = nil, noResumable: Bool? = nil, platform: String? = nil, playbook: String? = nil, project: String? = nil, prompt: String? = nil, promptFile: String? = nil, proxRun: String? = nil, repo: [String]? = nil, resumable: Bool? = nil, secret: [String]? = nil, sessionLink: [String]? = nil, sessionSecret: [String]? = nil, structuredOutputRequired: Bool? = nil, structuredOutputSchema: String? = nil, tag: [String]? = nil, task: String? = nil, title: String? = nil) {
    self.advancedMode = advancedMode
    self.asUser = asUser
    self.attachmentUrl = attachmentUrl
    self.bypassApproval = bypassApproval
    self.childPlaybook = childPlaybook
    self.devinId = devinId
    self.devinMode = devinMode
    self.execute = execute
    self.knowledge = knowledge
    self.maxAcu = maxAcu
    self.noMaxAcuLimit = noMaxAcuLimit
    self.noResumable = noResumable
    self.platform = platform
    self.playbook = playbook
    self.project = project
    self.prompt = prompt
    self.promptFile = promptFile
    self.proxRun = proxRun
    self.repo = repo
    self.resumable = resumable
    self.secret = secret
    self.sessionLink = sessionLink
    self.sessionSecret = sessionSecret
    self.structuredOutputRequired = structuredOutputRequired
    self.structuredOutputSchema = structuredOutputSchema
    self.tag = tag
    self.task = task
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case advancedMode = "advancedMode"
    case asUser = "asUser"
    case attachmentUrl = "attachmentUrl"
    case bypassApproval = "bypassApproval"
    case childPlaybook = "childPlaybook"
    case devinId = "devinId"
    case devinMode = "devinMode"
    case execute = "execute"
    case knowledge = "knowledge"
    case maxAcu = "maxAcu"
    case noMaxAcuLimit = "noMaxAcuLimit"
    case noResumable = "noResumable"
    case platform = "platform"
    case playbook = "playbook"
    case project = "project"
    case prompt = "prompt"
    case promptFile = "promptFile"
    case proxRun = "proxRun"
    case repo = "repo"
    case resumable = "resumable"
    case secret = "secret"
    case sessionLink = "sessionLink"
    case sessionSecret = "sessionSecret"
    case structuredOutputRequired = "structuredOutputRequired"
    case structuredOutputSchema = "structuredOutputSchema"
    case tag = "tag"
    case task = "task"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.advancedMode {
      body["advancedMode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.asUser {
      body["asUser"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.attachmentUrl {
      body["attachmentUrl"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.bypassApproval {
      body["bypassApproval"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.childPlaybook {
      body["childPlaybook"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.devinId {
      body["devinId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.devinMode {
      body["devinMode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.knowledge {
      body["knowledge"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.maxAcu {
      body["maxAcu"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.noMaxAcuLimit {
      body["noMaxAcuLimit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.noResumable {
      body["noResumable"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.platform {
      body["platform"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.playbook {
      body["playbook"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.prompt {
      body["prompt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.promptFile {
      body["promptFile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.proxRun {
      body["proxRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.repo {
      body["repo"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.resumable {
      body["resumable"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.secret {
      body["secret"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sessionLink {
      body["sessionLink"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sessionSecret {
      body["sessionSecret"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.structuredOutputRequired {
      body["structuredOutputRequired"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.structuredOutputSchema {
      body["structuredOutputSchema"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsCreateReturn: Codable, Sendable {
  public var devinMode: RaviJSON?
  public var maxAcuLimit: RaviJSON
  public var maxAcuLimitSource: String
  public var platform: RaviJSON?
  public var resumable: RaviJSON?
  public var session: RaviJSON
  public var status: String

  public init(devinMode: RaviJSON? = nil, maxAcuLimit: RaviJSON, maxAcuLimitSource: String, platform: RaviJSON? = nil, resumable: RaviJSON? = nil, session: RaviJSON, status: String) {
    self.devinMode = devinMode
    self.maxAcuLimit = maxAcuLimit
    self.maxAcuLimitSource = maxAcuLimitSource
    self.platform = platform
    self.resumable = resumable
    self.session = session
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case devinMode = "devinMode"
    case maxAcuLimit = "maxAcuLimit"
    case maxAcuLimitSource = "maxAcuLimitSource"
    case platform = "platform"
    case resumable = "resumable"
    case session = "session"
    case status = "status"
  }
}

public struct DevinSessionsInsightsOptions: Codable, Sendable {
  public var execute: Bool?
  public var generate: Bool?

  public init(execute: Bool? = nil, generate: Bool? = nil) {
    self.execute = execute
    self.generate = generate
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case generate = "generate"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.generate {
      body["generate"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsInsightsReturn: Codable, Sendable {
  public var insights: RaviJSON
  public var session: RaviJSON
  public var summary: RaviJSON

  public init(insights: RaviJSON, session: RaviJSON, summary: RaviJSON) {
    self.insights = insights
    self.session = session
    self.summary = summary
  }

  enum CodingKeys: String, CodingKey {
    case insights = "insights"
    case session = "session"
    case summary = "summary"
  }
}

public struct DevinSessionsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var remote: Bool?
  public var status: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, remote: Bool? = nil, status: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.remote = remote
    self.status = status
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case remote = "remote"
    case status = "status"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.remote {
      body["remote"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsListReturn: Codable, Sendable {
  public var hasNextPage: Bool?
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var sessions: [RaviJSON]
  public var source: String
  public var total: Double

  public init(hasNextPage: Bool? = nil, items: [[String: RaviJSON]], pagination: RaviJSON, sessions: [RaviJSON], source: String, total: Double) {
    self.hasNextPage = hasNextPage
    self.items = items
    self.pagination = pagination
    self.sessions = sessions
    self.source = source
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case hasNextPage = "hasNextPage"
    case items = "items"
    case pagination = "pagination"
    case sessions = "sessions"
    case source = "source"
    case total = "total"
  }
}

public struct DevinSessionsMessagesOptions: Codable, Sendable {
  public var cached: Bool?

  public init(cached: Bool? = nil) {
    self.cached = cached
  }

  enum CodingKeys: String, CodingKey {
    case cached = "cached"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cached {
      body["cached"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsMessagesReturn: Codable, Sendable {
  public var devinId: String
  public var messages: [RaviJSON]
  public var total: Double

  public init(devinId: String, messages: [RaviJSON], total: Double) {
    self.devinId = devinId
    self.messages = messages
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case devinId = "devinId"
    case messages = "messages"
    case total = "total"
  }
}

public struct DevinSessionsSendOptions: Codable, Sendable {
  public var asUser: String?
  public var execute: Bool?

  public init(asUser: String? = nil, execute: Bool? = nil) {
    self.asUser = asUser
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case asUser = "asUser"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.asUser {
      body["asUser"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsSendReturn: Codable, Sendable {
  public var session: RaviJSON
  public var status: String

  public init(session: RaviJSON, status: String) {
    self.session = session
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case session = "session"
    case status = "status"
  }
}

public struct DevinSessionsShowOptions: Codable, Sendable {
  public var sync: Bool?

  public init(sync: Bool? = nil) {
    self.sync = sync
  }

  enum CodingKeys: String, CodingKey {
    case sync = "sync"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.sync {
      body["sync"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsShowReturn: Codable, Sendable {
  public var session: RaviJSON

  public init(session: RaviJSON) {
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case session = "session"
  }
}

public struct DevinSessionsSyncOptions: Codable, Sendable {
  public var artifacts: Bool?
  public var insights: Bool?

  public init(artifacts: Bool? = nil, insights: Bool? = nil) {
    self.artifacts = artifacts
    self.insights = insights
  }

  enum CodingKeys: String, CodingKey {
    case artifacts = "artifacts"
    case insights = "insights"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.artifacts {
      body["artifacts"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.insights {
      body["insights"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsSyncReturn: Codable, Sendable {
  public var artifacts: [String]
  public var attachments: Double
  public var insights: RaviJSON
  public var messages: Double
  public var session: RaviJSON

  public init(artifacts: [String], attachments: Double, insights: RaviJSON, messages: Double, session: RaviJSON) {
    self.artifacts = artifacts
    self.attachments = attachments
    self.insights = insights
    self.messages = messages
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case artifacts = "artifacts"
    case attachments = "attachments"
    case insights = "insights"
    case messages = "messages"
    case session = "session"
  }
}

public struct DevinSessionsTerminateOptions: Codable, Sendable {
  public var archive: Bool?

  public init(archive: Bool? = nil) {
    self.archive = archive
  }

  enum CodingKeys: String, CodingKey {
    case archive = "archive"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.archive {
      body["archive"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct DevinSessionsTerminateReturn: Codable, Sendable {
  public var archive: Bool
  public var session: RaviJSON
  public var status: String

  public init(archive: Bool, session: RaviJSON, status: String) {
    self.archive = archive
    self.session = session
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case archive = "archive"
    case session = "session"
    case status = "status"
  }
}

public struct EvalRunOptions: Codable, Sendable {
  public var output: String?

  public init(output: String? = nil) {
    self.output = output
  }

  enum CodingKeys: String, CodingKey {
    case output = "output"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.output {
      body["output"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct EvalRunReturn: Codable, Sendable {
  public var execution: [String: RaviJSON]
  public var grade: [String: RaviJSON]
  public var outputDir: String
  public var runId: String
  public var session: [String: RaviJSON]

  public init(execution: [String: RaviJSON], grade: [String: RaviJSON], outputDir: String, runId: String, session: [String: RaviJSON]) {
    self.execution = execution
    self.grade = grade
    self.outputDir = outputDir
    self.runId = runId
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case execution = "execution"
    case grade = "grade"
    case outputDir = "outputDir"
    case runId = "runId"
    case session = "session"
  }
}

public struct FeedbackSendOptions: Codable, Sendable {
  public var console: String?
  public var execute: Bool?
  public var kind: String?
  public var metadataJson: String?
  public var project: String?
  public var severity: String?
  public var surface: String?
  public var tag: String?
  public var title: String?
  public var url: String?

  public init(console: String? = nil, execute: Bool? = nil, kind: String? = nil, metadataJson: String? = nil, project: String? = nil, severity: String? = nil, surface: String? = nil, tag: String? = nil, title: String? = nil, url: String? = nil) {
    self.console = console
    self.execute = execute
    self.kind = kind
    self.metadataJson = metadataJson
    self.project = project
    self.severity = severity
    self.surface = surface
    self.tag = tag
    self.title = title
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case execute = "execute"
    case kind = "kind"
    case metadataJson = "metadataJson"
    case project = "project"
    case severity = "severity"
    case surface = "surface"
    case tag = "tag"
    case title = "title"
    case url = "url"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metadataJson {
      body["metadataJson"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.severity {
      body["severity"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.surface {
      body["surface"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.url {
      body["url"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct FeedbackSendReturn: Codable, Sendable {
  public var consoleUrl: String
  public var feedback: [String: RaviJSON]
  public var success: Bool
  public var url: String

  public init(consoleUrl: String, feedback: [String: RaviJSON], success: Bool, url: String) {
    self.consoleUrl = consoleUrl
    self.feedback = feedback
    self.success = success
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case consoleUrl = "consoleUrl"
    case feedback = "feedback"
    case success = "success"
    case url = "url"
  }
}

public struct GmailListOptions: Codable, Sendable {
  public var connector: String?
  public var cursor: String?
  public var label: String?
  public var max: String?
  public var q: String?

  public init(connector: String? = nil, cursor: String? = nil, label: String? = nil, max: String? = nil, q: String? = nil) {
    self.connector = connector
    self.cursor = cursor
    self.label = label
    self.max = max
    self.q = q
  }

  enum CodingKeys: String, CodingKey {
    case connector = "connector"
    case cursor = "cursor"
    case label = "label"
    case max = "max"
    case q = "q"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connector {
      body["connector"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.max {
      body["max"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.q {
      body["q"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct GmailListReturn: Codable, Sendable {
  public var capability: String
  public var refreshed: Bool
  public var result: RaviJSON?

  public init(capability: String, refreshed: Bool, result: RaviJSON? = nil) {
    self.capability = capability
    self.refreshed = refreshed
    self.result = result
  }

  enum CodingKeys: String, CodingKey {
    case capability = "capability"
    case refreshed = "refreshed"
    case result = "result"
  }
}

public struct GmailReadOptions: Codable, Sendable {
  public var connector: String?
  public var format: String?

  public init(connector: String? = nil, format: String? = nil) {
    self.connector = connector
    self.format = format
  }

  enum CodingKeys: String, CodingKey {
    case connector = "connector"
    case format = "format"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connector {
      body["connector"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.format {
      body["format"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct GmailReadReturn: Codable, Sendable {
  public var capability: String
  public var refreshed: Bool
  public var result: RaviJSON?

  public init(capability: String, refreshed: Bool, result: RaviJSON? = nil) {
    self.capability = capability
    self.refreshed = refreshed
    self.result = result
  }

  enum CodingKeys: String, CodingKey {
    case capability = "capability"
    case refreshed = "refreshed"
    case result = "result"
  }
}

public struct HeartbeatDisableReturn: Codable, Sendable {
  public var agent: RaviJSON
  public var changedCount: Double
  public var heartbeat: RaviJSON
  public var heartbeatFile: String
  public var heartbeatFileExists: Bool
  public var property: String?
  public var status: String
  public var target: RaviJSON
  public var value: RaviJSON?

  public init(agent: RaviJSON, changedCount: Double, heartbeat: RaviJSON, heartbeatFile: String, heartbeatFileExists: Bool, property: String? = nil, status: String, target: RaviJSON, value: RaviJSON? = nil) {
    self.agent = agent
    self.changedCount = changedCount
    self.heartbeat = heartbeat
    self.heartbeatFile = heartbeatFile
    self.heartbeatFileExists = heartbeatFileExists
    self.property = property
    self.status = status
    self.target = target
    self.value = value
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case changedCount = "changedCount"
    case heartbeat = "heartbeat"
    case heartbeatFile = "heartbeatFile"
    case heartbeatFileExists = "heartbeatFileExists"
    case property = "property"
    case status = "status"
    case target = "target"
    case value = "value"
  }
}

public struct HeartbeatEnableReturn: Codable, Sendable {
  public var agent: RaviJSON
  public var changedCount: Double
  public var heartbeat: RaviJSON
  public var heartbeatFile: String
  public var heartbeatFileExists: Bool
  public var property: String?
  public var status: String
  public var target: RaviJSON
  public var value: RaviJSON?

  public init(agent: RaviJSON, changedCount: Double, heartbeat: RaviJSON, heartbeatFile: String, heartbeatFileExists: Bool, property: String? = nil, status: String, target: RaviJSON, value: RaviJSON? = nil) {
    self.agent = agent
    self.changedCount = changedCount
    self.heartbeat = heartbeat
    self.heartbeatFile = heartbeatFile
    self.heartbeatFileExists = heartbeatFileExists
    self.property = property
    self.status = status
    self.target = target
    self.value = value
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case changedCount = "changedCount"
    case heartbeat = "heartbeat"
    case heartbeatFile = "heartbeatFile"
    case heartbeatFileExists = "heartbeatFileExists"
    case property = "property"
    case status = "status"
    case target = "target"
    case value = "value"
  }
}

public struct HeartbeatSetReturn: Codable, Sendable {
  public var agent: RaviJSON
  public var changedCount: Double
  public var heartbeat: RaviJSON
  public var heartbeatFile: String
  public var heartbeatFileExists: Bool
  public var property: String?
  public var status: String
  public var target: RaviJSON
  public var value: RaviJSON?

  public init(agent: RaviJSON, changedCount: Double, heartbeat: RaviJSON, heartbeatFile: String, heartbeatFileExists: Bool, property: String? = nil, status: String, target: RaviJSON, value: RaviJSON? = nil) {
    self.agent = agent
    self.changedCount = changedCount
    self.heartbeat = heartbeat
    self.heartbeatFile = heartbeatFile
    self.heartbeatFileExists = heartbeatFileExists
    self.property = property
    self.status = status
    self.target = target
    self.value = value
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case changedCount = "changedCount"
    case heartbeat = "heartbeat"
    case heartbeatFile = "heartbeatFile"
    case heartbeatFileExists = "heartbeatFileExists"
    case property = "property"
    case status = "status"
    case target = "target"
    case value = "value"
  }
}

public struct HeartbeatShowReturn: Codable, Sendable {
  public var agent: RaviJSON
  public var heartbeat: RaviJSON
  public var heartbeatFile: String
  public var heartbeatFileExists: Bool

  public init(agent: RaviJSON, heartbeat: RaviJSON, heartbeatFile: String, heartbeatFileExists: Bool) {
    self.agent = agent
    self.heartbeat = heartbeat
    self.heartbeatFile = heartbeatFile
    self.heartbeatFileExists = heartbeatFileExists
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case heartbeat = "heartbeat"
    case heartbeatFile = "heartbeatFile"
    case heartbeatFileExists = "heartbeatFileExists"
  }
}

public struct HeartbeatStatusOptions: Codable, Sendable {
  public var fields: String?

  public init(fields: String? = nil) {
    self.fields = fields
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct HeartbeatStatusReturn: Codable, Sendable {
  public var agents: [RaviJSON]
  public var total: Double

  public init(agents: [RaviJSON], total: Double) {
    self.agents = agents
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case agents = "agents"
    case total = "total"
  }
}

public struct HeartbeatTriggerOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct HeartbeatTriggerReturn: Codable, Sendable {
  public var changedCount: Double
  public var heartbeatFile: String
  public var reason: String?
  public var sessionName: String?
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, heartbeatFile: String, reason: String? = nil, sessionName: String? = nil, status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.heartbeatFile = heartbeatFile
    self.reason = reason
    self.sessionName = sessionName
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case heartbeatFile = "heartbeatFile"
    case reason = "reason"
    case sessionName = "sessionName"
    case status = "status"
    case target = "target"
  }
}

public struct HooksCreateOptions: Codable, Sendable {
  public var action: String?
  public var agent: String?
  public var async_: Bool?
  public var barrier: String?
  public var cooldown: String?
  public var dedupeKey: String?
  public var disabled: Bool?
  public var event: String?
  public var matcher: String?
  public var message: String?
  public var role: String?
  public var scope: String?
  public var session: String?
  public var targetSession: String?
  public var targetTask: String?
  public var task: String?
  public var workspace: String?

  public init(action: String? = nil, agent: String? = nil, async_: Bool? = nil, barrier: String? = nil, cooldown: String? = nil, dedupeKey: String? = nil, disabled: Bool? = nil, event: String? = nil, matcher: String? = nil, message: String? = nil, role: String? = nil, scope: String? = nil, session: String? = nil, targetSession: String? = nil, targetTask: String? = nil, task: String? = nil, workspace: String? = nil) {
    self.action = action
    self.agent = agent
    self.async_ = async_
    self.barrier = barrier
    self.cooldown = cooldown
    self.dedupeKey = dedupeKey
    self.disabled = disabled
    self.event = event
    self.matcher = matcher
    self.message = message
    self.role = role
    self.scope = scope
    self.session = session
    self.targetSession = targetSession
    self.targetTask = targetTask
    self.task = task
    self.workspace = workspace
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case agent = "agent"
    case async_ = "async"
    case barrier = "barrier"
    case cooldown = "cooldown"
    case dedupeKey = "dedupeKey"
    case disabled = "disabled"
    case event = "event"
    case matcher = "matcher"
    case message = "message"
    case role = "role"
    case scope = "scope"
    case session = "session"
    case targetSession = "targetSession"
    case targetTask = "targetTask"
    case task = "task"
    case workspace = "workspace"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.action {
      body["action"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.async_ {
      body["async"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.barrier {
      body["barrier"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cooldown {
      body["cooldown"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dedupeKey {
      body["dedupeKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.disabled {
      body["disabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.event {
      body["event"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.matcher {
      body["matcher"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.targetSession {
      body["targetSession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.targetTask {
      body["targetTask"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workspace {
      body["workspace"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct HooksCreateReturn: Codable, Sendable {
  public var changedCount: Double
  public var hook: [String: RaviJSON]
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, hook: [String: RaviJSON], status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.hook = hook
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case hook = "hook"
    case status = "status"
    case target = "target"
  }
}

public struct HooksDisableReturn: Codable, Sendable {
  public var changedCount: Double
  public var hook: [String: RaviJSON]
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, hook: [String: RaviJSON], status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.hook = hook
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case hook = "hook"
    case status = "status"
    case target = "target"
  }
}

public struct HooksEnableReturn: Codable, Sendable {
  public var changedCount: Double
  public var hook: [String: RaviJSON]
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, hook: [String: RaviJSON], status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.hook = hook
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case hook = "hook"
    case status = "status"
    case target = "target"
  }
}

public struct HooksListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct HooksListReturn: Codable, Sendable {
  public var hooks: [[String: RaviJSON]]
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(hooks: [[String: RaviJSON]], items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.hooks = hooks
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case hooks = "hooks"
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct HooksRmOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct HooksRmReturn: Codable, Sendable {
  public var changedCount: Double
  public var hook: [String: RaviJSON]
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, hook: [String: RaviJSON], status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.hook = hook
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case hook = "hook"
    case status = "status"
    case target = "target"
  }
}

public struct HooksShowReturn: Codable, Sendable {
  public var hook: [String: RaviJSON]

  public init(hook: [String: RaviJSON]) {
    self.hook = hook
  }

  enum CodingKeys: String, CodingKey {
    case hook = "hook"
  }
}

public struct HooksTestOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias HooksTestReturn = [String: RaviJSON]

public struct ImageAtlasSplitOptions: Codable, Sendable {
  public var account: String?
  public var background: String?
  public var caption: String?
  public var channel: String?
  public var cols: String?
  public var execute: Bool?
  public var fit: String?
  public var fuzz: String?
  public var mode: String?
  public var names: String?
  public var output: String?
  public var pad: String?
  public var parentArtifact: String?
  public var rows: String?
  public var send: Bool?
  public var size: String?
  public var threadId: String?
  public var to: String?

  public init(account: String? = nil, background: String? = nil, caption: String? = nil, channel: String? = nil, cols: String? = nil, execute: Bool? = nil, fit: String? = nil, fuzz: String? = nil, mode: String? = nil, names: String? = nil, output: String? = nil, pad: String? = nil, parentArtifact: String? = nil, rows: String? = nil, send: Bool? = nil, size: String? = nil, threadId: String? = nil, to: String? = nil) {
    self.account = account
    self.background = background
    self.caption = caption
    self.channel = channel
    self.cols = cols
    self.execute = execute
    self.fit = fit
    self.fuzz = fuzz
    self.mode = mode
    self.names = names
    self.output = output
    self.pad = pad
    self.parentArtifact = parentArtifact
    self.rows = rows
    self.send = send
    self.size = size
    self.threadId = threadId
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case background = "background"
    case caption = "caption"
    case channel = "channel"
    case cols = "cols"
    case execute = "execute"
    case fit = "fit"
    case fuzz = "fuzz"
    case mode = "mode"
    case names = "names"
    case output = "output"
    case pad = "pad"
    case parentArtifact = "parentArtifact"
    case rows = "rows"
    case send = "send"
    case size = "size"
    case threadId = "threadId"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.background {
      body["background"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.caption {
      body["caption"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cols {
      body["cols"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fit {
      body["fit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fuzz {
      body["fuzz"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mode {
      body["mode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.names {
      body["names"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.output {
      body["output"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.pad {
      body["pad"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.parentArtifact {
      body["parentArtifact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.rows {
      body["rows"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.send {
      body["send"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.size {
      body["size"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadId {
      body["threadId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ImageAtlasSplitReturn: Codable, Sendable {
  public var artifactId: String
  public var artifact_id: String
  public var crops: [[String: RaviJSON]]
  public var manifestPath: String
  public var outputDir: String
  public var parentArtifactId: RaviJSON
  public var sent: [[String: RaviJSON]]
  public var success: Bool

  public init(artifactId: String, artifact_id: String, crops: [[String: RaviJSON]], manifestPath: String, outputDir: String, parentArtifactId: RaviJSON, sent: [[String: RaviJSON]], success: Bool) {
    self.artifactId = artifactId
    self.artifact_id = artifact_id
    self.crops = crops
    self.manifestPath = manifestPath
    self.outputDir = outputDir
    self.parentArtifactId = parentArtifactId
    self.sent = sent
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case artifactId = "artifactId"
    case artifact_id = "artifact_id"
    case crops = "crops"
    case manifestPath = "manifestPath"
    case outputDir = "outputDir"
    case parentArtifactId = "parentArtifactId"
    case sent = "sent"
    case success = "success"
  }
}

public struct ImageGenerateOptions: Codable, Sendable {
  public var artifactId: String?
  public var aspect: String?
  public var asyncWorker: Bool?
  public var async_: Bool?
  public var background: String?
  public var caption: String?
  public var compression: String?
  public var execute: Bool?
  public var format: String?
  public var mode: String?
  public var model: String?
  public var output: String?
  public var provider: String?
  public var quality: String?
  public var send: Bool?
  public var size: String?
  public var source: String?
  public var sync: Bool?

  public init(artifactId: String? = nil, aspect: String? = nil, asyncWorker: Bool? = nil, async_: Bool? = nil, background: String? = nil, caption: String? = nil, compression: String? = nil, execute: Bool? = nil, format: String? = nil, mode: String? = nil, model: String? = nil, output: String? = nil, provider: String? = nil, quality: String? = nil, send: Bool? = nil, size: String? = nil, source: String? = nil, sync: Bool? = nil) {
    self.artifactId = artifactId
    self.aspect = aspect
    self.asyncWorker = asyncWorker
    self.async_ = async_
    self.background = background
    self.caption = caption
    self.compression = compression
    self.execute = execute
    self.format = format
    self.mode = mode
    self.model = model
    self.output = output
    self.provider = provider
    self.quality = quality
    self.send = send
    self.size = size
    self.source = source
    self.sync = sync
  }

  enum CodingKeys: String, CodingKey {
    case artifactId = "artifactId"
    case aspect = "aspect"
    case asyncWorker = "asyncWorker"
    case async_ = "async"
    case background = "background"
    case caption = "caption"
    case compression = "compression"
    case execute = "execute"
    case format = "format"
    case mode = "mode"
    case model = "model"
    case output = "output"
    case provider = "provider"
    case quality = "quality"
    case send = "send"
    case size = "size"
    case source = "source"
    case sync = "sync"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.artifactId {
      body["artifactId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.aspect {
      body["aspect"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.asyncWorker {
      body["asyncWorker"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.async_ {
      body["async"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.background {
      body["background"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.caption {
      body["caption"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.compression {
      body["compression"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.format {
      body["format"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mode {
      body["mode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.output {
      body["output"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.quality {
      body["quality"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.send {
      body["send"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.size {
      body["size"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sync {
      body["sync"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ImageGenerateReturn = RaviJSON

public struct InboxArchiveReturn: Codable, Sendable {
  public var item: [String: RaviJSON]

  public init(item: [String: RaviJSON]) {
    self.item = item
  }

  enum CodingKeys: String, CodingKey {
    case item = "item"
  }
}

public struct InboxDisableReturn: Codable, Sendable {
  public var changed: Bool
  public var enabled: Bool

  public init(changed: Bool, enabled: Bool) {
    self.changed = changed
    self.enabled = enabled
  }

  enum CodingKeys: String, CodingKey {
    case changed = "changed"
    case enabled = "enabled"
  }
}

public struct InboxDoneReturn: Codable, Sendable {
  public var item: [String: RaviJSON]

  public init(item: [String: RaviJSON]) {
    self.item = item
  }

  enum CodingKeys: String, CodingKey {
    case item = "item"
  }
}

public struct InboxEnableReturn: Codable, Sendable {
  public var changed: Bool
  public var enabled: Bool

  public init(changed: Bool, enabled: Bool) {
    self.changed = changed
    self.enabled = enabled
  }

  enum CodingKeys: String, CodingKey {
    case changed = "changed"
    case enabled = "enabled"
  }
}

public struct InboxItemsOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?

  public init(fields: String? = nil, limit: String? = nil) {
    self.fields = fields
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct InboxItemsReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var total: Double

  public init(items: [[String: RaviJSON]], total: Double) {
    self.items = items
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case total = "total"
  }
}

public struct InboxListOptions: Codable, Sendable {
  public var fields: String?
  public var includeArchived: Bool?
  public var limit: String?
  public var offset: String?
  public var source: String?
  public var status: String?

  public init(fields: String? = nil, includeArchived: Bool? = nil, limit: String? = nil, offset: String? = nil, source: String? = nil, status: String? = nil) {
    self.fields = fields
    self.includeArchived = includeArchived
    self.limit = limit
    self.offset = offset
    self.source = source
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case includeArchived = "includeArchived"
    case limit = "limit"
    case offset = "offset"
    case source = "source"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeArchived {
      body["includeArchived"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct InboxListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var total: Double

  public init(items: [[String: RaviJSON]], total: Double) {
    self.items = items
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case total = "total"
  }
}

public struct InboxPollOptions: Codable, Sendable {
  public var once: Bool?

  public init(once: Bool? = nil) {
    self.once = once
  }

  enum CodingKeys: String, CodingKey {
    case once = "once"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.once {
      body["once"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct InboxPollReturn: Codable, Sendable {
  public var ok: Bool
  public var snapshot: [String: RaviJSON]

  public init(ok: Bool, snapshot: [String: RaviJSON]) {
    self.ok = ok
    self.snapshot = snapshot
  }

  enum CodingKeys: String, CodingKey {
    case ok = "ok"
    case snapshot = "snapshot"
  }
}

public struct InboxReadReturn: Codable, Sendable {
  public var events: [[String: RaviJSON]]
  public var item: [String: RaviJSON]

  public init(events: [[String: RaviJSON]], item: [String: RaviJSON]) {
    self.events = events
    self.item = item
  }

  enum CodingKeys: String, CodingKey {
    case events = "events"
    case item = "item"
  }
}

public struct InboxReplayOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct InboxReplayReturn: Codable, Sendable {
  public var itemId: String
  public var ok: Bool
  public var replayedAt: String
  public var sequence: Double
  public var subject: String

  public init(itemId: String, ok: Bool, replayedAt: String, sequence: Double, subject: String) {
    self.itemId = itemId
    self.ok = ok
    self.replayedAt = replayedAt
    self.sequence = sequence
    self.subject = subject
  }

  enum CodingKeys: String, CodingKey {
    case itemId = "itemId"
    case ok = "ok"
    case replayedAt = "replayedAt"
    case sequence = "sequence"
    case subject = "subject"
  }
}

public struct InboxSnoozeOptions: Codable, Sendable {
  public var until: String?

  public init(until: String? = nil) {
    self.until = until
  }

  enum CodingKeys: String, CodingKey {
    case until = "until"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.until {
      body["until"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct InboxSnoozeReturn: Codable, Sendable {
  public var item: [String: RaviJSON]

  public init(item: [String: RaviJSON]) {
    self.item = item
  }

  enum CodingKeys: String, CodingKey {
    case item = "item"
  }
}

public struct InboxSourcesReturn: Codable, Sendable {
  public var sources: [[String: RaviJSON]]

  public init(sources: [[String: RaviJSON]]) {
    self.sources = sources
  }

  enum CodingKeys: String, CodingKey {
    case sources = "sources"
  }
}

public typealias InboxStatusReturn = [String: RaviJSON]

public struct InsightsCreateOptions: Codable, Sendable {
  public var agent: String?
  public var artifact: String?
  public var autoContext: Bool?
  public var comment: String?
  public var confidence: String?
  public var detail: String?
  public var importance: String?
  public var kind: String?
  public var linkId: String?
  public var linkType: String?
  public var profile: String?
  public var session: String?
  public var tag: [String]?
  public var task: String?

  public init(agent: String? = nil, artifact: String? = nil, autoContext: Bool? = nil, comment: String? = nil, confidence: String? = nil, detail: String? = nil, importance: String? = nil, kind: String? = nil, linkId: String? = nil, linkType: String? = nil, profile: String? = nil, session: String? = nil, tag: [String]? = nil, task: String? = nil) {
    self.agent = agent
    self.artifact = artifact
    self.autoContext = autoContext
    self.comment = comment
    self.confidence = confidence
    self.detail = detail
    self.importance = importance
    self.kind = kind
    self.linkId = linkId
    self.linkType = linkType
    self.profile = profile
    self.session = session
    self.tag = tag
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case artifact = "artifact"
    case autoContext = "autoContext"
    case comment = "comment"
    case confidence = "confidence"
    case detail = "detail"
    case importance = "importance"
    case kind = "kind"
    case linkId = "linkId"
    case linkType = "linkType"
    case profile = "profile"
    case session = "session"
    case tag = "tag"
    case task = "task"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.artifact {
      body["artifact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.autoContext {
      body["autoContext"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.comment {
      body["comment"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.confidence {
      body["confidence"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.detail {
      body["detail"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.importance {
      body["importance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.linkId {
      body["linkId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.linkType {
      body["linkType"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct InsightsCreateReturn: Codable, Sendable {
  public var comment: [String: RaviJSON]?
  public var insight: [String: RaviJSON]
  public var success: Bool
  public var tags: [String]

  public init(comment: [String: RaviJSON]? = nil, insight: [String: RaviJSON], success: Bool, tags: [String]) {
    self.comment = comment
    self.insight = insight
    self.success = success
    self.tags = tags
  }

  enum CodingKeys: String, CodingKey {
    case comment = "comment"
    case insight = "insight"
    case success = "success"
    case tags = "tags"
  }
}

public struct InsightsListOptions: Codable, Sendable {
  public var agent: String?
  public var confidence: String?
  public var fields: String?
  public var importance: String?
  public var kind: String?
  public var limit: String?
  public var offset: String?
  public var profile: String?
  public var query: String?
  public var rich: Bool?
  public var session: String?
  public var tag: String?
  public var task: String?

  public init(agent: String? = nil, confidence: String? = nil, fields: String? = nil, importance: String? = nil, kind: String? = nil, limit: String? = nil, offset: String? = nil, profile: String? = nil, query: String? = nil, rich: Bool? = nil, session: String? = nil, tag: String? = nil, task: String? = nil) {
    self.agent = agent
    self.confidence = confidence
    self.fields = fields
    self.importance = importance
    self.kind = kind
    self.limit = limit
    self.offset = offset
    self.profile = profile
    self.query = query
    self.rich = rich
    self.session = session
    self.tag = tag
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case confidence = "confidence"
    case fields = "fields"
    case importance = "importance"
    case kind = "kind"
    case limit = "limit"
    case offset = "offset"
    case profile = "profile"
    case query = "query"
    case rich = "rich"
    case session = "session"
    case tag = "tag"
    case task = "task"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.confidence {
      body["confidence"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.importance {
      body["importance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.query {
      body["query"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.rich {
      body["rich"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InsightsListReturn = RaviJSON

public struct InsightsSearchOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?

  public init(fields: String? = nil, limit: String? = nil) {
    self.fields = fields
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct InsightsSearchReturn: Codable, Sendable {
  public var count: Double
  public var insights: [[String: RaviJSON]]
  public var query: [String: RaviJSON]

  public init(count: Double, insights: [[String: RaviJSON]], query: [String: RaviJSON]) {
    self.count = count
    self.insights = insights
    self.query = query
  }

  enum CodingKeys: String, CodingKey {
    case count = "count"
    case insights = "insights"
    case query = "query"
  }
}

public struct InsightsShowReturn: Codable, Sendable {
  public var insight: [String: RaviJSON]
  public var tags: [String]

  public init(insight: [String: RaviJSON], tags: [String]) {
    self.insight = insight
    self.tags = tags
  }

  enum CodingKeys: String, CodingKey {
    case insight = "insight"
    case tags = "tags"
  }
}

public struct InstancesCreateOptions: Codable, Sendable {
  public var agent: String?
  public var channel: String?
  public var contactIntakeMode: String?
  public var dmPolicy: String?
  public var groupPolicy: String?

  public init(agent: String? = nil, channel: String? = nil, contactIntakeMode: String? = nil, dmPolicy: String? = nil, groupPolicy: String? = nil) {
    self.agent = agent
    self.channel = channel
    self.contactIntakeMode = contactIntakeMode
    self.dmPolicy = dmPolicy
    self.groupPolicy = groupPolicy
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case channel = "channel"
    case contactIntakeMode = "contactIntakeMode"
    case dmPolicy = "dmPolicy"
    case groupPolicy = "groupPolicy"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contactIntakeMode {
      body["contactIntakeMode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dmPolicy {
      body["dmPolicy"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.groupPolicy {
      body["groupPolicy"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesCreateReturn = [String: RaviJSON]

public typealias InstancesDeleteReturn = [String: RaviJSON]

public typealias InstancesDeletedReturn = [String: RaviJSON]

public typealias InstancesDisableReturn = [String: RaviJSON]

public typealias InstancesDisconnectReturn = [String: RaviJSON]

public typealias InstancesEnableReturn = [String: RaviJSON]

public typealias InstancesGetReturn = [String: RaviJSON]

public struct InstancesListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesListReturn = [String: RaviJSON]

public struct InstancesPendingApproveOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesPendingApproveReturn = [String: RaviJSON]

public struct InstancesPendingListOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?

  public init(limit: String? = nil, offset: String? = nil) {
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesPendingListReturn = [String: RaviJSON]

public struct InstancesPendingRejectOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesPendingRejectReturn = [String: RaviJSON]

public typealias InstancesRestoreReturn = [String: RaviJSON]

public struct InstancesRoutesAddOptions: Codable, Sendable {
  public var allowRuntimeMismatch: Bool?
  public var channel: String?
  public var dmScope: String?
  public var policy: String?
  public var priority: String?
  public var session: String?

  public init(allowRuntimeMismatch: Bool? = nil, channel: String? = nil, dmScope: String? = nil, policy: String? = nil, priority: String? = nil, session: String? = nil) {
    self.allowRuntimeMismatch = allowRuntimeMismatch
    self.channel = channel
    self.dmScope = dmScope
    self.policy = policy
    self.priority = priority
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case allowRuntimeMismatch = "allowRuntimeMismatch"
    case channel = "channel"
    case dmScope = "dmScope"
    case policy = "policy"
    case priority = "priority"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dmScope {
      body["dmScope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.policy {
      body["policy"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesRoutesAddReturn = [String: RaviJSON]

public typealias InstancesRoutesDeletedReturn = [String: RaviJSON]

public struct InstancesRoutesListOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesRoutesListReturn = [String: RaviJSON]

public struct InstancesRoutesRemoveOptions: Codable, Sendable {
  public var allowRuntimeMismatch: Bool?

  public init(allowRuntimeMismatch: Bool? = nil) {
    self.allowRuntimeMismatch = allowRuntimeMismatch
  }

  enum CodingKeys: String, CodingKey {
    case allowRuntimeMismatch = "allowRuntimeMismatch"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesRoutesRemoveReturn = [String: RaviJSON]

public struct InstancesRoutesRestoreOptions: Codable, Sendable {
  public var allowRuntimeMismatch: Bool?

  public init(allowRuntimeMismatch: Bool? = nil) {
    self.allowRuntimeMismatch = allowRuntimeMismatch
  }

  enum CodingKeys: String, CodingKey {
    case allowRuntimeMismatch = "allowRuntimeMismatch"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesRoutesRestoreReturn = [String: RaviJSON]

public struct InstancesRoutesSetOptions: Codable, Sendable {
  public var allowRuntimeMismatch: Bool?

  public init(allowRuntimeMismatch: Bool? = nil) {
    self.allowRuntimeMismatch = allowRuntimeMismatch
  }

  enum CodingKeys: String, CodingKey {
    case allowRuntimeMismatch = "allowRuntimeMismatch"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesRoutesSetReturn = [String: RaviJSON]

public typealias InstancesRoutesShowReturn = [String: RaviJSON]

public typealias InstancesSetReturn = [String: RaviJSON]

public typealias InstancesShowReturn = [String: RaviJSON]

public typealias InstancesStatusReturn = [String: RaviJSON]

public struct InstancesTargetOptions: Codable, Sendable {
  public var channel: String?
  public var pattern: String?

  public init(channel: String? = nil, pattern: String? = nil) {
    self.channel = channel
    self.pattern = pattern
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case pattern = "pattern"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.pattern {
      body["pattern"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias InstancesTargetReturn = [String: RaviJSON]

public struct MailAccountsCreateOptions: Codable, Sendable {
  public var credentialsRef: String?
  public var id: String?
  public var name: String?
  public var provider: String?

  public init(credentialsRef: String? = nil, id: String? = nil, name: String? = nil, provider: String? = nil) {
    self.credentialsRef = credentialsRef
    self.id = id
    self.name = name
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case credentialsRef = "credentialsRef"
    case id = "id"
    case name = "name"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.credentialsRef {
      body["credentialsRef"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.id {
      body["id"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailAccountsCreateReturn: Codable, Sendable {
  public var account: RaviJSON

  public init(account: RaviJSON) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }
}

public struct MailAccountsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var provider: String?
  public var status: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, provider: String? = nil, status: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.provider = provider
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case provider = "provider"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailAccountsListReturn: Codable, Sendable {
  public var accounts: [RaviJSON]

  public init(accounts: [RaviJSON]) {
    self.accounts = accounts
  }

  enum CodingKeys: String, CodingKey {
    case accounts = "accounts"
  }
}

public struct MailAccountsSyncOptions: Codable, Sendable {
  public var once: Bool?

  public init(once: Bool? = nil) {
    self.once = once
  }

  enum CodingKeys: String, CodingKey {
    case once = "once"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.once {
      body["once"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailAccountsSyncReturn = RaviJSON

public struct MailDomainsCreateOptions: Codable, Sendable {
  public var console: String?

  public init(console: String? = nil) {
    self.console = console
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailDomainsCreateReturn = [String: RaviJSON]

public struct MailDomainsListOptions: Codable, Sendable {
  public var console: String?
  public var limit: String?
  public var offset: String?

  public init(console: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.console = console
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailDomainsListReturn = [String: RaviJSON]

public struct MailMailboxesCreateOptions: Codable, Sendable {
  public var account: String?
  public var default_: Bool?
  public var name: String?
  public var providerMailboxId: String?
  public var role: String?

  public init(account: String? = nil, default_: Bool? = nil, name: String? = nil, providerMailboxId: String? = nil, role: String? = nil) {
    self.account = account
    self.default_ = default_
    self.name = name
    self.providerMailboxId = providerMailboxId
    self.role = role
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case default_ = "default"
    case name = "name"
    case providerMailboxId = "providerMailboxId"
    case role = "role"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.default_ {
      body["default"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.providerMailboxId {
      body["providerMailboxId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailMailboxesCreateReturn: Codable, Sendable {
  public var mailbox: RaviJSON

  public init(mailbox: RaviJSON) {
    self.mailbox = mailbox
  }

  enum CodingKeys: String, CodingKey {
    case mailbox = "mailbox"
  }
}

public struct MailMailboxesDisableReturn: Codable, Sendable {
  public var mailbox: RaviJSON

  public init(mailbox: RaviJSON) {
    self.mailbox = mailbox
  }

  enum CodingKeys: String, CodingKey {
    case mailbox = "mailbox"
  }
}

public struct MailMailboxesListOptions: Codable, Sendable {
  public var account: String?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var status: String?

  public init(account: String? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, status: String? = nil) {
    self.account = account
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailMailboxesListReturn: Codable, Sendable {
  public var mailboxes: [RaviJSON]

  public init(mailboxes: [RaviJSON]) {
    self.mailboxes = mailboxes
  }

  enum CodingKeys: String, CodingKey {
    case mailboxes = "mailboxes"
  }
}

public struct MailMailboxesShowReturn: Codable, Sendable {
  public var mailbox: RaviJSON

  public init(mailbox: RaviJSON) {
    self.mailbox = mailbox
  }

  enum CodingKeys: String, CodingKey {
    case mailbox = "mailbox"
  }
}

public struct MailMessagesImportOptions: Codable, Sendable {
  public var body: String?
  public var from: String?
  public var mailbox: String?
  public var provider: String?
  public var providerMessageId: String?
  public var providerThreadId: String?
  public var rfcMessageId: String?
  public var subject: String?
  public var to: String?

  public init(body: String? = nil, from: String? = nil, mailbox: String? = nil, provider: String? = nil, providerMessageId: String? = nil, providerThreadId: String? = nil, rfcMessageId: String? = nil, subject: String? = nil, to: String? = nil) {
    self.body = body
    self.from = from
    self.mailbox = mailbox
    self.provider = provider
    self.providerMessageId = providerMessageId
    self.providerThreadId = providerThreadId
    self.rfcMessageId = rfcMessageId
    self.subject = subject
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case body = "body"
    case from = "from"
    case mailbox = "mailbox"
    case provider = "provider"
    case providerMessageId = "providerMessageId"
    case providerThreadId = "providerThreadId"
    case rfcMessageId = "rfcMessageId"
    case subject = "subject"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.body {
      body["body"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.from {
      body["from"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mailbox {
      body["mailbox"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.providerMessageId {
      body["providerMessageId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.providerThreadId {
      body["providerThreadId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.rfcMessageId {
      body["rfcMessageId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.subject {
      body["subject"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailMessagesImportReturn: Codable, Sendable {
  public var inboxCreated: Bool
  public var inboxItem: RaviJSON
  public var message: RaviJSON

  public init(inboxCreated: Bool, inboxItem: RaviJSON, message: RaviJSON) {
    self.inboxCreated = inboxCreated
    self.inboxItem = inboxItem
    self.message = message
  }

  enum CodingKeys: String, CodingKey {
    case inboxCreated = "inboxCreated"
    case inboxItem = "inboxItem"
    case message = "message"
  }
}

public struct MailMessagesListOptions: Codable, Sendable {
  public var addresses: Bool?
  public var fields: String?
  public var limit: String?
  public var mailbox: String?
  public var offset: String?
  public var query: String?
  public var status: String?

  public init(addresses: Bool? = nil, fields: String? = nil, limit: String? = nil, mailbox: String? = nil, offset: String? = nil, query: String? = nil, status: String? = nil) {
    self.addresses = addresses
    self.fields = fields
    self.limit = limit
    self.mailbox = mailbox
    self.offset = offset
    self.query = query
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case addresses = "addresses"
    case fields = "fields"
    case limit = "limit"
    case mailbox = "mailbox"
    case offset = "offset"
    case query = "query"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.addresses {
      body["addresses"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mailbox {
      body["mailbox"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.query {
      body["query"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailMessagesListReturn: Codable, Sendable {
  public var messages: [RaviJSON]

  public init(messages: [RaviJSON]) {
    self.messages = messages
  }

  enum CodingKeys: String, CodingKey {
    case messages = "messages"
  }
}

public struct MailMessagesReadOptions: Codable, Sendable {
  public var addresses: Bool?

  public init(addresses: Bool? = nil) {
    self.addresses = addresses
  }

  enum CodingKeys: String, CodingKey {
    case addresses = "addresses"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.addresses {
      body["addresses"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailMessagesReadReturn: Codable, Sendable {
  public var message: RaviJSON

  public init(message: RaviJSON) {
    self.message = message
  }

  enum CodingKeys: String, CodingKey {
    case message = "message"
  }
}

public struct MailMessagesSearchOptions: Codable, Sendable {
  public var limit: String?
  public var mailbox: String?

  public init(limit: String? = nil, mailbox: String? = nil) {
    self.limit = limit
    self.mailbox = mailbox
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case mailbox = "mailbox"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mailbox {
      body["mailbox"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailMessagesSearchReturn: Codable, Sendable {
  public var messages: [RaviJSON]

  public init(messages: [RaviJSON]) {
    self.messages = messages
  }

  enum CodingKeys: String, CodingKey {
    case messages = "messages"
  }
}

public struct MailOutboxInspectReturn: Codable, Sendable {
  public var outbox: RaviJSON

  public init(outbox: RaviJSON) {
    self.outbox = outbox
  }

  enum CodingKeys: String, CodingKey {
    case outbox = "outbox"
  }
}

public struct MailOutboxListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var mailbox: String?
  public var offset: String?
  public var status: String?

  public init(fields: String? = nil, limit: String? = nil, mailbox: String? = nil, offset: String? = nil, status: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.mailbox = mailbox
    self.offset = offset
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case mailbox = "mailbox"
    case offset = "offset"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mailbox {
      body["mailbox"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailOutboxListReturn: Codable, Sendable {
  public var outbox: [RaviJSON]

  public init(outbox: [RaviJSON]) {
    self.outbox = outbox
  }

  enum CodingKeys: String, CodingKey {
    case outbox = "outbox"
  }
}

public struct MailOutboxRetryReturn: Codable, Sendable {
  public var outbox: RaviJSON

  public init(outbox: RaviJSON) {
    self.outbox = outbox
  }

  enum CodingKeys: String, CodingKey {
    case outbox = "outbox"
  }
}

public struct MailOutboxStatusReturn: Codable, Sendable {
  public var counts: [String: Double]
  public var total: Double

  public init(counts: [String: Double], total: Double) {
    self.counts = counts
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case counts = "counts"
    case total = "total"
  }
}

public struct MailProvidersListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailProvidersListReturn: Codable, Sendable {
  public var providers: [RaviJSON]

  public init(providers: [RaviJSON]) {
    self.providers = providers
  }

  enum CodingKeys: String, CodingKey {
    case providers = "providers"
  }
}

public struct MailProvidersRaviMailMailboxesCreateOptions: Codable, Sendable {
  public var console: String?
  public var domain: String?

  public init(console: String? = nil, domain: String? = nil) {
    self.console = console
    self.domain = domain
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case domain = "domain"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.domain {
      body["domain"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailProvidersRaviMailMailboxesCreateReturn = [String: RaviJSON]

public struct MailProvidersRaviMailMailboxesDisableOptions: Codable, Sendable {
  public var console: String?

  public init(console: String? = nil) {
    self.console = console
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailProvidersRaviMailMailboxesDisableReturn = [String: RaviJSON]

public struct MailProvidersRaviMailMailboxesListOptions: Codable, Sendable {
  public var console: String?
  public var domain: String?
  public var limit: String?
  public var offset: String?

  public init(console: String? = nil, domain: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.console = console
    self.domain = domain
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case domain = "domain"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.domain {
      body["domain"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailProvidersRaviMailMailboxesListReturn = [String: RaviJSON]

public struct MailProvidersRaviMailMailboxesShowOptions: Codable, Sendable {
  public var console: String?

  public init(console: String? = nil) {
    self.console = console
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailProvidersRaviMailMailboxesShowReturn = [String: RaviJSON]

public struct MailProvidersRaviMailMessagesListOptions: Codable, Sendable {
  public var addresses: Bool?
  public var console: String?
  public var limit: String?
  public var mailbox: String?
  public var offset: String?

  public init(addresses: Bool? = nil, console: String? = nil, limit: String? = nil, mailbox: String? = nil, offset: String? = nil) {
    self.addresses = addresses
    self.console = console
    self.limit = limit
    self.mailbox = mailbox
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case addresses = "addresses"
    case console = "console"
    case limit = "limit"
    case mailbox = "mailbox"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.addresses {
      body["addresses"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mailbox {
      body["mailbox"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailProvidersRaviMailMessagesListReturn = [String: RaviJSON]

public struct MailProvidersRaviMailMessagesReadOptions: Codable, Sendable {
  public var console: String?
  public var payload: String?

  public init(console: String? = nil, payload: String? = nil) {
    self.console = console
    self.payload = payload
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case payload = "payload"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.payload {
      body["payload"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailProvidersRaviMailMessagesReadReturn = [String: RaviJSON]

public struct MailProvidersRaviMailMessagesShowOptions: Codable, Sendable {
  public var addresses: Bool?
  public var console: String?

  public init(addresses: Bool? = nil, console: String? = nil) {
    self.addresses = addresses
    self.console = console
  }

  enum CodingKeys: String, CodingKey {
    case addresses = "addresses"
    case console = "console"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.addresses {
      body["addresses"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailProvidersRaviMailMessagesShowReturn = [String: RaviJSON]

public struct MailProvidersRaviMailSendOptions: Codable, Sendable {
  public var body: String?
  public var console: String?
  public var execute: Bool?
  public var from: String?
  public var idempotencyKey: String?
  public var subject: String?
  public var to: String?

  public init(body: String? = nil, console: String? = nil, execute: Bool? = nil, from: String? = nil, idempotencyKey: String? = nil, subject: String? = nil, to: String? = nil) {
    self.body = body
    self.console = console
    self.execute = execute
    self.from = from
    self.idempotencyKey = idempotencyKey
    self.subject = subject
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case body = "body"
    case console = "console"
    case execute = "execute"
    case from = "from"
    case idempotencyKey = "idempotencyKey"
    case subject = "subject"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.body {
      body["body"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.from {
      body["from"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.subject {
      body["subject"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MailProvidersRaviMailSendReturn = [String: RaviJSON]

public struct MailReplyOptions: Codable, Sendable {
  public var bcc: String?
  public var body: String?
  public var cc: String?
  public var execute: Bool?
  public var from: String?
  public var idempotencyKey: String?
  public var subject: String?
  public var to: String?

  public init(bcc: String? = nil, body: String? = nil, cc: String? = nil, execute: Bool? = nil, from: String? = nil, idempotencyKey: String? = nil, subject: String? = nil, to: String? = nil) {
    self.bcc = bcc
    self.body = body
    self.cc = cc
    self.execute = execute
    self.from = from
    self.idempotencyKey = idempotencyKey
    self.subject = subject
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case bcc = "bcc"
    case body = "body"
    case cc = "cc"
    case execute = "execute"
    case from = "from"
    case idempotencyKey = "idempotencyKey"
    case subject = "subject"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.bcc {
      body["bcc"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.body {
      body["body"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cc {
      body["cc"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.from {
      body["from"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.subject {
      body["subject"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailReplyReturn: Codable, Sendable {
  public var message: RaviJSON
  public var outbox: RaviJSON
  public var queued: Bool

  public init(message: RaviJSON, outbox: RaviJSON, queued: Bool) {
    self.message = message
    self.outbox = outbox
    self.queued = queued
  }

  enum CodingKeys: String, CodingKey {
    case message = "message"
    case outbox = "outbox"
    case queued = "queued"
  }
}

public struct MailSendOptions: Codable, Sendable {
  public var body: String?
  public var execute: Bool?
  public var from: String?
  public var idempotencyKey: String?
  public var subject: String?
  public var to: String?

  public init(body: String? = nil, execute: Bool? = nil, from: String? = nil, idempotencyKey: String? = nil, subject: String? = nil, to: String? = nil) {
    self.body = body
    self.execute = execute
    self.from = from
    self.idempotencyKey = idempotencyKey
    self.subject = subject
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case body = "body"
    case execute = "execute"
    case from = "from"
    case idempotencyKey = "idempotencyKey"
    case subject = "subject"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.body {
      body["body"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.from {
      body["from"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.subject {
      body["subject"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailSendReturn: Codable, Sendable {
  public var message: RaviJSON
  public var outbox: RaviJSON
  public var queued: Bool

  public init(message: RaviJSON, outbox: RaviJSON, queued: Bool) {
    self.message = message
    self.outbox = outbox
    self.queued = queued
  }

  enum CodingKeys: String, CodingKey {
    case message = "message"
    case outbox = "outbox"
    case queued = "queued"
  }
}

public struct MailThreadsReadOptions: Codable, Sendable {
  public var addresses: Bool?

  public init(addresses: Bool? = nil) {
    self.addresses = addresses
  }

  enum CodingKeys: String, CodingKey {
    case addresses = "addresses"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.addresses {
      body["addresses"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MailThreadsReadReturn: Codable, Sendable {
  public var messages: [RaviJSON]
  public var thread: RaviJSON

  public init(messages: [RaviJSON], thread: RaviJSON) {
    self.messages = messages
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case messages = "messages"
    case thread = "thread"
  }
}

public struct MediaSendOptions: Codable, Sendable {
  public var account: String?
  public var caption: String?
  public var channel: String?
  public var execute: Bool?
  public var ptt: Bool?
  public var threadId: String?
  public var to: String?

  public init(account: String? = nil, caption: String? = nil, channel: String? = nil, execute: Bool? = nil, ptt: Bool? = nil, threadId: String? = nil, to: String? = nil) {
    self.account = account
    self.caption = caption
    self.channel = channel
    self.execute = execute
    self.ptt = ptt
    self.threadId = threadId
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case caption = "caption"
    case channel = "channel"
    case execute = "execute"
    case ptt = "ptt"
    case threadId = "threadId"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.caption {
      body["caption"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ptt {
      body["ptt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadId {
      body["threadId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MediaSendReturn: Codable, Sendable {
  public var delivery: [String: RaviJSON]
  public var media: RaviJSON
  public var success: Bool
  public var target: RaviJSON

  public init(delivery: [String: RaviJSON], media: RaviJSON, success: Bool, target: RaviJSON) {
    self.delivery = delivery
    self.media = media
    self.success = success
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case delivery = "delivery"
    case media = "media"
    case success = "success"
    case target = "target"
  }
}

public struct MeetingsFinalizeOptions: Codable, Sendable {
  public var noPostTranscribe: Bool?
  public var runDir: String?
  public var title: String?

  public init(noPostTranscribe: Bool? = nil, runDir: String? = nil, title: String? = nil) {
    self.noPostTranscribe = noPostTranscribe
    self.runDir = runDir
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case noPostTranscribe = "noPostTranscribe"
    case runDir = "runDir"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.noPostTranscribe {
      body["noPostTranscribe"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.runDir {
      body["runDir"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MeetingsFinalizeReturn: Codable, Sendable {
  public var artifactId: String
  public var artifactPath: String
  public var diagnosticCount: Double
  public var handoffMessage: String
  public var mediaRefCount: Double
  public var session: RaviJSON
  public var transcriptSegmentCount: Double

  public init(artifactId: String, artifactPath: String, diagnosticCount: Double, handoffMessage: String, mediaRefCount: Double, session: RaviJSON, transcriptSegmentCount: Double) {
    self.artifactId = artifactId
    self.artifactPath = artifactPath
    self.diagnosticCount = diagnosticCount
    self.handoffMessage = handoffMessage
    self.mediaRefCount = mediaRefCount
    self.session = session
    self.transcriptSegmentCount = transcriptSegmentCount
  }

  enum CodingKeys: String, CodingKey {
    case artifactId = "artifactId"
    case artifactPath = "artifactPath"
    case diagnosticCount = "diagnosticCount"
    case handoffMessage = "handoffMessage"
    case mediaRefCount = "mediaRefCount"
    case session = "session"
    case transcriptSegmentCount = "transcriptSegmentCount"
  }
}

public struct MeetingsProfilesInitOptions: Codable, Sendable {
  public var source: String?

  public init(source: String? = nil) {
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MeetingsProfilesInitReturn: Codable, Sendable {
  public var profileDir: String
  public var profilePath: String
  public var sourceKind: String

  public init(profileDir: String, profilePath: String, sourceKind: String) {
    self.profileDir = profileDir
    self.profilePath = profilePath
    self.sourceKind = sourceKind
  }

  enum CodingKeys: String, CodingKey {
    case profileDir = "profileDir"
    case profilePath = "profilePath"
    case sourceKind = "sourceKind"
  }
}

public struct MeetingsProfilesListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MeetingsProfilesListReturn: Codable, Sendable {
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var profiles: [RaviJSON]
  public var total: Double

  public init(items: [RaviJSON], pagination: RaviJSON, profiles: [RaviJSON], total: Double) {
    self.items = items
    self.pagination = pagination
    self.profiles = profiles
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case profiles = "profiles"
    case total = "total"
  }
}

public struct MeetingsProfilesShowReturn: Codable, Sendable {
  public var chrome: RaviJSON
  public var defaults: RaviJSON
  public var id: String
  public var label: String
  public var live: RaviJSON
  public var provider: String
  public var source: String
  public var sourceKind: String
  public var version: String
  public var voice: RaviJSON

  public init(chrome: RaviJSON, defaults: RaviJSON, id: String, label: String, live: RaviJSON, provider: String, source: String, sourceKind: String, version: String, voice: RaviJSON) {
    self.chrome = chrome
    self.defaults = defaults
    self.id = id
    self.label = label
    self.live = live
    self.provider = provider
    self.source = source
    self.sourceKind = sourceKind
    self.version = version
    self.voice = voice
  }

  enum CodingKeys: String, CodingKey {
    case chrome = "chrome"
    case defaults = "defaults"
    case id = "id"
    case label = "label"
    case live = "live"
    case provider = "provider"
    case source = "source"
    case sourceKind = "sourceKind"
    case version = "version"
    case voice = "voice"
  }
}

public struct MeetingsProfilesValidateReturn: Codable, Sendable {
  public var results: [RaviJSON]
  public var valid: Bool

  public init(results: [RaviJSON], valid: Bool) {
    self.results = results
    self.valid = valid
  }

  enum CodingKeys: String, CodingKey {
    case results = "results"
    case valid = "valid"
  }
}

public struct MeetingsVoiceRuntimesReturn: Codable, Sendable {
  public var candidates: [RaviJSON]
  public var defaultRuntimeId: String
  public var recommendation: String

  public init(candidates: [RaviJSON], defaultRuntimeId: String, recommendation: String) {
    self.candidates = candidates
    self.defaultRuntimeId = defaultRuntimeId
    self.recommendation = recommendation
  }

  enum CodingKeys: String, CodingKey {
    case candidates = "candidates"
    case defaultRuntimeId = "defaultRuntimeId"
    case recommendation = "recommendation"
  }
}

public typealias MetricsDatesReturn = [String]

public struct MetricsRollupOptions: Codable, Sendable {
  public var since: String?
  public var through: String?

  public init(since: String? = nil, through: String? = nil) {
    self.since = since
    self.through = through
  }

  enum CodingKeys: String, CodingKey {
    case since = "since"
    case through = "through"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.since {
      body["since"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.through {
      body["through"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct MetricsRollupReturn: Codable, Sendable {
  public var dates: [String]
  public var rowsWritten: Double

  public init(dates: [String], rowsWritten: Double) {
    self.dates = dates
    self.rowsWritten = rowsWritten
  }

  enum CodingKeys: String, CodingKey {
    case dates = "dates"
    case rowsWritten = "rowsWritten"
  }
}

public struct MetricsShowOptions: Codable, Sendable {
  public var agent: String?
  public var by: String?
  public var days: String?
  public var fields: String?
  public var since: String?
  public var through: String?

  public init(agent: String? = nil, by: String? = nil, days: String? = nil, fields: String? = nil, since: String? = nil, through: String? = nil) {
    self.agent = agent
    self.by = by
    self.days = days
    self.fields = fields
    self.since = since
    self.through = through
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case by = "by"
    case days = "days"
    case fields = "fields"
    case since = "since"
    case through = "through"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.by {
      body["by"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.days {
      body["days"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.since {
      body["since"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.through {
      body["through"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias MetricsShowReturn = [RaviJSON]

public struct ObserversListOptions: Codable, Sendable {
  public var agent: String?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var session: String?

  public init(agent: String? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, session: String? = nil) {
    self.agent = agent
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ObserversListReturn: Codable, Sendable {
  public var bindings: [[String: RaviJSON]]
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(bindings: [[String: RaviJSON]], items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.bindings = bindings
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case bindings = "bindings"
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct ObserversProfilesInitOptions: Codable, Sendable {
  public var overwrite: Bool?
  public var source: String?

  public init(overwrite: Bool? = nil, source: String? = nil) {
    self.overwrite = overwrite
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case overwrite = "overwrite"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.overwrite {
      body["overwrite"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ObserversProfilesInitReturn: Codable, Sendable {
  public var profileDir: String
  public var profilePath: String
  public var sourceKind: String

  public init(profileDir: String, profilePath: String, sourceKind: String) {
    self.profileDir = profileDir
    self.profilePath = profilePath
    self.sourceKind = sourceKind
  }

  enum CodingKeys: String, CodingKey {
    case profileDir = "profileDir"
    case profilePath = "profilePath"
    case sourceKind = "sourceKind"
  }
}

public struct ObserversProfilesListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ObserversProfilesListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var profiles: [[String: RaviJSON]]
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, profiles: [[String: RaviJSON]], total: Double) {
    self.items = items
    self.pagination = pagination
    self.profiles = profiles
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case profiles = "profiles"
    case total = "total"
  }
}

public struct ObserversProfilesPreviewOptions: Codable, Sendable {
  public var event: String?

  public init(event: String? = nil) {
    self.event = event
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.event {
      body["event"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ObserversProfilesPreviewReturn: Codable, Sendable {
  public var eventMarkdown: String
  public var eventType: String
  public var profile: [String: RaviJSON]
  public var prompt: String

  public init(eventMarkdown: String, eventType: String, profile: [String: RaviJSON], prompt: String) {
    self.eventMarkdown = eventMarkdown
    self.eventType = eventType
    self.profile = profile
    self.prompt = prompt
  }

  enum CodingKeys: String, CodingKey {
    case eventMarkdown = "eventMarkdown"
    case eventType = "eventType"
    case profile = "profile"
    case prompt = "prompt"
  }
}

public struct ObserversProfilesShowReturn: Codable, Sendable {
  public var body: String
  public var profile: [String: RaviJSON]

  public init(body: String, profile: [String: RaviJSON]) {
    self.body = body
    self.profile = profile
  }

  enum CodingKeys: String, CodingKey {
    case body = "body"
    case profile = "profile"
  }
}

public struct ObserversProfilesValidateReturn: Codable, Sendable {
  public var errors: [[String: RaviJSON]]
  public var ok: Bool
  public var profiles: [[String: RaviJSON]]

  public init(errors: [[String: RaviJSON]], ok: Bool, profiles: [[String: RaviJSON]]) {
    self.errors = errors
    self.ok = ok
    self.profiles = profiles
  }

  enum CodingKeys: String, CodingKey {
    case errors = "errors"
    case ok = "ok"
    case profiles = "profiles"
  }
}

public struct ObserversRefreshOptions: Codable, Sendable {
  public var reconcile: String?

  public init(reconcile: String? = nil) {
    self.reconcile = reconcile
  }

  enum CodingKeys: String, CodingKey {
    case reconcile = "reconcile"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.reconcile {
      body["reconcile"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ObserversRefreshReturn: Codable, Sendable {
  public var bindings: [[String: RaviJSON]]
  public var created: [[String: RaviJSON]]
  public var disabled: [[String: RaviJSON]]
  public var mode: String
  public var refreshedProfiles: [[String: RaviJSON]]
  public var skipped: [[String: RaviJSON]]
  public var source: RaviJSON
  public var total: Double

  public init(bindings: [[String: RaviJSON]], created: [[String: RaviJSON]], disabled: [[String: RaviJSON]], mode: String, refreshedProfiles: [[String: RaviJSON]], skipped: [[String: RaviJSON]], source: RaviJSON, total: Double) {
    self.bindings = bindings
    self.created = created
    self.disabled = disabled
    self.mode = mode
    self.refreshedProfiles = refreshedProfiles
    self.skipped = skipped
    self.source = source
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case bindings = "bindings"
    case created = "created"
    case disabled = "disabled"
    case mode = "mode"
    case refreshedProfiles = "refreshedProfiles"
    case skipped = "skipped"
    case source = "source"
    case total = "total"
  }
}

public struct ObserversRulesDisableReturn: Codable, Sendable {
  public var rule: [String: RaviJSON]
  public var success: Bool

  public init(rule: [String: RaviJSON], success: Bool) {
    self.rule = rule
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case rule = "rule"
    case success = "success"
  }
}

public struct ObserversRulesEnableReturn: Codable, Sendable {
  public var rule: [String: RaviJSON]
  public var success: Bool

  public init(rule: [String: RaviJSON], success: Bool) {
    self.rule = rule
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case rule = "rule"
    case success = "success"
  }
}

public struct ObserversRulesExplainReturn: Codable, Sendable {
  public var bindings: [[String: RaviJSON]]
  public var rules: [[String: RaviJSON]]
  public var source: [String: RaviJSON]

  public init(bindings: [[String: RaviJSON]], rules: [[String: RaviJSON]], source: [String: RaviJSON]) {
    self.bindings = bindings
    self.rules = rules
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case bindings = "bindings"
    case rules = "rules"
    case source = "source"
  }
}

public struct ObserversRulesListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ObserversRulesListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var rules: [[String: RaviJSON]]
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, rules: [[String: RaviJSON]], total: Double) {
    self.items = items
    self.pagination = pagination
    self.rules = rules
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case rules = "rules"
    case total = "total"
  }
}

public struct ObserversRulesRmOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ObserversRulesRmReturn: Codable, Sendable {
  public var deleted: RaviJSON
  public var success: Bool

  public init(deleted: RaviJSON, success: Bool) {
    self.deleted = deleted
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case deleted = "deleted"
    case success = "success"
  }
}

public struct ObserversRulesSetOptions: Codable, Sendable {
  public var delivery: String?
  public var disabled: Bool?
  public var events: String?
  public var meta: String?
  public var mode: String?
  public var model: String?
  public var permissions: String?
  public var priority: String?
  public var profile: String?
  public var provider: String?
  public var role: String?
  public var scope: String?
  public var selector: String?
  public var sourceAgent: String?
  public var sourceProfile: String?
  public var sourceProject: String?
  public var sourceSession: String?
  public var sourceTask: String?
  public var tag: String?
  public var tagInherited: Bool?
  public var tagTarget: String?

  public init(delivery: String? = nil, disabled: Bool? = nil, events: String? = nil, meta: String? = nil, mode: String? = nil, model: String? = nil, permissions: String? = nil, priority: String? = nil, profile: String? = nil, provider: String? = nil, role: String? = nil, scope: String? = nil, selector: String? = nil, sourceAgent: String? = nil, sourceProfile: String? = nil, sourceProject: String? = nil, sourceSession: String? = nil, sourceTask: String? = nil, tag: String? = nil, tagInherited: Bool? = nil, tagTarget: String? = nil) {
    self.delivery = delivery
    self.disabled = disabled
    self.events = events
    self.meta = meta
    self.mode = mode
    self.model = model
    self.permissions = permissions
    self.priority = priority
    self.profile = profile
    self.provider = provider
    self.role = role
    self.scope = scope
    self.selector = selector
    self.sourceAgent = sourceAgent
    self.sourceProfile = sourceProfile
    self.sourceProject = sourceProject
    self.sourceSession = sourceSession
    self.sourceTask = sourceTask
    self.tag = tag
    self.tagInherited = tagInherited
    self.tagTarget = tagTarget
  }

  enum CodingKeys: String, CodingKey {
    case delivery = "delivery"
    case disabled = "disabled"
    case events = "events"
    case meta = "meta"
    case mode = "mode"
    case model = "model"
    case permissions = "permissions"
    case priority = "priority"
    case profile = "profile"
    case provider = "provider"
    case role = "role"
    case scope = "scope"
    case selector = "selector"
    case sourceAgent = "sourceAgent"
    case sourceProfile = "sourceProfile"
    case sourceProject = "sourceProject"
    case sourceSession = "sourceSession"
    case sourceTask = "sourceTask"
    case tag = "tag"
    case tagInherited = "tagInherited"
    case tagTarget = "tagTarget"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.delivery {
      body["delivery"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.disabled {
      body["disabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.events {
      body["events"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.meta {
      body["meta"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mode {
      body["mode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.permissions {
      body["permissions"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.selector {
      body["selector"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sourceAgent {
      body["sourceAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sourceProfile {
      body["sourceProfile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sourceProject {
      body["sourceProject"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sourceSession {
      body["sourceSession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sourceTask {
      body["sourceTask"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tagInherited {
      body["tagInherited"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tagTarget {
      body["tagTarget"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ObserversRulesSetReturn: Codable, Sendable {
  public var rule: [String: RaviJSON]
  public var success: Bool

  public init(rule: [String: RaviJSON], success: Bool) {
    self.rule = rule
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case rule = "rule"
    case success = "success"
  }
}

public struct ObserversRulesShowReturn: Codable, Sendable {
  public var rule: [String: RaviJSON]

  public init(rule: [String: RaviJSON]) {
    self.rule = rule
  }

  enum CodingKeys: String, CodingKey {
    case rule = "rule"
  }
}

public struct ObserversRulesValidateReturn: Codable, Sendable {
  public var errors: [[String: RaviJSON]]
  public var ok: Bool

  public init(errors: [[String: RaviJSON]], ok: Bool) {
    self.errors = errors
    self.ok = ok
  }

  enum CodingKeys: String, CodingKey {
    case errors = "errors"
    case ok = "ok"
  }
}

public struct ObserversShowReturn: Codable, Sendable {
  public var binding: [String: RaviJSON]

  public init(binding: [String: RaviJSON]) {
    self.binding = binding
  }

  enum CodingKeys: String, CodingKey {
    case binding = "binding"
  }
}

public struct PagesCreateOptions: Codable, Sendable {
  public var console: String?
  public var defaultSite: Bool?
  public var execute: Bool?
  public var project: String?
  public var visibility: String?

  public init(console: String? = nil, defaultSite: Bool? = nil, execute: Bool? = nil, project: String? = nil, visibility: String? = nil) {
    self.console = console
    self.defaultSite = defaultSite
    self.execute = execute
    self.project = project
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case defaultSite = "defaultSite"
    case execute = "execute"
    case project = "project"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.defaultSite {
      body["defaultSite"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PagesCreateReturn: Codable, Sendable {
  public var consoleUrl: String
  public var contentPublishCommand: RaviJSON
  public var projectRef: String
  public var site: [String: RaviJSON]
  public var success: Bool
  public var url: RaviJSON

  public init(consoleUrl: String, contentPublishCommand: RaviJSON, projectRef: String, site: [String: RaviJSON], success: Bool, url: RaviJSON) {
    self.consoleUrl = consoleUrl
    self.contentPublishCommand = contentPublishCommand
    self.projectRef = projectRef
    self.site = site
    self.success = success
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case consoleUrl = "consoleUrl"
    case contentPublishCommand = "contentPublishCommand"
    case projectRef = "projectRef"
    case site = "site"
    case success = "success"
    case url = "url"
  }
}

public struct PagesDomainsOptions: Codable, Sendable {
  public var check: Bool?
  public var console: String?
  public var execute: Bool?
  public var project: String?

  public init(check: Bool? = nil, console: String? = nil, execute: Bool? = nil, project: String? = nil) {
    self.check = check
    self.console = console
    self.execute = execute
    self.project = project
  }

  enum CodingKeys: String, CodingKey {
    case check = "check"
    case console = "console"
    case execute = "execute"
    case project = "project"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.check {
      body["check"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PagesDomainsReturn: Codable, Sendable {
  public var bindings: [[String: RaviJSON]]
  public var consoleUrl: String
  public var hostnames: [String]
  public var projectRef: String
  public var site: [String: RaviJSON]
  public var siteRef: String
  public var success: Bool
  public var total: Double

  public init(bindings: [[String: RaviJSON]], consoleUrl: String, hostnames: [String], projectRef: String, site: [String: RaviJSON], siteRef: String, success: Bool, total: Double) {
    self.bindings = bindings
    self.consoleUrl = consoleUrl
    self.hostnames = hostnames
    self.projectRef = projectRef
    self.site = site
    self.siteRef = siteRef
    self.success = success
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case bindings = "bindings"
    case consoleUrl = "consoleUrl"
    case hostnames = "hostnames"
    case projectRef = "projectRef"
    case site = "site"
    case siteRef = "siteRef"
    case success = "success"
    case total = "total"
  }
}

public struct PagesListOptions: Codable, Sendable {
  public var console: String?
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(console: String? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.console = console
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PagesListReturn: Codable, Sendable {
  public var consoleUrl: String
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var projectRef: String
  public var sites: [[String: RaviJSON]]
  public var success: Bool
  public var total: Double

  public init(consoleUrl: String, items: [[String: RaviJSON]], pagination: RaviJSON, projectRef: String, sites: [[String: RaviJSON]], success: Bool, total: Double) {
    self.consoleUrl = consoleUrl
    self.items = items
    self.pagination = pagination
    self.projectRef = projectRef
    self.sites = sites
    self.success = success
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case consoleUrl = "consoleUrl"
    case items = "items"
    case pagination = "pagination"
    case projectRef = "projectRef"
    case sites = "sites"
    case success = "success"
    case total = "total"
  }
}

public struct PagesPasswordRemoveOptions: Codable, Sendable {
  public var console: String?
  public var execute: Bool?
  public var project: String?
  public var route: String?
  public var visibility: String?

  public init(console: String? = nil, execute: Bool? = nil, project: String? = nil, route: String? = nil, visibility: String? = nil) {
    self.console = console
    self.execute = execute
    self.project = project
    self.route = route
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case execute = "execute"
    case project = "project"
    case route = "route"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.route {
      body["route"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PagesPasswordRemoveReturn: Codable, Sendable {
  public var action: String
  public var configured: Bool
  public var consoleUrl: String
  public var path: String
  public var policy: RaviJSON
  public var projectRef: String
  public var release: [String: RaviJSON]
  public var route: [String: RaviJSON]
  public var scope: String
  public var site: [String: RaviJSON]
  public var siteRef: String
  public var success: Bool
  public var url: String

  public init(action: String, configured: Bool, consoleUrl: String, path: String, policy: RaviJSON, projectRef: String, release: [String: RaviJSON], route: [String: RaviJSON], scope: String, site: [String: RaviJSON], siteRef: String, success: Bool, url: String) {
    self.action = action
    self.configured = configured
    self.consoleUrl = consoleUrl
    self.path = path
    self.policy = policy
    self.projectRef = projectRef
    self.release = release
    self.route = route
    self.scope = scope
    self.site = site
    self.siteRef = siteRef
    self.success = success
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case configured = "configured"
    case consoleUrl = "consoleUrl"
    case path = "path"
    case policy = "policy"
    case projectRef = "projectRef"
    case release = "release"
    case route = "route"
    case scope = "scope"
    case site = "site"
    case siteRef = "siteRef"
    case success = "success"
    case url = "url"
  }
}

public struct PagesPasswordStatusOptions: Codable, Sendable {
  public var console: String?
  public var project: String?
  public var route: String?

  public init(console: String? = nil, project: String? = nil, route: String? = nil) {
    self.console = console
    self.project = project
    self.route = route
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case project = "project"
    case route = "route"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.route {
      body["route"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PagesPasswordStatusReturn: Codable, Sendable {
  public var action: String
  public var configured: Bool
  public var consoleUrl: String
  public var path: String
  public var policy: RaviJSON
  public var projectRef: String
  public var release: [String: RaviJSON]
  public var route: [String: RaviJSON]
  public var scope: String
  public var site: [String: RaviJSON]
  public var siteRef: String
  public var success: Bool
  public var url: String

  public init(action: String, configured: Bool, consoleUrl: String, path: String, policy: RaviJSON, projectRef: String, release: [String: RaviJSON], route: [String: RaviJSON], scope: String, site: [String: RaviJSON], siteRef: String, success: Bool, url: String) {
    self.action = action
    self.configured = configured
    self.consoleUrl = consoleUrl
    self.path = path
    self.policy = policy
    self.projectRef = projectRef
    self.release = release
    self.route = route
    self.scope = scope
    self.site = site
    self.siteRef = siteRef
    self.success = success
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case configured = "configured"
    case consoleUrl = "consoleUrl"
    case path = "path"
    case policy = "policy"
    case projectRef = "projectRef"
    case release = "release"
    case route = "route"
    case scope = "scope"
    case site = "site"
    case siteRef = "siteRef"
    case success = "success"
    case url = "url"
  }
}

public struct PagesPublishOptions: Codable, Sendable {
  public var artifactSlug: String?
  public var artifactVersion: String?
  public var assetBase: String?
  public var basePath: String?
  public var console: String?
  public var description: String?
  public var entrypoint: String?
  public var execute: Bool?
  public var idempotencyKey: String?
  public var noActivate: Bool?
  public var project: String?
  public var reason: String?
  public var replaceRelease: Bool?
  public var route: String?
  public var site: String?
  public var title: String?
  public var uploadSession: String?
  public var visibility: String?

  public init(artifactSlug: String? = nil, artifactVersion: String? = nil, assetBase: String? = nil, basePath: String? = nil, console: String? = nil, description: String? = nil, entrypoint: String? = nil, execute: Bool? = nil, idempotencyKey: String? = nil, noActivate: Bool? = nil, project: String? = nil, reason: String? = nil, replaceRelease: Bool? = nil, route: String? = nil, site: String? = nil, title: String? = nil, uploadSession: String? = nil, visibility: String? = nil) {
    self.artifactSlug = artifactSlug
    self.artifactVersion = artifactVersion
    self.assetBase = assetBase
    self.basePath = basePath
    self.console = console
    self.description = description
    self.entrypoint = entrypoint
    self.execute = execute
    self.idempotencyKey = idempotencyKey
    self.noActivate = noActivate
    self.project = project
    self.reason = reason
    self.replaceRelease = replaceRelease
    self.route = route
    self.site = site
    self.title = title
    self.uploadSession = uploadSession
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case artifactSlug = "artifactSlug"
    case artifactVersion = "artifactVersion"
    case assetBase = "assetBase"
    case basePath = "basePath"
    case console = "console"
    case description = "description"
    case entrypoint = "entrypoint"
    case execute = "execute"
    case idempotencyKey = "idempotencyKey"
    case noActivate = "noActivate"
    case project = "project"
    case reason = "reason"
    case replaceRelease = "replaceRelease"
    case route = "route"
    case site = "site"
    case title = "title"
    case uploadSession = "uploadSession"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.artifactSlug {
      body["artifactSlug"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.artifactVersion {
      body["artifactVersion"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.assetBase {
      body["assetBase"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.basePath {
      body["basePath"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.entrypoint {
      body["entrypoint"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.idempotencyKey {
      body["idempotencyKey"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.noActivate {
      body["noActivate"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.replaceRelease {
      body["replaceRelease"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.route {
      body["route"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.site {
      body["site"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.uploadSession {
      body["uploadSession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PagesPublishReturn: Codable, Sendable {
  public var artifact: RaviJSON
  public var artifactVersion: RaviJSON
  public var authenticated: Bool
  public var consoleUrl: String
  public var localSync: RaviJSON
  public var publish: RaviJSON
  public var release: RaviJSON
  public var routes: [[String: RaviJSON]]
  public var site: RaviJSON
  public var success: Bool
  public var upload: RaviJSON
  public var uploadSession: RaviJSON
  public var url: RaviJSON

  public init(artifact: RaviJSON, artifactVersion: RaviJSON, authenticated: Bool, consoleUrl: String, localSync: RaviJSON, publish: RaviJSON, release: RaviJSON, routes: [[String: RaviJSON]], site: RaviJSON, success: Bool, upload: RaviJSON, uploadSession: RaviJSON, url: RaviJSON) {
    self.artifact = artifact
    self.artifactVersion = artifactVersion
    self.authenticated = authenticated
    self.consoleUrl = consoleUrl
    self.localSync = localSync
    self.publish = publish
    self.release = release
    self.routes = routes
    self.site = site
    self.success = success
    self.upload = upload
    self.uploadSession = uploadSession
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case artifactVersion = "artifactVersion"
    case authenticated = "authenticated"
    case consoleUrl = "consoleUrl"
    case localSync = "localSync"
    case publish = "publish"
    case release = "release"
    case routes = "routes"
    case site = "site"
    case success = "success"
    case upload = "upload"
    case uploadSession = "uploadSession"
    case url = "url"
  }
}

public struct PagesPublishedOptions: Codable, Sendable {
  public var console: String?
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(console: String? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.console = console
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PagesPublishedReturn: Codable, Sendable {
  public var consoleUrl: String
  public var items: [[String: RaviJSON]]
  public var pages: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var projectRef: String
  public var success: Bool
  public var total: Double

  public init(consoleUrl: String, items: [[String: RaviJSON]], pages: [[String: RaviJSON]], pagination: RaviJSON, projectRef: String, success: Bool, total: Double) {
    self.consoleUrl = consoleUrl
    self.items = items
    self.pages = pages
    self.pagination = pagination
    self.projectRef = projectRef
    self.success = success
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case consoleUrl = "consoleUrl"
    case items = "items"
    case pages = "pages"
    case pagination = "pagination"
    case projectRef = "projectRef"
    case success = "success"
    case total = "total"
  }
}

public struct PagesUpdateOptions: Codable, Sendable {
  public var console: String?
  public var execute: Bool?
  public var project: String?
  public var visibility: String?

  public init(console: String? = nil, execute: Bool? = nil, project: String? = nil, visibility: String? = nil) {
    self.console = console
    self.execute = execute
    self.project = project
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case execute = "execute"
    case project = "project"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PagesUpdateReturn: Codable, Sendable {
  public var consoleUrl: String
  public var edgeManifestRepair: RaviJSON
  public var projectRef: String
  public var site: [String: RaviJSON]
  public var siteRef: String
  public var success: Bool
  public var url: RaviJSON

  public init(consoleUrl: String, edgeManifestRepair: RaviJSON, projectRef: String, site: [String: RaviJSON], siteRef: String, success: Bool, url: RaviJSON) {
    self.consoleUrl = consoleUrl
    self.edgeManifestRepair = edgeManifestRepair
    self.projectRef = projectRef
    self.site = site
    self.siteRef = siteRef
    self.success = success
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case consoleUrl = "consoleUrl"
    case edgeManifestRepair = "edgeManifestRepair"
    case projectRef = "projectRef"
    case site = "site"
    case siteRef = "siteRef"
    case success = "success"
    case url = "url"
  }
}

public struct PagesVisibilityOptions: Codable, Sendable {
  public var console: String?
  public var execute: Bool?
  public var project: String?

  public init(console: String? = nil, execute: Bool? = nil, project: String? = nil) {
    self.console = console
    self.execute = execute
    self.project = project
  }

  enum CodingKeys: String, CodingKey {
    case console = "console"
    case execute = "execute"
    case project = "project"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.console {
      body["console"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PagesVisibilityReturn: Codable, Sendable {
  public var consoleUrl: String
  public var edgeManifestRepair: RaviJSON
  public var projectRef: String
  public var site: [String: RaviJSON]
  public var siteRef: String
  public var success: Bool
  public var url: RaviJSON

  public init(consoleUrl: String, edgeManifestRepair: RaviJSON, projectRef: String, site: [String: RaviJSON], siteRef: String, success: Bool, url: RaviJSON) {
    self.consoleUrl = consoleUrl
    self.edgeManifestRepair = edgeManifestRepair
    self.projectRef = projectRef
    self.site = site
    self.siteRef = siteRef
    self.success = success
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case consoleUrl = "consoleUrl"
    case edgeManifestRepair = "edgeManifestRepair"
    case projectRef = "projectRef"
    case site = "site"
    case siteRef = "siteRef"
    case success = "success"
    case url = "url"
  }
}

public struct PermissionsAllowOptions: Codable, Sendable {
  public var agent: String?
  public var apply: Bool?
  public var capabilities: String?
  public var description: String?
  public var label: String?
  public var to: String?

  public init(agent: String? = nil, apply: Bool? = nil, capabilities: String? = nil, description: String? = nil, label: String? = nil, to: String? = nil) {
    self.agent = agent
    self.apply = apply
    self.capabilities = capabilities
    self.description = description
    self.label = label
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case apply = "apply"
    case capabilities = "capabilities"
    case description = "description"
    case label = "label"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.apply {
      body["apply"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.capabilities {
      body["capabilities"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PermissionsAllowReturn: Codable, Sendable {
  public var agentCeilings: [String]
  public var capabilities: [RaviJSON]
  public var changedCount: Double
  public var description: String?
  public var dryRun: Bool
  public var label: String
  public var nextCommand: String?
  public var operations: [RaviJSON]
  public var profile: String
  public var tagSlug: String
  public var targets: [RaviJSON]

  public init(agentCeilings: [String], capabilities: [RaviJSON], changedCount: Double, description: String? = nil, dryRun: Bool, label: String, nextCommand: String? = nil, operations: [RaviJSON], profile: String, tagSlug: String, targets: [RaviJSON]) {
    self.agentCeilings = agentCeilings
    self.capabilities = capabilities
    self.changedCount = changedCount
    self.description = description
    self.dryRun = dryRun
    self.label = label
    self.nextCommand = nextCommand
    self.operations = operations
    self.profile = profile
    self.tagSlug = tagSlug
    self.targets = targets
  }

  enum CodingKeys: String, CodingKey {
    case agentCeilings = "agentCeilings"
    case capabilities = "capabilities"
    case changedCount = "changedCount"
    case description = "description"
    case dryRun = "dryRun"
    case label = "label"
    case nextCommand = "nextCommand"
    case operations = "operations"
    case profile = "profile"
    case tagSlug = "tagSlug"
    case targets = "targets"
  }
}

public struct PermissionsCheckOptions: Codable, Sendable {
  public var localOperator: Bool?
  public var objectId: String?
  public var objectType: String?
  public var permission: String?

  public init(localOperator: Bool? = nil, objectId: String? = nil, objectType: String? = nil, permission: String? = nil) {
    self.localOperator = localOperator
    self.objectId = objectId
    self.objectType = objectType
    self.permission = permission
  }

  enum CodingKeys: String, CodingKey {
    case localOperator = "localOperator"
    case objectId = "objectId"
    case objectType = "objectType"
    case permission = "permission"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.localOperator {
      body["localOperator"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.objectId {
      body["objectId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.objectType {
      body["objectType"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.permission {
      body["permission"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PermissionsCheckReturn: Codable, Sendable {
  public var allowed: Bool
  public var decision: RaviJSON
  public var guidance: RaviJSON?

  public init(allowed: Bool, decision: RaviJSON, guidance: RaviJSON? = nil) {
    self.allowed = allowed
    self.decision = decision
    self.guidance = guidance
  }

  enum CodingKeys: String, CodingKey {
    case allowed = "allowed"
    case decision = "decision"
    case guidance = "guidance"
  }
}

public struct PermissionsMaterializeOptions: Codable, Sendable {
  public var subjectId: String?
  public var subjectType: String?

  public init(subjectId: String? = nil, subjectType: String? = nil) {
    self.subjectId = subjectId
    self.subjectType = subjectType
  }

  enum CodingKeys: String, CodingKey {
    case subjectId = "subjectId"
    case subjectType = "subjectType"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.subjectId {
      body["subjectId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.subjectType {
      body["subjectType"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PermissionsMaterializeReturn: Codable, Sendable {
  public var capabilities: [RaviJSON]
  public var guidance: RaviJSON
  public var subject: RaviJSON

  public init(capabilities: [RaviJSON], guidance: RaviJSON, subject: RaviJSON) {
    self.capabilities = capabilities
    self.guidance = guidance
    self.subject = subject
  }

  enum CodingKeys: String, CodingKey {
    case capabilities = "capabilities"
    case guidance = "guidance"
    case subject = "subject"
  }
}

public struct PermissionsResolveOptions: Codable, Sendable {
  public var apply: Bool?
  public var capabilities: String?
  public var profile: String?

  public init(apply: Bool? = nil, capabilities: String? = nil, profile: String? = nil) {
    self.apply = apply
    self.capabilities = capabilities
    self.profile = profile
  }

  enum CodingKeys: String, CodingKey {
    case apply = "apply"
    case capabilities = "capabilities"
    case profile = "profile"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.apply {
      body["apply"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.capabilities {
      body["capabilities"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct PermissionsResolveReturn: Codable, Sendable {
  public var agentCeilings: [String]
  public var capabilities: [RaviJSON]
  public var changedCount: Double
  public var denial: RaviJSON
  public var description: String?
  public var dryRun: Bool
  public var guidance: RaviJSON?
  public var label: String
  public var nextCommand: String?
  public var operations: [RaviJSON]
  public var profile: String
  public var tagSlug: String
  public var targets: [RaviJSON]

  public init(agentCeilings: [String], capabilities: [RaviJSON], changedCount: Double, denial: RaviJSON, description: String? = nil, dryRun: Bool, guidance: RaviJSON? = nil, label: String, nextCommand: String? = nil, operations: [RaviJSON], profile: String, tagSlug: String, targets: [RaviJSON]) {
    self.agentCeilings = agentCeilings
    self.capabilities = capabilities
    self.changedCount = changedCount
    self.denial = denial
    self.description = description
    self.dryRun = dryRun
    self.guidance = guidance
    self.label = label
    self.nextCommand = nextCommand
    self.operations = operations
    self.profile = profile
    self.tagSlug = tagSlug
    self.targets = targets
  }

  enum CodingKeys: String, CodingKey {
    case agentCeilings = "agentCeilings"
    case capabilities = "capabilities"
    case changedCount = "changedCount"
    case denial = "denial"
    case description = "description"
    case dryRun = "dryRun"
    case guidance = "guidance"
    case label = "label"
    case nextCommand = "nextCommand"
    case operations = "operations"
    case profile = "profile"
    case tagSlug = "tagSlug"
    case targets = "targets"
  }
}

public struct PermissionsStatusReturn: Codable, Sendable {
  public var authorizationProviders: [RaviJSON]
  public var capabilityMaterializers: [RaviJSON]
  public var guidance: RaviJSON
  public var mutationCommands: RaviJSON
  public var status: String

  public init(authorizationProviders: [RaviJSON], capabilityMaterializers: [RaviJSON], guidance: RaviJSON, mutationCommands: RaviJSON, status: String) {
    self.authorizationProviders = authorizationProviders
    self.capabilityMaterializers = capabilityMaterializers
    self.guidance = guidance
    self.mutationCommands = mutationCommands
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case authorizationProviders = "authorizationProviders"
    case capabilityMaterializers = "capabilityMaterializers"
    case guidance = "guidance"
    case mutationCommands = "mutationCommands"
    case status = "status"
  }
}

public struct ProjectsCreateOptions: Codable, Sendable {
  public var hypothesis: String?
  public var lastSignalAt: String?
  public var nextStep: String?
  public var ownerAgent: String?
  public var session: String?
  public var slug: String?
  public var status: String?
  public var summary: String?

  public init(hypothesis: String? = nil, lastSignalAt: String? = nil, nextStep: String? = nil, ownerAgent: String? = nil, session: String? = nil, slug: String? = nil, status: String? = nil, summary: String? = nil) {
    self.hypothesis = hypothesis
    self.lastSignalAt = lastSignalAt
    self.nextStep = nextStep
    self.ownerAgent = ownerAgent
    self.session = session
    self.slug = slug
    self.status = status
    self.summary = summary
  }

  enum CodingKeys: String, CodingKey {
    case hypothesis = "hypothesis"
    case lastSignalAt = "lastSignalAt"
    case nextStep = "nextStep"
    case ownerAgent = "ownerAgent"
    case session = "session"
    case slug = "slug"
    case status = "status"
    case summary = "summary"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.hypothesis {
      body["hypothesis"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.lastSignalAt {
      body["lastSignalAt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.nextStep {
      body["nextStep"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ownerAgent {
      body["ownerAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.slug {
      body["slug"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.summary {
      body["summary"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProjectsCreateReturn = [String: RaviJSON]

public struct ProjectsFixturesSeedOptions: Codable, Sendable {
  public var execute: Bool?
  public var ownerAgent: String?

  public init(execute: Bool? = nil, ownerAgent: String? = nil) {
    self.execute = execute
    self.ownerAgent = ownerAgent
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case ownerAgent = "ownerAgent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ownerAgent {
      body["ownerAgent"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsFixturesSeedReturn: Codable, Sendable {
  public var fixtures: [[String: RaviJSON]]
  public var total: Double

  public init(fixtures: [[String: RaviJSON]], total: Double) {
    self.fixtures = fixtures
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case fixtures = "fixtures"
    case total = "total"
  }
}

public struct ProjectsInitOptions: Codable, Sendable {
  public var hypothesis: String?
  public var lastSignalAt: String?
  public var nextStep: String?
  public var ownerAgent: String?
  public var resource: [String]?
  public var session: String?
  public var slug: String?
  public var status: String?
  public var summary: String?
  public var workflowRun: [String]?
  public var workflowTemplate: [String]?

  public init(hypothesis: String? = nil, lastSignalAt: String? = nil, nextStep: String? = nil, ownerAgent: String? = nil, resource: [String]? = nil, session: String? = nil, slug: String? = nil, status: String? = nil, summary: String? = nil, workflowRun: [String]? = nil, workflowTemplate: [String]? = nil) {
    self.hypothesis = hypothesis
    self.lastSignalAt = lastSignalAt
    self.nextStep = nextStep
    self.ownerAgent = ownerAgent
    self.resource = resource
    self.session = session
    self.slug = slug
    self.status = status
    self.summary = summary
    self.workflowRun = workflowRun
    self.workflowTemplate = workflowTemplate
  }

  enum CodingKeys: String, CodingKey {
    case hypothesis = "hypothesis"
    case lastSignalAt = "lastSignalAt"
    case nextStep = "nextStep"
    case ownerAgent = "ownerAgent"
    case resource = "resource"
    case session = "session"
    case slug = "slug"
    case status = "status"
    case summary = "summary"
    case workflowRun = "workflowRun"
    case workflowTemplate = "workflowTemplate"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.hypothesis {
      body["hypothesis"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.lastSignalAt {
      body["lastSignalAt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.nextStep {
      body["nextStep"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ownerAgent {
      body["ownerAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.resource {
      body["resource"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.slug {
      body["slug"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.summary {
      body["summary"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowRun {
      body["workflowRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowTemplate {
      body["workflowTemplate"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsInitReturn: Codable, Sendable {
  public var details: [String: RaviJSON]
  public var workflows: [[String: RaviJSON]]

  public init(details: [String: RaviJSON], workflows: [[String: RaviJSON]]) {
    self.details = details
    self.workflows = workflows
  }

  enum CodingKeys: String, CodingKey {
    case details = "details"
    case workflows = "workflows"
  }
}

public struct ProjectsLinkOptions: Codable, Sendable {
  public var label: String?
  public var meta: String?
  public var resourceType: String?
  public var role: String?

  public init(label: String? = nil, meta: String? = nil, resourceType: String? = nil, role: String? = nil) {
    self.label = label
    self.meta = meta
    self.resourceType = resourceType
    self.role = role
  }

  enum CodingKeys: String, CodingKey {
    case label = "label"
    case meta = "meta"
    case resourceType = "resourceType"
    case role = "role"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.meta {
      body["meta"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.resourceType {
      body["resourceType"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProjectsLinkReturn = [String: RaviJSON]

public struct ProjectsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var status: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, status: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.status = status
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case status = "status"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsListReturn: Codable, Sendable {
  public var filters: [String: RaviJSON]
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var projects: [[String: RaviJSON]]
  public var total: Double

  public init(filters: [String: RaviJSON], items: [[String: RaviJSON]], pagination: RaviJSON, projects: [[String: RaviJSON]], total: Double) {
    self.filters = filters
    self.items = items
    self.pagination = pagination
    self.projects = projects
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case filters = "filters"
    case items = "items"
    case pagination = "pagination"
    case projects = "projects"
    case total = "total"
  }
}

public struct ProjectsNextOptions: Codable, Sendable {
  public var fields: String?
  public var status: String?
  public var tag: String?

  public init(fields: String? = nil, status: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.status = status
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case status = "status"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsNextReturn: Codable, Sendable {
  public var filters: [String: RaviJSON]
  public var projects: [[String: RaviJSON]]
  public var total: Double

  public init(filters: [String: RaviJSON], projects: [[String: RaviJSON]], total: Double) {
    self.filters = filters
    self.projects = projects
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case filters = "filters"
    case projects = "projects"
    case total = "total"
  }
}

public struct ProjectsResourcesAddOptions: Codable, Sendable {
  public var label: String?
  public var meta: String?
  public var role: String?
  public var type: String?

  public init(label: String? = nil, meta: String? = nil, role: String? = nil, type: String? = nil) {
    self.label = label
    self.meta = meta
    self.role = role
    self.type = type
  }

  enum CodingKeys: String, CodingKey {
    case label = "label"
    case meta = "meta"
    case role = "role"
    case type = "type"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.meta {
      body["meta"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.type {
      body["type"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProjectsResourcesAddReturn = [String: RaviJSON]

public struct ProjectsResourcesImportOptions: Codable, Sendable {
  public var group: [String]?
  public var meta: String?
  public var repo: [String]?
  public var role: String?
  public var url: [String]?
  public var worktree: [String]?

  public init(group: [String]? = nil, meta: String? = nil, repo: [String]? = nil, role: String? = nil, url: [String]? = nil, worktree: [String]? = nil) {
    self.group = group
    self.meta = meta
    self.repo = repo
    self.role = role
    self.url = url
    self.worktree = worktree
  }

  enum CodingKeys: String, CodingKey {
    case group = "group"
    case meta = "meta"
    case repo = "repo"
    case role = "role"
    case url = "url"
    case worktree = "worktree"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.group {
      body["group"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.meta {
      body["meta"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.repo {
      body["repo"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.url {
      body["url"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.worktree {
      body["worktree"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsResourcesImportReturn: Codable, Sendable {
  public var resources: [[String: RaviJSON]]
  public var total: Double

  public init(resources: [[String: RaviJSON]], total: Double) {
    self.resources = resources
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case resources = "resources"
    case total = "total"
  }
}

public struct ProjectsResourcesListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var type: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, type: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.type = type
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case type = "type"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.type {
      body["type"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsResourcesListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var resources: [[String: RaviJSON]]
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, resources: [[String: RaviJSON]], total: Double) {
    self.items = items
    self.pagination = pagination
    self.resources = resources
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case resources = "resources"
    case total = "total"
  }
}

public typealias ProjectsResourcesShowReturn = [String: RaviJSON]

public typealias ProjectsShowReturn = [String: RaviJSON]

public typealias ProjectsStatusReturn = [String: RaviJSON]

public struct ProjectsTasksAttachOptions: Codable, Sendable {
  public var agent: String?
  public var dispatch: Bool?
  public var session: String?
  public var workflow: String?

  public init(agent: String? = nil, dispatch: Bool? = nil, session: String? = nil, workflow: String? = nil) {
    self.agent = agent
    self.dispatch = dispatch
    self.session = session
    self.workflow = workflow
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case dispatch = "dispatch"
    case session = "session"
    case workflow = "workflow"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dispatch {
      body["dispatch"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflow {
      body["workflow"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsTasksAttachReturn: Codable, Sendable {
  public var defaults: [String: RaviJSON]
  public var details: [String: RaviJSON]
  public var workflow: [String: RaviJSON]

  public init(defaults: [String: RaviJSON], details: [String: RaviJSON], workflow: [String: RaviJSON]) {
    self.defaults = defaults
    self.details = details
    self.workflow = workflow
  }

  enum CodingKeys: String, CodingKey {
    case defaults = "defaults"
    case details = "details"
    case workflow = "workflow"
  }
}

public struct ProjectsTasksCreateOptions: Codable, Sendable {
  public var agent: String?
  public var dispatch: Bool?
  public var instructions: String?
  public var priority: String?
  public var profile: String?
  public var session: String?
  public var workflow: String?

  public init(agent: String? = nil, dispatch: Bool? = nil, instructions: String? = nil, priority: String? = nil, profile: String? = nil, session: String? = nil, workflow: String? = nil) {
    self.agent = agent
    self.dispatch = dispatch
    self.instructions = instructions
    self.priority = priority
    self.profile = profile
    self.session = session
    self.workflow = workflow
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case dispatch = "dispatch"
    case instructions = "instructions"
    case priority = "priority"
    case profile = "profile"
    case session = "session"
    case workflow = "workflow"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dispatch {
      body["dispatch"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instructions {
      body["instructions"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflow {
      body["workflow"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsTasksCreateReturn: Codable, Sendable {
  public var defaults: [String: RaviJSON]
  public var details: [String: RaviJSON]
  public var workflow: [String: RaviJSON]

  public init(defaults: [String: RaviJSON], details: [String: RaviJSON], workflow: [String: RaviJSON]) {
    self.defaults = defaults
    self.details = details
    self.workflow = workflow
  }

  enum CodingKeys: String, CodingKey {
    case defaults = "defaults"
    case details = "details"
    case workflow = "workflow"
  }
}

public struct ProjectsTasksDispatchOptions: Codable, Sendable {
  public var agent: String?
  public var execute: Bool?
  public var session: String?

  public init(agent: String? = nil, execute: Bool? = nil, session: String? = nil) {
    self.agent = agent
    self.execute = execute
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case execute = "execute"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsTasksDispatchReturn: Codable, Sendable {
  public var defaults: [String: RaviJSON]
  public var details: [String: RaviJSON]
  public var workflow: [String: RaviJSON]

  public init(defaults: [String: RaviJSON], details: [String: RaviJSON], workflow: [String: RaviJSON]) {
    self.defaults = defaults
    self.details = details
    self.workflow = workflow
  }

  enum CodingKeys: String, CodingKey {
    case defaults = "defaults"
    case details = "details"
    case workflow = "workflow"
  }
}

public struct ProjectsUpdateOptions: Codable, Sendable {
  public var hypothesis: String?
  public var lastSignalAt: String?
  public var nextStep: String?
  public var ownerAgent: String?
  public var session: String?
  public var status: String?
  public var summary: String?
  public var title: String?
  public var touchSignal: Bool?

  public init(hypothesis: String? = nil, lastSignalAt: String? = nil, nextStep: String? = nil, ownerAgent: String? = nil, session: String? = nil, status: String? = nil, summary: String? = nil, title: String? = nil, touchSignal: Bool? = nil) {
    self.hypothesis = hypothesis
    self.lastSignalAt = lastSignalAt
    self.nextStep = nextStep
    self.ownerAgent = ownerAgent
    self.session = session
    self.status = status
    self.summary = summary
    self.title = title
    self.touchSignal = touchSignal
  }

  enum CodingKeys: String, CodingKey {
    case hypothesis = "hypothesis"
    case lastSignalAt = "lastSignalAt"
    case nextStep = "nextStep"
    case ownerAgent = "ownerAgent"
    case session = "session"
    case status = "status"
    case summary = "summary"
    case title = "title"
    case touchSignal = "touchSignal"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.hypothesis {
      body["hypothesis"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.lastSignalAt {
      body["lastSignalAt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.nextStep {
      body["nextStep"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ownerAgent {
      body["ownerAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.summary {
      body["summary"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.touchSignal {
      body["touchSignal"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProjectsUpdateReturn = [String: RaviJSON]

public struct ProjectsWorkflowsAttachOptions: Codable, Sendable {
  public var role: String?

  public init(role: String? = nil) {
    self.role = role
  }

  enum CodingKeys: String, CodingKey {
    case role = "role"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsWorkflowsAttachReturn: Codable, Sendable {
  public var details: [String: RaviJSON]
  public var workflow: [String: RaviJSON]

  public init(details: [String: RaviJSON], workflow: [String: RaviJSON]) {
    self.details = details
    self.workflow = workflow
  }

  enum CodingKeys: String, CodingKey {
    case details = "details"
    case workflow = "workflow"
  }
}

public struct ProjectsWorkflowsStartOptions: Codable, Sendable {
  public var execute: Bool?
  public var role: String?
  public var runId: String?

  public init(execute: Bool? = nil, role: String? = nil, runId: String? = nil) {
    self.execute = execute
    self.role = role
    self.runId = runId
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case role = "role"
    case runId = "runId"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.runId {
      body["runId"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProjectsWorkflowsStartReturn: Codable, Sendable {
  public var details: [String: RaviJSON]
  public var workflow: [String: RaviJSON]

  public init(details: [String: RaviJSON], workflow: [String: RaviJSON]) {
    self.details = details
    self.workflow = workflow
  }

  enum CodingKeys: String, CodingKey {
    case details = "details"
    case workflow = "workflow"
  }
}

public struct ProxCallsCancelOptions: Codable, Sendable {
  public var reason: String?

  public init(reason: String? = nil) {
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProxCallsCancelReturn: Codable, Sendable {
  public var message: String
  public var requestId: String
  public var success: Bool

  public init(message: String, requestId: String, success: Bool) {
    self.message = message
    self.requestId = requestId
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case message = "message"
    case requestId = "request_id"
    case success = "success"
  }
}

public struct ProxCallsEventsReturn: Codable, Sendable {
  public var events: [[String: RaviJSON]]
  public var requestId: String
  public var total: Double

  public init(events: [[String: RaviJSON]], requestId: String, total: Double) {
    self.events = events
    self.requestId = requestId
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case events = "events"
    case requestId = "request_id"
    case total = "total"
  }
}

public struct ProxCallsProfilesConfigureOptions: Codable, Sendable {
  public var agentId: String?
  public var dynamicPlaceholder: [String]?
  public var execute: Bool?
  public var firstMessage: String?
  public var language: String?
  public var prompt: String?
  public var provider: String?
  public var skipProviderSync: Bool?
  public var systemPromptPath: String?
  public var twilioNumberId: String?
  public var voicemailPolicy: String?

  public init(agentId: String? = nil, dynamicPlaceholder: [String]? = nil, execute: Bool? = nil, firstMessage: String? = nil, language: String? = nil, prompt: String? = nil, provider: String? = nil, skipProviderSync: Bool? = nil, systemPromptPath: String? = nil, twilioNumberId: String? = nil, voicemailPolicy: String? = nil) {
    self.agentId = agentId
    self.dynamicPlaceholder = dynamicPlaceholder
    self.execute = execute
    self.firstMessage = firstMessage
    self.language = language
    self.prompt = prompt
    self.provider = provider
    self.skipProviderSync = skipProviderSync
    self.systemPromptPath = systemPromptPath
    self.twilioNumberId = twilioNumberId
    self.voicemailPolicy = voicemailPolicy
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case dynamicPlaceholder = "dynamicPlaceholder"
    case execute = "execute"
    case firstMessage = "firstMessage"
    case language = "language"
    case prompt = "prompt"
    case provider = "provider"
    case skipProviderSync = "skipProviderSync"
    case systemPromptPath = "systemPromptPath"
    case twilioNumberId = "twilioNumberId"
    case voicemailPolicy = "voicemailPolicy"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agentId {
      body["agentId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dynamicPlaceholder {
      body["dynamicPlaceholder"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.firstMessage {
      body["firstMessage"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.language {
      body["language"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.prompt {
      body["prompt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipProviderSync {
      body["skipProviderSync"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.systemPromptPath {
      body["systemPromptPath"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.twilioNumberId {
      body["twilioNumberId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.voicemailPolicy {
      body["voicemailPolicy"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProxCallsProfilesConfigureReturn: Codable, Sendable {
  public var profile: [String: RaviJSON]
  public var providerSync: RaviJSON

  public init(profile: [String: RaviJSON], providerSync: RaviJSON) {
    self.profile = profile
    self.providerSync = providerSync
  }

  enum CodingKeys: String, CodingKey {
    case profile = "profile"
    case providerSync = "provider_sync"
  }
}

public struct ProxCallsProfilesListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProxCallsProfilesListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public typealias ProxCallsProfilesShowReturn = [String: RaviJSON]

public struct ProxCallsRequestOptions: Codable, Sendable {
  public var execute: Bool?
  public var force: Bool?
  public var person: String?
  public var phone: String?
  public var priority: String?
  public var profile: String?
  public var reason: String?
  public var skipOriginNotify: Bool?
  public var var_: [String]?

  public init(execute: Bool? = nil, force: Bool? = nil, person: String? = nil, phone: String? = nil, priority: String? = nil, profile: String? = nil, reason: String? = nil, skipOriginNotify: Bool? = nil, var_: [String]? = nil) {
    self.execute = execute
    self.force = force
    self.person = person
    self.phone = phone
    self.priority = priority
    self.profile = profile
    self.reason = reason
    self.skipOriginNotify = skipOriginNotify
    self.var_ = var_
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case force = "force"
    case person = "person"
    case phone = "phone"
    case priority = "priority"
    case profile = "profile"
    case reason = "reason"
    case skipOriginNotify = "skipOriginNotify"
    case var_ = "var"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.force {
      body["force"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.person {
      body["person"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.phone {
      body["phone"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipOriginNotify {
      body["skipOriginNotify"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.var_ {
      body["var"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProxCallsRequestReturn: Codable, Sendable {
  public var blockReason: RaviJSON?
  public var blocked: Bool
  public var hint: String
  public var providerMode: String
  public var request: [String: RaviJSON]

  public init(blockReason: RaviJSON? = nil, blocked: Bool, hint: String, providerMode: String, request: [String: RaviJSON]) {
    self.blockReason = blockReason
    self.blocked = blocked
    self.hint = hint
    self.providerMode = providerMode
    self.request = request
  }

  enum CodingKeys: String, CodingKey {
    case blockReason = "block_reason"
    case blocked = "blocked"
    case hint = "hint"
    case providerMode = "provider_mode"
    case request = "request"
  }
}

public struct ProxCallsRulesOptions: Codable, Sendable {
  public var scope: String?

  public init(scope: String? = nil) {
    self.scope = scope
  }

  enum CodingKeys: String, CodingKey {
    case scope = "scope"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProxCallsRulesReturn = RaviJSON

public struct ProxCallsShowReturn: Codable, Sendable {
  public var request: [String: RaviJSON]
  public var result: RaviJSON
  public var runs: [[String: RaviJSON]]

  public init(request: [String: RaviJSON], result: RaviJSON, runs: [[String: RaviJSON]]) {
    self.request = request
    self.result = result
    self.runs = runs
  }

  enum CodingKeys: String, CodingKey {
    case request = "request"
    case result = "result"
    case runs = "runs"
  }
}

public struct ProxCallsToolsBindOptions: Codable, Sendable {
  public var providerToolName: String?
  public var required: Bool?
  public var toolPrompt: String?

  public init(providerToolName: String? = nil, required: Bool? = nil, toolPrompt: String? = nil) {
    self.providerToolName = providerToolName
    self.required = required
    self.toolPrompt = toolPrompt
  }

  enum CodingKeys: String, CodingKey {
    case providerToolName = "providerToolName"
    case required = "required"
    case toolPrompt = "toolPrompt"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.providerToolName {
      body["providerToolName"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.required {
      body["required"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.toolPrompt {
      body["toolPrompt"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProxCallsToolsBindReturn = [String: RaviJSON]

public struct ProxCallsToolsConfigureOptions: Codable, Sendable {
  public var enabled: String?
  public var timeoutMs: String?

  public init(enabled: String? = nil, timeoutMs: String? = nil) {
    self.enabled = enabled
    self.timeoutMs = timeoutMs
  }

  enum CodingKeys: String, CodingKey {
    case enabled = "enabled"
    case timeoutMs = "timeoutMs"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.enabled {
      body["enabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.timeoutMs {
      body["timeoutMs"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProxCallsToolsConfigureReturn = [String: RaviJSON]

public struct ProxCallsToolsCreateOptions: Codable, Sendable {
  public var description: String?
  public var executor: String?
  public var inputSchema: String?
  public var name: String?
  public var outputSchema: String?
  public var sideEffect: String?

  public init(description: String? = nil, executor: String? = nil, inputSchema: String? = nil, name: String? = nil, outputSchema: String? = nil, sideEffect: String? = nil) {
    self.description = description
    self.executor = executor
    self.inputSchema = inputSchema
    self.name = name
    self.outputSchema = outputSchema
    self.sideEffect = sideEffect
  }

  enum CodingKeys: String, CodingKey {
    case description = "description"
    case executor = "executor"
    case inputSchema = "inputSchema"
    case name = "name"
    case outputSchema = "outputSchema"
    case sideEffect = "sideEffect"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.executor {
      body["executor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.inputSchema {
      body["inputSchema"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.outputSchema {
      body["outputSchema"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sideEffect {
      body["sideEffect"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProxCallsToolsCreateReturn = [String: RaviJSON]

public struct ProxCallsToolsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var profile: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, profile: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.profile = profile
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case profile = "profile"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProxCallsToolsListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct ProxCallsToolsRunOptions: Codable, Sendable {
  public var dryRun: Bool?
  public var input: String?
  public var profile: String?

  public init(dryRun: Bool? = nil, input: String? = nil, profile: String? = nil) {
    self.dryRun = dryRun
    self.input = input
    self.profile = profile
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
    case input = "input"
    case profile = "profile"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.input {
      body["input"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProxCallsToolsRunReturn: Codable, Sendable {
  public var ok: Bool

  public init(ok: Bool) {
    self.ok = ok
  }

  enum CodingKeys: String, CodingKey {
    case ok = "ok"
  }
}

public struct ProxCallsToolsRunsReturn: Codable, Sendable {
  public var requestId: String
  public var toolRuns: [[String: RaviJSON]]
  public var total: Double

  public init(requestId: String, toolRuns: [[String: RaviJSON]], total: Double) {
    self.requestId = requestId
    self.toolRuns = toolRuns
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case requestId = "request_id"
    case toolRuns = "tool_runs"
    case total = "total"
  }
}

public typealias ProxCallsToolsShowReturn = [String: RaviJSON]

public struct ProxCallsToolsUnbindReturn: Codable, Sendable {
  public var success: Bool
  public var toolId: String

  public init(success: Bool, toolId: String) {
    self.success = success
    self.toolId = toolId
  }

  enum CodingKeys: String, CodingKey {
    case success = "success"
    case toolId = "tool_id"
  }
}

public struct ProxCallsTranscriptOptions: Codable, Sendable {
  public var sync: Bool?

  public init(sync: Bool? = nil) {
    self.sync = sync
  }

  enum CodingKeys: String, CodingKey {
    case sync = "sync"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.sync {
      body["sync"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProxCallsTranscriptReturn: Codable, Sendable {
  public var outcome: String
  public var requestId: String
  public var summary: RaviJSON?
  public var transcript: String

  public init(outcome: String, requestId: String, summary: RaviJSON? = nil, transcript: String) {
    self.outcome = outcome
    self.requestId = requestId
    self.summary = summary
    self.transcript = transcript
  }

  enum CodingKeys: String, CodingKey {
    case outcome = "outcome"
    case requestId = "request_id"
    case summary = "summary"
    case transcript = "transcript"
  }
}

public struct ProxCallsVoiceAgentsBindToolOptions: Codable, Sendable {
  public var providerToolName: String?

  public init(providerToolName: String? = nil) {
    self.providerToolName = providerToolName
  }

  enum CodingKeys: String, CodingKey {
    case providerToolName = "providerToolName"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.providerToolName {
      body["providerToolName"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProxCallsVoiceAgentsBindToolReturn = [String: RaviJSON]

public struct ProxCallsVoiceAgentsConfigureOptions: Codable, Sendable {
  public var firstMessage: String?
  public var providerAgentId: String?
  public var systemPromptPath: String?
  public var voiceId: String?

  public init(firstMessage: String? = nil, providerAgentId: String? = nil, systemPromptPath: String? = nil, voiceId: String? = nil) {
    self.firstMessage = firstMessage
    self.providerAgentId = providerAgentId
    self.systemPromptPath = systemPromptPath
    self.voiceId = voiceId
  }

  enum CodingKeys: String, CodingKey {
    case firstMessage = "firstMessage"
    case providerAgentId = "providerAgentId"
    case systemPromptPath = "systemPromptPath"
    case voiceId = "voiceId"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.firstMessage {
      body["firstMessage"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.providerAgentId {
      body["providerAgentId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.systemPromptPath {
      body["systemPromptPath"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.voiceId {
      body["voiceId"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProxCallsVoiceAgentsConfigureReturn = [String: RaviJSON]

public struct ProxCallsVoiceAgentsCreateOptions: Codable, Sendable {
  public var name: String?
  public var provider: String?
  public var systemPromptPath: String?
  public var voiceId: String?

  public init(name: String? = nil, provider: String? = nil, systemPromptPath: String? = nil, voiceId: String? = nil) {
    self.name = name
    self.provider = provider
    self.systemPromptPath = systemPromptPath
    self.voiceId = voiceId
  }

  enum CodingKeys: String, CodingKey {
    case name = "name"
    case provider = "provider"
    case systemPromptPath = "systemPromptPath"
    case voiceId = "voiceId"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.systemPromptPath {
      body["systemPromptPath"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.voiceId {
      body["voiceId"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias ProxCallsVoiceAgentsCreateReturn = [String: RaviJSON]

public struct ProxCallsVoiceAgentsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProxCallsVoiceAgentsListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public typealias ProxCallsVoiceAgentsShowReturn = [String: RaviJSON]

public struct ProxCallsVoiceAgentsSyncOptions: Codable, Sendable {
  public var dryRun: Bool?
  public var provider: Bool?

  public init(dryRun: Bool? = nil, provider: Bool? = nil) {
    self.dryRun = dryRun
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ProxCallsVoiceAgentsSyncReturn: Codable, Sendable {
  public var dryRun: Bool
  public var intendedChanges: [String: RaviJSON]
  public var provider: String
  public var providerAgentId: RaviJSON?
  public var providerSync: String
  public var voiceAgentId: String

  public init(dryRun: Bool, intendedChanges: [String: RaviJSON], provider: String, providerAgentId: RaviJSON? = nil, providerSync: String, voiceAgentId: String) {
    self.dryRun = dryRun
    self.intendedChanges = intendedChanges
    self.provider = provider
    self.providerAgentId = providerAgentId
    self.providerSync = providerSync
    self.voiceAgentId = voiceAgentId
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dry_run"
    case intendedChanges = "intended_changes"
    case provider = "provider"
    case providerAgentId = "provider_agent_id"
    case providerSync = "provider_sync"
    case voiceAgentId = "voice_agent_id"
  }
}

public struct ProxCallsVoiceAgentsUnbindToolReturn: Codable, Sendable {
  public var success: Bool
  public var toolId: String

  public init(success: Bool, toolId: String) {
    self.success = success
    self.toolId = toolId
  }

  enum CodingKeys: String, CodingKey {
    case success = "success"
    case toolId = "tool_id"
  }
}

public struct ReactSendReturn: Codable, Sendable {
  public var event: RaviJSON
  public var executionMode: String
  public var idempotencyKey: String?
  public var nextAttemptAt: Double?
  public var publishPending: Bool?
  public var publishedNow: Bool?
  public var queued: Bool
  public var reaction: RaviJSON
  public var requestId: String?
  public var status: String
  public var target: RaviJSON
  public var topic: String

  public init(event: RaviJSON, executionMode: String, idempotencyKey: String? = nil, nextAttemptAt: Double? = nil, publishPending: Bool? = nil, publishedNow: Bool? = nil, queued: Bool, reaction: RaviJSON, requestId: String? = nil, status: String, target: RaviJSON, topic: String) {
    self.event = event
    self.executionMode = executionMode
    self.idempotencyKey = idempotencyKey
    self.nextAttemptAt = nextAttemptAt
    self.publishPending = publishPending
    self.publishedNow = publishedNow
    self.queued = queued
    self.reaction = reaction
    self.requestId = requestId
    self.status = status
    self.target = target
    self.topic = topic
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case executionMode = "executionMode"
    case idempotencyKey = "idempotencyKey"
    case nextAttemptAt = "nextAttemptAt"
    case publishPending = "publishPending"
    case publishedNow = "publishedNow"
    case queued = "queued"
    case reaction = "reaction"
    case requestId = "requestId"
    case status = "status"
    case target = "target"
    case topic = "topic"
  }
}

public struct RoutesExplainOptions: Codable, Sendable {
  public var channel: String?

  public init(channel: String? = nil) {
    self.channel = channel
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RoutesExplainReturn: Codable, Sendable {
  public var channel: RaviJSON
  public var configuredRoute: RaviJSON
  public var instance: String
  public var liveEffect: RaviJSON
  public var pattern: RaviJSON
  public var target: [String: RaviJSON]

  public init(channel: RaviJSON, configuredRoute: RaviJSON, instance: String, liveEffect: RaviJSON, pattern: RaviJSON, target: [String: RaviJSON]) {
    self.channel = channel
    self.configuredRoute = configuredRoute
    self.instance = instance
    self.liveEffect = liveEffect
    self.pattern = pattern
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case configuredRoute = "configuredRoute"
    case instance = "instance"
    case liveEffect = "liveEffect"
    case pattern = "pattern"
    case target = "target"
  }
}

public struct RoutesListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RoutesListReturn: Codable, Sendable {
  public var filter: [String: RaviJSON]
  public var instance: RaviJSON
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var routes: [[String: RaviJSON]]
  public var total: Double

  public init(filter: [String: RaviJSON], instance: RaviJSON, items: [[String: RaviJSON]], pagination: RaviJSON, routes: [[String: RaviJSON]], total: Double) {
    self.filter = filter
    self.instance = instance
    self.items = items
    self.pagination = pagination
    self.routes = routes
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case filter = "filter"
    case instance = "instance"
    case items = "items"
    case pagination = "pagination"
    case routes = "routes"
    case total = "total"
  }
}

public struct RoutesShowReturn: Codable, Sendable {
  public var instance: String
  public var pattern: String
  public var route: [String: RaviJSON]

  public init(instance: String, pattern: String, route: [String: RaviJSON]) {
    self.instance = instance
    self.pattern = pattern
    self.route = route
  }

  enum CodingKeys: String, CodingKey {
    case instance = "instance"
    case pattern = "pattern"
    case route = "route"
  }
}

public struct RulesImportOptions: Codable, Sendable {
  public var cwd: String?
  public var force: Bool?
  public var includeUser: Bool?
  public var write: Bool?

  public init(cwd: String? = nil, force: Bool? = nil, includeUser: Bool? = nil, write: Bool? = nil) {
    self.cwd = cwd
    self.force = force
    self.includeUser = includeUser
    self.write = write
  }

  enum CodingKeys: String, CodingKey {
    case cwd = "cwd"
    case force = "force"
    case includeUser = "includeUser"
    case write = "write"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cwd {
      body["cwd"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.force {
      body["force"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeUser {
      body["includeUser"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.write {
      body["write"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RulesImportReturn: Codable, Sendable {
  public var candidates: [[String: RaviJSON]]
  public var counts: [String: RaviJSON]
  public var cwd: String
  public var force: Bool
  public var includeUser: Bool
  public var rulesDir: String
  public var sources: [[String: RaviJSON]]
  public var write: Bool

  public init(candidates: [[String: RaviJSON]], counts: [String: RaviJSON], cwd: String, force: Bool, includeUser: Bool, rulesDir: String, sources: [[String: RaviJSON]], write: Bool) {
    self.candidates = candidates
    self.counts = counts
    self.cwd = cwd
    self.force = force
    self.includeUser = includeUser
    self.rulesDir = rulesDir
    self.sources = sources
    self.write = write
  }

  enum CodingKeys: String, CodingKey {
    case candidates = "candidates"
    case counts = "counts"
    case cwd = "cwd"
    case force = "force"
    case includeUser = "includeUser"
    case rulesDir = "rulesDir"
    case sources = "sources"
    case write = "write"
  }
}

public struct RulesSourcesOptions: Codable, Sendable {
  public var cwd: String?
  public var fields: String?
  public var includeUser: Bool?

  public init(cwd: String? = nil, fields: String? = nil, includeUser: Bool? = nil) {
    self.cwd = cwd
    self.fields = fields
    self.includeUser = includeUser
  }

  enum CodingKeys: String, CodingKey {
    case cwd = "cwd"
    case fields = "fields"
    case includeUser = "includeUser"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cwd {
      body["cwd"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeUser {
      body["includeUser"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RulesSourcesReturn: Codable, Sendable {
  public var counts: RaviJSON
  public var cwd: String
  public var includeUser: Bool
  public var provider: String
  public var sources: [[String: RaviJSON]]

  public init(counts: RaviJSON, cwd: String, includeUser: Bool, provider: String, sources: [[String: RaviJSON]]) {
    self.counts = counts
    self.cwd = cwd
    self.includeUser = includeUser
    self.provider = provider
    self.sources = sources
  }

  enum CodingKeys: String, CodingKey {
    case counts = "counts"
    case cwd = "cwd"
    case includeUser = "includeUser"
    case provider = "provider"
    case sources = "sources"
  }
}

public struct RuntimeCredentialsAddOptions: Codable, Sendable {
  public var agents: String?
  public var authMethod: String?
  public var authProfile: String?
  public var label: String?
  public var models: String?
  public var notes: String?
  public var priority: String?
  public var provider: String?
  public var readOnly: Bool?
  public var remoteForward: Bool?
  public var secretEnv: String?
  public var targetEnv: String?
  public var taskProfiles: String?
  public var upstream: String?

  public init(agents: String? = nil, authMethod: String? = nil, authProfile: String? = nil, label: String? = nil, models: String? = nil, notes: String? = nil, priority: String? = nil, provider: String? = nil, readOnly: Bool? = nil, remoteForward: Bool? = nil, secretEnv: String? = nil, targetEnv: String? = nil, taskProfiles: String? = nil, upstream: String? = nil) {
    self.agents = agents
    self.authMethod = authMethod
    self.authProfile = authProfile
    self.label = label
    self.models = models
    self.notes = notes
    self.priority = priority
    self.provider = provider
    self.readOnly = readOnly
    self.remoteForward = remoteForward
    self.secretEnv = secretEnv
    self.targetEnv = targetEnv
    self.taskProfiles = taskProfiles
    self.upstream = upstream
  }

  enum CodingKeys: String, CodingKey {
    case agents = "agents"
    case authMethod = "authMethod"
    case authProfile = "authProfile"
    case label = "label"
    case models = "models"
    case notes = "notes"
    case priority = "priority"
    case provider = "provider"
    case readOnly = "readOnly"
    case remoteForward = "remoteForward"
    case secretEnv = "secretEnv"
    case targetEnv = "targetEnv"
    case taskProfiles = "taskProfiles"
    case upstream = "upstream"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agents {
      body["agents"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.authMethod {
      body["authMethod"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.authProfile {
      body["authProfile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.models {
      body["models"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.notes {
      body["notes"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.readOnly {
      body["readOnly"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.remoteForward {
      body["remoteForward"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.secretEnv {
      body["secretEnv"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.targetEnv {
      body["targetEnv"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.taskProfiles {
      body["taskProfiles"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.upstream {
      body["upstream"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimeCredentialsAddReturn: Codable, Sendable {
  public var credential: [String: RaviJSON]

  public init(credential: [String: RaviJSON]) {
    self.credential = credential
  }

  enum CodingKeys: String, CodingKey {
    case credential = "credential"
  }
}

public struct RuntimeCredentialsClassifyOptions: Codable, Sendable {
  public var credential: String?
  public var headers: String?
  public var message: String?
  public var provider: String?
  public var providerCode: String?
  public var providerType: String?
  public var record: Bool?
  public var status: String?
  public var upstream: String?

  public init(credential: String? = nil, headers: String? = nil, message: String? = nil, provider: String? = nil, providerCode: String? = nil, providerType: String? = nil, record: Bool? = nil, status: String? = nil, upstream: String? = nil) {
    self.credential = credential
    self.headers = headers
    self.message = message
    self.provider = provider
    self.providerCode = providerCode
    self.providerType = providerType
    self.record = record
    self.status = status
    self.upstream = upstream
  }

  enum CodingKeys: String, CodingKey {
    case credential = "credential"
    case headers = "headers"
    case message = "message"
    case provider = "provider"
    case providerCode = "providerCode"
    case providerType = "providerType"
    case record = "record"
    case status = "status"
    case upstream = "upstream"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.credential {
      body["credential"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.headers {
      body["headers"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.providerCode {
      body["providerCode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.providerType {
      body["providerType"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.record {
      body["record"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.upstream {
      body["upstream"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimeCredentialsClassifyReturn: Codable, Sendable {
  public var pressure: [String: RaviJSON]
  public var signal: [String: RaviJSON]

  public init(pressure: [String: RaviJSON], signal: [String: RaviJSON]) {
    self.pressure = pressure
    self.signal = signal
  }

  enum CodingKeys: String, CodingKey {
    case pressure = "pressure"
    case signal = "signal"
  }
}

public struct RuntimeCredentialsDisableReturn: Codable, Sendable {
  public var credential: [String: RaviJSON]

  public init(credential: [String: RaviJSON]) {
    self.credential = credential
  }

  enum CodingKeys: String, CodingKey {
    case credential = "credential"
  }
}

public struct RuntimeCredentialsEnableReturn: Codable, Sendable {
  public var credential: [String: RaviJSON]

  public init(credential: [String: RaviJSON]) {
    self.credential = credential
  }

  enum CodingKeys: String, CodingKey {
    case credential = "credential"
  }
}

public struct RuntimeCredentialsImportOptions: Codable, Sendable {
  public var fromClaudeCode: Bool?
  public var fromCodexHome: String?
  public var label: String?
  public var managedRefresh: Bool?
  public var provider: String?

  public init(fromClaudeCode: Bool? = nil, fromCodexHome: String? = nil, label: String? = nil, managedRefresh: Bool? = nil, provider: String? = nil) {
    self.fromClaudeCode = fromClaudeCode
    self.fromCodexHome = fromCodexHome
    self.label = label
    self.managedRefresh = managedRefresh
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case fromClaudeCode = "fromClaudeCode"
    case fromCodexHome = "fromCodexHome"
    case label = "label"
    case managedRefresh = "managedRefresh"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fromClaudeCode {
      body["fromClaudeCode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fromCodexHome {
      body["fromCodexHome"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.managedRefresh {
      body["managedRefresh"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimeCredentialsImportReturn: Codable, Sendable {
  public var credential: [String: RaviJSON]

  public init(credential: [String: RaviJSON]) {
    self.credential = credential
  }

  enum CodingKeys: String, CodingKey {
    case credential = "credential"
  }
}

public struct RuntimeCredentialsListOptions: Codable, Sendable {
  public var all: Bool?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var provider: String?
  public var status: String?
  public var upstream: String?

  public init(all: Bool? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, provider: String? = nil, status: String? = nil, upstream: String? = nil) {
    self.all = all
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.provider = provider
    self.status = status
    self.upstream = upstream
  }

  enum CodingKeys: String, CodingKey {
    case all = "all"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case provider = "provider"
    case status = "status"
    case upstream = "upstream"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.all {
      body["all"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.upstream {
      body["upstream"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimeCredentialsListReturn: Codable, Sendable {
  public var credentials: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var providerHealth: [[String: RaviJSON]]
  public var total: Double

  public init(credentials: [[String: RaviJSON]], pagination: RaviJSON, providerHealth: [[String: RaviJSON]], total: Double) {
    self.credentials = credentials
    self.pagination = pagination
    self.providerHealth = providerHealth
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case credentials = "credentials"
    case pagination = "pagination"
    case providerHealth = "providerHealth"
    case total = "total"
  }
}

public struct RuntimeCredentialsRefreshOptions: Codable, Sendable {
  public var agent: String?
  public var force: Bool?
  public var model: String?
  public var provider: String?
  public var taskProfile: String?
  public var upstream: String?

  public init(agent: String? = nil, force: Bool? = nil, model: String? = nil, provider: String? = nil, taskProfile: String? = nil, upstream: String? = nil) {
    self.agent = agent
    self.force = force
    self.model = model
    self.provider = provider
    self.taskProfile = taskProfile
    self.upstream = upstream
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case force = "force"
    case model = "model"
    case provider = "provider"
    case taskProfile = "taskProfile"
    case upstream = "upstream"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.force {
      body["force"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.taskProfile {
      body["taskProfile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.upstream {
      body["upstream"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimeCredentialsRefreshReturn: Codable, Sendable {
  public var refreshed: [[String: RaviJSON]]

  public init(refreshed: [[String: RaviJSON]]) {
    self.refreshed = refreshed
  }

  enum CodingKeys: String, CodingKey {
    case refreshed = "refreshed"
  }
}

public struct RuntimeCredentialsResetHealthReturn: Codable, Sendable {
  public var credential: [String: RaviJSON]
  public var health: RaviJSON

  public init(credential: [String: RaviJSON], health: RaviJSON) {
    self.credential = credential
    self.health = health
  }

  enum CodingKeys: String, CodingKey {
    case credential = "credential"
    case health = "health"
  }
}

public struct RuntimeCredentialsSelectOptions: Codable, Sendable {
  public var agent: String?
  public var model: String?
  public var provider: String?
  public var taskProfile: String?
  public var upstream: String?

  public init(agent: String? = nil, model: String? = nil, provider: String? = nil, taskProfile: String? = nil, upstream: String? = nil) {
    self.agent = agent
    self.model = model
    self.provider = provider
    self.taskProfile = taskProfile
    self.upstream = upstream
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case model = "model"
    case provider = "provider"
    case taskProfile = "taskProfile"
    case upstream = "upstream"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.taskProfile {
      body["taskProfile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.upstream {
      body["upstream"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimeCredentialsSelectReturn: Codable, Sendable {
  public var candidates: [[String: RaviJSON]]
  public var rejected: [[String: RaviJSON]]
  public var selected: RaviJSON

  public init(candidates: [[String: RaviJSON]], rejected: [[String: RaviJSON]], selected: RaviJSON) {
    self.candidates = candidates
    self.rejected = rejected
    self.selected = selected
  }

  enum CodingKeys: String, CodingKey {
    case candidates = "candidates"
    case rejected = "rejected"
    case selected = "selected"
  }
}

public struct RuntimeCredentialsStatusReturn: Codable, Sendable {
  public var credential: [String: RaviJSON]
  public var health: RaviJSON

  public init(credential: [String: RaviJSON], health: RaviJSON) {
    self.credential = credential
    self.health = health
  }

  enum CodingKeys: String, CodingKey {
    case credential = "credential"
    case health = "health"
  }
}

public struct RuntimePresetsCreateOptions: Codable, Sendable {
  public var description: String?
  public var disabled: Bool?
  public var model: String?
  public var provider: String?

  public init(description: String? = nil, disabled: Bool? = nil, model: String? = nil, provider: String? = nil) {
    self.description = description
    self.disabled = disabled
    self.model = model
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case description = "description"
    case disabled = "disabled"
    case model = "model"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.disabled {
      body["disabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimePresetsCreateReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool
  public var dryRun: Bool
  public var preset: RaviJSON

  public init(action: String, changed: Bool, dryRun: Bool, preset: RaviJSON) {
    self.action = action
    self.changed = changed
    self.dryRun = dryRun
    self.preset = preset
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
    case dryRun = "dryRun"
    case preset = "preset"
  }
}

public struct RuntimePresetsDeleteOptions: Codable, Sendable {
  public var dryRun: Bool?

  public init(dryRun: Bool? = nil) {
    self.dryRun = dryRun
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimePresetsDeleteReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool
  public var dryRun: Bool
  public var preset: RaviJSON

  public init(action: String, changed: Bool, dryRun: Bool, preset: RaviJSON) {
    self.action = action
    self.changed = changed
    self.dryRun = dryRun
    self.preset = preset
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
    case dryRun = "dryRun"
    case preset = "preset"
  }
}

public struct RuntimePresetsDisableOptions: Codable, Sendable {
  public var dryRun: Bool?

  public init(dryRun: Bool? = nil) {
    self.dryRun = dryRun
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimePresetsDisableReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool
  public var dryRun: Bool
  public var preset: RaviJSON

  public init(action: String, changed: Bool, dryRun: Bool, preset: RaviJSON) {
    self.action = action
    self.changed = changed
    self.dryRun = dryRun
    self.preset = preset
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
    case dryRun = "dryRun"
    case preset = "preset"
  }
}

public struct RuntimePresetsEnableOptions: Codable, Sendable {
  public var dryRun: Bool?

  public init(dryRun: Bool? = nil) {
    self.dryRun = dryRun
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimePresetsEnableReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool
  public var dryRun: Bool
  public var preset: RaviJSON

  public init(action: String, changed: Bool, dryRun: Bool, preset: RaviJSON) {
    self.action = action
    self.changed = changed
    self.dryRun = dryRun
    self.preset = preset
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
    case dryRun = "dryRun"
    case preset = "preset"
  }
}

public struct RuntimePresetsImpactOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?

  public init(limit: String? = nil, offset: String? = nil) {
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimePresetsImpactReturn: Codable, Sendable {
  public var agents: [RaviJSON]
  public var correctionCommand: RaviJSON
  public var enabled: Bool
  public var limit: Double
  public var model: String
  public var offset: Double
  public var pagination: RaviJSON
  public var presetId: String
  public var provider: String
  public var referenced: Bool
  public var referencingAgentsTotal: Double
  public var shadowingSessionsTotal: Double
  public var version: Double

  public init(agents: [RaviJSON], correctionCommand: RaviJSON, enabled: Bool, limit: Double, model: String, offset: Double, pagination: RaviJSON, presetId: String, provider: String, referenced: Bool, referencingAgentsTotal: Double, shadowingSessionsTotal: Double, version: Double) {
    self.agents = agents
    self.correctionCommand = correctionCommand
    self.enabled = enabled
    self.limit = limit
    self.model = model
    self.offset = offset
    self.pagination = pagination
    self.presetId = presetId
    self.provider = provider
    self.referenced = referenced
    self.referencingAgentsTotal = referencingAgentsTotal
    self.shadowingSessionsTotal = shadowingSessionsTotal
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case agents = "agents"
    case correctionCommand = "correctionCommand"
    case enabled = "enabled"
    case limit = "limit"
    case model = "model"
    case offset = "offset"
    case pagination = "pagination"
    case presetId = "presetId"
    case provider = "provider"
    case referenced = "referenced"
    case referencingAgentsTotal = "referencingAgentsTotal"
    case shadowingSessionsTotal = "shadowingSessionsTotal"
    case version = "version"
  }
}

public struct RuntimePresetsListOptions: Codable, Sendable {
  public var disabled: Bool?
  public var enabled: Bool?
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var provider: String?

  public init(disabled: Bool? = nil, enabled: Bool? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil, provider: String? = nil) {
    self.disabled = disabled
    self.enabled = enabled
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case disabled = "disabled"
    case enabled = "enabled"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.disabled {
      body["disabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.enabled {
      body["enabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimePresetsListReturn: Codable, Sendable {
  public var pagination: RaviJSON
  public var presets: [RaviJSON]
  public var total: Double

  public init(pagination: RaviJSON, presets: [RaviJSON], total: Double) {
    self.pagination = pagination
    self.presets = presets
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case pagination = "pagination"
    case presets = "presets"
    case total = "total"
  }
}

public struct RuntimePresetsSetOptions: Codable, Sendable {
  public var dryRun: Bool?

  public init(dryRun: Bool? = nil) {
    self.dryRun = dryRun
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct RuntimePresetsSetReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool
  public var dryRun: Bool
  public var preset: RaviJSON

  public init(action: String, changed: Bool, dryRun: Bool, preset: RaviJSON) {
    self.action = action
    self.changed = changed
    self.dryRun = dryRun
    self.preset = preset
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
    case dryRun = "dryRun"
    case preset = "preset"
  }
}

public struct RuntimePresetsShowReturn: Codable, Sendable {
  public var preset: RaviJSON
  public var referencingAgentsTotal: Double

  public init(preset: RaviJSON, referencingAgentsTotal: Double) {
    self.preset = preset
    self.referencingAgentsTotal = referencingAgentsTotal
  }

  enum CodingKeys: String, CodingKey {
    case preset = "preset"
    case referencingAgentsTotal = "referencingAgentsTotal"
  }
}

public struct SdkClientCheckOptions: Codable, Sendable {
  public var out: String?
  public var version: String?

  public init(out: String? = nil, version: String? = nil) {
    self.out = out
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case out = "out"
    case version = "version"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.out {
      body["out"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.version {
      body["version"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SdkClientCheckReturn: Codable, Sendable {
  public var dir: String
  public var drift: [RaviJSON]
  public var files: [String]

  public init(dir: String, drift: [RaviJSON], files: [String]) {
    self.dir = dir
    self.drift = drift
    self.files = files
  }

  enum CodingKeys: String, CodingKey {
    case dir = "dir"
    case drift = "drift"
    case files = "files"
  }
}

public struct SdkClientGenerateOptions: Codable, Sendable {
  public var out: String?
  public var version: String?

  public init(out: String? = nil, version: String? = nil) {
    self.out = out
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case out = "out"
    case version = "version"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.out {
      body["out"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.version {
      body["version"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SdkClientGenerateReturn: Codable, Sendable {
  public var dir: String
  public var files: [RaviJSON]
  public var status: String

  public init(dir: String, files: [RaviJSON], status: String) {
    self.dir = dir
    self.files = files
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case dir = "dir"
    case files = "files"
    case status = "status"
  }
}

public struct SdkOpenapiCheckOptions: Codable, Sendable {
  public var against: String?

  public init(against: String? = nil) {
    self.against = against
  }

  enum CodingKeys: String, CodingKey {
    case against = "against"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.against {
      body["against"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SdkOpenapiCheckReturn: Codable, Sendable {
  public var drift: Bool
  public var liveBytes: Double
  public var path: String
  public var storedBytes: Double

  public init(drift: Bool, liveBytes: Double, path: String, storedBytes: Double) {
    self.drift = drift
    self.liveBytes = liveBytes
    self.path = path
    self.storedBytes = storedBytes
  }

  enum CodingKeys: String, CodingKey {
    case drift = "drift"
    case liveBytes = "liveBytes"
    case path = "path"
    case storedBytes = "storedBytes"
  }
}

public struct SdkOpenapiEmitOptions: Codable, Sendable {
  public var out: String?
  public var stdout: Bool?

  public init(out: String? = nil, stdout: Bool? = nil) {
    self.out = out
    self.stdout = stdout
  }

  enum CodingKeys: String, CodingKey {
    case out = "out"
    case stdout = "stdout"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.out {
      body["out"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.stdout {
      body["stdout"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SdkOpenapiEmitReturn = RaviJSON

public struct SdkSwiftCheckOptions: Codable, Sendable {
  public var out: String?
  public var version: String?

  public init(out: String? = nil, version: String? = nil) {
    self.out = out
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case out = "out"
    case version = "version"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.out {
      body["out"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.version {
      body["version"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SdkSwiftCheckReturn: Codable, Sendable {
  public var dir: String
  public var drift: [RaviJSON]
  public var files: [String]

  public init(dir: String, drift: [RaviJSON], files: [String]) {
    self.dir = dir
    self.drift = drift
    self.files = files
  }

  enum CodingKeys: String, CodingKey {
    case dir = "dir"
    case drift = "drift"
    case files = "files"
  }
}

public struct SdkSwiftGenerateOptions: Codable, Sendable {
  public var out: String?
  public var version: String?

  public init(out: String? = nil, version: String? = nil) {
    self.out = out
    self.version = version
  }

  enum CodingKeys: String, CodingKey {
    case out = "out"
    case version = "version"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.out {
      body["out"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.version {
      body["version"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SdkSwiftGenerateReturn: Codable, Sendable {
  public var dir: String
  public var files: [RaviJSON]
  public var status: String

  public init(dir: String, files: [RaviJSON], status: String) {
    self.dir = dir
    self.files = files
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case dir = "dir"
    case files = "files"
    case status = "status"
  }
}

public struct SelfChatOptions: Codable, Sendable {
  public var depth: String?

  public init(depth: String? = nil) {
    self.depth = depth
  }

  enum CodingKeys: String, CodingKey {
    case depth = "depth"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.depth {
      body["depth"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SelfChatReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var reason: String?
  public var status: String

  public init(data: RaviJSON? = nil, reason: String? = nil, status: String) {
    self.data = data
    self.reason = reason
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case reason = "reason"
    case status = "status"
  }
}

public struct SelfContextOptions: Codable, Sendable {
  public var depth: String?
  public var fields: String?
  public var limit: String?

  public init(depth: String? = nil, fields: String? = nil, limit: String? = nil) {
    self.depth = depth
    self.fields = fields
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case depth = "depth"
    case fields = "fields"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.depth {
      body["depth"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SelfContextReturn: Codable, Sendable {
  public var actor_: RaviJSON
  public var chat: RaviJSON
  public var depth: String
  public var explain: [[String: RaviJSON]]
  public var generatedAt: Double
  public var identity: [String: RaviJSON]
  public var knowledge: RaviJSON
  public var limit: Double
  public var nextReads: [String]
  public var permissions: RaviJSON
  public var recent: RaviJSON
  public var route: RaviJSON
  public var session: RaviJSON

  public init(actor_: RaviJSON, chat: RaviJSON, depth: String, explain: [[String: RaviJSON]], generatedAt: Double, identity: [String: RaviJSON], knowledge: RaviJSON, limit: Double, nextReads: [String], permissions: RaviJSON, recent: RaviJSON, route: RaviJSON, session: RaviJSON) {
    self.actor_ = actor_
    self.chat = chat
    self.depth = depth
    self.explain = explain
    self.generatedAt = generatedAt
    self.identity = identity
    self.knowledge = knowledge
    self.limit = limit
    self.nextReads = nextReads
    self.permissions = permissions
    self.recent = recent
    self.route = route
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case actor_ = "actor"
    case chat = "chat"
    case depth = "depth"
    case explain = "explain"
    case generatedAt = "generatedAt"
    case identity = "identity"
    case knowledge = "knowledge"
    case limit = "limit"
    case nextReads = "nextReads"
    case permissions = "permissions"
    case recent = "recent"
    case route = "route"
    case session = "session"
  }
}

public struct SelfExplainReturn: Codable, Sendable {
  public var explain: [[String: RaviJSON]]
  public var generatedAt: Double
  public var nextReads: [String]

  public init(explain: [[String: RaviJSON]], generatedAt: Double, nextReads: [String]) {
    self.explain = explain
    self.generatedAt = generatedAt
    self.nextReads = nextReads
  }

  enum CodingKeys: String, CodingKey {
    case explain = "explain"
    case generatedAt = "generatedAt"
    case nextReads = "nextReads"
  }
}

public struct SelfKnowledgeReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var reason: String?
  public var status: String

  public init(data: RaviJSON? = nil, reason: String? = nil, status: String) {
    self.data = data
    self.reason = reason
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case reason = "reason"
    case status = "status"
  }
}

public struct SelfPermissionsReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var reason: String?
  public var status: String

  public init(data: RaviJSON? = nil, reason: String? = nil, status: String) {
    self.data = data
    self.reason = reason
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case reason = "reason"
    case status = "status"
  }
}

public struct SelfRecentOptions: Codable, Sendable {
  public var limit: String?

  public init(limit: String? = nil) {
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SelfRecentReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var reason: String?
  public var status: String

  public init(data: RaviJSON? = nil, reason: String? = nil, status: String) {
    self.data = data
    self.reason = reason
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case reason = "reason"
    case status = "status"
  }
}

public struct SelfRouteReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var reason: String?
  public var status: String

  public init(data: RaviJSON? = nil, reason: String? = nil, status: String) {
    self.data = data
    self.reason = reason
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case reason = "reason"
    case status = "status"
  }
}

public struct SelfWhoamiReturn: Codable, Sendable {
  public var actor_: RaviJSON
  public var chat: RaviJSON
  public var generatedAt: Double
  public var identity: [String: RaviJSON]
  public var nextReads: [String]
  public var route: RaviJSON
  public var session: RaviJSON

  public init(actor_: RaviJSON, chat: RaviJSON, generatedAt: Double, identity: [String: RaviJSON], nextReads: [String], route: RaviJSON, session: RaviJSON) {
    self.actor_ = actor_
    self.chat = chat
    self.generatedAt = generatedAt
    self.identity = identity
    self.nextReads = nextReads
    self.route = route
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case actor_ = "actor"
    case chat = "chat"
    case generatedAt = "generatedAt"
    case identity = "identity"
    case nextReads = "nextReads"
    case route = "route"
    case session = "session"
  }
}

public struct SessionsActionsOptions: Codable, Sendable {
  public var limit: String?

  public init(limit: String? = nil) {
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsActionsReturn = [String: RaviJSON]

public struct SessionsAnswerOptions: Codable, Sendable {
  public var barrier: String?
  public var channel: String?
  public var immediate: Bool?
  public var steer: Bool?
  public var to: String?

  public init(barrier: String? = nil, channel: String? = nil, immediate: Bool? = nil, steer: Bool? = nil, to: String? = nil) {
    self.barrier = barrier
    self.channel = channel
    self.immediate = immediate
    self.steer = steer
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case barrier = "barrier"
    case channel = "channel"
    case immediate = "immediate"
    case steer = "steer"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.barrier {
      body["barrier"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.immediate {
      body["immediate"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.steer {
      body["steer"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsAnswerReturn = [String: RaviJSON]

public struct SessionsAskOptions: Codable, Sendable {
  public var barrier: String?
  public var channel: String?
  public var immediate: Bool?
  public var steer: Bool?
  public var to: String?

  public init(barrier: String? = nil, channel: String? = nil, immediate: Bool? = nil, steer: Bool? = nil, to: String? = nil) {
    self.barrier = barrier
    self.channel = channel
    self.immediate = immediate
    self.steer = steer
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case barrier = "barrier"
    case channel = "channel"
    case immediate = "immediate"
    case steer = "steer"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.barrier {
      body["barrier"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.immediate {
      body["immediate"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.steer {
      body["steer"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsAskReturn = [String: RaviJSON]

public struct SessionsAttachOptions: Codable, Sendable {
  public var chat: String?
  public var reason: String?

  public init(chat: String? = nil, reason: String? = nil) {
    self.chat = chat
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case chat = "chat"
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.chat {
      body["chat"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsAttachReturn = [String: RaviJSON]

public struct SessionsCloseThreadOptions: Codable, Sendable {
  public var return_: String?
  public var session: String?

  public init(return_: String? = nil, session: String? = nil) {
    self.return_ = return_
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case return_ = "return"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.return_ {
      body["return"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsCloseThreadReturn: Codable, Sendable {
  public var actionId: String
  public var changed: Bool
  public var childSession: RaviJSON
  public var closeSequence: Int
  public var closed: Bool
  public var parentReturn: RaviJSON
  public var parentSession: RaviJSON
  public var requestId: String
  public var slack: RaviJSON
  public var status: String

  public init(actionId: String, changed: Bool, childSession: RaviJSON, closeSequence: Int, closed: Bool, parentReturn: RaviJSON, parentSession: RaviJSON, requestId: String, slack: RaviJSON, status: String) {
    self.actionId = actionId
    self.changed = changed
    self.childSession = childSession
    self.closeSequence = closeSequence
    self.closed = closed
    self.parentReturn = parentReturn
    self.parentSession = parentSession
    self.requestId = requestId
    self.slack = slack
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case actionId = "actionId"
    case changed = "changed"
    case childSession = "childSession"
    case closeSequence = "closeSequence"
    case closed = "closed"
    case parentReturn = "parentReturn"
    case parentSession = "parentSession"
    case requestId = "requestId"
    case slack = "slack"
    case status = "status"
  }
}

public struct SessionsCreateThreadOptions: Codable, Sendable {
  public var model: String?
  public var session: String?

  public init(model: String? = nil, session: String? = nil) {
    self.model = model
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case model = "model"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsCreateThreadReturn: Codable, Sendable {
  public var actionId: String
  public var child: RaviJSON
  public var executionMode: String
  public var idempotencyKey: String
  public var initiatorSession: RaviJSON
  public var nextAttemptAt: Double?
  public var parentSession: RaviJSON
  public var publishPending: Bool
  public var publishedNow: Bool
  public var queued: Bool
  public var requestId: String
  public var slack: RaviJSON
  public var status: String

  public init(actionId: String, child: RaviJSON, executionMode: String, idempotencyKey: String, initiatorSession: RaviJSON, nextAttemptAt: Double? = nil, parentSession: RaviJSON, publishPending: Bool, publishedNow: Bool, queued: Bool, requestId: String, slack: RaviJSON, status: String) {
    self.actionId = actionId
    self.child = child
    self.executionMode = executionMode
    self.idempotencyKey = idempotencyKey
    self.initiatorSession = initiatorSession
    self.nextAttemptAt = nextAttemptAt
    self.parentSession = parentSession
    self.publishPending = publishPending
    self.publishedNow = publishedNow
    self.queued = queued
    self.requestId = requestId
    self.slack = slack
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case actionId = "actionId"
    case child = "child"
    case executionMode = "executionMode"
    case idempotencyKey = "idempotencyKey"
    case initiatorSession = "initiatorSession"
    case nextAttemptAt = "nextAttemptAt"
    case parentSession = "parentSession"
    case publishPending = "publishPending"
    case publishedNow = "publishedNow"
    case queued = "queued"
    case requestId = "requestId"
    case slack = "slack"
    case status = "status"
  }
}

public struct SessionsDeleteOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsDeleteReturn = [String: RaviJSON]

public struct SessionsDeleteMessageOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsDeleteMessageReturn = [String: RaviJSON]

public struct SessionsDetachOptions: Codable, Sendable {
  public var chat: String?

  public init(chat: String? = nil) {
    self.chat = chat
  }

  enum CodingKeys: String, CodingKey {
    case chat = "chat"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.chat {
      body["chat"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsDetachReturn = [String: RaviJSON]

public struct SessionsEditMessageOptions: Codable, Sendable {
  public var execute: Bool?
  public var text: String?

  public init(execute: Bool? = nil, text: String? = nil) {
    self.execute = execute
    self.text = text
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case text = "text"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.text {
      body["text"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsEditMessageReturn = [String: RaviJSON]

public struct SessionsExecuteOptions: Codable, Sendable {
  public var barrier: String?
  public var channel: String?
  public var immediate: Bool?
  public var steer: Bool?
  public var to: String?

  public init(barrier: String? = nil, channel: String? = nil, immediate: Bool? = nil, steer: Bool? = nil, to: String? = nil) {
    self.barrier = barrier
    self.channel = channel
    self.immediate = immediate
    self.steer = steer
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case barrier = "barrier"
    case channel = "channel"
    case immediate = "immediate"
    case steer = "steer"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.barrier {
      body["barrier"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.immediate {
      body["immediate"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.steer {
      body["steer"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsExecuteReturn = [String: RaviJSON]

public typealias SessionsExtendReturn = [String: RaviJSON]

public struct SessionsFollowupsAddOptions: Codable, Sendable {
  public var at: String?
  public var barrier: String?
  public var cron: String?
  public var description: String?
  public var disabled: Bool?
  public var every: String?
  public var message: String?
  public var owner: String?
  public var step: [String]?
  public var targetChat: String?
  public var targetList: String?
  public var targetSession: String?
  public var timezone: String?

  public init(at: String? = nil, barrier: String? = nil, cron: String? = nil, description: String? = nil, disabled: Bool? = nil, every: String? = nil, message: String? = nil, owner: String? = nil, step: [String]? = nil, targetChat: String? = nil, targetList: String? = nil, targetSession: String? = nil, timezone: String? = nil) {
    self.at = at
    self.barrier = barrier
    self.cron = cron
    self.description = description
    self.disabled = disabled
    self.every = every
    self.message = message
    self.owner = owner
    self.step = step
    self.targetChat = targetChat
    self.targetList = targetList
    self.targetSession = targetSession
    self.timezone = timezone
  }

  enum CodingKeys: String, CodingKey {
    case at = "at"
    case barrier = "barrier"
    case cron = "cron"
    case description = "description"
    case disabled = "disabled"
    case every = "every"
    case message = "message"
    case owner = "owner"
    case step = "step"
    case targetChat = "targetChat"
    case targetList = "targetList"
    case targetSession = "targetSession"
    case timezone = "timezone"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.at {
      body["at"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.barrier {
      body["barrier"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cron {
      body["cron"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.disabled {
      body["disabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.every {
      body["every"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.step {
      body["step"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.targetChat {
      body["targetChat"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.targetList {
      body["targetList"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.targetSession {
      body["targetSession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.timezone {
      body["timezone"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsFollowupsAddReturn = [String: RaviJSON]

public struct SessionsFollowupsInspectOptions: Codable, Sendable {
  public var runs: String?

  public init(runs: String? = nil) {
    self.runs = runs
  }

  enum CodingKeys: String, CodingKey {
    case runs = "runs"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.runs {
      body["runs"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsFollowupsInspectReturn = [String: RaviJSON]

public struct SessionsFollowupsListOptions: Codable, Sendable {
  public var includeDisabled: Bool?
  public var limit: String?
  public var offset: String?
  public var targetType: String?

  public init(includeDisabled: Bool? = nil, limit: String? = nil, offset: String? = nil, targetType: String? = nil) {
    self.includeDisabled = includeDisabled
    self.limit = limit
    self.offset = offset
    self.targetType = targetType
  }

  enum CodingKeys: String, CodingKey {
    case includeDisabled = "includeDisabled"
    case limit = "limit"
    case offset = "offset"
    case targetType = "targetType"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.includeDisabled {
      body["includeDisabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.targetType {
      body["targetType"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsFollowupsListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public typealias SessionsFollowupsPauseReturn = [String: RaviJSON]

public typealias SessionsFollowupsResumeReturn = [String: RaviJSON]

public struct SessionsFollowupsRetryOptions: Codable, Sendable {
  public var cadence: String?

  public init(cadence: String? = nil) {
    self.cadence = cadence
  }

  enum CodingKeys: String, CodingKey {
    case cadence = "cadence"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cadence {
      body["cadence"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsFollowupsRetryReturn = [String: RaviJSON]

public typealias SessionsFollowupsRunReturn = [String: RaviJSON]

public struct SessionsFollowupsRunsOptions: Codable, Sendable {
  public var cadence: String?
  public var limit: String?
  public var offset: String?
  public var status: String?

  public init(cadence: String? = nil, limit: String? = nil, offset: String? = nil, status: String? = nil) {
    self.cadence = cadence
    self.limit = limit
    self.offset = offset
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case cadence = "cadence"
    case limit = "limit"
    case offset = "offset"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cadence {
      body["cadence"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsFollowupsRunsReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct SessionsFollowupsSnoozeOptions: Codable, Sendable {
  public var until: String?

  public init(until: String? = nil) {
    self.until = until
  }

  enum CodingKeys: String, CodingKey {
    case until = "until"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.until {
      body["until"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsFollowupsSnoozeReturn = [String: RaviJSON]

public struct SessionsFollowupsUpdateOptions: Codable, Sendable {
  public var barrier: String?
  public var description: String?
  public var message: String?
  public var name: String?
  public var recalculateNext: Bool?
  public var step: [String]?

  public init(barrier: String? = nil, description: String? = nil, message: String? = nil, name: String? = nil, recalculateNext: Bool? = nil, step: [String]? = nil) {
    self.barrier = barrier
    self.description = description
    self.message = message
    self.name = name
    self.recalculateNext = recalculateNext
    self.step = step
  }

  enum CodingKeys: String, CodingKey {
    case barrier = "barrier"
    case description = "description"
    case message = "message"
    case name = "name"
    case recalculateNext = "recalculateNext"
    case step = "step"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.barrier {
      body["barrier"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.recalculateNext {
      body["recalculateNext"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.step {
      body["step"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsFollowupsUpdateReturn: Codable, Sendable {
  public var followup: RaviJSON

  public init(followup: RaviJSON) {
    self.followup = followup
  }

  enum CodingKeys: String, CodingKey {
    case followup = "followup"
  }
}

public struct SessionsGoalOptions: Codable, Sendable {
  public var budget: String?
  public var project: String?
  public var reason: String?
  public var seconds: String?
  public var task: String?
  public var tokens: String?

  public init(budget: String? = nil, project: String? = nil, reason: String? = nil, seconds: String? = nil, task: String? = nil, tokens: String? = nil) {
    self.budget = budget
    self.project = project
    self.reason = reason
    self.seconds = seconds
    self.task = task
    self.tokens = tokens
  }

  enum CodingKeys: String, CodingKey {
    case budget = "budget"
    case project = "project"
    case reason = "reason"
    case seconds = "seconds"
    case task = "task"
    case tokens = "tokens"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.budget {
      body["budget"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.seconds {
      body["seconds"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tokens {
      body["tokens"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsGoalReturn: Codable, Sendable {
  public var action: String
  public var changed: Bool
  public var goal: RaviJSON
  public var session: RaviJSON

  public init(action: String, changed: Bool, goal: RaviJSON, session: RaviJSON) {
    self.action = action
    self.changed = changed
    self.goal = goal
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case changed = "changed"
    case goal = "goal"
    case session = "session"
  }
}

public typealias SessionsInfoReturn = [String: RaviJSON]

public struct SessionsInformOptions: Codable, Sendable {
  public var barrier: String?
  public var channel: String?
  public var immediate: Bool?
  public var steer: Bool?
  public var to: String?

  public init(barrier: String? = nil, channel: String? = nil, immediate: Bool? = nil, steer: Bool? = nil, to: String? = nil) {
    self.barrier = barrier
    self.channel = channel
    self.immediate = immediate
    self.steer = steer
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case barrier = "barrier"
    case channel = "channel"
    case immediate = "immediate"
    case steer = "steer"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.barrier {
      body["barrier"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.immediate {
      body["immediate"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.steer {
      body["steer"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsInformReturn = [String: RaviJSON]

public typealias SessionsKeepReturn = [String: RaviJSON]

public struct SessionsListOptions: Codable, Sendable {
  public var agent: String?
  public var ephemeral: Bool?
  public var fields: String?
  public var limit: String?
  public var live: Bool?
  public var offset: String?
  public var tag: String?

  public init(agent: String? = nil, ephemeral: Bool? = nil, fields: String? = nil, limit: String? = nil, live: Bool? = nil, offset: String? = nil, tag: String? = nil) {
    self.agent = agent
    self.ephemeral = ephemeral
    self.fields = fields
    self.limit = limit
    self.live = live
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case ephemeral = "ephemeral"
    case fields = "fields"
    case limit = "limit"
    case live = "live"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ephemeral {
      body["ephemeral"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.live {
      body["live"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct SessionsPruneOptions: Codable, Sendable {
  public var agent: String?
  public var ephemeral: Bool?
  public var execute: Bool?
  public var inactiveFor: String?
  public var namePrefix: String?

  public init(agent: String? = nil, ephemeral: Bool? = nil, execute: Bool? = nil, inactiveFor: String? = nil, namePrefix: String? = nil) {
    self.agent = agent
    self.ephemeral = ephemeral
    self.execute = execute
    self.inactiveFor = inactiveFor
    self.namePrefix = namePrefix
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case ephemeral = "ephemeral"
    case execute = "execute"
    case inactiveFor = "inactiveFor"
    case namePrefix = "namePrefix"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ephemeral {
      body["ephemeral"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.inactiveFor {
      body["inactiveFor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.namePrefix {
      body["namePrefix"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsPruneReturn = [String: RaviJSON]

public struct SessionsReadOptions: Codable, Sendable {
  public var count: String?
  public var messageId: String?
  public var workspace: Bool?

  public init(count: String? = nil, messageId: String? = nil, workspace: Bool? = nil) {
    self.count = count
    self.messageId = messageId
    self.workspace = workspace
  }

  enum CodingKeys: String, CodingKey {
    case count = "count"
    case messageId = "messageId"
    case workspace = "workspace"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.count {
      body["count"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.messageId {
      body["messageId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workspace {
      body["workspace"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsReadReturn = RaviJSON

public typealias SessionsRenameReturn = [String: RaviJSON]

public struct SessionsResetOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsResetReturn = [String: RaviJSON]

public struct SessionsRuntimeFollowUpOptions: Codable, Sendable {
  public var execute: Bool?
  public var expectedTurn: String?
  public var thread: String?
  public var turn: String?

  public init(execute: Bool? = nil, expectedTurn: String? = nil, thread: String? = nil, turn: String? = nil) {
    self.execute = execute
    self.expectedTurn = expectedTurn
    self.thread = thread
    self.turn = turn
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case expectedTurn = "expectedTurn"
    case thread = "thread"
    case turn = "turn"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.expectedTurn {
      body["expectedTurn"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.thread {
      body["thread"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.turn {
      body["turn"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsRuntimeFollowUpReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var error: String?
  public var ok: Bool
  public var operation: String?

  public init(data: RaviJSON? = nil, error: String? = nil, ok: Bool, operation: String? = nil) {
    self.data = data
    self.error = error
    self.ok = ok
    self.operation = operation
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case error = "error"
    case ok = "ok"
    case operation = "operation"
  }
}

public struct SessionsRuntimeForkOptions: Codable, Sendable {
  public var cwd: String?
  public var execute: Bool?
  public var path: String?

  public init(cwd: String? = nil, execute: Bool? = nil, path: String? = nil) {
    self.cwd = cwd
    self.execute = execute
    self.path = path
  }

  enum CodingKeys: String, CodingKey {
    case cwd = "cwd"
    case execute = "execute"
    case path = "path"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cwd {
      body["cwd"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.path {
      body["path"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsRuntimeForkReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var error: String?
  public var ok: Bool
  public var operation: String?

  public init(data: RaviJSON? = nil, error: String? = nil, ok: Bool, operation: String? = nil) {
    self.data = data
    self.error = error
    self.ok = ok
    self.operation = operation
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case error = "error"
    case ok = "ok"
    case operation = "operation"
  }
}

public struct SessionsRuntimeInterruptOptions: Codable, Sendable {
  public var thread: String?
  public var turn: String?

  public init(thread: String? = nil, turn: String? = nil) {
    self.thread = thread
    self.turn = turn
  }

  enum CodingKeys: String, CodingKey {
    case thread = "thread"
    case turn = "turn"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.thread {
      body["thread"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.turn {
      body["turn"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsRuntimeInterruptReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var error: String?
  public var ok: Bool
  public var operation: String?

  public init(data: RaviJSON? = nil, error: String? = nil, ok: Bool, operation: String? = nil) {
    self.data = data
    self.error = error
    self.ok = ok
    self.operation = operation
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case error = "error"
    case ok = "ok"
    case operation = "operation"
  }
}

public struct SessionsRuntimeListOptions: Codable, Sendable {
  public var archived: Bool?
  public var cursor: String?
  public var cwd: String?
  public var limit: String?
  public var search: String?

  public init(archived: Bool? = nil, cursor: String? = nil, cwd: String? = nil, limit: String? = nil, search: String? = nil) {
    self.archived = archived
    self.cursor = cursor
    self.cwd = cwd
    self.limit = limit
    self.search = search
  }

  enum CodingKeys: String, CodingKey {
    case archived = "archived"
    case cursor = "cursor"
    case cwd = "cwd"
    case limit = "limit"
    case search = "search"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.archived {
      body["archived"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cwd {
      body["cwd"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.search {
      body["search"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsRuntimeListReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var error: String?
  public var ok: Bool
  public var operation: String?

  public init(data: RaviJSON? = nil, error: String? = nil, ok: Bool, operation: String? = nil) {
    self.data = data
    self.error = error
    self.ok = ok
    self.operation = operation
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case error = "error"
    case ok = "ok"
    case operation = "operation"
  }
}

public struct SessionsRuntimeReadOptions: Codable, Sendable {
  public var summaryOnly: Bool?

  public init(summaryOnly: Bool? = nil) {
    self.summaryOnly = summaryOnly
  }

  enum CodingKeys: String, CodingKey {
    case summaryOnly = "summaryOnly"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.summaryOnly {
      body["summaryOnly"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsRuntimeReadReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var error: String?
  public var ok: Bool
  public var operation: String?

  public init(data: RaviJSON? = nil, error: String? = nil, ok: Bool, operation: String? = nil) {
    self.data = data
    self.error = error
    self.ok = ok
    self.operation = operation
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case error = "error"
    case ok = "ok"
    case operation = "operation"
  }
}

public struct SessionsRuntimeRollbackOptions: Codable, Sendable {
  public var execute: Bool?
  public var thread: String?

  public init(execute: Bool? = nil, thread: String? = nil) {
    self.execute = execute
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case thread = "thread"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.thread {
      body["thread"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsRuntimeRollbackReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var error: String?
  public var ok: Bool
  public var operation: String?

  public init(data: RaviJSON? = nil, error: String? = nil, ok: Bool, operation: String? = nil) {
    self.data = data
    self.error = error
    self.ok = ok
    self.operation = operation
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case error = "error"
    case ok = "ok"
    case operation = "operation"
  }
}

public struct SessionsRuntimeSteerOptions: Codable, Sendable {
  public var expectedTurn: String?
  public var thread: String?
  public var turn: String?

  public init(expectedTurn: String? = nil, thread: String? = nil, turn: String? = nil) {
    self.expectedTurn = expectedTurn
    self.thread = thread
    self.turn = turn
  }

  enum CodingKeys: String, CodingKey {
    case expectedTurn = "expectedTurn"
    case thread = "thread"
    case turn = "turn"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.expectedTurn {
      body["expectedTurn"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.thread {
      body["thread"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.turn {
      body["turn"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsRuntimeSteerReturn: Codable, Sendable {
  public var data: RaviJSON?
  public var error: String?
  public var ok: Bool
  public var operation: String?

  public init(data: RaviJSON? = nil, error: String? = nil, ok: Bool, operation: String? = nil) {
    self.data = data
    self.error = error
    self.ok = ok
    self.operation = operation
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case error = "error"
    case ok = "ok"
    case operation = "operation"
  }
}

public struct SessionsSendOptions: Codable, Sendable {
  public var agent: String?
  public var barrier: String?
  public var channel: String?
  public var immediate: Bool?
  public var interactive: Bool?
  public var steer: Bool?
  public var thread: String?
  public var threadOwner: String?
  public var threadScope: String?
  public var threadSummary: String?
  public var threadTitle: String?
  public var to: String?
  public var wait: Bool?

  public init(agent: String? = nil, barrier: String? = nil, channel: String? = nil, immediate: Bool? = nil, interactive: Bool? = nil, steer: Bool? = nil, thread: String? = nil, threadOwner: String? = nil, threadScope: String? = nil, threadSummary: String? = nil, threadTitle: String? = nil, to: String? = nil, wait: Bool? = nil) {
    self.agent = agent
    self.barrier = barrier
    self.channel = channel
    self.immediate = immediate
    self.interactive = interactive
    self.steer = steer
    self.thread = thread
    self.threadOwner = threadOwner
    self.threadScope = threadScope
    self.threadSummary = threadSummary
    self.threadTitle = threadTitle
    self.to = to
    self.wait = wait
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case barrier = "barrier"
    case channel = "channel"
    case immediate = "immediate"
    case interactive = "interactive"
    case steer = "steer"
    case thread = "thread"
    case threadOwner = "threadOwner"
    case threadScope = "threadScope"
    case threadSummary = "threadSummary"
    case threadTitle = "threadTitle"
    case to = "to"
    case wait = "wait"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.barrier {
      body["barrier"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.immediate {
      body["immediate"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.interactive {
      body["interactive"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.steer {
      body["steer"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.thread {
      body["thread"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadOwner {
      body["threadOwner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadScope {
      body["threadScope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadSummary {
      body["threadSummary"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadTitle {
      body["threadTitle"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.wait {
      body["wait"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SessionsSendReturn: Codable, Sendable {
  public var action: String
  public var createdSession: Bool
  public var delivery: [String: RaviJSON]
  public var mode: String
  public var promptLength: Int
  public var published: Bool
  public var response: RaviJSON?
  public var session: RaviJSON
  public var thread: RaviJSON

  public init(action: String, createdSession: Bool, delivery: [String: RaviJSON], mode: String, promptLength: Int, published: Bool, response: RaviJSON? = nil, session: RaviJSON, thread: RaviJSON) {
    self.action = action
    self.createdSession = createdSession
    self.delivery = delivery
    self.mode = mode
    self.promptLength = promptLength
    self.published = published
    self.response = response
    self.session = session
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case createdSession = "createdSession"
    case delivery = "delivery"
    case mode = "mode"
    case promptLength = "promptLength"
    case published = "published"
    case response = "response"
    case session = "session"
    case thread = "thread"
  }
}

public typealias SessionsSetDisplayReturn = [String: RaviJSON]

public struct SessionsSetEffortReturn: Codable, Sendable {
  public var action: String
  public var after: RaviJSON
  public var appliesOn: String
  public var before: RaviJSON
  public var changed: Bool
  public var effectiveEffort: String
  public var effectiveEffortSource: String
  public var effortOverride: RaviJSON
  public var sessionKey: String
  public var sessionName: RaviJSON

  public init(action: String, after: RaviJSON, appliesOn: String, before: RaviJSON, changed: Bool, effectiveEffort: String, effectiveEffortSource: String, effortOverride: RaviJSON, sessionKey: String, sessionName: RaviJSON) {
    self.action = action
    self.after = after
    self.appliesOn = appliesOn
    self.before = before
    self.changed = changed
    self.effectiveEffort = effectiveEffort
    self.effectiveEffortSource = effectiveEffortSource
    self.effortOverride = effortOverride
    self.sessionKey = sessionKey
    self.sessionName = sessionName
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case after = "after"
    case appliesOn = "appliesOn"
    case before = "before"
    case changed = "changed"
    case effectiveEffort = "effectiveEffort"
    case effectiveEffortSource = "effectiveEffortSource"
    case effortOverride = "effortOverride"
    case sessionKey = "sessionKey"
    case sessionName = "sessionName"
  }
}

public typealias SessionsSetModelReturn = [String: RaviJSON]

public struct SessionsSetProviderReturn: Codable, Sendable {
  public var action: String
  public var after: RaviJSON
  public var appliesOn: String
  public var before: RaviJSON
  public var changed: Bool
  public var effectiveProvider: String
  public var runtimeProviderOverride: RaviJSON
  public var sessionKey: String
  public var sessionName: RaviJSON

  public init(action: String, after: RaviJSON, appliesOn: String, before: RaviJSON, changed: Bool, effectiveProvider: String, runtimeProviderOverride: RaviJSON, sessionKey: String, sessionName: RaviJSON) {
    self.action = action
    self.after = after
    self.appliesOn = appliesOn
    self.before = before
    self.changed = changed
    self.effectiveProvider = effectiveProvider
    self.runtimeProviderOverride = runtimeProviderOverride
    self.sessionKey = sessionKey
    self.sessionName = sessionName
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case after = "after"
    case appliesOn = "appliesOn"
    case before = "before"
    case changed = "changed"
    case effectiveProvider = "effectiveProvider"
    case runtimeProviderOverride = "runtimeProviderOverride"
    case sessionKey = "sessionKey"
    case sessionName = "sessionName"
  }
}

public typealias SessionsSetThinkingReturn = [String: RaviJSON]

public typealias SessionsSetTtlReturn = [String: RaviJSON]

public typealias SessionsSubscriptionsReturn = [String: RaviJSON]

public struct SessionsTraceOptions: Codable, Sendable {
  public var correlation: String?
  public var explain: Bool?
  public var includeStream: Bool?
  public var limit: String?
  public var message: String?
  public var only: String?
  public var raw: Bool?
  public var run: String?
  public var showSystemPrompt: Bool?
  public var showUserPrompt: Bool?
  public var since: String?
  public var turn: String?
  public var until: String?

  public init(correlation: String? = nil, explain: Bool? = nil, includeStream: Bool? = nil, limit: String? = nil, message: String? = nil, only: String? = nil, raw: Bool? = nil, run: String? = nil, showSystemPrompt: Bool? = nil, showUserPrompt: Bool? = nil, since: String? = nil, turn: String? = nil, until: String? = nil) {
    self.correlation = correlation
    self.explain = explain
    self.includeStream = includeStream
    self.limit = limit
    self.message = message
    self.only = only
    self.raw = raw
    self.run = run
    self.showSystemPrompt = showSystemPrompt
    self.showUserPrompt = showUserPrompt
    self.since = since
    self.turn = turn
    self.until = until
  }

  enum CodingKeys: String, CodingKey {
    case correlation = "correlation"
    case explain = "explain"
    case includeStream = "includeStream"
    case limit = "limit"
    case message = "message"
    case only = "only"
    case raw = "raw"
    case run = "run"
    case showSystemPrompt = "showSystemPrompt"
    case showUserPrompt = "showUserPrompt"
    case since = "since"
    case turn = "turn"
    case until = "until"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.correlation {
      body["correlation"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.explain {
      body["explain"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeStream {
      body["includeStream"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.only {
      body["only"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.raw {
      body["raw"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.run {
      body["run"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.showSystemPrompt {
      body["showSystemPrompt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.showUserPrompt {
      body["showUserPrompt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.since {
      body["since"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.turn {
      body["turn"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.until {
      body["until"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias SessionsTraceReturn = [String: RaviJSON]

public typealias SessionsVisibilityReturn = [String: RaviJSON]

public struct SettingsDeleteOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SettingsDeleteReturn: Codable, Sendable {
  public var changedCount: Double
  public var setting: RaviJSON
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, setting: RaviJSON, status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.setting = setting
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case setting = "setting"
    case status = "status"
    case target = "target"
  }
}

public struct SettingsGetReturn: Codable, Sendable {
  public var setting: RaviJSON

  public init(setting: RaviJSON) {
    self.setting = setting
  }

  enum CodingKeys: String, CodingKey {
    case setting = "setting"
  }
}

public struct SettingsListOptions: Codable, Sendable {
  public var fields: String?
  public var legacy: Bool?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, legacy: Bool? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.legacy = legacy
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case legacy = "legacy"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.legacy {
      body["legacy"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SettingsListReturn: Codable, Sendable {
  public var customSettings: [RaviJSON]
  public var items: [RaviJSON]
  public var knownSettings: [RaviJSON]
  public var legacySettings: RaviJSON
  public var pagination: RaviJSON
  public var showLegacy: Bool
  public var total: Double

  public init(customSettings: [RaviJSON], items: [RaviJSON], knownSettings: [RaviJSON], legacySettings: RaviJSON, pagination: RaviJSON, showLegacy: Bool, total: Double) {
    self.customSettings = customSettings
    self.items = items
    self.knownSettings = knownSettings
    self.legacySettings = legacySettings
    self.pagination = pagination
    self.showLegacy = showLegacy
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case customSettings = "customSettings"
    case items = "items"
    case knownSettings = "knownSettings"
    case legacySettings = "legacySettings"
    case pagination = "pagination"
    case showLegacy = "showLegacy"
    case total = "total"
  }
}

public struct SettingsSetReturn: Codable, Sendable {
  public var changedCount: Double
  public var setting: RaviJSON
  public var status: String
  public var target: RaviJSON

  public init(changedCount: Double, setting: RaviJSON, status: String, target: RaviJSON) {
    self.changedCount = changedCount
    self.setting = setting
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case setting = "setting"
    case status = "status"
    case target = "target"
  }
}

public struct SkillGatesDisableReturn: Codable, Sendable {
  public var rule: RaviJSON
  public var success: Bool

  public init(rule: RaviJSON, success: Bool) {
    self.rule = rule
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case rule = "rule"
    case success = "success"
  }
}

public struct SkillGatesEnableReturn: Codable, Sendable {
  public var rule: RaviJSON
  public var success: Bool

  public init(rule: RaviJSON, success: Bool) {
    self.rule = rule
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case rule = "rule"
    case success = "success"
  }
}

public struct SkillGatesListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillGatesListReturn: Codable, Sendable {
  public var configuredTotal: Double
  public var filters: [String: RaviJSON]?
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var rules: [RaviJSON]
  public var total: Double

  public init(configuredTotal: Double, filters: [String: RaviJSON]? = nil, items: [RaviJSON], pagination: RaviJSON, rules: [RaviJSON], total: Double) {
    self.configuredTotal = configuredTotal
    self.filters = filters
    self.items = items
    self.pagination = pagination
    self.rules = rules
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case configuredTotal = "configuredTotal"
    case filters = "filters"
    case items = "items"
    case pagination = "pagination"
    case rules = "rules"
    case total = "total"
  }
}

public struct SkillGatesResetOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillGatesResetReturn: Codable, Sendable {
  public var deleted: Bool
  public var success: Bool

  public init(deleted: Bool, success: Bool) {
    self.deleted = deleted
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case deleted = "deleted"
    case success = "success"
  }
}

public struct SkillGatesRmOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillGatesRmReturn: Codable, Sendable {
  public var action: String
  public var deleted: Bool?
  public var rule: RaviJSON?
  public var success: Bool

  public init(action: String, deleted: Bool? = nil, rule: RaviJSON? = nil, success: Bool) {
    self.action = action
    self.deleted = deleted
    self.rule = rule
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case deleted = "deleted"
    case rule = "rule"
    case success = "success"
  }
}

public struct SkillGatesSetOptions: Codable, Sendable {
  public var command: String?
  public var commandPrefix: String?
  public var commandRegex: String?
  public var groupRegex: String?
  public var pattern: String?
  public var tool: String?
  public var toolPrefix: String?
  public var toolRegex: String?

  public init(command: String? = nil, commandPrefix: String? = nil, commandRegex: String? = nil, groupRegex: String? = nil, pattern: String? = nil, tool: String? = nil, toolPrefix: String? = nil, toolRegex: String? = nil) {
    self.command = command
    self.commandPrefix = commandPrefix
    self.commandRegex = commandRegex
    self.groupRegex = groupRegex
    self.pattern = pattern
    self.tool = tool
    self.toolPrefix = toolPrefix
    self.toolRegex = toolRegex
  }

  enum CodingKeys: String, CodingKey {
    case command = "command"
    case commandPrefix = "commandPrefix"
    case commandRegex = "commandRegex"
    case groupRegex = "groupRegex"
    case pattern = "pattern"
    case tool = "tool"
    case toolPrefix = "toolPrefix"
    case toolRegex = "toolRegex"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.command {
      body["command"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.commandPrefix {
      body["commandPrefix"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.commandRegex {
      body["commandRegex"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.groupRegex {
      body["groupRegex"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.pattern {
      body["pattern"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tool {
      body["tool"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.toolPrefix {
      body["toolPrefix"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.toolRegex {
      body["toolRegex"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillGatesSetReturn: Codable, Sendable {
  public var rule: RaviJSON
  public var success: Bool

  public init(rule: RaviJSON, success: Bool) {
    self.rule = rule
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case rule = "rule"
    case success = "success"
  }
}

public struct SkillGatesShowReturn: Codable, Sendable {
  public var rule: RaviJSON

  public init(rule: RaviJSON) {
    self.rule = rule
  }

  enum CodingKeys: String, CodingKey {
    case rule = "rule"
  }
}

public struct SkillsGrantOptions: Codable, Sendable {
  public var note: String?

  public init(note: String? = nil) {
    self.note = note
  }

  enum CodingKeys: String, CodingKey {
    case note = "note"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.note {
      body["note"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillsGrantReturn: Codable, Sendable {
  public var agentId: String
  public var grant: RaviJSON?
  public var skillName: String
  public var success: Bool

  public init(agentId: String, grant: RaviJSON? = nil, skillName: String, success: Bool) {
    self.agentId = agentId
    self.grant = grant
    self.skillName = skillName
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case grant = "grant"
    case skillName = "skillName"
    case success = "success"
  }
}

public struct SkillsGrantBatchOptions: Codable, Sendable {
  public var agent: String?
  public var allAgents: Bool?
  public var allSkills: Bool?
  public var dryRun: Bool?
  public var note: String?
  public var skill: String?

  public init(agent: String? = nil, allAgents: Bool? = nil, allSkills: Bool? = nil, dryRun: Bool? = nil, note: String? = nil, skill: String? = nil) {
    self.agent = agent
    self.allAgents = allAgents
    self.allSkills = allSkills
    self.dryRun = dryRun
    self.note = note
    self.skill = skill
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case allAgents = "allAgents"
    case allSkills = "allSkills"
    case dryRun = "dryRun"
    case note = "note"
    case skill = "skill"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.allAgents {
      body["allAgents"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.allSkills {
      body["allSkills"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.note {
      body["note"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skill {
      body["skill"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillsGrantBatchReturn: Codable, Sendable {
  public var agentsTargeted: Double
  public var dryRun: Bool
  public var errors: [RaviJSON]
  public var op: String
  public var pairsAffected: Double
  public var pairsSkipped: Double
  public var sampleAgents: [String]
  public var sampleSkills: [String]
  public var skillsTargeted: Double

  public init(agentsTargeted: Double, dryRun: Bool, errors: [RaviJSON], op: String, pairsAffected: Double, pairsSkipped: Double, sampleAgents: [String], sampleSkills: [String], skillsTargeted: Double) {
    self.agentsTargeted = agentsTargeted
    self.dryRun = dryRun
    self.errors = errors
    self.op = op
    self.pairsAffected = pairsAffected
    self.pairsSkipped = pairsSkipped
    self.sampleAgents = sampleAgents
    self.sampleSkills = sampleSkills
    self.skillsTargeted = skillsTargeted
  }

  enum CodingKeys: String, CodingKey {
    case agentsTargeted = "agentsTargeted"
    case dryRun = "dryRun"
    case errors = "errors"
    case op = "op"
    case pairsAffected = "pairsAffected"
    case pairsSkipped = "pairsSkipped"
    case sampleAgents = "sampleAgents"
    case sampleSkills = "sampleSkills"
    case skillsTargeted = "skillsTargeted"
  }
}

public struct SkillsInspectReturn: Codable, Sendable {
  public var agentId: String
  public var allowlist: [String]
  public var hasConfiguration: Bool
  public var provenance: RaviJSON

  public init(agentId: String, allowlist: [String], hasConfiguration: Bool, provenance: RaviJSON) {
    self.agentId = agentId
    self.allowlist = allowlist
    self.hasConfiguration = hasConfiguration
    self.provenance = provenance
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case allowlist = "allowlist"
    case hasConfiguration = "hasConfiguration"
    case provenance = "provenance"
  }
}

public struct SkillsInstallOptions: Codable, Sendable {
  public var all: Bool?
  public var execute: Bool?
  public var overwrite: Bool?
  public var plugin: String?
  public var skill: String?
  public var skipCodexSync: Bool?
  public var source: String?

  public init(all: Bool? = nil, execute: Bool? = nil, overwrite: Bool? = nil, plugin: String? = nil, skill: String? = nil, skipCodexSync: Bool? = nil, source: String? = nil) {
    self.all = all
    self.execute = execute
    self.overwrite = overwrite
    self.plugin = plugin
    self.skill = skill
    self.skipCodexSync = skipCodexSync
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case all = "all"
    case execute = "execute"
    case overwrite = "overwrite"
    case plugin = "plugin"
    case skill = "skill"
    case skipCodexSync = "skipCodexSync"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.all {
      body["all"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.overwrite {
      body["overwrite"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.plugin {
      body["plugin"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skill {
      body["skill"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipCodexSync {
      body["skipCodexSync"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillsInstallReturn: Codable, Sendable {
  public var codexSynced: [String]
  public var installed: [RaviJSON]
  public var source: String
  public var success: Bool

  public init(codexSynced: [String], installed: [RaviJSON], source: String, success: Bool) {
    self.codexSynced = codexSynced
    self.installed = installed
    self.source = source
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case codexSynced = "codexSynced"
    case installed = "installed"
    case source = "source"
    case success = "success"
  }
}

public struct SkillsListOptions: Codable, Sendable {
  public var codex: Bool?
  public var fields: String?
  public var installed: Bool?
  public var limit: String?
  public var offset: String?
  public var source: String?
  public var tag: String?

  public init(codex: Bool? = nil, fields: String? = nil, installed: Bool? = nil, limit: String? = nil, offset: String? = nil, source: String? = nil, tag: String? = nil) {
    self.codex = codex
    self.fields = fields
    self.installed = installed
    self.limit = limit
    self.offset = offset
    self.source = source
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case codex = "codex"
    case fields = "fields"
    case installed = "installed"
    case limit = "limit"
    case offset = "offset"
    case source = "source"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.codex {
      body["codex"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.installed {
      body["installed"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillsListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var skills: [RaviJSON]
  public var source: String
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, skills: [RaviJSON], source: String, total: Double) {
    self.items = items
    self.pagination = pagination
    self.skills = skills
    self.source = source
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case skills = "skills"
    case source = "source"
    case total = "total"
  }
}

public struct SkillsRevokeReturn: Codable, Sendable {
  public var agentId: String
  public var grant: RaviJSON?
  public var skillName: String
  public var success: Bool

  public init(agentId: String, grant: RaviJSON? = nil, skillName: String, success: Bool) {
    self.agentId = agentId
    self.grant = grant
    self.skillName = skillName
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case agentId = "agentId"
    case grant = "grant"
    case skillName = "skillName"
    case success = "success"
  }
}

public struct SkillsRevokeBatchOptions: Codable, Sendable {
  public var agent: String?
  public var allAgents: Bool?
  public var allSkills: Bool?
  public var dryRun: Bool?
  public var skill: String?

  public init(agent: String? = nil, allAgents: Bool? = nil, allSkills: Bool? = nil, dryRun: Bool? = nil, skill: String? = nil) {
    self.agent = agent
    self.allAgents = allAgents
    self.allSkills = allSkills
    self.dryRun = dryRun
    self.skill = skill
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case allAgents = "allAgents"
    case allSkills = "allSkills"
    case dryRun = "dryRun"
    case skill = "skill"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.allAgents {
      body["allAgents"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.allSkills {
      body["allSkills"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skill {
      body["skill"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillsRevokeBatchReturn: Codable, Sendable {
  public var agentsTargeted: Double
  public var dryRun: Bool
  public var errors: [RaviJSON]
  public var op: String
  public var pairsAffected: Double
  public var pairsSkipped: Double
  public var sampleAgents: [String]
  public var sampleSkills: [String]
  public var skillsTargeted: Double

  public init(agentsTargeted: Double, dryRun: Bool, errors: [RaviJSON], op: String, pairsAffected: Double, pairsSkipped: Double, sampleAgents: [String], sampleSkills: [String], skillsTargeted: Double) {
    self.agentsTargeted = agentsTargeted
    self.dryRun = dryRun
    self.errors = errors
    self.op = op
    self.pairsAffected = pairsAffected
    self.pairsSkipped = pairsSkipped
    self.sampleAgents = sampleAgents
    self.sampleSkills = sampleSkills
    self.skillsTargeted = skillsTargeted
  }

  enum CodingKeys: String, CodingKey {
    case agentsTargeted = "agentsTargeted"
    case dryRun = "dryRun"
    case errors = "errors"
    case op = "op"
    case pairsAffected = "pairsAffected"
    case pairsSkipped = "pairsSkipped"
    case sampleAgents = "sampleAgents"
    case sampleSkills = "sampleSkills"
    case skillsTargeted = "skillsTargeted"
  }
}

public struct SkillsShowOptions: Codable, Sendable {
  public var installed: Bool?
  public var source: String?

  public init(installed: Bool? = nil, source: String? = nil) {
    self.installed = installed
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case installed = "installed"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.installed {
      body["installed"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillsShowReturn: Codable, Sendable {
  public var skill: RaviJSON

  public init(skill: RaviJSON) {
    self.skill = skill
  }

  enum CodingKeys: String, CodingKey {
    case skill = "skill"
  }
}

public struct SkillsSyncReturn: Codable, Sendable {
  public var codexSynced: [String]
  public var success: Bool
  public var total: Double

  public init(codexSynced: [String], success: Bool, total: Double) {
    self.codexSynced = codexSynced
    self.success = success
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case codexSynced = "codexSynced"
    case success = "success"
    case total = "total"
  }
}

public struct SkillsWhoOptions: Codable, Sendable {
  public var agent: String?
  public var fields: String?

  public init(agent: String? = nil, fields: String? = nil) {
    self.agent = agent
    self.fields = fields
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case fields = "fields"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SkillsWhoReturn: Codable, Sendable {
  public var grants: [RaviJSON]
  public var skillName: String?
  public var total: Double

  public init(grants: [RaviJSON], skillName: String? = nil, total: Double) {
    self.grants = grants
    self.skillName = skillName
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case grants = "grants"
    case skillName = "skillName"
    case total = "total"
  }
}

public struct SlackBlocksSendOptions: Codable, Sendable {
  public var connection: String?
  public var ephemeralUser: String?
  public var execute: Bool?
  public var text: String?
  public var threadTs: String?

  public init(connection: String? = nil, ephemeralUser: String? = nil, execute: Bool? = nil, text: String? = nil, threadTs: String? = nil) {
    self.connection = connection
    self.ephemeralUser = ephemeralUser
    self.execute = execute
    self.text = text
    self.threadTs = threadTs
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case ephemeralUser = "ephemeralUser"
    case execute = "execute"
    case text = "text"
    case threadTs = "threadTs"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ephemeralUser {
      body["ephemeralUser"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.text {
      body["text"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadTs {
      body["threadTs"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackBlocksSendReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackBlocksShowcaseOptions: Codable, Sendable {
  public var execute: Bool?
  public var threadTs: String?

  public init(execute: Bool? = nil, threadTs: String? = nil) {
    self.execute = execute
    self.threadTs = threadTs
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case threadTs = "threadTs"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadTs {
      body["threadTs"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackBlocksShowcaseReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackBlocksUpdateOptions: Codable, Sendable {
  public var execute: Bool?
  public var text: String?

  public init(execute: Bool? = nil, text: String? = nil) {
    self.execute = execute
    self.text = text
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case text = "text"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.text {
      body["text"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackBlocksUpdateReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackBlocksValidateOptions: Codable, Sendable {
  public var channel: String?
  public var target: String?

  public init(channel: String? = nil, target: String? = nil) {
    self.channel = channel
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case target = "target"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.target {
      body["target"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackBlocksValidateReturn: Codable, Sendable {
  public var connection: String
  public var item: RaviJSON?
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var source: String

  public init(connection: String, item: RaviJSON? = nil, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, source: String) {
    self.connection = connection
    self.item = item
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case item = "item"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case source = "source"
  }
}

public struct SlackCanvasAccessDeleteOptions: Codable, Sendable {
  public var channel: String?
  public var channels: String?
  public var execute: Bool?
  public var users: String?

  public init(channel: String? = nil, channels: String? = nil, execute: Bool? = nil, users: String? = nil) {
    self.channel = channel
    self.channels = channels
    self.execute = execute
    self.users = users
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case channels = "channels"
    case execute = "execute"
    case users = "users"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channels {
      body["channels"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.users {
      body["users"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasAccessDeleteReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackCanvasAccessSetOptions: Codable, Sendable {
  public var channel: String?
  public var channels: String?
  public var execute: Bool?
  public var users: String?

  public init(channel: String? = nil, channels: String? = nil, execute: Bool? = nil, users: String? = nil) {
    self.channel = channel
    self.channels = channels
    self.execute = execute
    self.users = users
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case channels = "channels"
    case execute = "execute"
    case users = "users"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channels {
      body["channels"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.users {
      body["users"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasAccessSetReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackCanvasArtifactPublishOptions: Codable, Sendable {
  public var canvas: String?
  public var channel: String?
  public var execute: Bool?
  public var skipRefresh: Bool?
  public var slackChannel: String?
  public var title: String?

  public init(canvas: String? = nil, channel: String? = nil, execute: Bool? = nil, skipRefresh: Bool? = nil, slackChannel: String? = nil, title: String? = nil) {
    self.canvas = canvas
    self.channel = channel
    self.execute = execute
    self.skipRefresh = skipRefresh
    self.slackChannel = slackChannel
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case canvas = "canvas"
    case channel = "channel"
    case execute = "execute"
    case skipRefresh = "skipRefresh"
    case slackChannel = "slackChannel"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.canvas {
      body["canvas"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipRefresh {
      body["skipRefresh"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.slackChannel {
      body["slackChannel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasArtifactPublishReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackCanvasArtifactStatusReturn: Codable, Sendable {
  public var item: [String: RaviJSON]
  public var ok: Bool
  public var provider: String

  public init(item: [String: RaviJSON], ok: Bool, provider: String) {
    self.item = item
    self.ok = ok
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case item = "item"
    case ok = "ok"
    case provider = "provider"
  }
}

public struct SlackCanvasChannelCreateOptions: Codable, Sendable {
  public var artifact: String?
  public var ensure: Bool?
  public var execute: Bool?
  public var markdown: String?
  public var markdownFile: String?
  public var skipRefresh: Bool?
  public var title: String?

  public init(artifact: String? = nil, ensure: Bool? = nil, execute: Bool? = nil, markdown: String? = nil, markdownFile: String? = nil, skipRefresh: Bool? = nil, title: String? = nil) {
    self.artifact = artifact
    self.ensure = ensure
    self.execute = execute
    self.markdown = markdown
    self.markdownFile = markdownFile
    self.skipRefresh = skipRefresh
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case ensure = "ensure"
    case execute = "execute"
    case markdown = "markdown"
    case markdownFile = "markdownFile"
    case skipRefresh = "skipRefresh"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.artifact {
      body["artifact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.ensure {
      body["ensure"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.markdown {
      body["markdown"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.markdownFile {
      body["markdownFile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipRefresh {
      body["skipRefresh"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasChannelCreateReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackCanvasChannelShowcaseOptions: Codable, Sendable {
  public var execute: Bool?
  public var title: String?

  public init(execute: Bool? = nil, title: String? = nil) {
    self.execute = execute
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasChannelShowcaseReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackCanvasCreateOptions: Codable, Sendable {
  public var artifact: String?
  public var channel: String?
  public var execute: Bool?
  public var markdown: String?
  public var markdownFile: String?
  public var skipRefresh: Bool?
  public var slackChannel: String?
  public var title: String?

  public init(artifact: String? = nil, channel: String? = nil, execute: Bool? = nil, markdown: String? = nil, markdownFile: String? = nil, skipRefresh: Bool? = nil, slackChannel: String? = nil, title: String? = nil) {
    self.artifact = artifact
    self.channel = channel
    self.execute = execute
    self.markdown = markdown
    self.markdownFile = markdownFile
    self.skipRefresh = skipRefresh
    self.slackChannel = slackChannel
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case channel = "channel"
    case execute = "execute"
    case markdown = "markdown"
    case markdownFile = "markdownFile"
    case skipRefresh = "skipRefresh"
    case slackChannel = "slackChannel"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.artifact {
      body["artifact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.markdown {
      body["markdown"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.markdownFile {
      body["markdownFile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipRefresh {
      body["skipRefresh"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.slackChannel {
      body["slackChannel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasCreateReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackCanvasDeleteOptions: Codable, Sendable {
  public var channel: String?
  public var execute: Bool?

  public init(channel: String? = nil, execute: Bool? = nil) {
    self.channel = channel
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasDeleteReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackCanvasEditOptions: Codable, Sendable {
  public var artifact: String?
  public var channel: String?
  public var execute: Bool?
  public var markdown: String?
  public var markdownFile: String?
  public var sectionId: String?
  public var skipRefresh: Bool?
  public var title: String?

  public init(artifact: String? = nil, channel: String? = nil, execute: Bool? = nil, markdown: String? = nil, markdownFile: String? = nil, sectionId: String? = nil, skipRefresh: Bool? = nil, title: String? = nil) {
    self.artifact = artifact
    self.channel = channel
    self.execute = execute
    self.markdown = markdown
    self.markdownFile = markdownFile
    self.sectionId = sectionId
    self.skipRefresh = skipRefresh
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case channel = "channel"
    case execute = "execute"
    case markdown = "markdown"
    case markdownFile = "markdownFile"
    case sectionId = "sectionId"
    case skipRefresh = "skipRefresh"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.artifact {
      body["artifact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.markdown {
      body["markdown"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.markdownFile {
      body["markdownFile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sectionId {
      body["sectionId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipRefresh {
      body["skipRefresh"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasEditReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackCanvasSectionsLookupOptions: Codable, Sendable {
  public var channel: String?
  public var containsText: String?
  public var fields: String?
  public var sectionTypes: String?

  public init(channel: String? = nil, containsText: String? = nil, fields: String? = nil, sectionTypes: String? = nil) {
    self.channel = channel
    self.containsText = containsText
    self.fields = fields
    self.sectionTypes = sectionTypes
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case containsText = "containsText"
    case fields = "fields"
    case sectionTypes = "sectionTypes"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.containsText {
      body["containsText"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sectionTypes {
      body["sectionTypes"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasSectionsLookupReturn: Codable, Sendable {
  public var connection: String
  public var items: [RaviJSON]
  public var ok: Bool
  public var pagination: RaviJSON
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var source: String

  public init(connection: String, items: [RaviJSON], ok: Bool, pagination: RaviJSON, provider: String, raw: [String: RaviJSON]? = nil, source: String) {
    self.connection = connection
    self.items = items
    self.ok = ok
    self.pagination = pagination
    self.provider = provider
    self.raw = raw
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case items = "items"
    case ok = "ok"
    case pagination = "pagination"
    case provider = "provider"
    case raw = "raw"
    case source = "source"
  }
}

public struct SlackCanvasShowcaseOptions: Codable, Sendable {
  public var channel: String?
  public var execute: Bool?
  public var slackChannel: String?
  public var title: String?

  public init(channel: String? = nil, execute: Bool? = nil, slackChannel: String? = nil, title: String? = nil) {
    self.channel = channel
    self.execute = execute
    self.slackChannel = slackChannel
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case execute = "execute"
    case slackChannel = "slackChannel"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.slackChannel {
      body["slackChannel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackCanvasShowcaseReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackChannelsCreateOptions: Codable, Sendable {
  public var channel: String?
  public var execute: Bool?
  public var private_: Bool?

  public init(channel: String? = nil, execute: Bool? = nil, private_: Bool? = nil) {
    self.channel = channel
    self.execute = execute
    self.private_ = private_
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case execute = "execute"
    case private_ = "private"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.private_ {
      body["private"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackChannelsCreateReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackChannelsHistoryOptions: Codable, Sendable {
  public var cursor: String?
  public var fields: String?
  public var inclusive: Bool?
  public var latest: String?
  public var limit: String?
  public var oldest: String?

  public init(cursor: String? = nil, fields: String? = nil, inclusive: Bool? = nil, latest: String? = nil, limit: String? = nil, oldest: String? = nil) {
    self.cursor = cursor
    self.fields = fields
    self.inclusive = inclusive
    self.latest = latest
    self.limit = limit
    self.oldest = oldest
  }

  enum CodingKeys: String, CodingKey {
    case cursor = "cursor"
    case fields = "fields"
    case inclusive = "inclusive"
    case latest = "latest"
    case limit = "limit"
    case oldest = "oldest"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.inclusive {
      body["inclusive"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.latest {
      body["latest"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.oldest {
      body["oldest"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackChannelsHistoryReturn: Codable, Sendable {
  public var connection: String
  public var items: [RaviJSON]
  public var ok: Bool
  public var pagination: RaviJSON
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var source: String

  public init(connection: String, items: [RaviJSON], ok: Bool, pagination: RaviJSON, provider: String, raw: [String: RaviJSON]? = nil, source: String) {
    self.connection = connection
    self.items = items
    self.ok = ok
    self.pagination = pagination
    self.provider = provider
    self.raw = raw
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case items = "items"
    case ok = "ok"
    case pagination = "pagination"
    case provider = "provider"
    case raw = "raw"
    case source = "source"
  }
}

public struct SlackChannelsInfoReturn: Codable, Sendable {
  public var connection: String
  public var item: RaviJSON?
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var source: String

  public init(connection: String, item: RaviJSON? = nil, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, source: String) {
    self.connection = connection
    self.item = item
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case item = "item"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case source = "source"
  }
}

public struct SlackChannelsInviteOptions: Codable, Sendable {
  public var connection: String?
  public var execute: Bool?

  public init(connection: String? = nil, execute: Bool? = nil) {
    self.connection = connection
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackChannelsInviteReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackChannelsListOptions: Codable, Sendable {
  public var channel: String?
  public var cursor: String?
  public var fields: String?
  public var includeArchived: Bool?
  public var limit: String?
  public var types: String?

  public init(channel: String? = nil, cursor: String? = nil, fields: String? = nil, includeArchived: Bool? = nil, limit: String? = nil, types: String? = nil) {
    self.channel = channel
    self.cursor = cursor
    self.fields = fields
    self.includeArchived = includeArchived
    self.limit = limit
    self.types = types
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case cursor = "cursor"
    case fields = "fields"
    case includeArchived = "includeArchived"
    case limit = "limit"
    case types = "types"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeArchived {
      body["includeArchived"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.types {
      body["types"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackChannelsListReturn: Codable, Sendable {
  public var connection: String
  public var items: [RaviJSON]
  public var ok: Bool
  public var pagination: RaviJSON
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var source: String

  public init(connection: String, items: [RaviJSON], ok: Bool, pagination: RaviJSON, provider: String, raw: [String: RaviJSON]? = nil, source: String) {
    self.connection = connection
    self.items = items
    self.ok = ok
    self.pagination = pagination
    self.provider = provider
    self.raw = raw
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case items = "items"
    case ok = "ok"
    case pagination = "pagination"
    case provider = "provider"
    case raw = "raw"
    case source = "source"
  }
}

public struct SlackChannelsRenameOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackChannelsRenameReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackFilesListOptions: Codable, Sendable {
  public var channel: String?
  public var cursor: String?
  public var fields: String?
  public var limit: String?
  public var slackChannel: String?
  public var user: String?

  public init(channel: String? = nil, cursor: String? = nil, fields: String? = nil, limit: String? = nil, slackChannel: String? = nil, user: String? = nil) {
    self.channel = channel
    self.cursor = cursor
    self.fields = fields
    self.limit = limit
    self.slackChannel = slackChannel
    self.user = user
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case cursor = "cursor"
    case fields = "fields"
    case limit = "limit"
    case slackChannel = "slackChannel"
    case user = "user"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.slackChannel {
      body["slackChannel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.user {
      body["user"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackFilesListReturn: Codable, Sendable {
  public var connection: String
  public var items: [RaviJSON]
  public var ok: Bool
  public var pagination: RaviJSON
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var source: String

  public init(connection: String, items: [RaviJSON], ok: Bool, pagination: RaviJSON, provider: String, raw: [String: RaviJSON]? = nil, source: String) {
    self.connection = connection
    self.items = items
    self.ok = ok
    self.pagination = pagination
    self.provider = provider
    self.raw = raw
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case items = "items"
    case ok = "ok"
    case pagination = "pagination"
    case provider = "provider"
    case raw = "raw"
    case source = "source"
  }
}

public struct SlackInteractionsRespondOptions: Codable, Sendable {
  public var channel: String?
  public var execute: Bool?

  public init(channel: String? = nil, execute: Bool? = nil) {
    self.channel = channel
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackInteractionsRespondReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackMembersListOptions: Codable, Sendable {
  public var cursor: String?
  public var limit: String?

  public init(cursor: String? = nil, limit: String? = nil) {
    self.cursor = cursor
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case cursor = "cursor"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackMembersListReturn: Codable, Sendable {
  public var connection: String
  public var items: [RaviJSON]
  public var ok: Bool
  public var pagination: RaviJSON
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var source: String

  public init(connection: String, items: [RaviJSON], ok: Bool, pagination: RaviJSON, provider: String, raw: [String: RaviJSON]? = nil, source: String) {
    self.connection = connection
    self.items = items
    self.ok = ok
    self.pagination = pagination
    self.provider = provider
    self.raw = raw
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case items = "items"
    case ok = "ok"
    case pagination = "pagination"
    case provider = "provider"
    case raw = "raw"
    case source = "source"
  }
}

public struct SlackMessagesInspectReturn: Codable, Sendable {
  public var connection: String
  public var item: RaviJSON?
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var source: String

  public init(connection: String, item: RaviJSON? = nil, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, source: String) {
    self.connection = connection
    self.item = item
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case item = "item"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case source = "source"
  }
}

public struct SlackMessagesReplayOptions: Codable, Sendable {
  public var execute: Bool?
  public var force: Bool?

  public init(execute: Bool? = nil, force: Bool? = nil) {
    self.execute = execute
    self.force = force
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case force = "force"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.force {
      body["force"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackMessagesReplayReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackMessagesSendOptions: Codable, Sendable {
  public var ephemeralUser: String?
  public var execute: Bool?
  public var threadTs: String?

  public init(ephemeralUser: String? = nil, execute: Bool? = nil, threadTs: String? = nil) {
    self.ephemeralUser = ephemeralUser
    self.execute = execute
    self.threadTs = threadTs
  }

  enum CodingKeys: String, CodingKey {
    case ephemeralUser = "ephemeralUser"
    case execute = "execute"
    case threadTs = "threadTs"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.ephemeralUser {
      body["ephemeralUser"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadTs {
      body["threadTs"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackMessagesSendReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackModalsOpenOptions: Codable, Sendable {
  public var channel: String?
  public var execute: Bool?

  public init(channel: String? = nil, execute: Bool? = nil) {
    self.channel = channel
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackModalsOpenReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackModalsPushOptions: Codable, Sendable {
  public var channel: String?
  public var execute: Bool?

  public init(channel: String? = nil, execute: Bool? = nil) {
    self.channel = channel
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackModalsPushReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackModalsUpdateOptions: Codable, Sendable {
  public var channel: String?
  public var execute: Bool?
  public var externalId: Bool?
  public var hash: String?

  public init(channel: String? = nil, execute: Bool? = nil, externalId: Bool? = nil, hash: String? = nil) {
    self.channel = channel
    self.execute = execute
    self.externalId = externalId
    self.hash = hash
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case execute = "execute"
    case externalId = "externalId"
    case hash = "hash"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.externalId {
      body["externalId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.hash {
      body["hash"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackModalsUpdateReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackPermissionsListOptions: Codable, Sendable {
  public var channel: String?

  public init(channel: String? = nil) {
    self.channel = channel
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackPermissionsListReturn: Codable, Sendable {
  public var connection: String
  public var item: RaviJSON?
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var source: String

  public init(connection: String, item: RaviJSON? = nil, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, source: String) {
    self.connection = connection
    self.item = item
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case item = "item"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case source = "source"
  }
}

public struct SlackTopologyOptions: Codable, Sendable {
  public var channel: String?
  public var cursor: String?
  public var includeArchived: Bool?
  public var limit: String?
  public var types: String?

  public init(channel: String? = nil, cursor: String? = nil, includeArchived: Bool? = nil, limit: String? = nil, types: String? = nil) {
    self.channel = channel
    self.cursor = cursor
    self.includeArchived = includeArchived
    self.limit = limit
    self.types = types
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case cursor = "cursor"
    case includeArchived = "includeArchived"
    case limit = "limit"
    case types = "types"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.includeArchived {
      body["includeArchived"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.types {
      body["types"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackTopologyReturn: Codable, Sendable {
  public var accountId: String
  public var capabilities: [String: RaviJSON]
  public var channels: [RaviJSON]
  public var connection: String
  public var ok: Bool
  public var provider: String
  public var source: String
  public var ungroupedChannelIds: [String]

  public init(accountId: String, capabilities: [String: RaviJSON], channels: [RaviJSON], connection: String, ok: Bool, provider: String, source: String, ungroupedChannelIds: [String]) {
    self.accountId = accountId
    self.capabilities = capabilities
    self.channels = channels
    self.connection = connection
    self.ok = ok
    self.provider = provider
    self.source = source
    self.ungroupedChannelIds = ungroupedChannelIds
  }

  enum CodingKeys: String, CodingKey {
    case accountId = "accountId"
    case capabilities = "capabilities"
    case channels = "channels"
    case connection = "connection"
    case ok = "ok"
    case provider = "provider"
    case source = "source"
    case ungroupedChannelIds = "ungroupedChannelIds"
  }
}

public struct SlackWorkObjectsPresentDetailsOptions: Codable, Sendable {
  public var channel: String?
  public var connection: String?
  public var execute: Bool?

  public init(channel: String? = nil, connection: String? = nil, execute: Bool? = nil) {
    self.channel = channel
    self.connection = connection
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case connection = "connection"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackWorkObjectsPresentDetailsReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackWorkObjectsSendOptions: Codable, Sendable {
  public var connection: String?
  public var execute: Bool?
  public var text: String?
  public var threadTs: String?

  public init(connection: String? = nil, execute: Bool? = nil, text: String? = nil, threadTs: String? = nil) {
    self.connection = connection
    self.execute = execute
    self.text = text
    self.threadTs = threadTs
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case execute = "execute"
    case text = "text"
    case threadTs = "threadTs"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.text {
      body["text"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.threadTs {
      body["threadTs"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackWorkObjectsSendReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackWorkObjectsUnfurlOptions: Codable, Sendable {
  public var connection: String?
  public var execute: Bool?

  public init(connection: String? = nil, execute: Bool? = nil) {
    self.connection = connection
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackWorkObjectsUnfurlReturn: Codable, Sendable {
  public var connection: String
  public var dryRun: Bool
  public var item: RaviJSON?
  public var method: String
  public var ok: Bool
  public var provider: String
  public var raw: [String: RaviJSON]?
  public var request: [String: RaviJSON]
  public var source: String

  public init(connection: String, dryRun: Bool, item: RaviJSON? = nil, method: String, ok: Bool, provider: String, raw: [String: RaviJSON]? = nil, request: [String: RaviJSON], source: String) {
    self.connection = connection
    self.dryRun = dryRun
    self.item = item
    self.method = method
    self.ok = ok
    self.provider = provider
    self.raw = raw
    self.request = request
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case dryRun = "dryRun"
    case item = "item"
    case method = "method"
    case ok = "ok"
    case provider = "provider"
    case raw = "raw"
    case request = "request"
    case source = "source"
  }
}

public struct SlackWorkObjectsValidateOptions: Codable, Sendable {
  public var target: String?

  public init(target: String? = nil) {
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case target = "target"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.target {
      body["target"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SlackWorkObjectsValidateReturn: Codable, Sendable {
  public var dryRun: Bool?
  public var item: RaviJSON?
  public var ok: Bool
  public var outputFile: String?
  public var provider: String

  public init(dryRun: Bool? = nil, item: RaviJSON? = nil, ok: Bool, outputFile: String? = nil, provider: String) {
    self.dryRun = dryRun
    self.item = item
    self.ok = ok
    self.outputFile = outputFile
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case dryRun = "dryRun"
    case item = "item"
    case ok = "ok"
    case outputFile = "outputFile"
    case provider = "provider"
  }
}

public struct SpecsGetOptions: Codable, Sendable {
  public var mode: String?

  public init(mode: String? = nil) {
    self.mode = mode
  }

  enum CodingKeys: String, CodingKey {
    case mode = "mode"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.mode {
      body["mode"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SpecsGetReturn: Codable, Sendable {
  public var context: [String: RaviJSON]

  public init(context: [String: RaviJSON]) {
    self.context = context
  }

  enum CodingKeys: String, CodingKey {
    case context = "context"
  }
}

public struct SpecsListOptions: Codable, Sendable {
  public var domain: String?
  public var fields: String?
  public var kind: String?
  public var limit: String?
  public var offset: String?

  public init(domain: String? = nil, fields: String? = nil, kind: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.domain = domain
    self.fields = fields
    self.kind = kind
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case domain = "domain"
    case fields = "fields"
    case kind = "kind"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.domain {
      body["domain"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SpecsListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var specs: [[String: RaviJSON]]
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, specs: [[String: RaviJSON]], total: Double) {
    self.items = items
    self.pagination = pagination
    self.specs = specs
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case specs = "specs"
    case total = "total"
  }
}

public struct SpecsNewOptions: Codable, Sendable {
  public var full: Bool?
  public var kind: String?
  public var title: String?

  public init(full: Bool? = nil, kind: String? = nil, title: String? = nil) {
    self.full = full
    self.kind = kind
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case full = "full"
    case kind = "kind"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.full {
      body["full"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SpecsNewReturn: Codable, Sendable {
  public var createdFiles: [String]
  public var missingAncestors: [[String: RaviJSON]]
  public var spec: [String: RaviJSON]
  public var status: String

  public init(createdFiles: [String], missingAncestors: [[String: RaviJSON]], spec: [String: RaviJSON], status: String) {
    self.createdFiles = createdFiles
    self.missingAncestors = missingAncestors
    self.spec = spec
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case createdFiles = "createdFiles"
    case missingAncestors = "missingAncestors"
    case spec = "spec"
    case status = "status"
  }
}

public struct SpecsSyncReturn: Codable, Sendable {
  public var rootPath: String
  public var status: String
  public var total: Double

  public init(rootPath: String, status: String, total: Double) {
    self.rootPath = rootPath
    self.status = status
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case rootPath = "rootPath"
    case status = "status"
    case total = "total"
  }
}

public struct StickersAddOptions: Codable, Sendable {
  public var agents: String?
  public var avoid: String?
  public var channels: String?
  public var description: String?
  public var disabled: Bool?
  public var label: String?
  public var overwrite: Bool?

  public init(agents: String? = nil, avoid: String? = nil, channels: String? = nil, description: String? = nil, disabled: Bool? = nil, label: String? = nil, overwrite: Bool? = nil) {
    self.agents = agents
    self.avoid = avoid
    self.channels = channels
    self.description = description
    self.disabled = disabled
    self.label = label
    self.overwrite = overwrite
  }

  enum CodingKeys: String, CodingKey {
    case agents = "agents"
    case avoid = "avoid"
    case channels = "channels"
    case description = "description"
    case disabled = "disabled"
    case label = "label"
    case overwrite = "overwrite"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agents {
      body["agents"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.avoid {
      body["avoid"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channels {
      body["channels"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.disabled {
      body["disabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.overwrite {
      body["overwrite"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct StickersAddReturn: Codable, Sendable {
  public var action: String
  public var sticker: RaviJSON
  public var success: Bool

  public init(action: String, sticker: RaviJSON, success: Bool) {
    self.action = action
    self.sticker = sticker
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case sticker = "sticker"
    case success = "success"
  }
}

public struct StickersListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct StickersListReturn: Codable, Sendable {
  public var items: [RaviJSON]
  public var pagination: RaviJSON
  public var stickers: [RaviJSON]
  public var total: Double

  public init(items: [RaviJSON], pagination: RaviJSON, stickers: [RaviJSON], total: Double) {
    self.items = items
    self.pagination = pagination
    self.stickers = stickers
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case stickers = "stickers"
    case total = "total"
  }
}

public struct StickersRemoveOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct StickersRemoveReturn: Codable, Sendable {
  public var action: String
  public var stickerId: String
  public var success: Bool

  public init(action: String, stickerId: String, success: Bool) {
    self.action = action
    self.stickerId = stickerId
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case stickerId = "stickerId"
    case success = "success"
  }
}

public struct StickersSendOptions: Codable, Sendable {
  public var account: String?
  public var channel: String?
  public var execute: Bool?
  public var session: String?
  public var to: String?

  public init(account: String? = nil, channel: String? = nil, execute: Bool? = nil, session: String? = nil, to: String? = nil) {
    self.account = account
    self.channel = channel
    self.execute = execute
    self.session = session
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case channel = "channel"
    case execute = "execute"
    case session = "session"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.channel {
      body["channel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.to {
      body["to"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct StickersSendReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var sticker: RaviJSON
  public var success: Bool
  public var target: RaviJSON
  public var topic: String

  public init(event: [String: RaviJSON], sticker: RaviJSON, success: Bool, target: RaviJSON, topic: String) {
    self.event = event
    self.sticker = sticker
    self.success = success
    self.target = target
    self.topic = topic
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case sticker = "sticker"
    case success = "success"
    case target = "target"
    case topic = "topic"
  }
}

public struct StickersShowReturn: Codable, Sendable {
  public var sticker: RaviJSON

  public init(sticker: RaviJSON) {
    self.sticker = sticker
  }

  enum CodingKeys: String, CodingKey {
    case sticker = "sticker"
  }
}

public typealias SyncInspectReturn = RaviJSON

public struct SyncPullOptions: Codable, Sendable {
  public var domain: String?
  public var execute: Bool?
  public var limit: String?
  public var project: String?
  public var projectId: String?
  public var projectRef: String?
  public var scope: String?

  public init(domain: String? = nil, execute: Bool? = nil, limit: String? = nil, project: String? = nil, projectId: String? = nil, projectRef: String? = nil, scope: String? = nil) {
    self.domain = domain
    self.execute = execute
    self.limit = limit
    self.project = project
    self.projectId = projectId
    self.projectRef = projectRef
    self.scope = scope
  }

  enum CodingKeys: String, CodingKey {
    case domain = "domain"
    case execute = "execute"
    case limit = "limit"
    case project = "project"
    case projectId = "projectId"
    case projectRef = "projectRef"
    case scope = "scope"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.domain {
      body["domain"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.projectId {
      body["projectId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.projectRef {
      body["projectRef"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SyncPullReturn: Codable, Sendable {
  public var applied: Double
  public var cursor: RaviJSON
  public var downloaded: Double
  public var enqueued: Double
  public var errorCode: String?
  public var failed: Double
  public var linked: Bool
  public var skipped: Double
  public var status: String

  public init(applied: Double, cursor: RaviJSON, downloaded: Double, enqueued: Double, errorCode: String? = nil, failed: Double, linked: Bool, skipped: Double, status: String) {
    self.applied = applied
    self.cursor = cursor
    self.downloaded = downloaded
    self.enqueued = enqueued
    self.errorCode = errorCode
    self.failed = failed
    self.linked = linked
    self.skipped = skipped
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case applied = "applied"
    case cursor = "cursor"
    case downloaded = "downloaded"
    case enqueued = "enqueued"
    case errorCode = "errorCode"
    case failed = "failed"
    case linked = "linked"
    case skipped = "skipped"
    case status = "status"
  }
}

public struct SyncPushOptions: Codable, Sendable {
  public var domain: String?
  public var execute: Bool?
  public var limit: String?
  public var maxBytes: String?
  public var project: String?
  public var projectId: String?
  public var projectRef: String?
  public var scope: String?
  public var traces: Bool?

  public init(domain: String? = nil, execute: Bool? = nil, limit: String? = nil, maxBytes: String? = nil, project: String? = nil, projectId: String? = nil, projectRef: String? = nil, scope: String? = nil, traces: Bool? = nil) {
    self.domain = domain
    self.execute = execute
    self.limit = limit
    self.maxBytes = maxBytes
    self.project = project
    self.projectId = projectId
    self.projectRef = projectRef
    self.scope = scope
    self.traces = traces
  }

  enum CodingKeys: String, CodingKey {
    case domain = "domain"
    case execute = "execute"
    case limit = "limit"
    case maxBytes = "maxBytes"
    case project = "project"
    case projectId = "projectId"
    case projectRef = "projectRef"
    case scope = "scope"
    case traces = "traces"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.domain {
      body["domain"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.maxBytes {
      body["maxBytes"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.projectId {
      body["projectId"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.projectRef {
      body["projectRef"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.traces {
      body["traces"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SyncPushReturn: Codable, Sendable {
  public var acked: Double
  public var attempted: Double
  public var errorCode: String?
  public var failed: Double
  public var linked: Bool
  public var sent: Double
  public var status: String
  public var trace: RaviJSON?

  public init(acked: Double, attempted: Double, errorCode: String? = nil, failed: Double, linked: Bool, sent: Double, status: String, trace: RaviJSON? = nil) {
    self.acked = acked
    self.attempted = attempted
    self.errorCode = errorCode
    self.failed = failed
    self.linked = linked
    self.sent = sent
    self.status = status
    self.trace = trace
  }

  enum CodingKeys: String, CodingKey {
    case acked = "acked"
    case attempted = "attempted"
    case errorCode = "errorCode"
    case failed = "failed"
    case linked = "linked"
    case sent = "sent"
    case status = "status"
    case trace = "trace"
  }
}

public struct SyncRetryOptions: Codable, Sendable {
  public var dead: Bool?
  public var id: String?

  public init(dead: Bool? = nil, id: String? = nil) {
    self.dead = dead
    self.id = id
  }

  enum CodingKeys: String, CodingKey {
    case dead = "dead"
    case id = "id"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.dead {
      body["dead"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.id {
      body["id"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct SyncRetryReturn: Codable, Sendable {
  public var retried: Double
  public var success: Bool

  public init(retried: Double, success: Bool) {
    self.retried = retried
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case retried = "retried"
    case success = "success"
  }
}

public struct SyncStatusReturn: Codable, Sendable {
  public var consoleUrl: RaviJSON
  public var cursors: [RaviJSON]
  public var inbox: RaviJSON
  public var installationId: RaviJSON
  public var lastDownload: RaviJSON
  public var lastError: RaviJSON
  public var lastUpload: RaviJSON
  public var linked: Bool
  public var outbox: RaviJSON
  public var runner: RaviJSON

  public init(consoleUrl: RaviJSON, cursors: [RaviJSON], inbox: RaviJSON, installationId: RaviJSON, lastDownload: RaviJSON, lastError: RaviJSON, lastUpload: RaviJSON, linked: Bool, outbox: RaviJSON, runner: RaviJSON) {
    self.consoleUrl = consoleUrl
    self.cursors = cursors
    self.inbox = inbox
    self.installationId = installationId
    self.lastDownload = lastDownload
    self.lastError = lastError
    self.lastUpload = lastUpload
    self.linked = linked
    self.outbox = outbox
    self.runner = runner
  }

  enum CodingKeys: String, CodingKey {
    case consoleUrl = "consoleUrl"
    case cursors = "cursors"
    case inbox = "inbox"
    case installationId = "installationId"
    case lastDownload = "lastDownload"
    case lastError = "lastError"
    case lastUpload = "lastUpload"
    case linked = "linked"
    case outbox = "outbox"
    case runner = "runner"
  }
}

public struct TagRulesEvaluateOptions: Codable, Sendable {
  public var apply: Bool?
  public var file: String?
  public var target: String?

  public init(apply: Bool? = nil, file: String? = nil, target: String? = nil) {
    self.apply = apply
    self.file = file
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case apply = "apply"
    case file = "file"
    case target = "target"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.apply {
      body["apply"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.file {
      body["file"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.target {
      body["target"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TagRulesEvaluateReturn: Codable, Sendable {
  public var apply: Bool
  public var outcomes: [[String: RaviJSON]]
  public var ruleId: String
  public var target: [String: RaviJSON]
  public var traces: [[String: RaviJSON]]

  public init(apply: Bool, outcomes: [[String: RaviJSON]], ruleId: String, target: [String: RaviJSON], traces: [[String: RaviJSON]]) {
    self.apply = apply
    self.outcomes = outcomes
    self.ruleId = ruleId
    self.target = target
    self.traces = traces
  }

  enum CodingKeys: String, CodingKey {
    case apply = "apply"
    case outcomes = "outcomes"
    case ruleId = "ruleId"
    case target = "target"
    case traces = "traces"
  }
}

public struct TagRulesExplainOptions: Codable, Sendable {
  public var target: String?

  public init(target: String? = nil) {
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case target = "target"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.target {
      body["target"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TagRulesExplainReturn: Codable, Sendable {
  public var loaded: [String: RaviJSON]
  public var outcomes: [[String: RaviJSON]]
  public var rules: [String: RaviJSON]
  public var target: [String: RaviJSON]

  public init(loaded: [String: RaviJSON], outcomes: [[String: RaviJSON]], rules: [String: RaviJSON], target: [String: RaviJSON]) {
    self.loaded = loaded
    self.outcomes = outcomes
    self.rules = rules
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case loaded = "loaded"
    case outcomes = "outcomes"
    case rules = "rules"
    case target = "target"
  }
}

public struct TagRulesListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TagRulesListReturn: Codable, Sendable {
  public var errors: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var rules: [[String: RaviJSON]]

  public init(errors: [[String: RaviJSON]], pagination: RaviJSON, rules: [[String: RaviJSON]]) {
    self.errors = errors
    self.pagination = pagination
    self.rules = rules
  }

  enum CodingKeys: String, CodingKey {
    case errors = "errors"
    case pagination = "pagination"
    case rules = "rules"
  }
}

public struct TagRulesShowReturn: Codable, Sendable {
  public var rule: [String: RaviJSON]
  public var source: String?

  public init(rule: [String: RaviJSON], source: String? = nil) {
    self.rule = rule
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case rule = "rule"
    case source = "source"
  }
}

public struct TagRulesTickOptions: Codable, Sendable {
  public var apply: Bool?
  public var limit: String?

  public init(apply: Bool? = nil, limit: String? = nil) {
    self.apply = apply
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case apply = "apply"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.apply {
      body["apply"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TagRulesTickReturn: Codable, Sendable {
  public var appliedActions: Double
  public var contacts: [[String: RaviJSON]]
  public var contactsProcessed: Double
  public var loadErrors: [[String: RaviJSON]]
  public var matched: Double
  public var rulesLoaded: Double

  public init(appliedActions: Double, contacts: [[String: RaviJSON]], contactsProcessed: Double, loadErrors: [[String: RaviJSON]], matched: Double, rulesLoaded: Double) {
    self.appliedActions = appliedActions
    self.contacts = contacts
    self.contactsProcessed = contactsProcessed
    self.loadErrors = loadErrors
    self.matched = matched
    self.rulesLoaded = rulesLoaded
  }

  enum CodingKeys: String, CodingKey {
    case appliedActions = "appliedActions"
    case contacts = "contacts"
    case contactsProcessed = "contactsProcessed"
    case loadErrors = "loadErrors"
    case matched = "matched"
    case rulesLoaded = "rulesLoaded"
  }
}

public struct TagRulesValidateReturn: Codable, Sendable {
  public var errors: [[String: RaviJSON]]
  public var ruleCount: Double
  public var status: String

  public init(errors: [[String: RaviJSON]], ruleCount: Double, status: String) {
    self.errors = errors
    self.ruleCount = ruleCount
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case errors = "errors"
    case ruleCount = "ruleCount"
    case status = "status"
  }
}

public struct TagsAttachOptions: Codable, Sendable {
  public var agent: String?
  public var artifact: String?
  public var callProfile: String?
  public var callRequest: String?
  public var callTool: String?
  public var callVoiceAgent: String?
  public var chat: String?
  public var command: String?
  public var contact: String?
  public var cronJob: String?
  public var devinSession: String?
  public var hook: String?
  public var insight: String?
  public var instance: String?
  public var meta: String?
  public var profile: String?
  public var project: String?
  public var route: String?
  public var session: String?
  public var skill: String?
  public var skillGateRule: String?
  public var source: String?
  public var target: String?
  public var task: String?
  public var taskAutomation: String?
  public var trigger: String?
  public var workflowNode: String?
  public var workflowRun: String?
  public var workflowSpec: String?

  public init(agent: String? = nil, artifact: String? = nil, callProfile: String? = nil, callRequest: String? = nil, callTool: String? = nil, callVoiceAgent: String? = nil, chat: String? = nil, command: String? = nil, contact: String? = nil, cronJob: String? = nil, devinSession: String? = nil, hook: String? = nil, insight: String? = nil, instance: String? = nil, meta: String? = nil, profile: String? = nil, project: String? = nil, route: String? = nil, session: String? = nil, skill: String? = nil, skillGateRule: String? = nil, source: String? = nil, target: String? = nil, task: String? = nil, taskAutomation: String? = nil, trigger: String? = nil, workflowNode: String? = nil, workflowRun: String? = nil, workflowSpec: String? = nil) {
    self.agent = agent
    self.artifact = artifact
    self.callProfile = callProfile
    self.callRequest = callRequest
    self.callTool = callTool
    self.callVoiceAgent = callVoiceAgent
    self.chat = chat
    self.command = command
    self.contact = contact
    self.cronJob = cronJob
    self.devinSession = devinSession
    self.hook = hook
    self.insight = insight
    self.instance = instance
    self.meta = meta
    self.profile = profile
    self.project = project
    self.route = route
    self.session = session
    self.skill = skill
    self.skillGateRule = skillGateRule
    self.source = source
    self.target = target
    self.task = task
    self.taskAutomation = taskAutomation
    self.trigger = trigger
    self.workflowNode = workflowNode
    self.workflowRun = workflowRun
    self.workflowSpec = workflowSpec
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case artifact = "artifact"
    case callProfile = "callProfile"
    case callRequest = "callRequest"
    case callTool = "callTool"
    case callVoiceAgent = "callVoiceAgent"
    case chat = "chat"
    case command = "command"
    case contact = "contact"
    case cronJob = "cronJob"
    case devinSession = "devinSession"
    case hook = "hook"
    case insight = "insight"
    case instance = "instance"
    case meta = "meta"
    case profile = "profile"
    case project = "project"
    case route = "route"
    case session = "session"
    case skill = "skill"
    case skillGateRule = "skillGateRule"
    case source = "source"
    case target = "target"
    case task = "task"
    case taskAutomation = "taskAutomation"
    case trigger = "trigger"
    case workflowNode = "workflowNode"
    case workflowRun = "workflowRun"
    case workflowSpec = "workflowSpec"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.artifact {
      body["artifact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callProfile {
      body["callProfile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callRequest {
      body["callRequest"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callTool {
      body["callTool"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callVoiceAgent {
      body["callVoiceAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.chat {
      body["chat"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.command {
      body["command"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cronJob {
      body["cronJob"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.devinSession {
      body["devinSession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.hook {
      body["hook"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.insight {
      body["insight"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.meta {
      body["meta"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.route {
      body["route"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skill {
      body["skill"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skillGateRule {
      body["skillGateRule"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.target {
      body["target"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.taskAutomation {
      body["taskAutomation"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.trigger {
      body["trigger"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowNode {
      body["workflowNode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowRun {
      body["workflowRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowSpec {
      body["workflowSpec"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TagsAttachReturn: Codable, Sendable {
  public var behaviorConsumers: [[String: RaviJSON]]?
  public var binding: [String: RaviJSON]?
  public var changedCount: Double
  public var status: String
  public var tag: [String: RaviJSON]?
  public var target: [String: RaviJSON]

  public init(behaviorConsumers: [[String: RaviJSON]]? = nil, binding: [String: RaviJSON]? = nil, changedCount: Double, status: String, tag: [String: RaviJSON]? = nil, target: [String: RaviJSON]) {
    self.behaviorConsumers = behaviorConsumers
    self.binding = binding
    self.changedCount = changedCount
    self.status = status
    self.tag = tag
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case behaviorConsumers = "behaviorConsumers"
    case binding = "binding"
    case changedCount = "changedCount"
    case status = "status"
    case tag = "tag"
    case target = "target"
  }
}

public struct TagsCreateOptions: Codable, Sendable {
  public var description: String?
  public var kind: String?
  public var label: String?
  public var meta: String?
  public var source: String?

  public init(description: String? = nil, kind: String? = nil, label: String? = nil, meta: String? = nil, source: String? = nil) {
    self.description = description
    self.kind = kind
    self.label = label
    self.meta = meta
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case description = "description"
    case kind = "kind"
    case label = "label"
    case meta = "meta"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.meta {
      body["meta"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TagsCreateReturn: Codable, Sendable {
  public var behaviorConsumers: [[String: RaviJSON]]?
  public var binding: [String: RaviJSON]?
  public var changedCount: Double
  public var status: String
  public var tag: [String: RaviJSON]?
  public var target: [String: RaviJSON]

  public init(behaviorConsumers: [[String: RaviJSON]]? = nil, binding: [String: RaviJSON]? = nil, changedCount: Double, status: String, tag: [String: RaviJSON]? = nil, target: [String: RaviJSON]) {
    self.behaviorConsumers = behaviorConsumers
    self.binding = binding
    self.changedCount = changedCount
    self.status = status
    self.tag = tag
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case behaviorConsumers = "behaviorConsumers"
    case binding = "binding"
    case changedCount = "changedCount"
    case status = "status"
    case tag = "tag"
    case target = "target"
  }
}

public struct TagsDetachOptions: Codable, Sendable {
  public var agent: String?
  public var artifact: String?
  public var callProfile: String?
  public var callRequest: String?
  public var callTool: String?
  public var callVoiceAgent: String?
  public var chat: String?
  public var command: String?
  public var contact: String?
  public var cronJob: String?
  public var devinSession: String?
  public var hook: String?
  public var insight: String?
  public var instance: String?
  public var profile: String?
  public var project: String?
  public var route: String?
  public var session: String?
  public var skill: String?
  public var skillGateRule: String?
  public var source: String?
  public var target: String?
  public var task: String?
  public var taskAutomation: String?
  public var trigger: String?
  public var workflowNode: String?
  public var workflowRun: String?
  public var workflowSpec: String?

  public init(agent: String? = nil, artifact: String? = nil, callProfile: String? = nil, callRequest: String? = nil, callTool: String? = nil, callVoiceAgent: String? = nil, chat: String? = nil, command: String? = nil, contact: String? = nil, cronJob: String? = nil, devinSession: String? = nil, hook: String? = nil, insight: String? = nil, instance: String? = nil, profile: String? = nil, project: String? = nil, route: String? = nil, session: String? = nil, skill: String? = nil, skillGateRule: String? = nil, source: String? = nil, target: String? = nil, task: String? = nil, taskAutomation: String? = nil, trigger: String? = nil, workflowNode: String? = nil, workflowRun: String? = nil, workflowSpec: String? = nil) {
    self.agent = agent
    self.artifact = artifact
    self.callProfile = callProfile
    self.callRequest = callRequest
    self.callTool = callTool
    self.callVoiceAgent = callVoiceAgent
    self.chat = chat
    self.command = command
    self.contact = contact
    self.cronJob = cronJob
    self.devinSession = devinSession
    self.hook = hook
    self.insight = insight
    self.instance = instance
    self.profile = profile
    self.project = project
    self.route = route
    self.session = session
    self.skill = skill
    self.skillGateRule = skillGateRule
    self.source = source
    self.target = target
    self.task = task
    self.taskAutomation = taskAutomation
    self.trigger = trigger
    self.workflowNode = workflowNode
    self.workflowRun = workflowRun
    self.workflowSpec = workflowSpec
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case artifact = "artifact"
    case callProfile = "callProfile"
    case callRequest = "callRequest"
    case callTool = "callTool"
    case callVoiceAgent = "callVoiceAgent"
    case chat = "chat"
    case command = "command"
    case contact = "contact"
    case cronJob = "cronJob"
    case devinSession = "devinSession"
    case hook = "hook"
    case insight = "insight"
    case instance = "instance"
    case profile = "profile"
    case project = "project"
    case route = "route"
    case session = "session"
    case skill = "skill"
    case skillGateRule = "skillGateRule"
    case source = "source"
    case target = "target"
    case task = "task"
    case taskAutomation = "taskAutomation"
    case trigger = "trigger"
    case workflowNode = "workflowNode"
    case workflowRun = "workflowRun"
    case workflowSpec = "workflowSpec"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.artifact {
      body["artifact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callProfile {
      body["callProfile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callRequest {
      body["callRequest"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callTool {
      body["callTool"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callVoiceAgent {
      body["callVoiceAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.chat {
      body["chat"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.command {
      body["command"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cronJob {
      body["cronJob"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.devinSession {
      body["devinSession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.hook {
      body["hook"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.insight {
      body["insight"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.route {
      body["route"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skill {
      body["skill"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skillGateRule {
      body["skillGateRule"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.target {
      body["target"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.taskAutomation {
      body["taskAutomation"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.trigger {
      body["trigger"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowNode {
      body["workflowNode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowRun {
      body["workflowRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowSpec {
      body["workflowSpec"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TagsDetachReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String
  public var target: [String: RaviJSON]

  public init(changedCount: Double, status: String, target: [String: RaviJSON]) {
    self.changedCount = changedCount
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
  }
}

public struct TagsListOptions: Codable, Sendable {
  public var cursor: String?
  public var fields: String?
  public var kind: String?
  public var limit: String?
  public var order: String?
  public var query: String?
  public var sort: String?
  public var source: String?

  public init(cursor: String? = nil, fields: String? = nil, kind: String? = nil, limit: String? = nil, order: String? = nil, query: String? = nil, sort: String? = nil, source: String? = nil) {
    self.cursor = cursor
    self.fields = fields
    self.kind = kind
    self.limit = limit
    self.order = order
    self.query = query
    self.sort = sort
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case cursor = "cursor"
    case fields = "fields"
    case kind = "kind"
    case limit = "limit"
    case order = "order"
    case query = "query"
    case sort = "sort"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.order {
      body["order"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.query {
      body["query"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sort {
      body["sort"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TagsListReturn: Codable, Sendable {
  public var filters: [String: RaviJSON]
  public var items: [[String: RaviJSON]]
  public var page: RaviJSON
  public var tags: [[String: RaviJSON]]
  public var total: Double

  public init(filters: [String: RaviJSON], items: [[String: RaviJSON]], page: RaviJSON, tags: [[String: RaviJSON]], total: Double) {
    self.filters = filters
    self.items = items
    self.page = page
    self.tags = tags
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case filters = "filters"
    case items = "items"
    case page = "page"
    case tags = "tags"
    case total = "total"
  }
}

public struct TagsSearchOptions: Codable, Sendable {
  public var agent: String?
  public var artifact: String?
  public var callProfile: String?
  public var callRequest: String?
  public var callTool: String?
  public var callVoiceAgent: String?
  public var chat: String?
  public var command: String?
  public var contact: String?
  public var cronJob: String?
  public var cursor: String?
  public var devinSession: String?
  public var fields: String?
  public var hook: String?
  public var insight: String?
  public var instance: String?
  public var kind: String?
  public var limit: String?
  public var order: String?
  public var profile: String?
  public var project: String?
  public var route: String?
  public var session: String?
  public var skill: String?
  public var skillGateRule: String?
  public var sort: String?
  public var source: String?
  public var tag: String?
  public var target: String?
  public var task: String?
  public var taskAutomation: String?
  public var trigger: String?
  public var workflowNode: String?
  public var workflowRun: String?
  public var workflowSpec: String?

  public init(agent: String? = nil, artifact: String? = nil, callProfile: String? = nil, callRequest: String? = nil, callTool: String? = nil, callVoiceAgent: String? = nil, chat: String? = nil, command: String? = nil, contact: String? = nil, cronJob: String? = nil, cursor: String? = nil, devinSession: String? = nil, fields: String? = nil, hook: String? = nil, insight: String? = nil, instance: String? = nil, kind: String? = nil, limit: String? = nil, order: String? = nil, profile: String? = nil, project: String? = nil, route: String? = nil, session: String? = nil, skill: String? = nil, skillGateRule: String? = nil, sort: String? = nil, source: String? = nil, tag: String? = nil, target: String? = nil, task: String? = nil, taskAutomation: String? = nil, trigger: String? = nil, workflowNode: String? = nil, workflowRun: String? = nil, workflowSpec: String? = nil) {
    self.agent = agent
    self.artifact = artifact
    self.callProfile = callProfile
    self.callRequest = callRequest
    self.callTool = callTool
    self.callVoiceAgent = callVoiceAgent
    self.chat = chat
    self.command = command
    self.contact = contact
    self.cronJob = cronJob
    self.cursor = cursor
    self.devinSession = devinSession
    self.fields = fields
    self.hook = hook
    self.insight = insight
    self.instance = instance
    self.kind = kind
    self.limit = limit
    self.order = order
    self.profile = profile
    self.project = project
    self.route = route
    self.session = session
    self.skill = skill
    self.skillGateRule = skillGateRule
    self.sort = sort
    self.source = source
    self.tag = tag
    self.target = target
    self.task = task
    self.taskAutomation = taskAutomation
    self.trigger = trigger
    self.workflowNode = workflowNode
    self.workflowRun = workflowRun
    self.workflowSpec = workflowSpec
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case artifact = "artifact"
    case callProfile = "callProfile"
    case callRequest = "callRequest"
    case callTool = "callTool"
    case callVoiceAgent = "callVoiceAgent"
    case chat = "chat"
    case command = "command"
    case contact = "contact"
    case cronJob = "cronJob"
    case cursor = "cursor"
    case devinSession = "devinSession"
    case fields = "fields"
    case hook = "hook"
    case insight = "insight"
    case instance = "instance"
    case kind = "kind"
    case limit = "limit"
    case order = "order"
    case profile = "profile"
    case project = "project"
    case route = "route"
    case session = "session"
    case skill = "skill"
    case skillGateRule = "skillGateRule"
    case sort = "sort"
    case source = "source"
    case tag = "tag"
    case target = "target"
    case task = "task"
    case taskAutomation = "taskAutomation"
    case trigger = "trigger"
    case workflowNode = "workflowNode"
    case workflowRun = "workflowRun"
    case workflowSpec = "workflowSpec"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.artifact {
      body["artifact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callProfile {
      body["callProfile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callRequest {
      body["callRequest"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callTool {
      body["callTool"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.callVoiceAgent {
      body["callVoiceAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.chat {
      body["chat"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.command {
      body["command"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.contact {
      body["contact"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cronJob {
      body["cronJob"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.devinSession {
      body["devinSession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.hook {
      body["hook"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.insight {
      body["insight"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instance {
      body["instance"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.kind {
      body["kind"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.order {
      body["order"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.route {
      body["route"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skill {
      body["skill"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skillGateRule {
      body["skillGateRule"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sort {
      body["sort"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.target {
      body["target"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.task {
      body["task"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.taskAutomation {
      body["taskAutomation"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.trigger {
      body["trigger"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowNode {
      body["workflowNode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowRun {
      body["workflowRun"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.workflowSpec {
      body["workflowSpec"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TagsSearchReturn: Codable, Sendable {
  public var behaviorConsumers: [[String: RaviJSON]]
  public var bindings: [[String: RaviJSON]]
  public var filters: [String: RaviJSON]
  public var items: [[String: RaviJSON]]
  public var page: RaviJSON
  public var total: Double

  public init(behaviorConsumers: [[String: RaviJSON]], bindings: [[String: RaviJSON]], filters: [String: RaviJSON], items: [[String: RaviJSON]], page: RaviJSON, total: Double) {
    self.behaviorConsumers = behaviorConsumers
    self.bindings = bindings
    self.filters = filters
    self.items = items
    self.page = page
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case behaviorConsumers = "behaviorConsumers"
    case bindings = "bindings"
    case filters = "filters"
    case items = "items"
    case page = "page"
    case total = "total"
  }
}

public struct TagsSetReturn: Codable, Sendable {
  public var behaviorConsumers: [[String: RaviJSON]]?
  public var binding: [String: RaviJSON]?
  public var changedCount: Double
  public var status: String
  public var tag: [String: RaviJSON]?
  public var target: [String: RaviJSON]

  public init(behaviorConsumers: [[String: RaviJSON]]? = nil, binding: [String: RaviJSON]? = nil, changedCount: Double, status: String, tag: [String: RaviJSON]? = nil, target: [String: RaviJSON]) {
    self.behaviorConsumers = behaviorConsumers
    self.binding = binding
    self.changedCount = changedCount
    self.status = status
    self.tag = tag
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case behaviorConsumers = "behaviorConsumers"
    case binding = "binding"
    case changedCount = "changedCount"
    case status = "status"
    case tag = "tag"
    case target = "target"
  }
}

public struct TagsShowReturn: Codable, Sendable {
  public var behaviorConsumers: [[String: RaviJSON]]
  public var bindings: [[String: RaviJSON]]
  public var tag: [String: RaviJSON]

  public init(behaviorConsumers: [[String: RaviJSON]], bindings: [[String: RaviJSON]], tag: [String: RaviJSON]) {
    self.behaviorConsumers = behaviorConsumers
    self.bindings = bindings
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case behaviorConsumers = "behaviorConsumers"
    case bindings = "bindings"
    case tag = "tag"
  }
}

public struct TasksArchiveOptions: Codable, Sendable {
  public var reason: String?

  public init(reason: String? = nil) {
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksArchiveReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(event: [String: RaviJSON], task: [String: RaviJSON]) {
    self.event = event
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case task = "task"
  }
}

public struct TasksAutomationsAddOptions: Codable, Sendable {
  public var agent: String?
  public var checkpoint: String?
  public var detached: Bool?
  public var disabled: Bool?
  public var filter: String?
  public var freshCheckpoint: Bool?
  public var freshReportEvents: Bool?
  public var freshReportTo: Bool?
  public var freshWorktree: Bool?
  public var input: [String]?
  public var instructions: String?
  public var on: String?
  public var priority: String?
  public var profile: String?
  public var reportEvents: String?
  public var reportTo: String?
  public var session: String?
  public var title: String?

  public init(agent: String? = nil, checkpoint: String? = nil, detached: Bool? = nil, disabled: Bool? = nil, filter: String? = nil, freshCheckpoint: Bool? = nil, freshReportEvents: Bool? = nil, freshReportTo: Bool? = nil, freshWorktree: Bool? = nil, input: [String]? = nil, instructions: String? = nil, on: String? = nil, priority: String? = nil, profile: String? = nil, reportEvents: String? = nil, reportTo: String? = nil, session: String? = nil, title: String? = nil) {
    self.agent = agent
    self.checkpoint = checkpoint
    self.detached = detached
    self.disabled = disabled
    self.filter = filter
    self.freshCheckpoint = freshCheckpoint
    self.freshReportEvents = freshReportEvents
    self.freshReportTo = freshReportTo
    self.freshWorktree = freshWorktree
    self.input = input
    self.instructions = instructions
    self.on = on
    self.priority = priority
    self.profile = profile
    self.reportEvents = reportEvents
    self.reportTo = reportTo
    self.session = session
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case checkpoint = "checkpoint"
    case detached = "detached"
    case disabled = "disabled"
    case filter = "filter"
    case freshCheckpoint = "freshCheckpoint"
    case freshReportEvents = "freshReportEvents"
    case freshReportTo = "freshReportTo"
    case freshWorktree = "freshWorktree"
    case input = "input"
    case instructions = "instructions"
    case on = "on"
    case priority = "priority"
    case profile = "profile"
    case reportEvents = "reportEvents"
    case reportTo = "reportTo"
    case session = "session"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.checkpoint {
      body["checkpoint"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.detached {
      body["detached"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.disabled {
      body["disabled"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.filter {
      body["filter"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.freshCheckpoint {
      body["freshCheckpoint"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.freshReportEvents {
      body["freshReportEvents"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.freshReportTo {
      body["freshReportTo"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.freshWorktree {
      body["freshWorktree"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.input {
      body["input"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instructions {
      body["instructions"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.on {
      body["on"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reportEvents {
      body["reportEvents"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reportTo {
      body["reportTo"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksAutomationsAddReturn: Codable, Sendable {
  public var automation: [String: RaviJSON]
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON

  public init(automation: [String: RaviJSON], changedCount: Double, status: String, target: RaviJSON) {
    self.automation = automation
    self.changedCount = changedCount
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case automation = "automation"
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
  }
}

public struct TasksAutomationsDisableReturn: Codable, Sendable {
  public var automation: [String: RaviJSON]
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON

  public init(automation: [String: RaviJSON], changedCount: Double, status: String, target: RaviJSON) {
    self.automation = automation
    self.changedCount = changedCount
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case automation = "automation"
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
  }
}

public struct TasksAutomationsEnableReturn: Codable, Sendable {
  public var automation: [String: RaviJSON]
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON

  public init(automation: [String: RaviJSON], changedCount: Double, status: String, target: RaviJSON) {
    self.automation = automation
    self.changedCount = changedCount
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case automation = "automation"
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
  }
}

public struct TasksAutomationsListOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksAutomationsListReturn: Codable, Sendable {
  public var automations: [[String: RaviJSON]]
  public var filters: [String: RaviJSON]
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double

  public init(automations: [[String: RaviJSON]], filters: [String: RaviJSON], items: [[String: RaviJSON]], pagination: RaviJSON, total: Double) {
    self.automations = automations
    self.filters = filters
    self.items = items
    self.pagination = pagination
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case automations = "automations"
    case filters = "filters"
    case items = "items"
    case pagination = "pagination"
    case total = "total"
  }
}

public struct TasksAutomationsRmOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksAutomationsRmReturn: Codable, Sendable {
  public var automation: [String: RaviJSON]
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON

  public init(automation: [String: RaviJSON], changedCount: Double, status: String, target: RaviJSON) {
    self.automation = automation
    self.changedCount = changedCount
    self.status = status
    self.target = target
  }

  enum CodingKeys: String, CodingKey {
    case automation = "automation"
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
  }
}

public struct TasksAutomationsShowReturn: Codable, Sendable {
  public var automation: [String: RaviJSON]
  public var runs: [[String: RaviJSON]]

  public init(automation: [String: RaviJSON], runs: [[String: RaviJSON]]) {
    self.automation = automation
    self.runs = runs
  }

  enum CodingKeys: String, CodingKey {
    case automation = "automation"
    case runs = "runs"
  }
}

public struct TasksBlockOptions: Codable, Sendable {
  public var reason: String?

  public init(reason: String? = nil) {
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksBlockReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(event: [String: RaviJSON], task: [String: RaviJSON]) {
    self.event = event
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case task = "task"
  }
}

public struct TasksCommentReturn: Codable, Sendable {
  public var comment: [String: RaviJSON]
  public var event: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(comment: [String: RaviJSON], event: [String: RaviJSON], task: [String: RaviJSON]) {
    self.comment = comment
    self.event = event
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case comment = "comment"
    case event = "event"
    case task = "task"
  }
}

public struct TasksCreateOptions: Codable, Sendable {
  public var agent: String?
  public var assignee: String?
  public var checkpoint: String?
  public var dependsOn: [String]?
  public var effort: String?
  public var input: [String]?
  public var instructions: String?
  public var model: String?
  public var parent: String?
  public var priority: String?
  public var profile: String?
  public var reportEvents: String?
  public var reportTo: String?
  public var session: String?
  public var tag: [String]?
  public var thinking: String?
  public var worktreeBranch: String?
  public var worktreeMode: String?
  public var worktreePath: String?

  public init(agent: String? = nil, assignee: String? = nil, checkpoint: String? = nil, dependsOn: [String]? = nil, effort: String? = nil, input: [String]? = nil, instructions: String? = nil, model: String? = nil, parent: String? = nil, priority: String? = nil, profile: String? = nil, reportEvents: String? = nil, reportTo: String? = nil, session: String? = nil, tag: [String]? = nil, thinking: String? = nil, worktreeBranch: String? = nil, worktreeMode: String? = nil, worktreePath: String? = nil) {
    self.agent = agent
    self.assignee = assignee
    self.checkpoint = checkpoint
    self.dependsOn = dependsOn
    self.effort = effort
    self.input = input
    self.instructions = instructions
    self.model = model
    self.parent = parent
    self.priority = priority
    self.profile = profile
    self.reportEvents = reportEvents
    self.reportTo = reportTo
    self.session = session
    self.tag = tag
    self.thinking = thinking
    self.worktreeBranch = worktreeBranch
    self.worktreeMode = worktreeMode
    self.worktreePath = worktreePath
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case assignee = "assignee"
    case checkpoint = "checkpoint"
    case dependsOn = "dependsOn"
    case effort = "effort"
    case input = "input"
    case instructions = "instructions"
    case model = "model"
    case parent = "parent"
    case priority = "priority"
    case profile = "profile"
    case reportEvents = "reportEvents"
    case reportTo = "reportTo"
    case session = "session"
    case tag = "tag"
    case thinking = "thinking"
    case worktreeBranch = "worktreeBranch"
    case worktreeMode = "worktreeMode"
    case worktreePath = "worktreePath"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.assignee {
      body["assignee"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.checkpoint {
      body["checkpoint"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.dependsOn {
      body["dependsOn"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.effort {
      body["effort"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.input {
      body["input"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instructions {
      body["instructions"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.parent {
      body["parent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reportEvents {
      body["reportEvents"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reportTo {
      body["reportTo"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.thinking {
      body["thinking"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.worktreeBranch {
      body["worktreeBranch"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.worktreeMode {
      body["worktreeMode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.worktreePath {
      body["worktreePath"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksCreateReturn: Codable, Sendable {
  public var dependencies: [[String: RaviJSON]]
  public var dependents: [[String: RaviJSON]]
  public var event: [String: RaviJSON]
  public var launchPlan: RaviJSON
  public var parentTaskId: RaviJSON
  public var readiness: [String: RaviJSON]
  public var relatedEvents: [[String: RaviJSON]]
  public var task: [String: RaviJSON]
  public var taskProfile: [String: RaviJSON]

  public init(dependencies: [[String: RaviJSON]], dependents: [[String: RaviJSON]], event: [String: RaviJSON], launchPlan: RaviJSON, parentTaskId: RaviJSON, readiness: [String: RaviJSON], relatedEvents: [[String: RaviJSON]], task: [String: RaviJSON], taskProfile: [String: RaviJSON]) {
    self.dependencies = dependencies
    self.dependents = dependents
    self.event = event
    self.launchPlan = launchPlan
    self.parentTaskId = parentTaskId
    self.readiness = readiness
    self.relatedEvents = relatedEvents
    self.task = task
    self.taskProfile = taskProfile
  }

  enum CodingKeys: String, CodingKey {
    case dependencies = "dependencies"
    case dependents = "dependents"
    case event = "event"
    case launchPlan = "launchPlan"
    case parentTaskId = "parentTaskId"
    case readiness = "readiness"
    case relatedEvents = "relatedEvents"
    case task = "task"
    case taskProfile = "taskProfile"
  }
}

public struct TasksDepsAddReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(event: [String: RaviJSON], task: [String: RaviJSON]) {
    self.event = event
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case task = "task"
  }
}

public struct TasksDepsLsOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?

  public init(limit: String? = nil, offset: String? = nil) {
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksDepsLsReturn: Codable, Sendable {
  public var dependencies: [[String: RaviJSON]]
  public var dependents: [[String: RaviJSON]]
  public var items: [[String: RaviJSON]]
  public var launchPlan: RaviJSON
  public var pagination: RaviJSON
  public var readiness: [String: RaviJSON]
  public var taskId: String
  public var total: Double

  public init(dependencies: [[String: RaviJSON]], dependents: [[String: RaviJSON]], items: [[String: RaviJSON]], launchPlan: RaviJSON, pagination: RaviJSON, readiness: [String: RaviJSON], taskId: String, total: Double) {
    self.dependencies = dependencies
    self.dependents = dependents
    self.items = items
    self.launchPlan = launchPlan
    self.pagination = pagination
    self.readiness = readiness
    self.taskId = taskId
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case dependencies = "dependencies"
    case dependents = "dependents"
    case items = "items"
    case launchPlan = "launchPlan"
    case pagination = "pagination"
    case readiness = "readiness"
    case taskId = "taskId"
    case total = "total"
  }
}

public struct TasksDepsRmOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksDepsRmReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(event: [String: RaviJSON], task: [String: RaviJSON]) {
    self.event = event
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case task = "task"
  }
}

public struct TasksDispatchOptions: Codable, Sendable {
  public var actorSession: String?
  public var agent: String?
  public var checkpoint: String?
  public var effort: String?
  public var execute: Bool?
  public var model: String?
  public var reportEvents: String?
  public var reportTo: String?
  public var session: String?
  public var thinking: String?

  public init(actorSession: String? = nil, agent: String? = nil, checkpoint: String? = nil, effort: String? = nil, execute: Bool? = nil, model: String? = nil, reportEvents: String? = nil, reportTo: String? = nil, session: String? = nil, thinking: String? = nil) {
    self.actorSession = actorSession
    self.agent = agent
    self.checkpoint = checkpoint
    self.effort = effort
    self.execute = execute
    self.model = model
    self.reportEvents = reportEvents
    self.reportTo = reportTo
    self.session = session
    self.thinking = thinking
  }

  enum CodingKeys: String, CodingKey {
    case actorSession = "actorSession"
    case agent = "agent"
    case checkpoint = "checkpoint"
    case effort = "effort"
    case execute = "execute"
    case model = "model"
    case reportEvents = "reportEvents"
    case reportTo = "reportTo"
    case session = "session"
    case thinking = "thinking"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.actorSession {
      body["actorSession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.checkpoint {
      body["checkpoint"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.effort {
      body["effort"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.model {
      body["model"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reportEvents {
      body["reportEvents"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.reportTo {
      body["reportTo"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.thinking {
      body["thinking"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksDispatchReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var mode: String
  public var readiness: [String: RaviJSON]?
  public var task: [String: RaviJSON]

  public init(event: [String: RaviJSON], mode: String, readiness: [String: RaviJSON]? = nil, task: [String: RaviJSON]) {
    self.event = event
    self.mode = mode
    self.readiness = readiness
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case mode = "mode"
    case readiness = "readiness"
    case task = "task"
  }
}

public struct TasksDoneOptions: Codable, Sendable {
  public var summary: String?

  public init(summary: String? = nil) {
    self.summary = summary
  }

  enum CodingKeys: String, CodingKey {
    case summary = "summary"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.summary {
      body["summary"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksDoneReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(event: [String: RaviJSON], task: [String: RaviJSON]) {
    self.event = event
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case task = "task"
  }
}

public struct TasksFailOptions: Codable, Sendable {
  public var reason: String?

  public init(reason: String? = nil) {
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksFailReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(event: [String: RaviJSON], task: [String: RaviJSON]) {
    self.event = event
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case task = "task"
  }
}

public struct TasksListOptions: Codable, Sendable {
  public var agent: String?
  public var all: Bool?
  public var allTime: Bool?
  public var archived: Bool?
  public var cursor: String?
  public var fields: String?
  public var last: String?
  public var limit: String?
  public var mine: Bool?
  public var order: String?
  public var parent: String?
  public var profile: String?
  public var root: String?
  public var roots: Bool?
  public var session: String?
  public var since: String?
  public var sort: String?
  public var status: String?
  public var tag: String?
  public var text: String?
  public var until: String?

  public init(agent: String? = nil, all: Bool? = nil, allTime: Bool? = nil, archived: Bool? = nil, cursor: String? = nil, fields: String? = nil, last: String? = nil, limit: String? = nil, mine: Bool? = nil, order: String? = nil, parent: String? = nil, profile: String? = nil, root: String? = nil, roots: Bool? = nil, session: String? = nil, since: String? = nil, sort: String? = nil, status: String? = nil, tag: String? = nil, text: String? = nil, until: String? = nil) {
    self.agent = agent
    self.all = all
    self.allTime = allTime
    self.archived = archived
    self.cursor = cursor
    self.fields = fields
    self.last = last
    self.limit = limit
    self.mine = mine
    self.order = order
    self.parent = parent
    self.profile = profile
    self.root = root
    self.roots = roots
    self.session = session
    self.since = since
    self.sort = sort
    self.status = status
    self.tag = tag
    self.text = text
    self.until = until
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case all = "all"
    case allTime = "allTime"
    case archived = "archived"
    case cursor = "cursor"
    case fields = "fields"
    case last = "last"
    case limit = "limit"
    case mine = "mine"
    case order = "order"
    case parent = "parent"
    case profile = "profile"
    case root = "root"
    case roots = "roots"
    case session = "session"
    case since = "since"
    case sort = "sort"
    case status = "status"
    case tag = "tag"
    case text = "text"
    case until = "until"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.all {
      body["all"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.allTime {
      body["allTime"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.archived {
      body["archived"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cursor {
      body["cursor"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.last {
      body["last"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mine {
      body["mine"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.order {
      body["order"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.parent {
      body["parent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.root {
      body["root"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.roots {
      body["roots"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.since {
      body["since"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.sort {
      body["sort"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.text {
      body["text"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.until {
      body["until"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksListReturn: Codable, Sendable {
  public var archiveMode: String
  public var filters: [String: RaviJSON]
  public var items: [[String: RaviJSON]]
  public var limit: RaviJSON
  public var page: [String: RaviJSON]
  public var tasks: [[String: RaviJSON]]
  public var total: Double

  public init(archiveMode: String, filters: [String: RaviJSON], items: [[String: RaviJSON]], limit: RaviJSON, page: [String: RaviJSON], tasks: [[String: RaviJSON]], total: Double) {
    self.archiveMode = archiveMode
    self.filters = filters
    self.items = items
    self.limit = limit
    self.page = page
    self.tasks = tasks
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case archiveMode = "archiveMode"
    case filters = "filters"
    case items = "items"
    case limit = "limit"
    case page = "page"
    case tasks = "tasks"
    case total = "total"
  }
}

public struct TasksProfilesInitOptions: Codable, Sendable {
  public var preset: String?
  public var source: String?

  public init(preset: String? = nil, source: String? = nil) {
    self.preset = preset
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case preset = "preset"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.preset {
      body["preset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.source {
      body["source"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksProfilesInitReturn: Codable, Sendable {
  public var manifestPath: String
  public var profileDir: String
  public var sourceKind: String

  public init(manifestPath: String, profileDir: String, sourceKind: String) {
    self.manifestPath = manifestPath
    self.profileDir = profileDir
    self.sourceKind = sourceKind
  }

  enum CodingKeys: String, CodingKey {
    case manifestPath = "manifestPath"
    case profileDir = "profileDir"
    case sourceKind = "sourceKind"
  }
}

public struct TasksProfilesListOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?

  public init(limit: String? = nil, offset: String? = nil) {
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksProfilesListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var profiles: [[String: RaviJSON]]
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, profiles: [[String: RaviJSON]], total: Double) {
    self.items = items
    self.pagination = pagination
    self.profiles = profiles
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case profiles = "profiles"
    case total = "total"
  }
}

public struct TasksProfilesPreviewOptions: Codable, Sendable {
  public var agent: String?
  public var input: [String]?
  public var instructions: String?
  public var session: String?
  public var title: String?
  public var worktreeBranch: String?
  public var worktreeMode: String?
  public var worktreePath: String?

  public init(agent: String? = nil, input: [String]? = nil, instructions: String? = nil, session: String? = nil, title: String? = nil, worktreeBranch: String? = nil, worktreeMode: String? = nil, worktreePath: String? = nil) {
    self.agent = agent
    self.input = input
    self.instructions = instructions
    self.session = session
    self.title = title
    self.worktreeBranch = worktreeBranch
    self.worktreeMode = worktreeMode
    self.worktreePath = worktreePath
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case input = "input"
    case instructions = "instructions"
    case session = "session"
    case title = "title"
    case worktreeBranch = "worktreeBranch"
    case worktreeMode = "worktreeMode"
    case worktreePath = "worktreePath"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.input {
      body["input"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instructions {
      body["instructions"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.worktreeBranch {
      body["worktreeBranch"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.worktreeMode {
      body["worktreeMode"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.worktreePath {
      body["worktreePath"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksProfilesPreviewReturn: Codable, Sendable {
  public var profile: [String: RaviJSON]
  public var rendered: [String: RaviJSON]

  public init(profile: [String: RaviJSON], rendered: [String: RaviJSON]) {
    self.profile = profile
    self.rendered = rendered
  }

  enum CodingKeys: String, CodingKey {
    case profile = "profile"
    case rendered = "rendered"
  }
}

public typealias TasksProfilesShowReturn = [String: RaviJSON]

public struct TasksProfilesValidateReturn: Codable, Sendable {
  public var results: [[String: RaviJSON]]
  public var valid: Bool

  public init(results: [[String: RaviJSON]], valid: Bool) {
    self.results = results
    self.valid = valid
  }

  enum CodingKeys: String, CodingKey {
    case results = "results"
    case valid = "valid"
  }
}

public struct TasksReportOptions: Codable, Sendable {
  public var message: String?
  public var progress: String?

  public init(message: String? = nil, progress: String? = nil) {
    self.message = message
    self.progress = progress
  }

  enum CodingKeys: String, CodingKey {
    case message = "message"
    case progress = "progress"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.progress {
      body["progress"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksReportReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(event: [String: RaviJSON], task: [String: RaviJSON]) {
    self.event = event
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case task = "task"
  }
}

public struct TasksShowOptions: Codable, Sendable {
  public var last: String?

  public init(last: String? = nil) {
    self.last = last
  }

  enum CodingKeys: String, CodingKey {
    case last = "last"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.last {
      body["last"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TasksShowReturn: Codable, Sendable {
  public var comments: [[String: RaviJSON]]
  public var dependencies: [[String: RaviJSON]]
  public var dependents: [[String: RaviJSON]]
  public var events: [[String: RaviJSON]]
  public var historyLimit: RaviJSON
  public var launchPlan: RaviJSON
  public var readiness: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(comments: [[String: RaviJSON]], dependencies: [[String: RaviJSON]], dependents: [[String: RaviJSON]], events: [[String: RaviJSON]], historyLimit: RaviJSON, launchPlan: RaviJSON, readiness: [String: RaviJSON], task: [String: RaviJSON]) {
    self.comments = comments
    self.dependencies = dependencies
    self.dependents = dependents
    self.events = events
    self.historyLimit = historyLimit
    self.launchPlan = launchPlan
    self.readiness = readiness
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case comments = "comments"
    case dependencies = "dependencies"
    case dependents = "dependents"
    case events = "events"
    case historyLimit = "historyLimit"
    case launchPlan = "launchPlan"
    case readiness = "readiness"
    case task = "task"
  }
}

public struct TasksUnarchiveReturn: Codable, Sendable {
  public var event: [String: RaviJSON]
  public var task: [String: RaviJSON]

  public init(event: [String: RaviJSON], task: [String: RaviJSON]) {
    self.event = event
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case task = "task"
  }
}

public struct ThreadsBriefOptions: Codable, Sendable {
  public var scope: String?

  public init(scope: String? = nil) {
    self.scope = scope
  }

  enum CodingKeys: String, CodingKey {
    case scope = "scope"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ThreadsBriefReturn: Codable, Sendable {
  public var action: String
  public var brief: [String: RaviJSON]
  public var thread: [String: RaviJSON]

  public init(action: String, brief: [String: RaviJSON], thread: [String: RaviJSON]) {
    self.action = action
    self.brief = brief
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case brief = "brief"
    case thread = "thread"
  }
}

public struct ThreadsCloseOptions: Codable, Sendable {
  public var reason: String?
  public var scope: String?

  public init(reason: String? = nil, scope: String? = nil) {
    self.reason = reason
    self.scope = scope
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
    case scope = "scope"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.reason {
      body["reason"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ThreadsCloseReturn: Codable, Sendable {
  public var action: String
  public var thread: [String: RaviJSON]

  public init(action: String, thread: [String: RaviJSON]) {
    self.action = action
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case thread = "thread"
  }
}

public struct ThreadsCommentOptions: Codable, Sendable {
  public var scope: String?
  public var visibility: String?

  public init(scope: String? = nil, visibility: String? = nil) {
    self.scope = scope
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case scope = "scope"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ThreadsCommentReturn: Codable, Sendable {
  public var action: String
  public var entry: [String: RaviJSON]
  public var thread: [String: RaviJSON]

  public init(action: String, entry: [String: RaviJSON], thread: [String: RaviJSON]) {
    self.action = action
    self.entry = entry
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case entry = "entry"
    case thread = "thread"
  }
}

public struct ThreadsCreateOptions: Codable, Sendable {
  public var defaultAgent: String?
  public var owner: String?
  public var scope: String?
  public var status: String?
  public var summary: String?
  public var title: String?

  public init(defaultAgent: String? = nil, owner: String? = nil, scope: String? = nil, status: String? = nil, summary: String? = nil, title: String? = nil) {
    self.defaultAgent = defaultAgent
    self.owner = owner
    self.scope = scope
    self.status = status
    self.summary = summary
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case defaultAgent = "defaultAgent"
    case owner = "owner"
    case scope = "scope"
    case status = "status"
    case summary = "summary"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.defaultAgent {
      body["defaultAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.summary {
      body["summary"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ThreadsCreateReturn: Codable, Sendable {
  public var action: String
  public var thread: [String: RaviJSON]

  public init(action: String, thread: [String: RaviJSON]) {
    self.action = action
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case thread = "thread"
  }
}

public struct ThreadsEntriesOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?
  public var scope: String?

  public init(limit: String? = nil, offset: String? = nil, scope: String? = nil) {
    self.limit = limit
    self.offset = offset
    self.scope = scope
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
    case scope = "scope"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ThreadsEntriesReturn: Codable, Sendable {
  public var action: String
  public var entries: [[String: RaviJSON]]
  public var thread: [String: RaviJSON]

  public init(action: String, entries: [[String: RaviJSON]], thread: [String: RaviJSON]) {
    self.action = action
    self.entries = entries
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case entries = "entries"
    case thread = "thread"
  }
}

public struct ThreadsLinkOptions: Codable, Sendable {
  public var label: String?
  public var role: String?
  public var scope: String?
  public var visibility: String?

  public init(label: String? = nil, role: String? = nil, scope: String? = nil, visibility: String? = nil) {
    self.label = label
    self.role = role
    self.scope = scope
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case label = "label"
    case role = "role"
    case scope = "scope"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.label {
      body["label"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.role {
      body["role"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ThreadsLinkReturn: Codable, Sendable {
  public var action: String
  public var link: [String: RaviJSON]
  public var thread: [String: RaviJSON]

  public init(action: String, link: [String: RaviJSON], thread: [String: RaviJSON]) {
    self.action = action
    self.link = link
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case link = "link"
    case thread = "thread"
  }
}

public struct ThreadsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var owner: String?
  public var scope: String?
  public var search: String?
  public var status: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, owner: String? = nil, scope: String? = nil, search: String? = nil, status: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.owner = owner
    self.scope = scope
    self.search = search
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case owner = "owner"
    case scope = "scope"
    case search = "search"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.owner {
      body["owner"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.search {
      body["search"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ThreadsListReturn: Codable, Sendable {
  public var action: String
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON

  public init(action: String, items: [[String: RaviJSON]], pagination: RaviJSON) {
    self.action = action
    self.items = items
    self.pagination = pagination
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case items = "items"
    case pagination = "pagination"
  }
}

public struct ThreadsNoteOptions: Codable, Sendable {
  public var scope: String?
  public var visibility: String?

  public init(scope: String? = nil, visibility: String? = nil) {
    self.scope = scope
    self.visibility = visibility
  }

  enum CodingKeys: String, CodingKey {
    case scope = "scope"
    case visibility = "visibility"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.visibility {
      body["visibility"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ThreadsNoteReturn: Codable, Sendable {
  public var action: String
  public var entry: [String: RaviJSON]
  public var thread: [String: RaviJSON]

  public init(action: String, entry: [String: RaviJSON], thread: [String: RaviJSON]) {
    self.action = action
    self.entry = entry
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case entry = "entry"
    case thread = "thread"
  }
}

public struct ThreadsShowOptions: Codable, Sendable {
  public var entries: String?
  public var scope: String?

  public init(entries: String? = nil, scope: String? = nil) {
    self.entries = entries
    self.scope = scope
  }

  enum CodingKeys: String, CodingKey {
    case entries = "entries"
    case scope = "scope"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.entries {
      body["entries"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.scope {
      body["scope"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ThreadsShowReturn: Codable, Sendable {
  public var action: String
  public var entries: [[String: RaviJSON]]
  public var links: [[String: RaviJSON]]
  public var thread: [String: RaviJSON]

  public init(action: String, entries: [[String: RaviJSON]], links: [[String: RaviJSON]], thread: [String: RaviJSON]) {
    self.action = action
    self.entries = entries
    self.links = links
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case action = "action"
    case entries = "entries"
    case links = "links"
    case thread = "thread"
  }
}

public struct ToolsInvokeReturn: Codable, Sendable {
  public var args: [String: RaviJSON]
  public var executed: Bool
  public var mode: String
  public var result: RaviJSON
  public var tool: RaviJSON

  public init(args: [String: RaviJSON], executed: Bool, mode: String, result: RaviJSON, tool: RaviJSON) {
    self.args = args
    self.executed = executed
    self.mode = mode
    self.result = result
    self.tool = tool
  }

  enum CodingKeys: String, CodingKey {
    case args = "args"
    case executed = "executed"
    case mode = "mode"
    case result = "result"
    case tool = "tool"
  }
}

public struct ToolsListOptions: Codable, Sendable {
  public var limit: String?
  public var offset: String?

  public init(limit: String? = nil, offset: String? = nil) {
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ToolsListReturn: Codable, Sendable {
  public var groups: [RaviJSON]
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var tools: [[String: RaviJSON]]
  public var total: Double

  public init(groups: [RaviJSON], items: [[String: RaviJSON]], pagination: RaviJSON, tools: [[String: RaviJSON]], total: Double) {
    self.groups = groups
    self.items = items
    self.pagination = pagination
    self.tools = tools
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case groups = "groups"
    case items = "items"
    case pagination = "pagination"
    case tools = "tools"
    case total = "total"
  }
}

public struct ToolsManifestReturn: Codable, Sendable {
  public var tools: [[String: RaviJSON]]
  public var total: Double

  public init(tools: [[String: RaviJSON]], total: Double) {
    self.tools = tools
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case tools = "tools"
    case total = "total"
  }
}

public struct ToolsSchemaReturn: Codable, Sendable {
  public var schema: [String: RaviJSON]

  public init(schema: [String: RaviJSON]) {
    self.schema = schema
  }

  enum CodingKeys: String, CodingKey {
    case schema = "schema"
  }
}

public struct ToolsSearchOptions: Codable, Sendable {
  public var limit: String?

  public init(limit: String? = nil) {
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct ToolsSearchReturn: Codable, Sendable {
  public var items: [RaviJSON]
  public var limit: Double
  public var query: String
  public var returned: Double
  public var total: Double

  public init(items: [RaviJSON], limit: Double, query: String, returned: Double, total: Double) {
    self.items = items
    self.limit = limit
    self.query = query
    self.returned = returned
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case limit = "limit"
    case query = "query"
    case returned = "returned"
    case total = "total"
  }
}

public struct ToolsShowReturn: Codable, Sendable {
  public var tool: [String: RaviJSON]

  public init(tool: [String: RaviJSON]) {
    self.tool = tool
  }

  enum CodingKeys: String, CodingKey {
    case tool = "tool"
  }
}

public struct ToolsTestReturn: Codable, Sendable {
  public var access: RaviJSON
  public var args: [String: RaviJSON]
  public var executed: Bool
  public var invokeCommand: String
  public var mode: String
  public var schema: RaviJSON
  public var tool: RaviJSON

  public init(access: RaviJSON, args: [String: RaviJSON], executed: Bool, invokeCommand: String, mode: String, schema: RaviJSON, tool: RaviJSON) {
    self.access = access
    self.args = args
    self.executed = executed
    self.invokeCommand = invokeCommand
    self.mode = mode
    self.schema = schema
    self.tool = tool
  }

  enum CodingKeys: String, CodingKey {
    case access = "access"
    case args = "args"
    case executed = "executed"
    case invokeCommand = "invokeCommand"
    case mode = "mode"
    case schema = "schema"
    case tool = "tool"
  }
}

public struct TranscribeFileOptions: Codable, Sendable {
  public var lang: String?

  public init(lang: String? = nil) {
    self.lang = lang
  }

  enum CodingKeys: String, CodingKey {
    case lang = "lang"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.lang {
      body["lang"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TranscribeFileReturn: Codable, Sendable {
  public var options: RaviJSON
  public var source: RaviJSON
  public var success: Bool
  public var transcription: RaviJSON

  public init(options: RaviJSON, source: RaviJSON, success: Bool, transcription: RaviJSON) {
    self.options = options
    self.source = source
    self.success = success
    self.transcription = transcription
  }

  enum CodingKeys: String, CodingKey {
    case options = "options"
    case source = "source"
    case success = "success"
    case transcription = "transcription"
  }
}

public struct TriggersAddOptions: Codable, Sendable {
  public var account: String?
  public var agent: String?
  public var cooldown: String?
  public var envFile: String?
  public var exec: String?
  public var filter: String?
  public var message: String?
  public var onError: String?
  public var replySession: String?
  public var session: String?
  public var shell: String?
  public var timeout: String?
  public var topic: String?

  public init(account: String? = nil, agent: String? = nil, cooldown: String? = nil, envFile: String? = nil, exec: String? = nil, filter: String? = nil, message: String? = nil, onError: String? = nil, replySession: String? = nil, session: String? = nil, shell: String? = nil, timeout: String? = nil, topic: String? = nil) {
    self.account = account
    self.agent = agent
    self.cooldown = cooldown
    self.envFile = envFile
    self.exec = exec
    self.filter = filter
    self.message = message
    self.onError = onError
    self.replySession = replySession
    self.session = session
    self.shell = shell
    self.timeout = timeout
    self.topic = topic
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case agent = "agent"
    case cooldown = "cooldown"
    case envFile = "envFile"
    case exec = "exec"
    case filter = "filter"
    case message = "message"
    case onError = "onError"
    case replySession = "replySession"
    case session = "session"
    case shell = "shell"
    case timeout = "timeout"
    case topic = "topic"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cooldown {
      body["cooldown"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.envFile {
      body["envFile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.exec {
      body["exec"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.filter {
      body["filter"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.onError {
      body["onError"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.replySession {
      body["replySession"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.shell {
      body["shell"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.timeout {
      body["timeout"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.topic {
      body["topic"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TriggersAddReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON
  public var trigger: RaviJSON

  public init(changedCount: Double, status: String, target: RaviJSON, trigger: RaviJSON) {
    self.changedCount = changedCount
    self.status = status
    self.target = target
    self.trigger = trigger
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
    case trigger = "trigger"
  }
}

public struct TriggersDisableReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON
  public var trigger: RaviJSON

  public init(changedCount: Double, status: String, target: RaviJSON, trigger: RaviJSON) {
    self.changedCount = changedCount
    self.status = status
    self.target = target
    self.trigger = trigger
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
    case trigger = "trigger"
  }
}

public struct TriggersEnableReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON
  public var trigger: RaviJSON

  public init(changedCount: Double, status: String, target: RaviJSON, trigger: RaviJSON) {
    self.changedCount = changedCount
    self.status = status
    self.target = target
    self.trigger = trigger
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
    case trigger = "trigger"
  }
}

public struct TriggersListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var tag: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, tag: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tag {
      body["tag"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TriggersListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double
  public var triggers: [[String: RaviJSON]]

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double, triggers: [[String: RaviJSON]]) {
    self.items = items
    self.pagination = pagination
    self.total = total
    self.triggers = triggers
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
    case triggers = "triggers"
  }
}

public struct TriggersRmOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TriggersRmReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON
  public var trigger: RaviJSON

  public init(changedCount: Double, status: String, target: RaviJSON, trigger: RaviJSON) {
    self.changedCount = changedCount
    self.status = status
    self.target = target
    self.trigger = trigger
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
    case trigger = "trigger"
  }
}

public struct TriggersSetReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON
  public var trigger: RaviJSON

  public init(changedCount: Double, status: String, target: RaviJSON, trigger: RaviJSON) {
    self.changedCount = changedCount
    self.status = status
    self.target = target
    self.trigger = trigger
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
    case trigger = "trigger"
  }
}

public struct TriggersShowReturn: Codable, Sendable {
  public var trigger: [String: RaviJSON]

  public init(trigger: [String: RaviJSON]) {
    self.trigger = trigger
  }

  enum CodingKeys: String, CodingKey {
    case trigger = "trigger"
  }
}

public struct TriggersTestOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct TriggersTestReturn: Codable, Sendable {
  public var changedCount: Double
  public var status: String
  public var target: RaviJSON
  public var trigger: RaviJSON

  public init(changedCount: Double, status: String, target: RaviJSON, trigger: RaviJSON) {
    self.changedCount = changedCount
    self.status = status
    self.target = target
    self.trigger = trigger
  }

  enum CodingKeys: String, CodingKey {
    case changedCount = "changedCount"
    case status = "status"
    case target = "target"
    case trigger = "trigger"
  }
}

public struct TriggersTopicsReturn: Codable, Sendable {
  public var topics: [[String: RaviJSON]]

  public init(topics: [[String: RaviJSON]]) {
    self.topics = topics
  }

  enum CodingKeys: String, CodingKey {
    case topics = "topics"
  }
}

public struct VideoAnalyzeOptions: Codable, Sendable {
  public var forceAnalyze: Bool?
  public var output: String?
  public var prompt: String?
  public var strategy: String?

  public init(forceAnalyze: Bool? = nil, output: String? = nil, prompt: String? = nil, strategy: String? = nil) {
    self.forceAnalyze = forceAnalyze
    self.output = output
    self.prompt = prompt
    self.strategy = strategy
  }

  enum CodingKeys: String, CodingKey {
    case forceAnalyze = "forceAnalyze"
    case output = "output"
    case prompt = "prompt"
    case strategy = "strategy"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.forceAnalyze {
      body["forceAnalyze"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.output {
      body["output"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.prompt {
      body["prompt"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.strategy {
      body["strategy"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct VideoAnalyzeReturn: Codable, Sendable {
  public var artifact: [String: RaviJSON]
  public var options: [String: RaviJSON]
  public var success: Bool
  public var video: RaviJSON

  public init(artifact: [String: RaviJSON], options: [String: RaviJSON], success: Bool, video: RaviJSON) {
    self.artifact = artifact
    self.options = options
    self.success = success
    self.video = video
  }

  enum CodingKeys: String, CodingKey {
    case artifact = "artifact"
    case options = "options"
    case success = "success"
    case video = "video"
  }
}

public struct WatchConnectorsOptions: Codable, Sendable {
  public var provider: String?

  public init(provider: String? = nil) {
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WatchConnectorsReturn: Codable, Sendable {
  public var connectors: [[String: RaviJSON]]
  public var items: [[String: RaviJSON]]
  public var total: Double

  public init(connectors: [[String: RaviJSON]], items: [[String: RaviJSON]], total: Double) {
    self.connectors = connectors
    self.items = items
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case connectors = "connectors"
    case items = "items"
    case total = "total"
  }
}

public struct WatchCreateOptions: Codable, Sendable {
  public var event: String?
  public var installation: String?
  public var name: String?
  public var placement: String?
  public var project: String?
  public var resourceId: String?

  public init(event: String? = nil, installation: String? = nil, name: String? = nil, placement: String? = nil, project: String? = nil, resourceId: String? = nil) {
    self.event = event
    self.installation = installation
    self.name = name
    self.placement = placement
    self.project = project
    self.resourceId = resourceId
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
    case installation = "installation"
    case name = "name"
    case placement = "placement"
    case project = "project"
    case resourceId = "resourceId"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.event {
      body["event"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.installation {
      body["installation"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.name {
      body["name"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.placement {
      body["placement"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.project {
      body["project"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.resourceId {
      body["resourceId"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WatchCreateReturn: Codable, Sendable {
  public var capabilities: [String: RaviJSON]
  public var next: [String: RaviJSON]
  public var status: String
  public var watch: [String: RaviJSON]

  public init(capabilities: [String: RaviJSON], next: [String: RaviJSON], status: String, watch: [String: RaviJSON]) {
    self.capabilities = capabilities
    self.next = next
    self.status = status
    self.watch = watch
  }

  enum CodingKeys: String, CodingKey {
    case capabilities = "capabilities"
    case next = "next"
    case status = "status"
    case watch = "watch"
  }
}

public struct WatchDisableReturn: Codable, Sendable {
  public var status: String
  public var watch: [String: RaviJSON]

  public init(status: String, watch: [String: RaviJSON]) {
    self.status = status
    self.watch = watch
  }

  enum CodingKeys: String, CodingKey {
    case status = "status"
    case watch = "watch"
  }
}

public struct WatchEnableReturn: Codable, Sendable {
  public var status: String
  public var watch: [String: RaviJSON]

  public init(status: String, watch: [String: RaviJSON]) {
    self.status = status
    self.watch = watch
  }

  enum CodingKeys: String, CodingKey {
    case status = "status"
    case watch = "watch"
  }
}

public struct WatchEventsReturn: Codable, Sendable {
  public var eventTypes: [String]
  public var subjects: [String]
  public var watchId: String

  public init(eventTypes: [String], subjects: [String], watchId: String) {
    self.eventTypes = eventTypes
    self.subjects = subjects
    self.watchId = watchId
  }

  enum CodingKeys: String, CodingKey {
    case eventTypes = "eventTypes"
    case subjects = "subjects"
    case watchId = "watchId"
  }
}

public struct WatchListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?
  public var provider: String?
  public var status: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil, provider: String? = nil, status: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
    self.provider = provider
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
    case provider = "provider"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.provider {
      body["provider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.status {
      body["status"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WatchListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var total: Double
  public var watches: [[String: RaviJSON]]

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, total: Double, watches: [[String: RaviJSON]]) {
    self.items = items
    self.pagination = pagination
    self.total = total
    self.watches = watches
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case total = "total"
    case watches = "watches"
  }
}

public struct WatchRmOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WatchRmReturn: Codable, Sendable {
  public var deleted: Bool
  public var id: String

  public init(deleted: Bool, id: String) {
    self.deleted = deleted
    self.id = id
  }

  enum CodingKeys: String, CodingKey {
    case deleted = "deleted"
    case id = "id"
  }
}

public struct WatchShowReturn: Codable, Sendable {
  public var watch: [String: RaviJSON]

  public init(watch: [String: RaviJSON]) {
    self.watch = watch
  }

  enum CodingKeys: String, CodingKey {
    case watch = "watch"
  }
}

public struct WatchTriggerOptions: Codable, Sendable {
  public var account: String?
  public var agent: String?
  public var cooldown: String?
  public var event: String?
  public var execute: Bool?
  public var message: String?
  public var session: String?

  public init(account: String? = nil, agent: String? = nil, cooldown: String? = nil, event: String? = nil, execute: Bool? = nil, message: String? = nil, session: String? = nil) {
    self.account = account
    self.agent = agent
    self.cooldown = cooldown
    self.event = event
    self.execute = execute
    self.message = message
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case agent = "agent"
    case cooldown = "cooldown"
    case event = "event"
    case execute = "execute"
    case message = "message"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.cooldown {
      body["cooldown"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.event {
      body["event"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.message {
      body["message"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WatchTriggerReturn: Codable, Sendable {
  public var status: String
  public var trigger: [String: RaviJSON]
  public var watch: [String: RaviJSON]

  public init(status: String, trigger: [String: RaviJSON], watch: [String: RaviJSON]) {
    self.status = status
    self.trigger = trigger
    self.watch = watch
  }

  enum CodingKeys: String, CodingKey {
    case status = "status"
    case trigger = "trigger"
    case watch = "watch"
  }
}

public struct WhatsappDmAckOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappDmAckReturn = [String: RaviJSON]

public struct WhatsappDmReadOptions: Codable, Sendable {
  public var account: String?
  public var fields: String?
  public var last: String?
  public var noAck: Bool?

  public init(account: String? = nil, fields: String? = nil, last: String? = nil, noAck: Bool? = nil) {
    self.account = account
    self.fields = fields
    self.last = last
    self.noAck = noAck
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case fields = "fields"
    case last = "last"
    case noAck = "noAck"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.last {
      body["last"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.noAck {
      body["noAck"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappDmReadReturn = [String: RaviJSON]

public struct WhatsappDmSendOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappDmSendReturn = [String: RaviJSON]

public struct WhatsappGroupAddOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupAddReturn = [String: RaviJSON]

public struct WhatsappGroupCreateOptions: Codable, Sendable {
  public var account: String?
  public var admin: [String]?
  public var admins: [String]?
  public var agent: String?
  public var agentCwd: String?
  public var agentModel: String?
  public var agentProvider: String?
  public var createAgent: Bool?
  public var execute: Bool?
  public var skipTaggedAdmins: Bool?

  public init(account: String? = nil, admin: [String]? = nil, admins: [String]? = nil, agent: String? = nil, agentCwd: String? = nil, agentModel: String? = nil, agentProvider: String? = nil, createAgent: Bool? = nil, execute: Bool? = nil, skipTaggedAdmins: Bool? = nil) {
    self.account = account
    self.admin = admin
    self.admins = admins
    self.agent = agent
    self.agentCwd = agentCwd
    self.agentModel = agentModel
    self.agentProvider = agentProvider
    self.createAgent = createAgent
    self.execute = execute
    self.skipTaggedAdmins = skipTaggedAdmins
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case admin = "admin"
    case admins = "admins"
    case agent = "agent"
    case agentCwd = "agentCwd"
    case agentModel = "agentModel"
    case agentProvider = "agentProvider"
    case createAgent = "createAgent"
    case execute = "execute"
    case skipTaggedAdmins = "skipTaggedAdmins"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.admin {
      body["admin"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.admins {
      body["admins"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agentCwd {
      body["agentCwd"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agentModel {
      body["agentModel"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.agentProvider {
      body["agentProvider"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.createAgent {
      body["createAgent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.skipTaggedAdmins {
      body["skipTaggedAdmins"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupCreateReturn = [String: RaviJSON]

public struct WhatsappGroupDemoteOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupDemoteReturn = [String: RaviJSON]

public struct WhatsappGroupDescriptionOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupDescriptionReturn = [String: RaviJSON]

public struct WhatsappGroupInfoOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupInfoReturn = [String: RaviJSON]

public struct WhatsappGroupInviteOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupInviteReturn = [String: RaviJSON]

public struct WhatsappGroupJoinOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupJoinReturn = [String: RaviJSON]

public struct WhatsappGroupLeaveOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupLeaveReturn = [String: RaviJSON]

public struct WhatsappGroupListOptions: Codable, Sendable {
  public var account: String?
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(account: String? = nil, fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.account = account
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupListReturn = [String: RaviJSON]

public struct WhatsappGroupPromoteOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupPromoteReturn = [String: RaviJSON]

public struct WhatsappGroupRemoveOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupRemoveReturn = [String: RaviJSON]

public struct WhatsappGroupRenameOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupRenameReturn = [String: RaviJSON]

public struct WhatsappGroupRevokeInviteOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupRevokeInviteReturn = [String: RaviJSON]

public struct WhatsappGroupSendOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?
  public var mention: [String]?

  public init(account: String? = nil, execute: Bool? = nil, mention: [String]? = nil) {
    self.account = account
    self.execute = execute
    self.mention = mention
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
    case mention = "mention"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.mention {
      body["mention"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupSendReturn = [String: RaviJSON]

public struct WhatsappGroupSettingsOptions: Codable, Sendable {
  public var account: String?
  public var execute: Bool?

  public init(account: String? = nil, execute: Bool? = nil) {
    self.account = account
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.account {
      body["account"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WhatsappGroupSettingsReturn = [String: RaviJSON]

public struct WorkObjectsActionOptions: Codable, Sendable {
  public var execute: Bool?
  public var value: String?

  public init(execute: Bool? = nil, value: String? = nil) {
    self.execute = execute
    self.value = value
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case value = "value"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.value {
      body["value"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WorkObjectsActionReturn: Codable, Sendable {
  public var providerId: String
  public var result: RaviJSON

  public init(providerId: String, result: RaviJSON) {
    self.providerId = providerId
    self.result = result
  }

  enum CodingKeys: String, CodingKey {
    case providerId = "providerId"
    case result = "result"
  }
}

public struct WorkObjectsResolveOptions: Codable, Sendable {
  public var id: String?
  public var type: String?
  public var url: String?

  public init(id: String? = nil, type: String? = nil, url: String? = nil) {
    self.id = id
    self.type = type
    self.url = url
  }

  enum CodingKeys: String, CodingKey {
    case id = "id"
    case type = "type"
    case url = "url"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.id {
      body["id"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.type {
      body["type"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.url {
      body["url"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WorkObjectsResolveReturn: Codable, Sendable {
  public var providerId: String
  public var result: RaviJSON

  public init(providerId: String, result: RaviJSON) {
    self.providerId = providerId
    self.result = result
  }

  enum CodingKeys: String, CodingKey {
    case providerId = "providerId"
    case result = "result"
  }
}

public struct WorkObjectsSuggestOptions: Codable, Sendable {
  public var query: String?

  public init(query: String? = nil) {
    self.query = query
  }

  enum CodingKeys: String, CodingKey {
    case query = "query"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.query {
      body["query"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WorkObjectsSuggestReturn: Codable, Sendable {
  public var providerId: String
  public var result: [RaviJSON]

  public init(providerId: String, result: [RaviJSON]) {
    self.providerId = providerId
    self.result = result
  }

  enum CodingKeys: String, CodingKey {
    case providerId = "providerId"
    case result = "result"
  }
}

public struct WorkObjectsUpdateOptions: Codable, Sendable {
  public var revision: String?
  public var values: String?

  public init(revision: String? = nil, values: String? = nil) {
    self.revision = revision
    self.values = values
  }

  enum CodingKeys: String, CodingKey {
    case revision = "revision"
    case values = "values"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.revision {
      body["revision"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.values {
      body["values"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WorkObjectsUpdateReturn: Codable, Sendable {
  public var providerId: String
  public var result: RaviJSON

  public init(providerId: String, result: RaviJSON) {
    self.providerId = providerId
    self.result = result
  }

  enum CodingKeys: String, CodingKey {
    case providerId = "providerId"
    case result = "result"
  }
}

public struct WorkflowsRunsArchiveNodeOptions: Codable, Sendable {
  public var execute: Bool?

  public init(execute: Bool? = nil) {
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WorkflowsRunsArchiveNodeReturn: Codable, Sendable {
  public var details: [String: RaviJSON]

  public init(details: [String: RaviJSON]) {
    self.details = details
  }

  enum CodingKeys: String, CodingKey {
    case details = "details"
  }
}

public struct WorkflowsRunsCancelReturn: Codable, Sendable {
  public var details: [String: RaviJSON]

  public init(details: [String: RaviJSON]) {
    self.details = details
  }

  enum CodingKeys: String, CodingKey {
    case details = "details"
  }
}

public struct WorkflowsRunsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WorkflowsRunsListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var runs: [[String: RaviJSON]]
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, runs: [[String: RaviJSON]], total: Double) {
    self.items = items
    self.pagination = pagination
    self.runs = runs
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case runs = "runs"
    case total = "total"
  }
}

public struct WorkflowsRunsReleaseReturn: Codable, Sendable {
  public var details: [String: RaviJSON]

  public init(details: [String: RaviJSON]) {
    self.details = details
  }

  enum CodingKeys: String, CodingKey {
    case details = "details"
  }
}

public typealias WorkflowsRunsShowReturn = [String: RaviJSON]

public struct WorkflowsRunsSkipReturn: Codable, Sendable {
  public var details: [String: RaviJSON]

  public init(details: [String: RaviJSON]) {
    self.details = details
  }

  enum CodingKeys: String, CodingKey {
    case details = "details"
  }
}

public struct WorkflowsRunsStartOptions: Codable, Sendable {
  public var execute: Bool?
  public var runId: String?

  public init(execute: Bool? = nil, runId: String? = nil) {
    self.execute = execute
    self.runId = runId
  }

  enum CodingKeys: String, CodingKey {
    case execute = "execute"
    case runId = "runId"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.runId {
      body["runId"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WorkflowsRunsStartReturn = [String: RaviJSON]

public struct WorkflowsRunsTaskAttachReturn: Codable, Sendable {
  public var details: [String: RaviJSON]

  public init(details: [String: RaviJSON]) {
    self.details = details
  }

  enum CodingKeys: String, CodingKey {
    case details = "details"
  }
}

public struct WorkflowsRunsTaskCreateOptions: Codable, Sendable {
  public var agent: String?
  public var instructions: String?
  public var priority: String?
  public var profile: String?
  public var session: String?
  public var title: String?

  public init(agent: String? = nil, instructions: String? = nil, priority: String? = nil, profile: String? = nil, session: String? = nil, title: String? = nil) {
    self.agent = agent
    self.instructions = instructions
    self.priority = priority
    self.profile = profile
    self.session = session
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case instructions = "instructions"
    case priority = "priority"
    case profile = "profile"
    case session = "session"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.agent {
      body["agent"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.instructions {
      body["instructions"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.priority {
      body["priority"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.profile {
      body["profile"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.session {
      body["session"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WorkflowsRunsTaskCreateReturn: Codable, Sendable {
  public var task: [String: RaviJSON]
  public var workflow: RaviJSON

  public init(task: [String: RaviJSON], workflow: RaviJSON) {
    self.task = task
    self.workflow = workflow
  }

  enum CodingKeys: String, CodingKey {
    case task = "task"
    case workflow = "workflow"
  }
}

public struct WorkflowsSpecsCreateOptions: Codable, Sendable {
  public var definition: String?
  public var file: String?

  public init(definition: String? = nil, file: String? = nil) {
    self.definition = definition
    self.file = file
  }

  enum CodingKeys: String, CodingKey {
    case definition = "definition"
    case file = "file"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.definition {
      body["definition"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.file {
      body["file"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public typealias WorkflowsSpecsCreateReturn = [String: RaviJSON]

public struct WorkflowsSpecsListOptions: Codable, Sendable {
  public var fields: String?
  public var limit: String?
  public var offset: String?

  public init(fields: String? = nil, limit: String? = nil, offset: String? = nil) {
    self.fields = fields
    self.limit = limit
    self.offset = offset
  }

  enum CodingKeys: String, CodingKey {
    case fields = "fields"
    case limit = "limit"
    case offset = "offset"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.offset {
      body["offset"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct WorkflowsSpecsListReturn: Codable, Sendable {
  public var items: [[String: RaviJSON]]
  public var pagination: RaviJSON
  public var specs: [[String: RaviJSON]]
  public var total: Double

  public init(items: [[String: RaviJSON]], pagination: RaviJSON, specs: [[String: RaviJSON]], total: Double) {
    self.items = items
    self.pagination = pagination
    self.specs = specs
    self.total = total
  }

  enum CodingKeys: String, CodingKey {
    case items = "items"
    case pagination = "pagination"
    case specs = "specs"
    case total = "total"
  }
}

public typealias WorkflowsSpecsShowReturn = [String: RaviJSON]

public struct YtAnalyticsCountriesOptions: Codable, Sendable {
  public var connection: String?
  public var days: String?
  public var limit: String?

  public init(connection: String? = nil, days: String? = nil, limit: String? = nil) {
    self.connection = connection
    self.days = days
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case days = "days"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.days {
      body["days"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtAnalyticsCountriesReturn: Codable, Sendable {
  public var countries: [RaviJSON]
  public var period: String
  public var success: Bool

  public init(countries: [RaviJSON], period: String, success: Bool) {
    self.countries = countries
    self.period = period
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case countries = "countries"
    case period = "period"
    case success = "success"
  }
}

public struct YtAnalyticsDemographicsOptions: Codable, Sendable {
  public var connection: String?
  public var days: String?

  public init(connection: String? = nil, days: String? = nil) {
    self.connection = connection
    self.days = days
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case days = "days"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.days {
      body["days"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtAnalyticsDemographicsReturn: Codable, Sendable {
  public var demographics: [RaviJSON]
  public var period: String
  public var success: Bool

  public init(demographics: [RaviJSON], period: String, success: Bool) {
    self.demographics = demographics
    self.period = period
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case demographics = "demographics"
    case period = "period"
    case success = "success"
  }
}

public struct YtAnalyticsDevicesOptions: Codable, Sendable {
  public var connection: String?
  public var days: String?

  public init(connection: String? = nil, days: String? = nil) {
    self.connection = connection
    self.days = days
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case days = "days"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.days {
      body["days"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtAnalyticsDevicesReturn: Codable, Sendable {
  public var devices: [RaviJSON]
  public var period: String
  public var success: Bool

  public init(devices: [RaviJSON], period: String, success: Bool) {
    self.devices = devices
    self.period = period
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case devices = "devices"
    case period = "period"
    case success = "success"
  }
}

public struct YtAnalyticsOverviewOptions: Codable, Sendable {
  public var connection: String?
  public var days: String?

  public init(connection: String? = nil, days: String? = nil) {
    self.connection = connection
    self.days = days
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case days = "days"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.days {
      body["days"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtAnalyticsOverviewReturn: Codable, Sendable {
  public var overview: RaviJSON
  public var period: String
  public var success: Bool

  public init(overview: RaviJSON, period: String, success: Bool) {
    self.overview = overview
    self.period = period
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case overview = "overview"
    case period = "period"
    case success = "success"
  }
}

public struct YtAnalyticsSeriesOptions: Codable, Sendable {
  public var connection: String?
  public var days: String?
  public var metric: String?

  public init(connection: String? = nil, days: String? = nil, metric: String? = nil) {
    self.connection = connection
    self.days = days
    self.metric = metric
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case days = "days"
    case metric = "metric"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.days {
      body["days"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.metric {
      body["metric"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtAnalyticsSeriesReturn: Codable, Sendable {
  public var data: [[String: RaviJSON]]
  public var metric: String
  public var period: String
  public var success: Bool

  public init(data: [[String: RaviJSON]], metric: String, period: String, success: Bool) {
    self.data = data
    self.metric = metric
    self.period = period
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case data = "data"
    case metric = "metric"
    case period = "period"
    case success = "success"
  }
}

public struct YtAnalyticsTopOptions: Codable, Sendable {
  public var connection: String?
  public var days: String?
  public var limit: String?

  public init(connection: String? = nil, days: String? = nil, limit: String? = nil) {
    self.connection = connection
    self.days = days
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case days = "days"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.days {
      body["days"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtAnalyticsTopReturn: Codable, Sendable {
  public var period: String
  public var success: Bool
  public var videos: [RaviJSON]

  public init(period: String, success: Bool, videos: [RaviJSON]) {
    self.period = period
    self.success = success
    self.videos = videos
  }

  enum CodingKeys: String, CodingKey {
    case period = "period"
    case success = "success"
    case videos = "videos"
  }
}

public struct YtAnalyticsTrafficOptions: Codable, Sendable {
  public var connection: String?
  public var days: String?

  public init(connection: String? = nil, days: String? = nil) {
    self.connection = connection
    self.days = days
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case days = "days"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.days {
      body["days"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtAnalyticsTrafficReturn: Codable, Sendable {
  public var period: String
  public var sources: [RaviJSON]
  public var success: Bool

  public init(period: String, sources: [RaviJSON], success: Bool) {
    self.period = period
    self.sources = sources
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case period = "period"
    case sources = "sources"
    case success = "success"
  }
}

public struct YtCaptionDownloadOptions: Codable, Sendable {
  public var connection: String?
  public var format: String?
  public var language: String?

  public init(connection: String? = nil, format: String? = nil, language: String? = nil) {
    self.connection = connection
    self.format = format
    self.language = language
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case format = "format"
    case language = "language"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.format {
      body["format"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.language {
      body["language"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtCaptionDownloadReturn: Codable, Sendable {
  public var captionId: String
  public var content: String
  public var format: String
  public var success: Bool

  public init(captionId: String, content: String, format: String, success: Bool) {
    self.captionId = captionId
    self.content = content
    self.format = format
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case captionId = "captionId"
    case content = "content"
    case format = "format"
    case success = "success"
  }
}

public struct YtCaptionsOptions: Codable, Sendable {
  public var connection: String?

  public init(connection: String? = nil) {
    self.connection = connection
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtCaptionsReturn: Codable, Sendable {
  public var captions: [RaviJSON]
  public var success: Bool
  public var totalResults: Double
  public var videoId: String

  public init(captions: [RaviJSON], success: Bool, totalResults: Double, videoId: String) {
    self.captions = captions
    self.success = success
    self.totalResults = totalResults
    self.videoId = videoId
  }

  enum CodingKeys: String, CodingKey {
    case captions = "captions"
    case success = "success"
    case totalResults = "totalResults"
    case videoId = "videoId"
  }
}

public struct YtCommentsOptions: Codable, Sendable {
  public var connection: String?
  public var fields: String?
  public var limit: String?
  public var page: String?

  public init(connection: String? = nil, fields: String? = nil, limit: String? = nil, page: String? = nil) {
    self.connection = connection
    self.fields = fields
    self.limit = limit
    self.page = page
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case fields = "fields"
    case limit = "limit"
    case page = "page"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.page {
      body["page"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtCommentsReturn: Codable, Sendable {
  public var comments: [RaviJSON]
  public var nextPageToken: String?
  public var success: Bool
  public var totalResults: Double
  public var videoId: String

  public init(comments: [RaviJSON], nextPageToken: String? = nil, success: Bool, totalResults: Double, videoId: String) {
    self.comments = comments
    self.nextPageToken = nextPageToken
    self.success = success
    self.totalResults = totalResults
    self.videoId = videoId
  }

  enum CodingKeys: String, CodingKey {
    case comments = "comments"
    case nextPageToken = "nextPageToken"
    case success = "success"
    case totalResults = "totalResults"
    case videoId = "videoId"
  }
}

public struct YtHealthOptions: Codable, Sendable {
  public var connection: String?

  public init(connection: String? = nil) {
    self.connection = connection
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtHealthReturn: Codable, Sendable {
  public var app: String
  public var authenticated: Bool
  public var connection: String
  public var credentialConfigured: Bool
  public var credentialStatus: String
  public var externalCheckPerformed: Bool
  public var message: String
  public var ready: Bool
  public var success: Bool

  public init(app: String, authenticated: Bool, connection: String, credentialConfigured: Bool, credentialStatus: String, externalCheckPerformed: Bool, message: String, ready: Bool, success: Bool) {
    self.app = app
    self.authenticated = authenticated
    self.connection = connection
    self.credentialConfigured = credentialConfigured
    self.credentialStatus = credentialStatus
    self.externalCheckPerformed = externalCheckPerformed
    self.message = message
    self.ready = ready
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case app = "app"
    case authenticated = "authenticated"
    case connection = "connection"
    case credentialConfigured = "credentialConfigured"
    case credentialStatus = "credentialStatus"
    case externalCheckPerformed = "externalCheckPerformed"
    case message = "message"
    case ready = "ready"
    case success = "success"
  }
}

public struct YtInfoOptions: Codable, Sendable {
  public var connection: String?

  public init(connection: String? = nil) {
    self.connection = connection
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtInfoReturn: Codable, Sendable {
  public var channel: RaviJSON
  public var success: Bool

  public init(channel: RaviJSON, success: Bool) {
    self.channel = channel
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
    case success = "success"
  }
}

public struct YtPlaylistOptions: Codable, Sendable {
  public var connection: String?
  public var fields: String?
  public var limit: String?
  public var page: String?

  public init(connection: String? = nil, fields: String? = nil, limit: String? = nil, page: String? = nil) {
    self.connection = connection
    self.fields = fields
    self.limit = limit
    self.page = page
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case fields = "fields"
    case limit = "limit"
    case page = "page"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.page {
      body["page"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtPlaylistReturn: Codable, Sendable {
  public var nextPageToken: String?
  public var playlistId: String
  public var success: Bool
  public var totalResults: Double
  public var videos: [RaviJSON]

  public init(nextPageToken: String? = nil, playlistId: String, success: Bool, totalResults: Double, videos: [RaviJSON]) {
    self.nextPageToken = nextPageToken
    self.playlistId = playlistId
    self.success = success
    self.totalResults = totalResults
    self.videos = videos
  }

  enum CodingKeys: String, CodingKey {
    case nextPageToken = "nextPageToken"
    case playlistId = "playlistId"
    case success = "success"
    case totalResults = "totalResults"
    case videos = "videos"
  }
}

public struct YtPlaylistAddOptions: Codable, Sendable {
  public var connection: String?
  public var execute: Bool?

  public init(connection: String? = nil, execute: Bool? = nil) {
    self.connection = connection
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtPlaylistAddReturn: Codable, Sendable {
  public var item: RaviJSON
  public var success: Bool

  public init(item: RaviJSON, success: Bool) {
    self.item = item
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case item = "item"
    case success = "success"
  }
}

public struct YtPlaylistCreateOptions: Codable, Sendable {
  public var connection: String?
  public var description: String?
  public var execute: Bool?
  public var privacy: String?

  public init(connection: String? = nil, description: String? = nil, execute: Bool? = nil, privacy: String? = nil) {
    self.connection = connection
    self.description = description
    self.execute = execute
    self.privacy = privacy
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case description = "description"
    case execute = "execute"
    case privacy = "privacy"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.privacy {
      body["privacy"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtPlaylistCreateReturn: Codable, Sendable {
  public var playlist: RaviJSON
  public var success: Bool

  public init(playlist: RaviJSON, success: Bool) {
    self.playlist = playlist
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case playlist = "playlist"
    case success = "success"
  }
}

public struct YtPlaylistDeleteOptions: Codable, Sendable {
  public var connection: String?
  public var execute: Bool?

  public init(connection: String? = nil, execute: Bool? = nil) {
    self.connection = connection
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtPlaylistDeleteReturn: Codable, Sendable {
  public var deleted: String
  public var success: Bool

  public init(deleted: String, success: Bool) {
    self.deleted = deleted
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case deleted = "deleted"
    case success = "success"
  }
}

public struct YtPlaylistRemoveOptions: Codable, Sendable {
  public var connection: String?
  public var execute: Bool?

  public init(connection: String? = nil, execute: Bool? = nil) {
    self.connection = connection
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtPlaylistRemoveReturn: Codable, Sendable {
  public var removed: String
  public var success: Bool

  public init(removed: String, success: Bool) {
    self.removed = removed
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case removed = "removed"
    case success = "success"
  }
}

public struct YtPlaylistsOptions: Codable, Sendable {
  public var connection: String?
  public var fields: String?
  public var limit: String?
  public var page: String?

  public init(connection: String? = nil, fields: String? = nil, limit: String? = nil, page: String? = nil) {
    self.connection = connection
    self.fields = fields
    self.limit = limit
    self.page = page
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case fields = "fields"
    case limit = "limit"
    case page = "page"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.page {
      body["page"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtPlaylistsReturn: Codable, Sendable {
  public var nextPageToken: String?
  public var playlists: [RaviJSON]
  public var success: Bool
  public var totalResults: Double

  public init(nextPageToken: String? = nil, playlists: [RaviJSON], success: Bool, totalResults: Double) {
    self.nextPageToken = nextPageToken
    self.playlists = playlists
    self.success = success
    self.totalResults = totalResults
  }

  enum CodingKeys: String, CodingKey {
    case nextPageToken = "nextPageToken"
    case playlists = "playlists"
    case success = "success"
    case totalResults = "totalResults"
  }
}

public struct YtReplyOptions: Codable, Sendable {
  public var connection: String?
  public var execute: Bool?

  public init(connection: String? = nil, execute: Bool? = nil) {
    self.connection = connection
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtReplyReturn: Codable, Sendable {
  public var replyId: String
  public var success: Bool

  public init(replyId: String, success: Bool) {
    self.replyId = replyId
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case replyId = "replyId"
    case success = "success"
  }
}

public struct YtSearchOptions: Codable, Sendable {
  public var connection: String?
  public var fields: String?
  public var limit: String?
  public var page: String?

  public init(connection: String? = nil, fields: String? = nil, limit: String? = nil, page: String? = nil) {
    self.connection = connection
    self.fields = fields
    self.limit = limit
    self.page = page
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case fields = "fields"
    case limit = "limit"
    case page = "page"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.page {
      body["page"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtSearchReturn: Codable, Sendable {
  public var nextPageToken: String?
  public var query: String
  public var success: Bool
  public var totalResults: Double
  public var videos: [RaviJSON]

  public init(nextPageToken: String? = nil, query: String, success: Bool, totalResults: Double, videos: [RaviJSON]) {
    self.nextPageToken = nextPageToken
    self.query = query
    self.success = success
    self.totalResults = totalResults
    self.videos = videos
  }

  enum CodingKeys: String, CodingKey {
    case nextPageToken = "nextPageToken"
    case query = "query"
    case success = "success"
    case totalResults = "totalResults"
    case videos = "videos"
  }
}

public struct YtStatsOptions: Codable, Sendable {
  public var connection: String?

  public init(connection: String? = nil) {
    self.connection = connection
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtStatsReturn: Codable, Sendable {
  public var stats: RaviJSON
  public var success: Bool

  public init(stats: RaviJSON, success: Bool) {
    self.stats = stats
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case stats = "stats"
    case success = "success"
  }
}

public struct YtSubscriptionsOptions: Codable, Sendable {
  public var connection: String?
  public var fields: String?
  public var limit: String?
  public var page: String?

  public init(connection: String? = nil, fields: String? = nil, limit: String? = nil, page: String? = nil) {
    self.connection = connection
    self.fields = fields
    self.limit = limit
    self.page = page
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case fields = "fields"
    case limit = "limit"
    case page = "page"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.page {
      body["page"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtSubscriptionsReturn: Codable, Sendable {
  public var nextPageToken: String?
  public var subscriptions: [RaviJSON]
  public var success: Bool
  public var totalResults: Double

  public init(nextPageToken: String? = nil, subscriptions: [RaviJSON], success: Bool, totalResults: Double) {
    self.nextPageToken = nextPageToken
    self.subscriptions = subscriptions
    self.success = success
    self.totalResults = totalResults
  }

  enum CodingKeys: String, CodingKey {
    case nextPageToken = "nextPageToken"
    case subscriptions = "subscriptions"
    case success = "success"
    case totalResults = "totalResults"
  }
}

public struct YtUnansweredOptions: Codable, Sendable {
  public var connection: String?
  public var fields: String?
  public var limit: String?
  public var page: String?

  public init(connection: String? = nil, fields: String? = nil, limit: String? = nil, page: String? = nil) {
    self.connection = connection
    self.fields = fields
    self.limit = limit
    self.page = page
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case fields = "fields"
    case limit = "limit"
    case page = "page"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.page {
      body["page"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtUnansweredReturn: Codable, Sendable {
  public var comments: [RaviJSON]
  public var nextPageToken: String?
  public var success: Bool
  public var totalUnanswered: Double
  public var videoId: String

  public init(comments: [RaviJSON], nextPageToken: String? = nil, success: Bool, totalUnanswered: Double, videoId: String) {
    self.comments = comments
    self.nextPageToken = nextPageToken
    self.success = success
    self.totalUnanswered = totalUnanswered
    self.videoId = videoId
  }

  enum CodingKeys: String, CodingKey {
    case comments = "comments"
    case nextPageToken = "nextPageToken"
    case success = "success"
    case totalUnanswered = "totalUnanswered"
    case videoId = "videoId"
  }
}

public struct YtVideoOptions: Codable, Sendable {
  public var connection: String?

  public init(connection: String? = nil) {
    self.connection = connection
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtVideoReturn: Codable, Sendable {
  public var success: Bool
  public var video: RaviJSON

  public init(success: Bool, video: RaviJSON) {
    self.success = success
    self.video = video
  }

  enum CodingKeys: String, CodingKey {
    case success = "success"
    case video = "video"
  }
}

public struct YtVideoCategoriesOptions: Codable, Sendable {
  public var connection: String?
  public var region: String?

  public init(connection: String? = nil, region: String? = nil) {
    self.connection = connection
    self.region = region
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case region = "region"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.region {
      body["region"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtVideoCategoriesReturn: Codable, Sendable {
  public var categories: [RaviJSON]
  public var region: String
  public var success: Bool
  public var totalResults: Double

  public init(categories: [RaviJSON], region: String, success: Bool, totalResults: Double) {
    self.categories = categories
    self.region = region
    self.success = success
    self.totalResults = totalResults
  }

  enum CodingKeys: String, CodingKey {
    case categories = "categories"
    case region = "region"
    case success = "success"
    case totalResults = "totalResults"
  }
}

public struct YtVideoDeleteOptions: Codable, Sendable {
  public var connection: String?
  public var execute: Bool?

  public init(connection: String? = nil, execute: Bool? = nil) {
    self.connection = connection
    self.execute = execute
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case execute = "execute"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtVideoDeleteReturn: Codable, Sendable {
  public var deleted: String
  public var success: Bool

  public init(deleted: String, success: Bool) {
    self.deleted = deleted
    self.success = success
  }

  enum CodingKeys: String, CodingKey {
    case deleted = "deleted"
    case success = "success"
  }
}

public struct YtVideoUpdateOptions: Codable, Sendable {
  public var category: String?
  public var connection: String?
  public var description: String?
  public var execute: Bool?
  public var privacy: String?
  public var tags: String?
  public var title: String?

  public init(category: String? = nil, connection: String? = nil, description: String? = nil, execute: Bool? = nil, privacy: String? = nil, tags: String? = nil, title: String? = nil) {
    self.category = category
    self.connection = connection
    self.description = description
    self.execute = execute
    self.privacy = privacy
    self.tags = tags
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case category = "category"
    case connection = "connection"
    case description = "description"
    case execute = "execute"
    case privacy = "privacy"
    case tags = "tags"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.category {
      body["category"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.description {
      body["description"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.execute {
      body["execute"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.privacy {
      body["privacy"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.tags {
      body["tags"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.title {
      body["title"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtVideoUpdateReturn: Codable, Sendable {
  public var success: Bool
  public var video: RaviJSON

  public init(success: Bool, video: RaviJSON) {
    self.success = success
    self.video = video
  }

  enum CodingKeys: String, CodingKey {
    case success = "success"
    case video = "video"
  }
}

public struct YtVideosOptions: Codable, Sendable {
  public var connection: String?
  public var fields: String?
  public var limit: String?
  public var page: String?

  public init(connection: String? = nil, fields: String? = nil, limit: String? = nil, page: String? = nil) {
    self.connection = connection
    self.fields = fields
    self.limit = limit
    self.page = page
  }

  enum CodingKeys: String, CodingKey {
    case connection = "connection"
    case fields = "fields"
    case limit = "limit"
    case page = "page"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let value = self.connection {
      body["connection"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.fields {
      body["fields"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.limit {
      body["limit"] = try RaviJSON.fromEncodable(value)
    }
    if let value = self.page {
      body["page"] = try RaviJSON.fromEncodable(value)
    }
  }
}

public struct YtVideosReturn: Codable, Sendable {
  public var nextPageToken: String?
  public var success: Bool
  public var totalResults: Double
  public var videos: [RaviJSON]

  public init(nextPageToken: String? = nil, success: Bool, totalResults: Double, videos: [RaviJSON]) {
    self.nextPageToken = nextPageToken
    self.success = success
    self.totalResults = totalResults
    self.videos = videos
  }

  enum CodingKeys: String, CodingKey {
    case nextPageToken = "nextPageToken"
    case success = "success"
    case totalResults = "totalResults"
    case videos = "videos"
  }
}
