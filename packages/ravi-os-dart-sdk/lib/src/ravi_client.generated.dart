// GENERATED FILE - DO NOT EDIT.
// Run `ravi sdk dart generate` to regenerate.
// Drift is detected by `ravi sdk dart check`.

import 'ravi_json.dart';
import 'ravi_transport.dart';
import 'ravi_types.generated.dart';

class RaviClient {
  RaviClient(this._transport);

  final RaviTransport _transport;

  AdaptersNamespace get adapters => AdaptersNamespace(_transport);
  AgentsNamespace get agents => AgentsNamespace(_transport);
  AppsNamespace get apps => AppsNamespace(_transport);
  ArtifactsNamespace get artifacts => ArtifactsNamespace(_transport);
  AudioNamespace get audio => AudioNamespace(_transport);
  BridgesNamespace get bridges => BridgesNamespace(_transport);
  CalendarsNamespace get calendars => CalendarsNamespace(_transport);
  ChannelsNamespace get channels => ChannelsNamespace(_transport);
  ChatsNamespace get chats => ChatsNamespace(_transport);
  CloudNamespace get cloud => CloudNamespace(_transport);
  CommandsNamespace get commands => CommandsNamespace(_transport);
  ConnectorsNamespace get connectors => ConnectorsNamespace(_transport);
  ContactsNamespace get contacts => ContactsNamespace(_transport);
  ContextNamespace get context => ContextNamespace(_transport);
  CostsNamespace get costs => CostsNamespace(_transport);
  CredentialsNamespace get credentials => CredentialsNamespace(_transport);
  CrmNamespace get crm => CrmNamespace(_transport);
  CronNamespace get cron => CronNamespace(_transport);
  DaemonNamespace get daemon => DaemonNamespace(_transport);
  DevinNamespace get devin => DevinNamespace(_transport);
  EvalNamespace get eval => EvalNamespace(_transport);
  FeedbackNamespace get feedback => FeedbackNamespace(_transport);
  GmailNamespace get gmail => GmailNamespace(_transport);
  HeartbeatNamespace get heartbeat => HeartbeatNamespace(_transport);
  HooksNamespace get hooks => HooksNamespace(_transport);
  ImageNamespace get image => ImageNamespace(_transport);
  InboxNamespace get inbox => InboxNamespace(_transport);
  InsightsNamespace get insights => InsightsNamespace(_transport);
  InstancesNamespace get instances => InstancesNamespace(_transport);
  MailNamespace get mail => MailNamespace(_transport);
  MediaNamespace get media => MediaNamespace(_transport);
  MeetingsNamespace get meetings => MeetingsNamespace(_transport);
  MetricsNamespace get metrics => MetricsNamespace(_transport);
  ObserversNamespace get observers => ObserversNamespace(_transport);
  PagesNamespace get pages => PagesNamespace(_transport);
  PermissionsNamespace get permissions => PermissionsNamespace(_transport);
  ProjectsNamespace get projects => ProjectsNamespace(_transport);
  ProxNamespace get prox => ProxNamespace(_transport);
  ReactNamespace get react => ReactNamespace(_transport);
  RoutesNamespace get routes => RoutesNamespace(_transport);
  RulesNamespace get rules => RulesNamespace(_transport);
  RuntimeNamespace get runtime => RuntimeNamespace(_transport);
  SdkNamespace get sdk => SdkNamespace(_transport);
  SelfNamespace get self => SelfNamespace(_transport);
  SessionsNamespace get sessions => SessionsNamespace(_transport);
  SettingsNamespace get settings => SettingsNamespace(_transport);
  SkillGatesNamespace get skillGates => SkillGatesNamespace(_transport);
  SkillsNamespace get skills => SkillsNamespace(_transport);
  SlackNamespace get slack => SlackNamespace(_transport);
  SpecsNamespace get specs => SpecsNamespace(_transport);
  StickersNamespace get stickers => StickersNamespace(_transport);
  SyncNamespace get sync => SyncNamespace(_transport);
  TagRulesNamespace get tagRules => TagRulesNamespace(_transport);
  TagsNamespace get tags => TagsNamespace(_transport);
  TasksNamespace get tasks => TasksNamespace(_transport);
  ThreadsNamespace get threads => ThreadsNamespace(_transport);
  ToolsNamespace get tools => ToolsNamespace(_transport);
  TranscribeNamespace get transcribe => TranscribeNamespace(_transport);
  TriggersNamespace get triggers => TriggersNamespace(_transport);
  VideoNamespace get video => VideoNamespace(_transport);
  WatchNamespace get watch => WatchNamespace(_transport);
  WhatsappNamespace get whatsapp => WhatsappNamespace(_transport);
  WorkObjectsNamespace get workObjects => WorkObjectsNamespace(_transport);
  WorkflowsNamespace get workflows => WorkflowsNamespace(_transport);
  YtNamespace get yt => YtNamespace(_transport);
}

class AdaptersNamespace {
  const AdaptersNamespace(this._transport);

  final RaviTransport _transport;

  Future<AdaptersListReturn> list([AdaptersListOptions options = const AdaptersListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["adapters"],
      command: "list",
      body: requestBody,
      decode: adaptersListReturnFromJson,
    );
  }

  Future<AdaptersShowReturn> show(String adapterId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["adapterId"] = RaviJson.from(adapterId);
    return _transport.callJson(
      groupSegments: const ["adapters"],
      command: "show",
      body: requestBody,
      decode: adaptersShowReturnFromJson,
    );
  }
}

class AgentsNamespace {
  const AgentsNamespace(this._transport);

  final RaviTransport _transport;

  Future<AgentsCreateReturn> create(String id, String cwd, [AgentsCreateOptions options = const AgentsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["cwd"] = RaviJson.from(cwd);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "create",
      body: requestBody,
      decode: agentsCreateReturnFromJson,
    );
  }

  Future<AgentsDebounceReturn> debounce(String id, [String? ms]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    if (ms != null) {
      requestBody["ms"] = RaviJson.from(ms);
    }
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "debounce",
      body: requestBody,
      decode: agentsDebounceReturnFromJson,
    );
  }

  Future<AgentsDebugReturn> debug(String id, [String? nameOrKey, AgentsDebugOptions options = const AgentsDebugOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    if (nameOrKey != null) {
      requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "debug",
      body: requestBody,
      decode: agentsDebugReturnFromJson,
    );
  }

  Future<AgentsDeleteReturn> delete(String id, [AgentsDeleteOptions options = const AgentsDeleteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "delete",
      body: requestBody,
      decode: agentsDeleteReturnFromJson,
    );
  }

  Future<AgentsListReturn> list([AgentsListOptions options = const AgentsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "list",
      body: requestBody,
      decode: agentsListReturnFromJson,
    );
  }

  Future<AgentsModelBrokerReturn> modelBroker(String id, [AgentsModelBrokerOptions options = const AgentsModelBrokerOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "model-broker",
      body: requestBody,
      decode: agentsModelBrokerReturnFromJson,
    );
  }

  Future<AgentsPermissionsReturn> permissions(String id, [String? profile, AgentsPermissionsOptions options = const AgentsPermissionsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    if (profile != null) {
      requestBody["profile"] = RaviJson.from(profile);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "permissions",
      body: requestBody,
      decode: agentsPermissionsReturnFromJson,
    );
  }

  Future<AgentsResetReturn> reset(String id, [String? nameOrKey, AgentsResetOptions options = const AgentsResetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    if (nameOrKey != null) {
      requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "reset",
      body: requestBody,
      decode: agentsResetReturnFromJson,
    );
  }

  Future<AgentsSessionReturn> session(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "session",
      body: requestBody,
      decode: agentsSessionReturnFromJson,
    );
  }

  Future<AgentsSetReturn> set_(String id, String key, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "set",
      body: requestBody,
      decode: agentsSetReturnFromJson,
    );
  }

  Future<AgentsShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "show",
      body: requestBody,
      decode: agentsShowReturnFromJson,
    );
  }

  Future<AgentsSpecModeReturn> specMode(String id, [String? enabled]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    if (enabled != null) {
      requestBody["enabled"] = RaviJson.from(enabled);
    }
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "spec-mode",
      body: requestBody,
      decode: agentsSpecModeReturnFromJson,
    );
  }

  Future<AgentsSyncInstructionsReturn> syncInstructions([AgentsSyncInstructionsOptions options = const AgentsSyncInstructionsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["agents"],
      command: "sync-instructions",
      body: requestBody,
      decode: agentsSyncInstructionsReturnFromJson,
    );
  }
}

class AppsNamespace {
  const AppsNamespace(this._transport);

  final RaviTransport _transport;

  Future<AppsCheckReturn> check([String? id]) async {
    final requestBody = <String, RaviJson>{};
    if (id != null) {
      requestBody["id"] = RaviJson.from(id);
    }
    return _transport.callJson(
      groupSegments: const ["apps"],
      command: "check",
      body: requestBody,
      decode: appsCheckReturnFromJson,
    );
  }

  Future<AppsDeleteReturn> delete(String id, [AppsDeleteOptions options = const AppsDeleteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["apps"],
      command: "delete",
      body: requestBody,
      decode: appsDeleteReturnFromJson,
    );
  }

  Future<AppsGuideReturn> guide([String? id]) async {
    final requestBody = <String, RaviJson>{};
    if (id != null) {
      requestBody["id"] = RaviJson.from(id);
    }
    return _transport.callJson(
      groupSegments: const ["apps"],
      command: "guide",
      body: requestBody,
      decode: appsGuideReturnFromJson,
    );
  }

  Future<AppsImportCliReturn> importCli(String command, [AppsImportCliOptions options = const AppsImportCliOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["command"] = RaviJson.from(command);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["apps"],
      command: "import-cli",
      body: requestBody,
      decode: appsImportCliReturnFromJson,
    );
  }

  Future<AppsListReturn> list([AppsListOptions options = const AppsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["apps"],
      command: "list",
      body: requestBody,
      decode: appsListReturnFromJson,
    );
  }

  Future<AppsPromptsReturn> prompts([String? id]) async {
    final requestBody = <String, RaviJson>{};
    if (id != null) {
      requestBody["id"] = RaviJson.from(id);
    }
    return _transport.callJson(
      groupSegments: const ["apps"],
      command: "prompts",
      body: requestBody,
      decode: appsPromptsReturnFromJson,
    );
  }

  Future<AppsRunReturn> run(String id, [String? operation, List<String>? args, AppsRunOptions options = const AppsRunOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    if (operation != null) {
      requestBody["operation"] = RaviJson.from(operation);
    }
    if (args != null) {
      requestBody["args"] = RaviJson.from(args);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["apps"],
      command: "run",
      body: requestBody,
      decode: appsRunReturnFromJson,
    );
  }

  Future<AppsScaffoldReturn> scaffold(String id, [AppsScaffoldOptions options = const AppsScaffoldOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["apps"],
      command: "scaffold",
      body: requestBody,
      decode: appsScaffoldReturnFromJson,
    );
  }

  Future<AppsShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["apps"],
      command: "show",
      body: requestBody,
      decode: appsShowReturnFromJson,
    );
  }
}

class ArtifactsNamespace {
  const ArtifactsNamespace(this._transport);

  final RaviTransport _transport;

  ArtifactsReleaseNamespace get release => ArtifactsReleaseNamespace(_transport);

  Future<ArtifactsArchiveReturn> archive(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "archive",
      body: requestBody,
      decode: artifactsArchiveReturnFromJson,
    );
  }

  Future<ArtifactsAttachReturn> attach(String id, String targetType, String targetId, [ArtifactsAttachOptions options = const ArtifactsAttachOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["targetType"] = RaviJson.from(targetType);
    requestBody["targetId"] = RaviJson.from(targetId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "attach",
      body: requestBody,
      decode: artifactsAttachReturnFromJson,
    );
  }

  Future<ArtifactsBlobReturn> blob(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callBinary(
      groupSegments: const ["artifacts"],
      command: "blob",
      body: requestBody,
    );
  }

  Future<ArtifactsCreateReturn> create([ArtifactsCreateOptions options = const ArtifactsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "create",
      body: requestBody,
      decode: artifactsCreateReturnFromJson,
    );
  }

  Future<ArtifactsEventReturn> event(String id, String eventType, [ArtifactsEventOptions options = const ArtifactsEventOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["eventType"] = RaviJson.from(eventType);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "event",
      body: requestBody,
      decode: artifactsEventReturnFromJson,
    );
  }

  Future<ArtifactsEventsReturn> events(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "events",
      body: requestBody,
      decode: artifactsEventsReturnFromJson,
    );
  }

  Future<ArtifactsListReturn> list([ArtifactsListOptions options = const ArtifactsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "list",
      body: requestBody,
      decode: artifactsListReturnFromJson,
    );
  }

  Future<ArtifactsPublishReturn> publish(String target, [ArtifactsPublishOptions options = const ArtifactsPublishOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["target"] = RaviJson.from(target);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "publish",
      body: requestBody,
      decode: artifactsPublishReturnFromJson,
    );
  }

  Future<ArtifactsRestoreReturn> restore(String id, [ArtifactsRestoreOptions options = const ArtifactsRestoreOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "restore",
      body: requestBody,
      decode: artifactsRestoreReturnFromJson,
    );
  }

  Future<ArtifactsShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "show",
      body: requestBody,
      decode: artifactsShowReturnFromJson,
    );
  }

  Future<ArtifactsSnapshotReturn> snapshot(String id, [ArtifactsSnapshotOptions options = const ArtifactsSnapshotOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "snapshot",
      body: requestBody,
      decode: artifactsSnapshotReturnFromJson,
    );
  }

  Future<ArtifactsUpdateReturn> update(String id, [ArtifactsUpdateOptions options = const ArtifactsUpdateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "update",
      body: requestBody,
      decode: artifactsUpdateReturnFromJson,
    );
  }

  Future<ArtifactsVersionReturn> version(String id, [ArtifactsVersionOptions options = const ArtifactsVersionOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "version",
      body: requestBody,
      decode: artifactsVersionReturnFromJson,
    );
  }

  Future<ArtifactsVersionsReturn> versions(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["artifacts"],
      command: "versions",
      body: requestBody,
      decode: artifactsVersionsReturnFromJson,
    );
  }
}

class ArtifactsReleaseNamespace {
  const ArtifactsReleaseNamespace(this._transport);

  final RaviTransport _transport;

  Future<ArtifactsReleaseActivateReturn> activate(String id, [ArtifactsReleaseActivateOptions options = const ArtifactsReleaseActivateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["artifacts", "release"],
      command: "activate",
      body: requestBody,
      decode: artifactsReleaseActivateReturnFromJson,
    );
  }
}

class AudioNamespace {
  const AudioNamespace(this._transport);

  final RaviTransport _transport;

  Future<AudioBlobReturn> blob(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callBinary(
      groupSegments: const ["audio"],
      command: "blob",
      body: requestBody,
    );
  }

  Future<AudioGenerateReturn> generate([String? text, AudioGenerateOptions options = const AudioGenerateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (text != null) {
      requestBody["text"] = RaviJson.from(text);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["audio"],
      command: "generate",
      body: requestBody,
      decode: audioGenerateReturnFromJson,
    );
  }

  Future<AudioPendingReturn> pending([AudioPendingOptions options = const AudioPendingOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["audio"],
      command: "pending",
      body: requestBody,
      decode: audioPendingReturnFromJson,
    );
  }

  Future<AudioTtsReturn> tts(String text, [AudioTtsOptions options = const AudioTtsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["text"] = RaviJson.from(text);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["audio"],
      command: "tts",
      body: requestBody,
      decode: audioTtsReturnFromJson,
    );
  }

  Future<AudioVoicesReturn> voices([AudioVoicesOptions options = const AudioVoicesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["audio"],
      command: "voices",
      body: requestBody,
      decode: audioVoicesReturnFromJson,
    );
  }
}

class BridgesNamespace {
  const BridgesNamespace(this._transport);

  final RaviTransport _transport;

  Future<BridgesCreateReturn> create([BridgesCreateOptions options = const BridgesCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["bridges"],
      command: "create",
      body: requestBody,
      decode: bridgesCreateReturnFromJson,
    );
  }

  Future<BridgesListReturn> list([BridgesListOptions options = const BridgesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["bridges"],
      command: "list",
      body: requestBody,
      decode: bridgesListReturnFromJson,
    );
  }

  Future<BridgesRevokeReturn> revoke(String id, [BridgesRevokeOptions options = const BridgesRevokeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["bridges"],
      command: "revoke",
      body: requestBody,
      decode: bridgesRevokeReturnFromJson,
    );
  }
}

class CalendarsNamespace {
  const CalendarsNamespace(this._transport);

  final RaviTransport _transport;

  CalendarsEventsNamespace get events => CalendarsEventsNamespace(_transport);

  Future<CalendarsAvailabilityReturn> availability([CalendarsAvailabilityOptions options = const CalendarsAvailabilityOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars"],
      command: "availability",
      body: requestBody,
      decode: calendarsAvailabilityReturnFromJson,
    );
  }

  Future<CalendarsCreateReturn> create([CalendarsCreateOptions options = const CalendarsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars"],
      command: "create",
      body: requestBody,
      decode: calendarsCreateReturnFromJson,
    );
  }

  Future<CalendarsDisableReturn> disable(String calendar) async {
    final requestBody = <String, RaviJson>{};
    requestBody["calendar"] = RaviJson.from(calendar);
    return _transport.callJson(
      groupSegments: const ["calendars"],
      command: "disable",
      body: requestBody,
      decode: calendarsDisableReturnFromJson,
    );
  }

  Future<CalendarsListReturn> list([CalendarsListOptions options = const CalendarsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars"],
      command: "list",
      body: requestBody,
      decode: calendarsListReturnFromJson,
    );
  }

  Future<CalendarsShareReturn> share(String calendar, [CalendarsShareOptions options = const CalendarsShareOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["calendar"] = RaviJson.from(calendar);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars"],
      command: "share",
      body: requestBody,
      decode: calendarsShareReturnFromJson,
    );
  }

  Future<CalendarsShowReturn> show(String calendar, [CalendarsShowOptions options = const CalendarsShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["calendar"] = RaviJson.from(calendar);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars"],
      command: "show",
      body: requestBody,
      decode: calendarsShowReturnFromJson,
    );
  }
}

class CalendarsEventsNamespace {
  const CalendarsEventsNamespace(this._transport);

  final RaviTransport _transport;

  Future<CalendarsEventsCancelReturn> cancel(String event, [CalendarsEventsCancelOptions options = const CalendarsEventsCancelOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["event"] = RaviJson.from(event);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars", "events"],
      command: "cancel",
      body: requestBody,
      decode: calendarsEventsCancelReturnFromJson,
    );
  }

  Future<CalendarsEventsCreateReturn> create([CalendarsEventsCreateOptions options = const CalendarsEventsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars", "events"],
      command: "create",
      body: requestBody,
      decode: calendarsEventsCreateReturnFromJson,
    );
  }

  Future<CalendarsEventsListReturn> list([CalendarsEventsListOptions options = const CalendarsEventsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars", "events"],
      command: "list",
      body: requestBody,
      decode: calendarsEventsListReturnFromJson,
    );
  }

  Future<CalendarsEventsReadReturn> read(String event) async {
    final requestBody = <String, RaviJson>{};
    requestBody["event"] = RaviJson.from(event);
    return _transport.callJson(
      groupSegments: const ["calendars", "events"],
      command: "read",
      body: requestBody,
      decode: calendarsEventsReadReturnFromJson,
    );
  }

  Future<CalendarsEventsRespondReturn> respond(String event, [CalendarsEventsRespondOptions options = const CalendarsEventsRespondOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["event"] = RaviJson.from(event);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars", "events"],
      command: "respond",
      body: requestBody,
      decode: calendarsEventsRespondReturnFromJson,
    );
  }

  Future<CalendarsEventsUpdateReturn> update(String event, [CalendarsEventsUpdateOptions options = const CalendarsEventsUpdateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["event"] = RaviJson.from(event);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["calendars", "events"],
      command: "update",
      body: requestBody,
      decode: calendarsEventsUpdateReturnFromJson,
    );
  }
}

class ChannelsNamespace {
  const ChannelsNamespace(this._transport);

  final RaviTransport _transport;

  ChannelsBackendNamespace get backend => ChannelsBackendNamespace(_transport);

  Future<ChannelsCreateReturn> create(String name, [ChannelsCreateOptions options = const ChannelsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["channels"],
      command: "create",
      body: requestBody,
      decode: channelsCreateReturnFromJson,
    );
  }

  Future<ChannelsListReturn> list([ChannelsListOptions options = const ChannelsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["channels"],
      command: "list",
      body: requestBody,
      decode: channelsListReturnFromJson,
    );
  }

  Future<ChannelsProbeReturn> probe() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["channels"],
      command: "probe",
      body: requestBody,
      decode: channelsProbeReturnFromJson,
    );
  }

  Future<ChannelsRestartReturn> restart([ChannelsRestartOptions options = const ChannelsRestartOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["channels"],
      command: "restart",
      body: requestBody,
      decode: channelsRestartReturnFromJson,
    );
  }

  Future<ChannelsSetReturn> set_(String name, String key, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["channels"],
      command: "set",
      body: requestBody,
      decode: channelsSetReturnFromJson,
    );
  }

  Future<ChannelsShowReturn> show(String name) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    return _transport.callJson(
      groupSegments: const ["channels"],
      command: "show",
      body: requestBody,
      decode: channelsShowReturnFromJson,
    );
  }

  Future<ChannelsStartReturn> start([ChannelsStartOptions options = const ChannelsStartOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["channels"],
      command: "start",
      body: requestBody,
      decode: channelsStartReturnFromJson,
    );
  }

  Future<ChannelsStatusReturn> status() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["channels"],
      command: "status",
      body: requestBody,
      decode: channelsStatusReturnFromJson,
    );
  }

  Future<ChannelsStopReturn> stop() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["channels"],
      command: "stop",
      body: requestBody,
      decode: channelsStopReturnFromJson,
    );
  }
}

class ChannelsBackendNamespace {
  const ChannelsBackendNamespace(this._transport);

  final RaviTransport _transport;

  ChannelsBackendRuntimeNamespace get runtime => ChannelsBackendRuntimeNamespace(_transport);

  Future<ChannelsBackendIngressReturn> ingress(String agentId, RaviJson request) async {
    final requestBody = <String, RaviJson>{};
    requestBody["agentId"] = RaviJson.from(agentId);
    requestBody["request"] = RaviJson.from(request);
    return _transport.callJson(
      groupSegments: const ["channels", "backend"],
      command: "ingress",
      body: requestBody,
      decode: channelsBackendIngressReturnFromJson,
    );
  }
}

class ChannelsBackendRuntimeNamespace {
  const ChannelsBackendRuntimeNamespace(this._transport);

  final RaviTransport _transport;

  Future<ChannelsBackendRuntimeInterruptReturn> interrupt(String agentId, RaviJson request) async {
    final requestBody = <String, RaviJson>{};
    requestBody["agentId"] = RaviJson.from(agentId);
    requestBody["request"] = RaviJson.from(request);
    return _transport.callJson(
      groupSegments: const ["channels", "backend", "runtime"],
      command: "interrupt",
      body: requestBody,
      decode: channelsBackendRuntimeInterruptReturnFromJson,
    );
  }

  Future<ChannelsBackendRuntimeReadbackReturn> readback(String agentId, RaviJson request) async {
    final requestBody = <String, RaviJson>{};
    requestBody["agentId"] = RaviJson.from(agentId);
    requestBody["request"] = RaviJson.from(request);
    return _transport.callJson(
      groupSegments: const ["channels", "backend", "runtime"],
      command: "readback",
      body: requestBody,
      decode: channelsBackendRuntimeReadbackReturnFromJson,
    );
  }
}

class ChatsNamespace {
  const ChatsNamespace(this._transport);

  final RaviTransport _transport;

  ChatsListsNamespace get lists => ChatsListsNamespace(_transport);

  ChatsMessagesNamespace get messages => ChatsMessagesNamespace(_transport);

  Future<ChatsBackfillProviderTimestampsReturn> backfillProviderTimestamps([ChatsBackfillProviderTimestampsOptions options = const ChatsBackfillProviderTimestampsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats"],
      command: "backfill-provider-timestamps",
      body: requestBody,
      decode: chatsBackfillProviderTimestampsReturnFromJson,
    );
  }

  Future<ChatsEnsureReturn> ensure(String actorId, String agentId, String clientRequestId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["actorId"] = RaviJson.from(actorId);
    requestBody["agentId"] = RaviJson.from(agentId);
    requestBody["clientRequestId"] = RaviJson.from(clientRequestId);
    return _transport.callJson(
      groupSegments: const ["chats"],
      command: "ensure",
      body: requestBody,
      decode: chatsEnsureReturnFromJson,
    );
  }

  Future<ChatsListReturn> list([ChatsListOptions options = const ChatsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats"],
      command: "list",
      body: requestBody,
      decode: chatsListReturnFromJson,
    );
  }

  Future<ChatsReadReturn> read(String chat, [ChatsReadOptions options = const ChatsReadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["chat"] = RaviJson.from(chat);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats"],
      command: "read",
      body: requestBody,
      decode: chatsReadReturnFromJson,
    );
  }
}

class ChatsListsNamespace {
  const ChatsListsNamespace(this._transport);

  final RaviTransport _transport;

