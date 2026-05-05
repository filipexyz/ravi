// GENERATED FILE - DO NOT EDIT.
// Run `ravi sdk swift generate` to regenerate.
// Drift is detected by `ravi sdk swift check`.

import Foundation

public struct AdaptersListOptions: Codable, Sendable {
  public var session: String?
  public var status: String?

  public init(session: String? = nil, status: String? = nil) {
    self.session = session
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case session = "session"
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
  }
}

public typealias AdaptersListReturn = RaviJSON

public typealias AdaptersShowReturn = RaviJSON

public struct AgentsCreateOptions: Codable, Sendable {
  public var allowRuntimeMismatch: Bool?
  public var provider: String?

  public init(allowRuntimeMismatch: Bool? = nil, provider: String? = nil) {
    self.allowRuntimeMismatch = allowRuntimeMismatch
    self.provider = provider
  }

  enum CodingKeys: String, CodingKey {
    case allowRuntimeMismatch = "allowRuntimeMismatch"
    case provider = "provider"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(allowRuntimeMismatch)
    }
    if let provider {
      body["provider"] = try RaviJSON.fromEncodable(provider)
    }
  }
}

public typealias AgentsCreateReturn = RaviJSON

public typealias AgentsDebounceReturn = RaviJSON

public struct AgentsDebugOptions: Codable, Sendable {
  public var turns: String?

  public init(turns: String? = nil) {
    self.turns = turns
  }

  enum CodingKeys: String, CodingKey {
    case turns = "turns"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let turns {
      body["turns"] = try RaviJSON.fromEncodable(turns)
    }
  }
}

public typealias AgentsDebugReturn = RaviJSON

public typealias AgentsDeleteReturn = RaviJSON

public struct AgentsListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias AgentsListReturn = RaviJSON

public typealias AgentsResetReturn = RaviJSON

public typealias AgentsSessionReturn = RaviJSON

public typealias AgentsSetReturn = RaviJSON

public typealias AgentsShowReturn = RaviJSON

public typealias AgentsSpecModeReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let materializeMissing {
      body["materializeMissing"] = try RaviJSON.fromEncodable(materializeMissing)
    }
  }
}

public typealias AgentsSyncInstructionsReturn = RaviJSON

public typealias ArtifactsArchiveReturn = RaviJSON

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
    if let metadata {
      body["metadata"] = try RaviJSON.fromEncodable(metadata)
    }
    if let relation {
      body["relation"] = try RaviJSON.fromEncodable(relation)
    }
  }
}

public typealias ArtifactsAttachReturn = RaviJSON

public typealias ArtifactsBlobReturn = RaviBinaryResponse

public struct ArtifactsCreateOptions: Codable, Sendable {
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
  public var summary: String?
  public var tags: String?
  public var task: String?
  public var title: String?
  public var totalTokens: String?
  public var uri: String?

  public init(command: String? = nil, costUsd: String? = nil, durationMs: String? = nil, input: String? = nil, inputTokens: String? = nil, lineage: String? = nil, message: String? = nil, metadata: String? = nil, metrics: String? = nil, mime: String? = nil, model: String? = nil, output: String? = nil, outputTokens: String? = nil, path: String? = nil, prompt: String? = nil, provider: String? = nil, session: String? = nil, summary: String? = nil, tags: String? = nil, task: String? = nil, title: String? = nil, totalTokens: String? = nil, uri: String? = nil) {
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
    case summary = "summary"
    case tags = "tags"
    case task = "task"
    case title = "title"
    case totalTokens = "totalTokens"
    case uri = "uri"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let command {
      body["command"] = try RaviJSON.fromEncodable(command)
    }
    if let costUsd {
      body["costUsd"] = try RaviJSON.fromEncodable(costUsd)
    }
    if let durationMs {
      body["durationMs"] = try RaviJSON.fromEncodable(durationMs)
    }
    if let input {
      body["input"] = try RaviJSON.fromEncodable(input)
    }
    if let inputTokens {
      body["inputTokens"] = try RaviJSON.fromEncodable(inputTokens)
    }
    if let lineage {
      body["lineage"] = try RaviJSON.fromEncodable(lineage)
    }
    if let message {
      body["message"] = try RaviJSON.fromEncodable(message)
    }
    if let metadata {
      body["metadata"] = try RaviJSON.fromEncodable(metadata)
    }
    if let metrics {
      body["metrics"] = try RaviJSON.fromEncodable(metrics)
    }
    if let mime {
      body["mime"] = try RaviJSON.fromEncodable(mime)
    }
    if let model {
      body["model"] = try RaviJSON.fromEncodable(model)
    }
    if let output {
      body["output"] = try RaviJSON.fromEncodable(output)
    }
    if let outputTokens {
      body["outputTokens"] = try RaviJSON.fromEncodable(outputTokens)
    }
    if let path {
      body["path"] = try RaviJSON.fromEncodable(path)
    }
    if let prompt {
      body["prompt"] = try RaviJSON.fromEncodable(prompt)
    }
    if let provider {
      body["provider"] = try RaviJSON.fromEncodable(provider)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let summary {
      body["summary"] = try RaviJSON.fromEncodable(summary)
    }
    if let tags {
      body["tags"] = try RaviJSON.fromEncodable(tags)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
    if let title {
      body["title"] = try RaviJSON.fromEncodable(title)
    }
    if let totalTokens {
      body["totalTokens"] = try RaviJSON.fromEncodable(totalTokens)
    }
    if let uri {
      body["uri"] = try RaviJSON.fromEncodable(uri)
    }
  }
}

public typealias ArtifactsCreateReturn = RaviJSON

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
    if let message {
      body["message"] = try RaviJSON.fromEncodable(message)
    }
    if let payload {
      body["payload"] = try RaviJSON.fromEncodable(payload)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
  }
}

public typealias ArtifactsEventReturn = RaviJSON

public typealias ArtifactsEventsReturn = RaviJSON

public struct ArtifactsListOptions: Codable, Sendable {
  public var agent: String?
  public var includeDeleted: Bool?
  public var kind: String?
  public var lifecycle: String?
  public var limit: String?
  public var rich: Bool?
  public var session: String?
  public var tag: String?
  public var task: String?

  public init(agent: String? = nil, includeDeleted: Bool? = nil, kind: String? = nil, lifecycle: String? = nil, limit: String? = nil, rich: Bool? = nil, session: String? = nil, tag: String? = nil, task: String? = nil) {
    self.agent = agent
    self.includeDeleted = includeDeleted
    self.kind = kind
    self.lifecycle = lifecycle
    self.limit = limit
    self.rich = rich
    self.session = session
    self.tag = tag
    self.task = task
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case includeDeleted = "includeDeleted"
    case kind = "kind"
    case lifecycle = "lifecycle"
    case limit = "limit"
    case rich = "rich"
    case session = "session"
    case tag = "tag"
    case task = "task"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let includeDeleted {
      body["includeDeleted"] = try RaviJSON.fromEncodable(includeDeleted)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
    if let lifecycle {
      body["lifecycle"] = try RaviJSON.fromEncodable(lifecycle)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
    if let rich {
      body["rich"] = try RaviJSON.fromEncodable(rich)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
  }
}

public typealias ArtifactsListReturn = RaviJSON

public typealias ArtifactsShowReturn = RaviJSON

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
    if let command {
      body["command"] = try RaviJSON.fromEncodable(command)
    }
    if let costUsd {
      body["costUsd"] = try RaviJSON.fromEncodable(costUsd)
    }
    if let durationMs {
      body["durationMs"] = try RaviJSON.fromEncodable(durationMs)
    }
    if let input {
      body["input"] = try RaviJSON.fromEncodable(input)
    }
    if let inputTokens {
      body["inputTokens"] = try RaviJSON.fromEncodable(inputTokens)
    }
    if let lineage {
      body["lineage"] = try RaviJSON.fromEncodable(lineage)
    }
    if let message {
      body["message"] = try RaviJSON.fromEncodable(message)
    }
    if let metadata {
      body["metadata"] = try RaviJSON.fromEncodable(metadata)
    }
    if let metrics {
      body["metrics"] = try RaviJSON.fromEncodable(metrics)
    }
    if let mime {
      body["mime"] = try RaviJSON.fromEncodable(mime)
    }
    if let model {
      body["model"] = try RaviJSON.fromEncodable(model)
    }
    if let output {
      body["output"] = try RaviJSON.fromEncodable(output)
    }
    if let outputTokens {
      body["outputTokens"] = try RaviJSON.fromEncodable(outputTokens)
    }
    if let path {
      body["path"] = try RaviJSON.fromEncodable(path)
    }
    if let prompt {
      body["prompt"] = try RaviJSON.fromEncodable(prompt)
    }
    if let provider {
      body["provider"] = try RaviJSON.fromEncodable(provider)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
    if let summary {
      body["summary"] = try RaviJSON.fromEncodable(summary)
    }
    if let tags {
      body["tags"] = try RaviJSON.fromEncodable(tags)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
    if let title {
      body["title"] = try RaviJSON.fromEncodable(title)
    }
    if let totalTokens {
      body["totalTokens"] = try RaviJSON.fromEncodable(totalTokens)
    }
    if let uri {
      body["uri"] = try RaviJSON.fromEncodable(uri)
    }
  }
}

public typealias ArtifactsUpdateReturn = RaviJSON

public struct AudioGenerateOptions: Codable, Sendable {
  public var caption: String?
  public var format: String?
  public var lang: String?
  public var model: String?
  public var output: String?
  public var send: Bool?
  public var speed: String?
  public var voice: String?

  public init(caption: String? = nil, format: String? = nil, lang: String? = nil, model: String? = nil, output: String? = nil, send: Bool? = nil, speed: String? = nil, voice: String? = nil) {
    self.caption = caption
    self.format = format
    self.lang = lang
    self.model = model
    self.output = output
    self.send = send
    self.speed = speed
    self.voice = voice
  }

  enum CodingKeys: String, CodingKey {
    case caption = "caption"
    case format = "format"
    case lang = "lang"
    case model = "model"
    case output = "output"
    case send = "send"
    case speed = "speed"
    case voice = "voice"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let caption {
      body["caption"] = try RaviJSON.fromEncodable(caption)
    }
    if let format {
      body["format"] = try RaviJSON.fromEncodable(format)
    }
    if let lang {
      body["lang"] = try RaviJSON.fromEncodable(lang)
    }
    if let model {
      body["model"] = try RaviJSON.fromEncodable(model)
    }
    if let output {
      body["output"] = try RaviJSON.fromEncodable(output)
    }
    if let send {
      body["send"] = try RaviJSON.fromEncodable(send)
    }
    if let speed {
      body["speed"] = try RaviJSON.fromEncodable(speed)
    }
    if let voice {
      body["voice"] = try RaviJSON.fromEncodable(voice)
    }
  }
}

public typealias AudioGenerateReturn = RaviJSON

public struct CommandsListOptions: Codable, Sendable {
  public var agent: String?
  public var tag: String?

  public init(agent: String? = nil, tag: String? = nil) {
    self.agent = agent
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias CommandsListReturn = RaviJSON

public struct CommandsRunOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
  }
}

public typealias CommandsRunReturn = RaviJSON

public struct CommandsShowOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
  }
}

public typealias CommandsShowReturn = RaviJSON

public struct CommandsValidateOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
  }
}

public typealias CommandsValidateReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
  }
}

public typealias ContactsAddReturn = RaviJSON

public typealias ContactsAllowReturn = RaviJSON

public struct ContactsApproveOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
  }
}

public typealias ContactsApproveReturn = RaviJSON

public typealias ContactsBlockReturn = RaviJSON

public typealias ContactsCheckReturn = RaviJSON

public typealias ContactsDuplicatesReturn = RaviJSON

public struct ContactsFindOptions: Codable, Sendable {
  public var tag: Bool?

  public init(tag: Bool? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias ContactsFindReturn = RaviJSON

public typealias ContactsGetReturn = RaviJSON

public typealias ContactsGroupTagReturn = RaviJSON

public typealias ContactsGroupUntagReturn = RaviJSON

public typealias ContactsIdentityAddReturn = RaviJSON

public typealias ContactsIdentityRemoveReturn = RaviJSON

public typealias ContactsInfoReturn = RaviJSON

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
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let id {
      body["id"] = try RaviJSON.fromEncodable(id)
    }
    if let instance {
      body["instance"] = try RaviJSON.fromEncodable(instance)
    }
    if let reason {
      body["reason"] = try RaviJSON.fromEncodable(reason)
    }
  }
}

public typealias ContactsLinkReturn = RaviJSON

public struct ContactsListOptions: Codable, Sendable {
  public var status: String?

  public init(status: String? = nil) {
    self.status = status
  }

  enum CodingKeys: String, CodingKey {
    case status = "status"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
  }
}

public typealias ContactsListReturn = RaviJSON

public typealias ContactsMergeReturn = RaviJSON

public struct ContactsPendingOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias ContactsPendingReturn = RaviJSON

public typealias ContactsRemoveReturn = RaviJSON

public typealias ContactsSetReturn = RaviJSON

public typealias ContactsTagReturn = RaviJSON

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
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let instance {
      body["instance"] = try RaviJSON.fromEncodable(instance)
    }
    if let reason {
      body["reason"] = try RaviJSON.fromEncodable(reason)
    }
  }
}

public typealias ContactsUnlinkReturn = RaviJSON

public typealias ContactsUntagReturn = RaviJSON

public typealias ContextAuthorizeReturn = RaviJSON

public typealias ContextCapabilitiesReturn = RaviJSON

public typealias ContextCheckReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let olderThan {
      body["olderThan"] = try RaviJSON.fromEncodable(olderThan)
    }
    if let reason {
      body["reason"] = try RaviJSON.fromEncodable(reason)
    }
    if let revoke {
      body["revoke"] = try RaviJSON.fromEncodable(revoke)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
  }
}

public typealias ContextCleanupAgentRuntimeReturn = RaviJSON

public typealias ContextCodexBashHookReturn = RaviJSON

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
    if let label {
      body["label"] = try RaviJSON.fromEncodable(label)
    }
    if let setDefault {
      body["setDefault"] = try RaviJSON.fromEncodable(setDefault)
    }
  }
}

public typealias ContextCredentialsAddReturn = RaviJSON

public typealias ContextCredentialsListReturn = RaviJSON

public typealias ContextCredentialsRemoveReturn = RaviJSON

public typealias ContextCredentialsSetDefaultReturn = RaviJSON

public typealias ContextInfoReturn = RaviJSON

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
    if let allow {
      body["allow"] = try RaviJSON.fromEncodable(allow)
    }
    if let inherit {
      body["inherit"] = try RaviJSON.fromEncodable(inherit)
    }
    if let ttl {
      body["ttl"] = try RaviJSON.fromEncodable(ttl)
    }
  }
}

public typealias ContextIssueReturn = RaviJSON

public typealias ContextLineageReturn = RaviJSON

public struct ContextListOptions: Codable, Sendable {
  public var agent: String?
  public var all: Bool?
  public var kind: String?
  public var session: String?

  public init(agent: String? = nil, all: Bool? = nil, kind: String? = nil, session: String? = nil) {
    self.agent = agent
    self.all = all
    self.kind = kind
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case all = "all"
    case kind = "kind"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let all {
      body["all"] = try RaviJSON.fromEncodable(all)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
  }
}

public typealias ContextListReturn = RaviJSON

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
    if let noCascade {
      body["noCascade"] = try RaviJSON.fromEncodable(noCascade)
    }
    if let reason {
      body["reason"] = try RaviJSON.fromEncodable(reason)
    }
  }
}

public typealias ContextRevokeReturn = RaviJSON

public typealias ContextVisibilityReturn = RaviJSON

public typealias ContextWhoamiReturn = RaviJSON

public struct CostsAgentOptions: Codable, Sendable {
  public var hours: String?

  public init(hours: String? = nil) {
    self.hours = hours
  }

  enum CodingKeys: String, CodingKey {
    case hours = "hours"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let hours {
      body["hours"] = try RaviJSON.fromEncodable(hours)
    }
  }
}

public typealias CostsAgentReturn = RaviJSON

public struct CostsAgentsOptions: Codable, Sendable {
  public var hours: String?
  public var limit: String?

  public init(hours: String? = nil, limit: String? = nil) {
    self.hours = hours
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case hours = "hours"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let hours {
      body["hours"] = try RaviJSON.fromEncodable(hours)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
  }
}

public typealias CostsAgentsReturn = RaviJSON

public typealias CostsSessionReturn = RaviJSON

public struct CostsSummaryOptions: Codable, Sendable {
  public var hours: String?

  public init(hours: String? = nil) {
    self.hours = hours
  }

  enum CodingKeys: String, CodingKey {
    case hours = "hours"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let hours {
      body["hours"] = try RaviJSON.fromEncodable(hours)
    }
  }
}

public typealias CostsSummaryReturn = RaviJSON

public struct CostsTopSessionsOptions: Codable, Sendable {
  public var hours: String?
  public var limit: String?

  public init(hours: String? = nil, limit: String? = nil) {
    self.hours = hours
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case hours = "hours"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let hours {
      body["hours"] = try RaviJSON.fromEncodable(hours)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
  }
}

public typealias CostsTopSessionsReturn = RaviJSON

public struct CronAddOptions: Codable, Sendable {
  public var account: String?
  public var agent: String?
  public var at: String?
  public var cron: String?
  public var deleteAfter: Bool?
  public var description: String?
  public var every: String?
  public var isolated: Bool?
  public var message: String?
  public var tz: String?

  public init(account: String? = nil, agent: String? = nil, at: String? = nil, cron: String? = nil, deleteAfter: Bool? = nil, description: String? = nil, every: String? = nil, isolated: Bool? = nil, message: String? = nil, tz: String? = nil) {
    self.account = account
    self.agent = agent
    self.at = at
    self.cron = cron
    self.deleteAfter = deleteAfter
    self.description = description
    self.every = every
    self.isolated = isolated
    self.message = message
    self.tz = tz
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case agent = "agent"
    case at = "at"
    case cron = "cron"
    case deleteAfter = "deleteAfter"
    case description = "description"
    case every = "every"
    case isolated = "isolated"
    case message = "message"
    case tz = "tz"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let at {
      body["at"] = try RaviJSON.fromEncodable(at)
    }
    if let cron {
      body["cron"] = try RaviJSON.fromEncodable(cron)
    }
    if let deleteAfter {
      body["deleteAfter"] = try RaviJSON.fromEncodable(deleteAfter)
    }
    if let description {
      body["description"] = try RaviJSON.fromEncodable(description)
    }
    if let every {
      body["every"] = try RaviJSON.fromEncodable(every)
    }
    if let isolated {
      body["isolated"] = try RaviJSON.fromEncodable(isolated)
    }
    if let message {
      body["message"] = try RaviJSON.fromEncodable(message)
    }
    if let tz {
      body["tz"] = try RaviJSON.fromEncodable(tz)
    }
  }
}

public typealias CronAddReturn = RaviJSON

public typealias CronDisableReturn = RaviJSON

public typealias CronEnableReturn = RaviJSON

public struct CronListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias CronListReturn = RaviJSON

public typealias CronRmReturn = RaviJSON

public typealias CronRunReturn = RaviJSON

public typealias CronSetReturn = RaviJSON

public typealias CronShowReturn = RaviJSON

public typealias DaemonEnvReturn = RaviJSON

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
    if let fromEnv {
      body["fromEnv"] = try RaviJSON.fromEncodable(fromEnv)
    }
    if let label {
      body["label"] = try RaviJSON.fromEncodable(label)
    }
    if let noStore {
      body["noStore"] = try RaviJSON.fromEncodable(noStore)
    }
    if let printOnly {
      body["printOnly"] = try RaviJSON.fromEncodable(printOnly)
    }
  }
}

public typealias DaemonInitAdminKeyReturn = RaviJSON

public typealias DaemonInstallReturn = RaviJSON

public struct DaemonLogsOptions: Codable, Sendable {
  public var clear: Bool?
  public var follow: Bool?
  public var path: Bool?
  public var tail: String?

  public init(clear: Bool? = nil, follow: Bool? = nil, path: Bool? = nil, tail: String? = nil) {
    self.clear = clear
    self.follow = follow
    self.path = path
    self.tail = tail
  }

  enum CodingKeys: String, CodingKey {
    case clear = "clear"
    case follow = "follow"
    case path = "path"
    case tail = "tail"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let clear {
      body["clear"] = try RaviJSON.fromEncodable(clear)
    }
    if let follow {
      body["follow"] = try RaviJSON.fromEncodable(follow)
    }
    if let path {
      body["path"] = try RaviJSON.fromEncodable(path)
    }
    if let tail {
      body["tail"] = try RaviJSON.fromEncodable(tail)
    }
  }
}

public typealias DaemonLogsReturn = RaviJSON

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
    if let build {
      body["build"] = try RaviJSON.fromEncodable(build)
    }
    if let message {
      body["message"] = try RaviJSON.fromEncodable(message)
    }
  }
}

public typealias DaemonRestartReturn = RaviJSON

public typealias DaemonStartReturn = RaviJSON

public typealias DaemonStatusReturn = RaviJSON

public typealias DaemonStopReturn = RaviJSON

public typealias DaemonUninstallReturn = RaviJSON

public typealias DevinAuthCheckReturn = RaviJSON

public typealias DevinSessionsArchiveReturn = RaviJSON

public struct DevinSessionsAttachmentsOptions: Codable, Sendable {
  public var cached: Bool?

  public init(cached: Bool? = nil) {
    self.cached = cached
  }

  enum CodingKeys: String, CodingKey {
    case cached = "cached"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let cached {
      body["cached"] = try RaviJSON.fromEncodable(cached)
    }
  }
}

public typealias DevinSessionsAttachmentsReturn = RaviJSON

public struct DevinSessionsCreateOptions: Codable, Sendable {
  public var advancedMode: String?
  public var asUser: String?
  public var attachmentUrl: [String]?
  public var bypassApproval: Bool?
  public var childPlaybook: String?
  public var knowledge: [String]?
  public var maxAcu: String?
  public var noMaxAcuLimit: Bool?
  public var playbook: String?
  public var project: String?
  public var prompt: String?
  public var promptFile: String?
  public var proxRun: String?
  public var repo: [String]?
  public var secret: [String]?
  public var sessionLink: [String]?
  public var structuredOutputSchema: String?
  public var tag: [String]?
  public var task: String?
  public var title: String?

  public init(advancedMode: String? = nil, asUser: String? = nil, attachmentUrl: [String]? = nil, bypassApproval: Bool? = nil, childPlaybook: String? = nil, knowledge: [String]? = nil, maxAcu: String? = nil, noMaxAcuLimit: Bool? = nil, playbook: String? = nil, project: String? = nil, prompt: String? = nil, promptFile: String? = nil, proxRun: String? = nil, repo: [String]? = nil, secret: [String]? = nil, sessionLink: [String]? = nil, structuredOutputSchema: String? = nil, tag: [String]? = nil, task: String? = nil, title: String? = nil) {
    self.advancedMode = advancedMode
    self.asUser = asUser
    self.attachmentUrl = attachmentUrl
    self.bypassApproval = bypassApproval
    self.childPlaybook = childPlaybook
    self.knowledge = knowledge
    self.maxAcu = maxAcu
    self.noMaxAcuLimit = noMaxAcuLimit
    self.playbook = playbook
    self.project = project
    self.prompt = prompt
    self.promptFile = promptFile
    self.proxRun = proxRun
    self.repo = repo
    self.secret = secret
    self.sessionLink = sessionLink
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
    case knowledge = "knowledge"
    case maxAcu = "maxAcu"
    case noMaxAcuLimit = "noMaxAcuLimit"
    case playbook = "playbook"
    case project = "project"
    case prompt = "prompt"
    case promptFile = "promptFile"
    case proxRun = "proxRun"
    case repo = "repo"
    case secret = "secret"
    case sessionLink = "sessionLink"
    case structuredOutputSchema = "structuredOutputSchema"
    case tag = "tag"
    case task = "task"
    case title = "title"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let advancedMode {
      body["advancedMode"] = try RaviJSON.fromEncodable(advancedMode)
    }
    if let asUser {
      body["asUser"] = try RaviJSON.fromEncodable(asUser)
    }
    if let attachmentUrl {
      body["attachmentUrl"] = try RaviJSON.fromEncodable(attachmentUrl)
    }
    if let bypassApproval {
      body["bypassApproval"] = try RaviJSON.fromEncodable(bypassApproval)
    }
    if let childPlaybook {
      body["childPlaybook"] = try RaviJSON.fromEncodable(childPlaybook)
    }
    if let knowledge {
      body["knowledge"] = try RaviJSON.fromEncodable(knowledge)
    }
    if let maxAcu {
      body["maxAcu"] = try RaviJSON.fromEncodable(maxAcu)
    }
    if let noMaxAcuLimit {
      body["noMaxAcuLimit"] = try RaviJSON.fromEncodable(noMaxAcuLimit)
    }
    if let playbook {
      body["playbook"] = try RaviJSON.fromEncodable(playbook)
    }
    if let project {
      body["project"] = try RaviJSON.fromEncodable(project)
    }
    if let prompt {
      body["prompt"] = try RaviJSON.fromEncodable(prompt)
    }
    if let promptFile {
      body["promptFile"] = try RaviJSON.fromEncodable(promptFile)
    }
    if let proxRun {
      body["proxRun"] = try RaviJSON.fromEncodable(proxRun)
    }
    if let repo {
      body["repo"] = try RaviJSON.fromEncodable(repo)
    }
    if let secret {
      body["secret"] = try RaviJSON.fromEncodable(secret)
    }
    if let sessionLink {
      body["sessionLink"] = try RaviJSON.fromEncodable(sessionLink)
    }
    if let structuredOutputSchema {
      body["structuredOutputSchema"] = try RaviJSON.fromEncodable(structuredOutputSchema)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
    if let title {
      body["title"] = try RaviJSON.fromEncodable(title)
    }
  }
}

public typealias DevinSessionsCreateReturn = RaviJSON

public struct DevinSessionsInsightsOptions: Codable, Sendable {
  public var generate: Bool?

  public init(generate: Bool? = nil) {
    self.generate = generate
  }

  enum CodingKeys: String, CodingKey {
    case generate = "generate"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let generate {
      body["generate"] = try RaviJSON.fromEncodable(generate)
    }
  }
}

public typealias DevinSessionsInsightsReturn = RaviJSON

public struct DevinSessionsListOptions: Codable, Sendable {
  public var limit: String?
  public var remote: Bool?
  public var status: String?
  public var tag: String?

  public init(limit: String? = nil, remote: Bool? = nil, status: String? = nil, tag: String? = nil) {
    self.limit = limit
    self.remote = remote
    self.status = status
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
    case remote = "remote"
    case status = "status"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
    if let remote {
      body["remote"] = try RaviJSON.fromEncodable(remote)
    }
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias DevinSessionsListReturn = RaviJSON

public struct DevinSessionsMessagesOptions: Codable, Sendable {
  public var cached: Bool?

  public init(cached: Bool? = nil) {
    self.cached = cached
  }

  enum CodingKeys: String, CodingKey {
    case cached = "cached"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let cached {
      body["cached"] = try RaviJSON.fromEncodable(cached)
    }
  }
}

public typealias DevinSessionsMessagesReturn = RaviJSON

public struct DevinSessionsSendOptions: Codable, Sendable {
  public var asUser: String?

  public init(asUser: String? = nil) {
    self.asUser = asUser
  }

  enum CodingKeys: String, CodingKey {
    case asUser = "asUser"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let asUser {
      body["asUser"] = try RaviJSON.fromEncodable(asUser)
    }
  }
}

public typealias DevinSessionsSendReturn = RaviJSON

public struct DevinSessionsShowOptions: Codable, Sendable {
  public var sync: Bool?

  public init(sync: Bool? = nil) {
    self.sync = sync
  }

  enum CodingKeys: String, CodingKey {
    case sync = "sync"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let sync {
      body["sync"] = try RaviJSON.fromEncodable(sync)
    }
  }
}

public typealias DevinSessionsShowReturn = RaviJSON

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
    if let artifacts {
      body["artifacts"] = try RaviJSON.fromEncodable(artifacts)
    }
    if let insights {
      body["insights"] = try RaviJSON.fromEncodable(insights)
    }
  }
}

public typealias DevinSessionsSyncReturn = RaviJSON

public struct DevinSessionsTerminateOptions: Codable, Sendable {
  public var archive: Bool?