  Future<ChatsListsAddReturn> add(String list, String chat, [ChatsListsAddOptions options = const ChatsListsAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["list"] = RaviJson.from(list);
    requestBody["chat"] = RaviJson.from(chat);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "add",
      body: requestBody,
      decode: chatsListsAddReturnFromJson,
    );
  }

  Future<ChatsListsCreateReturn> create(String name, [ChatsListsCreateOptions options = const ChatsListsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "create",
      body: requestBody,
      decode: chatsListsCreateReturnFromJson,
    );
  }

  Future<ChatsListsDeltaReturn> delta(String list, String chat, [ChatsListsDeltaOptions options = const ChatsListsDeltaOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["list"] = RaviJson.from(list);
    requestBody["chat"] = RaviJson.from(chat);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "delta",
      body: requestBody,
      decode: chatsListsDeltaReturnFromJson,
    );
  }

  Future<ChatsListsListReturn> list([ChatsListsListOptions options = const ChatsListsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "list",
      body: requestBody,
      decode: chatsListsListReturnFromJson,
    );
  }

  Future<ChatsListsMarkReadReturn> markRead(String list, String chat, [ChatsListsMarkReadOptions options = const ChatsListsMarkReadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["list"] = RaviJson.from(list);
    requestBody["chat"] = RaviJson.from(chat);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "mark-read",
      body: requestBody,
      decode: chatsListsMarkReadReturnFromJson,
    );
  }

  Future<ChatsListsMembersReturn> members(String list, [ChatsListsMembersOptions options = const ChatsListsMembersOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["list"] = RaviJson.from(list);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "members",
      body: requestBody,
      decode: chatsListsMembersReturnFromJson,
    );
  }

  Future<ChatsListsPreviewReturn> preview(String listId, [ChatsListsPreviewOptions options = const ChatsListsPreviewOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["listId"] = RaviJson.from(listId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "preview",
      body: requestBody,
      decode: chatsListsPreviewReturnFromJson,
    );
  }

  Future<ChatsListsRecomputeReturn> recompute(String listId, [ChatsListsRecomputeOptions options = const ChatsListsRecomputeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["listId"] = RaviJson.from(listId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "recompute",
      body: requestBody,
      decode: chatsListsRecomputeReturnFromJson,
    );
  }

  Future<ChatsListsRemoveReturn> remove(String list, String chat, [ChatsListsRemoveOptions options = const ChatsListsRemoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["list"] = RaviJson.from(list);
    requestBody["chat"] = RaviJson.from(chat);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "remove",
      body: requestBody,
      decode: chatsListsRemoveReturnFromJson,
    );
  }

  Future<ChatsListsShowReturn> show(String listId, [ChatsListsShowOptions options = const ChatsListsShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["listId"] = RaviJson.from(listId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["chats", "lists"],
      command: "show",
      body: requestBody,
      decode: chatsListsShowReturnFromJson,
    );
  }
}

class ChatsMessagesNamespace {
  const ChatsMessagesNamespace(this._transport);

  final RaviTransport _transport;

  Future<ChatsMessagesCreateReturn> create(String chatId, String actorId, String clientMessageId, String content) async {
    final requestBody = <String, RaviJson>{};
    requestBody["chatId"] = RaviJson.from(chatId);
    requestBody["actorId"] = RaviJson.from(actorId);
    requestBody["clientMessageId"] = RaviJson.from(clientMessageId);
    requestBody["content"] = RaviJson.from(content);
    return _transport.callJson(
      groupSegments: const ["chats", "messages"],
      command: "create",
      body: requestBody,
      decode: chatsMessagesCreateReturnFromJson,
    );
  }
}

class CloudNamespace {
  const CloudNamespace(this._transport);

  final RaviTransport _transport;

  CloudProjectsNamespace get projects => CloudProjectsNamespace(_transport);

  CloudScopeNamespace get scope => CloudScopeNamespace(_transport);
}

class CloudProjectsNamespace {
  const CloudProjectsNamespace(this._transport);

  final RaviTransport _transport;

  Future<CloudProjectsCreateReturn> create(String slug, [CloudProjectsCreateOptions options = const CloudProjectsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["slug"] = RaviJson.from(slug);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cloud", "projects"],
      command: "create",
      body: requestBody,
      decode: cloudProjectsCreateReturnFromJson,
    );
  }

  Future<CloudProjectsListReturn> list([CloudProjectsListOptions options = const CloudProjectsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cloud", "projects"],
      command: "list",
      body: requestBody,
      decode: cloudProjectsListReturnFromJson,
    );
  }
}

class CloudScopeNamespace {
  const CloudScopeNamespace(this._transport);

  final RaviTransport _transport;

  Future<CloudScopeClearReturn> clear([CloudScopeClearOptions options = const CloudScopeClearOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cloud", "scope"],
      command: "clear",
      body: requestBody,
      decode: cloudScopeClearReturnFromJson,
    );
  }

  Future<CloudScopeExplainReturn> explain([CloudScopeExplainOptions options = const CloudScopeExplainOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cloud", "scope"],
      command: "explain",
      body: requestBody,
      decode: cloudScopeExplainReturnFromJson,
    );
  }

  Future<CloudScopeSetReturn> set_([CloudScopeSetOptions options = const CloudScopeSetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cloud", "scope"],
      command: "set",
      body: requestBody,
      decode: cloudScopeSetReturnFromJson,
    );
  }

  Future<CloudScopeShowReturn> show([CloudScopeShowOptions options = const CloudScopeShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cloud", "scope"],
      command: "show",
      body: requestBody,
      decode: cloudScopeShowReturnFromJson,
    );
  }
}

class CommandsNamespace {
  const CommandsNamespace(this._transport);

  final RaviTransport _transport;

  Future<CommandsListReturn> list([CommandsListOptions options = const CommandsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["commands"],
      command: "list",
      body: requestBody,
      decode: commandsListReturnFromJson,
    );
  }

  Future<CommandsRunReturn> run(String name, [List<String>? args, CommandsRunOptions options = const CommandsRunOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    if (args != null) {
      requestBody["args"] = RaviJson.from(args);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["commands"],
      command: "run",
      body: requestBody,
      decode: commandsRunReturnFromJson,
    );
  }

  Future<CommandsShowReturn> show(String name, [CommandsShowOptions options = const CommandsShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["commands"],
      command: "show",
      body: requestBody,
      decode: commandsShowReturnFromJson,
    );
  }

  Future<CommandsValidateReturn> validate([CommandsValidateOptions options = const CommandsValidateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["commands"],
      command: "validate",
      body: requestBody,
      decode: commandsValidateReturnFromJson,
    );
  }
}

class ConnectorsNamespace {
  const ConnectorsNamespace(this._transport);

  final RaviTransport _transport;

  Future<ConnectorsListReturn> list([ConnectorsListOptions options = const ConnectorsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["connectors"],
      command: "list",
      body: requestBody,
      decode: connectorsListReturnFromJson,
    );
  }

  Future<ConnectorsRevokeReturn> revoke(String id, [ConnectorsRevokeOptions options = const ConnectorsRevokeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["connectors"],
      command: "revoke",
      body: requestBody,
      decode: connectorsRevokeReturnFromJson,
    );
  }

  Future<ConnectorsShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["connectors"],
      command: "show",
      body: requestBody,
      decode: connectorsShowReturnFromJson,
    );
  }
}

class ContactsNamespace {
  const ContactsNamespace(this._transport);

  final RaviTransport _transport;

  ContactsMetadataNamespace get metadata => ContactsMetadataNamespace(_transport);

  Future<ContactsActivityReturn> activity(String contact, [ContactsActivityOptions options = const ContactsActivityOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "activity",
      body: requestBody,
      decode: contactsActivityReturnFromJson,
    );
  }

  Future<ContactsAddReturn> add(String identity, [String? name, ContactsAddOptions options = const ContactsAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["identity"] = RaviJson.from(identity);
    if (name != null) {
      requestBody["name"] = RaviJson.from(name);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "add",
      body: requestBody,
      decode: contactsAddReturnFromJson,
    );
  }

  Future<ContactsAllowReturn> allow(String contact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "allow",
      body: requestBody,
      decode: contactsAllowReturnFromJson,
    );
  }

  Future<ContactsApproveReturn> approve(String contact, [String? mode, ContactsApproveOptions options = const ContactsApproveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    if (mode != null) {
      requestBody["mode"] = RaviJson.from(mode);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "approve",
      body: requestBody,
      decode: contactsApproveReturnFromJson,
    );
  }

  Future<ContactsBackfillReturn> backfill([ContactsBackfillOptions options = const ContactsBackfillOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "backfill",
      body: requestBody,
      decode: contactsBackfillReturnFromJson,
    );
  }

  Future<ContactsBlockReturn> block(String contact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "block",
      body: requestBody,
      decode: contactsBlockReturnFromJson,
    );
  }

  Future<ContactsCheckReturn> check(String contact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "check",
      body: requestBody,
      decode: contactsCheckReturnFromJson,
    );
  }

  Future<ContactsDuplicatesReturn> duplicates() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "duplicates",
      body: requestBody,
      decode: contactsDuplicatesReturnFromJson,
    );
  }

  Future<ContactsFindReturn> find(String query, [ContactsFindOptions options = const ContactsFindOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["query"] = RaviJson.from(query);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "find",
      body: requestBody,
      decode: contactsFindReturnFromJson,
    );
  }

  Future<ContactsGetReturn> get_(String contact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "get",
      body: requestBody,
      decode: contactsGetReturnFromJson,
    );
  }

  Future<ContactsInfoReturn> info(String contact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "info",
      body: requestBody,
      decode: contactsInfoReturnFromJson,
    );
  }

  Future<ContactsLinkReturn> link(String contact, [ContactsLinkOptions options = const ContactsLinkOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "link",
      body: requestBody,
      decode: contactsLinkReturnFromJson,
    );
  }

  Future<ContactsListReturn> list([ContactsListOptions options = const ContactsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "list",
      body: requestBody,
      decode: contactsListReturnFromJson,
    );
  }

  Future<ContactsMergeReturn> merge(String source, String target, [ContactsMergeOptions options = const ContactsMergeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["source"] = RaviJson.from(source);
    requestBody["target"] = RaviJson.from(target);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "merge",
      body: requestBody,
      decode: contactsMergeReturnFromJson,
    );
  }

  Future<ContactsMessagesReturn> messages(String contact, [ContactsMessagesOptions options = const ContactsMessagesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "messages",
      body: requestBody,
      decode: contactsMessagesReturnFromJson,
    );
  }

  Future<ContactsNoteReturn> note(String contact, String text, [ContactsNoteOptions options = const ContactsNoteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    requestBody["text"] = RaviJson.from(text);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "note",
      body: requestBody,
      decode: contactsNoteReturnFromJson,
    );
  }

  Future<ContactsPendingReturn> pending([ContactsPendingOptions options = const ContactsPendingOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "pending",
      body: requestBody,
      decode: contactsPendingReturnFromJson,
    );
  }

  Future<ContactsProfileReturn> profile(String contact, [ContactsProfileOptions options = const ContactsProfileOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "profile",
      body: requestBody,
      decode: contactsProfileReturnFromJson,
    );
  }

  Future<ContactsRemoveReturn> remove(String contact, [ContactsRemoveOptions options = const ContactsRemoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "remove",
      body: requestBody,
      decode: contactsRemoveReturnFromJson,
    );
  }

  Future<ContactsSessionsReturn> sessions(String contact, [ContactsSessionsOptions options = const ContactsSessionsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "sessions",
      body: requestBody,
      decode: contactsSessionsReturnFromJson,
    );
  }

  Future<ContactsSetReturn> set_(String contact, String key, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "set",
      body: requestBody,
      decode: contactsSetReturnFromJson,
    );
  }

  Future<ContactsTagReturn> tag(String contact, String tag) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    requestBody["tag"] = RaviJson.from(tag);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "tag",
      body: requestBody,
      decode: contactsTagReturnFromJson,
    );
  }

  Future<ContactsTimelineReturn> timeline(String contact, [ContactsTimelineOptions options = const ContactsTimelineOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "timeline",
      body: requestBody,
      decode: contactsTimelineReturnFromJson,
    );
  }

  Future<ContactsUnlinkReturn> unlink(String platformIdentity, [ContactsUnlinkOptions options = const ContactsUnlinkOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["platformIdentity"] = RaviJson.from(platformIdentity);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "unlink",
      body: requestBody,
      decode: contactsUnlinkReturnFromJson,
    );
  }

  Future<ContactsUntagReturn> untag(String contact, String tag) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    requestBody["tag"] = RaviJson.from(tag);
    return _transport.callJson(
      groupSegments: const ["contacts"],
      command: "untag",
      body: requestBody,
      decode: contactsUntagReturnFromJson,
    );
  }
}

class ContactsMetadataNamespace {
  const ContactsMetadataNamespace(this._transport);

  final RaviTransport _transport;

  Future<ContactsMetadataListReturn> list(String contact, [ContactsMetadataListOptions options = const ContactsMetadataListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts", "metadata"],
      command: "list",
      body: requestBody,
      decode: contactsMetadataListReturnFromJson,
    );
  }

  Future<ContactsMetadataRemoveReturn> remove(String contact, String key, [ContactsMetadataRemoveOptions options = const ContactsMetadataRemoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    requestBody["key"] = RaviJson.from(key);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts", "metadata"],
      command: "remove",
      body: requestBody,
      decode: contactsMetadataRemoveReturnFromJson,
    );
  }

  Future<ContactsMetadataSetReturn> set_(String contact, String key, String value, [ContactsMetadataSetOptions options = const ContactsMetadataSetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["contacts", "metadata"],
      command: "set",
      body: requestBody,
      decode: contactsMetadataSetReturnFromJson,
    );
  }
}

class ContextNamespace {
  const ContextNamespace(this._transport);

  final RaviTransport _transport;

  ContextCredentialsNamespace get credentials => ContextCredentialsNamespace(_transport);

  Future<ContextAuthorizeReturn> authorize(String permission, String objectType, String objectId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["permission"] = RaviJson.from(permission);
    requestBody["objectType"] = RaviJson.from(objectType);
    requestBody["objectId"] = RaviJson.from(objectId);
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "authorize",
      body: requestBody,
      decode: contextAuthorizeReturnFromJson,
    );
  }

  Future<ContextCapabilitiesReturn> capabilities() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "capabilities",
      body: requestBody,
      decode: contextCapabilitiesReturnFromJson,
    );
  }

  Future<ContextCheckReturn> check(String permission, String objectType, String objectId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["permission"] = RaviJson.from(permission);
    requestBody["objectType"] = RaviJson.from(objectType);
    requestBody["objectId"] = RaviJson.from(objectId);
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "check",
      body: requestBody,
      decode: contextCheckReturnFromJson,
    );
  }

  Future<ContextCleanupAgentRuntimeReturn> cleanupAgentRuntime([ContextCleanupAgentRuntimeOptions options = const ContextCleanupAgentRuntimeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "cleanup-agent-runtime",
      body: requestBody,
      decode: contextCleanupAgentRuntimeReturnFromJson,
    );
  }

  Future<ContextCodexBashHookReturn> codexBashHook() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "codex-bash-hook",
      body: requestBody,
      decode: contextCodexBashHookReturnFromJson,
    );
  }

  Future<ContextInfoReturn> info(String contextId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contextId"] = RaviJson.from(contextId);
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "info",
      body: requestBody,
      decode: contextInfoReturnFromJson,
    );
  }

  Future<ContextIssueReturn> issue(String cliName, [ContextIssueOptions options = const ContextIssueOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["cliName"] = RaviJson.from(cliName);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "issue",
      body: requestBody,
      decode: contextIssueReturnFromJson,
    );
  }

  Future<ContextLineageReturn> lineage(String contextId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contextId"] = RaviJson.from(contextId);
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "lineage",
      body: requestBody,
      decode: contextLineageReturnFromJson,
    );
  }

  Future<ContextListReturn> list([ContextListOptions options = const ContextListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "list",
      body: requestBody,
      decode: contextListReturnFromJson,
    );
  }

  Future<ContextPruneReturn> prune([ContextPruneOptions options = const ContextPruneOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "prune",
      body: requestBody,
      decode: contextPruneReturnFromJson,
    );
  }

  Future<ContextRevokeReturn> revoke(String contextId, [ContextRevokeOptions options = const ContextRevokeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contextId"] = RaviJson.from(contextId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "revoke",
      body: requestBody,
      decode: contextRevokeReturnFromJson,
    );
  }

  Future<ContextVisibilityReturn> visibility() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "visibility",
      body: requestBody,
      decode: contextVisibilityReturnFromJson,
    );
  }

  Future<ContextWhoamiReturn> whoami() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["context"],
      command: "whoami",
      body: requestBody,
      decode: contextWhoamiReturnFromJson,
    );
  }
}

class ContextCredentialsNamespace {
  const ContextCredentialsNamespace(this._transport);

  final RaviTransport _transport;

  Future<ContextCredentialsAddReturn> add(String contextKey, [ContextCredentialsAddOptions options = const ContextCredentialsAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contextKey"] = RaviJson.from(contextKey);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["context", "credentials"],
      command: "add",
      body: requestBody,
      decode: contextCredentialsAddReturnFromJson,
    );
  }

  Future<ContextCredentialsListReturn> list([ContextCredentialsListOptions options = const ContextCredentialsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["context", "credentials"],
      command: "list",
      body: requestBody,
      decode: contextCredentialsListReturnFromJson,
    );
  }

  Future<ContextCredentialsRemoveReturn> remove(String contextKey, [ContextCredentialsRemoveOptions options = const ContextCredentialsRemoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contextKey"] = RaviJson.from(contextKey);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["context", "credentials"],
      command: "remove",
      body: requestBody,
      decode: contextCredentialsRemoveReturnFromJson,
    );
  }

  Future<ContextCredentialsSetDefaultReturn> setDefault(String contextKey) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contextKey"] = RaviJson.from(contextKey);
    return _transport.callJson(
      groupSegments: const ["context", "credentials"],
      command: "set-default",
      body: requestBody,
      decode: contextCredentialsSetDefaultReturnFromJson,
    );
  }
}

class CostsNamespace {
  const CostsNamespace(this._transport);

  final RaviTransport _transport;

  Future<CostsAgentReturn> agent(String agentId, [CostsAgentOptions options = const CostsAgentOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["agentId"] = RaviJson.from(agentId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["costs"],
      command: "agent",
      body: requestBody,
      decode: costsAgentReturnFromJson,
    );
  }

  Future<CostsAgentsReturn> agents([CostsAgentsOptions options = const CostsAgentsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["costs"],
      command: "agents",
      body: requestBody,
      decode: costsAgentsReturnFromJson,
    );
  }

  Future<CostsPricingReturn> pricing([CostsPricingOptions options = const CostsPricingOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["costs"],
      command: "pricing",
      body: requestBody,
      decode: costsPricingReturnFromJson,
    );
  }

  Future<CostsSessionReturn> session(String nameOrKey) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    return _transport.callJson(
      groupSegments: const ["costs"],
      command: "session",
      body: requestBody,
      decode: costsSessionReturnFromJson,
    );
  }

  Future<CostsSummaryReturn> summary([CostsSummaryOptions options = const CostsSummaryOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["costs"],
      command: "summary",
      body: requestBody,
      decode: costsSummaryReturnFromJson,
    );
  }

  Future<CostsTopSessionsReturn> topSessions([CostsTopSessionsOptions options = const CostsTopSessionsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["costs"],
      command: "top-sessions",
      body: requestBody,
      decode: costsTopSessionsReturnFromJson,
    );
  }
}

class CredentialsNamespace {
  const CredentialsNamespace(this._transport);

  final RaviTransport _transport;

  CredentialsConnectionsNamespace get connections => CredentialsConnectionsNamespace(_transport);

  CredentialsPoliciesNamespace get policies => CredentialsPoliciesNamespace(_transport);
}

class CredentialsConnectionsNamespace {
  const CredentialsConnectionsNamespace(this._transport);

  final RaviTransport _transport;

  Future<CredentialsConnectionsDisableReturn> disable([CredentialsConnectionsDisableOptions options = const CredentialsConnectionsDisableOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["credentials", "connections"],
      command: "disable",
      body: requestBody,
      decode: credentialsConnectionsDisableReturnFromJson,
    );
  }

  Future<CredentialsConnectionsEnableReturn> enable([CredentialsConnectionsEnableOptions options = const CredentialsConnectionsEnableOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["credentials", "connections"],
      command: "enable",
      body: requestBody,
      decode: credentialsConnectionsEnableReturnFromJson,
    );
  }

  Future<CredentialsConnectionsListReturn> list([CredentialsConnectionsListOptions options = const CredentialsConnectionsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["credentials", "connections"],
      command: "list",
      body: requestBody,
      decode: credentialsConnectionsListReturnFromJson,
    );
  }

  Future<CredentialsConnectionsShowReturn> show([CredentialsConnectionsShowOptions options = const CredentialsConnectionsShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["credentials", "connections"],
      command: "show",
      body: requestBody,
      decode: credentialsConnectionsShowReturnFromJson,
    );
  }
}

class CredentialsPoliciesNamespace {
  const CredentialsPoliciesNamespace(this._transport);

  final RaviTransport _transport;

  Future<CredentialsPoliciesExplainReturn> explain([CredentialsPoliciesExplainOptions options = const CredentialsPoliciesExplainOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["credentials", "policies"],
      command: "explain",
      body: requestBody,
      decode: credentialsPoliciesExplainReturnFromJson,
    );
  }
}

class CrmNamespace {
  const CrmNamespace(this._transport);

  final RaviTransport _transport;

  CrmAccountNamespace get account => CrmAccountNamespace(_transport);

  CrmContactNamespace get contact => CrmContactNamespace(_transport);

  CrmFactNamespace get fact => CrmFactNamespace(_transport);

  CrmOpportunityNamespace get opportunity => CrmOpportunityNamespace(_transport);

  CrmPipelineNamespace get pipeline => CrmPipelineNamespace(_transport);

  CrmTaskNamespace get task => CrmTaskNamespace(_transport);

  Future<CrmAccountReturn> accountCommand(String account) async {
    final requestBody = <String, RaviJson>{};
    requestBody["account"] = RaviJson.from(account);
    return _transport.callJson(
      groupSegments: const ["crm"],
      command: "account",
      body: requestBody,
      decode: crmAccountReturnFromJson,
    );
  }

  Future<CrmBoardReturn> board([CrmBoardOptions options = const CrmBoardOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm"],
      command: "board",
      body: requestBody,
      decode: crmBoardReturnFromJson,
    );
  }

  Future<CrmContactReturn> contactCommand(String contact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    return _transport.callJson(
      groupSegments: const ["crm"],
      command: "contact",
      body: requestBody,
      decode: crmContactReturnFromJson,
    );
  }

  Future<CrmContactsReturn> contacts([CrmContactsOptions options = const CrmContactsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm"],
      command: "contacts",
      body: requestBody,
      decode: crmContactsReturnFromJson,
    );
  }

  Future<CrmNextReturn> next([CrmNextOptions options = const CrmNextOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm"],
      command: "next",
      body: requestBody,
      decode: crmNextReturnFromJson,
    );
  }

  Future<CrmOpportunityReturn> opportunityCommand(String opportunity) async {
    final requestBody = <String, RaviJson>{};
    requestBody["opportunity"] = RaviJson.from(opportunity);
    return _transport.callJson(
      groupSegments: const ["crm"],
      command: "opportunity",
      body: requestBody,
      decode: crmOpportunityReturnFromJson,
    );
  }
}

class CrmAccountNamespace {
  const CrmAccountNamespace(this._transport);

  final RaviTransport _transport;

  Future<CrmAccountCreateReturn> create(String name, [CrmAccountCreateOptions options = const CrmAccountCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "account"],
      command: "create",
      body: requestBody,
      decode: crmAccountCreateReturnFromJson,
    );
  }

  Future<CrmAccountLinkContactReturn> linkContact(String account, String contact, [CrmAccountLinkContactOptions options = const CrmAccountLinkContactOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["account"] = RaviJson.from(account);
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "account"],
      command: "link-contact",
      body: requestBody,
      decode: crmAccountLinkContactReturnFromJson,
    );
  }

  Future<CrmAccountShowReturn> show(String account) async {
    final requestBody = <String, RaviJson>{};
    requestBody["account"] = RaviJson.from(account);
    return _transport.callJson(
      groupSegments: const ["crm", "account"],
      command: "show",
      body: requestBody,
      decode: crmAccountShowReturnFromJson,
    );
  }
}

class CrmContactNamespace {
  const CrmContactNamespace(this._transport);

  final RaviTransport _transport;

  Future<CrmContactSetReturn> set_(String contact, String field, String value, [CrmContactSetOptions options = const CrmContactSetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    requestBody["field"] = RaviJson.from(field);
    requestBody["value"] = RaviJson.from(value);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "contact"],
      command: "set",
      body: requestBody,
      decode: crmContactSetReturnFromJson,
    );
  }

  Future<CrmContactShowReturn> show(String contact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    return _transport.callJson(
      groupSegments: const ["crm", "contact"],
      command: "show",
      body: requestBody,
      decode: crmContactShowReturnFromJson,
    );
  }
}

class CrmFactNamespace {
  const CrmFactNamespace(this._transport);

  final RaviTransport _transport;