  public init(archive: Bool? = nil) {
    self.archive = archive
  }

  enum CodingKeys: String, CodingKey {
    case archive = "archive"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let archive {
      body["archive"] = try RaviJSON.fromEncodable(archive)
    }
  }
}

public typealias DevinSessionsTerminateReturn = RaviJSON

public struct EvalRunOptions: Codable, Sendable {
  public var output: String?

  public init(output: String? = nil) {
    self.output = output
  }

  enum CodingKeys: String, CodingKey {
    case output = "output"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let output {
      body["output"] = try RaviJSON.fromEncodable(output)
    }
  }
}

public typealias EvalRunReturn = RaviJSON

public typealias HeartbeatDisableReturn = RaviJSON

public typealias HeartbeatEnableReturn = RaviJSON

public typealias HeartbeatSetReturn = RaviJSON

public typealias HeartbeatShowReturn = RaviJSON

public typealias HeartbeatStatusReturn = RaviJSON

public typealias HeartbeatTriggerReturn = RaviJSON

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
    if let action {
      body["action"] = try RaviJSON.fromEncodable(action)
    }
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let async_ {
      body["async"] = try RaviJSON.fromEncodable(async_)
    }
    if let barrier {
      body["barrier"] = try RaviJSON.fromEncodable(barrier)
    }
    if let cooldown {
      body["cooldown"] = try RaviJSON.fromEncodable(cooldown)
    }
    if let dedupeKey {
      body["dedupeKey"] = try RaviJSON.fromEncodable(dedupeKey)
    }
    if let disabled {
      body["disabled"] = try RaviJSON.fromEncodable(disabled)
    }
    if let event {
      body["event"] = try RaviJSON.fromEncodable(event)
    }
    if let matcher {
      body["matcher"] = try RaviJSON.fromEncodable(matcher)
    }
    if let message {
      body["message"] = try RaviJSON.fromEncodable(message)
    }
    if let role {
      body["role"] = try RaviJSON.fromEncodable(role)
    }
    if let scope {
      body["scope"] = try RaviJSON.fromEncodable(scope)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let targetSession {
      body["targetSession"] = try RaviJSON.fromEncodable(targetSession)
    }
    if let targetTask {
      body["targetTask"] = try RaviJSON.fromEncodable(targetTask)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
    if let workspace {
      body["workspace"] = try RaviJSON.fromEncodable(workspace)
    }
  }
}

public typealias HooksCreateReturn = RaviJSON

public typealias HooksDisableReturn = RaviJSON

public typealias HooksEnableReturn = RaviJSON

public struct HooksListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias HooksListReturn = RaviJSON

public typealias HooksRmReturn = RaviJSON

public typealias HooksShowReturn = RaviJSON

public typealias HooksTestReturn = RaviJSON

public struct ImageAtlasSplitOptions: Codable, Sendable {
  public var account: String?
  public var background: String?
  public var caption: String?
  public var channel: String?
  public var cols: String?
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

  public init(account: String? = nil, background: String? = nil, caption: String? = nil, channel: String? = nil, cols: String? = nil, fit: String? = nil, fuzz: String? = nil, mode: String? = nil, names: String? = nil, output: String? = nil, pad: String? = nil, parentArtifact: String? = nil, rows: String? = nil, send: Bool? = nil, size: String? = nil, threadId: String? = nil, to: String? = nil) {
    self.account = account
    self.background = background
    self.caption = caption
    self.channel = channel
    self.cols = cols
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
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
    if let background {
      body["background"] = try RaviJSON.fromEncodable(background)
    }
    if let caption {
      body["caption"] = try RaviJSON.fromEncodable(caption)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let cols {
      body["cols"] = try RaviJSON.fromEncodable(cols)
    }
    if let fit {
      body["fit"] = try RaviJSON.fromEncodable(fit)
    }
    if let fuzz {
      body["fuzz"] = try RaviJSON.fromEncodable(fuzz)
    }
    if let mode {
      body["mode"] = try RaviJSON.fromEncodable(mode)
    }
    if let names {
      body["names"] = try RaviJSON.fromEncodable(names)
    }
    if let output {
      body["output"] = try RaviJSON.fromEncodable(output)
    }
    if let pad {
      body["pad"] = try RaviJSON.fromEncodable(pad)
    }
    if let parentArtifact {
      body["parentArtifact"] = try RaviJSON.fromEncodable(parentArtifact)
    }
    if let rows {
      body["rows"] = try RaviJSON.fromEncodable(rows)
    }
    if let send {
      body["send"] = try RaviJSON.fromEncodable(send)
    }
    if let size {
      body["size"] = try RaviJSON.fromEncodable(size)
    }
    if let threadId {
      body["threadId"] = try RaviJSON.fromEncodable(threadId)
    }
    if let to {
      body["to"] = try RaviJSON.fromEncodable(to)
    }
  }
}

public typealias ImageAtlasSplitReturn = RaviJSON

public struct ImageGenerateOptions: Codable, Sendable {
  public var artifactId: String?
  public var aspect: String?
  public var asyncWorker: Bool?
  public var async_: Bool?
  public var background: String?
  public var caption: String?
  public var compression: String?
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

  public init(artifactId: String? = nil, aspect: String? = nil, asyncWorker: Bool? = nil, async_: Bool? = nil, background: String? = nil, caption: String? = nil, compression: String? = nil, format: String? = nil, mode: String? = nil, model: String? = nil, output: String? = nil, provider: String? = nil, quality: String? = nil, send: Bool? = nil, size: String? = nil, source: String? = nil, sync: Bool? = nil) {
    self.artifactId = artifactId
    self.aspect = aspect
    self.asyncWorker = asyncWorker
    self.async_ = async_
    self.background = background
    self.caption = caption
    self.compression = compression
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
    if let artifactId {
      body["artifactId"] = try RaviJSON.fromEncodable(artifactId)
    }
    if let aspect {
      body["aspect"] = try RaviJSON.fromEncodable(aspect)
    }
    if let asyncWorker {
      body["asyncWorker"] = try RaviJSON.fromEncodable(asyncWorker)
    }
    if let async_ {
      body["async"] = try RaviJSON.fromEncodable(async_)
    }
    if let background {
      body["background"] = try RaviJSON.fromEncodable(background)
    }
    if let caption {
      body["caption"] = try RaviJSON.fromEncodable(caption)
    }
    if let compression {
      body["compression"] = try RaviJSON.fromEncodable(compression)
    }
    if let format {
      body["format"] = try RaviJSON.fromEncodable(format)
    }
    if let mode {
      body["mode"] = try RaviJSON.fromEncodable(mode)
    }
    if let model {
      body["model"] = try RaviJSON.fromEncodable(model)
    }
    if let output {
      body["output"] = try RaviJSON.fromEncodable(output)
    }
    if let provider {
      body["provider"] = try RaviJSON.fromEncodable(provider)
    }
    if let quality {
      body["quality"] = try RaviJSON.fromEncodable(quality)
    }
    if let send {
      body["send"] = try RaviJSON.fromEncodable(send)
    }
    if let size {
      body["size"] = try RaviJSON.fromEncodable(size)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
    if let sync {
      body["sync"] = try RaviJSON.fromEncodable(sync)
    }
  }
}

public typealias ImageGenerateReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let artifact {
      body["artifact"] = try RaviJSON.fromEncodable(artifact)
    }
    if let autoContext {
      body["autoContext"] = try RaviJSON.fromEncodable(autoContext)
    }
    if let comment {
      body["comment"] = try RaviJSON.fromEncodable(comment)
    }
    if let confidence {
      body["confidence"] = try RaviJSON.fromEncodable(confidence)
    }
    if let detail {
      body["detail"] = try RaviJSON.fromEncodable(detail)
    }
    if let importance {
      body["importance"] = try RaviJSON.fromEncodable(importance)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
    if let linkId {
      body["linkId"] = try RaviJSON.fromEncodable(linkId)
    }
    if let linkType {
      body["linkType"] = try RaviJSON.fromEncodable(linkType)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
  }
}

public typealias InsightsCreateReturn = RaviJSON

public struct InsightsListOptions: Codable, Sendable {
  public var agent: String?
  public var confidence: String?
  public var importance: String?
  public var kind: String?
  public var limit: String?
  public var profile: String?
  public var query: String?
  public var rich: Bool?
  public var session: String?
  public var tag: String?
  public var task: String?

  public init(agent: String? = nil, confidence: String? = nil, importance: String? = nil, kind: String? = nil, limit: String? = nil, profile: String? = nil, query: String? = nil, rich: Bool? = nil, session: String? = nil, tag: String? = nil, task: String? = nil) {
    self.agent = agent
    self.confidence = confidence
    self.importance = importance
    self.kind = kind
    self.limit = limit
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
    case importance = "importance"
    case kind = "kind"
    case limit = "limit"
    case profile = "profile"
    case query = "query"
    case rich = "rich"
    case session = "session"
    case tag = "tag"
    case task = "task"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let confidence {
      body["confidence"] = try RaviJSON.fromEncodable(confidence)
    }
    if let importance {
      body["importance"] = try RaviJSON.fromEncodable(importance)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let query {
      body["query"] = try RaviJSON.fromEncodable(query)
    }
    if let rich {
      body["rich"] = try RaviJSON.fromEncodable(rich)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
  }
}

public typealias InsightsListReturn = RaviJSON

public struct InsightsSearchOptions: Codable, Sendable {
  public var limit: String?

  public init(limit: String? = nil) {
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
  }
}

public typealias InsightsSearchReturn = RaviJSON

public typealias InsightsShowReturn = RaviJSON

public struct InstancesCreateOptions: Codable, Sendable {
  public var agent: String?
  public var channel: String?
  public var dmPolicy: String?
  public var groupPolicy: String?

  public init(agent: String? = nil, channel: String? = nil, dmPolicy: String? = nil, groupPolicy: String? = nil) {
    self.agent = agent
    self.channel = channel
    self.dmPolicy = dmPolicy
    self.groupPolicy = groupPolicy
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case channel = "channel"
    case dmPolicy = "dmPolicy"
    case groupPolicy = "groupPolicy"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let dmPolicy {
      body["dmPolicy"] = try RaviJSON.fromEncodable(dmPolicy)
    }
    if let groupPolicy {
      body["groupPolicy"] = try RaviJSON.fromEncodable(groupPolicy)
    }
  }
}

public typealias InstancesCreateReturn = RaviJSON

public typealias InstancesDeleteReturn = RaviJSON

public typealias InstancesDeletedReturn = RaviJSON

public typealias InstancesDisableReturn = RaviJSON

public typealias InstancesDisconnectReturn = RaviJSON

public typealias InstancesEnableReturn = RaviJSON

public typealias InstancesGetReturn = RaviJSON

public struct InstancesListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias InstancesListReturn = RaviJSON

public struct InstancesPendingApproveOptions: Codable, Sendable {
  public var agent: String?

  public init(agent: String? = nil) {
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
  }
}

public typealias InstancesPendingApproveReturn = RaviJSON

public typealias InstancesPendingListReturn = RaviJSON

public typealias InstancesPendingRejectReturn = RaviJSON

public typealias InstancesRestoreReturn = RaviJSON

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
    if let allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(allowRuntimeMismatch)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let dmScope {
      body["dmScope"] = try RaviJSON.fromEncodable(dmScope)
    }
    if let policy {
      body["policy"] = try RaviJSON.fromEncodable(policy)
    }
    if let priority {
      body["priority"] = try RaviJSON.fromEncodable(priority)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
  }
}

public typealias InstancesRoutesAddReturn = RaviJSON

public typealias InstancesRoutesDeletedReturn = RaviJSON

public struct InstancesRoutesListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias InstancesRoutesListReturn = RaviJSON

public struct InstancesRoutesRemoveOptions: Codable, Sendable {
  public var allowRuntimeMismatch: Bool?

  public init(allowRuntimeMismatch: Bool? = nil) {
    self.allowRuntimeMismatch = allowRuntimeMismatch
  }

  enum CodingKeys: String, CodingKey {
    case allowRuntimeMismatch = "allowRuntimeMismatch"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(allowRuntimeMismatch)
    }
  }
}

public typealias InstancesRoutesRemoveReturn = RaviJSON

public struct InstancesRoutesRestoreOptions: Codable, Sendable {
  public var allowRuntimeMismatch: Bool?

  public init(allowRuntimeMismatch: Bool? = nil) {
    self.allowRuntimeMismatch = allowRuntimeMismatch
  }

  enum CodingKeys: String, CodingKey {
    case allowRuntimeMismatch = "allowRuntimeMismatch"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(allowRuntimeMismatch)
    }
  }
}

public typealias InstancesRoutesRestoreReturn = RaviJSON

public struct InstancesRoutesSetOptions: Codable, Sendable {
  public var allowRuntimeMismatch: Bool?

  public init(allowRuntimeMismatch: Bool? = nil) {
    self.allowRuntimeMismatch = allowRuntimeMismatch
  }

  enum CodingKeys: String, CodingKey {
    case allowRuntimeMismatch = "allowRuntimeMismatch"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let allowRuntimeMismatch {
      body["allowRuntimeMismatch"] = try RaviJSON.fromEncodable(allowRuntimeMismatch)
    }
  }
}

public typealias InstancesRoutesSetReturn = RaviJSON

public typealias InstancesRoutesShowReturn = RaviJSON

public typealias InstancesSetReturn = RaviJSON

public typealias InstancesShowReturn = RaviJSON

public typealias InstancesStatusReturn = RaviJSON

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
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let pattern {
      body["pattern"] = try RaviJSON.fromEncodable(pattern)
    }
  }
}

public typealias InstancesTargetReturn = RaviJSON