  Future<CrmFactConfirmReturn> confirm(String fact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["fact"] = RaviJson.from(fact);
    return _transport.callJson(
      groupSegments: const ["crm", "fact"],
      command: "confirm",
      body: requestBody,
      decode: crmFactConfirmReturnFromJson,
    );
  }

  Future<CrmFactListReturn> list([CrmFactListOptions options = const CrmFactListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "fact"],
      command: "list",
      body: requestBody,
      decode: crmFactListReturnFromJson,
    );
  }

  Future<CrmFactProposeReturn> propose(String entityType, String entity, String key, String value, [CrmFactProposeOptions options = const CrmFactProposeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["entityType"] = RaviJson.from(entityType);
    requestBody["entity"] = RaviJson.from(entity);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "fact"],
      command: "propose",
      body: requestBody,
      decode: crmFactProposeReturnFromJson,
    );
  }

  Future<CrmFactRejectReturn> reject(String fact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["fact"] = RaviJson.from(fact);
    return _transport.callJson(
      groupSegments: const ["crm", "fact"],
      command: "reject",
      body: requestBody,
      decode: crmFactRejectReturnFromJson,
    );
  }
}

class CrmOpportunityNamespace {
  const CrmOpportunityNamespace(this._transport);

  final RaviTransport _transport;

  Future<CrmOpportunityContactsReturn> contacts(String opportunity) async {
    final requestBody = <String, RaviJson>{};
    requestBody["opportunity"] = RaviJson.from(opportunity);
    return _transport.callJson(
      groupSegments: const ["crm", "opportunity"],
      command: "contacts",
      body: requestBody,
      decode: crmOpportunityContactsReturnFromJson,
    );
  }

  Future<CrmOpportunityCreateReturn> create(String title, [CrmOpportunityCreateOptions options = const CrmOpportunityCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["title"] = RaviJson.from(title);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "opportunity"],
      command: "create",
      body: requestBody,
      decode: crmOpportunityCreateReturnFromJson,
    );
  }

  Future<CrmOpportunityLinkContactReturn> linkContact(String opportunity, String contact, [CrmOpportunityLinkContactOptions options = const CrmOpportunityLinkContactOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["opportunity"] = RaviJson.from(opportunity);
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "opportunity"],
      command: "link-contact",
      body: requestBody,
      decode: crmOpportunityLinkContactReturnFromJson,
    );
  }

  Future<CrmOpportunityMoveReturn> move(String opportunity, String stage, [CrmOpportunityMoveOptions options = const CrmOpportunityMoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["opportunity"] = RaviJson.from(opportunity);
    requestBody["stage"] = RaviJson.from(stage);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "opportunity"],
      command: "move",
      body: requestBody,
      decode: crmOpportunityMoveReturnFromJson,
    );
  }

  Future<CrmOpportunityShowReturn> show(String opportunity) async {
    final requestBody = <String, RaviJson>{};
    requestBody["opportunity"] = RaviJson.from(opportunity);
    return _transport.callJson(
      groupSegments: const ["crm", "opportunity"],
      command: "show",
      body: requestBody,
      decode: crmOpportunityShowReturnFromJson,
    );
  }
}

class CrmPipelineNamespace {
  const CrmPipelineNamespace(this._transport);

  final RaviTransport _transport;

  CrmPipelinePolicyNamespace get policy => CrmPipelinePolicyNamespace(_transport);

  CrmPipelineStageNamespace get stage => CrmPipelineStageNamespace(_transport);

  Future<CrmPipelineCreateReturn> create(String name, [CrmPipelineCreateOptions options = const CrmPipelineCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline"],
      command: "create",
      body: requestBody,
      decode: crmPipelineCreateReturnFromJson,
    );
  }

  Future<CrmPipelineListReturn> list([CrmPipelineListOptions options = const CrmPipelineListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline"],
      command: "list",
      body: requestBody,
      decode: crmPipelineListReturnFromJson,
    );
  }

  Future<CrmPipelineReviewReturn> review(String pipeline) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline"],
      command: "review",
      body: requestBody,
      decode: crmPipelineReviewReturnFromJson,
    );
  }

  Future<CrmPipelineSetReturn> set_(String pipeline, String field, String value, [CrmPipelineSetOptions options = const CrmPipelineSetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    requestBody["field"] = RaviJson.from(field);
    requestBody["value"] = RaviJson.from(value);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline"],
      command: "set",
      body: requestBody,
      decode: crmPipelineSetReturnFromJson,
    );
  }

  Future<CrmPipelineShowReturn> show(String pipeline, [CrmPipelineShowOptions options = const CrmPipelineShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline"],
      command: "show",
      body: requestBody,
      decode: crmPipelineShowReturnFromJson,
    );
  }

  Future<CrmPipelineValidateReturn> validate([String? pipeline, CrmPipelineValidateOptions options = const CrmPipelineValidateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (pipeline != null) {
      requestBody["pipeline"] = RaviJson.from(pipeline);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline"],
      command: "validate",
      body: requestBody,
      decode: crmPipelineValidateReturnFromJson,
    );
  }
}

class CrmPipelinePolicyNamespace {
  const CrmPipelinePolicyNamespace(this._transport);

  final RaviTransport _transport;

  Future<CrmPipelinePolicyHitlCheckReturn> hitlCheck(String pipeline, [CrmPipelinePolicyHitlCheckOptions options = const CrmPipelinePolicyHitlCheckOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "policy"],
      command: "hitl-check",
      body: requestBody,
      decode: crmPipelinePolicyHitlCheckReturnFromJson,
    );
  }

  Future<CrmPipelinePolicySendWindowCheckReturn> sendWindowCheck(String pipeline, [CrmPipelinePolicySendWindowCheckOptions options = const CrmPipelinePolicySendWindowCheckOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "policy"],
      command: "send-window-check",
      body: requestBody,
      decode: crmPipelinePolicySendWindowCheckReturnFromJson,
    );
  }
}

class CrmPipelineStageNamespace {
  const CrmPipelineStageNamespace(this._transport);

  final RaviTransport _transport;

  CrmPipelineStageTopicNamespace get topic => CrmPipelineStageTopicNamespace(_transport);

  Future<CrmPipelineStageAddReturn> add(String pipeline, String key, [CrmPipelineStageAddOptions options = const CrmPipelineStageAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    requestBody["key"] = RaviJson.from(key);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "stage"],
      command: "add",
      body: requestBody,
      decode: crmPipelineStageAddReturnFromJson,
    );
  }

  Future<CrmPipelineStageArchiveReturn> archive(String pipeline, String stage) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    requestBody["stage"] = RaviJson.from(stage);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "stage"],
      command: "archive",
      body: requestBody,
      decode: crmPipelineStageArchiveReturnFromJson,
    );
  }

  Future<CrmPipelineStageListReturn> list(String pipeline, [CrmPipelineStageListOptions options = const CrmPipelineStageListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "stage"],
      command: "list",
      body: requestBody,
      decode: crmPipelineStageListReturnFromJson,
    );
  }

  Future<CrmPipelineStageSetReturn> set_(String pipeline, String stage, String field, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    requestBody["stage"] = RaviJson.from(stage);
    requestBody["field"] = RaviJson.from(field);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "stage"],
      command: "set",
      body: requestBody,
      decode: crmPipelineStageSetReturnFromJson,
    );
  }

  Future<CrmPipelineStageShowReturn> show(String pipeline, String stage) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    requestBody["stage"] = RaviJson.from(stage);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "stage"],
      command: "show",
      body: requestBody,
      decode: crmPipelineStageShowReturnFromJson,
    );
  }

  Future<CrmPipelineStageTopicsReturn> topics(String pipeline, String stage, [CrmPipelineStageTopicsOptions options = const CrmPipelineStageTopicsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    requestBody["stage"] = RaviJson.from(stage);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "stage"],
      command: "topics",
      body: requestBody,
      decode: crmPipelineStageTopicsReturnFromJson,
    );
  }
}

class CrmPipelineStageTopicNamespace {
  const CrmPipelineStageTopicNamespace(this._transport);

  final RaviTransport _transport;

  Future<CrmPipelineStageTopicAddReturn> add(String pipeline, String stage, String key, [CrmPipelineStageTopicAddOptions options = const CrmPipelineStageTopicAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    requestBody["stage"] = RaviJson.from(stage);
    requestBody["key"] = RaviJson.from(key);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "stage", "topic"],
      command: "add",
      body: requestBody,
      decode: crmPipelineStageTopicAddReturnFromJson,
    );
  }

  Future<CrmPipelineStageTopicArchiveReturn> archive(String pipeline, String stage, String topic) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    requestBody["stage"] = RaviJson.from(stage);
    requestBody["topic"] = RaviJson.from(topic);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "stage", "topic"],
      command: "archive",
      body: requestBody,
      decode: crmPipelineStageTopicArchiveReturnFromJson,
    );
  }

  Future<CrmPipelineStageTopicSetReturn> set_(String pipeline, String stage, String topic, String field, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["pipeline"] = RaviJson.from(pipeline);
    requestBody["stage"] = RaviJson.from(stage);
    requestBody["topic"] = RaviJson.from(topic);
    requestBody["field"] = RaviJson.from(field);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["crm", "pipeline", "stage", "topic"],
      command: "set",
      body: requestBody,
      decode: crmPipelineStageTopicSetReturnFromJson,
    );
  }
}

class CrmTaskNamespace {
  const CrmTaskNamespace(this._transport);

  final RaviTransport _transport;

  Future<CrmTaskCancelReturn> cancel(String task, [CrmTaskCancelOptions options = const CrmTaskCancelOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["task"] = RaviJson.from(task);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "task"],
      command: "cancel",
      body: requestBody,
      decode: crmTaskCancelReturnFromJson,
    );
  }

  Future<CrmTaskCreateReturn> create(String title, [CrmTaskCreateOptions options = const CrmTaskCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["title"] = RaviJson.from(title);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "task"],
      command: "create",
      body: requestBody,
      decode: crmTaskCreateReturnFromJson,
    );
  }

  Future<CrmTaskDoneReturn> done(String task) async {
    final requestBody = <String, RaviJson>{};
    requestBody["task"] = RaviJson.from(task);
    return _transport.callJson(
      groupSegments: const ["crm", "task"],
      command: "done",
      body: requestBody,
      decode: crmTaskDoneReturnFromJson,
    );
  }

  Future<CrmTaskListReturn> list([CrmTaskListOptions options = const CrmTaskListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "task"],
      command: "list",
      body: requestBody,
      decode: crmTaskListReturnFromJson,
    );
  }

  Future<CrmTaskShowReturn> show(String task) async {
    final requestBody = <String, RaviJson>{};
    requestBody["task"] = RaviJson.from(task);
    return _transport.callJson(
      groupSegments: const ["crm", "task"],
      command: "show",
      body: requestBody,
      decode: crmTaskShowReturnFromJson,
    );
  }

  Future<CrmTaskSnoozeReturn> snooze(String task, [CrmTaskSnoozeOptions options = const CrmTaskSnoozeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["task"] = RaviJson.from(task);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["crm", "task"],
      command: "snooze",
      body: requestBody,
      decode: crmTaskSnoozeReturnFromJson,
    );
  }
}

class CronNamespace {
  const CronNamespace(this._transport);

  final RaviTransport _transport;

  Future<CronAddReturn> add(String name, [CronAddOptions options = const CronAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cron"],
      command: "add",
      body: requestBody,
      decode: cronAddReturnFromJson,
    );
  }

  Future<CronDisableReturn> disable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["cron"],
      command: "disable",
      body: requestBody,
      decode: cronDisableReturnFromJson,
    );
  }

  Future<CronEnableReturn> enable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["cron"],
      command: "enable",
      body: requestBody,
      decode: cronEnableReturnFromJson,
    );
  }

  Future<CronListReturn> list([CronListOptions options = const CronListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cron"],
      command: "list",
      body: requestBody,
      decode: cronListReturnFromJson,
    );
  }

  Future<CronRmReturn> rm(String id, [CronRmOptions options = const CronRmOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cron"],
      command: "rm",
      body: requestBody,
      decode: cronRmReturnFromJson,
    );
  }

  Future<CronRunReturn> run(String id, [CronRunOptions options = const CronRunOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["cron"],
      command: "run",
      body: requestBody,
      decode: cronRunReturnFromJson,
    );
  }

  Future<CronSetReturn> set_(String id, String key, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["cron"],
      command: "set",
      body: requestBody,
      decode: cronSetReturnFromJson,
    );
  }

  Future<CronShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["cron"],
      command: "show",
      body: requestBody,
      decode: cronShowReturnFromJson,
    );
  }
}

class DaemonNamespace {
  const DaemonNamespace(this._transport);

  final RaviTransport _transport;

  Future<DaemonEnvReturn> env() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["daemon"],
      command: "env",
      body: requestBody,
      decode: daemonEnvReturnFromJson,
    );
  }

  Future<DaemonInitAdminKeyReturn> initAdminKey([DaemonInitAdminKeyOptions options = const DaemonInitAdminKeyOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["daemon"],
      command: "init-admin-key",
      body: requestBody,
      decode: daemonInitAdminKeyReturnFromJson,
    );
  }

  Future<DaemonInstallReturn> install() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["daemon"],
      command: "install",
      body: requestBody,
      decode: daemonInstallReturnFromJson,
    );
  }

  Future<DaemonLogsReturn> logs([DaemonLogsOptions options = const DaemonLogsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["daemon"],
      command: "logs",
      body: requestBody,
      decode: daemonLogsReturnFromJson,
    );
  }

  Future<DaemonRestartReturn> restart([DaemonRestartOptions options = const DaemonRestartOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["daemon"],
      command: "restart",
      body: requestBody,
      decode: daemonRestartReturnFromJson,
    );
  }

  Future<DaemonStartReturn> start() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["daemon"],
      command: "start",
      body: requestBody,
      decode: daemonStartReturnFromJson,
    );
  }

  Future<DaemonStatusReturn> status() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["daemon"],
      command: "status",
      body: requestBody,
      decode: daemonStatusReturnFromJson,
    );
  }

  Future<DaemonStopReturn> stop() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["daemon"],
      command: "stop",
      body: requestBody,
      decode: daemonStopReturnFromJson,
    );
  }

  Future<DaemonUninstallReturn> uninstall() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["daemon"],
      command: "uninstall",
      body: requestBody,
      decode: daemonUninstallReturnFromJson,
    );
  }
}

class DevinNamespace {
  const DevinNamespace(this._transport);

  final RaviTransport _transport;

  DevinAuthNamespace get auth => DevinAuthNamespace(_transport);

  DevinSessionsNamespace get sessions => DevinSessionsNamespace(_transport);
}

class DevinAuthNamespace {
  const DevinAuthNamespace(this._transport);

  final RaviTransport _transport;

  Future<DevinAuthCheckReturn> check() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["devin", "auth"],
      command: "check",
      body: requestBody,
      decode: devinAuthCheckReturnFromJson,
    );
  }
}

class DevinSessionsNamespace {
  const DevinSessionsNamespace(this._transport);

  final RaviTransport _transport;

  Future<DevinSessionsArchiveReturn> archive(String session, [DevinSessionsArchiveOptions options = const DevinSessionsArchiveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "archive",
      body: requestBody,
      decode: devinSessionsArchiveReturnFromJson,
    );
  }

  Future<DevinSessionsAttachmentsReturn> attachments(String session, [DevinSessionsAttachmentsOptions options = const DevinSessionsAttachmentsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "attachments",
      body: requestBody,
      decode: devinSessionsAttachmentsReturnFromJson,
    );
  }

  Future<DevinSessionsCreateReturn> create([DevinSessionsCreateOptions options = const DevinSessionsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "create",
      body: requestBody,
      decode: devinSessionsCreateReturnFromJson,
    );
  }

  Future<DevinSessionsInsightsReturn> insights(String session, [DevinSessionsInsightsOptions options = const DevinSessionsInsightsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "insights",
      body: requestBody,
      decode: devinSessionsInsightsReturnFromJson,
    );
  }

  Future<DevinSessionsListReturn> list([DevinSessionsListOptions options = const DevinSessionsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "list",
      body: requestBody,
      decode: devinSessionsListReturnFromJson,
    );
  }

  Future<DevinSessionsMessagesReturn> messages(String session, [DevinSessionsMessagesOptions options = const DevinSessionsMessagesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "messages",
      body: requestBody,
      decode: devinSessionsMessagesReturnFromJson,
    );
  }

  Future<DevinSessionsSendReturn> send(String session, String message, [DevinSessionsSendOptions options = const DevinSessionsSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "send",
      body: requestBody,
      decode: devinSessionsSendReturnFromJson,
    );
  }

  Future<DevinSessionsShowReturn> show(String session, [DevinSessionsShowOptions options = const DevinSessionsShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "show",
      body: requestBody,
      decode: devinSessionsShowReturnFromJson,
    );
  }

  Future<DevinSessionsSyncReturn> sync(String session, [DevinSessionsSyncOptions options = const DevinSessionsSyncOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "sync",
      body: requestBody,
      decode: devinSessionsSyncReturnFromJson,
    );
  }

  Future<DevinSessionsTerminateReturn> terminate(String session, [DevinSessionsTerminateOptions options = const DevinSessionsTerminateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["devin", "sessions"],
      command: "terminate",
      body: requestBody,
      decode: devinSessionsTerminateReturnFromJson,
    );
  }
}

class EvalNamespace {
  const EvalNamespace(this._transport);

  final RaviTransport _transport;

  Future<EvalRunReturn> run(String specPath, [EvalRunOptions options = const EvalRunOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["specPath"] = RaviJson.from(specPath);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["eval"],
      command: "run",
      body: requestBody,
      decode: evalRunReturnFromJson,
    );
  }
}

class FeedbackNamespace {
  const FeedbackNamespace(this._transport);

  final RaviTransport _transport;

  Future<FeedbackSendReturn> send(List<String> message, [FeedbackSendOptions options = const FeedbackSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["feedback"],
      command: "send",
      body: requestBody,
      decode: feedbackSendReturnFromJson,
    );
  }
}

class GmailNamespace {
  const GmailNamespace(this._transport);

  final RaviTransport _transport;

  Future<GmailListReturn> list([GmailListOptions options = const GmailListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["gmail"],
      command: "list",
      body: requestBody,
      decode: gmailListReturnFromJson,
    );
  }

  Future<GmailReadReturn> read(String id, [GmailReadOptions options = const GmailReadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["gmail"],
      command: "read",
      body: requestBody,
      decode: gmailReadReturnFromJson,
    );
  }
}

class HeartbeatNamespace {
  const HeartbeatNamespace(this._transport);

  final RaviTransport _transport;

  Future<HeartbeatDisableReturn> disable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["heartbeat"],
      command: "disable",
      body: requestBody,
      decode: heartbeatDisableReturnFromJson,
    );
  }

  Future<HeartbeatEnableReturn> enable(String id, [String? interval]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    if (interval != null) {
      requestBody["interval"] = RaviJson.from(interval);
    }
    return _transport.callJson(
      groupSegments: const ["heartbeat"],
      command: "enable",
      body: requestBody,
      decode: heartbeatEnableReturnFromJson,
    );
  }

  Future<HeartbeatSetReturn> set_(String id, String key, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["heartbeat"],
      command: "set",
      body: requestBody,
      decode: heartbeatSetReturnFromJson,
    );
  }

  Future<HeartbeatShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["heartbeat"],
      command: "show",
      body: requestBody,
      decode: heartbeatShowReturnFromJson,
    );
  }

  Future<HeartbeatStatusReturn> status([HeartbeatStatusOptions options = const HeartbeatStatusOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["heartbeat"],
      command: "status",
      body: requestBody,
      decode: heartbeatStatusReturnFromJson,
    );
  }

  Future<HeartbeatTriggerReturn> trigger(String id, [HeartbeatTriggerOptions options = const HeartbeatTriggerOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["heartbeat"],
      command: "trigger",
      body: requestBody,
      decode: heartbeatTriggerReturnFromJson,
    );
  }
}

class HooksNamespace {
  const HooksNamespace(this._transport);

  final RaviTransport _transport;

  Future<HooksCreateReturn> create(String name, [HooksCreateOptions options = const HooksCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["hooks"],
      command: "create",
      body: requestBody,
      decode: hooksCreateReturnFromJson,
    );
  }

  Future<HooksDisableReturn> disable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["hooks"],
      command: "disable",
      body: requestBody,
      decode: hooksDisableReturnFromJson,
    );
  }

  Future<HooksEnableReturn> enable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["hooks"],
      command: "enable",
      body: requestBody,
      decode: hooksEnableReturnFromJson,
    );
  }

  Future<HooksListReturn> list([HooksListOptions options = const HooksListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["hooks"],
      command: "list",
      body: requestBody,
      decode: hooksListReturnFromJson,
    );
  }

  Future<HooksRmReturn> rm(String id, [HooksRmOptions options = const HooksRmOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["hooks"],
      command: "rm",
      body: requestBody,
      decode: hooksRmReturnFromJson,
    );
  }

  Future<HooksShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["hooks"],
      command: "show",
      body: requestBody,
      decode: hooksShowReturnFromJson,
    );
  }

  Future<HooksTestReturn> test(String id, [HooksTestOptions options = const HooksTestOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["hooks"],
      command: "test",
      body: requestBody,
      decode: hooksTestReturnFromJson,
    );
  }
}

class ImageNamespace {
  const ImageNamespace(this._transport);

  final RaviTransport _transport;

  ImageAtlasNamespace get atlas => ImageAtlasNamespace(_transport);

  Future<ImageGenerateReturn> generate(String prompt, [ImageGenerateOptions options = const ImageGenerateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["prompt"] = RaviJson.from(prompt);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["image"],
      command: "generate",
      body: requestBody,
      decode: imageGenerateReturnFromJson,
    );
  }
}

class ImageAtlasNamespace {
  const ImageAtlasNamespace(this._transport);

  final RaviTransport _transport;

  Future<ImageAtlasSplitReturn> split(String input, [ImageAtlasSplitOptions options = const ImageAtlasSplitOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["input"] = RaviJson.from(input);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["image", "atlas"],
      command: "split",
      body: requestBody,
      decode: imageAtlasSplitReturnFromJson,
    );
  }
}

class InboxNamespace {
  const InboxNamespace(this._transport);

  final RaviTransport _transport;

  Future<InboxArchiveReturn> archive(String item) async {
    final requestBody = <String, RaviJson>{};
    requestBody["item"] = RaviJson.from(item);
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "archive",
      body: requestBody,
      decode: inboxArchiveReturnFromJson,
    );
  }

  Future<InboxDisableReturn> disable() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "disable",
      body: requestBody,
      decode: inboxDisableReturnFromJson,
    );
  }

  Future<InboxDoneReturn> done(String item) async {
    final requestBody = <String, RaviJson>{};
    requestBody["item"] = RaviJson.from(item);
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "done",
      body: requestBody,
      decode: inboxDoneReturnFromJson,
    );
  }

  Future<InboxEnableReturn> enable() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "enable",
      body: requestBody,
      decode: inboxEnableReturnFromJson,
    );
  }

  Future<InboxItemsReturn> items([InboxItemsOptions options = const InboxItemsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "items",
      body: requestBody,
      decode: inboxItemsReturnFromJson,
    );
  }

  Future<InboxListReturn> list([InboxListOptions options = const InboxListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "list",
      body: requestBody,
      decode: inboxListReturnFromJson,
    );
  }

  Future<InboxPollReturn> poll([InboxPollOptions options = const InboxPollOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "poll",
      body: requestBody,
      decode: inboxPollReturnFromJson,
    );
  }

  Future<InboxReadReturn> read(String item) async {
    final requestBody = <String, RaviJson>{};
    requestBody["item"] = RaviJson.from(item);
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "read",
      body: requestBody,
      decode: inboxReadReturnFromJson,
    );
  }

  Future<InboxReplayReturn> replay(String ref, [InboxReplayOptions options = const InboxReplayOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["ref"] = RaviJson.from(ref);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "replay",
      body: requestBody,
      decode: inboxReplayReturnFromJson,
    );
  }

  Future<InboxSnoozeReturn> snooze(String item, [InboxSnoozeOptions options = const InboxSnoozeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["item"] = RaviJson.from(item);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "snooze",
      body: requestBody,
      decode: inboxSnoozeReturnFromJson,
    );
  }

  Future<InboxSourcesReturn> sources() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "sources",
      body: requestBody,
      decode: inboxSourcesReturnFromJson,
    );
  }

  Future<InboxStatusReturn> status() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["inbox"],
      command: "status",
      body: requestBody,
      decode: inboxStatusReturnFromJson,
    );
  }
}

class InsightsNamespace {
  const InsightsNamespace(this._transport);

  final RaviTransport _transport;

  Future<InsightsCreateReturn> create(String summary, [InsightsCreateOptions options = const InsightsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["summary"] = RaviJson.from(summary);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["insights"],
      command: "create",
      body: requestBody,
      decode: insightsCreateReturnFromJson,
    );
  }

  Future<InsightsListReturn> list([InsightsListOptions options = const InsightsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["insights"],
      command: "list",
      body: requestBody,
      decode: insightsListReturnFromJson,
    );
  }

  Future<InsightsSearchReturn> search(String text, [InsightsSearchOptions options = const InsightsSearchOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["text"] = RaviJson.from(text);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["insights"],
      command: "search",
      body: requestBody,
      decode: insightsSearchReturnFromJson,
    );
  }

  Future<InsightsShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["insights"],
      command: "show",
      body: requestBody,
      decode: insightsShowReturnFromJson,
    );
  }
}

class InstancesNamespace {
  const InstancesNamespace(this._transport);

  final RaviTransport _transport;

  InstancesPendingNamespace get pending => InstancesPendingNamespace(_transport);

  InstancesRoutesNamespace get routes => InstancesRoutesNamespace(_transport);

  Future<InstancesCreateReturn> create(String name, [InstancesCreateOptions options = const InstancesCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "create",
      body: requestBody,
      decode: instancesCreateReturnFromJson,
    );
  }

  Future<InstancesDeleteReturn> delete(String name) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "delete",
      body: requestBody,
      decode: instancesDeleteReturnFromJson,
    );
  }

  Future<InstancesDeletedReturn> deleted() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "deleted",
      body: requestBody,
      decode: instancesDeletedReturnFromJson,
    );
  }

  Future<InstancesDisableReturn> disable(String target) async {
    final requestBody = <String, RaviJson>{};
    requestBody["target"] = RaviJson.from(target);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "disable",
      body: requestBody,
      decode: instancesDisableReturnFromJson,
    );
  }

  Future<InstancesDisconnectReturn> disconnect(String name) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "disconnect",
      body: requestBody,
      decode: instancesDisconnectReturnFromJson,
    );
  }

  Future<InstancesEnableReturn> enable(String target) async {
    final requestBody = <String, RaviJson>{};
    requestBody["target"] = RaviJson.from(target);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "enable",
      body: requestBody,
      decode: instancesEnableReturnFromJson,
    );
  }

  Future<InstancesGetReturn> get_(String name, String key) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["key"] = RaviJson.from(key);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "get",
      body: requestBody,
      decode: instancesGetReturnFromJson,
    );
  }

  Future<InstancesListReturn> list([InstancesListOptions options = const InstancesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "list",
      body: requestBody,
      decode: instancesListReturnFromJson,
    );
  }

  Future<InstancesRestoreReturn> restore(String name) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "restore",
      body: requestBody,
      decode: instancesRestoreReturnFromJson,
    );
  }

  Future<InstancesSetReturn> set_(String name, String key, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "set",
      body: requestBody,
      decode: instancesSetReturnFromJson,
    );
  }

  Future<InstancesShowReturn> show(String name) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "show",
      body: requestBody,
      decode: instancesShowReturnFromJson,
    );
  }

  Future<InstancesStatusReturn> status(String name) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "status",
      body: requestBody,
      decode: instancesStatusReturnFromJson,
    );
  }

  Future<InstancesTargetReturn> target(String name, [InstancesTargetOptions options = const InstancesTargetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances"],
      command: "target",
      body: requestBody,
      decode: instancesTargetReturnFromJson,
    );
  }
}

class InstancesPendingNamespace {
  const InstancesPendingNamespace(this._transport);

  final RaviTransport _transport;

  Future<InstancesPendingApproveReturn> approve(String name, String contact, [InstancesPendingApproveOptions options = const InstancesPendingApproveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances", "pending"],
      command: "approve",
      body: requestBody,
      decode: instancesPendingApproveReturnFromJson,
    );
  }

  Future<InstancesPendingListReturn> list(String name, [InstancesPendingListOptions options = const InstancesPendingListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances", "pending"],
      command: "list",
      body: requestBody,
      decode: instancesPendingListReturnFromJson,
    );
  }

  Future<InstancesPendingRejectReturn> reject(String name, String contact, [InstancesPendingRejectOptions options = const InstancesPendingRejectOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances", "pending"],
      command: "reject",
      body: requestBody,
      decode: instancesPendingRejectReturnFromJson,
    );
  }
}

class InstancesRoutesNamespace {
  const InstancesRoutesNamespace(this._transport);

  final RaviTransport _transport;

  Future<InstancesRoutesAddReturn> add(String name, String pattern, String agent, [InstancesRoutesAddOptions options = const InstancesRoutesAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["pattern"] = RaviJson.from(pattern);
    requestBody["agent"] = RaviJson.from(agent);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances", "routes"],
      command: "add",
      body: requestBody,
      decode: instancesRoutesAddReturnFromJson,
    );
  }

  Future<InstancesRoutesDeletedReturn> deleted([String? name]) async {
    final requestBody = <String, RaviJson>{};
    if (name != null) {
      requestBody["name"] = RaviJson.from(name);
    }
    return _transport.callJson(
      groupSegments: const ["instances", "routes"],
      command: "deleted",
      body: requestBody,
      decode: instancesRoutesDeletedReturnFromJson,
    );
  }

  Future<InstancesRoutesListReturn> list(String name, [InstancesRoutesListOptions options = const InstancesRoutesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances", "routes"],
      command: "list",
      body: requestBody,
      decode: instancesRoutesListReturnFromJson,
    );
  }

  Future<InstancesRoutesRemoveReturn> remove(String name, String pattern, [InstancesRoutesRemoveOptions options = const InstancesRoutesRemoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["pattern"] = RaviJson.from(pattern);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances", "routes"],
      command: "remove",
      body: requestBody,
      decode: instancesRoutesRemoveReturnFromJson,
    );
  }

  Future<InstancesRoutesRestoreReturn> restore(String name, String pattern, [InstancesRoutesRestoreOptions options = const InstancesRoutesRestoreOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["pattern"] = RaviJson.from(pattern);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances", "routes"],
      command: "restore",
      body: requestBody,
      decode: instancesRoutesRestoreReturnFromJson,
    );
  }

  Future<InstancesRoutesSetReturn> set_(String name, String pattern, String key, String value, [InstancesRoutesSetOptions options = const InstancesRoutesSetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["pattern"] = RaviJson.from(pattern);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["instances", "routes"],
      command: "set",
      body: requestBody,
      decode: instancesRoutesSetReturnFromJson,
    );
  }

  Future<InstancesRoutesShowReturn> show(String name, String pattern) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["pattern"] = RaviJson.from(pattern);
    return _transport.callJson(
      groupSegments: const ["instances", "routes"],
      command: "show",
      body: requestBody,
      decode: instancesRoutesShowReturnFromJson,
    );
  }
}

class MailNamespace {
  const MailNamespace(this._transport);

  final RaviTransport _transport;

  MailAccountsNamespace get accounts => MailAccountsNamespace(_transport);

  MailDomainsNamespace get domains => MailDomainsNamespace(_transport);

  MailMailboxesNamespace get mailboxes => MailMailboxesNamespace(_transport);

  MailMessagesNamespace get messages => MailMessagesNamespace(_transport);

  MailOutboxNamespace get outbox => MailOutboxNamespace(_transport);

  MailProvidersNamespace get providers => MailProvidersNamespace(_transport);

  MailThreadsNamespace get threads => MailThreadsNamespace(_transport);

  Future<MailReplyReturn> reply(String message, [MailReplyOptions options = const MailReplyOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail"],
      command: "reply",
      body: requestBody,
      decode: mailReplyReturnFromJson,
    );
  }

  Future<MailSendReturn> send([MailSendOptions options = const MailSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail"],
      command: "send",
      body: requestBody,
      decode: mailSendReturnFromJson,
    );
  }
}

class MailAccountsNamespace {
  const MailAccountsNamespace(this._transport);

  final RaviTransport _transport;

  Future<MailAccountsCreateReturn> create([MailAccountsCreateOptions options = const MailAccountsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "accounts"],
      command: "create",
      body: requestBody,
      decode: mailAccountsCreateReturnFromJson,
    );
  }

  Future<MailAccountsListReturn> list([MailAccountsListOptions options = const MailAccountsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "accounts"],
      command: "list",
      body: requestBody,
      decode: mailAccountsListReturnFromJson,
    );
  }

  Future<MailAccountsSyncReturn> sync(String account, [MailAccountsSyncOptions options = const MailAccountsSyncOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["account"] = RaviJson.from(account);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "accounts"],
      command: "sync",
      body: requestBody,
      decode: mailAccountsSyncReturnFromJson,
    );
  }
}

class MailDomainsNamespace {
  const MailDomainsNamespace(this._transport);

  final RaviTransport _transport;

  Future<MailDomainsCreateReturn> create(String domain, [MailDomainsCreateOptions options = const MailDomainsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["domain"] = RaviJson.from(domain);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "domains"],
      command: "create",
      body: requestBody,
      decode: mailDomainsCreateReturnFromJson,
    );
  }

  Future<MailDomainsListReturn> list([MailDomainsListOptions options = const MailDomainsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "domains"],
      command: "list",
      body: requestBody,
      decode: mailDomainsListReturnFromJson,
    );
  }
}

class MailMailboxesNamespace {
  const MailMailboxesNamespace(this._transport);

  final RaviTransport _transport;

  Future<MailMailboxesCreateReturn> create(String address, [MailMailboxesCreateOptions options = const MailMailboxesCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["address"] = RaviJson.from(address);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "mailboxes"],
      command: "create",
      body: requestBody,
      decode: mailMailboxesCreateReturnFromJson,
    );
  }

  Future<MailMailboxesDisableReturn> disable(String mailbox) async {
    final requestBody = <String, RaviJson>{};
    requestBody["mailbox"] = RaviJson.from(mailbox);
    return _transport.callJson(
      groupSegments: const ["mail", "mailboxes"],
      command: "disable",
      body: requestBody,
      decode: mailMailboxesDisableReturnFromJson,
    );
  }

  Future<MailMailboxesListReturn> list([MailMailboxesListOptions options = const MailMailboxesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "mailboxes"],
      command: "list",
      body: requestBody,
      decode: mailMailboxesListReturnFromJson,
    );
  }

  Future<MailMailboxesShowReturn> show(String mailbox) async {
    final requestBody = <String, RaviJson>{};
    requestBody["mailbox"] = RaviJson.from(mailbox);
    return _transport.callJson(
      groupSegments: const ["mail", "mailboxes"],
      command: "show",
      body: requestBody,
      decode: mailMailboxesShowReturnFromJson,
    );
  }
}

class MailMessagesNamespace {
  const MailMessagesNamespace(this._transport);

  final RaviTransport _transport;

  Future<MailMessagesImportReturn> import_([MailMessagesImportOptions options = const MailMessagesImportOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "messages"],
      command: "import",
      body: requestBody,
      decode: mailMessagesImportReturnFromJson,
    );
  }

  Future<MailMessagesListReturn> list([MailMessagesListOptions options = const MailMessagesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "messages"],
      command: "list",
      body: requestBody,
      decode: mailMessagesListReturnFromJson,
    );
  }

  Future<MailMessagesReadReturn> read(String message, [MailMessagesReadOptions options = const MailMessagesReadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "messages"],
      command: "read",
      body: requestBody,
      decode: mailMessagesReadReturnFromJson,
    );
  }

  Future<MailMessagesSearchReturn> search(String query, [MailMessagesSearchOptions options = const MailMessagesSearchOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["query"] = RaviJson.from(query);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "messages"],
      command: "search",
      body: requestBody,
      decode: mailMessagesSearchReturnFromJson,
    );
  }
}

class MailOutboxNamespace {
  const MailOutboxNamespace(this._transport);

  final RaviTransport _transport;

  Future<MailOutboxInspectReturn> inspect(String outbox) async {
    final requestBody = <String, RaviJson>{};
    requestBody["outbox"] = RaviJson.from(outbox);
    return _transport.callJson(
      groupSegments: const ["mail", "outbox"],
      command: "inspect",
      body: requestBody,
      decode: mailOutboxInspectReturnFromJson,
    );
  }

  Future<MailOutboxListReturn> list([MailOutboxListOptions options = const MailOutboxListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "outbox"],
      command: "list",
      body: requestBody,
      decode: mailOutboxListReturnFromJson,
    );
  }

  Future<MailOutboxRetryReturn> retry(String outbox) async {
    final requestBody = <String, RaviJson>{};
    requestBody["outbox"] = RaviJson.from(outbox);
    return _transport.callJson(
      groupSegments: const ["mail", "outbox"],
      command: "retry",
      body: requestBody,
      decode: mailOutboxRetryReturnFromJson,
    );
  }

  Future<MailOutboxStatusReturn> status() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["mail", "outbox"],
      command: "status",
      body: requestBody,
      decode: mailOutboxStatusReturnFromJson,
    );
  }
}

class MailProvidersNamespace {
  const MailProvidersNamespace(this._transport);

  final RaviTransport _transport;

  MailProvidersRaviMailNamespace get raviMail => MailProvidersRaviMailNamespace(_transport);

  Future<MailProvidersListReturn> list([MailProvidersListOptions options = const MailProvidersListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "providers"],
      command: "list",
      body: requestBody,
      decode: mailProvidersListReturnFromJson,
    );
  }
}

class MailProvidersRaviMailNamespace {
  const MailProvidersRaviMailNamespace(this._transport);

  final RaviTransport _transport;

  MailProvidersRaviMailMailboxesNamespace get mailboxes => MailProvidersRaviMailMailboxesNamespace(_transport);

  MailProvidersRaviMailMessagesNamespace get messages => MailProvidersRaviMailMessagesNamespace(_transport);

  Future<MailProvidersRaviMailSendReturn> send([MailProvidersRaviMailSendOptions options = const MailProvidersRaviMailSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "providers", "ravi-mail"],
      command: "send",
      body: requestBody,
      decode: mailProvidersRaviMailSendReturnFromJson,
    );
  }
}

class MailProvidersRaviMailMailboxesNamespace {
  const MailProvidersRaviMailMailboxesNamespace(this._transport);

  final RaviTransport _transport;

  Future<MailProvidersRaviMailMailboxesCreateReturn> create(String addressOrLocalPart, [MailProvidersRaviMailMailboxesCreateOptions options = const MailProvidersRaviMailMailboxesCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["addressOrLocalPart"] = RaviJson.from(addressOrLocalPart);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "providers", "ravi-mail", "mailboxes"],
      command: "create",
      body: requestBody,
      decode: mailProvidersRaviMailMailboxesCreateReturnFromJson,
    );
  }

  Future<MailProvidersRaviMailMailboxesDisableReturn> disable(String mailbox, [MailProvidersRaviMailMailboxesDisableOptions options = const MailProvidersRaviMailMailboxesDisableOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["mailbox"] = RaviJson.from(mailbox);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "providers", "ravi-mail", "mailboxes"],
      command: "disable",
      body: requestBody,
      decode: mailProvidersRaviMailMailboxesDisableReturnFromJson,
    );
  }

  Future<MailProvidersRaviMailMailboxesListReturn> list([MailProvidersRaviMailMailboxesListOptions options = const MailProvidersRaviMailMailboxesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "providers", "ravi-mail", "mailboxes"],
      command: "list",
      body: requestBody,
      decode: mailProvidersRaviMailMailboxesListReturnFromJson,
    );
  }

  Future<MailProvidersRaviMailMailboxesShowReturn> show(String mailbox, [MailProvidersRaviMailMailboxesShowOptions options = const MailProvidersRaviMailMailboxesShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["mailbox"] = RaviJson.from(mailbox);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "providers", "ravi-mail", "mailboxes"],
      command: "show",
      body: requestBody,
      decode: mailProvidersRaviMailMailboxesShowReturnFromJson,
    );
  }
}

class MailProvidersRaviMailMessagesNamespace {
  const MailProvidersRaviMailMessagesNamespace(this._transport);

  final RaviTransport _transport;

  Future<MailProvidersRaviMailMessagesListReturn> list([MailProvidersRaviMailMessagesListOptions options = const MailProvidersRaviMailMessagesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "providers", "ravi-mail", "messages"],
      command: "list",
      body: requestBody,
      decode: mailProvidersRaviMailMessagesListReturnFromJson,
    );
  }

  Future<MailProvidersRaviMailMessagesReadReturn> read(String message, [MailProvidersRaviMailMessagesReadOptions options = const MailProvidersRaviMailMessagesReadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "providers", "ravi-mail", "messages"],
      command: "read",
      body: requestBody,
      decode: mailProvidersRaviMailMessagesReadReturnFromJson,
    );
  }

  Future<MailProvidersRaviMailMessagesShowReturn> show(String message, [MailProvidersRaviMailMessagesShowOptions options = const MailProvidersRaviMailMessagesShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "providers", "ravi-mail", "messages"],
      command: "show",
      body: requestBody,
      decode: mailProvidersRaviMailMessagesShowReturnFromJson,
    );
  }
}

class MailThreadsNamespace {
  const MailThreadsNamespace(this._transport);

  final RaviTransport _transport;

  Future<MailThreadsReadReturn> read(String thread, [MailThreadsReadOptions options = const MailThreadsReadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["thread"] = RaviJson.from(thread);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["mail", "threads"],
      command: "read",
      body: requestBody,
      decode: mailThreadsReadReturnFromJson,
    );
  }
}

class MediaNamespace {
  const MediaNamespace(this._transport);

  final RaviTransport _transport;

  Future<MediaSendReturn> send(String filePath, [MediaSendOptions options = const MediaSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["filePath"] = RaviJson.from(filePath);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["media"],
      command: "send",
      body: requestBody,
      decode: mediaSendReturnFromJson,
    );
  }
}

class MeetingsNamespace {
  const MeetingsNamespace(this._transport);

  final RaviTransport _transport;

  MeetingsProfilesNamespace get profiles => MeetingsProfilesNamespace(_transport);

  Future<MeetingsFinalizeReturn> finalize([MeetingsFinalizeOptions options = const MeetingsFinalizeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["meetings"],
      command: "finalize",
      body: requestBody,
      decode: meetingsFinalizeReturnFromJson,
    );
  }

  Future<MeetingsVoiceRuntimesReturn> voiceRuntimes() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["meetings"],
      command: "voice-runtimes",
      body: requestBody,
      decode: meetingsVoiceRuntimesReturnFromJson,
    );
  }
}

class MeetingsProfilesNamespace {
  const MeetingsProfilesNamespace(this._transport);

  final RaviTransport _transport;

  Future<MeetingsProfilesInitReturn> init(String profileId, [MeetingsProfilesInitOptions options = const MeetingsProfilesInitOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profileId"] = RaviJson.from(profileId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["meetings", "profiles"],
      command: "init",
      body: requestBody,
      decode: meetingsProfilesInitReturnFromJson,
    );
  }

  Future<MeetingsProfilesListReturn> list([MeetingsProfilesListOptions options = const MeetingsProfilesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["meetings", "profiles"],
      command: "list",
      body: requestBody,
      decode: meetingsProfilesListReturnFromJson,
    );
  }

  Future<MeetingsProfilesShowReturn> show(String profileId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profileId"] = RaviJson.from(profileId);
    return _transport.callJson(
      groupSegments: const ["meetings", "profiles"],
      command: "show",
      body: requestBody,
      decode: meetingsProfilesShowReturnFromJson,
    );
  }

  Future<MeetingsProfilesValidateReturn> validate([String? profileId]) async {
    final requestBody = <String, RaviJson>{};
    if (profileId != null) {
      requestBody["profileId"] = RaviJson.from(profileId);
    }
    return _transport.callJson(
      groupSegments: const ["meetings", "profiles"],
      command: "validate",
      body: requestBody,
      decode: meetingsProfilesValidateReturnFromJson,
    );
  }
}

class MetricsNamespace {
  const MetricsNamespace(this._transport);

  final RaviTransport _transport;

  Future<MetricsDatesReturn> dates() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["metrics"],
      command: "dates",
      body: requestBody,
      decode: metricsDatesReturnFromJson,
    );
  }

  Future<MetricsRollupReturn> rollup([MetricsRollupOptions options = const MetricsRollupOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["metrics"],
      command: "rollup",
      body: requestBody,
      decode: metricsRollupReturnFromJson,
    );
  }

  Future<MetricsShowReturn> show([MetricsShowOptions options = const MetricsShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["metrics"],
      command: "show",
      body: requestBody,
      decode: metricsShowReturnFromJson,
    );
  }
}

class ObserversNamespace {
  const ObserversNamespace(this._transport);

  final RaviTransport _transport;

  ObserversProfilesNamespace get profiles => ObserversProfilesNamespace(_transport);

  ObserversRulesNamespace get rules => ObserversRulesNamespace(_transport);

  Future<ObserversListReturn> list([ObserversListOptions options = const ObserversListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["observers"],
      command: "list",
      body: requestBody,
      decode: observersListReturnFromJson,
    );
  }

  Future<ObserversRefreshReturn> refresh(String session, [ObserversRefreshOptions options = const ObserversRefreshOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["observers"],
      command: "refresh",
      body: requestBody,
      decode: observersRefreshReturnFromJson,
    );
  }

  Future<ObserversShowReturn> show(String bindingId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["bindingId"] = RaviJson.from(bindingId);
    return _transport.callJson(
      groupSegments: const ["observers"],
      command: "show",
      body: requestBody,
      decode: observersShowReturnFromJson,
    );
  }
}

class ObserversProfilesNamespace {
  const ObserversProfilesNamespace(this._transport);

  final RaviTransport _transport;

  Future<ObserversProfilesInitReturn> init(String profileId, [ObserversProfilesInitOptions options = const ObserversProfilesInitOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profileId"] = RaviJson.from(profileId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["observers", "profiles"],
      command: "init",
      body: requestBody,
      decode: observersProfilesInitReturnFromJson,
    );
  }

  Future<ObserversProfilesListReturn> list([ObserversProfilesListOptions options = const ObserversProfilesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["observers", "profiles"],
      command: "list",
      body: requestBody,
      decode: observersProfilesListReturnFromJson,
    );
  }

  Future<ObserversProfilesPreviewReturn> preview(String profileId, [ObserversProfilesPreviewOptions options = const ObserversProfilesPreviewOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profileId"] = RaviJson.from(profileId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["observers", "profiles"],
      command: "preview",
      body: requestBody,
      decode: observersProfilesPreviewReturnFromJson,
    );
  }

  Future<ObserversProfilesShowReturn> show(String profileId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profileId"] = RaviJson.from(profileId);
    return _transport.callJson(
      groupSegments: const ["observers", "profiles"],
      command: "show",
      body: requestBody,
      decode: observersProfilesShowReturnFromJson,
    );
  }

  Future<ObserversProfilesValidateReturn> validate([String? profileId]) async {
    final requestBody = <String, RaviJson>{};
    if (profileId != null) {
      requestBody["profileId"] = RaviJson.from(profileId);
    }
    return _transport.callJson(
      groupSegments: const ["observers", "profiles"],
      command: "validate",
      body: requestBody,
      decode: observersProfilesValidateReturnFromJson,
    );
  }
}

class ObserversRulesNamespace {
  const ObserversRulesNamespace(this._transport);

  final RaviTransport _transport;

  Future<ObserversRulesDisableReturn> disable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["observers", "rules"],
      command: "disable",
      body: requestBody,
      decode: observersRulesDisableReturnFromJson,
    );
  }

  Future<ObserversRulesEnableReturn> enable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["observers", "rules"],
      command: "enable",
      body: requestBody,
      decode: observersRulesEnableReturnFromJson,
    );
  }

  Future<ObserversRulesExplainReturn> explain(String session) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    return _transport.callJson(
      groupSegments: const ["observers", "rules"],
      command: "explain",
      body: requestBody,
      decode: observersRulesExplainReturnFromJson,
    );
  }

  Future<ObserversRulesListReturn> list([ObserversRulesListOptions options = const ObserversRulesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["observers", "rules"],
      command: "list",
      body: requestBody,
      decode: observersRulesListReturnFromJson,
    );
  }

  Future<ObserversRulesRmReturn> rm(String id, [ObserversRulesRmOptions options = const ObserversRulesRmOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["observers", "rules"],
      command: "rm",
      body: requestBody,
      decode: observersRulesRmReturnFromJson,
    );
  }

  Future<ObserversRulesSetReturn> set_(String id, String observerAgentId, [ObserversRulesSetOptions options = const ObserversRulesSetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["observerAgentId"] = RaviJson.from(observerAgentId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["observers", "rules"],
      command: "set",
      body: requestBody,
      decode: observersRulesSetReturnFromJson,
    );
  }

  Future<ObserversRulesShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["observers", "rules"],
      command: "show",
      body: requestBody,
      decode: observersRulesShowReturnFromJson,
    );
  }

  Future<ObserversRulesValidateReturn> validate() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["observers", "rules"],
      command: "validate",
      body: requestBody,
      decode: observersRulesValidateReturnFromJson,
    );
  }
}

class PagesNamespace {
  const PagesNamespace(this._transport);

  final RaviTransport _transport;

  PagesPasswordNamespace get password => PagesPasswordNamespace(_transport);

  Future<PagesCreateReturn> create(List<String> args, [PagesCreateOptions options = const PagesCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["args"] = RaviJson.from(args);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages"],
      command: "create",
      body: requestBody,
      decode: pagesCreateReturnFromJson,
    );
  }

  Future<PagesDomainsReturn> domains(List<String> args, [PagesDomainsOptions options = const PagesDomainsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["args"] = RaviJson.from(args);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages"],
      command: "domains",
      body: requestBody,
      decode: pagesDomainsReturnFromJson,
    );
  }