public struct MediaSendOptions: Codable, Sendable {
  public var account: String?
  public var caption: String?
  public var channel: String?
  public var ptt: Bool?
  public var threadId: String?
  public var to: String?

  public init(account: String? = nil, caption: String? = nil, channel: String? = nil, ptt: Bool? = nil, threadId: String? = nil, to: String? = nil) {
    self.account = account
    self.caption = caption
    self.channel = channel
    self.ptt = ptt
    self.threadId = threadId
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case caption = "caption"
    case channel = "channel"
    case ptt = "ptt"
    case threadId = "threadId"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
    if let caption {
      body["caption"] = try RaviJSON.fromEncodable(caption)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let ptt {
      body["ptt"] = try RaviJSON.fromEncodable(ptt)
    }
    if let threadId {
      body["threadId"] = try RaviJSON.fromEncodable(threadId)
    }
    if let to {
      body["to"] = try RaviJSON.fromEncodable(to)
    }
  }
}

public typealias MediaSendReturn = RaviJSON

public struct ObserversListOptions: Codable, Sendable {
  public var agent: String?
  public var session: String?

  public init(agent: String? = nil, session: String? = nil) {
    self.agent = agent
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
  }
}

public typealias ObserversListReturn = RaviJSON

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
    if let overwrite {
      body["overwrite"] = try RaviJSON.fromEncodable(overwrite)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
  }
}

public typealias ObserversProfilesInitReturn = RaviJSON

public typealias ObserversProfilesListReturn = RaviJSON

public struct ObserversProfilesPreviewOptions: Codable, Sendable {
  public var event: String?

  public init(event: String? = nil) {
    self.event = event
  }

  enum CodingKeys: String, CodingKey {
    case event = "event"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let event {
      body["event"] = try RaviJSON.fromEncodable(event)
    }
  }
}

public typealias ObserversProfilesPreviewReturn = RaviJSON

public typealias ObserversProfilesShowReturn = RaviJSON

public typealias ObserversProfilesValidateReturn = RaviJSON

public typealias ObserversRefreshReturn = RaviJSON

public typealias ObserversRulesDisableReturn = RaviJSON

public typealias ObserversRulesEnableReturn = RaviJSON

public typealias ObserversRulesExplainReturn = RaviJSON

public typealias ObserversRulesListReturn = RaviJSON

public typealias ObserversRulesRmReturn = RaviJSON

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
  public var sourceAgent: String?
  public var sourceProfile: String?
  public var sourceProject: String?
  public var sourceSession: String?
  public var sourceTask: String?
  public var tag: String?
  public var tagInherited: Bool?
  public var tagTarget: String?

  public init(delivery: String? = nil, disabled: Bool? = nil, events: String? = nil, meta: String? = nil, mode: String? = nil, model: String? = nil, permissions: String? = nil, priority: String? = nil, profile: String? = nil, provider: String? = nil, role: String? = nil, scope: String? = nil, sourceAgent: String? = nil, sourceProfile: String? = nil, sourceProject: String? = nil, sourceSession: String? = nil, sourceTask: String? = nil, tag: String? = nil, tagInherited: Bool? = nil, tagTarget: String? = nil) {
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
    if let delivery {
      body["delivery"] = try RaviJSON.fromEncodable(delivery)
    }
    if let disabled {
      body["disabled"] = try RaviJSON.fromEncodable(disabled)
    }
    if let events {
      body["events"] = try RaviJSON.fromEncodable(events)
    }
    if let meta {
      body["meta"] = try RaviJSON.fromEncodable(meta)
    }
    if let mode {
      body["mode"] = try RaviJSON.fromEncodable(mode)
    }
    if let model {
      body["model"] = try RaviJSON.fromEncodable(model)
    }
    if let permissions {
      body["permissions"] = try RaviJSON.fromEncodable(permissions)
    }
    if let priority {
      body["priority"] = try RaviJSON.fromEncodable(priority)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let provider {
      body["provider"] = try RaviJSON.fromEncodable(provider)
    }
    if let role {
      body["role"] = try RaviJSON.fromEncodable(role)
    }
    if let scope {
      body["scope"] = try RaviJSON.fromEncodable(scope)
    }
    if let sourceAgent {
      body["sourceAgent"] = try RaviJSON.fromEncodable(sourceAgent)
    }
    if let sourceProfile {
      body["sourceProfile"] = try RaviJSON.fromEncodable(sourceProfile)
    }
    if let sourceProject {
      body["sourceProject"] = try RaviJSON.fromEncodable(sourceProject)
    }
    if let sourceSession {
      body["sourceSession"] = try RaviJSON.fromEncodable(sourceSession)
    }
    if let sourceTask {
      body["sourceTask"] = try RaviJSON.fromEncodable(sourceTask)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
    if let tagInherited {
      body["tagInherited"] = try RaviJSON.fromEncodable(tagInherited)
    }
    if let tagTarget {
      body["tagTarget"] = try RaviJSON.fromEncodable(tagTarget)
    }
  }
}

public typealias ObserversRulesSetReturn = RaviJSON

public typealias ObserversRulesShowReturn = RaviJSON

public typealias ObserversRulesValidateReturn = RaviJSON

public typealias ObserversShowReturn = RaviJSON

public typealias PermissionsCheckReturn = RaviJSON

public struct PermissionsClearOptions: Codable, Sendable {
  public var all: Bool?

  public init(all: Bool? = nil) {
    self.all = all
  }

  enum CodingKeys: String, CodingKey {
    case all = "all"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let all {
      body["all"] = try RaviJSON.fromEncodable(all)
    }
  }
}

public typealias PermissionsClearReturn = RaviJSON

public typealias PermissionsGrantReturn = RaviJSON

public typealias PermissionsInitReturn = RaviJSON

public struct PermissionsListOptions: Codable, Sendable {
  public var object: String?
  public var relation: String?
  public var source: String?
  public var subject: String?

  public init(object: String? = nil, relation: String? = nil, source: String? = nil, subject: String? = nil) {
    self.object = object
    self.relation = relation
    self.source = source
    self.subject = subject
  }

  enum CodingKeys: String, CodingKey {
    case object = "object"
    case relation = "relation"
    case source = "source"
    case subject = "subject"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let object {
      body["object"] = try RaviJSON.fromEncodable(object)
    }
    if let relation {
      body["relation"] = try RaviJSON.fromEncodable(relation)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
    if let subject {
      body["subject"] = try RaviJSON.fromEncodable(subject)
    }
  }
}

public typealias PermissionsListReturn = RaviJSON

public typealias PermissionsRevokeReturn = RaviJSON

public typealias PermissionsSyncReturn = RaviJSON

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
    if let hypothesis {
      body["hypothesis"] = try RaviJSON.fromEncodable(hypothesis)
    }
    if let lastSignalAt {
      body["lastSignalAt"] = try RaviJSON.fromEncodable(lastSignalAt)
    }
    if let nextStep {
      body["nextStep"] = try RaviJSON.fromEncodable(nextStep)
    }
    if let ownerAgent {
      body["ownerAgent"] = try RaviJSON.fromEncodable(ownerAgent)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let slug {
      body["slug"] = try RaviJSON.fromEncodable(slug)
    }
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
    if let summary {
      body["summary"] = try RaviJSON.fromEncodable(summary)
    }
  }
}

public typealias ProjectsCreateReturn = RaviJSON

public struct ProjectsFixturesSeedOptions: Codable, Sendable {
  public var ownerAgent: String?

  public init(ownerAgent: String? = nil) {
    self.ownerAgent = ownerAgent
  }

  enum CodingKeys: String, CodingKey {
    case ownerAgent = "ownerAgent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let ownerAgent {
      body["ownerAgent"] = try RaviJSON.fromEncodable(ownerAgent)
    }
  }
}

public typealias ProjectsFixturesSeedReturn = RaviJSON

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
    if let hypothesis {
      body["hypothesis"] = try RaviJSON.fromEncodable(hypothesis)
    }
    if let lastSignalAt {
      body["lastSignalAt"] = try RaviJSON.fromEncodable(lastSignalAt)
    }
    if let nextStep {
      body["nextStep"] = try RaviJSON.fromEncodable(nextStep)
    }
    if let ownerAgent {
      body["ownerAgent"] = try RaviJSON.fromEncodable(ownerAgent)
    }
    if let resource {
      body["resource"] = try RaviJSON.fromEncodable(resource)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let slug {
      body["slug"] = try RaviJSON.fromEncodable(slug)
    }
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
    if let summary {
      body["summary"] = try RaviJSON.fromEncodable(summary)
    }
    if let workflowRun {
      body["workflowRun"] = try RaviJSON.fromEncodable(workflowRun)
    }
    if let workflowTemplate {
      body["workflowTemplate"] = try RaviJSON.fromEncodable(workflowTemplate)
    }
  }
}

public typealias ProjectsInitReturn = RaviJSON

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
    if let label {
      body["label"] = try RaviJSON.fromEncodable(label)
    }
    if let meta {
      body["meta"] = try RaviJSON.fromEncodable(meta)
    }
    if let resourceType {
      body["resourceType"] = try RaviJSON.fromEncodable(resourceType)
    }
    if let role {
      body["role"] = try RaviJSON.fromEncodable(role)
    }
  }
}

public typealias ProjectsLinkReturn = RaviJSON

public struct ProjectsListOptions: Codable, Sendable {
  public var status: String?
  public var tag: String?

  public init(status: String? = nil, tag: String? = nil) {
    self.status = status
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case status = "status"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias ProjectsListReturn = RaviJSON

public struct ProjectsNextOptions: Codable, Sendable {
  public var status: String?
  public var tag: String?

  public init(status: String? = nil, tag: String? = nil) {
    self.status = status
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case status = "status"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias ProjectsNextReturn = RaviJSON

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
    if let label {
      body["label"] = try RaviJSON.fromEncodable(label)
    }
    if let meta {
      body["meta"] = try RaviJSON.fromEncodable(meta)
    }
    if let role {
      body["role"] = try RaviJSON.fromEncodable(role)
    }
    if let type {
      body["type"] = try RaviJSON.fromEncodable(type)
    }
  }
}

public typealias ProjectsResourcesAddReturn = RaviJSON

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
    if let group {
      body["group"] = try RaviJSON.fromEncodable(group)
    }
    if let meta {
      body["meta"] = try RaviJSON.fromEncodable(meta)
    }
    if let repo {
      body["repo"] = try RaviJSON.fromEncodable(repo)
    }
    if let role {
      body["role"] = try RaviJSON.fromEncodable(role)
    }
    if let url {
      body["url"] = try RaviJSON.fromEncodable(url)
    }
    if let worktree {
      body["worktree"] = try RaviJSON.fromEncodable(worktree)
    }
  }
}

public typealias ProjectsResourcesImportReturn = RaviJSON

public struct ProjectsResourcesListOptions: Codable, Sendable {
  public var type: String?

  public init(type: String? = nil) {
    self.type = type
  }

  enum CodingKeys: String, CodingKey {
    case type = "type"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let type {
      body["type"] = try RaviJSON.fromEncodable(type)
    }
  }
}

public typealias ProjectsResourcesListReturn = RaviJSON

public typealias ProjectsResourcesShowReturn = RaviJSON

public typealias ProjectsShowReturn = RaviJSON

public typealias ProjectsStatusReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let dispatch {
      body["dispatch"] = try RaviJSON.fromEncodable(dispatch)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let workflow {
      body["workflow"] = try RaviJSON.fromEncodable(workflow)
    }
  }
}

public typealias ProjectsTasksAttachReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let dispatch {
      body["dispatch"] = try RaviJSON.fromEncodable(dispatch)
    }
    if let instructions {
      body["instructions"] = try RaviJSON.fromEncodable(instructions)
    }
    if let priority {
      body["priority"] = try RaviJSON.fromEncodable(priority)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let workflow {
      body["workflow"] = try RaviJSON.fromEncodable(workflow)
    }
  }
}

public typealias ProjectsTasksCreateReturn = RaviJSON

public struct ProjectsTasksDispatchOptions: Codable, Sendable {
  public var agent: String?
  public var session: String?

  public init(agent: String? = nil, session: String? = nil) {
    self.agent = agent
    self.session = session
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case session = "session"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
  }
}

public typealias ProjectsTasksDispatchReturn = RaviJSON

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
    if let hypothesis {
      body["hypothesis"] = try RaviJSON.fromEncodable(hypothesis)
    }
    if let lastSignalAt {
      body["lastSignalAt"] = try RaviJSON.fromEncodable(lastSignalAt)
    }
    if let nextStep {
      body["nextStep"] = try RaviJSON.fromEncodable(nextStep)
    }
    if let ownerAgent {
      body["ownerAgent"] = try RaviJSON.fromEncodable(ownerAgent)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
    if let summary {
      body["summary"] = try RaviJSON.fromEncodable(summary)
    }
    if let title {
      body["title"] = try RaviJSON.fromEncodable(title)
    }
    if let touchSignal {
      body["touchSignal"] = try RaviJSON.fromEncodable(touchSignal)
    }
  }
}

public typealias ProjectsUpdateReturn = RaviJSON

public struct ProjectsWorkflowsAttachOptions: Codable, Sendable {
  public var role: String?

  public init(role: String? = nil) {
    self.role = role
  }

  enum CodingKeys: String, CodingKey {
    case role = "role"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let role {
      body["role"] = try RaviJSON.fromEncodable(role)
    }
  }
}

public typealias ProjectsWorkflowsAttachReturn = RaviJSON

public struct ProjectsWorkflowsStartOptions: Codable, Sendable {
  public var role: String?
  public var runId: String?

  public init(role: String? = nil, runId: String? = nil) {
    self.role = role
    self.runId = runId
  }

  enum CodingKeys: String, CodingKey {
    case role = "role"
    case runId = "runId"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let role {
      body["role"] = try RaviJSON.fromEncodable(role)
    }
    if let runId {
      body["runId"] = try RaviJSON.fromEncodable(runId)
    }
  }
}

public typealias ProjectsWorkflowsStartReturn = RaviJSON

public struct ProxCallsCancelOptions: Codable, Sendable {
  public var reason: String?

  public init(reason: String? = nil) {
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let reason {
      body["reason"] = try RaviJSON.fromEncodable(reason)
    }
  }
}

public typealias ProxCallsCancelReturn = RaviJSON

public typealias ProxCallsEventsReturn = RaviJSON

public struct ProxCallsProfilesConfigureOptions: Codable, Sendable {
  public var agentId: String?
  public var dynamicPlaceholder: [String]?
  public var firstMessage: String?
  public var language: String?
  public var prompt: String?
  public var provider: String?
  public var skipProviderSync: Bool?
  public var systemPromptPath: String?
  public var twilioNumberId: String?
  public var voicemailPolicy: String?

  public init(agentId: String? = nil, dynamicPlaceholder: [String]? = nil, firstMessage: String? = nil, language: String? = nil, prompt: String? = nil, provider: String? = nil, skipProviderSync: Bool? = nil, systemPromptPath: String? = nil, twilioNumberId: String? = nil, voicemailPolicy: String? = nil) {
    self.agentId = agentId
    self.dynamicPlaceholder = dynamicPlaceholder
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
    if let agentId {
      body["agentId"] = try RaviJSON.fromEncodable(agentId)
    }
    if let dynamicPlaceholder {
      body["dynamicPlaceholder"] = try RaviJSON.fromEncodable(dynamicPlaceholder)
    }
    if let firstMessage {
      body["firstMessage"] = try RaviJSON.fromEncodable(firstMessage)
    }
    if let language {
      body["language"] = try RaviJSON.fromEncodable(language)
    }
    if let prompt {
      body["prompt"] = try RaviJSON.fromEncodable(prompt)
    }
    if let provider {
      body["provider"] = try RaviJSON.fromEncodable(provider)
    }
    if let skipProviderSync {
      body["skipProviderSync"] = try RaviJSON.fromEncodable(skipProviderSync)
    }
    if let systemPromptPath {
      body["systemPromptPath"] = try RaviJSON.fromEncodable(systemPromptPath)
    }
    if let twilioNumberId {
      body["twilioNumberId"] = try RaviJSON.fromEncodable(twilioNumberId)
    }
    if let voicemailPolicy {
      body["voicemailPolicy"] = try RaviJSON.fromEncodable(voicemailPolicy)
    }
  }
}

public typealias ProxCallsProfilesConfigureReturn = RaviJSON

public struct ProxCallsProfilesListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias ProxCallsProfilesListReturn = RaviJSON

public typealias ProxCallsProfilesShowReturn = RaviJSON

public struct ProxCallsRequestOptions: Codable, Sendable {
  public var force: Bool?
  public var person: String?
  public var phone: String?
  public var priority: String?
  public var profile: String?
  public var reason: String?
  public var skipOriginNotify: Bool?
  public var var_: [String]?

  public init(force: Bool? = nil, person: String? = nil, phone: String? = nil, priority: String? = nil, profile: String? = nil, reason: String? = nil, skipOriginNotify: Bool? = nil, var_: [String]? = nil) {
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
    if let force {
      body["force"] = try RaviJSON.fromEncodable(force)
    }
    if let person {
      body["person"] = try RaviJSON.fromEncodable(person)
    }
    if let phone {
      body["phone"] = try RaviJSON.fromEncodable(phone)
    }
    if let priority {
      body["priority"] = try RaviJSON.fromEncodable(priority)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let reason {
      body["reason"] = try RaviJSON.fromEncodable(reason)
    }
    if let skipOriginNotify {
      body["skipOriginNotify"] = try RaviJSON.fromEncodable(skipOriginNotify)
    }
    if let var_ {
      body["var"] = try RaviJSON.fromEncodable(var_)
    }
  }
}

public typealias ProxCallsRequestReturn = RaviJSON

public struct ProxCallsRulesOptions: Codable, Sendable {
  public var scope: String?

  public init(scope: String? = nil) {
    self.scope = scope
  }

  enum CodingKeys: String, CodingKey {
    case scope = "scope"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let scope {
      body["scope"] = try RaviJSON.fromEncodable(scope)
    }
  }
}

public typealias ProxCallsRulesReturn = RaviJSON

public typealias ProxCallsShowReturn = RaviJSON

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
    if let providerToolName {
      body["providerToolName"] = try RaviJSON.fromEncodable(providerToolName)
    }
    if let required {
      body["required"] = try RaviJSON.fromEncodable(required)
    }
    if let toolPrompt {
      body["toolPrompt"] = try RaviJSON.fromEncodable(toolPrompt)
    }
  }
}

public typealias ProxCallsToolsBindReturn = RaviJSON

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
    if let enabled {
      body["enabled"] = try RaviJSON.fromEncodable(enabled)
    }
    if let timeoutMs {
      body["timeoutMs"] = try RaviJSON.fromEncodable(timeoutMs)
    }
  }
}

public typealias ProxCallsToolsConfigureReturn = RaviJSON

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
    if let description {
      body["description"] = try RaviJSON.fromEncodable(description)
    }
    if let executor {
      body["executor"] = try RaviJSON.fromEncodable(executor)
    }
    if let inputSchema {
      body["inputSchema"] = try RaviJSON.fromEncodable(inputSchema)
    }
    if let name {
      body["name"] = try RaviJSON.fromEncodable(name)
    }
    if let outputSchema {
      body["outputSchema"] = try RaviJSON.fromEncodable(outputSchema)
    }
    if let sideEffect {
      body["sideEffect"] = try RaviJSON.fromEncodable(sideEffect)
    }
  }
}

public typealias ProxCallsToolsCreateReturn = RaviJSON

public struct ProxCallsToolsListOptions: Codable, Sendable {
  public var profile: String?
  public var tag: String?

  public init(profile: String? = nil, tag: String? = nil) {
    self.profile = profile
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case profile = "profile"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias ProxCallsToolsListReturn = RaviJSON

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
    if let dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(dryRun)
    }
    if let input {
      body["input"] = try RaviJSON.fromEncodable(input)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
  }
}

public typealias ProxCallsToolsRunReturn = RaviJSON

public typealias ProxCallsToolsRunsReturn = RaviJSON

public typealias ProxCallsToolsShowReturn = RaviJSON

public typealias ProxCallsToolsUnbindReturn = RaviJSON

public struct ProxCallsTranscriptOptions: Codable, Sendable {
  public var sync: Bool?

  public init(sync: Bool? = nil) {
    self.sync = sync
  }

  enum CodingKeys: String, CodingKey {
    case sync = "sync"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let sync {
      body["sync"] = try RaviJSON.fromEncodable(sync)
    }
  }
}

public typealias ProxCallsTranscriptReturn = RaviJSON

public struct ProxCallsVoiceAgentsBindToolOptions: Codable, Sendable {
  public var providerToolName: String?

  public init(providerToolName: String? = nil) {
    self.providerToolName = providerToolName
  }

  enum CodingKeys: String, CodingKey {
    case providerToolName = "providerToolName"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let providerToolName {
      body["providerToolName"] = try RaviJSON.fromEncodable(providerToolName)
    }
  }
}

public typealias ProxCallsVoiceAgentsBindToolReturn = RaviJSON

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
    if let firstMessage {
      body["firstMessage"] = try RaviJSON.fromEncodable(firstMessage)
    }
    if let providerAgentId {
      body["providerAgentId"] = try RaviJSON.fromEncodable(providerAgentId)
    }
    if let systemPromptPath {
      body["systemPromptPath"] = try RaviJSON.fromEncodable(systemPromptPath)
    }
    if let voiceId {
      body["voiceId"] = try RaviJSON.fromEncodable(voiceId)
    }
  }
}

public typealias ProxCallsVoiceAgentsConfigureReturn = RaviJSON

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
    if let name {
      body["name"] = try RaviJSON.fromEncodable(name)
    }
    if let provider {
      body["provider"] = try RaviJSON.fromEncodable(provider)
    }
    if let systemPromptPath {
      body["systemPromptPath"] = try RaviJSON.fromEncodable(systemPromptPath)
    }
    if let voiceId {
      body["voiceId"] = try RaviJSON.fromEncodable(voiceId)
    }
  }
}

public typealias ProxCallsVoiceAgentsCreateReturn = RaviJSON

public struct ProxCallsVoiceAgentsListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias ProxCallsVoiceAgentsListReturn = RaviJSON

public typealias ProxCallsVoiceAgentsShowReturn = RaviJSON

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
    if let dryRun {
      body["dryRun"] = try RaviJSON.fromEncodable(dryRun)
    }
    if let provider {
      body["provider"] = try RaviJSON.fromEncodable(provider)
    }
  }
}

public typealias ProxCallsVoiceAgentsSyncReturn = RaviJSON

public typealias ProxCallsVoiceAgentsUnbindToolReturn = RaviJSON

public typealias ReactSendReturn = RaviJSON

public struct RoutesExplainOptions: Codable, Sendable {
  public var channel: String?

  public init(channel: String? = nil) {
    self.channel = channel
  }

  enum CodingKeys: String, CodingKey {
    case channel = "channel"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
  }
}

public typealias RoutesExplainReturn = RaviJSON

public struct RoutesListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias RoutesListReturn = RaviJSON

public typealias RoutesShowReturn = RaviJSON

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
    if let out {
      body["out"] = try RaviJSON.fromEncodable(out)
    }
    if let version {
      body["version"] = try RaviJSON.fromEncodable(version)
    }
  }
}

public typealias SdkClientCheckReturn = RaviJSON

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
    if let out {
      body["out"] = try RaviJSON.fromEncodable(out)
    }
    if let version {
      body["version"] = try RaviJSON.fromEncodable(version)
    }
  }
}

public typealias SdkClientGenerateReturn = RaviJSON

public struct SdkOpenapiCheckOptions: Codable, Sendable {
  public var against: String?

  public init(against: String? = nil) {
    self.against = against
  }

  enum CodingKeys: String, CodingKey {
    case against = "against"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let against {
      body["against"] = try RaviJSON.fromEncodable(against)
    }
  }
}

public typealias SdkOpenapiCheckReturn = RaviJSON

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
    if let out {
      body["out"] = try RaviJSON.fromEncodable(out)
    }
    if let stdout {
      body["stdout"] = try RaviJSON.fromEncodable(stdout)
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
    if let out {
      body["out"] = try RaviJSON.fromEncodable(out)
    }
    if let version {
      body["version"] = try RaviJSON.fromEncodable(version)
    }
  }
}

public typealias SdkSwiftCheckReturn = RaviJSON

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
    if let out {
      body["out"] = try RaviJSON.fromEncodable(out)
    }
    if let version {
      body["version"] = try RaviJSON.fromEncodable(version)
    }
  }
}

public typealias SdkSwiftGenerateReturn = RaviJSON

public struct SelfChatOptions: Codable, Sendable {
  public var depth: String?

  public init(depth: String? = nil) {
    self.depth = depth
  }

  enum CodingKeys: String, CodingKey {
    case depth = "depth"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let depth {
      body["depth"] = try RaviJSON.fromEncodable(depth)
    }
  }
}

public typealias SelfChatReturn = RaviJSON

public struct SelfContextOptions: Codable, Sendable {
  public var depth: String?
  public var limit: String?

  public init(depth: String? = nil, limit: String? = nil) {
    self.depth = depth
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case depth = "depth"
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let depth {
      body["depth"] = try RaviJSON.fromEncodable(depth)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
  }
}

public typealias SelfContextReturn = RaviJSON

public typealias SelfExplainReturn = RaviJSON

public typealias SelfKnowledgeReturn = RaviJSON

public typealias SelfPermissionsReturn = RaviJSON

public struct SelfRecentOptions: Codable, Sendable {
  public var limit: String?

  public init(limit: String? = nil) {
    self.limit = limit
  }

  enum CodingKeys: String, CodingKey {
    case limit = "limit"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
  }
}

public typealias SelfRecentReturn = RaviJSON

public typealias SelfRouteReturn = RaviJSON

public typealias SelfWhoamiReturn = RaviJSON

public typealias ServiceStartReturn = RaviJSON

public typealias ServiceTuiReturn = RaviJSON

public typealias ServiceWaReturn = RaviJSON

public struct SessionsAnswerOptions: Codable, Sendable {
  public var barrier: String?
  public var channel: String?
  public var to: String?

  public init(barrier: String? = nil, channel: String? = nil, to: String? = nil) {
    self.barrier = barrier
    self.channel = channel
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case barrier = "barrier"
    case channel = "channel"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let barrier {
      body["barrier"] = try RaviJSON.fromEncodable(barrier)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let to {
      body["to"] = try RaviJSON.fromEncodable(to)
    }
  }
}

public typealias SessionsAnswerReturn = RaviJSON

public struct SessionsAskOptions: Codable, Sendable {
  public var barrier: String?
  public var channel: String?
  public var to: String?

  public init(barrier: String? = nil, channel: String? = nil, to: String? = nil) {
    self.barrier = barrier
    self.channel = channel
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case barrier = "barrier"
    case channel = "channel"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let barrier {
      body["barrier"] = try RaviJSON.fromEncodable(barrier)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let to {
      body["to"] = try RaviJSON.fromEncodable(to)
    }
  }
}

public typealias SessionsAskReturn = RaviJSON

public typealias SessionsDeleteReturn = RaviJSON

public struct SessionsExecuteOptions: Codable, Sendable {
  public var barrier: String?
  public var channel: String?
  public var to: String?

  public init(barrier: String? = nil, channel: String? = nil, to: String? = nil) {
    self.barrier = barrier
    self.channel = channel
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case barrier = "barrier"
    case channel = "channel"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let barrier {
      body["barrier"] = try RaviJSON.fromEncodable(barrier)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let to {
      body["to"] = try RaviJSON.fromEncodable(to)
    }
  }
}

public typealias SessionsExecuteReturn = RaviJSON

public typealias SessionsExtendReturn = RaviJSON

public struct SessionsGoalOptions: Codable, Sendable {
  public var budget: String?
  public var project: String?
  public var seconds: String?
  public var task: String?
  public var tokens: String?

  public init(budget: String? = nil, project: String? = nil, seconds: String? = nil, task: String? = nil, tokens: String? = nil) {
    self.budget = budget
    self.project = project
    self.seconds = seconds
    self.task = task
    self.tokens = tokens
  }