  Future<PagesListReturn> list([String? project, PagesListOptions options = const PagesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (project != null) {
      requestBody["project"] = RaviJson.from(project);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages"],
      command: "list",
      body: requestBody,
      decode: pagesListReturnFromJson,
    );
  }

  Future<PagesPublishReturn> publish(List<String> args, [PagesPublishOptions options = const PagesPublishOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["args"] = RaviJson.from(args);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages"],
      command: "publish",
      body: requestBody,
      decode: pagesPublishReturnFromJson,
    );
  }

  Future<PagesPublishedReturn> published([String? project, PagesPublishedOptions options = const PagesPublishedOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (project != null) {
      requestBody["project"] = RaviJson.from(project);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages"],
      command: "published",
      body: requestBody,
      decode: pagesPublishedReturnFromJson,
    );
  }

  Future<PagesShipReturn> ship([List<String>? args, PagesShipOptions options = const PagesShipOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (args != null) {
      requestBody["args"] = RaviJson.from(args);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages"],
      command: "ship",
      body: requestBody,
      decode: pagesShipReturnFromJson,
    );
  }

  Future<PagesUpdateReturn> update(List<String> args, [PagesUpdateOptions options = const PagesUpdateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["args"] = RaviJson.from(args);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages"],
      command: "update",
      body: requestBody,
      decode: pagesUpdateReturnFromJson,
    );
  }

  Future<PagesVisibilityReturn> visibility(List<String> args, [PagesVisibilityOptions options = const PagesVisibilityOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["args"] = RaviJson.from(args);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages"],
      command: "visibility",
      body: requestBody,
      decode: pagesVisibilityReturnFromJson,
    );
  }
}

class PagesPasswordNamespace {
  const PagesPasswordNamespace(this._transport);

  final RaviTransport _transport;

  Future<PagesPasswordRemoveReturn> remove(List<String> args, [PagesPasswordRemoveOptions options = const PagesPasswordRemoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["args"] = RaviJson.from(args);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages", "password"],
      command: "remove",
      body: requestBody,
      decode: pagesPasswordRemoveReturnFromJson,
    );
  }

  Future<PagesPasswordStatusReturn> status(List<String> args, [PagesPasswordStatusOptions options = const PagesPasswordStatusOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["args"] = RaviJson.from(args);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["pages", "password"],
      command: "status",
      body: requestBody,
      decode: pagesPasswordStatusReturnFromJson,
    );
  }
}

class PermissionsNamespace {
  const PermissionsNamespace(this._transport);

  final RaviTransport _transport;

  Future<PermissionsAllowReturn> allow(String profile, [PermissionsAllowOptions options = const PermissionsAllowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profile"] = RaviJson.from(profile);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["permissions"],
      command: "allow",
      body: requestBody,
      decode: permissionsAllowReturnFromJson,
    );
  }

  Future<PermissionsCheckReturn> check([PermissionsCheckOptions options = const PermissionsCheckOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["permissions"],
      command: "check",
      body: requestBody,
      decode: permissionsCheckReturnFromJson,
    );
  }

  Future<PermissionsMaterializeReturn> materialize([PermissionsMaterializeOptions options = const PermissionsMaterializeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["permissions"],
      command: "materialize",
      body: requestBody,
      decode: permissionsMaterializeReturnFromJson,
    );
  }

  Future<PermissionsResolveReturn> resolve(String denialId, [PermissionsResolveOptions options = const PermissionsResolveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["denialId"] = RaviJson.from(denialId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["permissions"],
      command: "resolve",
      body: requestBody,
      decode: permissionsResolveReturnFromJson,
    );
  }

  Future<PermissionsStatusReturn> status() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["permissions"],
      command: "status",
      body: requestBody,
      decode: permissionsStatusReturnFromJson,
    );
  }
}

class ProjectsNamespace {
  const ProjectsNamespace(this._transport);

  final RaviTransport _transport;

  ProjectsFixturesNamespace get fixtures => ProjectsFixturesNamespace(_transport);

  ProjectsResourcesNamespace get resources => ProjectsResourcesNamespace(_transport);

  ProjectsTasksNamespace get tasks => ProjectsTasksNamespace(_transport);

  ProjectsWorkflowsNamespace get workflows => ProjectsWorkflowsNamespace(_transport);

  Future<ProjectsCreateReturn> create(String title, [ProjectsCreateOptions options = const ProjectsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["title"] = RaviJson.from(title);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects"],
      command: "create",
      body: requestBody,
      decode: projectsCreateReturnFromJson,
    );
  }

  Future<ProjectsInitReturn> init(String title, [ProjectsInitOptions options = const ProjectsInitOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["title"] = RaviJson.from(title);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects"],
      command: "init",
      body: requestBody,
      decode: projectsInitReturnFromJson,
    );
  }

  Future<ProjectsLinkReturn> link(String assetType, String project, String target, [ProjectsLinkOptions options = const ProjectsLinkOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["assetType"] = RaviJson.from(assetType);
    requestBody["project"] = RaviJson.from(project);
    requestBody["target"] = RaviJson.from(target);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects"],
      command: "link",
      body: requestBody,
      decode: projectsLinkReturnFromJson,
    );
  }

  Future<ProjectsListReturn> list([ProjectsListOptions options = const ProjectsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects"],
      command: "list",
      body: requestBody,
      decode: projectsListReturnFromJson,
    );
  }

  Future<ProjectsNextReturn> next([ProjectsNextOptions options = const ProjectsNextOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects"],
      command: "next",
      body: requestBody,
      decode: projectsNextReturnFromJson,
    );
  }

  Future<ProjectsShowReturn> show(String project) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    return _transport.callJson(
      groupSegments: const ["projects"],
      command: "show",
      body: requestBody,
      decode: projectsShowReturnFromJson,
    );
  }

  Future<ProjectsStatusReturn> status(String project) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    return _transport.callJson(
      groupSegments: const ["projects"],
      command: "status",
      body: requestBody,
      decode: projectsStatusReturnFromJson,
    );
  }

  Future<ProjectsUpdateReturn> update(String project, [ProjectsUpdateOptions options = const ProjectsUpdateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects"],
      command: "update",
      body: requestBody,
      decode: projectsUpdateReturnFromJson,
    );
  }
}

class ProjectsFixturesNamespace {
  const ProjectsFixturesNamespace(this._transport);

  final RaviTransport _transport;

  Future<ProjectsFixturesSeedReturn> seed([ProjectsFixturesSeedOptions options = const ProjectsFixturesSeedOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects", "fixtures"],
      command: "seed",
      body: requestBody,
      decode: projectsFixturesSeedReturnFromJson,
    );
  }
}

class ProjectsResourcesNamespace {
  const ProjectsResourcesNamespace(this._transport);

  final RaviTransport _transport;

  Future<ProjectsResourcesAddReturn> add(String project, String target, [ProjectsResourcesAddOptions options = const ProjectsResourcesAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    requestBody["target"] = RaviJson.from(target);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects", "resources"],
      command: "add",
      body: requestBody,
      decode: projectsResourcesAddReturnFromJson,
    );
  }

  Future<ProjectsResourcesImportReturn> import_(String project, [ProjectsResourcesImportOptions options = const ProjectsResourcesImportOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects", "resources"],
      command: "import",
      body: requestBody,
      decode: projectsResourcesImportReturnFromJson,
    );
  }

  Future<ProjectsResourcesListReturn> list(String project, [ProjectsResourcesListOptions options = const ProjectsResourcesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects", "resources"],
      command: "list",
      body: requestBody,
      decode: projectsResourcesListReturnFromJson,
    );
  }

  Future<ProjectsResourcesShowReturn> show(String project, String resource) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    requestBody["resource"] = RaviJson.from(resource);
    return _transport.callJson(
      groupSegments: const ["projects", "resources"],
      command: "show",
      body: requestBody,
      decode: projectsResourcesShowReturnFromJson,
    );
  }
}

class ProjectsTasksNamespace {
  const ProjectsTasksNamespace(this._transport);

  final RaviTransport _transport;

  Future<ProjectsTasksAttachReturn> attach(String project, String nodeKey, String taskId, [ProjectsTasksAttachOptions options = const ProjectsTasksAttachOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    requestBody["nodeKey"] = RaviJson.from(nodeKey);
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects", "tasks"],
      command: "attach",
      body: requestBody,
      decode: projectsTasksAttachReturnFromJson,
    );
  }

  Future<ProjectsTasksCreateReturn> create(String project, String nodeKey, String title, [ProjectsTasksCreateOptions options = const ProjectsTasksCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    requestBody["nodeKey"] = RaviJson.from(nodeKey);
    requestBody["title"] = RaviJson.from(title);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects", "tasks"],
      command: "create",
      body: requestBody,
      decode: projectsTasksCreateReturnFromJson,
    );
  }

  Future<ProjectsTasksDispatchReturn> dispatch(String project, String taskId, [ProjectsTasksDispatchOptions options = const ProjectsTasksDispatchOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects", "tasks"],
      command: "dispatch",
      body: requestBody,
      decode: projectsTasksDispatchReturnFromJson,
    );
  }
}

class ProjectsWorkflowsNamespace {
  const ProjectsWorkflowsNamespace(this._transport);

  final RaviTransport _transport;

  Future<ProjectsWorkflowsAttachReturn> attach(String project, String runId, [ProjectsWorkflowsAttachOptions options = const ProjectsWorkflowsAttachOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    requestBody["runId"] = RaviJson.from(runId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects", "workflows"],
      command: "attach",
      body: requestBody,
      decode: projectsWorkflowsAttachReturnFromJson,
    );
  }

  Future<ProjectsWorkflowsStartReturn> start(String project, String specId, [ProjectsWorkflowsStartOptions options = const ProjectsWorkflowsStartOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["project"] = RaviJson.from(project);
    requestBody["specId"] = RaviJson.from(specId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["projects", "workflows"],
      command: "start",
      body: requestBody,
      decode: projectsWorkflowsStartReturnFromJson,
    );
  }
}

class ProxNamespace {
  const ProxNamespace(this._transport);

  final RaviTransport _transport;

  ProxCallsNamespace get calls => ProxCallsNamespace(_transport);
}

class ProxCallsNamespace {
  const ProxCallsNamespace(this._transport);

  final RaviTransport _transport;

  ProxCallsProfilesNamespace get profiles => ProxCallsProfilesNamespace(_transport);

  ProxCallsToolsNamespace get tools => ProxCallsToolsNamespace(_transport);

  ProxCallsVoiceAgentsNamespace get voiceAgents => ProxCallsVoiceAgentsNamespace(_transport);

  Future<ProxCallsCancelReturn> cancel(String callRequestId, [ProxCallsCancelOptions options = const ProxCallsCancelOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["call_request_id"] = RaviJson.from(callRequestId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls"],
      command: "cancel",
      body: requestBody,
      decode: proxCallsCancelReturnFromJson,
    );
  }

  Future<ProxCallsEventsReturn> events(String callRequestId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["call_request_id"] = RaviJson.from(callRequestId);
    return _transport.callJson(
      groupSegments: const ["prox", "calls"],
      command: "events",
      body: requestBody,
      decode: proxCallsEventsReturnFromJson,
    );
  }

  Future<ProxCallsRequestReturn> request([ProxCallsRequestOptions options = const ProxCallsRequestOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls"],
      command: "request",
      body: requestBody,
      decode: proxCallsRequestReturnFromJson,
    );
  }

  Future<ProxCallsRulesReturn> rules([ProxCallsRulesOptions options = const ProxCallsRulesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls"],
      command: "rules",
      body: requestBody,
      decode: proxCallsRulesReturnFromJson,
    );
  }

  Future<ProxCallsShowReturn> show(String callRequestId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["call_request_id"] = RaviJson.from(callRequestId);
    return _transport.callJson(
      groupSegments: const ["prox", "calls"],
      command: "show",
      body: requestBody,
      decode: proxCallsShowReturnFromJson,
    );
  }

  Future<ProxCallsTranscriptReturn> transcript(String callRequestId, [ProxCallsTranscriptOptions options = const ProxCallsTranscriptOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["call_request_id"] = RaviJson.from(callRequestId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls"],
      command: "transcript",
      body: requestBody,
      decode: proxCallsTranscriptReturnFromJson,
    );
  }
}

class ProxCallsProfilesNamespace {
  const ProxCallsProfilesNamespace(this._transport);

  final RaviTransport _transport;

  Future<ProxCallsProfilesConfigureReturn> configure(String profileId, [ProxCallsProfilesConfigureOptions options = const ProxCallsProfilesConfigureOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profile_id"] = RaviJson.from(profileId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "profiles"],
      command: "configure",
      body: requestBody,
      decode: proxCallsProfilesConfigureReturnFromJson,
    );
  }

  Future<ProxCallsProfilesListReturn> list([ProxCallsProfilesListOptions options = const ProxCallsProfilesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "profiles"],
      command: "list",
      body: requestBody,
      decode: proxCallsProfilesListReturnFromJson,
    );
  }

  Future<ProxCallsProfilesShowReturn> show(String profileId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profile_id"] = RaviJson.from(profileId);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "profiles"],
      command: "show",
      body: requestBody,
      decode: proxCallsProfilesShowReturnFromJson,
    );
  }
}

class ProxCallsToolsNamespace {
  const ProxCallsToolsNamespace(this._transport);

  final RaviTransport _transport;

  Future<ProxCallsToolsBindReturn> bind(String profileId, String toolId, [ProxCallsToolsBindOptions options = const ProxCallsToolsBindOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profile_id"] = RaviJson.from(profileId);
    requestBody["tool_id"] = RaviJson.from(toolId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "tools"],
      command: "bind",
      body: requestBody,
      decode: proxCallsToolsBindReturnFromJson,
    );
  }

  Future<ProxCallsToolsConfigureReturn> configure(String toolId, [ProxCallsToolsConfigureOptions options = const ProxCallsToolsConfigureOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["tool_id"] = RaviJson.from(toolId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "tools"],
      command: "configure",
      body: requestBody,
      decode: proxCallsToolsConfigureReturnFromJson,
    );
  }

  Future<ProxCallsToolsCreateReturn> create(String toolId, [ProxCallsToolsCreateOptions options = const ProxCallsToolsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["tool_id"] = RaviJson.from(toolId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "tools"],
      command: "create",
      body: requestBody,
      decode: proxCallsToolsCreateReturnFromJson,
    );
  }

  Future<ProxCallsToolsListReturn> list([ProxCallsToolsListOptions options = const ProxCallsToolsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "tools"],
      command: "list",
      body: requestBody,
      decode: proxCallsToolsListReturnFromJson,
    );
  }

  Future<ProxCallsToolsRunReturn> run(String toolId, [ProxCallsToolsRunOptions options = const ProxCallsToolsRunOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["tool_id"] = RaviJson.from(toolId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "tools"],
      command: "run",
      body: requestBody,
      decode: proxCallsToolsRunReturnFromJson,
    );
  }

  Future<ProxCallsToolsRunsReturn> runs(String callRequestId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["call_request_id"] = RaviJson.from(callRequestId);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "tools"],
      command: "runs",
      body: requestBody,
      decode: proxCallsToolsRunsReturnFromJson,
    );
  }

  Future<ProxCallsToolsShowReturn> show(String toolId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["tool_id"] = RaviJson.from(toolId);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "tools"],
      command: "show",
      body: requestBody,
      decode: proxCallsToolsShowReturnFromJson,
    );
  }

  Future<ProxCallsToolsUnbindReturn> unbind(String profileId, String toolId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profile_id"] = RaviJson.from(profileId);
    requestBody["tool_id"] = RaviJson.from(toolId);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "tools"],
      command: "unbind",
      body: requestBody,
      decode: proxCallsToolsUnbindReturnFromJson,
    );
  }
}

class ProxCallsVoiceAgentsNamespace {
  const ProxCallsVoiceAgentsNamespace(this._transport);

  final RaviTransport _transport;

  Future<ProxCallsVoiceAgentsBindToolReturn> bindTool(String voiceAgentId, String toolId, [ProxCallsVoiceAgentsBindToolOptions options = const ProxCallsVoiceAgentsBindToolOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["voice_agent_id"] = RaviJson.from(voiceAgentId);
    requestBody["tool_id"] = RaviJson.from(toolId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "voice-agents"],
      command: "bind-tool",
      body: requestBody,
      decode: proxCallsVoiceAgentsBindToolReturnFromJson,
    );
  }

  Future<ProxCallsVoiceAgentsConfigureReturn> configure(String voiceAgentId, [ProxCallsVoiceAgentsConfigureOptions options = const ProxCallsVoiceAgentsConfigureOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["voice_agent_id"] = RaviJson.from(voiceAgentId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "voice-agents"],
      command: "configure",
      body: requestBody,
      decode: proxCallsVoiceAgentsConfigureReturnFromJson,
    );
  }

  Future<ProxCallsVoiceAgentsCreateReturn> create(String voiceAgentId, [ProxCallsVoiceAgentsCreateOptions options = const ProxCallsVoiceAgentsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["voice_agent_id"] = RaviJson.from(voiceAgentId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "voice-agents"],
      command: "create",
      body: requestBody,
      decode: proxCallsVoiceAgentsCreateReturnFromJson,
    );
  }

  Future<ProxCallsVoiceAgentsListReturn> list([ProxCallsVoiceAgentsListOptions options = const ProxCallsVoiceAgentsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "voice-agents"],
      command: "list",
      body: requestBody,
      decode: proxCallsVoiceAgentsListReturnFromJson,
    );
  }

  Future<ProxCallsVoiceAgentsShowReturn> show(String voiceAgentId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["voice_agent_id"] = RaviJson.from(voiceAgentId);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "voice-agents"],
      command: "show",
      body: requestBody,
      decode: proxCallsVoiceAgentsShowReturnFromJson,
    );
  }

  Future<ProxCallsVoiceAgentsSyncReturn> sync(String voiceAgentId, [ProxCallsVoiceAgentsSyncOptions options = const ProxCallsVoiceAgentsSyncOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["voice_agent_id"] = RaviJson.from(voiceAgentId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "voice-agents"],
      command: "sync",
      body: requestBody,
      decode: proxCallsVoiceAgentsSyncReturnFromJson,
    );
  }

  Future<ProxCallsVoiceAgentsUnbindToolReturn> unbindTool(String voiceAgentId, String toolId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["voice_agent_id"] = RaviJson.from(voiceAgentId);
    requestBody["tool_id"] = RaviJson.from(toolId);
    return _transport.callJson(
      groupSegments: const ["prox", "calls", "voice-agents"],
      command: "unbind-tool",
      body: requestBody,
      decode: proxCallsVoiceAgentsUnbindToolReturnFromJson,
    );
  }
}

class ReactNamespace {
  const ReactNamespace(this._transport);

  final RaviTransport _transport;

  Future<ReactSendReturn> send(String messageId, String emoji) async {
    final requestBody = <String, RaviJson>{};
    requestBody["messageId"] = RaviJson.from(messageId);
    requestBody["emoji"] = RaviJson.from(emoji);
    return _transport.callJson(
      groupSegments: const ["react"],
      command: "send",
      body: requestBody,
      decode: reactSendReturnFromJson,
    );
  }
}

class RoutesNamespace {
  const RoutesNamespace(this._transport);

  final RaviTransport _transport;

  Future<RoutesExplainReturn> explain(String name, String pattern, [RoutesExplainOptions options = const RoutesExplainOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["pattern"] = RaviJson.from(pattern);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["routes"],
      command: "explain",
      body: requestBody,
      decode: routesExplainReturnFromJson,
    );
  }

  Future<RoutesListReturn> list([String? name, RoutesListOptions options = const RoutesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (name != null) {
      requestBody["name"] = RaviJson.from(name);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["routes"],
      command: "list",
      body: requestBody,
      decode: routesListReturnFromJson,
    );
  }

  Future<RoutesShowReturn> show(String name, String pattern) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    requestBody["pattern"] = RaviJson.from(pattern);
    return _transport.callJson(
      groupSegments: const ["routes"],
      command: "show",
      body: requestBody,
      decode: routesShowReturnFromJson,
    );
  }
}

class RulesNamespace {
  const RulesNamespace(this._transport);

  final RaviTransport _transport;

  Future<RulesImportReturn> import_([String? source, RulesImportOptions options = const RulesImportOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (source != null) {
      requestBody["source"] = RaviJson.from(source);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["rules"],
      command: "import",
      body: requestBody,
      decode: rulesImportReturnFromJson,
    );
  }

  Future<RulesSourcesReturn> sources([String? source, RulesSourcesOptions options = const RulesSourcesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (source != null) {
      requestBody["source"] = RaviJson.from(source);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["rules"],
      command: "sources",
      body: requestBody,
      decode: rulesSourcesReturnFromJson,
    );
  }
}

class RuntimeNamespace {
  const RuntimeNamespace(this._transport);

  final RaviTransport _transport;

  RuntimeCredentialsNamespace get credentials => RuntimeCredentialsNamespace(_transport);

  RuntimePresetsNamespace get presets => RuntimePresetsNamespace(_transport);
}

class RuntimeCredentialsNamespace {
  const RuntimeCredentialsNamespace(this._transport);

  final RaviTransport _transport;

  Future<RuntimeCredentialsAddReturn> add([RuntimeCredentialsAddOptions options = const RuntimeCredentialsAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "add",
      body: requestBody,
      decode: runtimeCredentialsAddReturnFromJson,
    );
  }

  Future<RuntimeCredentialsClassifyReturn> classify([RuntimeCredentialsClassifyOptions options = const RuntimeCredentialsClassifyOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "classify",
      body: requestBody,
      decode: runtimeCredentialsClassifyReturnFromJson,
    );
  }

  Future<RuntimeCredentialsDisableReturn> disable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "disable",
      body: requestBody,
      decode: runtimeCredentialsDisableReturnFromJson,
    );
  }

  Future<RuntimeCredentialsEnableReturn> enable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "enable",
      body: requestBody,
      decode: runtimeCredentialsEnableReturnFromJson,
    );
  }

  Future<RuntimeCredentialsImportReturn> import_([RuntimeCredentialsImportOptions options = const RuntimeCredentialsImportOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "import",
      body: requestBody,
      decode: runtimeCredentialsImportReturnFromJson,
    );
  }

  Future<RuntimeCredentialsListReturn> list([RuntimeCredentialsListOptions options = const RuntimeCredentialsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "list",
      body: requestBody,
      decode: runtimeCredentialsListReturnFromJson,
    );
  }

  Future<RuntimeCredentialsRefreshReturn> refresh([String? id, RuntimeCredentialsRefreshOptions options = const RuntimeCredentialsRefreshOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (id != null) {
      requestBody["id"] = RaviJson.from(id);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "refresh",
      body: requestBody,
      decode: runtimeCredentialsRefreshReturnFromJson,
    );
  }

  Future<RuntimeCredentialsResetHealthReturn> resetHealth(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "reset-health",
      body: requestBody,
      decode: runtimeCredentialsResetHealthReturnFromJson,
    );
  }

  Future<RuntimeCredentialsSelectReturn> select([RuntimeCredentialsSelectOptions options = const RuntimeCredentialsSelectOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "select",
      body: requestBody,
      decode: runtimeCredentialsSelectReturnFromJson,
    );
  }

  Future<RuntimeCredentialsStatusReturn> status([String? id]) async {
    final requestBody = <String, RaviJson>{};
    if (id != null) {
      requestBody["id"] = RaviJson.from(id);
    }
    return _transport.callJson(
      groupSegments: const ["runtime", "credentials"],
      command: "status",
      body: requestBody,
      decode: runtimeCredentialsStatusReturnFromJson,
    );
  }
}

class RuntimePresetsNamespace {
  const RuntimePresetsNamespace(this._transport);

  final RaviTransport _transport;

  Future<RuntimePresetsCreateReturn> create(String id, [RuntimePresetsCreateOptions options = const RuntimePresetsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "presets"],
      command: "create",
      body: requestBody,
      decode: runtimePresetsCreateReturnFromJson,
    );
  }

  Future<RuntimePresetsDeleteReturn> delete(String id, [RuntimePresetsDeleteOptions options = const RuntimePresetsDeleteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "presets"],
      command: "delete",
      body: requestBody,
      decode: runtimePresetsDeleteReturnFromJson,
    );
  }

  Future<RuntimePresetsDisableReturn> disable(String id, [RuntimePresetsDisableOptions options = const RuntimePresetsDisableOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "presets"],
      command: "disable",
      body: requestBody,
      decode: runtimePresetsDisableReturnFromJson,
    );
  }

  Future<RuntimePresetsEnableReturn> enable(String id, [RuntimePresetsEnableOptions options = const RuntimePresetsEnableOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "presets"],
      command: "enable",
      body: requestBody,
      decode: runtimePresetsEnableReturnFromJson,
    );
  }

  Future<RuntimePresetsImpactReturn> impact(String id, [RuntimePresetsImpactOptions options = const RuntimePresetsImpactOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "presets"],
      command: "impact",
      body: requestBody,
      decode: runtimePresetsImpactReturnFromJson,
    );
  }

  Future<RuntimePresetsListReturn> list([RuntimePresetsListOptions options = const RuntimePresetsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "presets"],
      command: "list",
      body: requestBody,
      decode: runtimePresetsListReturnFromJson,
    );
  }

  Future<RuntimePresetsSetReturn> set_(String id, String field, String value, [RuntimePresetsSetOptions options = const RuntimePresetsSetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["field"] = RaviJson.from(field);
    requestBody["value"] = RaviJson.from(value);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["runtime", "presets"],
      command: "set",
      body: requestBody,
      decode: runtimePresetsSetReturnFromJson,
    );
  }

  Future<RuntimePresetsShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["runtime", "presets"],
      command: "show",
      body: requestBody,
      decode: runtimePresetsShowReturnFromJson,
    );
  }
}