  enum CodingKeys: String, CodingKey {
    case budget = "budget"
    case project = "project"
    case seconds = "seconds"
    case task = "task"
    case tokens = "tokens"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let budget {
      body["budget"] = try RaviJSON.fromEncodable(budget)
    }
    if let project {
      body["project"] = try RaviJSON.fromEncodable(project)
    }
    if let seconds {
      body["seconds"] = try RaviJSON.fromEncodable(seconds)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
    if let tokens {
      body["tokens"] = try RaviJSON.fromEncodable(tokens)
    }
  }
}

public typealias SessionsGoalReturn = RaviJSON

public typealias SessionsInfoReturn = RaviJSON

public struct SessionsInformOptions: Codable, Sendable {
  public var barrier: String?
  public var channel: String?
  public var to: String?

  public init(barrier: String? = nil, channel: String? = nil, to: String? = nil) {
    self.barrier = barrier
    self.channel = channel
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case barrier = "barrier"
    case channel = "channel"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let barrier {
      body["barrier"] = try RaviJSON.fromEncodable(barrier)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let to {
      body["to"] = try RaviJSON.fromEncodable(to)
    }
  }
}

public typealias SessionsInformReturn = RaviJSON

public typealias SessionsKeepReturn = RaviJSON

public struct SessionsListOptions: Codable, Sendable {
  public var agent: String?
  public var ephemeral: Bool?
  public var live: Bool?
  public var tag: String?

  public init(agent: String? = nil, ephemeral: Bool? = nil, live: Bool? = nil, tag: String? = nil) {
    self.agent = agent
    self.ephemeral = ephemeral
    self.live = live
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case ephemeral = "ephemeral"
    case live = "live"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let ephemeral {
      body["ephemeral"] = try RaviJSON.fromEncodable(ephemeral)
    }
    if let live {
      body["live"] = try RaviJSON.fromEncodable(live)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias SessionsListReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let ephemeral {
      body["ephemeral"] = try RaviJSON.fromEncodable(ephemeral)
    }
    if let execute {
      body["execute"] = try RaviJSON.fromEncodable(execute)
    }
    if let inactiveFor {
      body["inactiveFor"] = try RaviJSON.fromEncodable(inactiveFor)
    }
    if let namePrefix {
      body["namePrefix"] = try RaviJSON.fromEncodable(namePrefix)
    }
  }
}

public typealias SessionsPruneReturn = RaviJSON

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
    if let count {
      body["count"] = try RaviJSON.fromEncodable(count)
    }
    if let messageId {
      body["messageId"] = try RaviJSON.fromEncodable(messageId)
    }
    if let workspace {
      body["workspace"] = try RaviJSON.fromEncodable(workspace)
    }
  }
}

public typealias SessionsReadReturn = RaviJSON

public typealias SessionsRenameReturn = RaviJSON

public typealias SessionsResetReturn = RaviJSON

public struct SessionsRuntimeFollowUpOptions: Codable, Sendable {
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
    if let expectedTurn {
      body["expectedTurn"] = try RaviJSON.fromEncodable(expectedTurn)
    }
    if let thread {
      body["thread"] = try RaviJSON.fromEncodable(thread)
    }
    if let turn {
      body["turn"] = try RaviJSON.fromEncodable(turn)
    }
  }
}

public typealias SessionsRuntimeFollowUpReturn = RaviJSON

public struct SessionsRuntimeForkOptions: Codable, Sendable {
  public var cwd: String?
  public var path: String?

  public init(cwd: String? = nil, path: String? = nil) {
    self.cwd = cwd
    self.path = path
  }

  enum CodingKeys: String, CodingKey {
    case cwd = "cwd"
    case path = "path"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let cwd {
      body["cwd"] = try RaviJSON.fromEncodable(cwd)
    }
    if let path {
      body["path"] = try RaviJSON.fromEncodable(path)
    }
  }
}

public typealias SessionsRuntimeForkReturn = RaviJSON

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
    if let thread {
      body["thread"] = try RaviJSON.fromEncodable(thread)
    }
    if let turn {
      body["turn"] = try RaviJSON.fromEncodable(turn)
    }
  }
}

public typealias SessionsRuntimeInterruptReturn = RaviJSON

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
    if let archived {
      body["archived"] = try RaviJSON.fromEncodable(archived)
    }
    if let cursor {
      body["cursor"] = try RaviJSON.fromEncodable(cursor)
    }
    if let cwd {
      body["cwd"] = try RaviJSON.fromEncodable(cwd)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
    if let search {
      body["search"] = try RaviJSON.fromEncodable(search)
    }
  }
}

public typealias SessionsRuntimeListReturn = RaviJSON

public struct SessionsRuntimeReadOptions: Codable, Sendable {
  public var summaryOnly: Bool?

  public init(summaryOnly: Bool? = nil) {
    self.summaryOnly = summaryOnly
  }

  enum CodingKeys: String, CodingKey {
    case summaryOnly = "summaryOnly"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let summaryOnly {
      body["summaryOnly"] = try RaviJSON.fromEncodable(summaryOnly)
    }
  }
}

public typealias SessionsRuntimeReadReturn = RaviJSON

public struct SessionsRuntimeRollbackOptions: Codable, Sendable {
  public var thread: String?

  public init(thread: String? = nil) {
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey {
    case thread = "thread"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let thread {
      body["thread"] = try RaviJSON.fromEncodable(thread)
    }
  }
}

public typealias SessionsRuntimeRollbackReturn = RaviJSON

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
    if let expectedTurn {
      body["expectedTurn"] = try RaviJSON.fromEncodable(expectedTurn)
    }
    if let thread {
      body["thread"] = try RaviJSON.fromEncodable(thread)
    }
    if let turn {
      body["turn"] = try RaviJSON.fromEncodable(turn)
    }
  }
}

public typealias SessionsRuntimeSteerReturn = RaviJSON

public struct SessionsSendOptions: Codable, Sendable {
  public var agent: String?
  public var barrier: String?
  public var channel: String?
  public var interactive: Bool?
  public var to: String?
  public var wait: Bool?

  public init(agent: String? = nil, barrier: String? = nil, channel: String? = nil, interactive: Bool? = nil, to: String? = nil, wait: Bool? = nil) {
    self.agent = agent
    self.barrier = barrier
    self.channel = channel
    self.interactive = interactive
    self.to = to
    self.wait = wait
  }

  enum CodingKeys: String, CodingKey {
    case agent = "agent"
    case barrier = "barrier"
    case channel = "channel"
    case interactive = "interactive"
    case to = "to"
    case wait = "wait"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let barrier {
      body["barrier"] = try RaviJSON.fromEncodable(barrier)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let interactive {
      body["interactive"] = try RaviJSON.fromEncodable(interactive)
    }
    if let to {
      body["to"] = try RaviJSON.fromEncodable(to)
    }
    if let wait {
      body["wait"] = try RaviJSON.fromEncodable(wait)
    }
  }
}

public typealias SessionsSendReturn = RaviJSON

public typealias SessionsSetDisplayReturn = RaviJSON

public typealias SessionsSetModelReturn = RaviJSON

public typealias SessionsSetThinkingReturn = RaviJSON

public typealias SessionsSetTtlReturn = RaviJSON

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
    if let correlation {
      body["correlation"] = try RaviJSON.fromEncodable(correlation)
    }
    if let explain {
      body["explain"] = try RaviJSON.fromEncodable(explain)
    }
    if let includeStream {
      body["includeStream"] = try RaviJSON.fromEncodable(includeStream)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
    if let message {
      body["message"] = try RaviJSON.fromEncodable(message)
    }
    if let only {
      body["only"] = try RaviJSON.fromEncodable(only)
    }
    if let raw {
      body["raw"] = try RaviJSON.fromEncodable(raw)
    }
    if let run {
      body["run"] = try RaviJSON.fromEncodable(run)
    }
    if let showSystemPrompt {
      body["showSystemPrompt"] = try RaviJSON.fromEncodable(showSystemPrompt)
    }
    if let showUserPrompt {
      body["showUserPrompt"] = try RaviJSON.fromEncodable(showUserPrompt)
    }
    if let since {
      body["since"] = try RaviJSON.fromEncodable(since)
    }
    if let turn {
      body["turn"] = try RaviJSON.fromEncodable(turn)
    }
    if let until {
      body["until"] = try RaviJSON.fromEncodable(until)
    }
  }
}

public typealias SessionsTraceReturn = RaviJSON

public typealias SessionsVisibilityReturn = RaviJSON

public typealias SettingsDeleteReturn = RaviJSON

public typealias SettingsGetReturn = RaviJSON

public struct SettingsListOptions: Codable, Sendable {
  public var legacy: Bool?

  public init(legacy: Bool? = nil) {
    self.legacy = legacy
  }

  enum CodingKeys: String, CodingKey {
    case legacy = "legacy"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let legacy {
      body["legacy"] = try RaviJSON.fromEncodable(legacy)
    }
  }
}

public typealias SettingsListReturn = RaviJSON

public typealias SettingsSetReturn = RaviJSON

public typealias SkillGatesDisableReturn = RaviJSON

public typealias SkillGatesEnableReturn = RaviJSON

public struct SkillGatesListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias SkillGatesListReturn = RaviJSON

public typealias SkillGatesResetReturn = RaviJSON

public typealias SkillGatesRmReturn = RaviJSON

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
    if let command {
      body["command"] = try RaviJSON.fromEncodable(command)
    }
    if let commandPrefix {
      body["commandPrefix"] = try RaviJSON.fromEncodable(commandPrefix)
    }
    if let commandRegex {
      body["commandRegex"] = try RaviJSON.fromEncodable(commandRegex)
    }
    if let groupRegex {
      body["groupRegex"] = try RaviJSON.fromEncodable(groupRegex)
    }
    if let pattern {
      body["pattern"] = try RaviJSON.fromEncodable(pattern)
    }
    if let tool {
      body["tool"] = try RaviJSON.fromEncodable(tool)
    }
    if let toolPrefix {
      body["toolPrefix"] = try RaviJSON.fromEncodable(toolPrefix)
    }
    if let toolRegex {
      body["toolRegex"] = try RaviJSON.fromEncodable(toolRegex)
    }
  }
}

public typealias SkillGatesSetReturn = RaviJSON

public typealias SkillGatesShowReturn = RaviJSON

public struct SkillsInstallOptions: Codable, Sendable {
  public var all: Bool?
  public var overwrite: Bool?
  public var plugin: String?
  public var skill: String?
  public var skipCodexSync: Bool?
  public var source: String?

  public init(all: Bool? = nil, overwrite: Bool? = nil, plugin: String? = nil, skill: String? = nil, skipCodexSync: Bool? = nil, source: String? = nil) {
    self.all = all
    self.overwrite = overwrite
    self.plugin = plugin
    self.skill = skill
    self.skipCodexSync = skipCodexSync
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case all = "all"
    case overwrite = "overwrite"
    case plugin = "plugin"
    case skill = "skill"
    case skipCodexSync = "skipCodexSync"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let all {
      body["all"] = try RaviJSON.fromEncodable(all)
    }
    if let overwrite {
      body["overwrite"] = try RaviJSON.fromEncodable(overwrite)
    }
    if let plugin {
      body["plugin"] = try RaviJSON.fromEncodable(plugin)
    }
    if let skill {
      body["skill"] = try RaviJSON.fromEncodable(skill)
    }
    if let skipCodexSync {
      body["skipCodexSync"] = try RaviJSON.fromEncodable(skipCodexSync)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
  }
}

public typealias SkillsInstallReturn = RaviJSON

public struct SkillsListOptions: Codable, Sendable {
  public var codex: Bool?
  public var installed: Bool?
  public var source: String?
  public var tag: String?

  public init(codex: Bool? = nil, installed: Bool? = nil, source: String? = nil, tag: String? = nil) {
    self.codex = codex
    self.installed = installed
    self.source = source
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case codex = "codex"
    case installed = "installed"
    case source = "source"
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let codex {
      body["codex"] = try RaviJSON.fromEncodable(codex)
    }
    if let installed {
      body["installed"] = try RaviJSON.fromEncodable(installed)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias SkillsListReturn = RaviJSON

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
    if let installed {
      body["installed"] = try RaviJSON.fromEncodable(installed)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
  }
}

public typealias SkillsShowReturn = RaviJSON

public typealias SkillsSyncReturn = RaviJSON

public struct SpecsGetOptions: Codable, Sendable {
  public var mode: String?

  public init(mode: String? = nil) {
    self.mode = mode
  }

  enum CodingKeys: String, CodingKey {
    case mode = "mode"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let mode {
      body["mode"] = try RaviJSON.fromEncodable(mode)
    }
  }
}

public typealias SpecsGetReturn = RaviJSON

public struct SpecsListOptions: Codable, Sendable {
  public var domain: String?
  public var kind: String?

  public init(domain: String? = nil, kind: String? = nil) {
    self.domain = domain
    self.kind = kind
  }

  enum CodingKeys: String, CodingKey {
    case domain = "domain"
    case kind = "kind"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let domain {
      body["domain"] = try RaviJSON.fromEncodable(domain)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
  }
}

public typealias SpecsListReturn = RaviJSON

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
    if let full {
      body["full"] = try RaviJSON.fromEncodable(full)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
    if let title {
      body["title"] = try RaviJSON.fromEncodable(title)
    }
  }
}

public typealias SpecsNewReturn = RaviJSON

public typealias SpecsSyncReturn = RaviJSON

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
    if let agents {
      body["agents"] = try RaviJSON.fromEncodable(agents)
    }
    if let avoid {
      body["avoid"] = try RaviJSON.fromEncodable(avoid)
    }
    if let channels {
      body["channels"] = try RaviJSON.fromEncodable(channels)
    }
    if let description {
      body["description"] = try RaviJSON.fromEncodable(description)
    }
    if let disabled {
      body["disabled"] = try RaviJSON.fromEncodable(disabled)
    }
    if let label {
      body["label"] = try RaviJSON.fromEncodable(label)
    }
    if let overwrite {
      body["overwrite"] = try RaviJSON.fromEncodable(overwrite)
    }
  }
}

public typealias StickersAddReturn = RaviJSON

public typealias StickersListReturn = RaviJSON

public typealias StickersRemoveReturn = RaviJSON

public struct StickersSendOptions: Codable, Sendable {
  public var account: String?
  public var channel: String?
  public var session: String?
  public var to: String?

  public init(account: String? = nil, channel: String? = nil, session: String? = nil, to: String? = nil) {
    self.account = account
    self.channel = channel
    self.session = session
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case channel = "channel"
    case session = "session"
    case to = "to"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
    if let channel {
      body["channel"] = try RaviJSON.fromEncodable(channel)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let to {
      body["to"] = try RaviJSON.fromEncodable(to)
    }
  }
}

public typealias StickersSendReturn = RaviJSON

public typealias StickersShowReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let artifact {
      body["artifact"] = try RaviJSON.fromEncodable(artifact)
    }
    if let callProfile {
      body["callProfile"] = try RaviJSON.fromEncodable(callProfile)
    }
    if let callRequest {
      body["callRequest"] = try RaviJSON.fromEncodable(callRequest)
    }
    if let callTool {
      body["callTool"] = try RaviJSON.fromEncodable(callTool)
    }
    if let callVoiceAgent {
      body["callVoiceAgent"] = try RaviJSON.fromEncodable(callVoiceAgent)
    }
    if let chat {
      body["chat"] = try RaviJSON.fromEncodable(chat)
    }
    if let command {
      body["command"] = try RaviJSON.fromEncodable(command)
    }
    if let contact {
      body["contact"] = try RaviJSON.fromEncodable(contact)
    }
    if let cronJob {
      body["cronJob"] = try RaviJSON.fromEncodable(cronJob)
    }
    if let devinSession {
      body["devinSession"] = try RaviJSON.fromEncodable(devinSession)
    }
    if let hook {
      body["hook"] = try RaviJSON.fromEncodable(hook)
    }
    if let insight {
      body["insight"] = try RaviJSON.fromEncodable(insight)
    }
    if let instance {
      body["instance"] = try RaviJSON.fromEncodable(instance)
    }
    if let meta {
      body["meta"] = try RaviJSON.fromEncodable(meta)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let project {
      body["project"] = try RaviJSON.fromEncodable(project)
    }
    if let route {
      body["route"] = try RaviJSON.fromEncodable(route)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let skill {
      body["skill"] = try RaviJSON.fromEncodable(skill)
    }
    if let skillGateRule {
      body["skillGateRule"] = try RaviJSON.fromEncodable(skillGateRule)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
    if let target {
      body["target"] = try RaviJSON.fromEncodable(target)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
    if let taskAutomation {
      body["taskAutomation"] = try RaviJSON.fromEncodable(taskAutomation)
    }
    if let trigger {
      body["trigger"] = try RaviJSON.fromEncodable(trigger)
    }
    if let workflowNode {
      body["workflowNode"] = try RaviJSON.fromEncodable(workflowNode)
    }
    if let workflowRun {
      body["workflowRun"] = try RaviJSON.fromEncodable(workflowRun)
    }
    if let workflowSpec {
      body["workflowSpec"] = try RaviJSON.fromEncodable(workflowSpec)
    }
  }
}

public typealias TagsAttachReturn = RaviJSON

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
    if let description {
      body["description"] = try RaviJSON.fromEncodable(description)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
    if let label {
      body["label"] = try RaviJSON.fromEncodable(label)
    }
    if let meta {
      body["meta"] = try RaviJSON.fromEncodable(meta)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
  }
}

public typealias TagsCreateReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let artifact {
      body["artifact"] = try RaviJSON.fromEncodable(artifact)
    }
    if let callProfile {
      body["callProfile"] = try RaviJSON.fromEncodable(callProfile)
    }
    if let callRequest {
      body["callRequest"] = try RaviJSON.fromEncodable(callRequest)
    }
    if let callTool {
      body["callTool"] = try RaviJSON.fromEncodable(callTool)
    }
    if let callVoiceAgent {
      body["callVoiceAgent"] = try RaviJSON.fromEncodable(callVoiceAgent)
    }
    if let chat {
      body["chat"] = try RaviJSON.fromEncodable(chat)
    }
    if let command {
      body["command"] = try RaviJSON.fromEncodable(command)
    }
    if let contact {
      body["contact"] = try RaviJSON.fromEncodable(contact)
    }
    if let cronJob {
      body["cronJob"] = try RaviJSON.fromEncodable(cronJob)
    }
    if let devinSession {
      body["devinSession"] = try RaviJSON.fromEncodable(devinSession)
    }
    if let hook {
      body["hook"] = try RaviJSON.fromEncodable(hook)
    }
    if let insight {
      body["insight"] = try RaviJSON.fromEncodable(insight)
    }
    if let instance {
      body["instance"] = try RaviJSON.fromEncodable(instance)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let project {
      body["project"] = try RaviJSON.fromEncodable(project)
    }
    if let route {
      body["route"] = try RaviJSON.fromEncodable(route)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let skill {
      body["skill"] = try RaviJSON.fromEncodable(skill)
    }
    if let skillGateRule {
      body["skillGateRule"] = try RaviJSON.fromEncodable(skillGateRule)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
    if let target {
      body["target"] = try RaviJSON.fromEncodable(target)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
    if let taskAutomation {
      body["taskAutomation"] = try RaviJSON.fromEncodable(taskAutomation)
    }
    if let trigger {
      body["trigger"] = try RaviJSON.fromEncodable(trigger)
    }
    if let workflowNode {
      body["workflowNode"] = try RaviJSON.fromEncodable(workflowNode)
    }
    if let workflowRun {
      body["workflowRun"] = try RaviJSON.fromEncodable(workflowRun)
    }
    if let workflowSpec {
      body["workflowSpec"] = try RaviJSON.fromEncodable(workflowSpec)
    }
  }
}

public typealias TagsDetachReturn = RaviJSON

public struct TagsListOptions: Codable, Sendable {
  public var cursor: String?
  public var kind: String?
  public var limit: String?
  public var order: String?
  public var query: String?
  public var sort: String?
  public var source: String?

  public init(cursor: String? = nil, kind: String? = nil, limit: String? = nil, order: String? = nil, query: String? = nil, sort: String? = nil, source: String? = nil) {
    self.cursor = cursor
    self.kind = kind
    self.limit = limit
    self.order = order
    self.query = query
    self.sort = sort
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case cursor = "cursor"
    case kind = "kind"
    case limit = "limit"
    case order = "order"
    case query = "query"
    case sort = "sort"
    case source = "source"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let cursor {
      body["cursor"] = try RaviJSON.fromEncodable(cursor)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
    if let order {
      body["order"] = try RaviJSON.fromEncodable(order)
    }
    if let query {
      body["query"] = try RaviJSON.fromEncodable(query)
    }
    if let sort {
      body["sort"] = try RaviJSON.fromEncodable(sort)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
  }
}

public typealias TagsListReturn = RaviJSON

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

  public init(agent: String? = nil, artifact: String? = nil, callProfile: String? = nil, callRequest: String? = nil, callTool: String? = nil, callVoiceAgent: String? = nil, chat: String? = nil, command: String? = nil, contact: String? = nil, cronJob: String? = nil, cursor: String? = nil, devinSession: String? = nil, hook: String? = nil, insight: String? = nil, instance: String? = nil, kind: String? = nil, limit: String? = nil, order: String? = nil, profile: String? = nil, project: String? = nil, route: String? = nil, session: String? = nil, skill: String? = nil, skillGateRule: String? = nil, sort: String? = nil, source: String? = nil, tag: String? = nil, target: String? = nil, task: String? = nil, taskAutomation: String? = nil, trigger: String? = nil, workflowNode: String? = nil, workflowRun: String? = nil, workflowSpec: String? = nil) {
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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let artifact {
      body["artifact"] = try RaviJSON.fromEncodable(artifact)
    }
    if let callProfile {
      body["callProfile"] = try RaviJSON.fromEncodable(callProfile)
    }
    if let callRequest {
      body["callRequest"] = try RaviJSON.fromEncodable(callRequest)
    }
    if let callTool {
      body["callTool"] = try RaviJSON.fromEncodable(callTool)
    }
    if let callVoiceAgent {
      body["callVoiceAgent"] = try RaviJSON.fromEncodable(callVoiceAgent)
    }
    if let chat {
      body["chat"] = try RaviJSON.fromEncodable(chat)
    }
    if let command {
      body["command"] = try RaviJSON.fromEncodable(command)
    }
    if let contact {
      body["contact"] = try RaviJSON.fromEncodable(contact)
    }
    if let cronJob {
      body["cronJob"] = try RaviJSON.fromEncodable(cronJob)
    }
    if let cursor {
      body["cursor"] = try RaviJSON.fromEncodable(cursor)
    }
    if let devinSession {
      body["devinSession"] = try RaviJSON.fromEncodable(devinSession)
    }
    if let hook {
      body["hook"] = try RaviJSON.fromEncodable(hook)
    }
    if let insight {
      body["insight"] = try RaviJSON.fromEncodable(insight)
    }
    if let instance {
      body["instance"] = try RaviJSON.fromEncodable(instance)
    }
    if let kind {
      body["kind"] = try RaviJSON.fromEncodable(kind)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
    if let order {
      body["order"] = try RaviJSON.fromEncodable(order)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let project {
      body["project"] = try RaviJSON.fromEncodable(project)
    }
    if let route {
      body["route"] = try RaviJSON.fromEncodable(route)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let skill {
      body["skill"] = try RaviJSON.fromEncodable(skill)
    }
    if let skillGateRule {
      body["skillGateRule"] = try RaviJSON.fromEncodable(skillGateRule)
    }
    if let sort {
      body["sort"] = try RaviJSON.fromEncodable(sort)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
    if let target {
      body["target"] = try RaviJSON.fromEncodable(target)
    }
    if let task {
      body["task"] = try RaviJSON.fromEncodable(task)
    }
    if let taskAutomation {
      body["taskAutomation"] = try RaviJSON.fromEncodable(taskAutomation)
    }
    if let trigger {
      body["trigger"] = try RaviJSON.fromEncodable(trigger)
    }
    if let workflowNode {
      body["workflowNode"] = try RaviJSON.fromEncodable(workflowNode)
    }
    if let workflowRun {
      body["workflowRun"] = try RaviJSON.fromEncodable(workflowRun)
    }
    if let workflowSpec {
      body["workflowSpec"] = try RaviJSON.fromEncodable(workflowSpec)
    }
  }
}

public typealias TagsSearchReturn = RaviJSON

public typealias TagsSetReturn = RaviJSON

public typealias TagsShowReturn = RaviJSON

public struct TasksArchiveOptions: Codable, Sendable {
  public var reason: String?

  public init(reason: String? = nil) {
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let reason {
      body["reason"] = try RaviJSON.fromEncodable(reason)
    }
  }
}

public typealias TasksArchiveReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let checkpoint {
      body["checkpoint"] = try RaviJSON.fromEncodable(checkpoint)
    }
    if let detached {
      body["detached"] = try RaviJSON.fromEncodable(detached)
    }
    if let disabled {
      body["disabled"] = try RaviJSON.fromEncodable(disabled)
    }
    if let filter {
      body["filter"] = try RaviJSON.fromEncodable(filter)
    }
    if let freshCheckpoint {
      body["freshCheckpoint"] = try RaviJSON.fromEncodable(freshCheckpoint)
    }
    if let freshReportEvents {
      body["freshReportEvents"] = try RaviJSON.fromEncodable(freshReportEvents)
    }
    if let freshReportTo {
      body["freshReportTo"] = try RaviJSON.fromEncodable(freshReportTo)
    }
    if let freshWorktree {
      body["freshWorktree"] = try RaviJSON.fromEncodable(freshWorktree)
    }
    if let input {
      body["input"] = try RaviJSON.fromEncodable(input)
    }
    if let instructions {
      body["instructions"] = try RaviJSON.fromEncodable(instructions)
    }
    if let on {
      body["on"] = try RaviJSON.fromEncodable(on)
    }
    if let priority {
      body["priority"] = try RaviJSON.fromEncodable(priority)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let reportEvents {
      body["reportEvents"] = try RaviJSON.fromEncodable(reportEvents)
    }
    if let reportTo {
      body["reportTo"] = try RaviJSON.fromEncodable(reportTo)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let title {
      body["title"] = try RaviJSON.fromEncodable(title)
    }
  }
}

public typealias TasksAutomationsAddReturn = RaviJSON

public typealias TasksAutomationsDisableReturn = RaviJSON

public typealias TasksAutomationsEnableReturn = RaviJSON

public struct TasksAutomationsListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias TasksAutomationsListReturn = RaviJSON

public typealias TasksAutomationsRmReturn = RaviJSON

public typealias TasksAutomationsShowReturn = RaviJSON

public struct TasksBlockOptions: Codable, Sendable {
  public var reason: String?

  public init(reason: String? = nil) {
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let reason {
      body["reason"] = try RaviJSON.fromEncodable(reason)
    }
  }
}

public typealias TasksBlockReturn = RaviJSON

public typealias TasksCommentReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let assignee {
      body["assignee"] = try RaviJSON.fromEncodable(assignee)
    }
    if let checkpoint {
      body["checkpoint"] = try RaviJSON.fromEncodable(checkpoint)
    }
    if let dependsOn {
      body["dependsOn"] = try RaviJSON.fromEncodable(dependsOn)
    }
    if let effort {
      body["effort"] = try RaviJSON.fromEncodable(effort)
    }
    if let input {
      body["input"] = try RaviJSON.fromEncodable(input)
    }
    if let instructions {
      body["instructions"] = try RaviJSON.fromEncodable(instructions)
    }
    if let model {
      body["model"] = try RaviJSON.fromEncodable(model)
    }
    if let parent {
      body["parent"] = try RaviJSON.fromEncodable(parent)
    }
    if let priority {
      body["priority"] = try RaviJSON.fromEncodable(priority)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let reportEvents {
      body["reportEvents"] = try RaviJSON.fromEncodable(reportEvents)
    }
    if let reportTo {
      body["reportTo"] = try RaviJSON.fromEncodable(reportTo)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
    if let thinking {
      body["thinking"] = try RaviJSON.fromEncodable(thinking)
    }
    if let worktreeBranch {
      body["worktreeBranch"] = try RaviJSON.fromEncodable(worktreeBranch)
    }
    if let worktreeMode {
      body["worktreeMode"] = try RaviJSON.fromEncodable(worktreeMode)
    }
    if let worktreePath {
      body["worktreePath"] = try RaviJSON.fromEncodable(worktreePath)
    }
  }
}

public typealias TasksCreateReturn = RaviJSON

public typealias TasksDepsAddReturn = RaviJSON

public typealias TasksDepsLsReturn = RaviJSON

public typealias TasksDepsRmReturn = RaviJSON

public struct TasksDispatchOptions: Codable, Sendable {
  public var actorSession: String?
  public var agent: String?
  public var checkpoint: String?
  public var effort: String?
  public var model: String?
  public var reportEvents: String?
  public var reportTo: String?
  public var session: String?
  public var thinking: String?

  public init(actorSession: String? = nil, agent: String? = nil, checkpoint: String? = nil, effort: String? = nil, model: String? = nil, reportEvents: String? = nil, reportTo: String? = nil, session: String? = nil, thinking: String? = nil) {
    self.actorSession = actorSession
    self.agent = agent
    self.checkpoint = checkpoint
    self.effort = effort
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
    case model = "model"
    case reportEvents = "reportEvents"
    case reportTo = "reportTo"
    case session = "session"
    case thinking = "thinking"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let actorSession {
      body["actorSession"] = try RaviJSON.fromEncodable(actorSession)
    }
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let checkpoint {
      body["checkpoint"] = try RaviJSON.fromEncodable(checkpoint)
    }
    if let effort {
      body["effort"] = try RaviJSON.fromEncodable(effort)
    }
    if let model {
      body["model"] = try RaviJSON.fromEncodable(model)
    }
    if let reportEvents {
      body["reportEvents"] = try RaviJSON.fromEncodable(reportEvents)
    }
    if let reportTo {
      body["reportTo"] = try RaviJSON.fromEncodable(reportTo)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let thinking {
      body["thinking"] = try RaviJSON.fromEncodable(thinking)
    }
  }
}

public typealias TasksDispatchReturn = RaviJSON

public struct TasksDoneOptions: Codable, Sendable {
  public var summary: String?

  public init(summary: String? = nil) {
    self.summary = summary
  }

  enum CodingKeys: String, CodingKey {
    case summary = "summary"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let summary {
      body["summary"] = try RaviJSON.fromEncodable(summary)
    }
  }
}

public typealias TasksDoneReturn = RaviJSON

public struct TasksFailOptions: Codable, Sendable {
  public var reason: String?

  public init(reason: String? = nil) {
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case reason = "reason"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let reason {
      body["reason"] = try RaviJSON.fromEncodable(reason)
    }
  }
}

public typealias TasksFailReturn = RaviJSON

public struct TasksListOptions: Codable, Sendable {
  public var agent: String?
  public var all: Bool?
  public var allTime: Bool?
  public var archived: Bool?
  public var cursor: String?
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

  public init(agent: String? = nil, all: Bool? = nil, allTime: Bool? = nil, archived: Bool? = nil, cursor: String? = nil, last: String? = nil, limit: String? = nil, mine: Bool? = nil, order: String? = nil, parent: String? = nil, profile: String? = nil, root: String? = nil, roots: Bool? = nil, session: String? = nil, since: String? = nil, sort: String? = nil, status: String? = nil, tag: String? = nil, text: String? = nil, until: String? = nil) {
    self.agent = agent
    self.all = all
    self.allTime = allTime
    self.archived = archived
    self.cursor = cursor
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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let all {
      body["all"] = try RaviJSON.fromEncodable(all)
    }
    if let allTime {
      body["allTime"] = try RaviJSON.fromEncodable(allTime)
    }
    if let archived {
      body["archived"] = try RaviJSON.fromEncodable(archived)
    }
    if let cursor {
      body["cursor"] = try RaviJSON.fromEncodable(cursor)
    }
    if let last {
      body["last"] = try RaviJSON.fromEncodable(last)
    }
    if let limit {
      body["limit"] = try RaviJSON.fromEncodable(limit)
    }
    if let mine {
      body["mine"] = try RaviJSON.fromEncodable(mine)
    }
    if let order {
      body["order"] = try RaviJSON.fromEncodable(order)
    }
    if let parent {
      body["parent"] = try RaviJSON.fromEncodable(parent)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let root {
      body["root"] = try RaviJSON.fromEncodable(root)
    }
    if let roots {
      body["roots"] = try RaviJSON.fromEncodable(roots)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let since {
      body["since"] = try RaviJSON.fromEncodable(since)
    }
    if let sort {
      body["sort"] = try RaviJSON.fromEncodable(sort)
    }
    if let status {
      body["status"] = try RaviJSON.fromEncodable(status)
    }
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
    if let text {
      body["text"] = try RaviJSON.fromEncodable(text)
    }
    if let until {
      body["until"] = try RaviJSON.fromEncodable(until)
    }
  }
}

public typealias TasksListReturn = RaviJSON

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
    if let preset {
      body["preset"] = try RaviJSON.fromEncodable(preset)
    }
    if let source {
      body["source"] = try RaviJSON.fromEncodable(source)
    }
  }
}

public typealias TasksProfilesInitReturn = RaviJSON

public typealias TasksProfilesListReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let input {
      body["input"] = try RaviJSON.fromEncodable(input)
    }
    if let instructions {
      body["instructions"] = try RaviJSON.fromEncodable(instructions)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let title {
      body["title"] = try RaviJSON.fromEncodable(title)
    }
    if let worktreeBranch {
      body["worktreeBranch"] = try RaviJSON.fromEncodable(worktreeBranch)
    }
    if let worktreeMode {
      body["worktreeMode"] = try RaviJSON.fromEncodable(worktreeMode)
    }
    if let worktreePath {
      body["worktreePath"] = try RaviJSON.fromEncodable(worktreePath)
    }
  }
}

public typealias TasksProfilesPreviewReturn = RaviJSON

public typealias TasksProfilesShowReturn = RaviJSON

public typealias TasksProfilesValidateReturn = RaviJSON

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
    if let message {
      body["message"] = try RaviJSON.fromEncodable(message)
    }
    if let progress {
      body["progress"] = try RaviJSON.fromEncodable(progress)
    }
  }
}

public typealias TasksReportReturn = RaviJSON

public struct TasksShowOptions: Codable, Sendable {
  public var last: String?

  public init(last: String? = nil) {
    self.last = last
  }

  enum CodingKeys: String, CodingKey {
    case last = "last"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let last {
      body["last"] = try RaviJSON.fromEncodable(last)
    }
  }
}

public typealias TasksShowReturn = RaviJSON

public typealias TasksUnarchiveReturn = RaviJSON

public typealias ToolsListReturn = RaviJSON

public typealias ToolsManifestReturn = RaviJSON

public typealias ToolsSchemaReturn = RaviJSON

public typealias ToolsShowReturn = RaviJSON

public typealias ToolsTestReturn = RaviJSON

public struct TranscribeFileOptions: Codable, Sendable {
  public var lang: String?

  public init(lang: String? = nil) {
    self.lang = lang
  }

  enum CodingKeys: String, CodingKey {
    case lang = "lang"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let lang {
      body["lang"] = try RaviJSON.fromEncodable(lang)
    }
  }
}

public typealias TranscribeFileReturn = RaviJSON

public struct TriggersAddOptions: Codable, Sendable {
  public var account: String?
  public var agent: String?
  public var cooldown: String?
  public var filter: String?
  public var message: String?
  public var session: String?
  public var topic: String?

  public init(account: String? = nil, agent: String? = nil, cooldown: String? = nil, filter: String? = nil, message: String? = nil, session: String? = nil, topic: String? = nil) {
    self.account = account
    self.agent = agent
    self.cooldown = cooldown
    self.filter = filter
    self.message = message
    self.session = session
    self.topic = topic
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case agent = "agent"
    case cooldown = "cooldown"
    case filter = "filter"
    case message = "message"
    case session = "session"
    case topic = "topic"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let cooldown {
      body["cooldown"] = try RaviJSON.fromEncodable(cooldown)
    }
    if let filter {
      body["filter"] = try RaviJSON.fromEncodable(filter)
    }
    if let message {
      body["message"] = try RaviJSON.fromEncodable(message)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let topic {
      body["topic"] = try RaviJSON.fromEncodable(topic)
    }
  }
}

public typealias TriggersAddReturn = RaviJSON

public typealias TriggersDisableReturn = RaviJSON

public typealias TriggersEnableReturn = RaviJSON

public struct TriggersListOptions: Codable, Sendable {
  public var tag: String?

  public init(tag: String? = nil) {
    self.tag = tag
  }

  enum CodingKeys: String, CodingKey {
    case tag = "tag"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let tag {
      body["tag"] = try RaviJSON.fromEncodable(tag)
    }
  }
}

public typealias TriggersListReturn = RaviJSON

public typealias TriggersRmReturn = RaviJSON

public typealias TriggersSetReturn = RaviJSON

public typealias TriggersShowReturn = RaviJSON

public typealias TriggersTestReturn = RaviJSON

public struct VideoAnalyzeOptions: Codable, Sendable {
  public var output: String?
  public var prompt: String?

  public init(output: String? = nil, prompt: String? = nil) {
    self.output = output
    self.prompt = prompt
  }

  enum CodingKeys: String, CodingKey {
    case output = "output"
    case prompt = "prompt"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let output {
      body["output"] = try RaviJSON.fromEncodable(output)
    }
    if let prompt {
      body["prompt"] = try RaviJSON.fromEncodable(prompt)
    }
  }
}

public typealias VideoAnalyzeReturn = RaviJSON

public struct WhatsappDmAckOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappDmAckReturn = RaviJSON

public struct WhatsappDmReadOptions: Codable, Sendable {
  public var account: String?
  public var last: String?
  public var noAck: Bool?

  public init(account: String? = nil, last: String? = nil, noAck: Bool? = nil) {
    self.account = account
    self.last = last
    self.noAck = noAck
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case last = "last"
    case noAck = "noAck"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
    if let last {
      body["last"] = try RaviJSON.fromEncodable(last)
    }
    if let noAck {
      body["noAck"] = try RaviJSON.fromEncodable(noAck)
    }
  }
}

public typealias WhatsappDmReadReturn = RaviJSON

public struct WhatsappDmSendOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappDmSendReturn = RaviJSON

public struct WhatsappGroupAddOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupAddReturn = RaviJSON

public struct WhatsappGroupCreateOptions: Codable, Sendable {
  public var account: String?
  public var agent: String?

  public init(account: String? = nil, agent: String? = nil) {
    self.account = account
    self.agent = agent
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
    case agent = "agent"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
  }
}

public typealias WhatsappGroupCreateReturn = RaviJSON

public struct WhatsappGroupDemoteOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupDemoteReturn = RaviJSON

public struct WhatsappGroupDescriptionOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupDescriptionReturn = RaviJSON

public struct WhatsappGroupInfoOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupInfoReturn = RaviJSON

public struct WhatsappGroupInviteOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupInviteReturn = RaviJSON

public struct WhatsappGroupJoinOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupJoinReturn = RaviJSON

public struct WhatsappGroupLeaveOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupLeaveReturn = RaviJSON

public struct WhatsappGroupListOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupListReturn = RaviJSON

public struct WhatsappGroupPromoteOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupPromoteReturn = RaviJSON

public struct WhatsappGroupRemoveOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupRemoveReturn = RaviJSON

public struct WhatsappGroupRenameOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupRenameReturn = RaviJSON

public struct WhatsappGroupRevokeInviteOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupRevokeInviteReturn = RaviJSON

public struct WhatsappGroupSettingsOptions: Codable, Sendable {
  public var account: String?

  public init(account: String? = nil) {
    self.account = account
  }

  enum CodingKeys: String, CodingKey {
    case account = "account"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let account {
      body["account"] = try RaviJSON.fromEncodable(account)
    }
  }
}

public typealias WhatsappGroupSettingsReturn = RaviJSON

public typealias WorkflowsRunsArchiveNodeReturn = RaviJSON

public typealias WorkflowsRunsCancelReturn = RaviJSON

public typealias WorkflowsRunsListReturn = RaviJSON

public typealias WorkflowsRunsReleaseReturn = RaviJSON

public typealias WorkflowsRunsShowReturn = RaviJSON

public typealias WorkflowsRunsSkipReturn = RaviJSON

public struct WorkflowsRunsStartOptions: Codable, Sendable {
  public var runId: String?

  public init(runId: String? = nil) {
    self.runId = runId
  }

  enum CodingKeys: String, CodingKey {
    case runId = "runId"
  }

  func encodeBody(into body: inout [String: RaviJSON]) throws {
    if let runId {
      body["runId"] = try RaviJSON.fromEncodable(runId)
    }
  }
}

public typealias WorkflowsRunsStartReturn = RaviJSON

public typealias WorkflowsRunsTaskAttachReturn = RaviJSON

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
    if let agent {
      body["agent"] = try RaviJSON.fromEncodable(agent)
    }
    if let instructions {
      body["instructions"] = try RaviJSON.fromEncodable(instructions)
    }
    if let priority {
      body["priority"] = try RaviJSON.fromEncodable(priority)
    }
    if let profile {
      body["profile"] = try RaviJSON.fromEncodable(profile)
    }
    if let session {
      body["session"] = try RaviJSON.fromEncodable(session)
    }
    if let title {
      body["title"] = try RaviJSON.fromEncodable(title)
    }
  }
}

public typealias WorkflowsRunsTaskCreateReturn = RaviJSON

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
    if let definition {
      body["definition"] = try RaviJSON.fromEncodable(definition)
    }
    if let file {
      body["file"] = try RaviJSON.fromEncodable(file)
    }
  }
}

public typealias WorkflowsSpecsCreateReturn = RaviJSON

public typealias WorkflowsSpecsListReturn = RaviJSON

public typealias WorkflowsSpecsShowReturn = RaviJSON