class SdkNamespace {
  const SdkNamespace(this._transport);

  final RaviTransport _transport;

  SdkClientNamespace get client => SdkClientNamespace(_transport);

  SdkDartNamespace get dart => SdkDartNamespace(_transport);

  SdkOpenapiNamespace get openapi => SdkOpenapiNamespace(_transport);

  SdkSwiftNamespace get swift => SdkSwiftNamespace(_transport);
}

class SdkClientNamespace {
  const SdkClientNamespace(this._transport);

  final RaviTransport _transport;

  Future<SdkClientCheckReturn> check([SdkClientCheckOptions options = const SdkClientCheckOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sdk", "client"],
      command: "check",
      body: requestBody,
      decode: sdkClientCheckReturnFromJson,
    );
  }

  Future<SdkClientGenerateReturn> generate([SdkClientGenerateOptions options = const SdkClientGenerateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sdk", "client"],
      command: "generate",
      body: requestBody,
      decode: sdkClientGenerateReturnFromJson,
    );
  }
}

class SdkDartNamespace {
  const SdkDartNamespace(this._transport);

  final RaviTransport _transport;

  Future<SdkDartCheckReturn> check([SdkDartCheckOptions options = const SdkDartCheckOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sdk", "dart"],
      command: "check",
      body: requestBody,
      decode: sdkDartCheckReturnFromJson,
    );
  }

  Future<SdkDartGenerateReturn> generate([SdkDartGenerateOptions options = const SdkDartGenerateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sdk", "dart"],
      command: "generate",
      body: requestBody,
      decode: sdkDartGenerateReturnFromJson,
    );
  }
}

class SdkOpenapiNamespace {
  const SdkOpenapiNamespace(this._transport);

  final RaviTransport _transport;

  Future<SdkOpenapiCheckReturn> check([SdkOpenapiCheckOptions options = const SdkOpenapiCheckOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sdk", "openapi"],
      command: "check",
      body: requestBody,
      decode: sdkOpenapiCheckReturnFromJson,
    );
  }

  Future<SdkOpenapiEmitReturn> emit([SdkOpenapiEmitOptions options = const SdkOpenapiEmitOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sdk", "openapi"],
      command: "emit",
      body: requestBody,
      decode: sdkOpenapiEmitReturnFromJson,
    );
  }
}

class SdkSwiftNamespace {
  const SdkSwiftNamespace(this._transport);

  final RaviTransport _transport;

  Future<SdkSwiftCheckReturn> check([SdkSwiftCheckOptions options = const SdkSwiftCheckOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sdk", "swift"],
      command: "check",
      body: requestBody,
      decode: sdkSwiftCheckReturnFromJson,
    );
  }

  Future<SdkSwiftGenerateReturn> generate([SdkSwiftGenerateOptions options = const SdkSwiftGenerateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sdk", "swift"],
      command: "generate",
      body: requestBody,
      decode: sdkSwiftGenerateReturnFromJson,
    );
  }
}

class SelfNamespace {
  const SelfNamespace(this._transport);

  final RaviTransport _transport;

  Future<SelfChatReturn> chat([SelfChatOptions options = const SelfChatOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["self"],
      command: "chat",
      body: requestBody,
      decode: selfChatReturnFromJson,
    );
  }

  Future<SelfContextReturn> context([SelfContextOptions options = const SelfContextOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["self"],
      command: "context",
      body: requestBody,
      decode: selfContextReturnFromJson,
    );
  }

  Future<SelfExplainReturn> explain() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["self"],
      command: "explain",
      body: requestBody,
      decode: selfExplainReturnFromJson,
    );
  }

  Future<SelfKnowledgeReturn> knowledge() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["self"],
      command: "knowledge",
      body: requestBody,
      decode: selfKnowledgeReturnFromJson,
    );
  }

  Future<SelfPermissionsReturn> permissions() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["self"],
      command: "permissions",
      body: requestBody,
      decode: selfPermissionsReturnFromJson,
    );
  }

  Future<SelfRecentReturn> recent([SelfRecentOptions options = const SelfRecentOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["self"],
      command: "recent",
      body: requestBody,
      decode: selfRecentReturnFromJson,
    );
  }

  Future<SelfRouteReturn> route() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["self"],
      command: "route",
      body: requestBody,
      decode: selfRouteReturnFromJson,
    );
  }

  Future<SelfWhoamiReturn> whoami() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["self"],
      command: "whoami",
      body: requestBody,
      decode: selfWhoamiReturnFromJson,
    );
  }
}

class SessionsNamespace {
  const SessionsNamespace(this._transport);

  final RaviTransport _transport;

  SessionsFollowupsNamespace get followups => SessionsFollowupsNamespace(_transport);

  SessionsRuntimeNamespace get runtime => SessionsRuntimeNamespace(_transport);

  Future<SessionsActionsReturn> actions([String? nameOrKey, SessionsActionsOptions options = const SessionsActionsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (nameOrKey != null) {
      requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "actions",
      body: requestBody,
      decode: sessionsActionsReturnFromJson,
    );
  }

  Future<SessionsAnswerReturn> answer(String target, String message, [String? sender, SessionsAnswerOptions options = const SessionsAnswerOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["target"] = RaviJson.from(target);
    requestBody["message"] = RaviJson.from(message);
    if (sender != null) {
      requestBody["sender"] = RaviJson.from(sender);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "answer",
      body: requestBody,
      decode: sessionsAnswerReturnFromJson,
    );
  }

  Future<SessionsAskReturn> ask(String target, String message, [String? sender, SessionsAskOptions options = const SessionsAskOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["target"] = RaviJson.from(target);
    requestBody["message"] = RaviJson.from(message);
    if (sender != null) {
      requestBody["sender"] = RaviJson.from(sender);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "ask",
      body: requestBody,
      decode: sessionsAskReturnFromJson,
    );
  }

  Future<SessionsAttachReturn> attach(String nameOrKey, [SessionsAttachOptions options = const SessionsAttachOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "attach",
      body: requestBody,
      decode: sessionsAttachReturnFromJson,
    );
  }

  Future<SessionsCloseThreadReturn> closeThread([SessionsCloseThreadOptions options = const SessionsCloseThreadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "close-thread",
      body: requestBody,
      decode: sessionsCloseThreadReturnFromJson,
    );
  }

  Future<SessionsCreateThreadReturn> createThread(String message, [SessionsCreateThreadOptions options = const SessionsCreateThreadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "create-thread",
      body: requestBody,
      decode: sessionsCreateThreadReturnFromJson,
    );
  }

  Future<SessionsDeleteReturn> delete(String nameOrKey, [SessionsDeleteOptions options = const SessionsDeleteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "delete",
      body: requestBody,
      decode: sessionsDeleteReturnFromJson,
    );
  }

  Future<SessionsDeleteMessageReturn> deleteMessage(String sessionOrMessage, [String? messageRef, SessionsDeleteMessageOptions options = const SessionsDeleteMessageOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["sessionOrMessage"] = RaviJson.from(sessionOrMessage);
    if (messageRef != null) {
      requestBody["messageRef"] = RaviJson.from(messageRef);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "delete-message",
      body: requestBody,
      decode: sessionsDeleteMessageReturnFromJson,
    );
  }

  Future<SessionsDetachReturn> detach(String nameOrKey, [SessionsDetachOptions options = const SessionsDetachOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "detach",
      body: requestBody,
      decode: sessionsDetachReturnFromJson,
    );
  }

  Future<SessionsEditMessageReturn> editMessage(String sessionOrMessage, [String? messageOrText, String? textArg, SessionsEditMessageOptions options = const SessionsEditMessageOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["sessionOrMessage"] = RaviJson.from(sessionOrMessage);
    if (messageOrText != null) {
      requestBody["messageOrText"] = RaviJson.from(messageOrText);
    }
    if (textArg != null) {
      requestBody["textArg"] = RaviJson.from(textArg);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "edit-message",
      body: requestBody,
      decode: sessionsEditMessageReturnFromJson,
    );
  }

  Future<SessionsExecuteReturn> execute(String target, String message, [SessionsExecuteOptions options = const SessionsExecuteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["target"] = RaviJson.from(target);
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "execute",
      body: requestBody,
      decode: sessionsExecuteReturnFromJson,
    );
  }

  Future<SessionsExtendReturn> extend(String nameOrKey, [String? duration]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    if (duration != null) {
      requestBody["duration"] = RaviJson.from(duration);
    }
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "extend",
      body: requestBody,
      decode: sessionsExtendReturnFromJson,
    );
  }

  Future<SessionsGoalReturn> goal(String action, String nameOrKey, [String? objective, SessionsGoalOptions options = const SessionsGoalOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["action"] = RaviJson.from(action);
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    if (objective != null) {
      requestBody["objective"] = RaviJson.from(objective);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "goal",
      body: requestBody,
      decode: sessionsGoalReturnFromJson,
    );
  }

  Future<SessionsInfoReturn> info(String nameOrKey) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "info",
      body: requestBody,
      decode: sessionsInfoReturnFromJson,
    );
  }

  Future<SessionsInformReturn> inform(String target, String message, [SessionsInformOptions options = const SessionsInformOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["target"] = RaviJson.from(target);
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "inform",
      body: requestBody,
      decode: sessionsInformReturnFromJson,
    );
  }

  Future<SessionsKeepReturn> keep(String nameOrKey) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "keep",
      body: requestBody,
      decode: sessionsKeepReturnFromJson,
    );
  }

  Future<SessionsListReturn> list([SessionsListOptions options = const SessionsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "list",
      body: requestBody,
      decode: sessionsListReturnFromJson,
    );
  }

  Future<SessionsPruneReturn> prune([SessionsPruneOptions options = const SessionsPruneOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "prune",
      body: requestBody,
      decode: sessionsPruneReturnFromJson,
    );
  }

  Future<SessionsReadReturn> read([String? nameOrKey, SessionsReadOptions options = const SessionsReadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (nameOrKey != null) {
      requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "read",
      body: requestBody,
      decode: sessionsReadReturnFromJson,
    );
  }

  Future<SessionsRecapReturn> recap([String? nameOrKey, SessionsRecapOptions options = const SessionsRecapOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (nameOrKey != null) {
      requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "recap",
      body: requestBody,
      decode: sessionsRecapReturnFromJson,
    );
  }

  Future<SessionsRenameReturn> rename(String nameOrKey, String newName) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    requestBody["newName"] = RaviJson.from(newName);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "rename",
      body: requestBody,
      decode: sessionsRenameReturnFromJson,
    );
  }

  Future<SessionsResetReturn> reset(String nameOrKey, [SessionsResetOptions options = const SessionsResetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "reset",
      body: requestBody,
      decode: sessionsResetReturnFromJson,
    );
  }

  Future<SessionsSendReturn> send(String nameOrKey, [String? prompt, SessionsSendOptions options = const SessionsSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    if (prompt != null) {
      requestBody["prompt"] = RaviJson.from(prompt);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "send",
      body: requestBody,
      decode: sessionsSendReturnFromJson,
    );
  }

  Future<SessionsSetDisplayReturn> setDisplay(String nameOrKey, String displayName) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    requestBody["displayName"] = RaviJson.from(displayName);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "set-display",
      body: requestBody,
      decode: sessionsSetDisplayReturnFromJson,
    );
  }

  Future<SessionsSetEffortReturn> setEffort(String nameOrKey, String level) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    requestBody["level"] = RaviJson.from(level);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "set-effort",
      body: requestBody,
      decode: sessionsSetEffortReturnFromJson,
    );
  }

  Future<SessionsSetModelReturn> setModel(String nameOrKey, String model) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    requestBody["model"] = RaviJson.from(model);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "set-model",
      body: requestBody,
      decode: sessionsSetModelReturnFromJson,
    );
  }

  Future<SessionsSetProviderReturn> setProvider(String nameOrKey, String provider) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    requestBody["provider"] = RaviJson.from(provider);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "set-provider",
      body: requestBody,
      decode: sessionsSetProviderReturnFromJson,
    );
  }

  Future<SessionsSetThinkingReturn> setThinking(String nameOrKey, String level) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    requestBody["level"] = RaviJson.from(level);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "set-thinking",
      body: requestBody,
      decode: sessionsSetThinkingReturnFromJson,
    );
  }

  Future<SessionsSetTtlReturn> setTtl(String nameOrKey, String duration) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    requestBody["duration"] = RaviJson.from(duration);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "set-ttl",
      body: requestBody,
      decode: sessionsSetTtlReturnFromJson,
    );
  }

  Future<SessionsSubscriptionsReturn> subscriptions(String nameOrKey) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "subscriptions",
      body: requestBody,
      decode: sessionsSubscriptionsReturnFromJson,
    );
  }

  Future<SessionsTraceReturn> trace(String nameOrKey, [SessionsTraceOptions options = const SessionsTraceOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "trace",
      body: requestBody,
      decode: sessionsTraceReturnFromJson,
    );
  }

  Future<SessionsVisibilityReturn> visibility(String nameOrKey) async {
    final requestBody = <String, RaviJson>{};
    requestBody["nameOrKey"] = RaviJson.from(nameOrKey);
    return _transport.callJson(
      groupSegments: const ["sessions"],
      command: "visibility",
      body: requestBody,
      decode: sessionsVisibilityReturnFromJson,
    );
  }
}

class SessionsFollowupsNamespace {
  const SessionsFollowupsNamespace(this._transport);

  final RaviTransport _transport;

  Future<SessionsFollowupsAddReturn> add(String name, [SessionsFollowupsAddOptions options = const SessionsFollowupsAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "add",
      body: requestBody,
      decode: sessionsFollowupsAddReturnFromJson,
    );
  }

  Future<SessionsFollowupsInspectReturn> inspect(String id, [SessionsFollowupsInspectOptions options = const SessionsFollowupsInspectOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "inspect",
      body: requestBody,
      decode: sessionsFollowupsInspectReturnFromJson,
    );
  }

  Future<SessionsFollowupsListReturn> list([SessionsFollowupsListOptions options = const SessionsFollowupsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "list",
      body: requestBody,
      decode: sessionsFollowupsListReturnFromJson,
    );
  }

  Future<SessionsFollowupsPauseReturn> pause(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "pause",
      body: requestBody,
      decode: sessionsFollowupsPauseReturnFromJson,
    );
  }

  Future<SessionsFollowupsResumeReturn> resume(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "resume",
      body: requestBody,
      decode: sessionsFollowupsResumeReturnFromJson,
    );
  }

  Future<SessionsFollowupsRetryReturn> retry([String? run, SessionsFollowupsRetryOptions options = const SessionsFollowupsRetryOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (run != null) {
      requestBody["run"] = RaviJson.from(run);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "retry",
      body: requestBody,
      decode: sessionsFollowupsRetryReturnFromJson,
    );
  }

  Future<SessionsFollowupsRunReturn> run(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "run",
      body: requestBody,
      decode: sessionsFollowupsRunReturnFromJson,
    );
  }

  Future<SessionsFollowupsRunsReturn> runs([SessionsFollowupsRunsOptions options = const SessionsFollowupsRunsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "runs",
      body: requestBody,
      decode: sessionsFollowupsRunsReturnFromJson,
    );
  }

  Future<SessionsFollowupsSnoozeReturn> snooze(String id, [SessionsFollowupsSnoozeOptions options = const SessionsFollowupsSnoozeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "snooze",
      body: requestBody,
      decode: sessionsFollowupsSnoozeReturnFromJson,
    );
  }

  Future<SessionsFollowupsUpdateReturn> update(String id, [SessionsFollowupsUpdateOptions options = const SessionsFollowupsUpdateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "followups"],
      command: "update",
      body: requestBody,
      decode: sessionsFollowupsUpdateReturnFromJson,
    );
  }
}

class SessionsRuntimeNamespace {
  const SessionsRuntimeNamespace(this._transport);

  final RaviTransport _transport;

  Future<SessionsRuntimeFollowUpReturn> followUp(String session, String text, [SessionsRuntimeFollowUpOptions options = const SessionsRuntimeFollowUpOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    requestBody["text"] = RaviJson.from(text);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "runtime"],
      command: "follow-up",
      body: requestBody,
      decode: sessionsRuntimeFollowUpReturnFromJson,
    );
  }

  Future<SessionsRuntimeForkReturn> fork(String session, [String? threadId, SessionsRuntimeForkOptions options = const SessionsRuntimeForkOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    if (threadId != null) {
      requestBody["threadId"] = RaviJson.from(threadId);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "runtime"],
      command: "fork",
      body: requestBody,
      decode: sessionsRuntimeForkReturnFromJson,
    );
  }

  Future<SessionsRuntimeInterruptReturn> interrupt(String session, [SessionsRuntimeInterruptOptions options = const SessionsRuntimeInterruptOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "runtime"],
      command: "interrupt",
      body: requestBody,
      decode: sessionsRuntimeInterruptReturnFromJson,
    );
  }

  Future<SessionsRuntimeListReturn> list(String session, [SessionsRuntimeListOptions options = const SessionsRuntimeListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "runtime"],
      command: "list",
      body: requestBody,
      decode: sessionsRuntimeListReturnFromJson,
    );
  }

  Future<SessionsRuntimeReadReturn> read(String session, [String? threadId, SessionsRuntimeReadOptions options = const SessionsRuntimeReadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    if (threadId != null) {
      requestBody["threadId"] = RaviJson.from(threadId);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "runtime"],
      command: "read",
      body: requestBody,
      decode: sessionsRuntimeReadReturnFromJson,
    );
  }

  Future<SessionsRuntimeRollbackReturn> rollback(String session, [String? turns, SessionsRuntimeRollbackOptions options = const SessionsRuntimeRollbackOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    if (turns != null) {
      requestBody["turns"] = RaviJson.from(turns);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "runtime"],
      command: "rollback",
      body: requestBody,
      decode: sessionsRuntimeRollbackReturnFromJson,
    );
  }

  Future<SessionsRuntimeSteerReturn> steer(String session, String text, [SessionsRuntimeSteerOptions options = const SessionsRuntimeSteerOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["session"] = RaviJson.from(session);
    requestBody["text"] = RaviJson.from(text);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sessions", "runtime"],
      command: "steer",
      body: requestBody,
      decode: sessionsRuntimeSteerReturnFromJson,
    );
  }
}

class SettingsNamespace {
  const SettingsNamespace(this._transport);

  final RaviTransport _transport;

  Future<SettingsDeleteReturn> delete(String key, [SettingsDeleteOptions options = const SettingsDeleteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["key"] = RaviJson.from(key);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["settings"],
      command: "delete",
      body: requestBody,
      decode: settingsDeleteReturnFromJson,
    );
  }

  Future<SettingsGetReturn> get_(String key) async {
    final requestBody = <String, RaviJson>{};
    requestBody["key"] = RaviJson.from(key);
    return _transport.callJson(
      groupSegments: const ["settings"],
      command: "get",
      body: requestBody,
      decode: settingsGetReturnFromJson,
    );
  }

  Future<SettingsListReturn> list([SettingsListOptions options = const SettingsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["settings"],
      command: "list",
      body: requestBody,
      decode: settingsListReturnFromJson,
    );
  }

  Future<SettingsSetReturn> set_(String key, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["settings"],
      command: "set",
      body: requestBody,
      decode: settingsSetReturnFromJson,
    );
  }
}

class SkillGatesNamespace {
  const SkillGatesNamespace(this._transport);

  final RaviTransport _transport;

  Future<SkillGatesDisableReturn> disable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["skill-gates"],
      command: "disable",
      body: requestBody,
      decode: skillGatesDisableReturnFromJson,
    );
  }

  Future<SkillGatesEnableReturn> enable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["skill-gates"],
      command: "enable",
      body: requestBody,
      decode: skillGatesEnableReturnFromJson,
    );
  }

  Future<SkillGatesListReturn> list([SkillGatesListOptions options = const SkillGatesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skill-gates"],
      command: "list",
      body: requestBody,
      decode: skillGatesListReturnFromJson,
    );
  }

  Future<SkillGatesResetReturn> reset(String id, [SkillGatesResetOptions options = const SkillGatesResetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skill-gates"],
      command: "reset",
      body: requestBody,
      decode: skillGatesResetReturnFromJson,
    );
  }

  Future<SkillGatesRmReturn> rm(String id, [SkillGatesRmOptions options = const SkillGatesRmOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skill-gates"],
      command: "rm",
      body: requestBody,
      decode: skillGatesRmReturnFromJson,
    );
  }

  Future<SkillGatesSetReturn> set_(String id, String skill, [SkillGatesSetOptions options = const SkillGatesSetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["skill"] = RaviJson.from(skill);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skill-gates"],
      command: "set",
      body: requestBody,
      decode: skillGatesSetReturnFromJson,
    );
  }

  Future<SkillGatesShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["skill-gates"],
      command: "show",
      body: requestBody,
      decode: skillGatesShowReturnFromJson,
    );
  }
}

class SkillsNamespace {
  const SkillsNamespace(this._transport);

  final RaviTransport _transport;

  Future<SkillsGrantReturn> grant(String agent, String skill, [SkillsGrantOptions options = const SkillsGrantOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["agent"] = RaviJson.from(agent);
    requestBody["skill"] = RaviJson.from(skill);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "grant",
      body: requestBody,
      decode: skillsGrantReturnFromJson,
    );
  }

  Future<SkillsGrantBatchReturn> grantBatch([SkillsGrantBatchOptions options = const SkillsGrantBatchOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "grant-batch",
      body: requestBody,
      decode: skillsGrantBatchReturnFromJson,
    );
  }

  Future<SkillsInspectReturn> inspect(String agent) async {
    final requestBody = <String, RaviJson>{};
    requestBody["agent"] = RaviJson.from(agent);
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "inspect",
      body: requestBody,
      decode: skillsInspectReturnFromJson,
    );
  }

  Future<SkillsInstallReturn> install([String? name, SkillsInstallOptions options = const SkillsInstallOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (name != null) {
      requestBody["name"] = RaviJson.from(name);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "install",
      body: requestBody,
      decode: skillsInstallReturnFromJson,
    );
  }

  Future<SkillsListReturn> list([SkillsListOptions options = const SkillsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "list",
      body: requestBody,
      decode: skillsListReturnFromJson,
    );
  }

  Future<SkillsRevokeReturn> revoke(String agent, String skill) async {
    final requestBody = <String, RaviJson>{};
    requestBody["agent"] = RaviJson.from(agent);
    requestBody["skill"] = RaviJson.from(skill);
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "revoke",
      body: requestBody,
      decode: skillsRevokeReturnFromJson,
    );
  }

  Future<SkillsRevokeBatchReturn> revokeBatch([SkillsRevokeBatchOptions options = const SkillsRevokeBatchOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "revoke-batch",
      body: requestBody,
      decode: skillsRevokeBatchReturnFromJson,
    );
  }

  Future<SkillsShowReturn> show(String name, [SkillsShowOptions options = const SkillsShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "show",
      body: requestBody,
      decode: skillsShowReturnFromJson,
    );
  }

  Future<SkillsSyncReturn> sync() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "sync",
      body: requestBody,
      decode: skillsSyncReturnFromJson,
    );
  }

  Future<SkillsWhoReturn> who([String? skill, SkillsWhoOptions options = const SkillsWhoOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (skill != null) {
      requestBody["skill"] = RaviJson.from(skill);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["skills"],
      command: "who",
      body: requestBody,
      decode: skillsWhoReturnFromJson,
    );
  }
}

class SlackNamespace {
  const SlackNamespace(this._transport);

  final RaviTransport _transport;

  Future<SlackBlocksSendReturn> blocksSend(String channel, String file, [SlackBlocksSendOptions options = const SlackBlocksSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "blocks-send",
      body: requestBody,
      decode: slackBlocksSendReturnFromJson,
    );
  }

  Future<SlackBlocksShowcaseReturn> blocksShowcase(String channel, [SlackBlocksShowcaseOptions options = const SlackBlocksShowcaseOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "blocks-showcase",
      body: requestBody,
      decode: slackBlocksShowcaseReturnFromJson,
    );
  }

  Future<SlackBlocksUpdateReturn> blocksUpdate(String channel, String ts, String file, [SlackBlocksUpdateOptions options = const SlackBlocksUpdateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    requestBody["ts"] = RaviJson.from(ts);
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "blocks-update",
      body: requestBody,
      decode: slackBlocksUpdateReturnFromJson,
    );
  }

  Future<SlackBlocksValidateReturn> blocksValidate(String file, [SlackBlocksValidateOptions options = const SlackBlocksValidateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "blocks-validate",
      body: requestBody,
      decode: slackBlocksValidateReturnFromJson,
    );
  }

  Future<SlackCanvasAccessDeleteReturn> canvasAccessDelete(String canvas, [SlackCanvasAccessDeleteOptions options = const SlackCanvasAccessDeleteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["canvas"] = RaviJson.from(canvas);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-access-delete",
      body: requestBody,
      decode: slackCanvasAccessDeleteReturnFromJson,
    );
  }

  Future<SlackCanvasAccessSetReturn> canvasAccessSet(String canvas, String access, [SlackCanvasAccessSetOptions options = const SlackCanvasAccessSetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["canvas"] = RaviJson.from(canvas);
    requestBody["access"] = RaviJson.from(access);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-access-set",
      body: requestBody,
      decode: slackCanvasAccessSetReturnFromJson,
    );
  }

  Future<SlackCanvasArtifactPublishReturn> canvasArtifactPublish(String artifactOrFile, [SlackCanvasArtifactPublishOptions options = const SlackCanvasArtifactPublishOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["artifactOrFile"] = RaviJson.from(artifactOrFile);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-artifact-publish",
      body: requestBody,
      decode: slackCanvasArtifactPublishReturnFromJson,
    );
  }

  Future<SlackCanvasArtifactStatusReturn> canvasArtifactStatus(String artifact) async {
    final requestBody = <String, RaviJson>{};
    requestBody["artifact"] = RaviJson.from(artifact);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-artifact-status",
      body: requestBody,
      decode: slackCanvasArtifactStatusReturnFromJson,
    );
  }

  Future<SlackCanvasChannelCreateReturn> canvasChannelCreate(String channel, [SlackCanvasChannelCreateOptions options = const SlackCanvasChannelCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-channel-create",
      body: requestBody,
      decode: slackCanvasChannelCreateReturnFromJson,
    );
  }

  Future<SlackCanvasChannelShowcaseReturn> canvasChannelShowcase(String channel, [SlackCanvasChannelShowcaseOptions options = const SlackCanvasChannelShowcaseOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-channel-showcase",
      body: requestBody,
      decode: slackCanvasChannelShowcaseReturnFromJson,
    );
  }

  Future<SlackCanvasCreateReturn> canvasCreate([SlackCanvasCreateOptions options = const SlackCanvasCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-create",
      body: requestBody,
      decode: slackCanvasCreateReturnFromJson,
    );
  }

  Future<SlackCanvasDeleteReturn> canvasDelete(String canvas, [SlackCanvasDeleteOptions options = const SlackCanvasDeleteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["canvas"] = RaviJson.from(canvas);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-delete",
      body: requestBody,
      decode: slackCanvasDeleteReturnFromJson,
    );
  }

  Future<SlackCanvasEditReturn> canvasEdit(String canvas, String operation, [SlackCanvasEditOptions options = const SlackCanvasEditOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["canvas"] = RaviJson.from(canvas);
    requestBody["operation"] = RaviJson.from(operation);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-edit",
      body: requestBody,
      decode: slackCanvasEditReturnFromJson,
    );
  }

  Future<SlackCanvasSectionsLookupReturn> canvasSectionsLookup(String canvas, [SlackCanvasSectionsLookupOptions options = const SlackCanvasSectionsLookupOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["canvas"] = RaviJson.from(canvas);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-sections-lookup",
      body: requestBody,
      decode: slackCanvasSectionsLookupReturnFromJson,
    );
  }

  Future<SlackCanvasShowcaseReturn> canvasShowcase(String canvas, [SlackCanvasShowcaseOptions options = const SlackCanvasShowcaseOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["canvas"] = RaviJson.from(canvas);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "canvas-showcase",
      body: requestBody,
      decode: slackCanvasShowcaseReturnFromJson,
    );
  }

  Future<SlackChannelsCreateReturn> channelsCreate(String name, [SlackChannelsCreateOptions options = const SlackChannelsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "channels-create",
      body: requestBody,
      decode: slackChannelsCreateReturnFromJson,
    );
  }

  Future<SlackChannelsHistoryReturn> channelsHistory(String channel, [SlackChannelsHistoryOptions options = const SlackChannelsHistoryOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "channels-history",
      body: requestBody,
      decode: slackChannelsHistoryReturnFromJson,
    );
  }

  Future<SlackChannelsInfoReturn> channelsInfo(String channel) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "channels-info",
      body: requestBody,
      decode: slackChannelsInfoReturnFromJson,
    );
  }

  Future<SlackChannelsInviteReturn> channelsInvite(String channel, String users, [SlackChannelsInviteOptions options = const SlackChannelsInviteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    requestBody["users"] = RaviJson.from(users);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "channels-invite",
      body: requestBody,
      decode: slackChannelsInviteReturnFromJson,
    );
  }

  Future<SlackChannelsListReturn> channelsList([SlackChannelsListOptions options = const SlackChannelsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "channels-list",
      body: requestBody,
      decode: slackChannelsListReturnFromJson,
    );
  }

  Future<SlackChannelsRenameReturn> channelsRename(String channel, String name, [SlackChannelsRenameOptions options = const SlackChannelsRenameOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "channels-rename",
      body: requestBody,
      decode: slackChannelsRenameReturnFromJson,
    );
  }

  Future<SlackFilesListReturn> filesList([SlackFilesListOptions options = const SlackFilesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "files-list",
      body: requestBody,
      decode: slackFilesListReturnFromJson,
    );
  }

  Future<SlackInteractionsRespondReturn> interactionsRespond(String responseUrlId, String file, [SlackInteractionsRespondOptions options = const SlackInteractionsRespondOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["responseUrlId"] = RaviJson.from(responseUrlId);
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "interactions-respond",
      body: requestBody,
      decode: slackInteractionsRespondReturnFromJson,
    );
  }

  Future<SlackMembersListReturn> membersList(String channel, [SlackMembersListOptions options = const SlackMembersListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "members-list",
      body: requestBody,
      decode: slackMembersListReturnFromJson,
    );
  }

  Future<SlackMessagesInspectReturn> messagesInspect(String channel, String ts) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    requestBody["ts"] = RaviJson.from(ts);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "messages-inspect",
      body: requestBody,
      decode: slackMessagesInspectReturnFromJson,
    );
  }

  Future<SlackMessagesReplayReturn> messagesReplay(String channel, String ts, [SlackMessagesReplayOptions options = const SlackMessagesReplayOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    requestBody["ts"] = RaviJson.from(ts);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "messages-replay",
      body: requestBody,
      decode: slackMessagesReplayReturnFromJson,
    );
  }

  Future<SlackMessagesSendReturn> messagesSend(String channel, String text, [SlackMessagesSendOptions options = const SlackMessagesSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    requestBody["text"] = RaviJson.from(text);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "messages-send",
      body: requestBody,
      decode: slackMessagesSendReturnFromJson,
    );
  }

  Future<SlackModalsOpenReturn> modalsOpen(String triggerId, String file, [SlackModalsOpenOptions options = const SlackModalsOpenOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["triggerId"] = RaviJson.from(triggerId);
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "modals-open",
      body: requestBody,
      decode: slackModalsOpenReturnFromJson,
    );
  }

  Future<SlackModalsPushReturn> modalsPush(String triggerId, String file, [SlackModalsPushOptions options = const SlackModalsPushOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["triggerId"] = RaviJson.from(triggerId);
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "modals-push",
      body: requestBody,
      decode: slackModalsPushReturnFromJson,
    );
  }

  Future<SlackModalsUpdateReturn> modalsUpdate(String view, String file, [SlackModalsUpdateOptions options = const SlackModalsUpdateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["view"] = RaviJson.from(view);
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "modals-update",
      body: requestBody,
      decode: slackModalsUpdateReturnFromJson,
    );
  }

  Future<SlackPermissionsListReturn> permissionsList([SlackPermissionsListOptions options = const SlackPermissionsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "permissions-list",
      body: requestBody,
      decode: slackPermissionsListReturnFromJson,
    );
  }

  Future<SlackTopologyReturn> topology([SlackTopologyOptions options = const SlackTopologyOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "topology",
      body: requestBody,
      decode: slackTopologyReturnFromJson,
    );
  }

  Future<SlackWorkObjectsPresentDetailsReturn> workObjectsPresentDetails(String triggerId, String file, [SlackWorkObjectsPresentDetailsOptions options = const SlackWorkObjectsPresentDetailsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["triggerId"] = RaviJson.from(triggerId);
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "work-objects-present-details",
      body: requestBody,
      decode: slackWorkObjectsPresentDetailsReturnFromJson,
    );
  }

  Future<SlackWorkObjectsSendReturn> workObjectsSend(String channel, String file, [SlackWorkObjectsSendOptions options = const SlackWorkObjectsSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "work-objects-send",
      body: requestBody,
      decode: slackWorkObjectsSendReturnFromJson,
    );
  }

  Future<SlackWorkObjectsUnfurlReturn> workObjectsUnfurl(String channel, String ts, String url, String file, [SlackWorkObjectsUnfurlOptions options = const SlackWorkObjectsUnfurlOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["channel"] = RaviJson.from(channel);
    requestBody["ts"] = RaviJson.from(ts);
    requestBody["url"] = RaviJson.from(url);
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "work-objects-unfurl",
      body: requestBody,
      decode: slackWorkObjectsUnfurlReturnFromJson,
    );
  }

  Future<SlackWorkObjectsValidateReturn> workObjectsValidate(String file, [SlackWorkObjectsValidateOptions options = const SlackWorkObjectsValidateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["file"] = RaviJson.from(file);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["slack"],
      command: "work-objects-validate",
      body: requestBody,
      decode: slackWorkObjectsValidateReturnFromJson,
    );
  }
}

class SpecsNamespace {
  const SpecsNamespace(this._transport);

  final RaviTransport _transport;

  Future<SpecsGetReturn> get_(String id, [SpecsGetOptions options = const SpecsGetOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["specs"],
      command: "get",
      body: requestBody,
      decode: specsGetReturnFromJson,
    );
  }

  Future<SpecsListReturn> list([SpecsListOptions options = const SpecsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["specs"],
      command: "list",
      body: requestBody,
      decode: specsListReturnFromJson,
    );
  }

  Future<SpecsNewReturn> new_(String id, [SpecsNewOptions options = const SpecsNewOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["specs"],
      command: "new",
      body: requestBody,
      decode: specsNewReturnFromJson,
    );
  }

  Future<SpecsSyncReturn> sync() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["specs"],
      command: "sync",
      body: requestBody,
      decode: specsSyncReturnFromJson,
    );
  }
}

class StickersNamespace {
  const StickersNamespace(this._transport);

  final RaviTransport _transport;

  Future<StickersAddReturn> add(String id, String mediaPath, [StickersAddOptions options = const StickersAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["mediaPath"] = RaviJson.from(mediaPath);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["stickers"],
      command: "add",
      body: requestBody,
      decode: stickersAddReturnFromJson,
    );
  }

  Future<StickersListReturn> list([StickersListOptions options = const StickersListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["stickers"],
      command: "list",
      body: requestBody,
      decode: stickersListReturnFromJson,
    );
  }

  Future<StickersRemoveReturn> remove(String id, [StickersRemoveOptions options = const StickersRemoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["stickers"],
      command: "remove",
      body: requestBody,
      decode: stickersRemoveReturnFromJson,
    );
  }

  Future<StickersSendReturn> send(String id, [StickersSendOptions options = const StickersSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["stickers"],
      command: "send",
      body: requestBody,
      decode: stickersSendReturnFromJson,
    );
  }

  Future<StickersShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["stickers"],
      command: "show",
      body: requestBody,
      decode: stickersShowReturnFromJson,
    );
  }
}

class SyncNamespace {
  const SyncNamespace(this._transport);

  final RaviTransport _transport;

  Future<SyncInspectReturn> inspect(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["sync"],
      command: "inspect",
      body: requestBody,
      decode: syncInspectReturnFromJson,
    );
  }

  Future<SyncPullReturn> pull([SyncPullOptions options = const SyncPullOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sync"],
      command: "pull",
      body: requestBody,
      decode: syncPullReturnFromJson,
    );
  }

  Future<SyncPushReturn> push([SyncPushOptions options = const SyncPushOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sync"],
      command: "push",
      body: requestBody,
      decode: syncPushReturnFromJson,
    );
  }

  Future<SyncRetryReturn> retry([SyncRetryOptions options = const SyncRetryOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["sync"],
      command: "retry",
      body: requestBody,
      decode: syncRetryReturnFromJson,
    );
  }

  Future<SyncStatusReturn> status() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["sync"],
      command: "status",
      body: requestBody,
      decode: syncStatusReturnFromJson,
    );
  }
}

class TagRulesNamespace {
  const TagRulesNamespace(this._transport);

  final RaviTransport _transport;

  Future<TagRulesEvaluateReturn> evaluate(String ruleId, [TagRulesEvaluateOptions options = const TagRulesEvaluateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["ruleId"] = RaviJson.from(ruleId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tag-rules"],
      command: "evaluate",
      body: requestBody,
      decode: tagRulesEvaluateReturnFromJson,
    );
  }

  Future<TagRulesExplainReturn> explain([TagRulesExplainOptions options = const TagRulesExplainOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tag-rules"],
      command: "explain",
      body: requestBody,
      decode: tagRulesExplainReturnFromJson,
    );
  }

  Future<TagRulesListReturn> list([TagRulesListOptions options = const TagRulesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tag-rules"],
      command: "list",
      body: requestBody,
      decode: tagRulesListReturnFromJson,
    );
  }

  Future<TagRulesShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["tag-rules"],
      command: "show",
      body: requestBody,
      decode: tagRulesShowReturnFromJson,
    );
  }

  Future<TagRulesTickReturn> tick([TagRulesTickOptions options = const TagRulesTickOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tag-rules"],
      command: "tick",
      body: requestBody,
      decode: tagRulesTickReturnFromJson,
    );
  }

  Future<TagRulesValidateReturn> validate() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["tag-rules"],
      command: "validate",
      body: requestBody,
      decode: tagRulesValidateReturnFromJson,
    );
  }
}

class TagsNamespace {
  const TagsNamespace(this._transport);

  final RaviTransport _transport;

  Future<TagsAttachReturn> attach(String slug, [TagsAttachOptions options = const TagsAttachOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["slug"] = RaviJson.from(slug);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tags"],
      command: "attach",
      body: requestBody,
      decode: tagsAttachReturnFromJson,
    );
  }

  Future<TagsCreateReturn> create(String slug, [TagsCreateOptions options = const TagsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["slug"] = RaviJson.from(slug);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tags"],
      command: "create",
      body: requestBody,
      decode: tagsCreateReturnFromJson,
    );
  }

  Future<TagsDetachReturn> detach(String slug, [TagsDetachOptions options = const TagsDetachOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["slug"] = RaviJson.from(slug);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tags"],
      command: "detach",
      body: requestBody,
      decode: tagsDetachReturnFromJson,
    );
  }

  Future<TagsListReturn> list([TagsListOptions options = const TagsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tags"],
      command: "list",
      body: requestBody,
      decode: tagsListReturnFromJson,
    );
  }

  Future<TagsSearchReturn> search([TagsSearchOptions options = const TagsSearchOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tags"],
      command: "search",
      body: requestBody,
      decode: tagsSearchReturnFromJson,
    );
  }

  Future<TagsSetReturn> set_(String slug, String key, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["slug"] = RaviJson.from(slug);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["tags"],
      command: "set",
      body: requestBody,
      decode: tagsSetReturnFromJson,
    );
  }

  Future<TagsShowReturn> show(String slug) async {
    final requestBody = <String, RaviJson>{};
    requestBody["slug"] = RaviJson.from(slug);
    return _transport.callJson(
      groupSegments: const ["tags"],
      command: "show",
      body: requestBody,
      decode: tagsShowReturnFromJson,
    );
  }
}

class TasksNamespace {
  const TasksNamespace(this._transport);

  final RaviTransport _transport;

  TasksAutomationsNamespace get automations => TasksAutomationsNamespace(_transport);

  TasksDepsNamespace get deps => TasksDepsNamespace(_transport);

  TasksProfilesNamespace get profiles => TasksProfilesNamespace(_transport);

  Future<TasksArchiveReturn> archive(String taskId, [TasksArchiveOptions options = const TasksArchiveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "archive",
      body: requestBody,
      decode: tasksArchiveReturnFromJson,
    );
  }

  Future<TasksBlockReturn> block(String taskId, [TasksBlockOptions options = const TasksBlockOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "block",
      body: requestBody,
      decode: tasksBlockReturnFromJson,
    );
  }

  Future<TasksCommentReturn> comment(String taskId, String body) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    requestBody["body"] = RaviJson.from(body);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "comment",
      body: requestBody,
      decode: tasksCommentReturnFromJson,
    );
  }

  Future<TasksCreateReturn> create(String title, [TasksCreateOptions options = const TasksCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["title"] = RaviJson.from(title);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "create",
      body: requestBody,
      decode: tasksCreateReturnFromJson,
    );
  }

  Future<TasksDispatchReturn> dispatch(String taskId, [TasksDispatchOptions options = const TasksDispatchOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "dispatch",
      body: requestBody,
      decode: tasksDispatchReturnFromJson,
    );
  }

  Future<TasksDoneReturn> done(String taskId, [TasksDoneOptions options = const TasksDoneOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "done",
      body: requestBody,
      decode: tasksDoneReturnFromJson,
    );
  }

  Future<TasksFailReturn> fail(String taskId, [TasksFailOptions options = const TasksFailOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "fail",
      body: requestBody,
      decode: tasksFailReturnFromJson,
    );
  }

  Future<TasksListReturn> list([TasksListOptions options = const TasksListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "list",
      body: requestBody,
      decode: tasksListReturnFromJson,
    );
  }

  Future<TasksReportReturn> report(String taskId, [TasksReportOptions options = const TasksReportOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "report",
      body: requestBody,
      decode: tasksReportReturnFromJson,
    );
  }

  Future<TasksShowReturn> show(String taskId, [TasksShowOptions options = const TasksShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "show",
      body: requestBody,
      decode: tasksShowReturnFromJson,
    );
  }

  Future<TasksUnarchiveReturn> unarchive(String taskId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    return _transport.callJson(
      groupSegments: const ["tasks"],
      command: "unarchive",
      body: requestBody,
      decode: tasksUnarchiveReturnFromJson,
    );
  }
}

class TasksAutomationsNamespace {
  const TasksAutomationsNamespace(this._transport);

  final RaviTransport _transport;

  Future<TasksAutomationsAddReturn> add(String name, [TasksAutomationsAddOptions options = const TasksAutomationsAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks", "automations"],
      command: "add",
      body: requestBody,
      decode: tasksAutomationsAddReturnFromJson,
    );
  }

  Future<TasksAutomationsDisableReturn> disable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["tasks", "automations"],
      command: "disable",
      body: requestBody,
      decode: tasksAutomationsDisableReturnFromJson,
    );
  }

  Future<TasksAutomationsEnableReturn> enable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["tasks", "automations"],
      command: "enable",
      body: requestBody,
      decode: tasksAutomationsEnableReturnFromJson,
    );
  }

  Future<TasksAutomationsListReturn> list([TasksAutomationsListOptions options = const TasksAutomationsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks", "automations"],
      command: "list",
      body: requestBody,
      decode: tasksAutomationsListReturnFromJson,
    );
  }

  Future<TasksAutomationsRmReturn> rm(String id, [TasksAutomationsRmOptions options = const TasksAutomationsRmOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks", "automations"],
      command: "rm",
      body: requestBody,
      decode: tasksAutomationsRmReturnFromJson,
    );
  }

  Future<TasksAutomationsShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["tasks", "automations"],
      command: "show",
      body: requestBody,
      decode: tasksAutomationsShowReturnFromJson,
    );
  }
}

class TasksDepsNamespace {
  const TasksDepsNamespace(this._transport);

  final RaviTransport _transport;

  Future<TasksDepsAddReturn> add(String taskId, String dependencyTaskId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    requestBody["dependencyTaskId"] = RaviJson.from(dependencyTaskId);
    return _transport.callJson(
      groupSegments: const ["tasks", "deps"],
      command: "add",
      body: requestBody,
      decode: tasksDepsAddReturnFromJson,
    );
  }

  Future<TasksDepsLsReturn> ls(String taskId, [TasksDepsLsOptions options = const TasksDepsLsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks", "deps"],
      command: "ls",
      body: requestBody,
      decode: tasksDepsLsReturnFromJson,
    );
  }

  Future<TasksDepsRmReturn> rm(String taskId, String dependencyTaskId, [TasksDepsRmOptions options = const TasksDepsRmOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["taskId"] = RaviJson.from(taskId);
    requestBody["dependencyTaskId"] = RaviJson.from(dependencyTaskId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks", "deps"],
      command: "rm",
      body: requestBody,
      decode: tasksDepsRmReturnFromJson,
    );
  }
}

class TasksProfilesNamespace {
  const TasksProfilesNamespace(this._transport);

  final RaviTransport _transport;

  Future<TasksProfilesInitReturn> init(String profileId, [TasksProfilesInitOptions options = const TasksProfilesInitOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profileId"] = RaviJson.from(profileId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks", "profiles"],
      command: "init",
      body: requestBody,
      decode: tasksProfilesInitReturnFromJson,
    );
  }

  Future<TasksProfilesListReturn> list([TasksProfilesListOptions options = const TasksProfilesListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks", "profiles"],
      command: "list",
      body: requestBody,
      decode: tasksProfilesListReturnFromJson,
    );
  }

  Future<TasksProfilesPreviewReturn> preview(String profileId, [TasksProfilesPreviewOptions options = const TasksProfilesPreviewOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profileId"] = RaviJson.from(profileId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tasks", "profiles"],
      command: "preview",
      body: requestBody,
      decode: tasksProfilesPreviewReturnFromJson,
    );
  }

  Future<TasksProfilesShowReturn> show(String profileId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["profileId"] = RaviJson.from(profileId);
    return _transport.callJson(
      groupSegments: const ["tasks", "profiles"],
      command: "show",
      body: requestBody,
      decode: tasksProfilesShowReturnFromJson,
    );
  }

  Future<TasksProfilesValidateReturn> validate([String? profileId]) async {
    final requestBody = <String, RaviJson>{};
    if (profileId != null) {
      requestBody["profileId"] = RaviJson.from(profileId);
    }
    return _transport.callJson(
      groupSegments: const ["tasks", "profiles"],
      command: "validate",
      body: requestBody,
      decode: tasksProfilesValidateReturnFromJson,
    );
  }
}

class ThreadsNamespace {
  const ThreadsNamespace(this._transport);

  final RaviTransport _transport;

  Future<ThreadsBriefReturn> brief(String thread, [ThreadsBriefOptions options = const ThreadsBriefOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["thread"] = RaviJson.from(thread);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["threads"],
      command: "brief",
      body: requestBody,
      decode: threadsBriefReturnFromJson,
    );
  }

  Future<ThreadsCloseReturn> close(String thread, [ThreadsCloseOptions options = const ThreadsCloseOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["thread"] = RaviJson.from(thread);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["threads"],
      command: "close",
      body: requestBody,
      decode: threadsCloseReturnFromJson,
    );
  }

  Future<ThreadsCommentReturn> comment(String thread, String body, [ThreadsCommentOptions options = const ThreadsCommentOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["thread"] = RaviJson.from(thread);
    requestBody["body"] = RaviJson.from(body);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["threads"],
      command: "comment",
      body: requestBody,
      decode: threadsCommentReturnFromJson,
    );
  }

  Future<ThreadsCreateReturn> create(String slug, [ThreadsCreateOptions options = const ThreadsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["slug"] = RaviJson.from(slug);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["threads"],
      command: "create",
      body: requestBody,
      decode: threadsCreateReturnFromJson,
    );
  }

  Future<ThreadsEntriesReturn> entries(String thread, [ThreadsEntriesOptions options = const ThreadsEntriesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["thread"] = RaviJson.from(thread);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["threads"],
      command: "entries",
      body: requestBody,
      decode: threadsEntriesReturnFromJson,
    );
  }

  Future<ThreadsLinkReturn> link(String thread, String target, [ThreadsLinkOptions options = const ThreadsLinkOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["thread"] = RaviJson.from(thread);
    requestBody["target"] = RaviJson.from(target);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["threads"],
      command: "link",
      body: requestBody,
      decode: threadsLinkReturnFromJson,
    );
  }

  Future<ThreadsListReturn> list([ThreadsListOptions options = const ThreadsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["threads"],
      command: "list",
      body: requestBody,
      decode: threadsListReturnFromJson,
    );
  }

  Future<ThreadsNoteReturn> note(String thread, String body, [ThreadsNoteOptions options = const ThreadsNoteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["thread"] = RaviJson.from(thread);
    requestBody["body"] = RaviJson.from(body);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["threads"],
      command: "note",
      body: requestBody,
      decode: threadsNoteReturnFromJson,
    );
  }

  Future<ThreadsShowReturn> show(String thread, [ThreadsShowOptions options = const ThreadsShowOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["thread"] = RaviJson.from(thread);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["threads"],
      command: "show",
      body: requestBody,
      decode: threadsShowReturnFromJson,
    );
  }
}

class ToolsNamespace {
  const ToolsNamespace(this._transport);

  final RaviTransport _transport;

  Future<ToolsInvokeReturn> invoke(String name, [String? args]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    if (args != null) {
      requestBody["args"] = RaviJson.from(args);
    }
    return _transport.callJson(
      groupSegments: const ["tools"],
      command: "invoke",
      body: requestBody,
      decode: toolsInvokeReturnFromJson,
    );
  }

  Future<ToolsListReturn> list([ToolsListOptions options = const ToolsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tools"],
      command: "list",
      body: requestBody,
      decode: toolsListReturnFromJson,
    );
  }

  Future<ToolsManifestReturn> manifest() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["tools"],
      command: "manifest",
      body: requestBody,
      decode: toolsManifestReturnFromJson,
    );
  }

  Future<ToolsSchemaReturn> schema() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["tools"],
      command: "schema",
      body: requestBody,
      decode: toolsSchemaReturnFromJson,
    );
  }

  Future<ToolsSearchReturn> search(String query, [ToolsSearchOptions options = const ToolsSearchOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["query"] = RaviJson.from(query);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["tools"],
      command: "search",
      body: requestBody,
      decode: toolsSearchReturnFromJson,
    );
  }

  Future<ToolsShowReturn> show(String name) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    return _transport.callJson(
      groupSegments: const ["tools"],
      command: "show",
      body: requestBody,
      decode: toolsShowReturnFromJson,
    );
  }

  Future<ToolsTestReturn> test(String name, [String? args]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    if (args != null) {
      requestBody["args"] = RaviJson.from(args);
    }
    return _transport.callJson(
      groupSegments: const ["tools"],
      command: "test",
      body: requestBody,
      decode: toolsTestReturnFromJson,
    );
  }
}

class TranscribeNamespace {
  const TranscribeNamespace(this._transport);

  final RaviTransport _transport;

  Future<TranscribeFileReturn> file(String path, [TranscribeFileOptions options = const TranscribeFileOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["path"] = RaviJson.from(path);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["transcribe"],
      command: "file",
      body: requestBody,
      decode: transcribeFileReturnFromJson,
    );
  }
}

class TriggersNamespace {
  const TriggersNamespace(this._transport);

  final RaviTransport _transport;

  Future<TriggersAddReturn> add(String name, [TriggersAddOptions options = const TriggersAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["triggers"],
      command: "add",
      body: requestBody,
      decode: triggersAddReturnFromJson,
    );
  }

  Future<TriggersDisableReturn> disable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["triggers"],
      command: "disable",
      body: requestBody,
      decode: triggersDisableReturnFromJson,
    );
  }

  Future<TriggersEnableReturn> enable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["triggers"],
      command: "enable",
      body: requestBody,
      decode: triggersEnableReturnFromJson,
    );
  }

  Future<TriggersListReturn> list([TriggersListOptions options = const TriggersListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["triggers"],
      command: "list",
      body: requestBody,
      decode: triggersListReturnFromJson,
    );
  }

  Future<TriggersRmReturn> rm(String id, [TriggersRmOptions options = const TriggersRmOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["triggers"],
      command: "rm",
      body: requestBody,
      decode: triggersRmReturnFromJson,
    );
  }

  Future<TriggersSetReturn> set_(String id, String key, String value) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    requestBody["key"] = RaviJson.from(key);
    requestBody["value"] = RaviJson.from(value);
    return _transport.callJson(
      groupSegments: const ["triggers"],
      command: "set",
      body: requestBody,
      decode: triggersSetReturnFromJson,
    );
  }

  Future<TriggersShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["triggers"],
      command: "show",
      body: requestBody,
      decode: triggersShowReturnFromJson,
    );
  }

  Future<TriggersTestReturn> test(String id, [TriggersTestOptions options = const TriggersTestOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["triggers"],
      command: "test",
      body: requestBody,
      decode: triggersTestReturnFromJson,
    );
  }

  Future<TriggersTopicsReturn> topics() async {
    final requestBody = <String, RaviJson>{};
    return _transport.callJson(
      groupSegments: const ["triggers"],
      command: "topics",
      body: requestBody,
      decode: triggersTopicsReturnFromJson,
    );
  }
}

class VideoNamespace {
  const VideoNamespace(this._transport);

  final RaviTransport _transport;

  Future<VideoAnalyzeReturn> analyze(String url, [VideoAnalyzeOptions options = const VideoAnalyzeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["url"] = RaviJson.from(url);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["video"],
      command: "analyze",
      body: requestBody,
      decode: videoAnalyzeReturnFromJson,
    );
  }
}

class WatchNamespace {
  const WatchNamespace(this._transport);

  final RaviTransport _transport;

  Future<WatchConnectorsReturn> connectors([WatchConnectorsOptions options = const WatchConnectorsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["watch"],
      command: "connectors",
      body: requestBody,
      decode: watchConnectorsReturnFromJson,
    );
  }

  Future<WatchCreateReturn> create(String provider, String resource, [WatchCreateOptions options = const WatchCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["provider"] = RaviJson.from(provider);
    requestBody["resource"] = RaviJson.from(resource);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["watch"],
      command: "create",
      body: requestBody,
      decode: watchCreateReturnFromJson,
    );
  }

  Future<WatchDisableReturn> disable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["watch"],
      command: "disable",
      body: requestBody,
      decode: watchDisableReturnFromJson,
    );
  }

  Future<WatchEnableReturn> enable(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["watch"],
      command: "enable",
      body: requestBody,
      decode: watchEnableReturnFromJson,
    );
  }

  Future<WatchEventsReturn> events(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["watch"],
      command: "events",
      body: requestBody,
      decode: watchEventsReturnFromJson,
    );
  }

  Future<WatchListReturn> list([WatchListOptions options = const WatchListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["watch"],
      command: "list",
      body: requestBody,
      decode: watchListReturnFromJson,
    );
  }

  Future<WatchRmReturn> rm(String id, [WatchRmOptions options = const WatchRmOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["watch"],
      command: "rm",
      body: requestBody,
      decode: watchRmReturnFromJson,
    );
  }

  Future<WatchShowReturn> show(String id) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    return _transport.callJson(
      groupSegments: const ["watch"],
      command: "show",
      body: requestBody,
      decode: watchShowReturnFromJson,
    );
  }

  Future<WatchTriggerReturn> trigger(String id, [WatchTriggerOptions options = const WatchTriggerOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["watch"],
      command: "trigger",
      body: requestBody,
      decode: watchTriggerReturnFromJson,
    );
  }
}

class WhatsappNamespace {
  const WhatsappNamespace(this._transport);

  final RaviTransport _transport;

  WhatsappDmNamespace get dm => WhatsappDmNamespace(_transport);

  WhatsappGroupNamespace get group => WhatsappGroupNamespace(_transport);
}

class WhatsappDmNamespace {
  const WhatsappDmNamespace(this._transport);

  final RaviTransport _transport;

  Future<WhatsappDmAckReturn> ack(String contact, String messageId, [WhatsappDmAckOptions options = const WhatsappDmAckOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    requestBody["messageId"] = RaviJson.from(messageId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "dm"],
      command: "ack",
      body: requestBody,
      decode: whatsappDmAckReturnFromJson,
    );
  }

  Future<WhatsappDmReadReturn> read(String contact, [WhatsappDmReadOptions options = const WhatsappDmReadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "dm"],
      command: "read",
      body: requestBody,
      decode: whatsappDmReadReturnFromJson,
    );
  }

  Future<WhatsappDmSendReturn> send(String contact, String message, [WhatsappDmSendOptions options = const WhatsappDmSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["contact"] = RaviJson.from(contact);
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "dm"],
      command: "send",
      body: requestBody,
      decode: whatsappDmSendReturnFromJson,
    );
  }
}

class WhatsappGroupNamespace {
  const WhatsappGroupNamespace(this._transport);

  final RaviTransport _transport;

  Future<WhatsappGroupAddReturn> add(String groupId, String participants, [WhatsappGroupAddOptions options = const WhatsappGroupAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    requestBody["participants"] = RaviJson.from(participants);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "add",
      body: requestBody,
      decode: whatsappGroupAddReturnFromJson,
    );
  }

  Future<WhatsappGroupCreateReturn> create(String name, [String? participants, WhatsappGroupCreateOptions options = const WhatsappGroupCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["name"] = RaviJson.from(name);
    if (participants != null) {
      requestBody["participants"] = RaviJson.from(participants);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "create",
      body: requestBody,
      decode: whatsappGroupCreateReturnFromJson,
    );
  }

  Future<WhatsappGroupDemoteReturn> demote(String groupId, String participants, [WhatsappGroupDemoteOptions options = const WhatsappGroupDemoteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    requestBody["participants"] = RaviJson.from(participants);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "demote",
      body: requestBody,
      decode: whatsappGroupDemoteReturnFromJson,
    );
  }

  Future<WhatsappGroupDescriptionReturn> description(String groupId, String text, [WhatsappGroupDescriptionOptions options = const WhatsappGroupDescriptionOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    requestBody["text"] = RaviJson.from(text);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "description",
      body: requestBody,
      decode: whatsappGroupDescriptionReturnFromJson,
    );
  }

  Future<WhatsappGroupInfoReturn> info(String groupId, [WhatsappGroupInfoOptions options = const WhatsappGroupInfoOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "info",
      body: requestBody,
      decode: whatsappGroupInfoReturnFromJson,
    );
  }

  Future<WhatsappGroupInviteReturn> invite(String groupId, [WhatsappGroupInviteOptions options = const WhatsappGroupInviteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "invite",
      body: requestBody,
      decode: whatsappGroupInviteReturnFromJson,
    );
  }

  Future<WhatsappGroupJoinReturn> join(String code, [WhatsappGroupJoinOptions options = const WhatsappGroupJoinOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["code"] = RaviJson.from(code);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "join",
      body: requestBody,
      decode: whatsappGroupJoinReturnFromJson,
    );
  }

  Future<WhatsappGroupLeaveReturn> leave(String groupId, [WhatsappGroupLeaveOptions options = const WhatsappGroupLeaveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "leave",
      body: requestBody,
      decode: whatsappGroupLeaveReturnFromJson,
    );
  }

  Future<WhatsappGroupListReturn> list([WhatsappGroupListOptions options = const WhatsappGroupListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "list",
      body: requestBody,
      decode: whatsappGroupListReturnFromJson,
    );
  }

  Future<WhatsappGroupPromoteReturn> promote(String groupId, String participants, [WhatsappGroupPromoteOptions options = const WhatsappGroupPromoteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    requestBody["participants"] = RaviJson.from(participants);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "promote",
      body: requestBody,
      decode: whatsappGroupPromoteReturnFromJson,
    );
  }

  Future<WhatsappGroupRemoveReturn> remove(String groupId, String participants, [WhatsappGroupRemoveOptions options = const WhatsappGroupRemoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    requestBody["participants"] = RaviJson.from(participants);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "remove",
      body: requestBody,
      decode: whatsappGroupRemoveReturnFromJson,
    );
  }

  Future<WhatsappGroupRenameReturn> rename(String groupId, String name, [WhatsappGroupRenameOptions options = const WhatsappGroupRenameOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    requestBody["name"] = RaviJson.from(name);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "rename",
      body: requestBody,
      decode: whatsappGroupRenameReturnFromJson,
    );
  }

  Future<WhatsappGroupRevokeInviteReturn> revokeInvite(String groupId, [WhatsappGroupRevokeInviteOptions options = const WhatsappGroupRevokeInviteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "revoke-invite",
      body: requestBody,
      decode: whatsappGroupRevokeInviteReturnFromJson,
    );
  }

  Future<WhatsappGroupSendReturn> send(String groupId, String message, [WhatsappGroupSendOptions options = const WhatsappGroupSendOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    requestBody["message"] = RaviJson.from(message);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "send",
      body: requestBody,
      decode: whatsappGroupSendReturnFromJson,
    );
  }

  Future<WhatsappGroupSettingsReturn> settings(String groupId, String setting, [WhatsappGroupSettingsOptions options = const WhatsappGroupSettingsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["groupId"] = RaviJson.from(groupId);
    requestBody["setting"] = RaviJson.from(setting);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["whatsapp", "group"],
      command: "settings",
      body: requestBody,
      decode: whatsappGroupSettingsReturnFromJson,
    );
  }
}

class WorkObjectsNamespace {
  const WorkObjectsNamespace(this._transport);

  final RaviTransport _transport;

  Future<WorkObjectsActionReturn> action(String type, String id, String actionId, [WorkObjectsActionOptions options = const WorkObjectsActionOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["type"] = RaviJson.from(type);
    requestBody["id"] = RaviJson.from(id);
    requestBody["actionId"] = RaviJson.from(actionId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["work-objects"],
      command: "action",
      body: requestBody,
      decode: workObjectsActionReturnFromJson,
    );
  }

  Future<WorkObjectsResolveReturn> resolve([String? target, WorkObjectsResolveOptions options = const WorkObjectsResolveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    if (target != null) {
      requestBody["target"] = RaviJson.from(target);
    }
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["work-objects"],
      command: "resolve",
      body: requestBody,
      decode: workObjectsResolveReturnFromJson,
    );
  }

  Future<WorkObjectsSuggestReturn> suggest(String type, String id, String fieldId, [WorkObjectsSuggestOptions options = const WorkObjectsSuggestOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["type"] = RaviJson.from(type);
    requestBody["id"] = RaviJson.from(id);
    requestBody["fieldId"] = RaviJson.from(fieldId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["work-objects"],
      command: "suggest",
      body: requestBody,
      decode: workObjectsSuggestReturnFromJson,
    );
  }

  Future<WorkObjectsUpdateReturn> update(String type, String id, [WorkObjectsUpdateOptions options = const WorkObjectsUpdateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["type"] = RaviJson.from(type);
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["work-objects"],
      command: "update",
      body: requestBody,
      decode: workObjectsUpdateReturnFromJson,
    );
  }
}

class WorkflowsNamespace {
  const WorkflowsNamespace(this._transport);

  final RaviTransport _transport;

  WorkflowsRunsNamespace get runs => WorkflowsRunsNamespace(_transport);

  WorkflowsSpecsNamespace get specs => WorkflowsSpecsNamespace(_transport);
}

class WorkflowsRunsNamespace {
  const WorkflowsRunsNamespace(this._transport);

  final RaviTransport _transport;

  Future<WorkflowsRunsArchiveNodeReturn> archiveNode(String runId, String nodeKey, [WorkflowsRunsArchiveNodeOptions options = const WorkflowsRunsArchiveNodeOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["runId"] = RaviJson.from(runId);
    requestBody["nodeKey"] = RaviJson.from(nodeKey);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["workflows", "runs"],
      command: "archive-node",
      body: requestBody,
      decode: workflowsRunsArchiveNodeReturnFromJson,
    );
  }

  Future<WorkflowsRunsCancelReturn> cancel(String runId, String nodeKey) async {
    final requestBody = <String, RaviJson>{};
    requestBody["runId"] = RaviJson.from(runId);
    requestBody["nodeKey"] = RaviJson.from(nodeKey);
    return _transport.callJson(
      groupSegments: const ["workflows", "runs"],
      command: "cancel",
      body: requestBody,
      decode: workflowsRunsCancelReturnFromJson,
    );
  }

  Future<WorkflowsRunsListReturn> list([WorkflowsRunsListOptions options = const WorkflowsRunsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["workflows", "runs"],
      command: "list",
      body: requestBody,
      decode: workflowsRunsListReturnFromJson,
    );
  }

  Future<WorkflowsRunsReleaseReturn> release(String runId, String nodeKey) async {
    final requestBody = <String, RaviJson>{};
    requestBody["runId"] = RaviJson.from(runId);
    requestBody["nodeKey"] = RaviJson.from(nodeKey);
    return _transport.callJson(
      groupSegments: const ["workflows", "runs"],
      command: "release",
      body: requestBody,
      decode: workflowsRunsReleaseReturnFromJson,
    );
  }

  Future<WorkflowsRunsShowReturn> show(String runId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["runId"] = RaviJson.from(runId);
    return _transport.callJson(
      groupSegments: const ["workflows", "runs"],
      command: "show",
      body: requestBody,
      decode: workflowsRunsShowReturnFromJson,
    );
  }

  Future<WorkflowsRunsSkipReturn> skip(String runId, String nodeKey) async {
    final requestBody = <String, RaviJson>{};
    requestBody["runId"] = RaviJson.from(runId);
    requestBody["nodeKey"] = RaviJson.from(nodeKey);
    return _transport.callJson(
      groupSegments: const ["workflows", "runs"],
      command: "skip",
      body: requestBody,
      decode: workflowsRunsSkipReturnFromJson,
    );
  }

  Future<WorkflowsRunsStartReturn> start(String specId, [WorkflowsRunsStartOptions options = const WorkflowsRunsStartOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["specId"] = RaviJson.from(specId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["workflows", "runs"],
      command: "start",
      body: requestBody,
      decode: workflowsRunsStartReturnFromJson,
    );
  }

  Future<WorkflowsRunsTaskAttachReturn> taskAttach(String runId, String nodeKey, String taskId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["runId"] = RaviJson.from(runId);
    requestBody["nodeKey"] = RaviJson.from(nodeKey);
    requestBody["taskId"] = RaviJson.from(taskId);
    return _transport.callJson(
      groupSegments: const ["workflows", "runs"],
      command: "task-attach",
      body: requestBody,
      decode: workflowsRunsTaskAttachReturnFromJson,
    );
  }

  Future<WorkflowsRunsTaskCreateReturn> taskCreate(String runId, String nodeKey, [WorkflowsRunsTaskCreateOptions options = const WorkflowsRunsTaskCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["runId"] = RaviJson.from(runId);
    requestBody["nodeKey"] = RaviJson.from(nodeKey);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["workflows", "runs"],
      command: "task-create",
      body: requestBody,
      decode: workflowsRunsTaskCreateReturnFromJson,
    );
  }
}

class WorkflowsSpecsNamespace {
  const WorkflowsSpecsNamespace(this._transport);

  final RaviTransport _transport;

  Future<WorkflowsSpecsCreateReturn> create(String specId, [WorkflowsSpecsCreateOptions options = const WorkflowsSpecsCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["specId"] = RaviJson.from(specId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["workflows", "specs"],
      command: "create",
      body: requestBody,
      decode: workflowsSpecsCreateReturnFromJson,
    );
  }

  Future<WorkflowsSpecsListReturn> list([WorkflowsSpecsListOptions options = const WorkflowsSpecsListOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["workflows", "specs"],
      command: "list",
      body: requestBody,
      decode: workflowsSpecsListReturnFromJson,
    );
  }

  Future<WorkflowsSpecsShowReturn> show(String specId) async {
    final requestBody = <String, RaviJson>{};
    requestBody["specId"] = RaviJson.from(specId);
    return _transport.callJson(
      groupSegments: const ["workflows", "specs"],
      command: "show",
      body: requestBody,
      decode: workflowsSpecsShowReturnFromJson,
    );
  }
}

class YtNamespace {
  const YtNamespace(this._transport);

  final RaviTransport _transport;

  Future<YtAnalyticsCountriesReturn> analyticsCountries([YtAnalyticsCountriesOptions options = const YtAnalyticsCountriesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "analytics-countries",
      body: requestBody,
      decode: ytAnalyticsCountriesReturnFromJson,
    );
  }

  Future<YtAnalyticsDemographicsReturn> analyticsDemographics([YtAnalyticsDemographicsOptions options = const YtAnalyticsDemographicsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "analytics-demographics",
      body: requestBody,
      decode: ytAnalyticsDemographicsReturnFromJson,
    );
  }

  Future<YtAnalyticsDevicesReturn> analyticsDevices([YtAnalyticsDevicesOptions options = const YtAnalyticsDevicesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "analytics-devices",
      body: requestBody,
      decode: ytAnalyticsDevicesReturnFromJson,
    );
  }

  Future<YtAnalyticsOverviewReturn> analyticsOverview([YtAnalyticsOverviewOptions options = const YtAnalyticsOverviewOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "analytics-overview",
      body: requestBody,
      decode: ytAnalyticsOverviewReturnFromJson,
    );
  }

  Future<YtAnalyticsSeriesReturn> analyticsSeries([YtAnalyticsSeriesOptions options = const YtAnalyticsSeriesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "analytics-series",
      body: requestBody,
      decode: ytAnalyticsSeriesReturnFromJson,
    );
  }

  Future<YtAnalyticsTopReturn> analyticsTop([YtAnalyticsTopOptions options = const YtAnalyticsTopOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "analytics-top",
      body: requestBody,
      decode: ytAnalyticsTopReturnFromJson,
    );
  }

  Future<YtAnalyticsTrafficReturn> analyticsTraffic([YtAnalyticsTrafficOptions options = const YtAnalyticsTrafficOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "analytics-traffic",
      body: requestBody,
      decode: ytAnalyticsTrafficReturnFromJson,
    );
  }

  Future<YtCaptionDownloadReturn> captionDownload(String captionId, [YtCaptionDownloadOptions options = const YtCaptionDownloadOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["captionId"] = RaviJson.from(captionId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "caption-download",
      body: requestBody,
      decode: ytCaptionDownloadReturnFromJson,
    );
  }

  Future<YtCaptionsReturn> captions(String videoId, [YtCaptionsOptions options = const YtCaptionsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["videoId"] = RaviJson.from(videoId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "captions",
      body: requestBody,
      decode: ytCaptionsReturnFromJson,
    );
  }

  Future<YtCommentsReturn> comments(String videoId, [YtCommentsOptions options = const YtCommentsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["videoId"] = RaviJson.from(videoId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "comments",
      body: requestBody,
      decode: ytCommentsReturnFromJson,
    );
  }

  Future<YtHealthReturn> health([YtHealthOptions options = const YtHealthOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "health",
      body: requestBody,
      decode: ytHealthReturnFromJson,
    );
  }

  Future<YtInfoReturn> info([YtInfoOptions options = const YtInfoOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "info",
      body: requestBody,
      decode: ytInfoReturnFromJson,
    );
  }

  Future<YtPlaylistReturn> playlist(String playlistId, [YtPlaylistOptions options = const YtPlaylistOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["playlistId"] = RaviJson.from(playlistId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "playlist",
      body: requestBody,
      decode: ytPlaylistReturnFromJson,
    );
  }

  Future<YtPlaylistAddReturn> playlistAdd(String playlistId, String videoId, [YtPlaylistAddOptions options = const YtPlaylistAddOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["playlistId"] = RaviJson.from(playlistId);
    requestBody["videoId"] = RaviJson.from(videoId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "playlist-add",
      body: requestBody,
      decode: ytPlaylistAddReturnFromJson,
    );
  }

  Future<YtPlaylistCreateReturn> playlistCreate(String title, [YtPlaylistCreateOptions options = const YtPlaylistCreateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["title"] = RaviJson.from(title);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "playlist-create",
      body: requestBody,
      decode: ytPlaylistCreateReturnFromJson,
    );
  }

  Future<YtPlaylistDeleteReturn> playlistDelete(String playlistId, [YtPlaylistDeleteOptions options = const YtPlaylistDeleteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["playlistId"] = RaviJson.from(playlistId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "playlist-delete",
      body: requestBody,
      decode: ytPlaylistDeleteReturnFromJson,
    );
  }

  Future<YtPlaylistRemoveReturn> playlistRemove(String playlistItemId, [YtPlaylistRemoveOptions options = const YtPlaylistRemoveOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["playlistItemId"] = RaviJson.from(playlistItemId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "playlist-remove",
      body: requestBody,
      decode: ytPlaylistRemoveReturnFromJson,
    );
  }

  Future<YtPlaylistsReturn> playlists([YtPlaylistsOptions options = const YtPlaylistsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "playlists",
      body: requestBody,
      decode: ytPlaylistsReturnFromJson,
    );
  }

  Future<YtReplyReturn> reply(String commentId, String text, [YtReplyOptions options = const YtReplyOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["commentId"] = RaviJson.from(commentId);
    requestBody["text"] = RaviJson.from(text);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "reply",
      body: requestBody,
      decode: ytReplyReturnFromJson,
    );
  }

  Future<YtSearchReturn> search(String query, [YtSearchOptions options = const YtSearchOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["query"] = RaviJson.from(query);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "search",
      body: requestBody,
      decode: ytSearchReturnFromJson,
    );
  }

  Future<YtStatsReturn> stats(String id, [YtStatsOptions options = const YtStatsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "stats",
      body: requestBody,
      decode: ytStatsReturnFromJson,
    );
  }

  Future<YtSubscriptionsReturn> subscriptions([YtSubscriptionsOptions options = const YtSubscriptionsOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "subscriptions",
      body: requestBody,
      decode: ytSubscriptionsReturnFromJson,
    );
  }

  Future<YtUnansweredReturn> unanswered(String videoId, [YtUnansweredOptions options = const YtUnansweredOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["videoId"] = RaviJson.from(videoId);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "unanswered",
      body: requestBody,
      decode: ytUnansweredReturnFromJson,
    );
  }

  Future<YtVideoReturn> video(String id, [YtVideoOptions options = const YtVideoOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "video",
      body: requestBody,
      decode: ytVideoReturnFromJson,
    );
  }

  Future<YtVideoCategoriesReturn> videoCategories([YtVideoCategoriesOptions options = const YtVideoCategoriesOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "video-categories",
      body: requestBody,
      decode: ytVideoCategoriesReturnFromJson,
    );
  }

  Future<YtVideoDeleteReturn> videoDelete(String id, [YtVideoDeleteOptions options = const YtVideoDeleteOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "video-delete",
      body: requestBody,
      decode: ytVideoDeleteReturnFromJson,
    );
  }

  Future<YtVideoUpdateReturn> videoUpdate(String id, [YtVideoUpdateOptions options = const YtVideoUpdateOptions()]) async {
    final requestBody = <String, RaviJson>{};
    requestBody["id"] = RaviJson.from(id);
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "video-update",
      body: requestBody,
      decode: ytVideoUpdateReturnFromJson,
    );
  }

  Future<YtVideosReturn> videos([YtVideosOptions options = const YtVideosOptions()]) async {
    final requestBody = <String, RaviJson>{};
    options.encodeBody(requestBody);
    return _transport.callJson(
      groupSegments: const ["yt"],
      command: "videos",
      body: requestBody,
      decode: ytVideosReturnFromJson,
    );
  }
}
