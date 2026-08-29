// GENERATED FILE - DO NOT EDIT.
// Run `ravi sdk dart generate` to regenerate.
// Drift is detected by `ravi sdk dart check`.

import 'ravi_json.dart';
import 'ravi_transport.dart';

class AdaptersListOptions {
  const AdaptersListOptions({this.limit, this.offset, this.session, this.status});

  final String? limit;
  final String? offset;
  final String? session;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class AdaptersListReturn {
  const AdaptersListReturn({required this.adapters, required this.count, required this.items, required this.pagination, required this.total});

  final List<RaviJson> adapters;
  final double count;
  final List<RaviJson> items;
  final RaviJson pagination;
  final double total;

  factory AdaptersListReturn.fromJson(Map<String, Object?> json) {
    return AdaptersListReturn(
      adapters: raviJsonAsList(json["adapters"], RaviJson.from),
      count: raviJsonAsDouble(json["count"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static AdaptersListReturn fromJsonValue(Object? json) {
    return AdaptersListReturn.fromJson(raviJsonObject(json, "AdaptersListReturn"));
  }
}

AdaptersListReturn adaptersListReturnFromJson(Object? json) => AdaptersListReturn.fromJsonValue(json);

class AdaptersShowReturn {
  const AdaptersShowReturn({required this.adapterId, required this.adapterName, required this.bind, required this.diagnosticState, required this.health, required this.lastCommand, required this.lastEvent, required this.lastProtocolError, required this.sessionKey, required this.sessionName, required this.status, required this.transport, required this.updatedAt});

  final String adapterId;
  final String adapterName;
  final RaviJson bind;
  final String diagnosticState;
  final Map<String, RaviJson> health;
  final RaviJson lastCommand;
  final RaviJson lastEvent;
  final RaviJson lastProtocolError;
  final String sessionKey;
  final RaviJson sessionName;
  final String status;
  final String transport;
  final double updatedAt;

  factory AdaptersShowReturn.fromJson(Map<String, Object?> json) {
    return AdaptersShowReturn(
      adapterId: raviJsonAsString(json["adapterId"]),
      adapterName: raviJsonAsString(json["adapterName"]),
      bind: RaviJson.from(json["bind"]),
      diagnosticState: raviJsonAsString(json["diagnosticState"]),
      health: raviJsonAsRaviJsonMap(json["health"]),
      lastCommand: RaviJson.from(json["lastCommand"]),
      lastEvent: RaviJson.from(json["lastEvent"]),
      lastProtocolError: RaviJson.from(json["lastProtocolError"]),
      sessionKey: raviJsonAsString(json["sessionKey"]),
      sessionName: RaviJson.from(json["sessionName"]),
      status: raviJsonAsString(json["status"]),
      transport: raviJsonAsString(json["transport"]),
      updatedAt: raviJsonAsDouble(json["updatedAt"]),
    );
  }

  static AdaptersShowReturn fromJsonValue(Object? json) {
    return AdaptersShowReturn.fromJson(raviJsonObject(json, "AdaptersShowReturn"));
  }
}

AdaptersShowReturn adaptersShowReturnFromJson(Object? json) => AdaptersShowReturn.fromJsonValue(json);

class AgentsCreateOptions {
  const AgentsCreateOptions({this.allowRuntimeMismatch, this.model, this.modelPreset, this.provider});

  final bool? allowRuntimeMismatch;
  final String? model;
  final String? modelPreset;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (allowRuntimeMismatch != null) {
      into["allowRuntimeMismatch"] = RaviJson.from(allowRuntimeMismatch);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (modelPreset != null) {
      into["modelPreset"] = RaviJson.from(modelPreset);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class AgentsCreateReturn {
  const AgentsCreateReturn({required this.action, required this.agent, required this.changed, required this.permissions, required this.runtimeTarget});

  final String action;
  final Map<String, RaviJson> agent;
  final bool changed;
  final Map<String, RaviJson> permissions;
  final Map<String, RaviJson> runtimeTarget;

  factory AgentsCreateReturn.fromJson(Map<String, Object?> json) {
    return AgentsCreateReturn(
      action: raviJsonAsString(json["action"]),
      agent: raviJsonAsRaviJsonMap(json["agent"]),
      changed: raviJsonAsBool(json["changed"]),
      permissions: raviJsonAsRaviJsonMap(json["permissions"]),
      runtimeTarget: raviJsonAsRaviJsonMap(json["runtimeTarget"]),
    );
  }

  static AgentsCreateReturn fromJsonValue(Object? json) {
    return AgentsCreateReturn.fromJson(raviJsonObject(json, "AgentsCreateReturn"));
  }
}

AgentsCreateReturn agentsCreateReturnFromJson(Object? json) => AgentsCreateReturn.fromJsonValue(json);

class AgentsDebounceReturn {
  const AgentsDebounceReturn({this.action, required this.agentId, this.changed, required this.debounceMs, required this.enabled});

  final String? action;
  final String agentId;
  final bool? changed;
  final RaviJson debounceMs;
  final bool enabled;

  factory AgentsDebounceReturn.fromJson(Map<String, Object?> json) {
    return AgentsDebounceReturn(
      action: json["action"] == null ? null : raviJsonAsString(json["action"]),
      agentId: raviJsonAsString(json["agentId"]),
      changed: json["changed"] == null ? null : raviJsonAsBool(json["changed"]),
      debounceMs: RaviJson.from(json["debounceMs"]),
      enabled: raviJsonAsBool(json["enabled"]),
    );
  }

  static AgentsDebounceReturn fromJsonValue(Object? json) {
    return AgentsDebounceReturn.fromJson(raviJsonObject(json, "AgentsDebounceReturn"));
  }
}

AgentsDebounceReturn agentsDebounceReturnFromJson(Object? json) => AgentsDebounceReturn.fromJsonValue(json);

class AgentsDebugOptions {
  const AgentsDebugOptions({this.turns});

  final String? turns;

  void encodeBody(Map<String, RaviJson> into) {
    if (turns != null) {
      into["turns"] = RaviJson.from(turns);
    }
  }
}

typedef AgentsDebugReturn = RaviJson;

AgentsDebugReturn agentsDebugReturnFromJson(Object? json) => RaviJson.from(json);

class AgentsDeleteOptions {
  const AgentsDeleteOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class AgentsDeleteReturn {
  const AgentsDeleteReturn({required this.action, required this.agentId, this.before, required this.changed});

  final String action;
  final String agentId;
  final Map<String, RaviJson>? before;
  final bool changed;

  factory AgentsDeleteReturn.fromJson(Map<String, Object?> json) {
    return AgentsDeleteReturn(
      action: raviJsonAsString(json["action"]),
      agentId: raviJsonAsString(json["agentId"]),
      before: json["before"] == null ? null : raviJsonAsRaviJsonMap(json["before"]),
      changed: raviJsonAsBool(json["changed"]),
    );
  }

  static AgentsDeleteReturn fromJsonValue(Object? json) {
    return AgentsDeleteReturn.fromJson(raviJsonObject(json, "AgentsDeleteReturn"));
  }
}

AgentsDeleteReturn agentsDeleteReturnFromJson(Object? json) => AgentsDeleteReturn.fromJsonValue(json);

class AgentsListOptions {
  const AgentsListOptions({this.fields, this.limit, this.offset, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class AgentsListReturn {
  const AgentsListReturn({required this.agents, required this.defaultAgent, required this.filters, required this.items, required this.pagination, required this.total});

  final List<RaviJson> agents;
  final String defaultAgent;
  final RaviJson filters;
  final List<RaviJson> items;
  final RaviJson pagination;
  final double total;

  factory AgentsListReturn.fromJson(Map<String, Object?> json) {
    return AgentsListReturn(
      agents: raviJsonAsList(json["agents"], RaviJson.from),
      defaultAgent: raviJsonAsString(json["defaultAgent"]),
      filters: RaviJson.from(json["filters"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static AgentsListReturn fromJsonValue(Object? json) {
    return AgentsListReturn.fromJson(raviJsonObject(json, "AgentsListReturn"));
  }
}

AgentsListReturn agentsListReturnFromJson(Object? json) => AgentsListReturn.fromJsonValue(json);

class AgentsModelBrokerOptions {
  const AgentsModelBrokerOptions({this.broker, this.clear, this.execute, this.profile, this.required_});

  final String? broker;
  final bool? clear;
  final bool? execute;
  final String? profile;
  final String? required_;

  void encodeBody(Map<String, RaviJson> into) {
    if (broker != null) {
      into["broker"] = RaviJson.from(broker);
    }
    if (clear != null) {
      into["clear"] = RaviJson.from(clear);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (required_ != null) {
      into["required"] = RaviJson.from(required_);
    }
  }
}

class AgentsModelBrokerReturn {
  const AgentsModelBrokerReturn({required this.action, this.agent, required this.agentId, required this.changed, this.defaults, required this.modelBroker});

  final String action;
  final RaviJson? agent;
  final String agentId;
  final bool changed;
  final RaviJson? defaults;
  final RaviJson modelBroker;

  factory AgentsModelBrokerReturn.fromJson(Map<String, Object?> json) {
    return AgentsModelBrokerReturn(
      action: raviJsonAsString(json["action"]),
      agent: json["agent"] == null ? null : RaviJson.from(json["agent"]),
      agentId: raviJsonAsString(json["agentId"]),
      changed: raviJsonAsBool(json["changed"]),
      defaults: json["defaults"] == null ? null : RaviJson.from(json["defaults"]),
      modelBroker: RaviJson.from(json["modelBroker"]),
    );
  }

  static AgentsModelBrokerReturn fromJsonValue(Object? json) {
    return AgentsModelBrokerReturn.fromJson(raviJsonObject(json, "AgentsModelBrokerReturn"));
  }
}

AgentsModelBrokerReturn agentsModelBrokerReturnFromJson(Object? json) => AgentsModelBrokerReturn.fromJsonValue(json);

class AgentsPermissionsOptions {
  const AgentsPermissionsOptions({this.capabilities, this.clearCapabilities, this.execute});

  final String? capabilities;
  final bool? clearCapabilities;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (capabilities != null) {
      into["capabilities"] = RaviJson.from(capabilities);
    }
    if (clearCapabilities != null) {
      into["clearCapabilities"] = RaviJson.from(clearCapabilities);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class AgentsPermissionsReturn {
  const AgentsPermissionsReturn({required this.action, this.after, this.agent, required this.agentId, this.before, required this.changed, this.command, this.defaults, this.profile, this.runtimePermissions});

  final String action;
  final RaviJson? after;
  final RaviJson? agent;
  final String agentId;
  final RaviJson? before;
  final bool changed;
  final String? command;
  final RaviJson? defaults;
  final String? profile;
  final RaviJson? runtimePermissions;

  factory AgentsPermissionsReturn.fromJson(Map<String, Object?> json) {
    return AgentsPermissionsReturn(
      action: raviJsonAsString(json["action"]),
      after: json["after"] == null ? null : RaviJson.from(json["after"]),
      agent: json["agent"] == null ? null : RaviJson.from(json["agent"]),
      agentId: raviJsonAsString(json["agentId"]),
      before: json["before"] == null ? null : RaviJson.from(json["before"]),
      changed: raviJsonAsBool(json["changed"]),
      command: json["command"] == null ? null : raviJsonAsString(json["command"]),
      defaults: json["defaults"] == null ? null : RaviJson.from(json["defaults"]),
      profile: json["profile"] == null ? null : raviJsonAsString(json["profile"]),
      runtimePermissions: json["runtimePermissions"] == null ? null : RaviJson.from(json["runtimePermissions"]),
    );
  }

  static AgentsPermissionsReturn fromJsonValue(Object? json) {
    return AgentsPermissionsReturn.fromJson(raviJsonObject(json, "AgentsPermissionsReturn"));
  }
}

AgentsPermissionsReturn agentsPermissionsReturnFromJson(Object? json) => AgentsPermissionsReturn.fromJsonValue(json);

class AgentsResetOptions {
  const AgentsResetOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class AgentsResetReturn {
  const AgentsResetReturn({required this.action, required this.agentId, this.availableSessions, required this.changed, this.count, this.reason, this.resetSessions, this.session, required this.target});

  final String action;
  final String agentId;
  final List<String>? availableSessions;
  final bool changed;
  final double? count;
  final String? reason;
  final List<Map<String, RaviJson>>? resetSessions;
  final Map<String, RaviJson>? session;
  final String target;

  factory AgentsResetReturn.fromJson(Map<String, Object?> json) {
    return AgentsResetReturn(
      action: raviJsonAsString(json["action"]),
      agentId: raviJsonAsString(json["agentId"]),
      availableSessions: json["availableSessions"] == null ? null : raviJsonAsList(json["availableSessions"], raviJsonAsString),
      changed: raviJsonAsBool(json["changed"]),
      count: json["count"] == null ? null : raviJsonAsDouble(json["count"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      resetSessions: json["resetSessions"] == null ? null : raviJsonAsList(json["resetSessions"], raviJsonAsRaviJsonMap),
      session: json["session"] == null ? null : raviJsonAsRaviJsonMap(json["session"]),
      target: raviJsonAsString(json["target"]),
    );
  }

  static AgentsResetReturn fromJsonValue(Object? json) {
    return AgentsResetReturn.fromJson(raviJsonObject(json, "AgentsResetReturn"));
  }
}

AgentsResetReturn agentsResetReturnFromJson(Object? json) => AgentsResetReturn.fromJsonValue(json);

class AgentsSessionReturn {
  const AgentsSessionReturn({required this.agent, required this.sessions, required this.total});

  final Map<String, RaviJson> agent;
  final List<Map<String, RaviJson>> sessions;
  final double total;

  factory AgentsSessionReturn.fromJson(Map<String, Object?> json) {
    return AgentsSessionReturn(
      agent: raviJsonAsRaviJsonMap(json["agent"]),
      sessions: raviJsonAsList(json["sessions"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static AgentsSessionReturn fromJsonValue(Object? json) {
    return AgentsSessionReturn.fromJson(raviJsonObject(json, "AgentsSessionReturn"));
  }
}

AgentsSessionReturn agentsSessionReturnFromJson(Object? json) => AgentsSessionReturn.fromJsonValue(json);

class AgentsSetReturn {
  const AgentsSetReturn({required this.action, this.agent, required this.agentId, required this.changed, required this.key, required this.sessionOverrides, required this.value});

  final String action;
  final Map<String, RaviJson>? agent;
  final String agentId;
  final bool changed;
  final String key;
  final List<RaviJson> sessionOverrides;
  final RaviJson value;

  factory AgentsSetReturn.fromJson(Map<String, Object?> json) {
    return AgentsSetReturn(
      action: raviJsonAsString(json["action"]),
      agent: json["agent"] == null ? null : raviJsonAsRaviJsonMap(json["agent"]),
      agentId: raviJsonAsString(json["agentId"]),
      changed: raviJsonAsBool(json["changed"]),
      key: raviJsonAsString(json["key"]),
      sessionOverrides: raviJsonAsList(json["sessionOverrides"], RaviJson.from),
      value: RaviJson.from(json["value"]),
    );
  }

  static AgentsSetReturn fromJsonValue(Object? json) {
    return AgentsSetReturn.fromJson(raviJsonObject(json, "AgentsSetReturn"));
  }
}

AgentsSetReturn agentsSetReturnFromJson(Object? json) => AgentsSetReturn.fromJsonValue(json);

class AgentsShowReturn {
  const AgentsShowReturn({required this.agent, required this.permissionsCommand, required this.runtimePermissions});

  final RaviJson agent;
  final String permissionsCommand;
  final RaviJson runtimePermissions;

  factory AgentsShowReturn.fromJson(Map<String, Object?> json) {
    return AgentsShowReturn(
      agent: RaviJson.from(json["agent"]),
      permissionsCommand: raviJsonAsString(json["permissionsCommand"]),
      runtimePermissions: RaviJson.from(json["runtimePermissions"]),
    );
  }

  static AgentsShowReturn fromJsonValue(Object? json) {
    return AgentsShowReturn.fromJson(raviJsonObject(json, "AgentsShowReturn"));
  }
}

AgentsShowReturn agentsShowReturnFromJson(Object? json) => AgentsShowReturn.fromJsonValue(json);

class AgentsSpecModeReturn {
  const AgentsSpecModeReturn({this.action, required this.agentId, this.changed, required this.specMode});

  final String? action;
  final String agentId;
  final bool? changed;
  final bool specMode;

  factory AgentsSpecModeReturn.fromJson(Map<String, Object?> json) {
    return AgentsSpecModeReturn(
      action: json["action"] == null ? null : raviJsonAsString(json["action"]),
      agentId: raviJsonAsString(json["agentId"]),
      changed: json["changed"] == null ? null : raviJsonAsBool(json["changed"]),
      specMode: raviJsonAsBool(json["specMode"]),
    );
  }

  static AgentsSpecModeReturn fromJsonValue(Object? json) {
    return AgentsSpecModeReturn.fromJson(raviJsonObject(json, "AgentsSpecModeReturn"));
  }
}

AgentsSpecModeReturn agentsSpecModeReturnFromJson(Object? json) => AgentsSpecModeReturn.fromJsonValue(json);

class AgentsSyncInstructionsOptions {
  const AgentsSyncInstructionsOptions({this.agent, this.materializeMissing});

  final String? agent;
  final bool? materializeMissing;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (materializeMissing != null) {
      into["materializeMissing"] = RaviJson.from(materializeMissing);
    }
  }
}

class AgentsSyncInstructionsReturn {
  const AgentsSyncInstructionsReturn({required this.alreadyCanonical, required this.incomplete, required this.manualReview, required this.migrated, required this.missing, required this.results, required this.total});

  final double alreadyCanonical;
  final double incomplete;
  final double manualReview;
  final double migrated;
  final double missing;
  final List<Map<String, RaviJson>> results;
  final double total;

  factory AgentsSyncInstructionsReturn.fromJson(Map<String, Object?> json) {
    return AgentsSyncInstructionsReturn(
      alreadyCanonical: raviJsonAsDouble(json["alreadyCanonical"]),
      incomplete: raviJsonAsDouble(json["incomplete"]),
      manualReview: raviJsonAsDouble(json["manualReview"]),
      migrated: raviJsonAsDouble(json["migrated"]),
      missing: raviJsonAsDouble(json["missing"]),
      results: raviJsonAsList(json["results"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static AgentsSyncInstructionsReturn fromJsonValue(Object? json) {
    return AgentsSyncInstructionsReturn.fromJson(raviJsonObject(json, "AgentsSyncInstructionsReturn"));
  }
}

AgentsSyncInstructionsReturn agentsSyncInstructionsReturnFromJson(Object? json) => AgentsSyncInstructionsReturn.fromJsonValue(json);

class AppsCheckReturn {
  const AppsCheckReturn({required this.checked, required this.ok, required this.results});

  final double checked;
  final bool ok;
  final List<RaviJson> results;

  factory AppsCheckReturn.fromJson(Map<String, Object?> json) {
    return AppsCheckReturn(
      checked: raviJsonAsDouble(json["checked"]),
      ok: raviJsonAsBool(json["ok"]),
      results: raviJsonAsList(json["results"], RaviJson.from),
    );
  }

  static AppsCheckReturn fromJsonValue(Object? json) {
    return AppsCheckReturn.fromJson(raviJsonObject(json, "AppsCheckReturn"));
  }
}

AppsCheckReturn appsCheckReturnFromJson(Object? json) => AppsCheckReturn.fromJsonValue(json);

class AppsDeleteOptions {
  const AppsDeleteOptions({this.dryRun});

  final bool? dryRun;

  void encodeBody(Map<String, RaviJson> into) {
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
  }
}

class AppsDeleteReturn {
  const AppsDeleteReturn({required this.dryRun, required this.files, required this.id, required this.nextCommands, required this.removedDirs});

  final bool dryRun;
  final List<RaviJson> files;
  final String id;
  final List<String> nextCommands;
  final List<String> removedDirs;

  factory AppsDeleteReturn.fromJson(Map<String, Object?> json) {
    return AppsDeleteReturn(
      dryRun: raviJsonAsBool(json["dryRun"]),
      files: raviJsonAsList(json["files"], RaviJson.from),
      id: raviJsonAsString(json["id"]),
      nextCommands: raviJsonAsList(json["nextCommands"], raviJsonAsString),
      removedDirs: raviJsonAsList(json["removedDirs"], raviJsonAsString),
    );
  }

  static AppsDeleteReturn fromJsonValue(Object? json) {
    return AppsDeleteReturn.fromJson(raviJsonObject(json, "AppsDeleteReturn"));
  }
}

AppsDeleteReturn appsDeleteReturnFromJson(Object? json) => AppsDeleteReturn.fromJsonValue(json);

class AppsGuideReturn {
  const AppsGuideReturn({required this.app, required this.appId, required this.builder, required this.nextCommands, required this.prompts, required this.skill, required this.skillGate});

  final RaviJson app;
  final RaviJson appId;
  final RaviJson builder;
  final List<String> nextCommands;
  final List<RaviJson> prompts;
  final String skill;
  final RaviJson skillGate;

  factory AppsGuideReturn.fromJson(Map<String, Object?> json) {
    return AppsGuideReturn(
      app: RaviJson.from(json["app"]),
      appId: RaviJson.from(json["appId"]),
      builder: RaviJson.from(json["builder"]),
      nextCommands: raviJsonAsList(json["nextCommands"], raviJsonAsString),
      prompts: raviJsonAsList(json["prompts"], RaviJson.from),
      skill: raviJsonAsString(json["skill"]),
      skillGate: RaviJson.from(json["skillGate"]),
    );
  }

  static AppsGuideReturn fromJsonValue(Object? json) {
    return AppsGuideReturn.fromJson(raviJsonObject(json, "AppsGuideReturn"));
  }
}

AppsGuideReturn appsGuideReturnFromJson(Object? json) => AppsGuideReturn.fromJsonValue(json);

class AppsImportCliOptions {
  const AppsImportCliOptions({this.description, this.dryRun, this.force, this.id, this.name, this.skipSkill, this.skipSpec, this.skipUi, this.source});

  final String? description;
  final bool? dryRun;
  final bool? force;
  final String? id;
  final String? name;
  final bool? skipSkill;
  final bool? skipSpec;
  final bool? skipUi;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
    if (force != null) {
      into["force"] = RaviJson.from(force);
    }
    if (id != null) {
      into["id"] = RaviJson.from(id);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (skipSkill != null) {
      into["skipSkill"] = RaviJson.from(skipSkill);
    }
    if (skipSpec != null) {
      into["skipSpec"] = RaviJson.from(skipSpec);
    }
    if (skipUi != null) {
      into["skipUi"] = RaviJson.from(skipUi);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class AppsImportCliReturn {
  const AppsImportCliReturn({required this.builder, required this.cliPath, required this.command, required this.confidence, required this.debugCandidates, required this.description, required this.dryRun, required this.files, required this.force, required this.id, required this.manifest, required this.manifestPath, required this.name, required this.nextCommands, required this.operationCandidates, required this.reviewRequired, required this.skill, required this.skillPath, required this.source, required this.sourceCommand, required this.specPath, required this.warnings});

  final RaviJson builder;
  final RaviJson cliPath;
  final String command;
  final String confidence;
  final List<RaviJson> debugCandidates;
  final String description;
  final bool dryRun;
  final List<RaviJson> files;
  final bool force;
  final String id;
  final Map<String, RaviJson> manifest;
  final String manifestPath;
  final String name;
  final List<String> nextCommands;
  final List<RaviJson> operationCandidates;
  final List<String> reviewRequired;
  final RaviJson skill;
  final RaviJson skillPath;
  final String source;
  final String sourceCommand;
  final RaviJson specPath;
  final List<String> warnings;

  factory AppsImportCliReturn.fromJson(Map<String, Object?> json) {
    return AppsImportCliReturn(
      builder: RaviJson.from(json["builder"]),
      cliPath: RaviJson.from(json["cliPath"]),
      command: raviJsonAsString(json["command"]),
      confidence: raviJsonAsString(json["confidence"]),
      debugCandidates: raviJsonAsList(json["debugCandidates"], RaviJson.from),
      description: raviJsonAsString(json["description"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      files: raviJsonAsList(json["files"], RaviJson.from),
      force: raviJsonAsBool(json["force"]),
      id: raviJsonAsString(json["id"]),
      manifest: raviJsonAsRaviJsonMap(json["manifest"]),
      manifestPath: raviJsonAsString(json["manifestPath"]),
      name: raviJsonAsString(json["name"]),
      nextCommands: raviJsonAsList(json["nextCommands"], raviJsonAsString),
      operationCandidates: raviJsonAsList(json["operationCandidates"], RaviJson.from),
      reviewRequired: raviJsonAsList(json["reviewRequired"], raviJsonAsString),
      skill: RaviJson.from(json["skill"]),
      skillPath: RaviJson.from(json["skillPath"]),
      source: raviJsonAsString(json["source"]),
      sourceCommand: raviJsonAsString(json["sourceCommand"]),
      specPath: RaviJson.from(json["specPath"]),
      warnings: raviJsonAsList(json["warnings"], raviJsonAsString),
    );
  }

  static AppsImportCliReturn fromJsonValue(Object? json) {
    return AppsImportCliReturn.fromJson(raviJsonObject(json, "AppsImportCliReturn"));
  }
}

AppsImportCliReturn appsImportCliReturnFromJson(Object? json) => AppsImportCliReturn.fromJsonValue(json);

class AppsListOptions {
  const AppsListOptions({this.limit, this.offset, this.source});

  final String? limit;
  final String? offset;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class AppsListReturn {
  const AppsListReturn({required this.apps, required this.items, required this.pagination, required this.total});

  final List<RaviJson> apps;
  final List<RaviJson> items;
  final RaviJson pagination;
  final double total;

  factory AppsListReturn.fromJson(Map<String, Object?> json) {
    return AppsListReturn(
      apps: raviJsonAsList(json["apps"], RaviJson.from),
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static AppsListReturn fromJsonValue(Object? json) {
    return AppsListReturn.fromJson(raviJsonObject(json, "AppsListReturn"));
  }
}

AppsListReturn appsListReturnFromJson(Object? json) => AppsListReturn.fromJsonValue(json);

class AppsPromptsReturn {
  const AppsPromptsReturn({required this.app, required this.appId, required this.builder, required this.nextCommands, required this.prompts, required this.skill, required this.skillGate});

  final RaviJson app;
  final RaviJson appId;
  final RaviJson builder;
  final List<String> nextCommands;
  final List<RaviJson> prompts;
  final String skill;
  final RaviJson skillGate;

  factory AppsPromptsReturn.fromJson(Map<String, Object?> json) {
    return AppsPromptsReturn(
      app: RaviJson.from(json["app"]),
      appId: RaviJson.from(json["appId"]),
      builder: RaviJson.from(json["builder"]),
      nextCommands: raviJsonAsList(json["nextCommands"], raviJsonAsString),
      prompts: raviJsonAsList(json["prompts"], RaviJson.from),
      skill: raviJsonAsString(json["skill"]),
      skillGate: RaviJson.from(json["skillGate"]),
    );
  }

  static AppsPromptsReturn fromJsonValue(Object? json) {
    return AppsPromptsReturn.fromJson(raviJsonObject(json, "AppsPromptsReturn"));
  }
}

AppsPromptsReturn appsPromptsReturnFromJson(Object? json) => AppsPromptsReturn.fromJsonValue(json);

class AppsRunOptions {
  const AppsRunOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class AppsRunReturn {
  const AppsRunReturn({required this.appId, this.callerContextId, this.channel, this.childContextId, this.command, this.dryRun, required this.durationMs, this.error, this.errorCode, this.exitCode, this.handler, required this.interface_, required this.mutating, required this.ok, required this.operation, required this.operationId, this.permissionProvider, this.plan, this.result, required this.status, this.stderr, this.stdout});

  final RaviJson appId;
  final String? callerContextId;
  final String? channel;
  final String? childContextId;
  final String? command;
  final bool? dryRun;
  final double durationMs;
  final String? error;
  final String? errorCode;
  final RaviJson? exitCode;
  final String? handler;
  final RaviJson interface_;
  final bool mutating;
  final bool ok;
  final RaviJson operation;
  final RaviJson operationId;
  final RaviJson? permissionProvider;
  final RaviJson? plan;
  final RaviJson? result;
  final String status;
  final String? stderr;
  final String? stdout;

  factory AppsRunReturn.fromJson(Map<String, Object?> json) {
    return AppsRunReturn(
      appId: RaviJson.from(json["appId"]),
      callerContextId: json["callerContextId"] == null ? null : raviJsonAsString(json["callerContextId"]),
      channel: json["channel"] == null ? null : raviJsonAsString(json["channel"]),
      childContextId: json["childContextId"] == null ? null : raviJsonAsString(json["childContextId"]),
      command: json["command"] == null ? null : raviJsonAsString(json["command"]),
      dryRun: json["dryRun"] == null ? null : raviJsonAsBool(json["dryRun"]),
      durationMs: raviJsonAsDouble(json["durationMs"]),
      error: json["error"] == null ? null : raviJsonAsString(json["error"]),
      errorCode: json["errorCode"] == null ? null : raviJsonAsString(json["errorCode"]),
      exitCode: json["exitCode"] == null ? null : RaviJson.from(json["exitCode"]),
      handler: json["handler"] == null ? null : raviJsonAsString(json["handler"]),
      interface_: RaviJson.from(json["interface"]),
      mutating: raviJsonAsBool(json["mutating"]),
      ok: raviJsonAsBool(json["ok"]),
      operation: RaviJson.from(json["operation"]),
      operationId: RaviJson.from(json["operationId"]),
      permissionProvider: json["permissionProvider"] == null ? null : RaviJson.from(json["permissionProvider"]),
      plan: json["plan"] == null ? null : RaviJson.from(json["plan"]),
      result: json["result"] == null ? null : RaviJson.from(json["result"]),
      status: raviJsonAsString(json["status"]),
      stderr: json["stderr"] == null ? null : raviJsonAsString(json["stderr"]),
      stdout: json["stdout"] == null ? null : raviJsonAsString(json["stdout"]),
    );
  }

  static AppsRunReturn fromJsonValue(Object? json) {
    return AppsRunReturn.fromJson(raviJsonObject(json, "AppsRunReturn"));
  }
}

AppsRunReturn appsRunReturnFromJson(Object? json) => AppsRunReturn.fromJsonValue(json);

class AppsScaffoldOptions {
  const AppsScaffoldOptions({this.command, this.description, this.dryRun, this.force, this.name, this.skipSkill, this.skipSpec, this.skipUi});

  final String? command;
  final String? description;
  final bool? dryRun;
  final bool? force;
  final String? name;
  final bool? skipSkill;
  final bool? skipSpec;
  final bool? skipUi;

  void encodeBody(Map<String, RaviJson> into) {
    if (command != null) {
      into["command"] = RaviJson.from(command);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
    if (force != null) {
      into["force"] = RaviJson.from(force);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (skipSkill != null) {
      into["skipSkill"] = RaviJson.from(skipSkill);
    }
    if (skipSpec != null) {
      into["skipSpec"] = RaviJson.from(skipSpec);
    }
    if (skipUi != null) {
      into["skipUi"] = RaviJson.from(skipUi);
    }
  }
}

class AppsScaffoldReturn {
  const AppsScaffoldReturn({required this.builder, required this.cliPath, required this.command, required this.description, required this.dryRun, required this.files, required this.force, required this.id, required this.manifest, required this.manifestPath, required this.name, required this.nextCommands, required this.skill, required this.skillPath, required this.specPath});

  final RaviJson builder;
  final RaviJson cliPath;
  final String command;
  final String description;
  final bool dryRun;
  final List<RaviJson> files;
  final bool force;
  final String id;
  final Map<String, RaviJson> manifest;
  final String manifestPath;
  final String name;
  final List<String> nextCommands;
  final RaviJson skill;
  final RaviJson skillPath;
  final RaviJson specPath;

  factory AppsScaffoldReturn.fromJson(Map<String, Object?> json) {
    return AppsScaffoldReturn(
      builder: RaviJson.from(json["builder"]),
      cliPath: RaviJson.from(json["cliPath"]),
      command: raviJsonAsString(json["command"]),
      description: raviJsonAsString(json["description"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      files: raviJsonAsList(json["files"], RaviJson.from),
      force: raviJsonAsBool(json["force"]),
      id: raviJsonAsString(json["id"]),
      manifest: raviJsonAsRaviJsonMap(json["manifest"]),
      manifestPath: raviJsonAsString(json["manifestPath"]),
      name: raviJsonAsString(json["name"]),
      nextCommands: raviJsonAsList(json["nextCommands"], raviJsonAsString),
      skill: RaviJson.from(json["skill"]),
      skillPath: RaviJson.from(json["skillPath"]),
      specPath: RaviJson.from(json["specPath"]),
    );
  }

  static AppsScaffoldReturn fromJsonValue(Object? json) {
    return AppsScaffoldReturn.fromJson(raviJsonObject(json, "AppsScaffoldReturn"));
  }
}

AppsScaffoldReturn appsScaffoldReturnFromJson(Object? json) => AppsScaffoldReturn.fromJsonValue(json);

class AppsShowReturn {
  const AppsShowReturn({required this.app});

  final RaviJson app;

  factory AppsShowReturn.fromJson(Map<String, Object?> json) {
    return AppsShowReturn(
      app: RaviJson.from(json["app"]),
    );
  }

  static AppsShowReturn fromJsonValue(Object? json) {
    return AppsShowReturn.fromJson(raviJsonObject(json, "AppsShowReturn"));
  }
}

AppsShowReturn appsShowReturnFromJson(Object? json) => AppsShowReturn.fromJsonValue(json);

class ArtifactsArchiveReturn {
  const ArtifactsArchiveReturn({required this.success});

  final bool success;

  factory ArtifactsArchiveReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsArchiveReturn(
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ArtifactsArchiveReturn fromJsonValue(Object? json) {
    return ArtifactsArchiveReturn.fromJson(raviJsonObject(json, "ArtifactsArchiveReturn"));
  }
}

ArtifactsArchiveReturn artifactsArchiveReturnFromJson(Object? json) => ArtifactsArchiveReturn.fromJsonValue(json);

class ArtifactsAttachOptions {
  const ArtifactsAttachOptions({this.metadata, this.relation});

  final String? metadata;
  final String? relation;

  void encodeBody(Map<String, RaviJson> into) {
    if (metadata != null) {
      into["metadata"] = RaviJson.from(metadata);
    }
    if (relation != null) {
      into["relation"] = RaviJson.from(relation);
    }
  }
}

class ArtifactsAttachReturn {
  const ArtifactsAttachReturn({required this.success});

  final bool success;

  factory ArtifactsAttachReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsAttachReturn(
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ArtifactsAttachReturn fromJsonValue(Object? json) {
    return ArtifactsAttachReturn.fromJson(raviJsonObject(json, "ArtifactsAttachReturn"));
  }
}

ArtifactsAttachReturn artifactsAttachReturnFromJson(Object? json) => ArtifactsAttachReturn.fromJsonValue(json);

typedef ArtifactsBlobReturn = RaviBinaryResponse;

ArtifactsBlobReturn artifactsBlobReturnFromJson(Object? json) {
  throw FormatException('ArtifactsBlobReturn is a binary response and cannot be decoded from JSON');
}

class ArtifactsCreateOptions {
  const ArtifactsCreateOptions({this.assetBase, this.basePath, this.command, this.costUsd, this.durationMs, this.entrypoint, this.input, this.inputTokens, this.kind, this.lineage, this.message, this.metadata, this.metrics, this.mime, this.model, this.output, this.outputTokens, this.path, this.prompt, this.provider, this.session, this.summary, this.tags, this.task, this.title, this.totalTokens, this.uri});

  final String? assetBase;
  final String? basePath;
  final String? command;
  final String? costUsd;
  final String? durationMs;
  final String? entrypoint;
  final String? input;
  final String? inputTokens;
  final String? kind;
  final String? lineage;
  final String? message;
  final String? metadata;
  final String? metrics;
  final String? mime;
  final String? model;
  final String? output;
  final String? outputTokens;
  final String? path;
  final String? prompt;
  final String? provider;
  final String? session;
  final String? summary;
  final String? tags;
  final String? task;
  final String? title;
  final String? totalTokens;
  final String? uri;

  void encodeBody(Map<String, RaviJson> into) {
    if (assetBase != null) {
      into["assetBase"] = RaviJson.from(assetBase);
    }
    if (basePath != null) {
      into["basePath"] = RaviJson.from(basePath);
    }
    if (command != null) {
      into["command"] = RaviJson.from(command);
    }
    if (costUsd != null) {
      into["costUsd"] = RaviJson.from(costUsd);
    }
    if (durationMs != null) {
      into["durationMs"] = RaviJson.from(durationMs);
    }
    if (entrypoint != null) {
      into["entrypoint"] = RaviJson.from(entrypoint);
    }
    if (input != null) {
      into["input"] = RaviJson.from(input);
    }
    if (inputTokens != null) {
      into["inputTokens"] = RaviJson.from(inputTokens);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (lineage != null) {
      into["lineage"] = RaviJson.from(lineage);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (metadata != null) {
      into["metadata"] = RaviJson.from(metadata);
    }
    if (metrics != null) {
      into["metrics"] = RaviJson.from(metrics);
    }
    if (mime != null) {
      into["mime"] = RaviJson.from(mime);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (output != null) {
      into["output"] = RaviJson.from(output);
    }
    if (outputTokens != null) {
      into["outputTokens"] = RaviJson.from(outputTokens);
    }
    if (path != null) {
      into["path"] = RaviJson.from(path);
    }
    if (prompt != null) {
      into["prompt"] = RaviJson.from(prompt);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (summary != null) {
      into["summary"] = RaviJson.from(summary);
    }
    if (tags != null) {
      into["tags"] = RaviJson.from(tags);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
    if (totalTokens != null) {
      into["totalTokens"] = RaviJson.from(totalTokens);
    }
    if (uri != null) {
      into["uri"] = RaviJson.from(uri);
    }
  }
}

class ArtifactsCreateReturn {
  const ArtifactsCreateReturn({required this.artifact, this.package, required this.success, this.version});

  final Map<String, RaviJson> artifact;
  final Map<String, RaviJson>? package;
  final bool success;
  final Map<String, RaviJson>? version;

  factory ArtifactsCreateReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsCreateReturn(
      artifact: raviJsonAsRaviJsonMap(json["artifact"]),
      package: json["package"] == null ? null : raviJsonAsRaviJsonMap(json["package"]),
      success: raviJsonAsBool(json["success"]),
      version: json["version"] == null ? null : raviJsonAsRaviJsonMap(json["version"]),
    );
  }

  static ArtifactsCreateReturn fromJsonValue(Object? json) {
    return ArtifactsCreateReturn.fromJson(raviJsonObject(json, "ArtifactsCreateReturn"));
  }
}

ArtifactsCreateReturn artifactsCreateReturnFromJson(Object? json) => ArtifactsCreateReturn.fromJsonValue(json);

class ArtifactsEventOptions {
  const ArtifactsEventOptions({this.message, this.payload, this.source, this.status});

  final String? message;
  final String? payload;
  final String? source;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (payload != null) {
      into["payload"] = RaviJson.from(payload);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class ArtifactsEventReturn {
  const ArtifactsEventReturn({this.artifact, required this.event, required this.success});

  final Map<String, RaviJson>? artifact;
  final Map<String, RaviJson> event;
  final bool success;

  factory ArtifactsEventReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsEventReturn(
      artifact: json["artifact"] == null ? null : raviJsonAsRaviJsonMap(json["artifact"]),
      event: raviJsonAsRaviJsonMap(json["event"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ArtifactsEventReturn fromJsonValue(Object? json) {
    return ArtifactsEventReturn.fromJson(raviJsonObject(json, "ArtifactsEventReturn"));
  }
}

ArtifactsEventReturn artifactsEventReturnFromJson(Object? json) => ArtifactsEventReturn.fromJsonValue(json);

class ArtifactsEventsReturn {
  const ArtifactsEventsReturn({required this.artifactId, required this.events, required this.total});

  final String artifactId;
  final List<Map<String, RaviJson>> events;
  final double total;

  factory ArtifactsEventsReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsEventsReturn(
      artifactId: raviJsonAsString(json["artifactId"]),
      events: raviJsonAsList(json["events"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ArtifactsEventsReturn fromJsonValue(Object? json) {
    return ArtifactsEventsReturn.fromJson(raviJsonObject(json, "ArtifactsEventsReturn"));
  }
}

ArtifactsEventsReturn artifactsEventsReturnFromJson(Object? json) => ArtifactsEventsReturn.fromJsonValue(json);

class ArtifactsListOptions {
  const ArtifactsListOptions({this.agent, this.fields, this.includeDeleted, this.kind, this.lifecycle, this.limit, this.offset, this.orderBy, this.rich, this.session, this.tag, this.task});

  final String? agent;
  final String? fields;
  final bool? includeDeleted;
  final String? kind;
  final String? lifecycle;
  final String? limit;
  final String? offset;
  final String? orderBy;
  final bool? rich;
  final String? session;
  final String? tag;
  final String? task;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (includeDeleted != null) {
      into["includeDeleted"] = RaviJson.from(includeDeleted);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (lifecycle != null) {
      into["lifecycle"] = RaviJson.from(lifecycle);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (orderBy != null) {
      into["orderBy"] = RaviJson.from(orderBy);
    }
    if (rich != null) {
      into["rich"] = RaviJson.from(rich);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
  }
}

typedef ArtifactsListReturn = RaviJson;

ArtifactsListReturn artifactsListReturnFromJson(Object? json) => RaviJson.from(json);

class ArtifactsPublishOptions {
  const ArtifactsPublishOptions({this.artifactVersion, this.assetBase, this.basePath, this.console, this.description, this.entrypoint, this.execute, this.idempotencyKey, this.name, this.noActivate, this.project, this.reason, this.replaceRelease, this.route, this.site, this.slug, this.uploadSession, this.visibility});

  final String? artifactVersion;
  final String? assetBase;
  final String? basePath;
  final String? console;
  final String? description;
  final String? entrypoint;
  final bool? execute;
  final String? idempotencyKey;
  final String? name;
  final bool? noActivate;
  final String? project;
  final String? reason;
  final bool? replaceRelease;
  final String? route;
  final String? site;
  final String? slug;
  final String? uploadSession;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (artifactVersion != null) {
      into["artifactVersion"] = RaviJson.from(artifactVersion);
    }
    if (assetBase != null) {
      into["assetBase"] = RaviJson.from(assetBase);
    }
    if (basePath != null) {
      into["basePath"] = RaviJson.from(basePath);
    }
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (entrypoint != null) {
      into["entrypoint"] = RaviJson.from(entrypoint);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (noActivate != null) {
      into["noActivate"] = RaviJson.from(noActivate);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
    if (replaceRelease != null) {
      into["replaceRelease"] = RaviJson.from(replaceRelease);
    }
    if (route != null) {
      into["route"] = RaviJson.from(route);
    }
    if (site != null) {
      into["site"] = RaviJson.from(site);
    }
    if (slug != null) {
      into["slug"] = RaviJson.from(slug);
    }
    if (uploadSession != null) {
      into["uploadSession"] = RaviJson.from(uploadSession);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class ArtifactsPublishReturn {
  const ArtifactsPublishReturn({required this.artifact, required this.artifactVersion, required this.authenticated, required this.consoleUrl, required this.localSync, required this.publish, required this.release, required this.routes, required this.site, required this.success, required this.upload, required this.uploadSession, required this.url});

  final RaviJson artifact;
  final RaviJson artifactVersion;
  final bool authenticated;
  final String consoleUrl;
  final RaviJson localSync;
  final RaviJson publish;
  final RaviJson release;
  final List<Map<String, RaviJson>> routes;
  final RaviJson site;
  final bool success;
  final RaviJson upload;
  final RaviJson uploadSession;
  final RaviJson url;

  factory ArtifactsPublishReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsPublishReturn(
      artifact: RaviJson.from(json["artifact"]),
      artifactVersion: RaviJson.from(json["artifactVersion"]),
      authenticated: raviJsonAsBool(json["authenticated"]),
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      localSync: RaviJson.from(json["localSync"]),
      publish: RaviJson.from(json["publish"]),
      release: RaviJson.from(json["release"]),
      routes: raviJsonAsList(json["routes"], raviJsonAsRaviJsonMap),
      site: RaviJson.from(json["site"]),
      success: raviJsonAsBool(json["success"]),
      upload: RaviJson.from(json["upload"]),
      uploadSession: RaviJson.from(json["uploadSession"]),
      url: RaviJson.from(json["url"]),
    );
  }

  static ArtifactsPublishReturn fromJsonValue(Object? json) {
    return ArtifactsPublishReturn.fromJson(raviJsonObject(json, "ArtifactsPublishReturn"));
  }
}

ArtifactsPublishReturn artifactsPublishReturnFromJson(Object? json) => ArtifactsPublishReturn.fromJsonValue(json);

class ArtifactsReleaseActivateOptions {
  const ArtifactsReleaseActivateOptions({this.console, this.execute, this.release, this.site, this.version});

  final String? console;
  final bool? execute;
  final String? release;
  final String? site;
  final String? version;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (release != null) {
      into["release"] = RaviJson.from(release);
    }
    if (site != null) {
      into["site"] = RaviJson.from(site);
    }
    if (version != null) {
      into["version"] = RaviJson.from(version);
    }
  }
}

class ArtifactsReleaseActivateReturn {
  const ArtifactsReleaseActivateReturn({this.localSync, required this.release, required this.routes, required this.site, required this.url});

  final Map<String, RaviJson>? localSync;
  final RaviJson release;
  final List<RaviJson> routes;
  final RaviJson site;
  final RaviJson url;

  factory ArtifactsReleaseActivateReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsReleaseActivateReturn(
      localSync: json["localSync"] == null ? null : raviJsonAsRaviJsonMap(json["localSync"]),
      release: RaviJson.from(json["release"]),
      routes: raviJsonAsList(json["routes"], RaviJson.from),
      site: RaviJson.from(json["site"]),
      url: RaviJson.from(json["url"]),
    );
  }

  static ArtifactsReleaseActivateReturn fromJsonValue(Object? json) {
    return ArtifactsReleaseActivateReturn.fromJson(raviJsonObject(json, "ArtifactsReleaseActivateReturn"));
  }
}

ArtifactsReleaseActivateReturn artifactsReleaseActivateReturnFromJson(Object? json) => ArtifactsReleaseActivateReturn.fromJsonValue(json);

class ArtifactsRestoreOptions {
  const ArtifactsRestoreOptions({this.message, this.version});

  final String? message;
  final String? version;

  void encodeBody(Map<String, RaviJson> into) {
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (version != null) {
      into["version"] = RaviJson.from(version);
    }
  }
}

class ArtifactsRestoreReturn {
  const ArtifactsRestoreReturn({required this.artifact, required this.restoreVersion, required this.restoredFrom, required this.success});

  final Map<String, RaviJson> artifact;
  final Map<String, RaviJson> restoreVersion;
  final Map<String, RaviJson> restoredFrom;
  final bool success;

  factory ArtifactsRestoreReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsRestoreReturn(
      artifact: raviJsonAsRaviJsonMap(json["artifact"]),
      restoreVersion: raviJsonAsRaviJsonMap(json["restoreVersion"]),
      restoredFrom: raviJsonAsRaviJsonMap(json["restoredFrom"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ArtifactsRestoreReturn fromJsonValue(Object? json) {
    return ArtifactsRestoreReturn.fromJson(raviJsonObject(json, "ArtifactsRestoreReturn"));
  }
}

ArtifactsRestoreReturn artifactsRestoreReturnFromJson(Object? json) => ArtifactsRestoreReturn.fromJsonValue(json);

class ArtifactsShowReturn {
  const ArtifactsShowReturn({required this.artifact, required this.events, required this.links, required this.versions});

  final Map<String, RaviJson> artifact;
  final List<Map<String, RaviJson>> events;
  final List<Map<String, RaviJson>> links;
  final List<Map<String, RaviJson>> versions;

  factory ArtifactsShowReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsShowReturn(
      artifact: raviJsonAsRaviJsonMap(json["artifact"]),
      events: raviJsonAsList(json["events"], raviJsonAsRaviJsonMap),
      links: raviJsonAsList(json["links"], raviJsonAsRaviJsonMap),
      versions: raviJsonAsList(json["versions"], raviJsonAsRaviJsonMap),
    );
  }

  static ArtifactsShowReturn fromJsonValue(Object? json) {
    return ArtifactsShowReturn.fromJson(raviJsonObject(json, "ArtifactsShowReturn"));
  }
}

ArtifactsShowReturn artifactsShowReturnFromJson(Object? json) => ArtifactsShowReturn.fromJsonValue(json);

class ArtifactsSnapshotOptions {
  const ArtifactsSnapshotOptions({this.label, this.manifest, this.message, this.metadata, this.source, this.status});

  final String? label;
  final String? manifest;
  final String? message;
  final String? metadata;
  final String? source;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (manifest != null) {
      into["manifest"] = RaviJson.from(manifest);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (metadata != null) {
      into["metadata"] = RaviJson.from(metadata);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class ArtifactsSnapshotReturn {
  const ArtifactsSnapshotReturn({required this.success, required this.version});

  final bool success;
  final Map<String, RaviJson> version;

  factory ArtifactsSnapshotReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsSnapshotReturn(
      success: raviJsonAsBool(json["success"]),
      version: raviJsonAsRaviJsonMap(json["version"]),
    );
  }

  static ArtifactsSnapshotReturn fromJsonValue(Object? json) {
    return ArtifactsSnapshotReturn.fromJson(raviJsonObject(json, "ArtifactsSnapshotReturn"));
  }
}

ArtifactsSnapshotReturn artifactsSnapshotReturnFromJson(Object? json) => ArtifactsSnapshotReturn.fromJsonValue(json);

class ArtifactsUpdateOptions {
  const ArtifactsUpdateOptions({this.command, this.costUsd, this.durationMs, this.input, this.inputTokens, this.lineage, this.message, this.metadata, this.metrics, this.mime, this.model, this.output, this.outputTokens, this.path, this.prompt, this.provider, this.session, this.status, this.summary, this.tags, this.task, this.title, this.totalTokens, this.uri});

  final String? command;
  final String? costUsd;
  final String? durationMs;
  final String? input;
  final String? inputTokens;
  final String? lineage;
  final String? message;
  final String? metadata;
  final String? metrics;
  final String? mime;
  final String? model;
  final String? output;
  final String? outputTokens;
  final String? path;
  final String? prompt;
  final String? provider;
  final String? session;
  final String? status;
  final String? summary;
  final String? tags;
  final String? task;
  final String? title;
  final String? totalTokens;
  final String? uri;

  void encodeBody(Map<String, RaviJson> into) {
    if (command != null) {
      into["command"] = RaviJson.from(command);
    }
    if (costUsd != null) {
      into["costUsd"] = RaviJson.from(costUsd);
    }
    if (durationMs != null) {
      into["durationMs"] = RaviJson.from(durationMs);
    }
    if (input != null) {
      into["input"] = RaviJson.from(input);
    }
    if (inputTokens != null) {
      into["inputTokens"] = RaviJson.from(inputTokens);
    }
    if (lineage != null) {
      into["lineage"] = RaviJson.from(lineage);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (metadata != null) {
      into["metadata"] = RaviJson.from(metadata);
    }
    if (metrics != null) {
      into["metrics"] = RaviJson.from(metrics);
    }
    if (mime != null) {
      into["mime"] = RaviJson.from(mime);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (output != null) {
      into["output"] = RaviJson.from(output);
    }
    if (outputTokens != null) {
      into["outputTokens"] = RaviJson.from(outputTokens);
    }
    if (path != null) {
      into["path"] = RaviJson.from(path);
    }
    if (prompt != null) {
      into["prompt"] = RaviJson.from(prompt);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (summary != null) {
      into["summary"] = RaviJson.from(summary);
    }
    if (tags != null) {
      into["tags"] = RaviJson.from(tags);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
    if (totalTokens != null) {
      into["totalTokens"] = RaviJson.from(totalTokens);
    }
    if (uri != null) {
      into["uri"] = RaviJson.from(uri);
    }
  }
}

class ArtifactsUpdateReturn {
  const ArtifactsUpdateReturn({required this.success});

  final bool success;

  factory ArtifactsUpdateReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsUpdateReturn(
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ArtifactsUpdateReturn fromJsonValue(Object? json) {
    return ArtifactsUpdateReturn.fromJson(raviJsonObject(json, "ArtifactsUpdateReturn"));
  }
}

ArtifactsUpdateReturn artifactsUpdateReturnFromJson(Object? json) => ArtifactsUpdateReturn.fromJsonValue(json);

class ArtifactsVersionOptions {
  const ArtifactsVersionOptions({this.version});

  final String? version;

  void encodeBody(Map<String, RaviJson> into) {
    if (version != null) {
      into["version"] = RaviJson.from(version);
    }
  }
}

class ArtifactsVersionReturn {
  const ArtifactsVersionReturn({required this.artifactId, required this.version});

  final String artifactId;
  final Map<String, RaviJson> version;

  factory ArtifactsVersionReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsVersionReturn(
      artifactId: raviJsonAsString(json["artifactId"]),
      version: raviJsonAsRaviJsonMap(json["version"]),
    );
  }

  static ArtifactsVersionReturn fromJsonValue(Object? json) {
    return ArtifactsVersionReturn.fromJson(raviJsonObject(json, "ArtifactsVersionReturn"));
  }
}

ArtifactsVersionReturn artifactsVersionReturnFromJson(Object? json) => ArtifactsVersionReturn.fromJsonValue(json);

class ArtifactsVersionsReturn {
  const ArtifactsVersionsReturn({required this.artifactId, required this.total, required this.versions});

  final String artifactId;
  final double total;
  final List<Map<String, RaviJson>> versions;

  factory ArtifactsVersionsReturn.fromJson(Map<String, Object?> json) {
    return ArtifactsVersionsReturn(
      artifactId: raviJsonAsString(json["artifactId"]),
      total: raviJsonAsDouble(json["total"]),
      versions: raviJsonAsList(json["versions"], raviJsonAsRaviJsonMap),
    );
  }

  static ArtifactsVersionsReturn fromJsonValue(Object? json) {
    return ArtifactsVersionsReturn.fromJson(raviJsonObject(json, "ArtifactsVersionsReturn"));
  }
}

ArtifactsVersionsReturn artifactsVersionsReturnFromJson(Object? json) => ArtifactsVersionsReturn.fromJsonValue(json);

typedef AudioBlobReturn = RaviBinaryResponse;

AudioBlobReturn audioBlobReturnFromJson(Object? json) {
  throw FormatException('AudioBlobReturn is a binary response and cannot be decoded from JSON');
}

class AudioGenerateOptions {
  const AudioGenerateOptions({this.caption, this.execute, this.format, this.lang, this.model, this.output, this.send, this.speed, this.textFile, this.voice});

  final String? caption;
  final bool? execute;
  final String? format;
  final String? lang;
  final String? model;
  final String? output;
  final bool? send;
  final String? speed;
  final String? textFile;
  final String? voice;

  void encodeBody(Map<String, RaviJson> into) {
    if (caption != null) {
      into["caption"] = RaviJson.from(caption);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (format != null) {
      into["format"] = RaviJson.from(format);
    }
    if (lang != null) {
      into["lang"] = RaviJson.from(lang);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (output != null) {
      into["output"] = RaviJson.from(output);
    }
    if (send != null) {
      into["send"] = RaviJson.from(send);
    }
    if (speed != null) {
      into["speed"] = RaviJson.from(speed);
    }
    if (textFile != null) {
      into["textFile"] = RaviJson.from(textFile);
    }
    if (voice != null) {
      into["voice"] = RaviJson.from(voice);
    }
  }
}

class AudioGenerateReturn {
  const AudioGenerateReturn({required this.audio, required this.options, this.sent, required this.success});

  final RaviJson audio;
  final Map<String, RaviJson> options;
  final RaviJson? sent;
  final bool success;

  factory AudioGenerateReturn.fromJson(Map<String, Object?> json) {
    return AudioGenerateReturn(
      audio: RaviJson.from(json["audio"]),
      options: raviJsonAsRaviJsonMap(json["options"]),
      sent: json["sent"] == null ? null : RaviJson.from(json["sent"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static AudioGenerateReturn fromJsonValue(Object? json) {
    return AudioGenerateReturn.fromJson(raviJsonObject(json, "AudioGenerateReturn"));
  }
}

AudioGenerateReturn audioGenerateReturnFromJson(Object? json) => AudioGenerateReturn.fromJsonValue(json);

class AudioPendingOptions {
  const AudioPendingOptions({this.agent, this.chat, this.clientId, this.fields, this.id, this.includeFailed, this.limit, this.requestId, this.session, this.sessionKey, this.since});

  final String? agent;
  final String? chat;
  final String? clientId;
  final String? fields;
  final String? id;
  final bool? includeFailed;
  final String? limit;
  final String? requestId;
  final String? session;
  final String? sessionKey;
  final String? since;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (chat != null) {
      into["chat"] = RaviJson.from(chat);
    }
    if (clientId != null) {
      into["clientId"] = RaviJson.from(clientId);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (id != null) {
      into["id"] = RaviJson.from(id);
    }
    if (includeFailed != null) {
      into["includeFailed"] = RaviJson.from(includeFailed);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (requestId != null) {
      into["requestId"] = RaviJson.from(requestId);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (sessionKey != null) {
      into["sessionKey"] = RaviJson.from(sessionKey);
    }
    if (since != null) {
      into["since"] = RaviJson.from(since);
    }
  }
}

class AudioPendingReturn {
  const AudioPendingReturn({required this.generatedAt, required this.items, required this.ok});

  final double generatedAt;
  final List<RaviJson> items;
  final bool ok;

  factory AudioPendingReturn.fromJson(Map<String, Object?> json) {
    return AudioPendingReturn(
      generatedAt: raviJsonAsDouble(json["generatedAt"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      ok: raviJsonAsBool(json["ok"]),
    );
  }

  static AudioPendingReturn fromJsonValue(Object? json) {
    return AudioPendingReturn.fromJson(raviJsonObject(json, "AudioPendingReturn"));
  }
}

AudioPendingReturn audioPendingReturnFromJson(Object? json) => AudioPendingReturn.fromJsonValue(json);

class AudioTtsOptions {
  const AudioTtsOptions({this.account, this.agent, this.channel, this.chat, this.clientId, this.elevenlabs, this.execute, this.format, this.id, this.lang, this.model, this.noAutoplay, this.session, this.sessionKey, this.speed, this.voice, this.voiceSettings});

  final String? account;
  final String? agent;
  final String? channel;
  final String? chat;
  final String? clientId;
  final String? elevenlabs;
  final bool? execute;
  final String? format;
  final String? id;
  final String? lang;
  final String? model;
  final bool? noAutoplay;
  final String? session;
  final String? sessionKey;
  final String? speed;
  final String? voice;
  final String? voiceSettings;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (chat != null) {
      into["chat"] = RaviJson.from(chat);
    }
    if (clientId != null) {
      into["clientId"] = RaviJson.from(clientId);
    }
    if (elevenlabs != null) {
      into["elevenlabs"] = RaviJson.from(elevenlabs);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (format != null) {
      into["format"] = RaviJson.from(format);
    }
    if (id != null) {
      into["id"] = RaviJson.from(id);
    }
    if (lang != null) {
      into["lang"] = RaviJson.from(lang);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (noAutoplay != null) {
      into["noAutoplay"] = RaviJson.from(noAutoplay);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (sessionKey != null) {
      into["sessionKey"] = RaviJson.from(sessionKey);
    }
    if (speed != null) {
      into["speed"] = RaviJson.from(speed);
    }
    if (voice != null) {
      into["voice"] = RaviJson.from(voice);
    }
    if (voiceSettings != null) {
      into["voiceSettings"] = RaviJson.from(voiceSettings);
    }
  }
}

class AudioTtsReturn {
  const AudioTtsReturn({required this.ok, required this.request, required this.topic});

  final bool ok;
  final RaviJson request;
  final String topic;

  factory AudioTtsReturn.fromJson(Map<String, Object?> json) {
    return AudioTtsReturn(
      ok: raviJsonAsBool(json["ok"]),
      request: RaviJson.from(json["request"]),
      topic: raviJsonAsString(json["topic"]),
    );
  }

  static AudioTtsReturn fromJsonValue(Object? json) {
    return AudioTtsReturn.fromJson(raviJsonObject(json, "AudioTtsReturn"));
  }
}

AudioTtsReturn audioTtsReturnFromJson(Object? json) => AudioTtsReturn.fromJsonValue(json);

class AudioVoicesOptions {
  const AudioVoicesOptions({this.category, this.fields, this.limit, this.search, this.voiceType});

  final String? category;
  final String? fields;
  final String? limit;
  final String? search;
  final String? voiceType;

  void encodeBody(Map<String, RaviJson> into) {
    if (category != null) {
      into["category"] = RaviJson.from(category);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (search != null) {
      into["search"] = RaviJson.from(search);
    }
    if (voiceType != null) {
      into["voiceType"] = RaviJson.from(voiceType);
    }
  }
}

class AudioVoicesReturn {
  const AudioVoicesReturn({required this.generatedAt, required this.hasMore, this.nextPageToken, required this.ok, required this.provider, this.totalCount, required this.voices});

  final double generatedAt;
  final bool hasMore;
  final String? nextPageToken;
  final bool ok;
  final String provider;
  final double? totalCount;
  final List<RaviJson> voices;

  factory AudioVoicesReturn.fromJson(Map<String, Object?> json) {
    return AudioVoicesReturn(
      generatedAt: raviJsonAsDouble(json["generatedAt"]),
      hasMore: raviJsonAsBool(json["hasMore"]),
      nextPageToken: json["nextPageToken"] == null ? null : raviJsonAsString(json["nextPageToken"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      totalCount: json["totalCount"] == null ? null : raviJsonAsDouble(json["totalCount"]),
      voices: raviJsonAsList(json["voices"], RaviJson.from),
    );
  }

  static AudioVoicesReturn fromJsonValue(Object? json) {
    return AudioVoicesReturn.fromJson(raviJsonObject(json, "AudioVoicesReturn"));
  }
}

AudioVoicesReturn audioVoicesReturnFromJson(Object? json) => AudioVoicesReturn.fromJsonValue(json);

class BridgesCreateOptions {
  const BridgesCreateOptions({this.allow, this.console, this.description, this.name, this.project, this.session});

  final String? allow;
  final String? console;
  final String? description;
  final String? name;
  final String? project;
  final String? session;

  void encodeBody(Map<String, RaviJson> into) {
    if (allow != null) {
      into["allow"] = RaviJson.from(allow);
    }
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
  }
}

class BridgesCreateReturn {
  const BridgesCreateReturn({required this.bridge, required this.bridgeToken, required this.bridgeUrl, required this.consoleUrl, required this.projectRef, required this.success});

  final Map<String, RaviJson> bridge;
  final RaviJson bridgeToken;
  final RaviJson bridgeUrl;
  final String consoleUrl;
  final String projectRef;
  final bool success;

  factory BridgesCreateReturn.fromJson(Map<String, Object?> json) {
    return BridgesCreateReturn(
      bridge: raviJsonAsRaviJsonMap(json["bridge"]),
      bridgeToken: RaviJson.from(json["bridgeToken"]),
      bridgeUrl: RaviJson.from(json["bridgeUrl"]),
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      projectRef: raviJsonAsString(json["projectRef"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static BridgesCreateReturn fromJsonValue(Object? json) {
    return BridgesCreateReturn.fromJson(raviJsonObject(json, "BridgesCreateReturn"));
  }
}

BridgesCreateReturn bridgesCreateReturnFromJson(Object? json) => BridgesCreateReturn.fromJsonValue(json);

class BridgesListOptions {
  const BridgesListOptions({this.console, this.fields, this.limit, this.offset, this.project});

  final String? console;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? project;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
  }
}

class BridgesListReturn {
  const BridgesListReturn({required this.bridges, required this.consoleUrl, required this.items, required this.pagination, required this.projectRef, required this.success, required this.total});

  final List<Map<String, RaviJson>> bridges;
  final String consoleUrl;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final String projectRef;
  final bool success;
  final double total;

  factory BridgesListReturn.fromJson(Map<String, Object?> json) {
    return BridgesListReturn(
      bridges: raviJsonAsList(json["bridges"], raviJsonAsRaviJsonMap),
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      projectRef: raviJsonAsString(json["projectRef"]),
      success: raviJsonAsBool(json["success"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static BridgesListReturn fromJsonValue(Object? json) {
    return BridgesListReturn.fromJson(raviJsonObject(json, "BridgesListReturn"));
  }
}

BridgesListReturn bridgesListReturnFromJson(Object? json) => BridgesListReturn.fromJsonValue(json);

class BridgesRevokeOptions {
  const BridgesRevokeOptions({this.console, this.execute, this.yes});

  final String? console;
  final bool? execute;
  final bool? yes;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (yes != null) {
      into["yes"] = RaviJson.from(yes);
    }
  }
}

class BridgesRevokeReturn {
  const BridgesRevokeReturn({required this.bridgeId, required this.consoleUrl, required this.revoked, required this.success});

  final String bridgeId;
  final String consoleUrl;
  final bool revoked;
  final bool success;

  factory BridgesRevokeReturn.fromJson(Map<String, Object?> json) {
    return BridgesRevokeReturn(
      bridgeId: raviJsonAsString(json["bridgeId"]),
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      revoked: raviJsonAsBool(json["revoked"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static BridgesRevokeReturn fromJsonValue(Object? json) {
    return BridgesRevokeReturn.fromJson(raviJsonObject(json, "BridgesRevokeReturn"));
  }
}

BridgesRevokeReturn bridgesRevokeReturnFromJson(Object? json) => BridgesRevokeReturn.fromJsonValue(json);

class CalendarsAvailabilityOptions {
  const CalendarsAvailabilityOptions({this.calendar, this.fields, this.from, this.limit, this.to});

  final String? calendar;
  final String? fields;
  final String? from;
  final String? limit;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (calendar != null) {
      into["calendar"] = RaviJson.from(calendar);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (from != null) {
      into["from"] = RaviJson.from(from);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

class CalendarsAvailabilityReturn {
  const CalendarsAvailabilityReturn({required this.busy, required this.window});

  final List<RaviJson> busy;
  final RaviJson window;

  factory CalendarsAvailabilityReturn.fromJson(Map<String, Object?> json) {
    return CalendarsAvailabilityReturn(
      busy: raviJsonAsList(json["busy"], RaviJson.from),
      window: RaviJson.from(json["window"]),
    );
  }

  static CalendarsAvailabilityReturn fromJsonValue(Object? json) {
    return CalendarsAvailabilityReturn.fromJson(raviJsonObject(json, "CalendarsAvailabilityReturn"));
  }
}

CalendarsAvailabilityReturn calendarsAvailabilityReturnFromJson(Object? json) => CalendarsAvailabilityReturn.fromJsonValue(json);

class CalendarsCreateOptions {
  const CalendarsCreateOptions({this.account, this.color, this.default_, this.description, this.name, this.owner, this.providerCalendarId, this.role, this.timezone, this.visibility});

  final String? account;
  final String? color;
  final bool? default_;
  final String? description;
  final String? name;
  final String? owner;
  final String? providerCalendarId;
  final String? role;
  final String? timezone;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (color != null) {
      into["color"] = RaviJson.from(color);
    }
    if (default_ != null) {
      into["default"] = RaviJson.from(default_);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (providerCalendarId != null) {
      into["providerCalendarId"] = RaviJson.from(providerCalendarId);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
    if (timezone != null) {
      into["timezone"] = RaviJson.from(timezone);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class CalendarsCreateReturn {
  const CalendarsCreateReturn({required this.calendar});

  final RaviJson calendar;

  factory CalendarsCreateReturn.fromJson(Map<String, Object?> json) {
    return CalendarsCreateReturn(
      calendar: RaviJson.from(json["calendar"]),
    );
  }

  static CalendarsCreateReturn fromJsonValue(Object? json) {
    return CalendarsCreateReturn.fromJson(raviJsonObject(json, "CalendarsCreateReturn"));
  }
}

CalendarsCreateReturn calendarsCreateReturnFromJson(Object? json) => CalendarsCreateReturn.fromJsonValue(json);

class CalendarsDisableReturn {
  const CalendarsDisableReturn({required this.calendar});

  final RaviJson calendar;

  factory CalendarsDisableReturn.fromJson(Map<String, Object?> json) {
    return CalendarsDisableReturn(
      calendar: RaviJson.from(json["calendar"]),
    );
  }

  static CalendarsDisableReturn fromJsonValue(Object? json) {
    return CalendarsDisableReturn.fromJson(raviJsonObject(json, "CalendarsDisableReturn"));
  }
}

CalendarsDisableReturn calendarsDisableReturnFromJson(Object? json) => CalendarsDisableReturn.fromJsonValue(json);

class CalendarsEventsCancelOptions {
  const CalendarsEventsCancelOptions({this.execute, this.idempotencyKey});

  final bool? execute;
  final String? idempotencyKey;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
  }
}

class CalendarsEventsCancelReturn {
  const CalendarsEventsCancelReturn({required this.event, required this.outbox});

  final RaviJson event;
  final RaviJson outbox;

  factory CalendarsEventsCancelReturn.fromJson(Map<String, Object?> json) {
    return CalendarsEventsCancelReturn(
      event: RaviJson.from(json["event"]),
      outbox: RaviJson.from(json["outbox"]),
    );
  }

  static CalendarsEventsCancelReturn fromJsonValue(Object? json) {
    return CalendarsEventsCancelReturn.fromJson(raviJsonObject(json, "CalendarsEventsCancelReturn"));
  }
}

CalendarsEventsCancelReturn calendarsEventsCancelReturnFromJson(Object? json) => CalendarsEventsCancelReturn.fromJsonValue(json);

class CalendarsEventsCreateOptions {
  const CalendarsEventsCreateOptions({this.attendee, this.calendar, this.description, this.end, this.idempotencyKey, this.location, this.start, this.timezone, this.title});

  final String? attendee;
  final String? calendar;
  final String? description;
  final String? end;
  final String? idempotencyKey;
  final String? location;
  final String? start;
  final String? timezone;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (attendee != null) {
      into["attendee"] = RaviJson.from(attendee);
    }
    if (calendar != null) {
      into["calendar"] = RaviJson.from(calendar);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (end != null) {
      into["end"] = RaviJson.from(end);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (location != null) {
      into["location"] = RaviJson.from(location);
    }
    if (start != null) {
      into["start"] = RaviJson.from(start);
    }
    if (timezone != null) {
      into["timezone"] = RaviJson.from(timezone);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class CalendarsEventsCreateReturn {
  const CalendarsEventsCreateReturn({required this.event, required this.outbox});

  final RaviJson event;
  final RaviJson outbox;

  factory CalendarsEventsCreateReturn.fromJson(Map<String, Object?> json) {
    return CalendarsEventsCreateReturn(
      event: RaviJson.from(json["event"]),
      outbox: RaviJson.from(json["outbox"]),
    );
  }

  static CalendarsEventsCreateReturn fromJsonValue(Object? json) {
    return CalendarsEventsCreateReturn.fromJson(raviJsonObject(json, "CalendarsEventsCreateReturn"));
  }
}

CalendarsEventsCreateReturn calendarsEventsCreateReturnFromJson(Object? json) => CalendarsEventsCreateReturn.fromJsonValue(json);

class CalendarsEventsListOptions {
  const CalendarsEventsListOptions({this.calendar, this.fields, this.from, this.includeCancelled, this.limit, this.offset, this.query, this.status, this.to});

  final String? calendar;
  final String? fields;
  final String? from;
  final bool? includeCancelled;
  final String? limit;
  final String? offset;
  final String? query;
  final String? status;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (calendar != null) {
      into["calendar"] = RaviJson.from(calendar);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (from != null) {
      into["from"] = RaviJson.from(from);
    }
    if (includeCancelled != null) {
      into["includeCancelled"] = RaviJson.from(includeCancelled);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (query != null) {
      into["query"] = RaviJson.from(query);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

class CalendarsEventsListReturn {
  const CalendarsEventsListReturn({required this.events, required this.window});

  final List<RaviJson> events;
  final RaviJson window;

  factory CalendarsEventsListReturn.fromJson(Map<String, Object?> json) {
    return CalendarsEventsListReturn(
      events: raviJsonAsList(json["events"], RaviJson.from),
      window: RaviJson.from(json["window"]),
    );
  }

  static CalendarsEventsListReturn fromJsonValue(Object? json) {
    return CalendarsEventsListReturn.fromJson(raviJsonObject(json, "CalendarsEventsListReturn"));
  }
}

CalendarsEventsListReturn calendarsEventsListReturnFromJson(Object? json) => CalendarsEventsListReturn.fromJsonValue(json);

class CalendarsEventsReadReturn {
  const CalendarsEventsReadReturn({required this.event});

  final RaviJson event;

  factory CalendarsEventsReadReturn.fromJson(Map<String, Object?> json) {
    return CalendarsEventsReadReturn(
      event: RaviJson.from(json["event"]),
    );
  }

  static CalendarsEventsReadReturn fromJsonValue(Object? json) {
    return CalendarsEventsReadReturn.fromJson(raviJsonObject(json, "CalendarsEventsReadReturn"));
  }
}

CalendarsEventsReadReturn calendarsEventsReadReturnFromJson(Object? json) => CalendarsEventsReadReturn.fromJsonValue(json);

class CalendarsEventsRespondOptions {
  const CalendarsEventsRespondOptions({this.attendeeAgent, this.attendeeEmail, this.execute, this.idempotencyKey, this.status});

  final String? attendeeAgent;
  final String? attendeeEmail;
  final bool? execute;
  final String? idempotencyKey;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (attendeeAgent != null) {
      into["attendeeAgent"] = RaviJson.from(attendeeAgent);
    }
    if (attendeeEmail != null) {
      into["attendeeEmail"] = RaviJson.from(attendeeEmail);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class CalendarsEventsRespondReturn {
  const CalendarsEventsRespondReturn({required this.event, required this.outbox});

  final RaviJson event;
  final RaviJson outbox;

  factory CalendarsEventsRespondReturn.fromJson(Map<String, Object?> json) {
    return CalendarsEventsRespondReturn(
      event: RaviJson.from(json["event"]),
      outbox: RaviJson.from(json["outbox"]),
    );
  }

  static CalendarsEventsRespondReturn fromJsonValue(Object? json) {
    return CalendarsEventsRespondReturn.fromJson(raviJsonObject(json, "CalendarsEventsRespondReturn"));
  }
}

CalendarsEventsRespondReturn calendarsEventsRespondReturnFromJson(Object? json) => CalendarsEventsRespondReturn.fromJsonValue(json);

class CalendarsEventsUpdateOptions {
  const CalendarsEventsUpdateOptions({this.busy, this.description, this.end, this.idempotencyKey, this.location, this.start, this.status, this.title, this.visibility});

  final String? busy;
  final String? description;
  final String? end;
  final String? idempotencyKey;
  final String? location;
  final String? start;
  final String? status;
  final String? title;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (busy != null) {
      into["busy"] = RaviJson.from(busy);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (end != null) {
      into["end"] = RaviJson.from(end);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (location != null) {
      into["location"] = RaviJson.from(location);
    }
    if (start != null) {
      into["start"] = RaviJson.from(start);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class CalendarsEventsUpdateReturn {
  const CalendarsEventsUpdateReturn({required this.event, required this.outbox});

  final RaviJson event;
  final RaviJson outbox;

  factory CalendarsEventsUpdateReturn.fromJson(Map<String, Object?> json) {
    return CalendarsEventsUpdateReturn(
      event: RaviJson.from(json["event"]),
      outbox: RaviJson.from(json["outbox"]),
    );
  }

  static CalendarsEventsUpdateReturn fromJsonValue(Object? json) {
    return CalendarsEventsUpdateReturn.fromJson(raviJsonObject(json, "CalendarsEventsUpdateReturn"));
  }
}

CalendarsEventsUpdateReturn calendarsEventsUpdateReturnFromJson(Object? json) => CalendarsEventsUpdateReturn.fromJsonValue(json);

class CalendarsListOptions {
  const CalendarsListOptions({this.account, this.fields, this.limit, this.offset, this.status});

  final String? account;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class CalendarsListReturn {
  const CalendarsListReturn({required this.calendars});

  final List<RaviJson> calendars;

  factory CalendarsListReturn.fromJson(Map<String, Object?> json) {
    return CalendarsListReturn(
      calendars: raviJsonAsList(json["calendars"], RaviJson.from),
    );
  }

  static CalendarsListReturn fromJsonValue(Object? json) {
    return CalendarsListReturn.fromJson(raviJsonObject(json, "CalendarsListReturn"));
  }
}

CalendarsListReturn calendarsListReturnFromJson(Object? json) => CalendarsListReturn.fromJsonValue(json);

class CalendarsShareOptions {
  const CalendarsShareOptions({this.execute, this.expiresAt, this.relation, this.with_});

  final bool? execute;
  final String? expiresAt;
  final String? relation;
  final String? with_;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (expiresAt != null) {
      into["expiresAt"] = RaviJson.from(expiresAt);
    }
    if (relation != null) {
      into["relation"] = RaviJson.from(relation);
    }
    if (with_ != null) {
      into["with"] = RaviJson.from(with_);
    }
  }
}

class CalendarsShareReturn {
  const CalendarsShareReturn({required this.calendar, required this.member});

  final RaviJson calendar;
  final RaviJson member;

  factory CalendarsShareReturn.fromJson(Map<String, Object?> json) {
    return CalendarsShareReturn(
      calendar: RaviJson.from(json["calendar"]),
      member: RaviJson.from(json["member"]),
    );
  }

  static CalendarsShareReturn fromJsonValue(Object? json) {
    return CalendarsShareReturn.fromJson(raviJsonObject(json, "CalendarsShareReturn"));
  }
}

CalendarsShareReturn calendarsShareReturnFromJson(Object? json) => CalendarsShareReturn.fromJsonValue(json);

class CalendarsShowOptions {
  const CalendarsShowOptions({this.members});

  final bool? members;

  void encodeBody(Map<String, RaviJson> into) {
    if (members != null) {
      into["members"] = RaviJson.from(members);
    }
  }
}

class CalendarsShowReturn {
  const CalendarsShowReturn({required this.calendar, this.members});

  final RaviJson calendar;
  final List<RaviJson>? members;

  factory CalendarsShowReturn.fromJson(Map<String, Object?> json) {
    return CalendarsShowReturn(
      calendar: RaviJson.from(json["calendar"]),
      members: json["members"] == null ? null : raviJsonAsList(json["members"], RaviJson.from),
    );
  }

  static CalendarsShowReturn fromJsonValue(Object? json) {
    return CalendarsShowReturn.fromJson(raviJsonObject(json, "CalendarsShowReturn"));
  }
}

CalendarsShowReturn calendarsShowReturnFromJson(Object? json) => CalendarsShowReturn.fromJsonValue(json);

class ChannelsBackendIngressReturn {
  const ChannelsBackendIngressReturn({required this.acceptedAt, this.binding, required this.disposition, this.error, required this.protocol, required this.requestId, required this.schemaVersion});

  final String acceptedAt;
  final RaviJson? binding;
  final String disposition;
  final RaviJson? error;
  final String protocol;
  final String requestId;
  final int schemaVersion;

  factory ChannelsBackendIngressReturn.fromJson(Map<String, Object?> json) {
    return ChannelsBackendIngressReturn(
      acceptedAt: raviJsonAsString(json["acceptedAt"]),
      binding: json["binding"] == null ? null : RaviJson.from(json["binding"]),
      disposition: raviJsonAsString(json["disposition"]),
      error: json["error"] == null ? null : RaviJson.from(json["error"]),
      protocol: raviJsonAsString(json["protocol"]),
      requestId: raviJsonAsString(json["requestId"]),
      schemaVersion: raviJsonAsInt(json["schemaVersion"]),
    );
  }

  static ChannelsBackendIngressReturn fromJsonValue(Object? json) {
    return ChannelsBackendIngressReturn.fromJson(raviJsonObject(json, "ChannelsBackendIngressReturn"));
  }
}

ChannelsBackendIngressReturn channelsBackendIngressReturnFromJson(Object? json) => ChannelsBackendIngressReturn.fromJsonValue(json);

class ChannelsBackendRuntimeInterruptReturn {
  const ChannelsBackendRuntimeInterruptReturn({required this.acceptedAt, required this.disposition, this.error, required this.protocol, required this.requestId, required this.schemaVersion});

  final String acceptedAt;
  final String disposition;
  final RaviJson? error;
  final String protocol;
  final String requestId;
  final int schemaVersion;

  factory ChannelsBackendRuntimeInterruptReturn.fromJson(Map<String, Object?> json) {
    return ChannelsBackendRuntimeInterruptReturn(
      acceptedAt: raviJsonAsString(json["acceptedAt"]),
      disposition: raviJsonAsString(json["disposition"]),
      error: json["error"] == null ? null : RaviJson.from(json["error"]),
      protocol: raviJsonAsString(json["protocol"]),
      requestId: raviJsonAsString(json["requestId"]),
      schemaVersion: raviJsonAsInt(json["schemaVersion"]),
    );
  }

  static ChannelsBackendRuntimeInterruptReturn fromJsonValue(Object? json) {
    return ChannelsBackendRuntimeInterruptReturn.fromJson(raviJsonObject(json, "ChannelsBackendRuntimeInterruptReturn"));
  }
}

ChannelsBackendRuntimeInterruptReturn channelsBackendRuntimeInterruptReturnFromJson(Object? json) => ChannelsBackendRuntimeInterruptReturn.fromJsonValue(json);

class ChannelsBackendRuntimeReadbackReturn {
  const ChannelsBackendRuntimeReadbackReturn({this.assistantMessageId, required this.binding, this.lastEventRuntimeGenerationId, required this.lastSequence, required this.observedAt, required this.protocol, required this.requestId, this.runtimeGenerationId, required this.schemaVersion, required this.state, this.terminalEvent});

  final String? assistantMessageId;
  final RaviJson binding;
  final String? lastEventRuntimeGenerationId;
  final int lastSequence;
  final String observedAt;
  final String protocol;
  final String requestId;
  final String? runtimeGenerationId;
  final int schemaVersion;
  final String state;
  final RaviJson? terminalEvent;

  factory ChannelsBackendRuntimeReadbackReturn.fromJson(Map<String, Object?> json) {
    return ChannelsBackendRuntimeReadbackReturn(
      assistantMessageId: json["assistantMessageId"] == null ? null : raviJsonAsString(json["assistantMessageId"]),
      binding: RaviJson.from(json["binding"]),
      lastEventRuntimeGenerationId: json["lastEventRuntimeGenerationId"] == null ? null : raviJsonAsString(json["lastEventRuntimeGenerationId"]),
      lastSequence: raviJsonAsInt(json["lastSequence"]),
      observedAt: raviJsonAsString(json["observedAt"]),
      protocol: raviJsonAsString(json["protocol"]),
      requestId: raviJsonAsString(json["requestId"]),
      runtimeGenerationId: json["runtimeGenerationId"] == null ? null : raviJsonAsString(json["runtimeGenerationId"]),
      schemaVersion: raviJsonAsInt(json["schemaVersion"]),
      state: raviJsonAsString(json["state"]),
      terminalEvent: json["terminalEvent"] == null ? null : RaviJson.from(json["terminalEvent"]),
    );
  }

  static ChannelsBackendRuntimeReadbackReturn fromJsonValue(Object? json) {
    return ChannelsBackendRuntimeReadbackReturn.fromJson(raviJsonObject(json, "ChannelsBackendRuntimeReadbackReturn"));
  }
}

ChannelsBackendRuntimeReadbackReturn channelsBackendRuntimeReadbackReturnFromJson(Object? json) => ChannelsBackendRuntimeReadbackReturn.fromJsonValue(json);

class ChannelsCreateOptions {
  const ChannelsCreateOptions({this.credentialConnection, this.provider});

  final String? credentialConnection;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (credentialConnection != null) {
      into["credentialConnection"] = RaviJson.from(credentialConnection);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class ChannelsCreateReturn {
  const ChannelsCreateReturn({required this.changedCount, required this.channel, required this.status});

  final double changedCount;
  final RaviJson channel;
  final String status;

  factory ChannelsCreateReturn.fromJson(Map<String, Object?> json) {
    return ChannelsCreateReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      channel: RaviJson.from(json["channel"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static ChannelsCreateReturn fromJsonValue(Object? json) {
    return ChannelsCreateReturn.fromJson(raviJsonObject(json, "ChannelsCreateReturn"));
  }
}

ChannelsCreateReturn channelsCreateReturnFromJson(Object? json) => ChannelsCreateReturn.fromJsonValue(json);

class ChannelsListOptions {
  const ChannelsListOptions({this.fields, this.limit, this.offset, this.provider});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class ChannelsListReturn {
  const ChannelsListReturn({required this.channels, required this.items, required this.pagination, required this.total});

  final List<RaviJson> channels;
  final List<RaviJson> items;
  final RaviJson pagination;
  final double total;

  factory ChannelsListReturn.fromJson(Map<String, Object?> json) {
    return ChannelsListReturn(
      channels: raviJsonAsList(json["channels"], RaviJson.from),
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ChannelsListReturn fromJsonValue(Object? json) {
    return ChannelsListReturn.fromJson(raviJsonObject(json, "ChannelsListReturn"));
  }
}

ChannelsListReturn channelsListReturnFromJson(Object? json) => ChannelsListReturn.fromJsonValue(json);

class ChannelsProbeReturn {
  const ChannelsProbeReturn({required this.adapters, required this.outbound, required this.pid, required this.running, required this.startedAt});

  final List<Map<String, RaviJson>> adapters;
  final Map<String, RaviJson> outbound;
  final double pid;
  final bool running;
  final RaviJson startedAt;

  factory ChannelsProbeReturn.fromJson(Map<String, Object?> json) {
    return ChannelsProbeReturn(
      adapters: raviJsonAsList(json["adapters"], raviJsonAsRaviJsonMap),
      outbound: raviJsonAsRaviJsonMap(json["outbound"]),
      pid: raviJsonAsDouble(json["pid"]),
      running: raviJsonAsBool(json["running"]),
      startedAt: RaviJson.from(json["startedAt"]),
    );
  }

  static ChannelsProbeReturn fromJsonValue(Object? json) {
    return ChannelsProbeReturn.fromJson(raviJsonObject(json, "ChannelsProbeReturn"));
  }
}

ChannelsProbeReturn channelsProbeReturnFromJson(Object? json) => ChannelsProbeReturn.fromJsonValue(json);

class ChannelsRestartOptions {
  const ChannelsRestartOptions({this.build});

  final bool? build;

  void encodeBody(Map<String, RaviJson> into) {
    if (build != null) {
      into["build"] = RaviJson.from(build);
    }
  }
}

class ChannelsRestartReturn {
  const ChannelsRestartReturn({required this.action, required this.changed, this.pm2Status, this.reason, this.runnerEnv, this.status, this.target});

  final String action;
  final bool changed;
  final RaviJson? pm2Status;
  final String? reason;
  final RaviJson? runnerEnv;
  final RaviJson? status;
  final RaviJson? target;

  factory ChannelsRestartReturn.fromJson(Map<String, Object?> json) {
    return ChannelsRestartReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
      pm2Status: json["pm2Status"] == null ? null : RaviJson.from(json["pm2Status"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      runnerEnv: json["runnerEnv"] == null ? null : RaviJson.from(json["runnerEnv"]),
      status: json["status"] == null ? null : RaviJson.from(json["status"]),
      target: json["target"] == null ? null : RaviJson.from(json["target"]),
    );
  }

  static ChannelsRestartReturn fromJsonValue(Object? json) {
    return ChannelsRestartReturn.fromJson(raviJsonObject(json, "ChannelsRestartReturn"));
  }
}

ChannelsRestartReturn channelsRestartReturnFromJson(Object? json) => ChannelsRestartReturn.fromJsonValue(json);

class ChannelsSetReturn {
  const ChannelsSetReturn({required this.changedCount, required this.channel, required this.status});

  final double changedCount;
  final RaviJson channel;
  final String status;

  factory ChannelsSetReturn.fromJson(Map<String, Object?> json) {
    return ChannelsSetReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      channel: RaviJson.from(json["channel"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static ChannelsSetReturn fromJsonValue(Object? json) {
    return ChannelsSetReturn.fromJson(raviJsonObject(json, "ChannelsSetReturn"));
  }
}

ChannelsSetReturn channelsSetReturnFromJson(Object? json) => ChannelsSetReturn.fromJsonValue(json);

class ChannelsShowReturn {
  const ChannelsShowReturn({required this.createdAt, this.credentialConnection, this.defaults, this.deletedAt, this.enabled, required this.name, required this.provider, required this.updatedAt});

  final double createdAt;
  final String? credentialConnection;
  final Map<String, RaviJson>? defaults;
  final double? deletedAt;
  final bool? enabled;
  final String name;
  final String provider;
  final double updatedAt;

  factory ChannelsShowReturn.fromJson(Map<String, Object?> json) {
    return ChannelsShowReturn(
      createdAt: raviJsonAsDouble(json["createdAt"]),
      credentialConnection: json["credentialConnection"] == null ? null : raviJsonAsString(json["credentialConnection"]),
      defaults: json["defaults"] == null ? null : raviJsonAsRaviJsonMap(json["defaults"]),
      deletedAt: json["deletedAt"] == null ? null : raviJsonAsDouble(json["deletedAt"]),
      enabled: json["enabled"] == null ? null : raviJsonAsBool(json["enabled"]),
      name: raviJsonAsString(json["name"]),
      provider: raviJsonAsString(json["provider"]),
      updatedAt: raviJsonAsDouble(json["updatedAt"]),
    );
  }

  static ChannelsShowReturn fromJsonValue(Object? json) {
    return ChannelsShowReturn.fromJson(raviJsonObject(json, "ChannelsShowReturn"));
  }
}

ChannelsShowReturn channelsShowReturnFromJson(Object? json) => ChannelsShowReturn.fromJsonValue(json);

class ChannelsStartOptions {
  const ChannelsStartOptions({this.build});

  final bool? build;

  void encodeBody(Map<String, RaviJson> into) {
    if (build != null) {
      into["build"] = RaviJson.from(build);
    }
  }
}

class ChannelsStartReturn {
  const ChannelsStartReturn({required this.action, required this.changed, this.pm2Status, this.reason, this.runnerEnv, this.status, this.target});

  final String action;
  final bool changed;
  final RaviJson? pm2Status;
  final String? reason;
  final RaviJson? runnerEnv;
  final RaviJson? status;
  final RaviJson? target;

  factory ChannelsStartReturn.fromJson(Map<String, Object?> json) {
    return ChannelsStartReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
      pm2Status: json["pm2Status"] == null ? null : RaviJson.from(json["pm2Status"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      runnerEnv: json["runnerEnv"] == null ? null : RaviJson.from(json["runnerEnv"]),
      status: json["status"] == null ? null : RaviJson.from(json["status"]),
      target: json["target"] == null ? null : RaviJson.from(json["target"]),
    );
  }

  static ChannelsStartReturn fromJsonValue(Object? json) {
    return ChannelsStartReturn.fromJson(raviJsonObject(json, "ChannelsStartReturn"));
  }
}

ChannelsStartReturn channelsStartReturnFromJson(Object? json) => ChannelsStartReturn.fromJsonValue(json);

class ChannelsStatusReturn {
  const ChannelsStatusReturn({required this.channels, this.health, required this.pm2Available, required this.processName, required this.processes, this.runner});

  final RaviJson channels;
  final RaviJson? health;
  final bool pm2Available;
  final String processName;
  final List<RaviJson> processes;
  final RaviJson? runner;

  factory ChannelsStatusReturn.fromJson(Map<String, Object?> json) {
    return ChannelsStatusReturn(
      channels: RaviJson.from(json["channels"]),
      health: json["health"] == null ? null : RaviJson.from(json["health"]),
      pm2Available: raviJsonAsBool(json["pm2Available"]),
      processName: raviJsonAsString(json["processName"]),
      processes: raviJsonAsList(json["processes"], RaviJson.from),
      runner: json["runner"] == null ? null : RaviJson.from(json["runner"]),
    );
  }

  static ChannelsStatusReturn fromJsonValue(Object? json) {
    return ChannelsStatusReturn.fromJson(raviJsonObject(json, "ChannelsStatusReturn"));
  }
}

ChannelsStatusReturn channelsStatusReturnFromJson(Object? json) => ChannelsStatusReturn.fromJsonValue(json);

class ChannelsStopReturn {
  const ChannelsStopReturn({required this.action, required this.changed, this.pm2Status, this.reason, this.runnerEnv, this.status, this.target});

  final String action;
  final bool changed;
  final RaviJson? pm2Status;
  final String? reason;
  final RaviJson? runnerEnv;
  final RaviJson? status;
  final RaviJson? target;

  factory ChannelsStopReturn.fromJson(Map<String, Object?> json) {
    return ChannelsStopReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
      pm2Status: json["pm2Status"] == null ? null : RaviJson.from(json["pm2Status"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      runnerEnv: json["runnerEnv"] == null ? null : RaviJson.from(json["runnerEnv"]),
      status: json["status"] == null ? null : RaviJson.from(json["status"]),
      target: json["target"] == null ? null : RaviJson.from(json["target"]),
    );
  }

  static ChannelsStopReturn fromJsonValue(Object? json) {
    return ChannelsStopReturn.fromJson(raviJsonObject(json, "ChannelsStopReturn"));
  }
}

ChannelsStopReturn channelsStopReturnFromJson(Object? json) => ChannelsStopReturn.fromJsonValue(json);

class ChatsBackfillProviderTimestampsOptions {
  const ChatsBackfillProviderTimestampsOptions({this.apply, this.dryRun, this.limit});

  final bool? apply;
  final bool? dryRun;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (apply != null) {
      into["apply"] = RaviJson.from(apply);
    }
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

typedef ChatsBackfillProviderTimestampsReturn = Map<String, RaviJson>;

ChatsBackfillProviderTimestampsReturn chatsBackfillProviderTimestampsReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ChatsEnsureReturn {
  const ChatsEnsureReturn({required this.chat, required this.clientRequestId, required this.disposition});

  final RaviJson chat;
  final String clientRequestId;
  final String disposition;

  factory ChatsEnsureReturn.fromJson(Map<String, Object?> json) {
    return ChatsEnsureReturn(
      chat: RaviJson.from(json["chat"]),
      clientRequestId: raviJsonAsString(json["clientRequestId"]),
      disposition: raviJsonAsString(json["disposition"]),
    );
  }

  static ChatsEnsureReturn fromJsonValue(Object? json) {
    return ChatsEnsureReturn.fromJson(raviJsonObject(json, "ChatsEnsureReturn"));
  }
}

ChatsEnsureReturn chatsEnsureReturnFromJson(Object? json) => ChatsEnsureReturn.fromJsonValue(json);

class ChatsListOptions {
  const ChatsListOptions({this.agent, this.channel, this.contact, this.fields, this.includeRaw, this.instance, this.limit, this.offset, this.query, this.type});

  final String? agent;
  final String? channel;
  final String? contact;
  final String? fields;
  final bool? includeRaw;
  final String? instance;
  final String? limit;
  final String? offset;
  final String? query;
  final String? type;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (includeRaw != null) {
      into["includeRaw"] = RaviJson.from(includeRaw);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (query != null) {
      into["query"] = RaviJson.from(query);
    }
    if (type != null) {
      into["type"] = RaviJson.from(type);
    }
  }
}

class ChatsListReturn {
  const ChatsListReturn({required this.chats, required this.items, required this.pagination, required this.total});

  final List<RaviJson> chats;
  final List<RaviJson> items;
  final RaviJson pagination;
  final double total;

  factory ChatsListReturn.fromJson(Map<String, Object?> json) {
    return ChatsListReturn(
      chats: raviJsonAsList(json["chats"], RaviJson.from),
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ChatsListReturn fromJsonValue(Object? json) {
    return ChatsListReturn.fromJson(raviJsonObject(json, "ChatsListReturn"));
  }
}

ChatsListReturn chatsListReturnFromJson(Object? json) => ChatsListReturn.fromJsonValue(json);

class ChatsListsAddOptions {
  const ChatsListsAddOptions({this.channel, this.includeRaw, this.instance, this.owner, this.priority, this.reason});

  final String? channel;
  final bool? includeRaw;
  final String? instance;
  final String? owner;
  final String? priority;
  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (includeRaw != null) {
      into["includeRaw"] = RaviJson.from(includeRaw);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

typedef ChatsListsAddReturn = Map<String, RaviJson>;

ChatsListsAddReturn chatsListsAddReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ChatsListsCreateOptions {
  const ChatsListsCreateOptions({this.description, this.mode, this.owner, this.visibility});

  final String? description;
  final String? mode;
  final String? owner;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (mode != null) {
      into["mode"] = RaviJson.from(mode);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

typedef ChatsListsCreateReturn = Map<String, RaviJson>;

ChatsListsCreateReturn chatsListsCreateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ChatsListsDeltaOptions {
  const ChatsListsDeltaOptions({this.channel, this.includeRaw, this.instance, this.limit, this.markRead, this.owner, this.reader});

  final String? channel;
  final bool? includeRaw;
  final String? instance;
  final String? limit;
  final bool? markRead;
  final String? owner;
  final String? reader;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (includeRaw != null) {
      into["includeRaw"] = RaviJson.from(includeRaw);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (markRead != null) {
      into["markRead"] = RaviJson.from(markRead);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (reader != null) {
      into["reader"] = RaviJson.from(reader);
    }
  }
}

typedef ChatsListsDeltaReturn = Map<String, RaviJson>;

ChatsListsDeltaReturn chatsListsDeltaReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ChatsListsListOptions {
  const ChatsListsListOptions({this.fields, this.includeArchived, this.limit, this.offset, this.owner});

  final String? fields;
  final bool? includeArchived;
  final String? limit;
  final String? offset;
  final String? owner;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (includeArchived != null) {
      into["includeArchived"] = RaviJson.from(includeArchived);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
  }
}

typedef ChatsListsListReturn = Map<String, RaviJson>;

ChatsListsListReturn chatsListsListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ChatsListsMarkReadOptions {
  const ChatsListsMarkReadOptions({this.channel, this.includeRaw, this.instance, this.message, this.owner, this.reader, this.reason});

  final String? channel;
  final bool? includeRaw;
  final String? instance;
  final String? message;
  final String? owner;
  final String? reader;
  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (includeRaw != null) {
      into["includeRaw"] = RaviJson.from(includeRaw);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (reader != null) {
      into["reader"] = RaviJson.from(reader);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

typedef ChatsListsMarkReadReturn = Map<String, RaviJson>;

ChatsListsMarkReadReturn chatsListsMarkReadReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ChatsListsMembersOptions {
  const ChatsListsMembersOptions({this.fields, this.includeRaw, this.limit, this.offset, this.owner, this.reader});

  final String? fields;
  final bool? includeRaw;
  final String? limit;
  final String? offset;
  final String? owner;
  final String? reader;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (includeRaw != null) {
      into["includeRaw"] = RaviJson.from(includeRaw);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (reader != null) {
      into["reader"] = RaviJson.from(reader);
    }
  }
}

typedef ChatsListsMembersReturn = Map<String, RaviJson>;

ChatsListsMembersReturn chatsListsMembersReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ChatsListsPreviewOptions {
  const ChatsListsPreviewOptions({this.owner});

  final String? owner;

  void encodeBody(Map<String, RaviJson> into) {
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
  }
}

class ChatsListsPreviewReturn {
  const ChatsListsPreviewReturn({required this.list, required this.preview});

  final RaviJson list;
  final RaviJson preview;

  factory ChatsListsPreviewReturn.fromJson(Map<String, Object?> json) {
    return ChatsListsPreviewReturn(
      list: RaviJson.from(json["list"]),
      preview: RaviJson.from(json["preview"]),
    );
  }

  static ChatsListsPreviewReturn fromJsonValue(Object? json) {
    return ChatsListsPreviewReturn.fromJson(raviJsonObject(json, "ChatsListsPreviewReturn"));
  }
}

ChatsListsPreviewReturn chatsListsPreviewReturnFromJson(Object? json) => ChatsListsPreviewReturn.fromJsonValue(json);

class ChatsListsRecomputeOptions {
  const ChatsListsRecomputeOptions({this.owner});

  final String? owner;

  void encodeBody(Map<String, RaviJson> into) {
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
  }
}

class ChatsListsRecomputeReturn {
  const ChatsListsRecomputeReturn({required this.list, required this.recompute});

  final RaviJson list;
  final RaviJson recompute;

  factory ChatsListsRecomputeReturn.fromJson(Map<String, Object?> json) {
    return ChatsListsRecomputeReturn(
      list: RaviJson.from(json["list"]),
      recompute: RaviJson.from(json["recompute"]),
    );
  }

  static ChatsListsRecomputeReturn fromJsonValue(Object? json) {
    return ChatsListsRecomputeReturn.fromJson(raviJsonObject(json, "ChatsListsRecomputeReturn"));
  }
}

ChatsListsRecomputeReturn chatsListsRecomputeReturnFromJson(Object? json) => ChatsListsRecomputeReturn.fromJsonValue(json);

class ChatsListsRemoveOptions {
  const ChatsListsRemoveOptions({this.channel, this.instance, this.owner});

  final String? channel;
  final String? instance;
  final String? owner;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
  }
}

typedef ChatsListsRemoveReturn = Map<String, RaviJson>;

ChatsListsRemoveReturn chatsListsRemoveReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ChatsListsShowOptions {
  const ChatsListsShowOptions({this.owner});

  final String? owner;

  void encodeBody(Map<String, RaviJson> into) {
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
  }
}

class ChatsListsShowReturn {
  const ChatsListsShowReturn({required this.current, required this.list, required this.validation});

  final RaviJson current;
  final RaviJson list;
  final RaviJson validation;

  factory ChatsListsShowReturn.fromJson(Map<String, Object?> json) {
    return ChatsListsShowReturn(
      current: RaviJson.from(json["current"]),
      list: RaviJson.from(json["list"]),
      validation: RaviJson.from(json["validation"]),
    );
  }

  static ChatsListsShowReturn fromJsonValue(Object? json) {
    return ChatsListsShowReturn.fromJson(raviJsonObject(json, "ChatsListsShowReturn"));
  }
}

ChatsListsShowReturn chatsListsShowReturnFromJson(Object? json) => ChatsListsShowReturn.fromJsonValue(json);

class ChatsMessagesCreateReturn {
  const ChatsMessagesCreateReturn({required this.clientMessageId, required this.disposition, required this.message, required this.messageId});

  final String clientMessageId;
  final String disposition;
  final RaviJson message;
  final String messageId;

  factory ChatsMessagesCreateReturn.fromJson(Map<String, Object?> json) {
    return ChatsMessagesCreateReturn(
      clientMessageId: raviJsonAsString(json["clientMessageId"]),
      disposition: raviJsonAsString(json["disposition"]),
      message: RaviJson.from(json["message"]),
      messageId: raviJsonAsString(json["messageId"]),
    );
  }

  static ChatsMessagesCreateReturn fromJsonValue(Object? json) {
    return ChatsMessagesCreateReturn.fromJson(raviJsonObject(json, "ChatsMessagesCreateReturn"));
  }
}

ChatsMessagesCreateReturn chatsMessagesCreateReturnFromJson(Object? json) => ChatsMessagesCreateReturn.fromJsonValue(json);

class ChatsReadOptions {
  const ChatsReadOptions({this.channel, this.includeRaw, this.instance, this.limit, this.offset, this.order, this.type});

  final String? channel;
  final bool? includeRaw;
  final String? instance;
  final String? limit;
  final String? offset;
  final String? order;
  final String? type;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (includeRaw != null) {
      into["includeRaw"] = RaviJson.from(includeRaw);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (order != null) {
      into["order"] = RaviJson.from(order);
    }
    if (type != null) {
      into["type"] = RaviJson.from(type);
    }
  }
}

class ChatsReadReturn {
  const ChatsReadReturn({required this.chat, required this.messages, required this.pagination, required this.total});

  final RaviJson chat;
  final List<RaviJson> messages;
  final RaviJson pagination;
  final double total;

  factory ChatsReadReturn.fromJson(Map<String, Object?> json) {
    return ChatsReadReturn(
      chat: RaviJson.from(json["chat"]),
      messages: raviJsonAsList(json["messages"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ChatsReadReturn fromJsonValue(Object? json) {
    return ChatsReadReturn.fromJson(raviJsonObject(json, "ChatsReadReturn"));
  }
}

ChatsReadReturn chatsReadReturnFromJson(Object? json) => ChatsReadReturn.fromJsonValue(json);

class CloudProjectsCreateOptions {
  const CloudProjectsCreateOptions({this.console, this.defaultPageSite, this.description, this.execute, this.name, this.visibility});

  final String? console;
  final String? defaultPageSite;
  final String? description;
  final bool? execute;
  final String? name;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (defaultPageSite != null) {
      into["defaultPageSite"] = RaviJson.from(defaultPageSite);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class CloudProjectsCreateReturn {
  const CloudProjectsCreateReturn({required this.consoleUrl, required this.project, required this.redirectTo, required this.success});

  final String consoleUrl;
  final Map<String, RaviJson> project;
  final RaviJson redirectTo;
  final bool success;

  factory CloudProjectsCreateReturn.fromJson(Map<String, Object?> json) {
    return CloudProjectsCreateReturn(
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      project: raviJsonAsRaviJsonMap(json["project"]),
      redirectTo: RaviJson.from(json["redirectTo"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static CloudProjectsCreateReturn fromJsonValue(Object? json) {
    return CloudProjectsCreateReturn.fromJson(raviJsonObject(json, "CloudProjectsCreateReturn"));
  }
}

CloudProjectsCreateReturn cloudProjectsCreateReturnFromJson(Object? json) => CloudProjectsCreateReturn.fromJsonValue(json);

class CloudProjectsListOptions {
  const CloudProjectsListOptions({this.console, this.fields, this.limit, this.offset});

  final String? console;
  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class CloudProjectsListReturn {
  const CloudProjectsListReturn({required this.consoleUrl, required this.items, required this.pagination, required this.projects, required this.success, required this.total});

  final String consoleUrl;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> projects;
  final bool success;
  final double total;

  factory CloudProjectsListReturn.fromJson(Map<String, Object?> json) {
    return CloudProjectsListReturn(
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      projects: raviJsonAsList(json["projects"], raviJsonAsRaviJsonMap),
      success: raviJsonAsBool(json["success"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CloudProjectsListReturn fromJsonValue(Object? json) {
    return CloudProjectsListReturn.fromJson(raviJsonObject(json, "CloudProjectsListReturn"));
  }
}

CloudProjectsListReturn cloudProjectsListReturnFromJson(Object? json) => CloudProjectsListReturn.fromJsonValue(json);

class CloudScopeClearOptions {
  const CloudScopeClearOptions({this.agent, this.console, this.global, this.session, this.workspace});

  final String? agent;
  final String? console;
  final bool? global;
  final String? session;
  final String? workspace;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (global != null) {
      into["global"] = RaviJson.from(global);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (workspace != null) {
      into["workspace"] = RaviJson.from(workspace);
    }
  }
}

class CloudScopeClearReturn {
  const CloudScopeClearReturn({required this.action, required this.cleared, required this.success, required this.target});

  final String action;
  final bool cleared;
  final bool success;
  final RaviJson target;

  factory CloudScopeClearReturn.fromJson(Map<String, Object?> json) {
    return CloudScopeClearReturn(
      action: raviJsonAsString(json["action"]),
      cleared: raviJsonAsBool(json["cleared"]),
      success: raviJsonAsBool(json["success"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static CloudScopeClearReturn fromJsonValue(Object? json) {
    return CloudScopeClearReturn.fromJson(raviJsonObject(json, "CloudScopeClearReturn"));
  }
}

CloudScopeClearReturn cloudScopeClearReturnFromJson(Object? json) => CloudScopeClearReturn.fromJsonValue(json);

class CloudScopeExplainOptions {
  const CloudScopeExplainOptions({this.console, this.project});

  final String? console;
  final String? project;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
  }
}

class CloudScopeExplainReturn {
  const CloudScopeExplainReturn({required this.candidates, required this.consoleUrl, this.missingProjectCommand, this.organization, required this.resolved, required this.success});

  final List<RaviJson> candidates;
  final String consoleUrl;
  final RaviJson? missingProjectCommand;
  final RaviJson? organization;
  final RaviJson resolved;
  final bool success;

  factory CloudScopeExplainReturn.fromJson(Map<String, Object?> json) {
    return CloudScopeExplainReturn(
      candidates: raviJsonAsList(json["candidates"], RaviJson.from),
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      missingProjectCommand: json["missingProjectCommand"] == null ? null : RaviJson.from(json["missingProjectCommand"]),
      organization: json["organization"] == null ? null : RaviJson.from(json["organization"]),
      resolved: RaviJson.from(json["resolved"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static CloudScopeExplainReturn fromJsonValue(Object? json) {
    return CloudScopeExplainReturn.fromJson(raviJsonObject(json, "CloudScopeExplainReturn"));
  }
}

CloudScopeExplainReturn cloudScopeExplainReturnFromJson(Object? json) => CloudScopeExplainReturn.fromJsonValue(json);

class CloudScopeSetOptions {
  const CloudScopeSetOptions({this.agent, this.console, this.global, this.project, this.session, this.workspace});

  final String? agent;
  final String? console;
  final bool? global;
  final String? project;
  final String? session;
  final String? workspace;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (global != null) {
      into["global"] = RaviJson.from(global);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (workspace != null) {
      into["workspace"] = RaviJson.from(workspace);
    }
  }
}

class CloudScopeSetReturn {
  const CloudScopeSetReturn({required this.action, required this.scope, required this.success, required this.target});

  final String action;
  final RaviJson scope;
  final bool success;
  final RaviJson target;

  factory CloudScopeSetReturn.fromJson(Map<String, Object?> json) {
    return CloudScopeSetReturn(
      action: raviJsonAsString(json["action"]),
      scope: RaviJson.from(json["scope"]),
      success: raviJsonAsBool(json["success"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static CloudScopeSetReturn fromJsonValue(Object? json) {
    return CloudScopeSetReturn.fromJson(raviJsonObject(json, "CloudScopeSetReturn"));
  }
}

CloudScopeSetReturn cloudScopeSetReturnFromJson(Object? json) => CloudScopeSetReturn.fromJsonValue(json);

class CloudScopeShowOptions {
  const CloudScopeShowOptions({this.console});

  final String? console;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
  }
}

class CloudScopeShowReturn {
  const CloudScopeShowReturn({required this.scope, required this.success});

  final RaviJson scope;
  final bool success;

  factory CloudScopeShowReturn.fromJson(Map<String, Object?> json) {
    return CloudScopeShowReturn(
      scope: RaviJson.from(json["scope"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static CloudScopeShowReturn fromJsonValue(Object? json) {
    return CloudScopeShowReturn.fromJson(raviJsonObject(json, "CloudScopeShowReturn"));
  }
}

CloudScopeShowReturn cloudScopeShowReturnFromJson(Object? json) => CloudScopeShowReturn.fromJsonValue(json);

class CommandsListOptions {
  const CommandsListOptions({this.agent, this.fields, this.limit, this.offset, this.tag});

  final String? agent;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class CommandsListReturn {
  const CommandsListReturn({required this.agent, required this.commands, required this.issues, required this.items, required this.locations, required this.pagination, required this.total});

  final Map<String, RaviJson> agent;
  final List<RaviJson> commands;
  final List<RaviJson> issues;
  final List<Map<String, RaviJson>> items;
  final Map<String, RaviJson> locations;
  final RaviJson pagination;
  final double total;

  factory CommandsListReturn.fromJson(Map<String, Object?> json) {
    return CommandsListReturn(
      agent: raviJsonAsRaviJsonMap(json["agent"]),
      commands: raviJsonAsList(json["commands"], RaviJson.from),
      issues: raviJsonAsList(json["issues"], RaviJson.from),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      locations: raviJsonAsRaviJsonMap(json["locations"]),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CommandsListReturn fromJsonValue(Object? json) {
    return CommandsListReturn.fromJson(raviJsonObject(json, "CommandsListReturn"));
  }
}

CommandsListReturn commandsListReturnFromJson(Object? json) => CommandsListReturn.fromJsonValue(json);

class CommandsRunOptions {
  const CommandsRunOptions({this.agent});

  final String? agent;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
  }
}

class CommandsRunReturn {
  const CommandsRunReturn({required this.agent, required this.command, required this.metadata, required this.positionalArguments, required this.prompt});

  final Map<String, RaviJson> agent;
  final RaviJson command;
  final Map<String, RaviJson> metadata;
  final List<RaviJson> positionalArguments;
  final String prompt;

  factory CommandsRunReturn.fromJson(Map<String, Object?> json) {
    return CommandsRunReturn(
      agent: raviJsonAsRaviJsonMap(json["agent"]),
      command: RaviJson.from(json["command"]),
      metadata: raviJsonAsRaviJsonMap(json["metadata"]),
      positionalArguments: raviJsonAsList(json["positionalArguments"], RaviJson.from),
      prompt: raviJsonAsString(json["prompt"]),
    );
  }

  static CommandsRunReturn fromJsonValue(Object? json) {
    return CommandsRunReturn.fromJson(raviJsonObject(json, "CommandsRunReturn"));
  }
}

CommandsRunReturn commandsRunReturnFromJson(Object? json) => CommandsRunReturn.fromJsonValue(json);

class CommandsShowOptions {
  const CommandsShowOptions({this.agent});

  final String? agent;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
  }
}

class CommandsShowReturn {
  const CommandsShowReturn({required this.agent, required this.command});

  final Map<String, RaviJson> agent;
  final RaviJson command;

  factory CommandsShowReturn.fromJson(Map<String, Object?> json) {
    return CommandsShowReturn(
      agent: raviJsonAsRaviJsonMap(json["agent"]),
      command: RaviJson.from(json["command"]),
    );
  }

  static CommandsShowReturn fromJsonValue(Object? json) {
    return CommandsShowReturn.fromJson(raviJsonObject(json, "CommandsShowReturn"));
  }
}

CommandsShowReturn commandsShowReturnFromJson(Object? json) => CommandsShowReturn.fromJsonValue(json);

class CommandsValidateOptions {
  const CommandsValidateOptions({this.agent});

  final String? agent;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
  }
}

class CommandsValidateReturn {
  const CommandsValidateReturn({required this.agent, required this.effectiveTotal, required this.errors, required this.total, required this.valid, required this.warnings});

  final Map<String, RaviJson> agent;
  final double effectiveTotal;
  final List<RaviJson> errors;
  final double total;
  final bool valid;
  final List<RaviJson> warnings;

  factory CommandsValidateReturn.fromJson(Map<String, Object?> json) {
    return CommandsValidateReturn(
      agent: raviJsonAsRaviJsonMap(json["agent"]),
      effectiveTotal: raviJsonAsDouble(json["effectiveTotal"]),
      errors: raviJsonAsList(json["errors"], RaviJson.from),
      total: raviJsonAsDouble(json["total"]),
      valid: raviJsonAsBool(json["valid"]),
      warnings: raviJsonAsList(json["warnings"], RaviJson.from),
    );
  }

  static CommandsValidateReturn fromJsonValue(Object? json) {
    return CommandsValidateReturn.fromJson(raviJsonObject(json, "CommandsValidateReturn"));
  }
}

CommandsValidateReturn commandsValidateReturnFromJson(Object? json) => CommandsValidateReturn.fromJsonValue(json);

class ConnectorsListOptions {
  const ConnectorsListOptions({this.fields, this.limit, this.offset, this.project, this.provider});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? project;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class ConnectorsListReturn {
  const ConnectorsListReturn({required this.connections, required this.pagination});

  final List<RaviJson> connections;
  final RaviJson pagination;

  factory ConnectorsListReturn.fromJson(Map<String, Object?> json) {
    return ConnectorsListReturn(
      connections: raviJsonAsList(json["connections"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
    );
  }

  static ConnectorsListReturn fromJsonValue(Object? json) {
    return ConnectorsListReturn.fromJson(raviJsonObject(json, "ConnectorsListReturn"));
  }
}

ConnectorsListReturn connectorsListReturnFromJson(Object? json) => ConnectorsListReturn.fromJsonValue(json);

class ConnectorsRevokeOptions {
  const ConnectorsRevokeOptions({this.execute, this.yes});

  final bool? execute;
  final bool? yes;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (yes != null) {
      into["yes"] = RaviJson.from(yes);
    }
  }
}

class ConnectorsRevokeReturn {
  const ConnectorsRevokeReturn({required this.id, required this.revoked});

  final String id;
  final bool revoked;

  factory ConnectorsRevokeReturn.fromJson(Map<String, Object?> json) {
    return ConnectorsRevokeReturn(
      id: raviJsonAsString(json["id"]),
      revoked: raviJsonAsBool(json["revoked"]),
    );
  }

  static ConnectorsRevokeReturn fromJsonValue(Object? json) {
    return ConnectorsRevokeReturn.fromJson(raviJsonObject(json, "ConnectorsRevokeReturn"));
  }
}

ConnectorsRevokeReturn connectorsRevokeReturnFromJson(Object? json) => ConnectorsRevokeReturn.fromJsonValue(json);

class ConnectorsShowReturn {
  const ConnectorsShowReturn({required this.connection});

  final RaviJson connection;

  factory ConnectorsShowReturn.fromJson(Map<String, Object?> json) {
    return ConnectorsShowReturn(
      connection: RaviJson.from(json["connection"]),
    );
  }

  static ConnectorsShowReturn fromJsonValue(Object? json) {
    return ConnectorsShowReturn.fromJson(raviJsonObject(json, "ConnectorsShowReturn"));
  }
}

ConnectorsShowReturn connectorsShowReturnFromJson(Object? json) => ConnectorsShowReturn.fromJsonValue(json);

class ContactsActivityOptions {
  const ContactsActivityOptions({this.limit, this.offset, this.raw});

  final String? limit;
  final String? offset;
  final bool? raw;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (raw != null) {
      into["raw"] = RaviJson.from(raw);
    }
  }
}

typedef ContactsActivityReturn = Map<String, RaviJson>;

ContactsActivityReturn contactsActivityReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsAddOptions {
  const ContactsAddOptions({this.agent, this.kind});

  final String? agent;
  final String? kind;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
  }
}

typedef ContactsAddReturn = Map<String, RaviJson>;

ContactsAddReturn contactsAddReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ContactsAllowReturn = Map<String, RaviJson>;

ContactsAllowReturn contactsAllowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsApproveOptions {
  const ContactsApproveOptions({this.agent});

  final String? agent;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
  }
}

typedef ContactsApproveReturn = Map<String, RaviJson>;

ContactsApproveReturn contactsApproveReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsBackfillOptions {
  const ContactsBackfillOptions({this.apply, this.channel, this.createList, this.dryRun, this.instance, this.limit, this.listOwner, this.mode});

  final bool? apply;
  final String? channel;
  final String? createList;
  final bool? dryRun;
  final String? instance;
  final String? limit;
  final String? listOwner;
  final String? mode;

  void encodeBody(Map<String, RaviJson> into) {
    if (apply != null) {
      into["apply"] = RaviJson.from(apply);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (createList != null) {
      into["createList"] = RaviJson.from(createList);
    }
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (listOwner != null) {
      into["listOwner"] = RaviJson.from(listOwner);
    }
    if (mode != null) {
      into["mode"] = RaviJson.from(mode);
    }
  }
}

typedef ContactsBackfillReturn = Map<String, RaviJson>;

ContactsBackfillReturn contactsBackfillReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ContactsBlockReturn = Map<String, RaviJson>;

ContactsBlockReturn contactsBlockReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ContactsCheckReturn = Map<String, RaviJson>;

ContactsCheckReturn contactsCheckReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ContactsDuplicatesReturn = Map<String, RaviJson>;

ContactsDuplicatesReturn contactsDuplicatesReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsFindOptions {
  const ContactsFindOptions({this.fields, this.tag});

  final String? fields;
  final bool? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

typedef ContactsFindReturn = Map<String, RaviJson>;

ContactsFindReturn contactsFindReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ContactsGetReturn = Map<String, RaviJson>;

ContactsGetReturn contactsGetReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ContactsInfoReturn = Map<String, RaviJson>;

ContactsInfoReturn contactsInfoReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsLinkOptions {
  const ContactsLinkOptions({this.channel, this.id, this.instance, this.reason});

  final String? channel;
  final String? id;
  final String? instance;
  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (id != null) {
      into["id"] = RaviJson.from(id);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

typedef ContactsLinkReturn = Map<String, RaviJson>;

ContactsLinkReturn contactsLinkReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsListOptions {
  const ContactsListOptions({this.fields, this.limit, this.offset, this.status});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

typedef ContactsListReturn = Map<String, RaviJson>;

ContactsListReturn contactsListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsMergeOptions {
  const ContactsMergeOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef ContactsMergeReturn = Map<String, RaviJson>;

ContactsMergeReturn contactsMergeReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsMessagesOptions {
  const ContactsMessagesOptions({this.limit, this.offset});

  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

typedef ContactsMessagesReturn = Map<String, RaviJson>;

ContactsMessagesReturn contactsMessagesReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsMetadataListOptions {
  const ContactsMetadataListOptions({this.limit, this.offset, this.scope});

  final String? limit;
  final String? offset;
  final String? scope;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
  }
}

typedef ContactsMetadataListReturn = Map<String, RaviJson>;

ContactsMetadataListReturn contactsMetadataListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsMetadataRemoveOptions {
  const ContactsMetadataRemoveOptions({this.scope, this.source});

  final String? scope;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

typedef ContactsMetadataRemoveReturn = Map<String, RaviJson>;

ContactsMetadataRemoveReturn contactsMetadataRemoveReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsMetadataSetOptions {
  const ContactsMetadataSetOptions({this.scope, this.source});

  final String? scope;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

typedef ContactsMetadataSetReturn = Map<String, RaviJson>;

ContactsMetadataSetReturn contactsMetadataSetReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsNoteOptions {
  const ContactsNoteOptions({this.scope, this.source});

  final String? scope;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

typedef ContactsNoteReturn = Map<String, RaviJson>;

ContactsNoteReturn contactsNoteReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsPendingOptions {
  const ContactsPendingOptions({this.account});

  final String? account;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
  }
}

typedef ContactsPendingReturn = Map<String, RaviJson>;

ContactsPendingReturn contactsPendingReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsProfileOptions {
  const ContactsProfileOptions({this.includeCrm, this.limit});

  final bool? includeCrm;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (includeCrm != null) {
      into["includeCrm"] = RaviJson.from(includeCrm);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

typedef ContactsProfileReturn = Map<String, RaviJson>;

ContactsProfileReturn contactsProfileReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsRemoveOptions {
  const ContactsRemoveOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef ContactsRemoveReturn = Map<String, RaviJson>;

ContactsRemoveReturn contactsRemoveReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsSessionsOptions {
  const ContactsSessionsOptions({this.limit, this.offset});

  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

typedef ContactsSessionsReturn = Map<String, RaviJson>;

ContactsSessionsReturn contactsSessionsReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ContactsSetReturn = Map<String, RaviJson>;

ContactsSetReturn contactsSetReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ContactsTagReturn = Map<String, RaviJson>;

ContactsTagReturn contactsTagReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsTimelineOptions {
  const ContactsTimelineOptions({this.event, this.limit, this.offset, this.scope});

  final String? event;
  final String? limit;
  final String? offset;
  final String? scope;

  void encodeBody(Map<String, RaviJson> into) {
    if (event != null) {
      into["event"] = RaviJson.from(event);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
  }
}

typedef ContactsTimelineReturn = Map<String, RaviJson>;

ContactsTimelineReturn contactsTimelineReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContactsUnlinkOptions {
  const ContactsUnlinkOptions({this.channel, this.instance, this.reason});

  final String? channel;
  final String? instance;
  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

typedef ContactsUnlinkReturn = Map<String, RaviJson>;

ContactsUnlinkReturn contactsUnlinkReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ContactsUntagReturn = Map<String, RaviJson>;

ContactsUntagReturn contactsUntagReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ContextAuthorizeReturn {
  const ContextAuthorizeReturn({required this.agentId, required this.allowed, required this.approved, required this.capabilitiesCount, required this.contextId, required this.inherited, required this.objectId, required this.objectType, required this.permission, required this.reason});

  final RaviJson agentId;
  final bool allowed;
  final bool approved;
  final double capabilitiesCount;
  final String contextId;
  final bool inherited;
  final String objectId;
  final String objectType;
  final String permission;
  final RaviJson reason;

  factory ContextAuthorizeReturn.fromJson(Map<String, Object?> json) {
    return ContextAuthorizeReturn(
      agentId: RaviJson.from(json["agentId"]),
      allowed: raviJsonAsBool(json["allowed"]),
      approved: raviJsonAsBool(json["approved"]),
      capabilitiesCount: raviJsonAsDouble(json["capabilitiesCount"]),
      contextId: raviJsonAsString(json["contextId"]),
      inherited: raviJsonAsBool(json["inherited"]),
      objectId: raviJsonAsString(json["objectId"]),
      objectType: raviJsonAsString(json["objectType"]),
      permission: raviJsonAsString(json["permission"]),
      reason: RaviJson.from(json["reason"]),
    );
  }

  static ContextAuthorizeReturn fromJsonValue(Object? json) {
    return ContextAuthorizeReturn.fromJson(raviJsonObject(json, "ContextAuthorizeReturn"));
  }
}

ContextAuthorizeReturn contextAuthorizeReturnFromJson(Object? json) => ContextAuthorizeReturn.fromJsonValue(json);

class ContextCapabilitiesReturn {
  const ContextCapabilitiesReturn({required this.agentId, required this.capabilities, required this.contextId, required this.kind, required this.sessionKey, required this.sessionName});

  final RaviJson agentId;
  final List<RaviJson> capabilities;
  final String contextId;
  final String kind;
  final RaviJson sessionKey;
  final RaviJson sessionName;

  factory ContextCapabilitiesReturn.fromJson(Map<String, Object?> json) {
    return ContextCapabilitiesReturn(
      agentId: RaviJson.from(json["agentId"]),
      capabilities: raviJsonAsList(json["capabilities"], RaviJson.from),
      contextId: raviJsonAsString(json["contextId"]),
      kind: raviJsonAsString(json["kind"]),
      sessionKey: RaviJson.from(json["sessionKey"]),
      sessionName: RaviJson.from(json["sessionName"]),
    );
  }

  static ContextCapabilitiesReturn fromJsonValue(Object? json) {
    return ContextCapabilitiesReturn.fromJson(raviJsonObject(json, "ContextCapabilitiesReturn"));
  }
}

ContextCapabilitiesReturn contextCapabilitiesReturnFromJson(Object? json) => ContextCapabilitiesReturn.fromJsonValue(json);

class ContextCheckReturn {
  const ContextCheckReturn({required this.agentId, required this.allowed, required this.capabilitiesCount, required this.contextId, required this.objectId, required this.objectType, required this.permission});

  final RaviJson agentId;
  final bool allowed;
  final double capabilitiesCount;
  final String contextId;
  final String objectId;
  final String objectType;
  final String permission;

  factory ContextCheckReturn.fromJson(Map<String, Object?> json) {
    return ContextCheckReturn(
      agentId: RaviJson.from(json["agentId"]),
      allowed: raviJsonAsBool(json["allowed"]),
      capabilitiesCount: raviJsonAsDouble(json["capabilitiesCount"]),
      contextId: raviJsonAsString(json["contextId"]),
      objectId: raviJsonAsString(json["objectId"]),
      objectType: raviJsonAsString(json["objectType"]),
      permission: raviJsonAsString(json["permission"]),
    );
  }

  static ContextCheckReturn fromJsonValue(Object? json) {
    return ContextCheckReturn.fromJson(raviJsonObject(json, "ContextCheckReturn"));
  }
}

ContextCheckReturn contextCheckReturnFromJson(Object? json) => ContextCheckReturn.fromJsonValue(json);

class ContextCleanupAgentRuntimeOptions {
  const ContextCleanupAgentRuntimeOptions({this.agent, this.olderThan, this.reason, this.revoke, this.session});

  final String? agent;
  final String? olderThan;
  final String? reason;
  final bool? revoke;
  final String? session;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (olderThan != null) {
      into["olderThan"] = RaviJson.from(olderThan);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
    if (revoke != null) {
      into["revoke"] = RaviJson.from(revoke);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
  }
}

class ContextCleanupAgentRuntimeReturn {
  const ContextCleanupAgentRuntimeReturn({required this.candidates, required this.candidatesCount, required this.cutoffAt, required this.dryRun, required this.olderThan, required this.olderThanMs, required this.reason, required this.revoked, required this.revokedCount, required this.scanned});

  final List<RaviJson> candidates;
  final double candidatesCount;
  final double cutoffAt;
  final bool dryRun;
  final String olderThan;
  final double olderThanMs;
  final RaviJson reason;
  final List<RaviJson> revoked;
  final double revokedCount;
  final RaviJson scanned;

  factory ContextCleanupAgentRuntimeReturn.fromJson(Map<String, Object?> json) {
    return ContextCleanupAgentRuntimeReturn(
      candidates: raviJsonAsList(json["candidates"], RaviJson.from),
      candidatesCount: raviJsonAsDouble(json["candidatesCount"]),
      cutoffAt: raviJsonAsDouble(json["cutoffAt"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      olderThan: raviJsonAsString(json["olderThan"]),
      olderThanMs: raviJsonAsDouble(json["olderThanMs"]),
      reason: RaviJson.from(json["reason"]),
      revoked: raviJsonAsList(json["revoked"], RaviJson.from),
      revokedCount: raviJsonAsDouble(json["revokedCount"]),
      scanned: RaviJson.from(json["scanned"]),
    );
  }

  static ContextCleanupAgentRuntimeReturn fromJsonValue(Object? json) {
    return ContextCleanupAgentRuntimeReturn.fromJson(raviJsonObject(json, "ContextCleanupAgentRuntimeReturn"));
  }
}

ContextCleanupAgentRuntimeReturn contextCleanupAgentRuntimeReturnFromJson(Object? json) => ContextCleanupAgentRuntimeReturn.fromJsonValue(json);

class ContextCodexBashHookReturn {
  const ContextCodexBashHookReturn({this.hookSpecificOutput});

  final RaviJson? hookSpecificOutput;

  factory ContextCodexBashHookReturn.fromJson(Map<String, Object?> json) {
    return ContextCodexBashHookReturn(
      hookSpecificOutput: json["hookSpecificOutput"] == null ? null : RaviJson.from(json["hookSpecificOutput"]),
    );
  }

  static ContextCodexBashHookReturn fromJsonValue(Object? json) {
    return ContextCodexBashHookReturn.fromJson(raviJsonObject(json, "ContextCodexBashHookReturn"));
  }
}

ContextCodexBashHookReturn contextCodexBashHookReturnFromJson(Object? json) => ContextCodexBashHookReturn.fromJsonValue(json);

class ContextCredentialsAddOptions {
  const ContextCredentialsAddOptions({this.label, this.setDefault});

  final String? label;
  final bool? setDefault;

  void encodeBody(Map<String, RaviJson> into) {
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (setDefault != null) {
      into["setDefault"] = RaviJson.from(setDefault);
    }
  }
}

class ContextCredentialsAddReturn {
  const ContextCredentialsAddReturn({required this.added, required this.default_, required this.path});

  final String added;
  final RaviJson default_;
  final String path;

  factory ContextCredentialsAddReturn.fromJson(Map<String, Object?> json) {
    return ContextCredentialsAddReturn(
      added: raviJsonAsString(json["added"]),
      default_: RaviJson.from(json["default"]),
      path: raviJsonAsString(json["path"]),
    );
  }

  static ContextCredentialsAddReturn fromJsonValue(Object? json) {
    return ContextCredentialsAddReturn.fromJson(raviJsonObject(json, "ContextCredentialsAddReturn"));
  }
}

ContextCredentialsAddReturn contextCredentialsAddReturnFromJson(Object? json) => ContextCredentialsAddReturn.fromJsonValue(json);

class ContextCredentialsListOptions {
  const ContextCredentialsListOptions({this.fields, this.limit, this.offset});

  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class ContextCredentialsListReturn {
  const ContextCredentialsListReturn({required this.default_, required this.entries, required this.exists, required this.items, required this.pagination, required this.path, required this.total});

  final RaviJson default_;
  final List<RaviJson> entries;
  final bool exists;
  final List<RaviJson> items;
  final RaviJson pagination;
  final String path;
  final double total;

  factory ContextCredentialsListReturn.fromJson(Map<String, Object?> json) {
    return ContextCredentialsListReturn(
      default_: RaviJson.from(json["default"]),
      entries: raviJsonAsList(json["entries"], RaviJson.from),
      exists: raviJsonAsBool(json["exists"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      path: raviJsonAsString(json["path"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ContextCredentialsListReturn fromJsonValue(Object? json) {
    return ContextCredentialsListReturn.fromJson(raviJsonObject(json, "ContextCredentialsListReturn"));
  }
}

ContextCredentialsListReturn contextCredentialsListReturnFromJson(Object? json) => ContextCredentialsListReturn.fromJsonValue(json);

class ContextCredentialsRemoveOptions {
  const ContextCredentialsRemoveOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class ContextCredentialsRemoveReturn {
  const ContextCredentialsRemoveReturn({required this.default_, required this.path, required this.removed});

  final RaviJson default_;
  final String path;
  final String removed;

  factory ContextCredentialsRemoveReturn.fromJson(Map<String, Object?> json) {
    return ContextCredentialsRemoveReturn(
      default_: RaviJson.from(json["default"]),
      path: raviJsonAsString(json["path"]),
      removed: raviJsonAsString(json["removed"]),
    );
  }

  static ContextCredentialsRemoveReturn fromJsonValue(Object? json) {
    return ContextCredentialsRemoveReturn.fromJson(raviJsonObject(json, "ContextCredentialsRemoveReturn"));
  }
}

ContextCredentialsRemoveReturn contextCredentialsRemoveReturnFromJson(Object? json) => ContextCredentialsRemoveReturn.fromJsonValue(json);

class ContextCredentialsSetDefaultReturn {
  const ContextCredentialsSetDefaultReturn({required this.default_, required this.path});

  final RaviJson default_;
  final String path;

  factory ContextCredentialsSetDefaultReturn.fromJson(Map<String, Object?> json) {
    return ContextCredentialsSetDefaultReturn(
      default_: RaviJson.from(json["default"]),
      path: raviJsonAsString(json["path"]),
    );
  }

  static ContextCredentialsSetDefaultReturn fromJsonValue(Object? json) {
    return ContextCredentialsSetDefaultReturn.fromJson(raviJsonObject(json, "ContextCredentialsSetDefaultReturn"));
  }
}

ContextCredentialsSetDefaultReturn contextCredentialsSetDefaultReturnFromJson(Object? json) => ContextCredentialsSetDefaultReturn.fromJsonValue(json);

class ContextInfoReturn {
  const ContextInfoReturn({required this.agentId, required this.capabilities, required this.capabilitiesCount, required this.contextId, required this.createdAt, required this.expiresAt, required this.issuanceMode, required this.issuedFor, required this.kind, required this.lastUsedAt, required this.lineage, required this.metadata, required this.parentContextId, required this.revokedAt, required this.sessionKey, required this.sessionName, required this.source, required this.status});

  final RaviJson agentId;
  final List<RaviJson> capabilities;
  final double capabilitiesCount;
  final String contextId;
  final double createdAt;
  final RaviJson expiresAt;
  final RaviJson issuanceMode;
  final RaviJson issuedFor;
  final String kind;
  final RaviJson lastUsedAt;
  final RaviJson lineage;
  final RaviJson metadata;
  final RaviJson parentContextId;
  final RaviJson revokedAt;
  final RaviJson sessionKey;
  final RaviJson sessionName;
  final RaviJson source;
  final String status;

  factory ContextInfoReturn.fromJson(Map<String, Object?> json) {
    return ContextInfoReturn(
      agentId: RaviJson.from(json["agentId"]),
      capabilities: raviJsonAsList(json["capabilities"], RaviJson.from),
      capabilitiesCount: raviJsonAsDouble(json["capabilitiesCount"]),
      contextId: raviJsonAsString(json["contextId"]),
      createdAt: raviJsonAsDouble(json["createdAt"]),
      expiresAt: RaviJson.from(json["expiresAt"]),
      issuanceMode: RaviJson.from(json["issuanceMode"]),
      issuedFor: RaviJson.from(json["issuedFor"]),
      kind: raviJsonAsString(json["kind"]),
      lastUsedAt: RaviJson.from(json["lastUsedAt"]),
      lineage: RaviJson.from(json["lineage"]),
      metadata: RaviJson.from(json["metadata"]),
      parentContextId: RaviJson.from(json["parentContextId"]),
      revokedAt: RaviJson.from(json["revokedAt"]),
      sessionKey: RaviJson.from(json["sessionKey"]),
      sessionName: RaviJson.from(json["sessionName"]),
      source: RaviJson.from(json["source"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static ContextInfoReturn fromJsonValue(Object? json) {
    return ContextInfoReturn.fromJson(raviJsonObject(json, "ContextInfoReturn"));
  }
}

ContextInfoReturn contextInfoReturnFromJson(Object? json) => ContextInfoReturn.fromJsonValue(json);

class ContextIssueOptions {
  const ContextIssueOptions({this.allow, this.asAgent, this.asSessionKey, this.asSessionName, this.inherit, this.ttl});

  final String? allow;
  final String? asAgent;
  final String? asSessionKey;
  final String? asSessionName;
  final bool? inherit;
  final String? ttl;

  void encodeBody(Map<String, RaviJson> into) {
    if (allow != null) {
      into["allow"] = RaviJson.from(allow);
    }
    if (asAgent != null) {
      into["asAgent"] = RaviJson.from(asAgent);
    }
    if (asSessionKey != null) {
      into["asSessionKey"] = RaviJson.from(asSessionKey);
    }
    if (asSessionName != null) {
      into["asSessionName"] = RaviJson.from(asSessionName);
    }
    if (inherit != null) {
      into["inherit"] = RaviJson.from(inherit);
    }
    if (ttl != null) {
      into["ttl"] = RaviJson.from(ttl);
    }
  }
}

class ContextIssueReturn {
  const ContextIssueReturn({required this.agentId, required this.capabilities, required this.capabilitiesCount, required this.cliName, required this.contextId, required this.contextKey, required this.createdAt, required this.env, required this.expiresAt, required this.kind, required this.metadata, required this.parentContextId, required this.sessionKey, required this.sessionName, required this.source});

  final RaviJson agentId;
  final List<RaviJson> capabilities;
  final double capabilitiesCount;
  final String cliName;
  final String contextId;
  final String contextKey;
  final double createdAt;
  final Map<String, String> env;
  final RaviJson expiresAt;
  final String kind;
  final RaviJson metadata;
  final String parentContextId;
  final RaviJson sessionKey;
  final RaviJson sessionName;
  final RaviJson source;

  factory ContextIssueReturn.fromJson(Map<String, Object?> json) {
    return ContextIssueReturn(
      agentId: RaviJson.from(json["agentId"]),
      capabilities: raviJsonAsList(json["capabilities"], RaviJson.from),
      capabilitiesCount: raviJsonAsDouble(json["capabilitiesCount"]),
      cliName: raviJsonAsString(json["cliName"]),
      contextId: raviJsonAsString(json["contextId"]),
      contextKey: raviJsonAsString(json["contextKey"]),
      createdAt: raviJsonAsDouble(json["createdAt"]),
      env: raviJsonAsMap(json["env"], raviJsonAsString),
      expiresAt: RaviJson.from(json["expiresAt"]),
      kind: raviJsonAsString(json["kind"]),
      metadata: RaviJson.from(json["metadata"]),
      parentContextId: raviJsonAsString(json["parentContextId"]),
      sessionKey: RaviJson.from(json["sessionKey"]),
      sessionName: RaviJson.from(json["sessionName"]),
      source: RaviJson.from(json["source"]),
    );
  }

  static ContextIssueReturn fromJsonValue(Object? json) {
    return ContextIssueReturn.fromJson(raviJsonObject(json, "ContextIssueReturn"));
  }
}

ContextIssueReturn contextIssueReturnFromJson(Object? json) => ContextIssueReturn.fromJsonValue(json);

class ContextLineageReturn {
  const ContextLineageReturn({required this.ancestors, required this.context, required this.descendants});

  final List<RaviJson> ancestors;
  final RaviJson context;
  final List<RaviJson> descendants;

  factory ContextLineageReturn.fromJson(Map<String, Object?> json) {
    return ContextLineageReturn(
      ancestors: raviJsonAsList(json["ancestors"], RaviJson.from),
      context: RaviJson.from(json["context"]),
      descendants: raviJsonAsList(json["descendants"], RaviJson.from),
    );
  }

  static ContextLineageReturn fromJsonValue(Object? json) {
    return ContextLineageReturn.fromJson(raviJsonObject(json, "ContextLineageReturn"));
  }
}

ContextLineageReturn contextLineageReturnFromJson(Object? json) => ContextLineageReturn.fromJsonValue(json);

class ContextListOptions {
  const ContextListOptions({this.agent, this.all, this.fields, this.kind, this.limit, this.offset, this.session});

  final String? agent;
  final bool? all;
  final String? fields;
  final String? kind;
  final String? limit;
  final String? offset;
  final String? session;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (all != null) {
      into["all"] = RaviJson.from(all);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
  }
}

class ContextListReturn {
  const ContextListReturn({required this.contexts, required this.count, required this.items, required this.pagination, required this.total});

  final List<RaviJson> contexts;
  final double count;
  final List<RaviJson> items;
  final RaviJson pagination;
  final double total;

  factory ContextListReturn.fromJson(Map<String, Object?> json) {
    return ContextListReturn(
      contexts: raviJsonAsList(json["contexts"], RaviJson.from),
      count: raviJsonAsDouble(json["count"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ContextListReturn fromJsonValue(Object? json) {
    return ContextListReturn.fromJson(raviJsonObject(json, "ContextListReturn"));
  }
}

ContextListReturn contextListReturnFromJson(Object? json) => ContextListReturn.fromJsonValue(json);

class ContextPruneOptions {
  const ContextPruneOptions({this.apply, this.confirm, this.olderThan});

  final bool? apply;
  final String? confirm;
  final String? olderThan;

  void encodeBody(Map<String, RaviJson> into) {
    if (apply != null) {
      into["apply"] = RaviJson.from(apply);
    }
    if (confirm != null) {
      into["confirm"] = RaviJson.from(confirm);
    }
    if (olderThan != null) {
      into["olderThan"] = RaviJson.from(olderThan);
    }
  }
}

class ContextPruneReturn {
  const ContextPruneReturn({required this.changedCount, required this.dryRun, required this.matchedCount, required this.olderThan, required this.status});

  final double changedCount;
  final bool dryRun;
  final double matchedCount;
  final String olderThan;
  final String status;

  factory ContextPruneReturn.fromJson(Map<String, Object?> json) {
    return ContextPruneReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      matchedCount: raviJsonAsDouble(json["matchedCount"]),
      olderThan: raviJsonAsString(json["olderThan"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static ContextPruneReturn fromJsonValue(Object? json) {
    return ContextPruneReturn.fromJson(raviJsonObject(json, "ContextPruneReturn"));
  }
}

ContextPruneReturn contextPruneReturnFromJson(Object? json) => ContextPruneReturn.fromJsonValue(json);

class ContextRevokeOptions {
  const ContextRevokeOptions({this.noCascade, this.reason});

  final bool? noCascade;
  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (noCascade != null) {
      into["noCascade"] = RaviJson.from(noCascade);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

class ContextRevokeReturn {
  const ContextRevokeReturn({required this.cascaded, required this.context, required this.revokedAt});

  final List<RaviJson> cascaded;
  final RaviJson context;
  final double revokedAt;

  factory ContextRevokeReturn.fromJson(Map<String, Object?> json) {
    return ContextRevokeReturn(
      cascaded: raviJsonAsList(json["cascaded"], RaviJson.from),
      context: RaviJson.from(json["context"]),
      revokedAt: raviJsonAsDouble(json["revokedAt"]),
    );
  }

  static ContextRevokeReturn fromJsonValue(Object? json) {
    return ContextRevokeReturn.fromJson(raviJsonObject(json, "ContextRevokeReturn"));
  }
}

ContextRevokeReturn contextRevokeReturnFromJson(Object? json) => ContextRevokeReturn.fromJsonValue(json);

class ContextVisibilityReturn {
  const ContextVisibilityReturn({required this.agentId, required this.compact, required this.lastUpdatedAt, required this.loadedSkills, required this.provider, required this.sessionKey, required this.skills, required this.tokens});

  final String agentId;
  final RaviJson compact;
  final double lastUpdatedAt;
  final List<String> loadedSkills;
  final RaviJson provider;
  final String sessionKey;
  final List<RaviJson> skills;
  final RaviJson tokens;

  factory ContextVisibilityReturn.fromJson(Map<String, Object?> json) {
    return ContextVisibilityReturn(
      agentId: raviJsonAsString(json["agentId"]),
      compact: RaviJson.from(json["compact"]),
      lastUpdatedAt: raviJsonAsDouble(json["lastUpdatedAt"]),
      loadedSkills: raviJsonAsList(json["loadedSkills"], raviJsonAsString),
      provider: RaviJson.from(json["provider"]),
      sessionKey: raviJsonAsString(json["sessionKey"]),
      skills: raviJsonAsList(json["skills"], RaviJson.from),
      tokens: RaviJson.from(json["tokens"]),
    );
  }

  static ContextVisibilityReturn fromJsonValue(Object? json) {
    return ContextVisibilityReturn.fromJson(raviJsonObject(json, "ContextVisibilityReturn"));
  }
}

ContextVisibilityReturn contextVisibilityReturnFromJson(Object? json) => ContextVisibilityReturn.fromJsonValue(json);

class ContextWhoamiReturn {
  const ContextWhoamiReturn({required this.agentId, required this.capabilities, required this.capabilitiesCount, required this.contextId, required this.createdAt, required this.expiresAt, required this.issuanceMode, required this.issuedFor, required this.kind, required this.lastUsedAt, required this.lineage, required this.metadata, required this.parentContextId, required this.revokedAt, required this.sessionKey, required this.sessionName, required this.source, required this.status});

  final RaviJson agentId;
  final List<RaviJson> capabilities;
  final double capabilitiesCount;
  final String contextId;
  final double createdAt;
  final RaviJson expiresAt;
  final RaviJson issuanceMode;
  final RaviJson issuedFor;
  final String kind;
  final RaviJson lastUsedAt;
  final RaviJson lineage;
  final RaviJson metadata;
  final RaviJson parentContextId;
  final RaviJson revokedAt;
  final RaviJson sessionKey;
  final RaviJson sessionName;
  final RaviJson source;
  final String status;

  factory ContextWhoamiReturn.fromJson(Map<String, Object?> json) {
    return ContextWhoamiReturn(
      agentId: RaviJson.from(json["agentId"]),
      capabilities: raviJsonAsList(json["capabilities"], RaviJson.from),
      capabilitiesCount: raviJsonAsDouble(json["capabilitiesCount"]),
      contextId: raviJsonAsString(json["contextId"]),
      createdAt: raviJsonAsDouble(json["createdAt"]),
      expiresAt: RaviJson.from(json["expiresAt"]),
      issuanceMode: RaviJson.from(json["issuanceMode"]),
      issuedFor: RaviJson.from(json["issuedFor"]),
      kind: raviJsonAsString(json["kind"]),
      lastUsedAt: RaviJson.from(json["lastUsedAt"]),
      lineage: RaviJson.from(json["lineage"]),
      metadata: RaviJson.from(json["metadata"]),
      parentContextId: RaviJson.from(json["parentContextId"]),
      revokedAt: RaviJson.from(json["revokedAt"]),
      sessionKey: RaviJson.from(json["sessionKey"]),
      sessionName: RaviJson.from(json["sessionName"]),
      source: RaviJson.from(json["source"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static ContextWhoamiReturn fromJsonValue(Object? json) {
    return ContextWhoamiReturn.fromJson(raviJsonObject(json, "ContextWhoamiReturn"));
  }
}

ContextWhoamiReturn contextWhoamiReturnFromJson(Object? json) => ContextWhoamiReturn.fromJsonValue(json);

class CostsAgentOptions {
  const CostsAgentOptions({this.hours});

  final String? hours;

  void encodeBody(Map<String, RaviJson> into) {
    if (hours != null) {
      into["hours"] = RaviJson.from(hours);
    }
  }
}

class CostsAgentReturn {
  const CostsAgentReturn({required this.agentId, required this.summary, required this.window});

  final String agentId;
  final RaviJson summary;
  final RaviJson window;

  factory CostsAgentReturn.fromJson(Map<String, Object?> json) {
    return CostsAgentReturn(
      agentId: raviJsonAsString(json["agentId"]),
      summary: RaviJson.from(json["summary"]),
      window: RaviJson.from(json["window"]),
    );
  }

  static CostsAgentReturn fromJsonValue(Object? json) {
    return CostsAgentReturn.fromJson(raviJsonObject(json, "CostsAgentReturn"));
  }
}

CostsAgentReturn costsAgentReturnFromJson(Object? json) => CostsAgentReturn.fromJsonValue(json);

class CostsAgentsOptions {
  const CostsAgentsOptions({this.fields, this.hours, this.limit});

  final String? fields;
  final String? hours;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (hours != null) {
      into["hours"] = RaviJson.from(hours);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class CostsAgentsReturn {
  const CostsAgentsReturn({required this.agents, required this.limit, required this.totalAgents, required this.window});

  final List<RaviJson> agents;
  final double limit;
  final double totalAgents;
  final RaviJson window;

  factory CostsAgentsReturn.fromJson(Map<String, Object?> json) {
    return CostsAgentsReturn(
      agents: raviJsonAsList(json["agents"], RaviJson.from),
      limit: raviJsonAsDouble(json["limit"]),
      totalAgents: raviJsonAsDouble(json["totalAgents"]),
      window: RaviJson.from(json["window"]),
    );
  }

  static CostsAgentsReturn fromJsonValue(Object? json) {
    return CostsAgentsReturn.fromJson(raviJsonObject(json, "CostsAgentsReturn"));
  }
}

CostsAgentsReturn costsAgentsReturnFromJson(Object? json) => CostsAgentsReturn.fromJsonValue(json);

class CostsPricingOptions {
  const CostsPricingOptions({this.dryRun, this.fields, this.hours, this.includePriced, this.limit, this.recompute});

  final bool? dryRun;
  final String? fields;
  final String? hours;
  final bool? includePriced;
  final String? limit;
  final bool? recompute;

  void encodeBody(Map<String, RaviJson> into) {
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (hours != null) {
      into["hours"] = RaviJson.from(hours);
    }
    if (includePriced != null) {
      into["includePriced"] = RaviJson.from(includePriced);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (recompute != null) {
      into["recompute"] = RaviJson.from(recompute);
    }
  }
}

class CostsPricingReturn {
  const CostsPricingReturn({this.recompute, required this.rows, required this.window});

  final RaviJson? recompute;
  final List<RaviJson> rows;
  final RaviJson window;

  factory CostsPricingReturn.fromJson(Map<String, Object?> json) {
    return CostsPricingReturn(
      recompute: json["recompute"] == null ? null : RaviJson.from(json["recompute"]),
      rows: raviJsonAsList(json["rows"], RaviJson.from),
      window: RaviJson.from(json["window"]),
    );
  }

  static CostsPricingReturn fromJsonValue(Object? json) {
    return CostsPricingReturn.fromJson(raviJsonObject(json, "CostsPricingReturn"));
  }
}

CostsPricingReturn costsPricingReturnFromJson(Object? json) => CostsPricingReturn.fromJsonValue(json);

class CostsSessionReturn {
  const CostsSessionReturn({required this.agentId, required this.sessionKey, required this.sessionName, required this.summary});

  final RaviJson agentId;
  final String sessionKey;
  final RaviJson sessionName;
  final RaviJson summary;

  factory CostsSessionReturn.fromJson(Map<String, Object?> json) {
    return CostsSessionReturn(
      agentId: RaviJson.from(json["agentId"]),
      sessionKey: raviJsonAsString(json["sessionKey"]),
      sessionName: RaviJson.from(json["sessionName"]),
      summary: RaviJson.from(json["summary"]),
    );
  }

  static CostsSessionReturn fromJsonValue(Object? json) {
    return CostsSessionReturn.fromJson(raviJsonObject(json, "CostsSessionReturn"));
  }
}

CostsSessionReturn costsSessionReturnFromJson(Object? json) => CostsSessionReturn.fromJsonValue(json);

class CostsSummaryOptions {
  const CostsSummaryOptions({this.hours});

  final String? hours;

  void encodeBody(Map<String, RaviJson> into) {
    if (hours != null) {
      into["hours"] = RaviJson.from(hours);
    }
  }
}

class CostsSummaryReturn {
  const CostsSummaryReturn({required this.summary, required this.window});

  final RaviJson summary;
  final RaviJson window;

  factory CostsSummaryReturn.fromJson(Map<String, Object?> json) {
    return CostsSummaryReturn(
      summary: RaviJson.from(json["summary"]),
      window: RaviJson.from(json["window"]),
    );
  }

  static CostsSummaryReturn fromJsonValue(Object? json) {
    return CostsSummaryReturn.fromJson(raviJsonObject(json, "CostsSummaryReturn"));
  }
}

CostsSummaryReturn costsSummaryReturnFromJson(Object? json) => CostsSummaryReturn.fromJsonValue(json);

class CostsTopSessionsOptions {
  const CostsTopSessionsOptions({this.fields, this.hours, this.limit});

  final String? fields;
  final String? hours;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (hours != null) {
      into["hours"] = RaviJson.from(hours);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class CostsTopSessionsReturn {
  const CostsTopSessionsReturn({required this.limit, required this.sessions, required this.window});

  final double limit;
  final List<RaviJson> sessions;
  final RaviJson window;

  factory CostsTopSessionsReturn.fromJson(Map<String, Object?> json) {
    return CostsTopSessionsReturn(
      limit: raviJsonAsDouble(json["limit"]),
      sessions: raviJsonAsList(json["sessions"], RaviJson.from),
      window: RaviJson.from(json["window"]),
    );
  }

  static CostsTopSessionsReturn fromJsonValue(Object? json) {
    return CostsTopSessionsReturn.fromJson(raviJsonObject(json, "CostsTopSessionsReturn"));
  }
}

CostsTopSessionsReturn costsTopSessionsReturnFromJson(Object? json) => CostsTopSessionsReturn.fromJsonValue(json);

class CredentialsConnectionsDisableOptions {
  const CredentialsConnectionsDisableOptions({this.connection, this.provider});

  final String? connection;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class CredentialsConnectionsDisableReturn {
  const CredentialsConnectionsDisableReturn({required this.connection});

  final RaviJson connection;

  factory CredentialsConnectionsDisableReturn.fromJson(Map<String, Object?> json) {
    return CredentialsConnectionsDisableReturn(
      connection: RaviJson.from(json["connection"]),
    );
  }

  static CredentialsConnectionsDisableReturn fromJsonValue(Object? json) {
    return CredentialsConnectionsDisableReturn.fromJson(raviJsonObject(json, "CredentialsConnectionsDisableReturn"));
  }
}

CredentialsConnectionsDisableReturn credentialsConnectionsDisableReturnFromJson(Object? json) => CredentialsConnectionsDisableReturn.fromJsonValue(json);

class CredentialsConnectionsEnableOptions {
  const CredentialsConnectionsEnableOptions({this.connection, this.provider});

  final String? connection;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class CredentialsConnectionsEnableReturn {
  const CredentialsConnectionsEnableReturn({required this.connection});

  final RaviJson connection;

  factory CredentialsConnectionsEnableReturn.fromJson(Map<String, Object?> json) {
    return CredentialsConnectionsEnableReturn(
      connection: RaviJson.from(json["connection"]),
    );
  }

  static CredentialsConnectionsEnableReturn fromJsonValue(Object? json) {
    return CredentialsConnectionsEnableReturn.fromJson(raviJsonObject(json, "CredentialsConnectionsEnableReturn"));
  }
}

CredentialsConnectionsEnableReturn credentialsConnectionsEnableReturnFromJson(Object? json) => CredentialsConnectionsEnableReturn.fromJsonValue(json);

class CredentialsConnectionsListOptions {
  const CredentialsConnectionsListOptions({this.all, this.fields, this.limit, this.offset, this.provider, this.status});

  final bool? all;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? provider;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (all != null) {
      into["all"] = RaviJson.from(all);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class CredentialsConnectionsListReturn {
  const CredentialsConnectionsListReturn({required this.items, required this.pagination, required this.total});

  final List<RaviJson> items;
  final RaviJson pagination;
  final double total;

  factory CredentialsConnectionsListReturn.fromJson(Map<String, Object?> json) {
    return CredentialsConnectionsListReturn(
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CredentialsConnectionsListReturn fromJsonValue(Object? json) {
    return CredentialsConnectionsListReturn.fromJson(raviJsonObject(json, "CredentialsConnectionsListReturn"));
  }
}

CredentialsConnectionsListReturn credentialsConnectionsListReturnFromJson(Object? json) => CredentialsConnectionsListReturn.fromJsonValue(json);

class CredentialsConnectionsShowOptions {
  const CredentialsConnectionsShowOptions({this.connection, this.provider});

  final String? connection;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class CredentialsConnectionsShowReturn {
  const CredentialsConnectionsShowReturn({required this.connection});

  final RaviJson connection;

  factory CredentialsConnectionsShowReturn.fromJson(Map<String, Object?> json) {
    return CredentialsConnectionsShowReturn(
      connection: RaviJson.from(json["connection"]),
    );
  }

  static CredentialsConnectionsShowReturn fromJsonValue(Object? json) {
    return CredentialsConnectionsShowReturn.fromJson(raviJsonObject(json, "CredentialsConnectionsShowReturn"));
  }
}

CredentialsConnectionsShowReturn credentialsConnectionsShowReturnFromJson(Object? json) => CredentialsConnectionsShowReturn.fromJsonValue(json);

class CredentialsPoliciesExplainOptions {
  const CredentialsPoliciesExplainOptions({this.action, this.connection, this.provider});

  final String? action;
  final String? connection;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (action != null) {
      into["action"] = RaviJson.from(action);
    }
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class CredentialsPoliciesExplainReturn {
  const CredentialsPoliciesExplainReturn({required this.action, required this.approval, required this.connection, required this.provider, required this.requiredCapabilities});

  final String action;
  final RaviJson approval;
  final String connection;
  final String provider;
  final List<String> requiredCapabilities;

  factory CredentialsPoliciesExplainReturn.fromJson(Map<String, Object?> json) {
    return CredentialsPoliciesExplainReturn(
      action: raviJsonAsString(json["action"]),
      approval: RaviJson.from(json["approval"]),
      connection: raviJsonAsString(json["connection"]),
      provider: raviJsonAsString(json["provider"]),
      requiredCapabilities: raviJsonAsList(json["requiredCapabilities"], raviJsonAsString),
    );
  }

  static CredentialsPoliciesExplainReturn fromJsonValue(Object? json) {
    return CredentialsPoliciesExplainReturn.fromJson(raviJsonObject(json, "CredentialsPoliciesExplainReturn"));
  }
}

CredentialsPoliciesExplainReturn credentialsPoliciesExplainReturnFromJson(Object? json) => CredentialsPoliciesExplainReturn.fromJsonValue(json);

class CrmAccountReturn {
  const CrmAccountReturn({required this.crm, required this.target});

  final Map<String, RaviJson> crm;
  final String target;

  factory CrmAccountReturn.fromJson(Map<String, Object?> json) {
    return CrmAccountReturn(
      crm: raviJsonAsRaviJsonMap(json["crm"]),
      target: raviJsonAsString(json["target"]),
    );
  }

  static CrmAccountReturn fromJsonValue(Object? json) {
    return CrmAccountReturn.fromJson(raviJsonObject(json, "CrmAccountReturn"));
  }
}

CrmAccountReturn crmAccountReturnFromJson(Object? json) => CrmAccountReturn.fromJsonValue(json);

class CrmAccountCreateOptions {
  const CrmAccountCreateOptions({this.contact, this.domain, this.idempotencyKey, this.owner});

  final String? contact;
  final String? domain;
  final String? idempotencyKey;
  final String? owner;

  void encodeBody(Map<String, RaviJson> into) {
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (domain != null) {
      into["domain"] = RaviJson.from(domain);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
  }
}

class CrmAccountCreateReturn {
  const CrmAccountCreateReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmAccountCreateReturn.fromJson(Map<String, Object?> json) {
    return CrmAccountCreateReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmAccountCreateReturn fromJsonValue(Object? json) {
    return CrmAccountCreateReturn.fromJson(raviJsonObject(json, "CrmAccountCreateReturn"));
  }
}

CrmAccountCreateReturn crmAccountCreateReturnFromJson(Object? json) => CrmAccountCreateReturn.fromJsonValue(json);

class CrmAccountLinkContactOptions {
  const CrmAccountLinkContactOptions({this.primary, this.role});

  final bool? primary;
  final String? role;

  void encodeBody(Map<String, RaviJson> into) {
    if (primary != null) {
      into["primary"] = RaviJson.from(primary);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
  }
}

class CrmAccountLinkContactReturn {
  const CrmAccountLinkContactReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmAccountLinkContactReturn.fromJson(Map<String, Object?> json) {
    return CrmAccountLinkContactReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmAccountLinkContactReturn fromJsonValue(Object? json) {
    return CrmAccountLinkContactReturn.fromJson(raviJsonObject(json, "CrmAccountLinkContactReturn"));
  }
}

CrmAccountLinkContactReturn crmAccountLinkContactReturnFromJson(Object? json) => CrmAccountLinkContactReturn.fromJsonValue(json);

class CrmAccountShowReturn {
  const CrmAccountShowReturn({required this.crm, required this.target});

  final Map<String, RaviJson> crm;
  final String target;

  factory CrmAccountShowReturn.fromJson(Map<String, Object?> json) {
    return CrmAccountShowReturn(
      crm: raviJsonAsRaviJsonMap(json["crm"]),
      target: raviJsonAsString(json["target"]),
    );
  }

  static CrmAccountShowReturn fromJsonValue(Object? json) {
    return CrmAccountShowReturn.fromJson(raviJsonObject(json, "CrmAccountShowReturn"));
  }
}

CrmAccountShowReturn crmAccountShowReturnFromJson(Object? json) => CrmAccountShowReturn.fromJsonValue(json);

class CrmBoardOptions {
  const CrmBoardOptions({this.fields, this.includeEmptyStages, this.pipeline});

  final String? fields;
  final bool? includeEmptyStages;
  final String? pipeline;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (includeEmptyStages != null) {
      into["includeEmptyStages"] = RaviJson.from(includeEmptyStages);
    }
    if (pipeline != null) {
      into["pipeline"] = RaviJson.from(pipeline);
    }
  }
}

class CrmBoardReturn {
  const CrmBoardReturn({required this.opportunities, this.stages, required this.total});

  final List<Map<String, RaviJson>> opportunities;
  final List<Map<String, RaviJson>>? stages;
  final double total;

  factory CrmBoardReturn.fromJson(Map<String, Object?> json) {
    return CrmBoardReturn(
      opportunities: raviJsonAsList(json["opportunities"], raviJsonAsRaviJsonMap),
      stages: json["stages"] == null ? null : raviJsonAsList(json["stages"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CrmBoardReturn fromJsonValue(Object? json) {
    return CrmBoardReturn.fromJson(raviJsonObject(json, "CrmBoardReturn"));
  }
}

CrmBoardReturn crmBoardReturnFromJson(Object? json) => CrmBoardReturn.fromJsonValue(json);

class CrmContactReturn {
  const CrmContactReturn({required this.crm, required this.target});

  final Map<String, RaviJson> crm;
  final String target;

  factory CrmContactReturn.fromJson(Map<String, Object?> json) {
    return CrmContactReturn(
      crm: raviJsonAsRaviJsonMap(json["crm"]),
      target: raviJsonAsString(json["target"]),
    );
  }

  static CrmContactReturn fromJsonValue(Object? json) {
    return CrmContactReturn.fromJson(raviJsonObject(json, "CrmContactReturn"));
  }
}

CrmContactReturn crmContactReturnFromJson(Object? json) => CrmContactReturn.fromJsonValue(json);

class CrmContactSetOptions {
  const CrmContactSetOptions({this.source});

  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class CrmContactSetReturn {
  const CrmContactSetReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmContactSetReturn.fromJson(Map<String, Object?> json) {
    return CrmContactSetReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmContactSetReturn fromJsonValue(Object? json) {
    return CrmContactSetReturn.fromJson(raviJsonObject(json, "CrmContactSetReturn"));
  }
}

CrmContactSetReturn crmContactSetReturnFromJson(Object? json) => CrmContactSetReturn.fromJsonValue(json);

class CrmContactShowReturn {
  const CrmContactShowReturn({required this.crm, required this.target});

  final Map<String, RaviJson> crm;
  final String target;

  factory CrmContactShowReturn.fromJson(Map<String, Object?> json) {
    return CrmContactShowReturn(
      crm: raviJsonAsRaviJsonMap(json["crm"]),
      target: raviJsonAsString(json["target"]),
    );
  }

  static CrmContactShowReturn fromJsonValue(Object? json) {
    return CrmContactShowReturn.fromJson(raviJsonObject(json, "CrmContactShowReturn"));
  }
}

CrmContactShowReturn crmContactShowReturnFromJson(Object? json) => CrmContactShowReturn.fromJsonValue(json);

class CrmContactsOptions {
  const CrmContactsOptions({this.fields, this.limit, this.offset, this.owner, this.status});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? owner;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class CrmContactsReturn {
  const CrmContactsReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory CrmContactsReturn.fromJson(Map<String, Object?> json) {
    return CrmContactsReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CrmContactsReturn fromJsonValue(Object? json) {
    return CrmContactsReturn.fromJson(raviJsonObject(json, "CrmContactsReturn"));
  }
}

CrmContactsReturn crmContactsReturnFromJson(Object? json) => CrmContactsReturn.fromJsonValue(json);

class CrmFactConfirmReturn {
  const CrmFactConfirmReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmFactConfirmReturn.fromJson(Map<String, Object?> json) {
    return CrmFactConfirmReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmFactConfirmReturn fromJsonValue(Object? json) {
    return CrmFactConfirmReturn.fromJson(raviJsonObject(json, "CrmFactConfirmReturn"));
  }
}

CrmFactConfirmReturn crmFactConfirmReturnFromJson(Object? json) => CrmFactConfirmReturn.fromJsonValue(json);

class CrmFactListOptions {
  const CrmFactListOptions({this.account, this.contact, this.entity, this.entityType, this.key, this.limit, this.offset, this.opportunity, this.status});

  final String? account;
  final String? contact;
  final String? entity;
  final String? entityType;
  final String? key;
  final String? limit;
  final String? offset;
  final String? opportunity;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (entity != null) {
      into["entity"] = RaviJson.from(entity);
    }
    if (entityType != null) {
      into["entityType"] = RaviJson.from(entityType);
    }
    if (key != null) {
      into["key"] = RaviJson.from(key);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (opportunity != null) {
      into["opportunity"] = RaviJson.from(opportunity);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class CrmFactListReturn {
  const CrmFactListReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory CrmFactListReturn.fromJson(Map<String, Object?> json) {
    return CrmFactListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CrmFactListReturn fromJsonValue(Object? json) {
    return CrmFactListReturn.fromJson(raviJsonObject(json, "CrmFactListReturn"));
  }
}

CrmFactListReturn crmFactListReturnFromJson(Object? json) => CrmFactListReturn.fromJsonValue(json);

class CrmFactProposeOptions {
  const CrmFactProposeOptions({this.account, this.confidence, this.contact, this.idempotencyKey, this.opportunity, this.status});

  final String? account;
  final String? confidence;
  final String? contact;
  final String? idempotencyKey;
  final String? opportunity;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (confidence != null) {
      into["confidence"] = RaviJson.from(confidence);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (opportunity != null) {
      into["opportunity"] = RaviJson.from(opportunity);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class CrmFactProposeReturn {
  const CrmFactProposeReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmFactProposeReturn.fromJson(Map<String, Object?> json) {
    return CrmFactProposeReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmFactProposeReturn fromJsonValue(Object? json) {
    return CrmFactProposeReturn.fromJson(raviJsonObject(json, "CrmFactProposeReturn"));
  }
}

CrmFactProposeReturn crmFactProposeReturnFromJson(Object? json) => CrmFactProposeReturn.fromJsonValue(json);

class CrmFactRejectReturn {
  const CrmFactRejectReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmFactRejectReturn.fromJson(Map<String, Object?> json) {
    return CrmFactRejectReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmFactRejectReturn fromJsonValue(Object? json) {
    return CrmFactRejectReturn.fromJson(raviJsonObject(json, "CrmFactRejectReturn"));
  }
}

CrmFactRejectReturn crmFactRejectReturnFromJson(Object? json) => CrmFactRejectReturn.fromJsonValue(json);

class CrmNextOptions {
  const CrmNextOptions({this.account, this.contact, this.dueAfter, this.dueBefore, this.dueToday, this.fields, this.limit, this.offset, this.opportunity, this.owner, this.taskType});

  final String? account;
  final String? contact;
  final String? dueAfter;
  final String? dueBefore;
  final bool? dueToday;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? opportunity;
  final String? owner;
  final String? taskType;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (dueAfter != null) {
      into["dueAfter"] = RaviJson.from(dueAfter);
    }
    if (dueBefore != null) {
      into["dueBefore"] = RaviJson.from(dueBefore);
    }
    if (dueToday != null) {
      into["dueToday"] = RaviJson.from(dueToday);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (opportunity != null) {
      into["opportunity"] = RaviJson.from(opportunity);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (taskType != null) {
      into["taskType"] = RaviJson.from(taskType);
    }
  }
}

class CrmNextReturn {
  const CrmNextReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory CrmNextReturn.fromJson(Map<String, Object?> json) {
    return CrmNextReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CrmNextReturn fromJsonValue(Object? json) {
    return CrmNextReturn.fromJson(raviJsonObject(json, "CrmNextReturn"));
  }
}

CrmNextReturn crmNextReturnFromJson(Object? json) => CrmNextReturn.fromJsonValue(json);

class CrmOpportunityReturn {
  const CrmOpportunityReturn({required this.opportunity, required this.target});

  final Map<String, RaviJson> opportunity;
  final String target;

  factory CrmOpportunityReturn.fromJson(Map<String, Object?> json) {
    return CrmOpportunityReturn(
      opportunity: raviJsonAsRaviJsonMap(json["opportunity"]),
      target: raviJsonAsString(json["target"]),
    );
  }

  static CrmOpportunityReturn fromJsonValue(Object? json) {
    return CrmOpportunityReturn.fromJson(raviJsonObject(json, "CrmOpportunityReturn"));
  }
}

CrmOpportunityReturn crmOpportunityReturnFromJson(Object? json) => CrmOpportunityReturn.fromJsonValue(json);

class CrmOpportunityContactsReturn {
  const CrmOpportunityContactsReturn({required this.contacts, required this.total});

  final List<Map<String, RaviJson>> contacts;
  final double total;

  factory CrmOpportunityContactsReturn.fromJson(Map<String, Object?> json) {
    return CrmOpportunityContactsReturn(
      contacts: raviJsonAsList(json["contacts"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CrmOpportunityContactsReturn fromJsonValue(Object? json) {
    return CrmOpportunityContactsReturn.fromJson(raviJsonObject(json, "CrmOpportunityContactsReturn"));
  }
}

CrmOpportunityContactsReturn crmOpportunityContactsReturnFromJson(Object? json) => CrmOpportunityContactsReturn.fromJsonValue(json);

class CrmOpportunityCreateOptions {
  const CrmOpportunityCreateOptions({this.account, this.contact, this.currency, this.idempotencyKey, this.owner, this.pipeline, this.stage, this.value});

  final String? account;
  final String? contact;
  final String? currency;
  final String? idempotencyKey;
  final String? owner;
  final String? pipeline;
  final String? stage;
  final String? value;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (currency != null) {
      into["currency"] = RaviJson.from(currency);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (pipeline != null) {
      into["pipeline"] = RaviJson.from(pipeline);
    }
    if (stage != null) {
      into["stage"] = RaviJson.from(stage);
    }
    if (value != null) {
      into["value"] = RaviJson.from(value);
    }
  }
}

class CrmOpportunityCreateReturn {
  const CrmOpportunityCreateReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmOpportunityCreateReturn.fromJson(Map<String, Object?> json) {
    return CrmOpportunityCreateReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmOpportunityCreateReturn fromJsonValue(Object? json) {
    return CrmOpportunityCreateReturn.fromJson(raviJsonObject(json, "CrmOpportunityCreateReturn"));
  }
}

CrmOpportunityCreateReturn crmOpportunityCreateReturnFromJson(Object? json) => CrmOpportunityCreateReturn.fromJsonValue(json);

class CrmOpportunityLinkContactOptions {
  const CrmOpportunityLinkContactOptions({this.account, this.primary, this.role});

  final String? account;
  final bool? primary;
  final String? role;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (primary != null) {
      into["primary"] = RaviJson.from(primary);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
  }
}

class CrmOpportunityLinkContactReturn {
  const CrmOpportunityLinkContactReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmOpportunityLinkContactReturn.fromJson(Map<String, Object?> json) {
    return CrmOpportunityLinkContactReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmOpportunityLinkContactReturn fromJsonValue(Object? json) {
    return CrmOpportunityLinkContactReturn.fromJson(raviJsonObject(json, "CrmOpportunityLinkContactReturn"));
  }
}

CrmOpportunityLinkContactReturn crmOpportunityLinkContactReturnFromJson(Object? json) => CrmOpportunityLinkContactReturn.fromJsonValue(json);

class CrmOpportunityMoveOptions {
  const CrmOpportunityMoveOptions({this.lostReason});

  final String? lostReason;

  void encodeBody(Map<String, RaviJson> into) {
    if (lostReason != null) {
      into["lostReason"] = RaviJson.from(lostReason);
    }
  }
}

class CrmOpportunityMoveReturn {
  const CrmOpportunityMoveReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmOpportunityMoveReturn.fromJson(Map<String, Object?> json) {
    return CrmOpportunityMoveReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmOpportunityMoveReturn fromJsonValue(Object? json) {
    return CrmOpportunityMoveReturn.fromJson(raviJsonObject(json, "CrmOpportunityMoveReturn"));
  }
}

CrmOpportunityMoveReturn crmOpportunityMoveReturnFromJson(Object? json) => CrmOpportunityMoveReturn.fromJsonValue(json);

class CrmOpportunityShowReturn {
  const CrmOpportunityShowReturn({required this.opportunity, required this.target});

  final Map<String, RaviJson> opportunity;
  final String target;

  factory CrmOpportunityShowReturn.fromJson(Map<String, Object?> json) {
    return CrmOpportunityShowReturn(
      opportunity: raviJsonAsRaviJsonMap(json["opportunity"]),
      target: raviJsonAsString(json["target"]),
    );
  }

  static CrmOpportunityShowReturn fromJsonValue(Object? json) {
    return CrmOpportunityShowReturn.fromJson(raviJsonObject(json, "CrmOpportunityShowReturn"));
  }
}

CrmOpportunityShowReturn crmOpportunityShowReturnFromJson(Object? json) => CrmOpportunityShowReturn.fromJsonValue(json);

class CrmPipelineCreateOptions {
  const CrmPipelineCreateOptions({this.analystAvoid, this.analystMentions, this.analystTone, this.consumer, this.default_, this.entityType, this.hitlRequiredWhen, this.idempotencyKey, this.messagePrefix, this.messageSuffix, this.metadata, this.objetivo, this.priorityGlobal, this.producer, this.readingListId, this.reguaTag, this.relatedCron, this.relatedTrigger, this.sendWindow, this.versao, this.vipGuardAction, this.vipGuardLtv, this.vipGuardTag});

  final String? analystAvoid;
  final String? analystMentions;
  final String? analystTone;
  final String? consumer;
  final bool? default_;
  final String? entityType;
  final String? hitlRequiredWhen;
  final String? idempotencyKey;
  final String? messagePrefix;
  final String? messageSuffix;
  final String? metadata;
  final String? objetivo;
  final String? priorityGlobal;
  final String? producer;
  final String? readingListId;
  final List<String>? reguaTag;
  final String? relatedCron;
  final String? relatedTrigger;
  final String? sendWindow;
  final String? versao;
  final String? vipGuardAction;
  final String? vipGuardLtv;
  final String? vipGuardTag;

  void encodeBody(Map<String, RaviJson> into) {
    if (analystAvoid != null) {
      into["analystAvoid"] = RaviJson.from(analystAvoid);
    }
    if (analystMentions != null) {
      into["analystMentions"] = RaviJson.from(analystMentions);
    }
    if (analystTone != null) {
      into["analystTone"] = RaviJson.from(analystTone);
    }
    if (consumer != null) {
      into["consumer"] = RaviJson.from(consumer);
    }
    if (default_ != null) {
      into["default"] = RaviJson.from(default_);
    }
    if (entityType != null) {
      into["entityType"] = RaviJson.from(entityType);
    }
    if (hitlRequiredWhen != null) {
      into["hitlRequiredWhen"] = RaviJson.from(hitlRequiredWhen);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (messagePrefix != null) {
      into["messagePrefix"] = RaviJson.from(messagePrefix);
    }
    if (messageSuffix != null) {
      into["messageSuffix"] = RaviJson.from(messageSuffix);
    }
    if (metadata != null) {
      into["metadata"] = RaviJson.from(metadata);
    }
    if (objetivo != null) {
      into["objetivo"] = RaviJson.from(objetivo);
    }
    if (priorityGlobal != null) {
      into["priorityGlobal"] = RaviJson.from(priorityGlobal);
    }
    if (producer != null) {
      into["producer"] = RaviJson.from(producer);
    }
    if (readingListId != null) {
      into["readingListId"] = RaviJson.from(readingListId);
    }
    if (reguaTag != null) {
      into["reguaTag"] = RaviJson.from(reguaTag);
    }
    if (relatedCron != null) {
      into["relatedCron"] = RaviJson.from(relatedCron);
    }
    if (relatedTrigger != null) {
      into["relatedTrigger"] = RaviJson.from(relatedTrigger);
    }
    if (sendWindow != null) {
      into["sendWindow"] = RaviJson.from(sendWindow);
    }
    if (versao != null) {
      into["versao"] = RaviJson.from(versao);
    }
    if (vipGuardAction != null) {
      into["vipGuardAction"] = RaviJson.from(vipGuardAction);
    }
    if (vipGuardLtv != null) {
      into["vipGuardLtv"] = RaviJson.from(vipGuardLtv);
    }
    if (vipGuardTag != null) {
      into["vipGuardTag"] = RaviJson.from(vipGuardTag);
    }
  }
}

class CrmPipelineCreateReturn {
  const CrmPipelineCreateReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmPipelineCreateReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineCreateReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmPipelineCreateReturn fromJsonValue(Object? json) {
    return CrmPipelineCreateReturn.fromJson(raviJsonObject(json, "CrmPipelineCreateReturn"));
  }
}

CrmPipelineCreateReturn crmPipelineCreateReturnFromJson(Object? json) => CrmPipelineCreateReturn.fromJsonValue(json);

class CrmPipelineListOptions {
  const CrmPipelineListOptions({this.entityType, this.fields, this.includeArchived, this.limit, this.offset});

  final String? entityType;
  final String? fields;
  final bool? includeArchived;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (entityType != null) {
      into["entityType"] = RaviJson.from(entityType);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (includeArchived != null) {
      into["includeArchived"] = RaviJson.from(includeArchived);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class CrmPipelineListReturn {
  const CrmPipelineListReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory CrmPipelineListReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CrmPipelineListReturn fromJsonValue(Object? json) {
    return CrmPipelineListReturn.fromJson(raviJsonObject(json, "CrmPipelineListReturn"));
  }
}

CrmPipelineListReturn crmPipelineListReturnFromJson(Object? json) => CrmPipelineListReturn.fromJsonValue(json);

class CrmPipelinePolicyHitlCheckOptions {
  const CrmPipelinePolicyHitlCheckOptions({this.context});

  final String? context;

  void encodeBody(Map<String, RaviJson> into) {
    if (context != null) {
      into["context"] = RaviJson.from(context);
    }
  }
}

class CrmPipelinePolicyHitlCheckReturn {
  const CrmPipelinePolicyHitlCheckReturn({required this.decision, required this.errors, required this.ok, required this.pipelineId, required this.warnings});

  final RaviJson decision;
  final List<RaviJson> errors;
  final bool ok;
  final String pipelineId;
  final List<RaviJson> warnings;

  factory CrmPipelinePolicyHitlCheckReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelinePolicyHitlCheckReturn(
      decision: RaviJson.from(json["decision"]),
      errors: raviJsonAsList(json["errors"], RaviJson.from),
      ok: raviJsonAsBool(json["ok"]),
      pipelineId: raviJsonAsString(json["pipelineId"]),
      warnings: raviJsonAsList(json["warnings"], RaviJson.from),
    );
  }

  static CrmPipelinePolicyHitlCheckReturn fromJsonValue(Object? json) {
    return CrmPipelinePolicyHitlCheckReturn.fromJson(raviJsonObject(json, "CrmPipelinePolicyHitlCheckReturn"));
  }
}

CrmPipelinePolicyHitlCheckReturn crmPipelinePolicyHitlCheckReturnFromJson(Object? json) => CrmPipelinePolicyHitlCheckReturn.fromJsonValue(json);

class CrmPipelinePolicySendWindowCheckOptions {
  const CrmPipelinePolicySendWindowCheckOptions({this.at});

  final String? at;

  void encodeBody(Map<String, RaviJson> into) {
    if (at != null) {
      into["at"] = RaviJson.from(at);
    }
  }
}

class CrmPipelinePolicySendWindowCheckReturn {
  const CrmPipelinePolicySendWindowCheckReturn({required this.decision, required this.errors, required this.ok, required this.pipelineId, required this.warnings});

  final RaviJson decision;
  final List<RaviJson> errors;
  final bool ok;
  final String pipelineId;
  final List<RaviJson> warnings;

  factory CrmPipelinePolicySendWindowCheckReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelinePolicySendWindowCheckReturn(
      decision: RaviJson.from(json["decision"]),
      errors: raviJsonAsList(json["errors"], RaviJson.from),
      ok: raviJsonAsBool(json["ok"]),
      pipelineId: raviJsonAsString(json["pipelineId"]),
      warnings: raviJsonAsList(json["warnings"], RaviJson.from),
    );
  }

  static CrmPipelinePolicySendWindowCheckReturn fromJsonValue(Object? json) {
    return CrmPipelinePolicySendWindowCheckReturn.fromJson(raviJsonObject(json, "CrmPipelinePolicySendWindowCheckReturn"));
  }
}

CrmPipelinePolicySendWindowCheckReturn crmPipelinePolicySendWindowCheckReturnFromJson(Object? json) => CrmPipelinePolicySendWindowCheckReturn.fromJsonValue(json);

class CrmPipelineReviewReturn {
  const CrmPipelineReviewReturn({required this.fields, required this.highSeverityGaps, required this.pipelineId, required this.pipelineName, required this.totalGaps});

  final List<RaviJson> fields;
  final double highSeverityGaps;
  final String pipelineId;
  final String pipelineName;
  final double totalGaps;

  factory CrmPipelineReviewReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineReviewReturn(
      fields: raviJsonAsList(json["fields"], RaviJson.from),
      highSeverityGaps: raviJsonAsDouble(json["highSeverityGaps"]),
      pipelineId: raviJsonAsString(json["pipelineId"]),
      pipelineName: raviJsonAsString(json["pipelineName"]),
      totalGaps: raviJsonAsDouble(json["totalGaps"]),
    );
  }

  static CrmPipelineReviewReturn fromJsonValue(Object? json) {
    return CrmPipelineReviewReturn.fromJson(raviJsonObject(json, "CrmPipelineReviewReturn"));
  }
}

CrmPipelineReviewReturn crmPipelineReviewReturnFromJson(Object? json) => CrmPipelineReviewReturn.fromJsonValue(json);

class CrmPipelineSetOptions {
  const CrmPipelineSetOptions({this.analystAvoid, this.analystMentions, this.analystTone, this.consumer, this.hitlRequiredWhen, this.messagePrefix, this.messageSuffix, this.objetivo, this.priorityGlobal, this.producer, this.readingListId, this.reguaTag, this.relatedCron, this.relatedTrigger, this.sendWindow, this.versao, this.vipGuardAction, this.vipGuardLtv, this.vipGuardTag});

  final String? analystAvoid;
  final String? analystMentions;
  final String? analystTone;
  final String? consumer;
  final String? hitlRequiredWhen;
  final String? messagePrefix;
  final String? messageSuffix;
  final String? objetivo;
  final String? priorityGlobal;
  final String? producer;
  final String? readingListId;
  final List<String>? reguaTag;
  final String? relatedCron;
  final String? relatedTrigger;
  final String? sendWindow;
  final String? versao;
  final String? vipGuardAction;
  final String? vipGuardLtv;
  final String? vipGuardTag;

  void encodeBody(Map<String, RaviJson> into) {
    if (analystAvoid != null) {
      into["analystAvoid"] = RaviJson.from(analystAvoid);
    }
    if (analystMentions != null) {
      into["analystMentions"] = RaviJson.from(analystMentions);
    }
    if (analystTone != null) {
      into["analystTone"] = RaviJson.from(analystTone);
    }
    if (consumer != null) {
      into["consumer"] = RaviJson.from(consumer);
    }
    if (hitlRequiredWhen != null) {
      into["hitlRequiredWhen"] = RaviJson.from(hitlRequiredWhen);
    }
    if (messagePrefix != null) {
      into["messagePrefix"] = RaviJson.from(messagePrefix);
    }
    if (messageSuffix != null) {
      into["messageSuffix"] = RaviJson.from(messageSuffix);
    }
    if (objetivo != null) {
      into["objetivo"] = RaviJson.from(objetivo);
    }
    if (priorityGlobal != null) {
      into["priorityGlobal"] = RaviJson.from(priorityGlobal);
    }
    if (producer != null) {
      into["producer"] = RaviJson.from(producer);
    }
    if (readingListId != null) {
      into["readingListId"] = RaviJson.from(readingListId);
    }
    if (reguaTag != null) {
      into["reguaTag"] = RaviJson.from(reguaTag);
    }
    if (relatedCron != null) {
      into["relatedCron"] = RaviJson.from(relatedCron);
    }
    if (relatedTrigger != null) {
      into["relatedTrigger"] = RaviJson.from(relatedTrigger);
    }
    if (sendWindow != null) {
      into["sendWindow"] = RaviJson.from(sendWindow);
    }
    if (versao != null) {
      into["versao"] = RaviJson.from(versao);
    }
    if (vipGuardAction != null) {
      into["vipGuardAction"] = RaviJson.from(vipGuardAction);
    }
    if (vipGuardLtv != null) {
      into["vipGuardLtv"] = RaviJson.from(vipGuardLtv);
    }
    if (vipGuardTag != null) {
      into["vipGuardTag"] = RaviJson.from(vipGuardTag);
    }
  }
}

class CrmPipelineSetReturn {
  const CrmPipelineSetReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmPipelineSetReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineSetReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmPipelineSetReturn fromJsonValue(Object? json) {
    return CrmPipelineSetReturn.fromJson(raviJsonObject(json, "CrmPipelineSetReturn"));
  }
}

CrmPipelineSetReturn crmPipelineSetReturnFromJson(Object? json) => CrmPipelineSetReturn.fromJsonValue(json);

class CrmPipelineShowOptions {
  const CrmPipelineShowOptions({this.explain});

  final bool? explain;

  void encodeBody(Map<String, RaviJson> into) {
    if (explain != null) {
      into["explain"] = RaviJson.from(explain);
    }
  }
}

typedef CrmPipelineShowReturn = Map<String, RaviJson>;

CrmPipelineShowReturn crmPipelineShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class CrmPipelineStageAddOptions {
  const CrmPipelineStageAddOptions({this.category, this.idempotencyKey, this.metadata, this.name, this.order, this.probability, this.terminal});

  final String? category;
  final String? idempotencyKey;
  final String? metadata;
  final String? name;
  final String? order;
  final String? probability;
  final bool? terminal;

  void encodeBody(Map<String, RaviJson> into) {
    if (category != null) {
      into["category"] = RaviJson.from(category);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (metadata != null) {
      into["metadata"] = RaviJson.from(metadata);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (order != null) {
      into["order"] = RaviJson.from(order);
    }
    if (probability != null) {
      into["probability"] = RaviJson.from(probability);
    }
    if (terminal != null) {
      into["terminal"] = RaviJson.from(terminal);
    }
  }
}

class CrmPipelineStageAddReturn {
  const CrmPipelineStageAddReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmPipelineStageAddReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineStageAddReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmPipelineStageAddReturn fromJsonValue(Object? json) {
    return CrmPipelineStageAddReturn.fromJson(raviJsonObject(json, "CrmPipelineStageAddReturn"));
  }
}

CrmPipelineStageAddReturn crmPipelineStageAddReturnFromJson(Object? json) => CrmPipelineStageAddReturn.fromJsonValue(json);

class CrmPipelineStageArchiveReturn {
  const CrmPipelineStageArchiveReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmPipelineStageArchiveReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineStageArchiveReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmPipelineStageArchiveReturn fromJsonValue(Object? json) {
    return CrmPipelineStageArchiveReturn.fromJson(raviJsonObject(json, "CrmPipelineStageArchiveReturn"));
  }
}

CrmPipelineStageArchiveReturn crmPipelineStageArchiveReturnFromJson(Object? json) => CrmPipelineStageArchiveReturn.fromJsonValue(json);

class CrmPipelineStageListOptions {
  const CrmPipelineStageListOptions({this.includeArchived, this.limit, this.offset});

  final bool? includeArchived;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (includeArchived != null) {
      into["includeArchived"] = RaviJson.from(includeArchived);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class CrmPipelineStageListReturn {
  const CrmPipelineStageListReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory CrmPipelineStageListReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineStageListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CrmPipelineStageListReturn fromJsonValue(Object? json) {
    return CrmPipelineStageListReturn.fromJson(raviJsonObject(json, "CrmPipelineStageListReturn"));
  }
}

CrmPipelineStageListReturn crmPipelineStageListReturnFromJson(Object? json) => CrmPipelineStageListReturn.fromJsonValue(json);

class CrmPipelineStageSetReturn {
  const CrmPipelineStageSetReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmPipelineStageSetReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineStageSetReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmPipelineStageSetReturn fromJsonValue(Object? json) {
    return CrmPipelineStageSetReturn.fromJson(raviJsonObject(json, "CrmPipelineStageSetReturn"));
  }
}

CrmPipelineStageSetReturn crmPipelineStageSetReturnFromJson(Object? json) => CrmPipelineStageSetReturn.fromJsonValue(json);

typedef CrmPipelineStageShowReturn = Map<String, RaviJson>;

CrmPipelineStageShowReturn crmPipelineStageShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class CrmPipelineStageTopicAddOptions {
  const CrmPipelineStageTopicAddOptions({this.description, this.idempotencyKey, this.metadata, this.order, this.title, this.type});

  final String? description;
  final String? idempotencyKey;
  final String? metadata;
  final String? order;
  final String? title;
  final String? type;

  void encodeBody(Map<String, RaviJson> into) {
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (metadata != null) {
      into["metadata"] = RaviJson.from(metadata);
    }
    if (order != null) {
      into["order"] = RaviJson.from(order);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
    if (type != null) {
      into["type"] = RaviJson.from(type);
    }
  }
}

class CrmPipelineStageTopicAddReturn {
  const CrmPipelineStageTopicAddReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmPipelineStageTopicAddReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineStageTopicAddReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmPipelineStageTopicAddReturn fromJsonValue(Object? json) {
    return CrmPipelineStageTopicAddReturn.fromJson(raviJsonObject(json, "CrmPipelineStageTopicAddReturn"));
  }
}

CrmPipelineStageTopicAddReturn crmPipelineStageTopicAddReturnFromJson(Object? json) => CrmPipelineStageTopicAddReturn.fromJsonValue(json);

class CrmPipelineStageTopicArchiveReturn {
  const CrmPipelineStageTopicArchiveReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmPipelineStageTopicArchiveReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineStageTopicArchiveReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmPipelineStageTopicArchiveReturn fromJsonValue(Object? json) {
    return CrmPipelineStageTopicArchiveReturn.fromJson(raviJsonObject(json, "CrmPipelineStageTopicArchiveReturn"));
  }
}

CrmPipelineStageTopicArchiveReturn crmPipelineStageTopicArchiveReturnFromJson(Object? json) => CrmPipelineStageTopicArchiveReturn.fromJsonValue(json);

class CrmPipelineStageTopicSetReturn {
  const CrmPipelineStageTopicSetReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmPipelineStageTopicSetReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineStageTopicSetReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmPipelineStageTopicSetReturn fromJsonValue(Object? json) {
    return CrmPipelineStageTopicSetReturn.fromJson(raviJsonObject(json, "CrmPipelineStageTopicSetReturn"));
  }
}

CrmPipelineStageTopicSetReturn crmPipelineStageTopicSetReturnFromJson(Object? json) => CrmPipelineStageTopicSetReturn.fromJsonValue(json);

class CrmPipelineStageTopicsOptions {
  const CrmPipelineStageTopicsOptions({this.includeArchived, this.limit, this.offset});

  final bool? includeArchived;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (includeArchived != null) {
      into["includeArchived"] = RaviJson.from(includeArchived);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class CrmPipelineStageTopicsReturn {
  const CrmPipelineStageTopicsReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory CrmPipelineStageTopicsReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineStageTopicsReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CrmPipelineStageTopicsReturn fromJsonValue(Object? json) {
    return CrmPipelineStageTopicsReturn.fromJson(raviJsonObject(json, "CrmPipelineStageTopicsReturn"));
  }
}

CrmPipelineStageTopicsReturn crmPipelineStageTopicsReturnFromJson(Object? json) => CrmPipelineStageTopicsReturn.fromJsonValue(json);

class CrmPipelineValidateOptions {
  const CrmPipelineValidateOptions({this.schemaJson});

  final bool? schemaJson;

  void encodeBody(Map<String, RaviJson> into) {
    if (schemaJson != null) {
      into["schemaJson"] = RaviJson.from(schemaJson);
    }
  }
}

class CrmPipelineValidateReturn {
  const CrmPipelineValidateReturn({required this.errors, required this.ok, required this.pipelineId, this.schema, required this.warnings});

  final List<RaviJson> errors;
  final bool ok;
  final String pipelineId;
  final Map<String, RaviJson>? schema;
  final List<RaviJson> warnings;

  factory CrmPipelineValidateReturn.fromJson(Map<String, Object?> json) {
    return CrmPipelineValidateReturn(
      errors: raviJsonAsList(json["errors"], RaviJson.from),
      ok: raviJsonAsBool(json["ok"]),
      pipelineId: raviJsonAsString(json["pipelineId"]),
      schema: json["schema"] == null ? null : raviJsonAsRaviJsonMap(json["schema"]),
      warnings: raviJsonAsList(json["warnings"], RaviJson.from),
    );
  }

  static CrmPipelineValidateReturn fromJsonValue(Object? json) {
    return CrmPipelineValidateReturn.fromJson(raviJsonObject(json, "CrmPipelineValidateReturn"));
  }
}

CrmPipelineValidateReturn crmPipelineValidateReturnFromJson(Object? json) => CrmPipelineValidateReturn.fromJsonValue(json);

class CrmTaskCancelOptions {
  const CrmTaskCancelOptions({this.reason});

  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

class CrmTaskCancelReturn {
  const CrmTaskCancelReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmTaskCancelReturn.fromJson(Map<String, Object?> json) {
    return CrmTaskCancelReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmTaskCancelReturn fromJsonValue(Object? json) {
    return CrmTaskCancelReturn.fromJson(raviJsonObject(json, "CrmTaskCancelReturn"));
  }
}

CrmTaskCancelReturn crmTaskCancelReturnFromJson(Object? json) => CrmTaskCancelReturn.fromJsonValue(json);

class CrmTaskCreateOptions {
  const CrmTaskCreateOptions({this.account, this.body, this.confidence, this.contact, this.due, this.evidence, this.idempotencyKey, this.metadata, this.opportunity, this.owner, this.priority, this.source, this.taskType});

  final String? account;
  final String? body;
  final String? confidence;
  final String? contact;
  final String? due;
  final String? evidence;
  final String? idempotencyKey;
  final String? metadata;
  final String? opportunity;
  final String? owner;
  final String? priority;
  final String? source;
  final String? taskType;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (body != null) {
      into["body"] = RaviJson.from(body);
    }
    if (confidence != null) {
      into["confidence"] = RaviJson.from(confidence);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (due != null) {
      into["due"] = RaviJson.from(due);
    }
    if (evidence != null) {
      into["evidence"] = RaviJson.from(evidence);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (metadata != null) {
      into["metadata"] = RaviJson.from(metadata);
    }
    if (opportunity != null) {
      into["opportunity"] = RaviJson.from(opportunity);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
    if (taskType != null) {
      into["taskType"] = RaviJson.from(taskType);
    }
  }
}

class CrmTaskCreateReturn {
  const CrmTaskCreateReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmTaskCreateReturn.fromJson(Map<String, Object?> json) {
    return CrmTaskCreateReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmTaskCreateReturn fromJsonValue(Object? json) {
    return CrmTaskCreateReturn.fromJson(raviJsonObject(json, "CrmTaskCreateReturn"));
  }
}

CrmTaskCreateReturn crmTaskCreateReturnFromJson(Object? json) => CrmTaskCreateReturn.fromJsonValue(json);

class CrmTaskDoneReturn {
  const CrmTaskDoneReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmTaskDoneReturn.fromJson(Map<String, Object?> json) {
    return CrmTaskDoneReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmTaskDoneReturn fromJsonValue(Object? json) {
    return CrmTaskDoneReturn.fromJson(raviJsonObject(json, "CrmTaskDoneReturn"));
  }
}

CrmTaskDoneReturn crmTaskDoneReturnFromJson(Object? json) => CrmTaskDoneReturn.fromJsonValue(json);

class CrmTaskListOptions {
  const CrmTaskListOptions({this.account, this.contact, this.dueAfter, this.dueBefore, this.dueToday, this.limit, this.offset, this.opportunity, this.owner, this.status, this.taskType});

  final String? account;
  final String? contact;
  final String? dueAfter;
  final String? dueBefore;
  final bool? dueToday;
  final String? limit;
  final String? offset;
  final String? opportunity;
  final String? owner;
  final String? status;
  final String? taskType;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (dueAfter != null) {
      into["dueAfter"] = RaviJson.from(dueAfter);
    }
    if (dueBefore != null) {
      into["dueBefore"] = RaviJson.from(dueBefore);
    }
    if (dueToday != null) {
      into["dueToday"] = RaviJson.from(dueToday);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (opportunity != null) {
      into["opportunity"] = RaviJson.from(opportunity);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (taskType != null) {
      into["taskType"] = RaviJson.from(taskType);
    }
  }
}

class CrmTaskListReturn {
  const CrmTaskListReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory CrmTaskListReturn.fromJson(Map<String, Object?> json) {
    return CrmTaskListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CrmTaskListReturn fromJsonValue(Object? json) {
    return CrmTaskListReturn.fromJson(raviJsonObject(json, "CrmTaskListReturn"));
  }
}

CrmTaskListReturn crmTaskListReturnFromJson(Object? json) => CrmTaskListReturn.fromJsonValue(json);

class CrmTaskShowReturn {
  const CrmTaskShowReturn({required this.target, required this.task});

  final String target;
  final Map<String, RaviJson> task;

  factory CrmTaskShowReturn.fromJson(Map<String, Object?> json) {
    return CrmTaskShowReturn(
      target: raviJsonAsString(json["target"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static CrmTaskShowReturn fromJsonValue(Object? json) {
    return CrmTaskShowReturn.fromJson(raviJsonObject(json, "CrmTaskShowReturn"));
  }
}

CrmTaskShowReturn crmTaskShowReturnFromJson(Object? json) => CrmTaskShowReturn.fromJsonValue(json);

class CrmTaskSnoozeOptions {
  const CrmTaskSnoozeOptions({this.reason, this.until});

  final String? reason;
  final String? until;

  void encodeBody(Map<String, RaviJson> into) {
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
    if (until != null) {
      into["until"] = RaviJson.from(until);
    }
  }
}

class CrmTaskSnoozeReturn {
  const CrmTaskSnoozeReturn({required this.changedCount, required this.status});

  final double changedCount;
  final String status;

  factory CrmTaskSnoozeReturn.fromJson(Map<String, Object?> json) {
    return CrmTaskSnoozeReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static CrmTaskSnoozeReturn fromJsonValue(Object? json) {
    return CrmTaskSnoozeReturn.fromJson(raviJsonObject(json, "CrmTaskSnoozeReturn"));
  }
}

CrmTaskSnoozeReturn crmTaskSnoozeReturnFromJson(Object? json) => CrmTaskSnoozeReturn.fromJsonValue(json);

class CronAddOptions {
  const CronAddOptions({this.account, this.agent, this.at, this.cron, this.deleteAfter, this.description, this.envFile, this.every, this.exec, this.idempotencyKey, this.isolated, this.message, this.onError, this.shell, this.timeout, this.tz});

  final String? account;
  final String? agent;
  final String? at;
  final String? cron;
  final bool? deleteAfter;
  final String? description;
  final String? envFile;
  final String? every;
  final String? exec;
  final String? idempotencyKey;
  final bool? isolated;
  final String? message;
  final String? onError;
  final String? shell;
  final String? timeout;
  final String? tz;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (at != null) {
      into["at"] = RaviJson.from(at);
    }
    if (cron != null) {
      into["cron"] = RaviJson.from(cron);
    }
    if (deleteAfter != null) {
      into["deleteAfter"] = RaviJson.from(deleteAfter);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (envFile != null) {
      into["envFile"] = RaviJson.from(envFile);
    }
    if (every != null) {
      into["every"] = RaviJson.from(every);
    }
    if (exec != null) {
      into["exec"] = RaviJson.from(exec);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (isolated != null) {
      into["isolated"] = RaviJson.from(isolated);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (onError != null) {
      into["onError"] = RaviJson.from(onError);
    }
    if (shell != null) {
      into["shell"] = RaviJson.from(shell);
    }
    if (timeout != null) {
      into["timeout"] = RaviJson.from(timeout);
    }
    if (tz != null) {
      into["tz"] = RaviJson.from(tz);
    }
  }
}

class CronAddReturn {
  const CronAddReturn({required this.changedCount, required this.job, required this.status, required this.target});

  final double changedCount;
  final RaviJson job;
  final String status;
  final RaviJson target;

  factory CronAddReturn.fromJson(Map<String, Object?> json) {
    return CronAddReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      job: RaviJson.from(json["job"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static CronAddReturn fromJsonValue(Object? json) {
    return CronAddReturn.fromJson(raviJsonObject(json, "CronAddReturn"));
  }
}

CronAddReturn cronAddReturnFromJson(Object? json) => CronAddReturn.fromJsonValue(json);

class CronDisableReturn {
  const CronDisableReturn({required this.changedCount, required this.job, required this.status, required this.target});

  final double changedCount;
  final RaviJson job;
  final String status;
  final RaviJson target;

  factory CronDisableReturn.fromJson(Map<String, Object?> json) {
    return CronDisableReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      job: RaviJson.from(json["job"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static CronDisableReturn fromJsonValue(Object? json) {
    return CronDisableReturn.fromJson(raviJsonObject(json, "CronDisableReturn"));
  }
}

CronDisableReturn cronDisableReturnFromJson(Object? json) => CronDisableReturn.fromJsonValue(json);

class CronEnableReturn {
  const CronEnableReturn({required this.changedCount, required this.job, required this.status, required this.target});

  final double changedCount;
  final RaviJson job;
  final String status;
  final RaviJson target;

  factory CronEnableReturn.fromJson(Map<String, Object?> json) {
    return CronEnableReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      job: RaviJson.from(json["job"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static CronEnableReturn fromJsonValue(Object? json) {
    return CronEnableReturn.fromJson(raviJsonObject(json, "CronEnableReturn"));
  }
}

CronEnableReturn cronEnableReturnFromJson(Object? json) => CronEnableReturn.fromJsonValue(json);

class CronListOptions {
  const CronListOptions({this.agent, this.allAgents, this.fields, this.limit, this.offset, this.tag});

  final String? agent;
  final bool? allAgents;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (allAgents != null) {
      into["allAgents"] = RaviJson.from(allAgents);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class CronListReturn {
  const CronListReturn({required this.items, required this.jobs, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final List<Map<String, RaviJson>> jobs;
  final RaviJson pagination;
  final double total;

  factory CronListReturn.fromJson(Map<String, Object?> json) {
    return CronListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      jobs: raviJsonAsList(json["jobs"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static CronListReturn fromJsonValue(Object? json) {
    return CronListReturn.fromJson(raviJsonObject(json, "CronListReturn"));
  }
}

CronListReturn cronListReturnFromJson(Object? json) => CronListReturn.fromJsonValue(json);

class CronRmOptions {
  const CronRmOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class CronRmReturn {
  const CronRmReturn({required this.changedCount, required this.job, required this.status, required this.target});

  final double changedCount;
  final RaviJson job;
  final String status;
  final RaviJson target;

  factory CronRmReturn.fromJson(Map<String, Object?> json) {
    return CronRmReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      job: RaviJson.from(json["job"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static CronRmReturn fromJsonValue(Object? json) {
    return CronRmReturn.fromJson(raviJsonObject(json, "CronRmReturn"));
  }
}

CronRmReturn cronRmReturnFromJson(Object? json) => CronRmReturn.fromJsonValue(json);

class CronRunOptions {
  const CronRunOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class CronRunReturn {
  const CronRunReturn({required this.changedCount, required this.job, required this.status, required this.target});

  final double changedCount;
  final RaviJson job;
  final String status;
  final RaviJson target;

  factory CronRunReturn.fromJson(Map<String, Object?> json) {
    return CronRunReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      job: RaviJson.from(json["job"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static CronRunReturn fromJsonValue(Object? json) {
    return CronRunReturn.fromJson(raviJsonObject(json, "CronRunReturn"));
  }
}

CronRunReturn cronRunReturnFromJson(Object? json) => CronRunReturn.fromJsonValue(json);

class CronSetReturn {
  const CronSetReturn({required this.changedCount, required this.job, required this.status, required this.target});

  final double changedCount;
  final RaviJson job;
  final String status;
  final RaviJson target;

  factory CronSetReturn.fromJson(Map<String, Object?> json) {
    return CronSetReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      job: RaviJson.from(json["job"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static CronSetReturn fromJsonValue(Object? json) {
    return CronSetReturn.fromJson(raviJsonObject(json, "CronSetReturn"));
  }
}

CronSetReturn cronSetReturnFromJson(Object? json) => CronSetReturn.fromJsonValue(json);

class CronShowReturn {
  const CronShowReturn({required this.job});

  final Map<String, RaviJson> job;

  factory CronShowReturn.fromJson(Map<String, Object?> json) {
    return CronShowReturn(
      job: raviJsonAsRaviJsonMap(json["job"]),
    );
  }

  static CronShowReturn fromJsonValue(Object? json) {
    return CronShowReturn.fromJson(raviJsonObject(json, "CronShowReturn"));
  }
}

CronShowReturn cronShowReturnFromJson(Object? json) => CronShowReturn.fromJsonValue(json);

class DaemonEnvReturn {
  const DaemonEnvReturn({required this.action, required this.created, required this.existedBefore, required this.openedEditor, required this.path});

  final String action;
  final bool created;
  final bool existedBefore;
  final bool openedEditor;
  final String path;

  factory DaemonEnvReturn.fromJson(Map<String, Object?> json) {
    return DaemonEnvReturn(
      action: raviJsonAsString(json["action"]),
      created: raviJsonAsBool(json["created"]),
      existedBefore: raviJsonAsBool(json["existedBefore"]),
      openedEditor: raviJsonAsBool(json["openedEditor"]),
      path: raviJsonAsString(json["path"]),
    );
  }

  static DaemonEnvReturn fromJsonValue(Object? json) {
    return DaemonEnvReturn.fromJson(raviJsonObject(json, "DaemonEnvReturn"));
  }
}

DaemonEnvReturn daemonEnvReturnFromJson(Object? json) => DaemonEnvReturn.fromJsonValue(json);

class DaemonInitAdminKeyOptions {
  const DaemonInitAdminKeyOptions({this.fromEnv, this.label, this.noStore, this.printOnly});

  final bool? fromEnv;
  final String? label;
  final bool? noStore;
  final bool? printOnly;

  void encodeBody(Map<String, RaviJson> into) {
    if (fromEnv != null) {
      into["fromEnv"] = RaviJson.from(fromEnv);
    }
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (noStore != null) {
      into["noStore"] = RaviJson.from(noStore);
    }
    if (printOnly != null) {
      into["printOnly"] = RaviJson.from(printOnly);
    }
  }
}

class DaemonInitAdminKeyReturn {
  const DaemonInitAdminKeyReturn({required this.action, required this.changed});

  final String action;
  final bool changed;

  factory DaemonInitAdminKeyReturn.fromJson(Map<String, Object?> json) {
    return DaemonInitAdminKeyReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
    );
  }

  static DaemonInitAdminKeyReturn fromJsonValue(Object? json) {
    return DaemonInitAdminKeyReturn.fromJson(raviJsonObject(json, "DaemonInitAdminKeyReturn"));
  }
}

DaemonInitAdminKeyReturn daemonInitAdminKeyReturnFromJson(Object? json) => DaemonInitAdminKeyReturn.fromJsonValue(json);

class DaemonInstallReturn {
  const DaemonInstallReturn({required this.action, required this.changed});

  final String action;
  final bool changed;

  factory DaemonInstallReturn.fromJson(Map<String, Object?> json) {
    return DaemonInstallReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
    );
  }

  static DaemonInstallReturn fromJsonValue(Object? json) {
    return DaemonInstallReturn.fromJson(raviJsonObject(json, "DaemonInstallReturn"));
  }
}

DaemonInstallReturn daemonInstallReturnFromJson(Object? json) => DaemonInstallReturn.fromJsonValue(json);

class DaemonLogsOptions {
  const DaemonLogsOptions({this.clear, this.execute, this.follow, this.path, this.tail});

  final bool? clear;
  final bool? execute;
  final bool? follow;
  final bool? path;
  final String? tail;

  void encodeBody(Map<String, RaviJson> into) {
    if (clear != null) {
      into["clear"] = RaviJson.from(clear);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (follow != null) {
      into["follow"] = RaviJson.from(follow);
    }
    if (path != null) {
      into["path"] = RaviJson.from(path);
    }
    if (tail != null) {
      into["tail"] = RaviJson.from(tail);
    }
  }
}

class DaemonLogsReturn {
  const DaemonLogsReturn({required this.action});

  final String action;

  factory DaemonLogsReturn.fromJson(Map<String, Object?> json) {
    return DaemonLogsReturn(
      action: raviJsonAsString(json["action"]),
    );
  }

  static DaemonLogsReturn fromJsonValue(Object? json) {
    return DaemonLogsReturn.fromJson(raviJsonObject(json, "DaemonLogsReturn"));
  }
}

DaemonLogsReturn daemonLogsReturnFromJson(Object? json) => DaemonLogsReturn.fromJsonValue(json);

class DaemonRestartOptions {
  const DaemonRestartOptions({this.build, this.message});

  final bool? build;
  final String? message;

  void encodeBody(Map<String, RaviJson> into) {
    if (build != null) {
      into["build"] = RaviJson.from(build);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
  }
}

class DaemonRestartReturn {
  const DaemonRestartReturn({required this.action, required this.changed});

  final String action;
  final bool changed;

  factory DaemonRestartReturn.fromJson(Map<String, Object?> json) {
    return DaemonRestartReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
    );
  }

  static DaemonRestartReturn fromJsonValue(Object? json) {
    return DaemonRestartReturn.fromJson(raviJsonObject(json, "DaemonRestartReturn"));
  }
}

DaemonRestartReturn daemonRestartReturnFromJson(Object? json) => DaemonRestartReturn.fromJsonValue(json);

class DaemonStartReturn {
  const DaemonStartReturn({required this.action, required this.changed});

  final String action;
  final bool changed;

  factory DaemonStartReturn.fromJson(Map<String, Object?> json) {
    return DaemonStartReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
    );
  }

  static DaemonStartReturn fromJsonValue(Object? json) {
    return DaemonStartReturn.fromJson(raviJsonObject(json, "DaemonStartReturn"));
  }
}

DaemonStartReturn daemonStartReturnFromJson(Object? json) => DaemonStartReturn.fromJsonValue(json);

class DaemonStatusReturn {
  const DaemonStatusReturn({required this.infrastructure, required this.pm2Available, required this.processName, required this.processes, required this.ravi, required this.runtime});

  final Map<String, RaviJson> infrastructure;
  final bool pm2Available;
  final String processName;
  final List<Map<String, RaviJson>> processes;
  final Map<String, RaviJson> ravi;
  final RaviJson runtime;

  factory DaemonStatusReturn.fromJson(Map<String, Object?> json) {
    return DaemonStatusReturn(
      infrastructure: raviJsonAsRaviJsonMap(json["infrastructure"]),
      pm2Available: raviJsonAsBool(json["pm2Available"]),
      processName: raviJsonAsString(json["processName"]),
      processes: raviJsonAsList(json["processes"], raviJsonAsRaviJsonMap),
      ravi: raviJsonAsRaviJsonMap(json["ravi"]),
      runtime: RaviJson.from(json["runtime"]),
    );
  }

  static DaemonStatusReturn fromJsonValue(Object? json) {
    return DaemonStatusReturn.fromJson(raviJsonObject(json, "DaemonStatusReturn"));
  }
}

DaemonStatusReturn daemonStatusReturnFromJson(Object? json) => DaemonStatusReturn.fromJsonValue(json);

class DaemonStopReturn {
  const DaemonStopReturn({required this.action, required this.changed});

  final String action;
  final bool changed;

  factory DaemonStopReturn.fromJson(Map<String, Object?> json) {
    return DaemonStopReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
    );
  }

  static DaemonStopReturn fromJsonValue(Object? json) {
    return DaemonStopReturn.fromJson(raviJsonObject(json, "DaemonStopReturn"));
  }
}

DaemonStopReturn daemonStopReturnFromJson(Object? json) => DaemonStopReturn.fromJsonValue(json);

class DaemonUninstallReturn {
  const DaemonUninstallReturn({required this.action, required this.changed});

  final String action;
  final bool changed;

  factory DaemonUninstallReturn.fromJson(Map<String, Object?> json) {
    return DaemonUninstallReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
    );
  }

  static DaemonUninstallReturn fromJsonValue(Object? json) {
    return DaemonUninstallReturn.fromJson(raviJsonObject(json, "DaemonUninstallReturn"));
  }
}

DaemonUninstallReturn daemonUninstallReturnFromJson(Object? json) => DaemonUninstallReturn.fromJsonValue(json);

class DevinAuthCheckReturn {
  const DevinAuthCheckReturn({required this.baseUrl, this.configuredOrgId, required this.ok, required this.self});

  final String baseUrl;
  final String? configuredOrgId;
  final bool ok;
  final RaviJson self;

  factory DevinAuthCheckReturn.fromJson(Map<String, Object?> json) {
    return DevinAuthCheckReturn(
      baseUrl: raviJsonAsString(json["baseUrl"]),
      configuredOrgId: json["configuredOrgId"] == null ? null : raviJsonAsString(json["configuredOrgId"]),
      ok: raviJsonAsBool(json["ok"]),
      self: RaviJson.from(json["self"]),
    );
  }

  static DevinAuthCheckReturn fromJsonValue(Object? json) {
    return DevinAuthCheckReturn.fromJson(raviJsonObject(json, "DevinAuthCheckReturn"));
  }
}

DevinAuthCheckReturn devinAuthCheckReturnFromJson(Object? json) => DevinAuthCheckReturn.fromJsonValue(json);

class DevinSessionsArchiveOptions {
  const DevinSessionsArchiveOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class DevinSessionsArchiveReturn {
  const DevinSessionsArchiveReturn({required this.session, required this.status});

  final RaviJson session;
  final String status;

  factory DevinSessionsArchiveReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsArchiveReturn(
      session: RaviJson.from(json["session"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static DevinSessionsArchiveReturn fromJsonValue(Object? json) {
    return DevinSessionsArchiveReturn.fromJson(raviJsonObject(json, "DevinSessionsArchiveReturn"));
  }
}

DevinSessionsArchiveReturn devinSessionsArchiveReturnFromJson(Object? json) => DevinSessionsArchiveReturn.fromJsonValue(json);

class DevinSessionsAttachmentsOptions {
  const DevinSessionsAttachmentsOptions({this.cached});

  final bool? cached;

  void encodeBody(Map<String, RaviJson> into) {
    if (cached != null) {
      into["cached"] = RaviJson.from(cached);
    }
  }
}

class DevinSessionsAttachmentsReturn {
  const DevinSessionsAttachmentsReturn({required this.attachments, required this.devinId, required this.total});

  final List<RaviJson> attachments;
  final String devinId;
  final double total;

  factory DevinSessionsAttachmentsReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsAttachmentsReturn(
      attachments: raviJsonAsList(json["attachments"], RaviJson.from),
      devinId: raviJsonAsString(json["devinId"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static DevinSessionsAttachmentsReturn fromJsonValue(Object? json) {
    return DevinSessionsAttachmentsReturn.fromJson(raviJsonObject(json, "DevinSessionsAttachmentsReturn"));
  }
}

DevinSessionsAttachmentsReturn devinSessionsAttachmentsReturnFromJson(Object? json) => DevinSessionsAttachmentsReturn.fromJsonValue(json);

class DevinSessionsCreateOptions {
  const DevinSessionsCreateOptions({this.advancedMode, this.asUser, this.attachmentUrl, this.bypassApproval, this.childPlaybook, this.devinId, this.devinMode, this.execute, this.knowledge, this.maxAcu, this.noMaxAcuLimit, this.noResumable, this.platform, this.playbook, this.project, this.prompt, this.promptFile, this.proxRun, this.repo, this.resumable, this.secret, this.sessionLink, this.sessionSecret, this.structuredOutputRequired, this.structuredOutputSchema, this.tag, this.task, this.title});

  final String? advancedMode;
  final String? asUser;
  final List<String>? attachmentUrl;
  final bool? bypassApproval;
  final String? childPlaybook;
  final String? devinId;
  final String? devinMode;
  final bool? execute;
  final List<String>? knowledge;
  final String? maxAcu;
  final bool? noMaxAcuLimit;
  final bool? noResumable;
  final String? platform;
  final String? playbook;
  final String? project;
  final String? prompt;
  final String? promptFile;
  final String? proxRun;
  final List<String>? repo;
  final bool? resumable;
  final List<String>? secret;
  final List<String>? sessionLink;
  final List<String>? sessionSecret;
  final bool? structuredOutputRequired;
  final String? structuredOutputSchema;
  final List<String>? tag;
  final String? task;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (advancedMode != null) {
      into["advancedMode"] = RaviJson.from(advancedMode);
    }
    if (asUser != null) {
      into["asUser"] = RaviJson.from(asUser);
    }
    if (attachmentUrl != null) {
      into["attachmentUrl"] = RaviJson.from(attachmentUrl);
    }
    if (bypassApproval != null) {
      into["bypassApproval"] = RaviJson.from(bypassApproval);
    }
    if (childPlaybook != null) {
      into["childPlaybook"] = RaviJson.from(childPlaybook);
    }
    if (devinId != null) {
      into["devinId"] = RaviJson.from(devinId);
    }
    if (devinMode != null) {
      into["devinMode"] = RaviJson.from(devinMode);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (knowledge != null) {
      into["knowledge"] = RaviJson.from(knowledge);
    }
    if (maxAcu != null) {
      into["maxAcu"] = RaviJson.from(maxAcu);
    }
    if (noMaxAcuLimit != null) {
      into["noMaxAcuLimit"] = RaviJson.from(noMaxAcuLimit);
    }
    if (noResumable != null) {
      into["noResumable"] = RaviJson.from(noResumable);
    }
    if (platform != null) {
      into["platform"] = RaviJson.from(platform);
    }
    if (playbook != null) {
      into["playbook"] = RaviJson.from(playbook);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (prompt != null) {
      into["prompt"] = RaviJson.from(prompt);
    }
    if (promptFile != null) {
      into["promptFile"] = RaviJson.from(promptFile);
    }
    if (proxRun != null) {
      into["proxRun"] = RaviJson.from(proxRun);
    }
    if (repo != null) {
      into["repo"] = RaviJson.from(repo);
    }
    if (resumable != null) {
      into["resumable"] = RaviJson.from(resumable);
    }
    if (secret != null) {
      into["secret"] = RaviJson.from(secret);
    }
    if (sessionLink != null) {
      into["sessionLink"] = RaviJson.from(sessionLink);
    }
    if (sessionSecret != null) {
      into["sessionSecret"] = RaviJson.from(sessionSecret);
    }
    if (structuredOutputRequired != null) {
      into["structuredOutputRequired"] = RaviJson.from(structuredOutputRequired);
    }
    if (structuredOutputSchema != null) {
      into["structuredOutputSchema"] = RaviJson.from(structuredOutputSchema);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class DevinSessionsCreateReturn {
  const DevinSessionsCreateReturn({this.devinMode, required this.maxAcuLimit, required this.maxAcuLimitSource, this.platform, this.resumable, required this.session, required this.status});

  final RaviJson? devinMode;
  final RaviJson maxAcuLimit;
  final String maxAcuLimitSource;
  final RaviJson? platform;
  final RaviJson? resumable;
  final RaviJson session;
  final String status;

  factory DevinSessionsCreateReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsCreateReturn(
      devinMode: json["devinMode"] == null ? null : RaviJson.from(json["devinMode"]),
      maxAcuLimit: RaviJson.from(json["maxAcuLimit"]),
      maxAcuLimitSource: raviJsonAsString(json["maxAcuLimitSource"]),
      platform: json["platform"] == null ? null : RaviJson.from(json["platform"]),
      resumable: json["resumable"] == null ? null : RaviJson.from(json["resumable"]),
      session: RaviJson.from(json["session"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static DevinSessionsCreateReturn fromJsonValue(Object? json) {
    return DevinSessionsCreateReturn.fromJson(raviJsonObject(json, "DevinSessionsCreateReturn"));
  }
}

DevinSessionsCreateReturn devinSessionsCreateReturnFromJson(Object? json) => DevinSessionsCreateReturn.fromJsonValue(json);

class DevinSessionsInsightsOptions {
  const DevinSessionsInsightsOptions({this.execute, this.generate});

  final bool? execute;
  final bool? generate;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (generate != null) {
      into["generate"] = RaviJson.from(generate);
    }
  }
}

class DevinSessionsInsightsReturn {
  const DevinSessionsInsightsReturn({required this.insights, required this.session, required this.summary});

  final RaviJson insights;
  final RaviJson session;
  final RaviJson summary;

  factory DevinSessionsInsightsReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsInsightsReturn(
      insights: RaviJson.from(json["insights"]),
      session: RaviJson.from(json["session"]),
      summary: RaviJson.from(json["summary"]),
    );
  }

  static DevinSessionsInsightsReturn fromJsonValue(Object? json) {
    return DevinSessionsInsightsReturn.fromJson(raviJsonObject(json, "DevinSessionsInsightsReturn"));
  }
}

DevinSessionsInsightsReturn devinSessionsInsightsReturnFromJson(Object? json) => DevinSessionsInsightsReturn.fromJsonValue(json);

class DevinSessionsListOptions {
  const DevinSessionsListOptions({this.fields, this.limit, this.offset, this.remote, this.status, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final bool? remote;
  final String? status;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (remote != null) {
      into["remote"] = RaviJson.from(remote);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class DevinSessionsListReturn {
  const DevinSessionsListReturn({this.hasNextPage, required this.items, required this.pagination, required this.sessions, required this.source, required this.total});

  final bool? hasNextPage;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<RaviJson> sessions;
  final String source;
  final double total;

  factory DevinSessionsListReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsListReturn(
      hasNextPage: json["hasNextPage"] == null ? null : raviJsonAsBool(json["hasNextPage"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      sessions: raviJsonAsList(json["sessions"], RaviJson.from),
      source: raviJsonAsString(json["source"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static DevinSessionsListReturn fromJsonValue(Object? json) {
    return DevinSessionsListReturn.fromJson(raviJsonObject(json, "DevinSessionsListReturn"));
  }
}

DevinSessionsListReturn devinSessionsListReturnFromJson(Object? json) => DevinSessionsListReturn.fromJsonValue(json);

class DevinSessionsMessagesOptions {
  const DevinSessionsMessagesOptions({this.cached});

  final bool? cached;

  void encodeBody(Map<String, RaviJson> into) {
    if (cached != null) {
      into["cached"] = RaviJson.from(cached);
    }
  }
}

class DevinSessionsMessagesReturn {
  const DevinSessionsMessagesReturn({required this.devinId, required this.messages, required this.total});

  final String devinId;
  final List<RaviJson> messages;
  final double total;

  factory DevinSessionsMessagesReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsMessagesReturn(
      devinId: raviJsonAsString(json["devinId"]),
      messages: raviJsonAsList(json["messages"], RaviJson.from),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static DevinSessionsMessagesReturn fromJsonValue(Object? json) {
    return DevinSessionsMessagesReturn.fromJson(raviJsonObject(json, "DevinSessionsMessagesReturn"));
  }
}

DevinSessionsMessagesReturn devinSessionsMessagesReturnFromJson(Object? json) => DevinSessionsMessagesReturn.fromJsonValue(json);

class DevinSessionsSendOptions {
  const DevinSessionsSendOptions({this.asUser, this.execute});

  final String? asUser;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (asUser != null) {
      into["asUser"] = RaviJson.from(asUser);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class DevinSessionsSendReturn {
  const DevinSessionsSendReturn({required this.session, required this.status});

  final RaviJson session;
  final String status;

  factory DevinSessionsSendReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsSendReturn(
      session: RaviJson.from(json["session"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static DevinSessionsSendReturn fromJsonValue(Object? json) {
    return DevinSessionsSendReturn.fromJson(raviJsonObject(json, "DevinSessionsSendReturn"));
  }
}

DevinSessionsSendReturn devinSessionsSendReturnFromJson(Object? json) => DevinSessionsSendReturn.fromJsonValue(json);

class DevinSessionsShowOptions {
  const DevinSessionsShowOptions({this.sync});

  final bool? sync;

  void encodeBody(Map<String, RaviJson> into) {
    if (sync != null) {
      into["sync"] = RaviJson.from(sync);
    }
  }
}

class DevinSessionsShowReturn {
  const DevinSessionsShowReturn({required this.session});

  final RaviJson session;

  factory DevinSessionsShowReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsShowReturn(
      session: RaviJson.from(json["session"]),
    );
  }

  static DevinSessionsShowReturn fromJsonValue(Object? json) {
    return DevinSessionsShowReturn.fromJson(raviJsonObject(json, "DevinSessionsShowReturn"));
  }
}

DevinSessionsShowReturn devinSessionsShowReturnFromJson(Object? json) => DevinSessionsShowReturn.fromJsonValue(json);

class DevinSessionsSyncOptions {
  const DevinSessionsSyncOptions({this.artifacts, this.insights});

  final bool? artifacts;
  final bool? insights;

  void encodeBody(Map<String, RaviJson> into) {
    if (artifacts != null) {
      into["artifacts"] = RaviJson.from(artifacts);
    }
    if (insights != null) {
      into["insights"] = RaviJson.from(insights);
    }
  }
}

class DevinSessionsSyncReturn {
  const DevinSessionsSyncReturn({required this.artifacts, required this.attachments, required this.insights, required this.messages, required this.session});

  final List<String> artifacts;
  final double attachments;
  final RaviJson insights;
  final double messages;
  final RaviJson session;

  factory DevinSessionsSyncReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsSyncReturn(
      artifacts: raviJsonAsList(json["artifacts"], raviJsonAsString),
      attachments: raviJsonAsDouble(json["attachments"]),
      insights: RaviJson.from(json["insights"]),
      messages: raviJsonAsDouble(json["messages"]),
      session: RaviJson.from(json["session"]),
    );
  }

  static DevinSessionsSyncReturn fromJsonValue(Object? json) {
    return DevinSessionsSyncReturn.fromJson(raviJsonObject(json, "DevinSessionsSyncReturn"));
  }
}

DevinSessionsSyncReturn devinSessionsSyncReturnFromJson(Object? json) => DevinSessionsSyncReturn.fromJsonValue(json);

class DevinSessionsTerminateOptions {
  const DevinSessionsTerminateOptions({this.archive});

  final bool? archive;

  void encodeBody(Map<String, RaviJson> into) {
    if (archive != null) {
      into["archive"] = RaviJson.from(archive);
    }
  }
}

class DevinSessionsTerminateReturn {
  const DevinSessionsTerminateReturn({required this.archive, required this.session, required this.status});

  final bool archive;
  final RaviJson session;
  final String status;

  factory DevinSessionsTerminateReturn.fromJson(Map<String, Object?> json) {
    return DevinSessionsTerminateReturn(
      archive: raviJsonAsBool(json["archive"]),
      session: RaviJson.from(json["session"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static DevinSessionsTerminateReturn fromJsonValue(Object? json) {
    return DevinSessionsTerminateReturn.fromJson(raviJsonObject(json, "DevinSessionsTerminateReturn"));
  }
}

DevinSessionsTerminateReturn devinSessionsTerminateReturnFromJson(Object? json) => DevinSessionsTerminateReturn.fromJsonValue(json);

class EvalRunOptions {
  const EvalRunOptions({this.output});

  final String? output;

  void encodeBody(Map<String, RaviJson> into) {
    if (output != null) {
      into["output"] = RaviJson.from(output);
    }
  }
}

class EvalRunReturn {
  const EvalRunReturn({required this.execution, required this.grade, required this.outputDir, required this.runId, required this.session});

  final Map<String, RaviJson> execution;
  final Map<String, RaviJson> grade;
  final String outputDir;
  final String runId;
  final Map<String, RaviJson> session;

  factory EvalRunReturn.fromJson(Map<String, Object?> json) {
    return EvalRunReturn(
      execution: raviJsonAsRaviJsonMap(json["execution"]),
      grade: raviJsonAsRaviJsonMap(json["grade"]),
      outputDir: raviJsonAsString(json["outputDir"]),
      runId: raviJsonAsString(json["runId"]),
      session: raviJsonAsRaviJsonMap(json["session"]),
    );
  }

  static EvalRunReturn fromJsonValue(Object? json) {
    return EvalRunReturn.fromJson(raviJsonObject(json, "EvalRunReturn"));
  }
}

EvalRunReturn evalRunReturnFromJson(Object? json) => EvalRunReturn.fromJsonValue(json);

class FeedbackSendOptions {
  const FeedbackSendOptions({this.console, this.execute, this.kind, this.metadataJson, this.project, this.severity, this.surface, this.tag, this.title, this.url});

  final String? console;
  final bool? execute;
  final String? kind;
  final String? metadataJson;
  final String? project;
  final String? severity;
  final String? surface;
  final String? tag;
  final String? title;
  final String? url;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (metadataJson != null) {
      into["metadataJson"] = RaviJson.from(metadataJson);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (severity != null) {
      into["severity"] = RaviJson.from(severity);
    }
    if (surface != null) {
      into["surface"] = RaviJson.from(surface);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
    if (url != null) {
      into["url"] = RaviJson.from(url);
    }
  }
}

class FeedbackSendReturn {
  const FeedbackSendReturn({required this.consoleUrl, required this.feedback, required this.success, required this.url});

  final String consoleUrl;
  final Map<String, RaviJson> feedback;
  final bool success;
  final String url;

  factory FeedbackSendReturn.fromJson(Map<String, Object?> json) {
    return FeedbackSendReturn(
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      feedback: raviJsonAsRaviJsonMap(json["feedback"]),
      success: raviJsonAsBool(json["success"]),
      url: raviJsonAsString(json["url"]),
    );
  }

  static FeedbackSendReturn fromJsonValue(Object? json) {
    return FeedbackSendReturn.fromJson(raviJsonObject(json, "FeedbackSendReturn"));
  }
}

FeedbackSendReturn feedbackSendReturnFromJson(Object? json) => FeedbackSendReturn.fromJsonValue(json);

class GmailListOptions {
  const GmailListOptions({this.connector, this.cursor, this.label, this.max, this.q});

  final String? connector;
  final String? cursor;
  final String? label;
  final String? max;
  final String? q;

  void encodeBody(Map<String, RaviJson> into) {
    if (connector != null) {
      into["connector"] = RaviJson.from(connector);
    }
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (max != null) {
      into["max"] = RaviJson.from(max);
    }
    if (q != null) {
      into["q"] = RaviJson.from(q);
    }
  }
}

class GmailListReturn {
  const GmailListReturn({required this.capability, required this.refreshed, this.result});

  final String capability;
  final bool refreshed;
  final RaviJson? result;

  factory GmailListReturn.fromJson(Map<String, Object?> json) {
    return GmailListReturn(
      capability: raviJsonAsString(json["capability"]),
      refreshed: raviJsonAsBool(json["refreshed"]),
      result: json["result"] == null ? null : RaviJson.from(json["result"]),
    );
  }

  static GmailListReturn fromJsonValue(Object? json) {
    return GmailListReturn.fromJson(raviJsonObject(json, "GmailListReturn"));
  }
}

GmailListReturn gmailListReturnFromJson(Object? json) => GmailListReturn.fromJsonValue(json);

class GmailReadOptions {
  const GmailReadOptions({this.connector, this.format});

  final String? connector;
  final String? format;

  void encodeBody(Map<String, RaviJson> into) {
    if (connector != null) {
      into["connector"] = RaviJson.from(connector);
    }
    if (format != null) {
      into["format"] = RaviJson.from(format);
    }
  }
}

class GmailReadReturn {
  const GmailReadReturn({required this.capability, required this.refreshed, this.result});

  final String capability;
  final bool refreshed;
  final RaviJson? result;

  factory GmailReadReturn.fromJson(Map<String, Object?> json) {
    return GmailReadReturn(
      capability: raviJsonAsString(json["capability"]),
      refreshed: raviJsonAsBool(json["refreshed"]),
      result: json["result"] == null ? null : RaviJson.from(json["result"]),
    );
  }

  static GmailReadReturn fromJsonValue(Object? json) {
    return GmailReadReturn.fromJson(raviJsonObject(json, "GmailReadReturn"));
  }
}

GmailReadReturn gmailReadReturnFromJson(Object? json) => GmailReadReturn.fromJsonValue(json);

class HeartbeatDisableReturn {
  const HeartbeatDisableReturn({required this.agent, required this.changedCount, required this.heartbeat, required this.heartbeatFile, required this.heartbeatFileExists, this.property, required this.status, required this.target, this.value});

  final RaviJson agent;
  final double changedCount;
  final RaviJson heartbeat;
  final String heartbeatFile;
  final bool heartbeatFileExists;
  final String? property;
  final String status;
  final RaviJson target;
  final RaviJson? value;

  factory HeartbeatDisableReturn.fromJson(Map<String, Object?> json) {
    return HeartbeatDisableReturn(
      agent: RaviJson.from(json["agent"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      heartbeat: RaviJson.from(json["heartbeat"]),
      heartbeatFile: raviJsonAsString(json["heartbeatFile"]),
      heartbeatFileExists: raviJsonAsBool(json["heartbeatFileExists"]),
      property: json["property"] == null ? null : raviJsonAsString(json["property"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      value: json["value"] == null ? null : RaviJson.from(json["value"]),
    );
  }

  static HeartbeatDisableReturn fromJsonValue(Object? json) {
    return HeartbeatDisableReturn.fromJson(raviJsonObject(json, "HeartbeatDisableReturn"));
  }
}

HeartbeatDisableReturn heartbeatDisableReturnFromJson(Object? json) => HeartbeatDisableReturn.fromJsonValue(json);

class HeartbeatEnableReturn {
  const HeartbeatEnableReturn({required this.agent, required this.changedCount, required this.heartbeat, required this.heartbeatFile, required this.heartbeatFileExists, this.property, required this.status, required this.target, this.value});

  final RaviJson agent;
  final double changedCount;
  final RaviJson heartbeat;
  final String heartbeatFile;
  final bool heartbeatFileExists;
  final String? property;
  final String status;
  final RaviJson target;
  final RaviJson? value;

  factory HeartbeatEnableReturn.fromJson(Map<String, Object?> json) {
    return HeartbeatEnableReturn(
      agent: RaviJson.from(json["agent"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      heartbeat: RaviJson.from(json["heartbeat"]),
      heartbeatFile: raviJsonAsString(json["heartbeatFile"]),
      heartbeatFileExists: raviJsonAsBool(json["heartbeatFileExists"]),
      property: json["property"] == null ? null : raviJsonAsString(json["property"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      value: json["value"] == null ? null : RaviJson.from(json["value"]),
    );
  }

  static HeartbeatEnableReturn fromJsonValue(Object? json) {
    return HeartbeatEnableReturn.fromJson(raviJsonObject(json, "HeartbeatEnableReturn"));
  }
}

HeartbeatEnableReturn heartbeatEnableReturnFromJson(Object? json) => HeartbeatEnableReturn.fromJsonValue(json);

class HeartbeatSetReturn {
  const HeartbeatSetReturn({required this.agent, required this.changedCount, required this.heartbeat, required this.heartbeatFile, required this.heartbeatFileExists, this.property, required this.status, required this.target, this.value});

  final RaviJson agent;
  final double changedCount;
  final RaviJson heartbeat;
  final String heartbeatFile;
  final bool heartbeatFileExists;
  final String? property;
  final String status;
  final RaviJson target;
  final RaviJson? value;

  factory HeartbeatSetReturn.fromJson(Map<String, Object?> json) {
    return HeartbeatSetReturn(
      agent: RaviJson.from(json["agent"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      heartbeat: RaviJson.from(json["heartbeat"]),
      heartbeatFile: raviJsonAsString(json["heartbeatFile"]),
      heartbeatFileExists: raviJsonAsBool(json["heartbeatFileExists"]),
      property: json["property"] == null ? null : raviJsonAsString(json["property"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      value: json["value"] == null ? null : RaviJson.from(json["value"]),
    );
  }

  static HeartbeatSetReturn fromJsonValue(Object? json) {
    return HeartbeatSetReturn.fromJson(raviJsonObject(json, "HeartbeatSetReturn"));
  }
}

HeartbeatSetReturn heartbeatSetReturnFromJson(Object? json) => HeartbeatSetReturn.fromJsonValue(json);

class HeartbeatShowReturn {
  const HeartbeatShowReturn({required this.agent, required this.heartbeat, required this.heartbeatFile, required this.heartbeatFileExists});

  final RaviJson agent;
  final RaviJson heartbeat;
  final String heartbeatFile;
  final bool heartbeatFileExists;

  factory HeartbeatShowReturn.fromJson(Map<String, Object?> json) {
    return HeartbeatShowReturn(
      agent: RaviJson.from(json["agent"]),
      heartbeat: RaviJson.from(json["heartbeat"]),
      heartbeatFile: raviJsonAsString(json["heartbeatFile"]),
      heartbeatFileExists: raviJsonAsBool(json["heartbeatFileExists"]),
    );
  }

  static HeartbeatShowReturn fromJsonValue(Object? json) {
    return HeartbeatShowReturn.fromJson(raviJsonObject(json, "HeartbeatShowReturn"));
  }
}

HeartbeatShowReturn heartbeatShowReturnFromJson(Object? json) => HeartbeatShowReturn.fromJsonValue(json);

class HeartbeatStatusOptions {
  const HeartbeatStatusOptions({this.fields});

  final String? fields;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
  }
}

class HeartbeatStatusReturn {
  const HeartbeatStatusReturn({required this.agents, required this.total});

  final List<RaviJson> agents;
  final double total;

  factory HeartbeatStatusReturn.fromJson(Map<String, Object?> json) {
    return HeartbeatStatusReturn(
      agents: raviJsonAsList(json["agents"], RaviJson.from),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static HeartbeatStatusReturn fromJsonValue(Object? json) {
    return HeartbeatStatusReturn.fromJson(raviJsonObject(json, "HeartbeatStatusReturn"));
  }
}

HeartbeatStatusReturn heartbeatStatusReturnFromJson(Object? json) => HeartbeatStatusReturn.fromJsonValue(json);

class HeartbeatTriggerOptions {
  const HeartbeatTriggerOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class HeartbeatTriggerReturn {
  const HeartbeatTriggerReturn({required this.changedCount, required this.heartbeatFile, this.reason, this.sessionName, required this.status, required this.target});

  final double changedCount;
  final String heartbeatFile;
  final String? reason;
  final String? sessionName;
  final String status;
  final RaviJson target;

  factory HeartbeatTriggerReturn.fromJson(Map<String, Object?> json) {
    return HeartbeatTriggerReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      heartbeatFile: raviJsonAsString(json["heartbeatFile"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      sessionName: json["sessionName"] == null ? null : raviJsonAsString(json["sessionName"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static HeartbeatTriggerReturn fromJsonValue(Object? json) {
    return HeartbeatTriggerReturn.fromJson(raviJsonObject(json, "HeartbeatTriggerReturn"));
  }
}

HeartbeatTriggerReturn heartbeatTriggerReturnFromJson(Object? json) => HeartbeatTriggerReturn.fromJsonValue(json);

class HooksCreateOptions {
  const HooksCreateOptions({this.action, this.agent, this.async, this.barrier, this.cooldown, this.dedupeKey, this.disabled, this.event, this.matcher, this.message, this.role, this.scope, this.session, this.targetSession, this.targetTask, this.task, this.workspace});

  final String? action;
  final String? agent;
  final bool? async;
  final String? barrier;
  final String? cooldown;
  final String? dedupeKey;
  final bool? disabled;
  final String? event;
  final String? matcher;
  final String? message;
  final String? role;
  final String? scope;
  final String? session;
  final String? targetSession;
  final String? targetTask;
  final String? task;
  final String? workspace;

  void encodeBody(Map<String, RaviJson> into) {
    if (action != null) {
      into["action"] = RaviJson.from(action);
    }
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (async != null) {
      into["async"] = RaviJson.from(async);
    }
    if (barrier != null) {
      into["barrier"] = RaviJson.from(barrier);
    }
    if (cooldown != null) {
      into["cooldown"] = RaviJson.from(cooldown);
    }
    if (dedupeKey != null) {
      into["dedupeKey"] = RaviJson.from(dedupeKey);
    }
    if (disabled != null) {
      into["disabled"] = RaviJson.from(disabled);
    }
    if (event != null) {
      into["event"] = RaviJson.from(event);
    }
    if (matcher != null) {
      into["matcher"] = RaviJson.from(matcher);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (targetSession != null) {
      into["targetSession"] = RaviJson.from(targetSession);
    }
    if (targetTask != null) {
      into["targetTask"] = RaviJson.from(targetTask);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
    if (workspace != null) {
      into["workspace"] = RaviJson.from(workspace);
    }
  }
}

class HooksCreateReturn {
  const HooksCreateReturn({required this.changedCount, required this.hook, required this.status, required this.target});

  final double changedCount;
  final Map<String, RaviJson> hook;
  final String status;
  final RaviJson target;

  factory HooksCreateReturn.fromJson(Map<String, Object?> json) {
    return HooksCreateReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      hook: raviJsonAsRaviJsonMap(json["hook"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static HooksCreateReturn fromJsonValue(Object? json) {
    return HooksCreateReturn.fromJson(raviJsonObject(json, "HooksCreateReturn"));
  }
}

HooksCreateReturn hooksCreateReturnFromJson(Object? json) => HooksCreateReturn.fromJsonValue(json);

class HooksDisableReturn {
  const HooksDisableReturn({required this.changedCount, required this.hook, required this.status, required this.target});

  final double changedCount;
  final Map<String, RaviJson> hook;
  final String status;
  final RaviJson target;

  factory HooksDisableReturn.fromJson(Map<String, Object?> json) {
    return HooksDisableReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      hook: raviJsonAsRaviJsonMap(json["hook"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static HooksDisableReturn fromJsonValue(Object? json) {
    return HooksDisableReturn.fromJson(raviJsonObject(json, "HooksDisableReturn"));
  }
}

HooksDisableReturn hooksDisableReturnFromJson(Object? json) => HooksDisableReturn.fromJsonValue(json);

class HooksEnableReturn {
  const HooksEnableReturn({required this.changedCount, required this.hook, required this.status, required this.target});

  final double changedCount;
  final Map<String, RaviJson> hook;
  final String status;
  final RaviJson target;

  factory HooksEnableReturn.fromJson(Map<String, Object?> json) {
    return HooksEnableReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      hook: raviJsonAsRaviJsonMap(json["hook"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static HooksEnableReturn fromJsonValue(Object? json) {
    return HooksEnableReturn.fromJson(raviJsonObject(json, "HooksEnableReturn"));
  }
}

HooksEnableReturn hooksEnableReturnFromJson(Object? json) => HooksEnableReturn.fromJsonValue(json);

class HooksListOptions {
  const HooksListOptions({this.fields, this.limit, this.offset, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class HooksListReturn {
  const HooksListReturn({required this.hooks, required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> hooks;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory HooksListReturn.fromJson(Map<String, Object?> json) {
    return HooksListReturn(
      hooks: raviJsonAsList(json["hooks"], raviJsonAsRaviJsonMap),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static HooksListReturn fromJsonValue(Object? json) {
    return HooksListReturn.fromJson(raviJsonObject(json, "HooksListReturn"));
  }
}

HooksListReturn hooksListReturnFromJson(Object? json) => HooksListReturn.fromJsonValue(json);

class HooksRmOptions {
  const HooksRmOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class HooksRmReturn {
  const HooksRmReturn({required this.changedCount, required this.hook, required this.status, required this.target});

  final double changedCount;
  final Map<String, RaviJson> hook;
  final String status;
  final RaviJson target;

  factory HooksRmReturn.fromJson(Map<String, Object?> json) {
    return HooksRmReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      hook: raviJsonAsRaviJsonMap(json["hook"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static HooksRmReturn fromJsonValue(Object? json) {
    return HooksRmReturn.fromJson(raviJsonObject(json, "HooksRmReturn"));
  }
}

HooksRmReturn hooksRmReturnFromJson(Object? json) => HooksRmReturn.fromJsonValue(json);

class HooksShowReturn {
  const HooksShowReturn({required this.hook});

  final Map<String, RaviJson> hook;

  factory HooksShowReturn.fromJson(Map<String, Object?> json) {
    return HooksShowReturn(
      hook: raviJsonAsRaviJsonMap(json["hook"]),
    );
  }

  static HooksShowReturn fromJsonValue(Object? json) {
    return HooksShowReturn.fromJson(raviJsonObject(json, "HooksShowReturn"));
  }
}

HooksShowReturn hooksShowReturnFromJson(Object? json) => HooksShowReturn.fromJsonValue(json);

class HooksTestOptions {
  const HooksTestOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef HooksTestReturn = Map<String, RaviJson>;

HooksTestReturn hooksTestReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ImageAtlasSplitOptions {
  const ImageAtlasSplitOptions({this.account, this.background, this.caption, this.channel, this.cols, this.execute, this.fit, this.fuzz, this.mode, this.names, this.output, this.pad, this.parentArtifact, this.rows, this.send, this.size, this.threadId, this.to});

  final String? account;
  final String? background;
  final String? caption;
  final String? channel;
  final String? cols;
  final bool? execute;
  final String? fit;
  final String? fuzz;
  final String? mode;
  final String? names;
  final String? output;
  final String? pad;
  final String? parentArtifact;
  final String? rows;
  final bool? send;
  final String? size;
  final String? threadId;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (background != null) {
      into["background"] = RaviJson.from(background);
    }
    if (caption != null) {
      into["caption"] = RaviJson.from(caption);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (cols != null) {
      into["cols"] = RaviJson.from(cols);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (fit != null) {
      into["fit"] = RaviJson.from(fit);
    }
    if (fuzz != null) {
      into["fuzz"] = RaviJson.from(fuzz);
    }
    if (mode != null) {
      into["mode"] = RaviJson.from(mode);
    }
    if (names != null) {
      into["names"] = RaviJson.from(names);
    }
    if (output != null) {
      into["output"] = RaviJson.from(output);
    }
    if (pad != null) {
      into["pad"] = RaviJson.from(pad);
    }
    if (parentArtifact != null) {
      into["parentArtifact"] = RaviJson.from(parentArtifact);
    }
    if (rows != null) {
      into["rows"] = RaviJson.from(rows);
    }
    if (send != null) {
      into["send"] = RaviJson.from(send);
    }
    if (size != null) {
      into["size"] = RaviJson.from(size);
    }
    if (threadId != null) {
      into["threadId"] = RaviJson.from(threadId);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

class ImageAtlasSplitReturn {
  const ImageAtlasSplitReturn({required this.artifactId, required this.artifact_id, required this.crops, required this.manifestPath, required this.outputDir, required this.parentArtifactId, required this.sent, required this.success});

  final String artifactId;
  final String artifact_id;
  final List<Map<String, RaviJson>> crops;
  final String manifestPath;
  final String outputDir;
  final RaviJson parentArtifactId;
  final List<Map<String, RaviJson>> sent;
  final bool success;

  factory ImageAtlasSplitReturn.fromJson(Map<String, Object?> json) {
    return ImageAtlasSplitReturn(
      artifactId: raviJsonAsString(json["artifactId"]),
      artifact_id: raviJsonAsString(json["artifact_id"]),
      crops: raviJsonAsList(json["crops"], raviJsonAsRaviJsonMap),
      manifestPath: raviJsonAsString(json["manifestPath"]),
      outputDir: raviJsonAsString(json["outputDir"]),
      parentArtifactId: RaviJson.from(json["parentArtifactId"]),
      sent: raviJsonAsList(json["sent"], raviJsonAsRaviJsonMap),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ImageAtlasSplitReturn fromJsonValue(Object? json) {
    return ImageAtlasSplitReturn.fromJson(raviJsonObject(json, "ImageAtlasSplitReturn"));
  }
}

ImageAtlasSplitReturn imageAtlasSplitReturnFromJson(Object? json) => ImageAtlasSplitReturn.fromJsonValue(json);

class ImageGenerateOptions {
  const ImageGenerateOptions({this.artifactId, this.aspect, this.async, this.asyncWorker, this.background, this.caption, this.compression, this.execute, this.format, this.mode, this.model, this.output, this.provider, this.quality, this.send, this.size, this.source, this.sync});

  final String? artifactId;
  final String? aspect;
  final bool? async;
  final bool? asyncWorker;
  final String? background;
  final String? caption;
  final String? compression;
  final bool? execute;
  final String? format;
  final String? mode;
  final String? model;
  final String? output;
  final String? provider;
  final String? quality;
  final bool? send;
  final String? size;
  final String? source;
  final bool? sync;

  void encodeBody(Map<String, RaviJson> into) {
    if (artifactId != null) {
      into["artifactId"] = RaviJson.from(artifactId);
    }
    if (aspect != null) {
      into["aspect"] = RaviJson.from(aspect);
    }
    if (async != null) {
      into["async"] = RaviJson.from(async);
    }
    if (asyncWorker != null) {
      into["asyncWorker"] = RaviJson.from(asyncWorker);
    }
    if (background != null) {
      into["background"] = RaviJson.from(background);
    }
    if (caption != null) {
      into["caption"] = RaviJson.from(caption);
    }
    if (compression != null) {
      into["compression"] = RaviJson.from(compression);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (format != null) {
      into["format"] = RaviJson.from(format);
    }
    if (mode != null) {
      into["mode"] = RaviJson.from(mode);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (output != null) {
      into["output"] = RaviJson.from(output);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (quality != null) {
      into["quality"] = RaviJson.from(quality);
    }
    if (send != null) {
      into["send"] = RaviJson.from(send);
    }
    if (size != null) {
      into["size"] = RaviJson.from(size);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
    if (sync != null) {
      into["sync"] = RaviJson.from(sync);
    }
  }
}

typedef ImageGenerateReturn = RaviJson;

ImageGenerateReturn imageGenerateReturnFromJson(Object? json) => RaviJson.from(json);

class InboxArchiveReturn {
  const InboxArchiveReturn({required this.item});

  final Map<String, RaviJson> item;

  factory InboxArchiveReturn.fromJson(Map<String, Object?> json) {
    return InboxArchiveReturn(
      item: raviJsonAsRaviJsonMap(json["item"]),
    );
  }

  static InboxArchiveReturn fromJsonValue(Object? json) {
    return InboxArchiveReturn.fromJson(raviJsonObject(json, "InboxArchiveReturn"));
  }
}

InboxArchiveReturn inboxArchiveReturnFromJson(Object? json) => InboxArchiveReturn.fromJsonValue(json);

class InboxDisableReturn {
  const InboxDisableReturn({required this.changed, required this.enabled});

  final bool changed;
  final bool enabled;

  factory InboxDisableReturn.fromJson(Map<String, Object?> json) {
    return InboxDisableReturn(
      changed: raviJsonAsBool(json["changed"]),
      enabled: raviJsonAsBool(json["enabled"]),
    );
  }

  static InboxDisableReturn fromJsonValue(Object? json) {
    return InboxDisableReturn.fromJson(raviJsonObject(json, "InboxDisableReturn"));
  }
}

InboxDisableReturn inboxDisableReturnFromJson(Object? json) => InboxDisableReturn.fromJsonValue(json);

class InboxDoneReturn {
  const InboxDoneReturn({required this.item});

  final Map<String, RaviJson> item;

  factory InboxDoneReturn.fromJson(Map<String, Object?> json) {
    return InboxDoneReturn(
      item: raviJsonAsRaviJsonMap(json["item"]),
    );
  }

  static InboxDoneReturn fromJsonValue(Object? json) {
    return InboxDoneReturn.fromJson(raviJsonObject(json, "InboxDoneReturn"));
  }
}

InboxDoneReturn inboxDoneReturnFromJson(Object? json) => InboxDoneReturn.fromJsonValue(json);

class InboxEnableReturn {
  const InboxEnableReturn({required this.changed, required this.enabled});

  final bool changed;
  final bool enabled;

  factory InboxEnableReturn.fromJson(Map<String, Object?> json) {
    return InboxEnableReturn(
      changed: raviJsonAsBool(json["changed"]),
      enabled: raviJsonAsBool(json["enabled"]),
    );
  }

  static InboxEnableReturn fromJsonValue(Object? json) {
    return InboxEnableReturn.fromJson(raviJsonObject(json, "InboxEnableReturn"));
  }
}

InboxEnableReturn inboxEnableReturnFromJson(Object? json) => InboxEnableReturn.fromJsonValue(json);

class InboxItemsOptions {
  const InboxItemsOptions({this.fields, this.limit});

  final String? fields;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class InboxItemsReturn {
  const InboxItemsReturn({required this.items, required this.total});

  final List<Map<String, RaviJson>> items;
  final double total;

  factory InboxItemsReturn.fromJson(Map<String, Object?> json) {
    return InboxItemsReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static InboxItemsReturn fromJsonValue(Object? json) {
    return InboxItemsReturn.fromJson(raviJsonObject(json, "InboxItemsReturn"));
  }
}

InboxItemsReturn inboxItemsReturnFromJson(Object? json) => InboxItemsReturn.fromJsonValue(json);

class InboxListOptions {
  const InboxListOptions({this.fields, this.includeArchived, this.limit, this.offset, this.source, this.status});

  final String? fields;
  final bool? includeArchived;
  final String? limit;
  final String? offset;
  final String? source;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (includeArchived != null) {
      into["includeArchived"] = RaviJson.from(includeArchived);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class InboxListReturn {
  const InboxListReturn({required this.items, required this.total});

  final List<Map<String, RaviJson>> items;
  final double total;

  factory InboxListReturn.fromJson(Map<String, Object?> json) {
    return InboxListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static InboxListReturn fromJsonValue(Object? json) {
    return InboxListReturn.fromJson(raviJsonObject(json, "InboxListReturn"));
  }
}

InboxListReturn inboxListReturnFromJson(Object? json) => InboxListReturn.fromJsonValue(json);

class InboxPollOptions {
  const InboxPollOptions({this.once});

  final bool? once;

  void encodeBody(Map<String, RaviJson> into) {
    if (once != null) {
      into["once"] = RaviJson.from(once);
    }
  }
}

class InboxPollReturn {
  const InboxPollReturn({required this.ok, required this.snapshot});

  final bool ok;
  final Map<String, RaviJson> snapshot;

  factory InboxPollReturn.fromJson(Map<String, Object?> json) {
    return InboxPollReturn(
      ok: raviJsonAsBool(json["ok"]),
      snapshot: raviJsonAsRaviJsonMap(json["snapshot"]),
    );
  }

  static InboxPollReturn fromJsonValue(Object? json) {
    return InboxPollReturn.fromJson(raviJsonObject(json, "InboxPollReturn"));
  }
}

InboxPollReturn inboxPollReturnFromJson(Object? json) => InboxPollReturn.fromJsonValue(json);

class InboxReadReturn {
  const InboxReadReturn({required this.events, required this.item});

  final List<Map<String, RaviJson>> events;
  final Map<String, RaviJson> item;

  factory InboxReadReturn.fromJson(Map<String, Object?> json) {
    return InboxReadReturn(
      events: raviJsonAsList(json["events"], raviJsonAsRaviJsonMap),
      item: raviJsonAsRaviJsonMap(json["item"]),
    );
  }

  static InboxReadReturn fromJsonValue(Object? json) {
    return InboxReadReturn.fromJson(raviJsonObject(json, "InboxReadReturn"));
  }
}

InboxReadReturn inboxReadReturnFromJson(Object? json) => InboxReadReturn.fromJsonValue(json);

class InboxReplayOptions {
  const InboxReplayOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class InboxReplayReturn {
  const InboxReplayReturn({required this.itemId, required this.ok, required this.replayedAt, required this.sequence, required this.subject});

  final String itemId;
  final bool ok;
  final String replayedAt;
  final double sequence;
  final String subject;

  factory InboxReplayReturn.fromJson(Map<String, Object?> json) {
    return InboxReplayReturn(
      itemId: raviJsonAsString(json["itemId"]),
      ok: raviJsonAsBool(json["ok"]),
      replayedAt: raviJsonAsString(json["replayedAt"]),
      sequence: raviJsonAsDouble(json["sequence"]),
      subject: raviJsonAsString(json["subject"]),
    );
  }

  static InboxReplayReturn fromJsonValue(Object? json) {
    return InboxReplayReturn.fromJson(raviJsonObject(json, "InboxReplayReturn"));
  }
}

InboxReplayReturn inboxReplayReturnFromJson(Object? json) => InboxReplayReturn.fromJsonValue(json);

class InboxSnoozeOptions {
  const InboxSnoozeOptions({this.until});

  final String? until;

  void encodeBody(Map<String, RaviJson> into) {
    if (until != null) {
      into["until"] = RaviJson.from(until);
    }
  }
}

class InboxSnoozeReturn {
  const InboxSnoozeReturn({required this.item});

  final Map<String, RaviJson> item;

  factory InboxSnoozeReturn.fromJson(Map<String, Object?> json) {
    return InboxSnoozeReturn(
      item: raviJsonAsRaviJsonMap(json["item"]),
    );
  }

  static InboxSnoozeReturn fromJsonValue(Object? json) {
    return InboxSnoozeReturn.fromJson(raviJsonObject(json, "InboxSnoozeReturn"));
  }
}

InboxSnoozeReturn inboxSnoozeReturnFromJson(Object? json) => InboxSnoozeReturn.fromJsonValue(json);

class InboxSourcesReturn {
  const InboxSourcesReturn({required this.sources});

  final List<Map<String, RaviJson>> sources;

  factory InboxSourcesReturn.fromJson(Map<String, Object?> json) {
    return InboxSourcesReturn(
      sources: raviJsonAsList(json["sources"], raviJsonAsRaviJsonMap),
    );
  }

  static InboxSourcesReturn fromJsonValue(Object? json) {
    return InboxSourcesReturn.fromJson(raviJsonObject(json, "InboxSourcesReturn"));
  }
}

InboxSourcesReturn inboxSourcesReturnFromJson(Object? json) => InboxSourcesReturn.fromJsonValue(json);

typedef InboxStatusReturn = Map<String, RaviJson>;

InboxStatusReturn inboxStatusReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InsightsCreateOptions {
  const InsightsCreateOptions({this.agent, this.artifact, this.autoContext, this.comment, this.confidence, this.detail, this.importance, this.kind, this.linkId, this.linkType, this.profile, this.session, this.tag, this.task});

  final String? agent;
  final String? artifact;
  final bool? autoContext;
  final String? comment;
  final String? confidence;
  final String? detail;
  final String? importance;
  final String? kind;
  final String? linkId;
  final String? linkType;
  final String? profile;
  final String? session;
  final List<String>? tag;
  final String? task;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (artifact != null) {
      into["artifact"] = RaviJson.from(artifact);
    }
    if (autoContext != null) {
      into["autoContext"] = RaviJson.from(autoContext);
    }
    if (comment != null) {
      into["comment"] = RaviJson.from(comment);
    }
    if (confidence != null) {
      into["confidence"] = RaviJson.from(confidence);
    }
    if (detail != null) {
      into["detail"] = RaviJson.from(detail);
    }
    if (importance != null) {
      into["importance"] = RaviJson.from(importance);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (linkId != null) {
      into["linkId"] = RaviJson.from(linkId);
    }
    if (linkType != null) {
      into["linkType"] = RaviJson.from(linkType);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
  }
}

class InsightsCreateReturn {
  const InsightsCreateReturn({this.comment, required this.insight, required this.success, required this.tags});

  final Map<String, RaviJson>? comment;
  final Map<String, RaviJson> insight;
  final bool success;
  final List<String> tags;

  factory InsightsCreateReturn.fromJson(Map<String, Object?> json) {
    return InsightsCreateReturn(
      comment: json["comment"] == null ? null : raviJsonAsRaviJsonMap(json["comment"]),
      insight: raviJsonAsRaviJsonMap(json["insight"]),
      success: raviJsonAsBool(json["success"]),
      tags: raviJsonAsList(json["tags"], raviJsonAsString),
    );
  }

  static InsightsCreateReturn fromJsonValue(Object? json) {
    return InsightsCreateReturn.fromJson(raviJsonObject(json, "InsightsCreateReturn"));
  }
}

InsightsCreateReturn insightsCreateReturnFromJson(Object? json) => InsightsCreateReturn.fromJsonValue(json);

class InsightsListOptions {
  const InsightsListOptions({this.agent, this.confidence, this.fields, this.importance, this.kind, this.limit, this.offset, this.profile, this.query, this.rich, this.session, this.tag, this.task});

  final String? agent;
  final String? confidence;
  final String? fields;
  final String? importance;
  final String? kind;
  final String? limit;
  final String? offset;
  final String? profile;
  final String? query;
  final bool? rich;
  final String? session;
  final String? tag;
  final String? task;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (confidence != null) {
      into["confidence"] = RaviJson.from(confidence);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (importance != null) {
      into["importance"] = RaviJson.from(importance);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (query != null) {
      into["query"] = RaviJson.from(query);
    }
    if (rich != null) {
      into["rich"] = RaviJson.from(rich);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
  }
}

typedef InsightsListReturn = RaviJson;

InsightsListReturn insightsListReturnFromJson(Object? json) => RaviJson.from(json);

class InsightsSearchOptions {
  const InsightsSearchOptions({this.fields, this.limit});

  final String? fields;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class InsightsSearchReturn {
  const InsightsSearchReturn({required this.count, required this.insights, required this.query});

  final double count;
  final List<Map<String, RaviJson>> insights;
  final Map<String, RaviJson> query;

  factory InsightsSearchReturn.fromJson(Map<String, Object?> json) {
    return InsightsSearchReturn(
      count: raviJsonAsDouble(json["count"]),
      insights: raviJsonAsList(json["insights"], raviJsonAsRaviJsonMap),
      query: raviJsonAsRaviJsonMap(json["query"]),
    );
  }

  static InsightsSearchReturn fromJsonValue(Object? json) {
    return InsightsSearchReturn.fromJson(raviJsonObject(json, "InsightsSearchReturn"));
  }
}

InsightsSearchReturn insightsSearchReturnFromJson(Object? json) => InsightsSearchReturn.fromJsonValue(json);

class InsightsShowReturn {
  const InsightsShowReturn({required this.insight, required this.tags});

  final Map<String, RaviJson> insight;
  final List<String> tags;

  factory InsightsShowReturn.fromJson(Map<String, Object?> json) {
    return InsightsShowReturn(
      insight: raviJsonAsRaviJsonMap(json["insight"]),
      tags: raviJsonAsList(json["tags"], raviJsonAsString),
    );
  }

  static InsightsShowReturn fromJsonValue(Object? json) {
    return InsightsShowReturn.fromJson(raviJsonObject(json, "InsightsShowReturn"));
  }
}

InsightsShowReturn insightsShowReturnFromJson(Object? json) => InsightsShowReturn.fromJsonValue(json);

class InstancesCreateOptions {
  const InstancesCreateOptions({this.agent, this.channel, this.contactIntakeMode, this.dmPolicy, this.groupPolicy});

  final String? agent;
  final String? channel;
  final String? contactIntakeMode;
  final String? dmPolicy;
  final String? groupPolicy;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (contactIntakeMode != null) {
      into["contactIntakeMode"] = RaviJson.from(contactIntakeMode);
    }
    if (dmPolicy != null) {
      into["dmPolicy"] = RaviJson.from(dmPolicy);
    }
    if (groupPolicy != null) {
      into["groupPolicy"] = RaviJson.from(groupPolicy);
    }
  }
}

typedef InstancesCreateReturn = Map<String, RaviJson>;

InstancesCreateReturn instancesCreateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesDeleteReturn = Map<String, RaviJson>;

InstancesDeleteReturn instancesDeleteReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesDeletedReturn = Map<String, RaviJson>;

InstancesDeletedReturn instancesDeletedReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesDisableReturn = Map<String, RaviJson>;

InstancesDisableReturn instancesDisableReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesDisconnectReturn = Map<String, RaviJson>;

InstancesDisconnectReturn instancesDisconnectReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesEnableReturn = Map<String, RaviJson>;

InstancesEnableReturn instancesEnableReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesGetReturn = Map<String, RaviJson>;

InstancesGetReturn instancesGetReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesListOptions {
  const InstancesListOptions({this.fields, this.limit, this.offset, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

typedef InstancesListReturn = Map<String, RaviJson>;

InstancesListReturn instancesListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesPendingApproveOptions {
  const InstancesPendingApproveOptions({this.agent});

  final String? agent;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
  }
}

typedef InstancesPendingApproveReturn = Map<String, RaviJson>;

InstancesPendingApproveReturn instancesPendingApproveReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesPendingListOptions {
  const InstancesPendingListOptions({this.limit, this.offset});

  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

typedef InstancesPendingListReturn = Map<String, RaviJson>;

InstancesPendingListReturn instancesPendingListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesPendingRejectOptions {
  const InstancesPendingRejectOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef InstancesPendingRejectReturn = Map<String, RaviJson>;

InstancesPendingRejectReturn instancesPendingRejectReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesRestoreReturn = Map<String, RaviJson>;

InstancesRestoreReturn instancesRestoreReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesRoutesAddOptions {
  const InstancesRoutesAddOptions({this.allowRuntimeMismatch, this.channel, this.dmScope, this.policy, this.priority, this.session});

  final bool? allowRuntimeMismatch;
  final String? channel;
  final String? dmScope;
  final String? policy;
  final String? priority;
  final String? session;

  void encodeBody(Map<String, RaviJson> into) {
    if (allowRuntimeMismatch != null) {
      into["allowRuntimeMismatch"] = RaviJson.from(allowRuntimeMismatch);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (dmScope != null) {
      into["dmScope"] = RaviJson.from(dmScope);
    }
    if (policy != null) {
      into["policy"] = RaviJson.from(policy);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
  }
}

typedef InstancesRoutesAddReturn = Map<String, RaviJson>;

InstancesRoutesAddReturn instancesRoutesAddReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesRoutesDeletedReturn = Map<String, RaviJson>;

InstancesRoutesDeletedReturn instancesRoutesDeletedReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesRoutesListOptions {
  const InstancesRoutesListOptions({this.limit, this.offset, this.tag});

  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

typedef InstancesRoutesListReturn = Map<String, RaviJson>;

InstancesRoutesListReturn instancesRoutesListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesRoutesRemoveOptions {
  const InstancesRoutesRemoveOptions({this.allowRuntimeMismatch});

  final bool? allowRuntimeMismatch;

  void encodeBody(Map<String, RaviJson> into) {
    if (allowRuntimeMismatch != null) {
      into["allowRuntimeMismatch"] = RaviJson.from(allowRuntimeMismatch);
    }
  }
}

typedef InstancesRoutesRemoveReturn = Map<String, RaviJson>;

InstancesRoutesRemoveReturn instancesRoutesRemoveReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesRoutesRestoreOptions {
  const InstancesRoutesRestoreOptions({this.allowRuntimeMismatch});

  final bool? allowRuntimeMismatch;

  void encodeBody(Map<String, RaviJson> into) {
    if (allowRuntimeMismatch != null) {
      into["allowRuntimeMismatch"] = RaviJson.from(allowRuntimeMismatch);
    }
  }
}

typedef InstancesRoutesRestoreReturn = Map<String, RaviJson>;

InstancesRoutesRestoreReturn instancesRoutesRestoreReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesRoutesSetOptions {
  const InstancesRoutesSetOptions({this.allowRuntimeMismatch});

  final bool? allowRuntimeMismatch;

  void encodeBody(Map<String, RaviJson> into) {
    if (allowRuntimeMismatch != null) {
      into["allowRuntimeMismatch"] = RaviJson.from(allowRuntimeMismatch);
    }
  }
}

typedef InstancesRoutesSetReturn = Map<String, RaviJson>;

InstancesRoutesSetReturn instancesRoutesSetReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesRoutesShowReturn = Map<String, RaviJson>;

InstancesRoutesShowReturn instancesRoutesShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesSetReturn = Map<String, RaviJson>;

InstancesSetReturn instancesSetReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesShowReturn = Map<String, RaviJson>;

InstancesShowReturn instancesShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef InstancesStatusReturn = Map<String, RaviJson>;

InstancesStatusReturn instancesStatusReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class InstancesTargetOptions {
  const InstancesTargetOptions({this.channel, this.pattern});

  final String? channel;
  final String? pattern;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (pattern != null) {
      into["pattern"] = RaviJson.from(pattern);
    }
  }
}

typedef InstancesTargetReturn = Map<String, RaviJson>;

InstancesTargetReturn instancesTargetReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailAccountsCreateOptions {
  const MailAccountsCreateOptions({this.credentialsRef, this.id, this.name, this.provider});

  final String? credentialsRef;
  final String? id;
  final String? name;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (credentialsRef != null) {
      into["credentialsRef"] = RaviJson.from(credentialsRef);
    }
    if (id != null) {
      into["id"] = RaviJson.from(id);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class MailAccountsCreateReturn {
  const MailAccountsCreateReturn({required this.account});

  final RaviJson account;

  factory MailAccountsCreateReturn.fromJson(Map<String, Object?> json) {
    return MailAccountsCreateReturn(
      account: RaviJson.from(json["account"]),
    );
  }

  static MailAccountsCreateReturn fromJsonValue(Object? json) {
    return MailAccountsCreateReturn.fromJson(raviJsonObject(json, "MailAccountsCreateReturn"));
  }
}

MailAccountsCreateReturn mailAccountsCreateReturnFromJson(Object? json) => MailAccountsCreateReturn.fromJsonValue(json);

class MailAccountsListOptions {
  const MailAccountsListOptions({this.fields, this.limit, this.offset, this.provider, this.status});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? provider;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class MailAccountsListReturn {
  const MailAccountsListReturn({required this.accounts});

  final List<RaviJson> accounts;

  factory MailAccountsListReturn.fromJson(Map<String, Object?> json) {
    return MailAccountsListReturn(
      accounts: raviJsonAsList(json["accounts"], RaviJson.from),
    );
  }

  static MailAccountsListReturn fromJsonValue(Object? json) {
    return MailAccountsListReturn.fromJson(raviJsonObject(json, "MailAccountsListReturn"));
  }
}

MailAccountsListReturn mailAccountsListReturnFromJson(Object? json) => MailAccountsListReturn.fromJsonValue(json);

class MailAccountsSyncOptions {
  const MailAccountsSyncOptions({this.once});

  final bool? once;

  void encodeBody(Map<String, RaviJson> into) {
    if (once != null) {
      into["once"] = RaviJson.from(once);
    }
  }
}

typedef MailAccountsSyncReturn = RaviJson;

MailAccountsSyncReturn mailAccountsSyncReturnFromJson(Object? json) => RaviJson.from(json);

class MailDomainsCreateOptions {
  const MailDomainsCreateOptions({this.console});

  final String? console;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
  }
}

typedef MailDomainsCreateReturn = Map<String, RaviJson>;

MailDomainsCreateReturn mailDomainsCreateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailDomainsListOptions {
  const MailDomainsListOptions({this.console, this.limit, this.offset});

  final String? console;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

typedef MailDomainsListReturn = Map<String, RaviJson>;

MailDomainsListReturn mailDomainsListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailMailboxesCreateOptions {
  const MailMailboxesCreateOptions({this.account, this.default_, this.name, this.providerMailboxId, this.role});

  final String? account;
  final bool? default_;
  final String? name;
  final String? providerMailboxId;
  final String? role;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (default_ != null) {
      into["default"] = RaviJson.from(default_);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (providerMailboxId != null) {
      into["providerMailboxId"] = RaviJson.from(providerMailboxId);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
  }
}

class MailMailboxesCreateReturn {
  const MailMailboxesCreateReturn({required this.mailbox});

  final RaviJson mailbox;

  factory MailMailboxesCreateReturn.fromJson(Map<String, Object?> json) {
    return MailMailboxesCreateReturn(
      mailbox: RaviJson.from(json["mailbox"]),
    );
  }

  static MailMailboxesCreateReturn fromJsonValue(Object? json) {
    return MailMailboxesCreateReturn.fromJson(raviJsonObject(json, "MailMailboxesCreateReturn"));
  }
}

MailMailboxesCreateReturn mailMailboxesCreateReturnFromJson(Object? json) => MailMailboxesCreateReturn.fromJsonValue(json);

class MailMailboxesDisableReturn {
  const MailMailboxesDisableReturn({required this.mailbox});

  final RaviJson mailbox;

  factory MailMailboxesDisableReturn.fromJson(Map<String, Object?> json) {
    return MailMailboxesDisableReturn(
      mailbox: RaviJson.from(json["mailbox"]),
    );
  }

  static MailMailboxesDisableReturn fromJsonValue(Object? json) {
    return MailMailboxesDisableReturn.fromJson(raviJsonObject(json, "MailMailboxesDisableReturn"));
  }
}

MailMailboxesDisableReturn mailMailboxesDisableReturnFromJson(Object? json) => MailMailboxesDisableReturn.fromJsonValue(json);

class MailMailboxesListOptions {
  const MailMailboxesListOptions({this.account, this.fields, this.limit, this.offset, this.status});

  final String? account;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class MailMailboxesListReturn {
  const MailMailboxesListReturn({required this.mailboxes});

  final List<RaviJson> mailboxes;

  factory MailMailboxesListReturn.fromJson(Map<String, Object?> json) {
    return MailMailboxesListReturn(
      mailboxes: raviJsonAsList(json["mailboxes"], RaviJson.from),
    );
  }

  static MailMailboxesListReturn fromJsonValue(Object? json) {
    return MailMailboxesListReturn.fromJson(raviJsonObject(json, "MailMailboxesListReturn"));
  }
}

MailMailboxesListReturn mailMailboxesListReturnFromJson(Object? json) => MailMailboxesListReturn.fromJsonValue(json);

class MailMailboxesShowReturn {
  const MailMailboxesShowReturn({required this.mailbox});

  final RaviJson mailbox;

  factory MailMailboxesShowReturn.fromJson(Map<String, Object?> json) {
    return MailMailboxesShowReturn(
      mailbox: RaviJson.from(json["mailbox"]),
    );
  }

  static MailMailboxesShowReturn fromJsonValue(Object? json) {
    return MailMailboxesShowReturn.fromJson(raviJsonObject(json, "MailMailboxesShowReturn"));
  }
}

MailMailboxesShowReturn mailMailboxesShowReturnFromJson(Object? json) => MailMailboxesShowReturn.fromJsonValue(json);

class MailMessagesImportOptions {
  const MailMessagesImportOptions({this.body, this.from, this.mailbox, this.provider, this.providerMessageId, this.providerThreadId, this.rfcMessageId, this.subject, this.to});

  final String? body;
  final String? from;
  final String? mailbox;
  final String? provider;
  final String? providerMessageId;
  final String? providerThreadId;
  final String? rfcMessageId;
  final String? subject;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (body != null) {
      into["body"] = RaviJson.from(body);
    }
    if (from != null) {
      into["from"] = RaviJson.from(from);
    }
    if (mailbox != null) {
      into["mailbox"] = RaviJson.from(mailbox);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (providerMessageId != null) {
      into["providerMessageId"] = RaviJson.from(providerMessageId);
    }
    if (providerThreadId != null) {
      into["providerThreadId"] = RaviJson.from(providerThreadId);
    }
    if (rfcMessageId != null) {
      into["rfcMessageId"] = RaviJson.from(rfcMessageId);
    }
    if (subject != null) {
      into["subject"] = RaviJson.from(subject);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

class MailMessagesImportReturn {
  const MailMessagesImportReturn({required this.inboxCreated, required this.inboxItem, required this.message});

  final bool inboxCreated;
  final RaviJson inboxItem;
  final RaviJson message;

  factory MailMessagesImportReturn.fromJson(Map<String, Object?> json) {
    return MailMessagesImportReturn(
      inboxCreated: raviJsonAsBool(json["inboxCreated"]),
      inboxItem: RaviJson.from(json["inboxItem"]),
      message: RaviJson.from(json["message"]),
    );
  }

  static MailMessagesImportReturn fromJsonValue(Object? json) {
    return MailMessagesImportReturn.fromJson(raviJsonObject(json, "MailMessagesImportReturn"));
  }
}

MailMessagesImportReturn mailMessagesImportReturnFromJson(Object? json) => MailMessagesImportReturn.fromJsonValue(json);

class MailMessagesListOptions {
  const MailMessagesListOptions({this.addresses, this.fields, this.limit, this.mailbox, this.offset, this.query, this.status});

  final bool? addresses;
  final String? fields;
  final String? limit;
  final String? mailbox;
  final String? offset;
  final String? query;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (addresses != null) {
      into["addresses"] = RaviJson.from(addresses);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (mailbox != null) {
      into["mailbox"] = RaviJson.from(mailbox);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (query != null) {
      into["query"] = RaviJson.from(query);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class MailMessagesListReturn {
  const MailMessagesListReturn({required this.messages});

  final List<RaviJson> messages;

  factory MailMessagesListReturn.fromJson(Map<String, Object?> json) {
    return MailMessagesListReturn(
      messages: raviJsonAsList(json["messages"], RaviJson.from),
    );
  }

  static MailMessagesListReturn fromJsonValue(Object? json) {
    return MailMessagesListReturn.fromJson(raviJsonObject(json, "MailMessagesListReturn"));
  }
}

MailMessagesListReturn mailMessagesListReturnFromJson(Object? json) => MailMessagesListReturn.fromJsonValue(json);

class MailMessagesReadOptions {
  const MailMessagesReadOptions({this.addresses});

  final bool? addresses;

  void encodeBody(Map<String, RaviJson> into) {
    if (addresses != null) {
      into["addresses"] = RaviJson.from(addresses);
    }
  }
}

class MailMessagesReadReturn {
  const MailMessagesReadReturn({required this.message});

  final RaviJson message;

  factory MailMessagesReadReturn.fromJson(Map<String, Object?> json) {
    return MailMessagesReadReturn(
      message: RaviJson.from(json["message"]),
    );
  }

  static MailMessagesReadReturn fromJsonValue(Object? json) {
    return MailMessagesReadReturn.fromJson(raviJsonObject(json, "MailMessagesReadReturn"));
  }
}

MailMessagesReadReturn mailMessagesReadReturnFromJson(Object? json) => MailMessagesReadReturn.fromJsonValue(json);

class MailMessagesSearchOptions {
  const MailMessagesSearchOptions({this.limit, this.mailbox});

  final String? limit;
  final String? mailbox;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (mailbox != null) {
      into["mailbox"] = RaviJson.from(mailbox);
    }
  }
}

class MailMessagesSearchReturn {
  const MailMessagesSearchReturn({required this.messages});

  final List<RaviJson> messages;

  factory MailMessagesSearchReturn.fromJson(Map<String, Object?> json) {
    return MailMessagesSearchReturn(
      messages: raviJsonAsList(json["messages"], RaviJson.from),
    );
  }

  static MailMessagesSearchReturn fromJsonValue(Object? json) {
    return MailMessagesSearchReturn.fromJson(raviJsonObject(json, "MailMessagesSearchReturn"));
  }
}

MailMessagesSearchReturn mailMessagesSearchReturnFromJson(Object? json) => MailMessagesSearchReturn.fromJsonValue(json);

class MailOutboxInspectReturn {
  const MailOutboxInspectReturn({required this.outbox});

  final RaviJson outbox;

  factory MailOutboxInspectReturn.fromJson(Map<String, Object?> json) {
    return MailOutboxInspectReturn(
      outbox: RaviJson.from(json["outbox"]),
    );
  }

  static MailOutboxInspectReturn fromJsonValue(Object? json) {
    return MailOutboxInspectReturn.fromJson(raviJsonObject(json, "MailOutboxInspectReturn"));
  }
}

MailOutboxInspectReturn mailOutboxInspectReturnFromJson(Object? json) => MailOutboxInspectReturn.fromJsonValue(json);

class MailOutboxListOptions {
  const MailOutboxListOptions({this.fields, this.limit, this.mailbox, this.offset, this.status});

  final String? fields;
  final String? limit;
  final String? mailbox;
  final String? offset;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (mailbox != null) {
      into["mailbox"] = RaviJson.from(mailbox);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class MailOutboxListReturn {
  const MailOutboxListReturn({required this.outbox});

  final List<RaviJson> outbox;

  factory MailOutboxListReturn.fromJson(Map<String, Object?> json) {
    return MailOutboxListReturn(
      outbox: raviJsonAsList(json["outbox"], RaviJson.from),
    );
  }

  static MailOutboxListReturn fromJsonValue(Object? json) {
    return MailOutboxListReturn.fromJson(raviJsonObject(json, "MailOutboxListReturn"));
  }
}

MailOutboxListReturn mailOutboxListReturnFromJson(Object? json) => MailOutboxListReturn.fromJsonValue(json);

class MailOutboxRetryReturn {
  const MailOutboxRetryReturn({required this.outbox});

  final RaviJson outbox;

  factory MailOutboxRetryReturn.fromJson(Map<String, Object?> json) {
    return MailOutboxRetryReturn(
      outbox: RaviJson.from(json["outbox"]),
    );
  }

  static MailOutboxRetryReturn fromJsonValue(Object? json) {
    return MailOutboxRetryReturn.fromJson(raviJsonObject(json, "MailOutboxRetryReturn"));
  }
}

MailOutboxRetryReturn mailOutboxRetryReturnFromJson(Object? json) => MailOutboxRetryReturn.fromJsonValue(json);

class MailOutboxStatusReturn {
  const MailOutboxStatusReturn({required this.counts, required this.total});

  final Map<String, double> counts;
  final double total;

  factory MailOutboxStatusReturn.fromJson(Map<String, Object?> json) {
    return MailOutboxStatusReturn(
      counts: raviJsonAsMap(json["counts"], raviJsonAsDouble),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static MailOutboxStatusReturn fromJsonValue(Object? json) {
    return MailOutboxStatusReturn.fromJson(raviJsonObject(json, "MailOutboxStatusReturn"));
  }
}

MailOutboxStatusReturn mailOutboxStatusReturnFromJson(Object? json) => MailOutboxStatusReturn.fromJsonValue(json);

class MailProvidersListOptions {
  const MailProvidersListOptions({this.fields, this.limit, this.offset});

  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class MailProvidersListReturn {
  const MailProvidersListReturn({required this.providers});

  final List<RaviJson> providers;

  factory MailProvidersListReturn.fromJson(Map<String, Object?> json) {
    return MailProvidersListReturn(
      providers: raviJsonAsList(json["providers"], RaviJson.from),
    );
  }

  static MailProvidersListReturn fromJsonValue(Object? json) {
    return MailProvidersListReturn.fromJson(raviJsonObject(json, "MailProvidersListReturn"));
  }
}

MailProvidersListReturn mailProvidersListReturnFromJson(Object? json) => MailProvidersListReturn.fromJsonValue(json);

class MailProvidersRaviMailMailboxesCreateOptions {
  const MailProvidersRaviMailMailboxesCreateOptions({this.console, this.domain});

  final String? console;
  final String? domain;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (domain != null) {
      into["domain"] = RaviJson.from(domain);
    }
  }
}

typedef MailProvidersRaviMailMailboxesCreateReturn = Map<String, RaviJson>;

MailProvidersRaviMailMailboxesCreateReturn mailProvidersRaviMailMailboxesCreateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailProvidersRaviMailMailboxesDisableOptions {
  const MailProvidersRaviMailMailboxesDisableOptions({this.console});

  final String? console;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
  }
}

typedef MailProvidersRaviMailMailboxesDisableReturn = Map<String, RaviJson>;

MailProvidersRaviMailMailboxesDisableReturn mailProvidersRaviMailMailboxesDisableReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailProvidersRaviMailMailboxesListOptions {
  const MailProvidersRaviMailMailboxesListOptions({this.console, this.domain, this.limit, this.offset});

  final String? console;
  final String? domain;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (domain != null) {
      into["domain"] = RaviJson.from(domain);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

typedef MailProvidersRaviMailMailboxesListReturn = Map<String, RaviJson>;

MailProvidersRaviMailMailboxesListReturn mailProvidersRaviMailMailboxesListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailProvidersRaviMailMailboxesShowOptions {
  const MailProvidersRaviMailMailboxesShowOptions({this.console});

  final String? console;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
  }
}

typedef MailProvidersRaviMailMailboxesShowReturn = Map<String, RaviJson>;

MailProvidersRaviMailMailboxesShowReturn mailProvidersRaviMailMailboxesShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailProvidersRaviMailMessagesListOptions {
  const MailProvidersRaviMailMessagesListOptions({this.addresses, this.console, this.limit, this.mailbox, this.offset});

  final bool? addresses;
  final String? console;
  final String? limit;
  final String? mailbox;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (addresses != null) {
      into["addresses"] = RaviJson.from(addresses);
    }
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (mailbox != null) {
      into["mailbox"] = RaviJson.from(mailbox);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

typedef MailProvidersRaviMailMessagesListReturn = Map<String, RaviJson>;

MailProvidersRaviMailMessagesListReturn mailProvidersRaviMailMessagesListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailProvidersRaviMailMessagesReadOptions {
  const MailProvidersRaviMailMessagesReadOptions({this.console, this.payload});

  final String? console;
  final String? payload;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (payload != null) {
      into["payload"] = RaviJson.from(payload);
    }
  }
}

typedef MailProvidersRaviMailMessagesReadReturn = Map<String, RaviJson>;

MailProvidersRaviMailMessagesReadReturn mailProvidersRaviMailMessagesReadReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailProvidersRaviMailMessagesShowOptions {
  const MailProvidersRaviMailMessagesShowOptions({this.addresses, this.console});

  final bool? addresses;
  final String? console;

  void encodeBody(Map<String, RaviJson> into) {
    if (addresses != null) {
      into["addresses"] = RaviJson.from(addresses);
    }
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
  }
}

typedef MailProvidersRaviMailMessagesShowReturn = Map<String, RaviJson>;

MailProvidersRaviMailMessagesShowReturn mailProvidersRaviMailMessagesShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailProvidersRaviMailSendOptions {
  const MailProvidersRaviMailSendOptions({this.body, this.console, this.execute, this.from, this.idempotencyKey, this.subject, this.to});

  final String? body;
  final String? console;
  final bool? execute;
  final String? from;
  final String? idempotencyKey;
  final String? subject;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (body != null) {
      into["body"] = RaviJson.from(body);
    }
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (from != null) {
      into["from"] = RaviJson.from(from);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (subject != null) {
      into["subject"] = RaviJson.from(subject);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

typedef MailProvidersRaviMailSendReturn = Map<String, RaviJson>;

MailProvidersRaviMailSendReturn mailProvidersRaviMailSendReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class MailReplyOptions {
  const MailReplyOptions({this.bcc, this.body, this.cc, this.execute, this.from, this.idempotencyKey, this.subject, this.to});

  final String? bcc;
  final String? body;
  final String? cc;
  final bool? execute;
  final String? from;
  final String? idempotencyKey;
  final String? subject;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (bcc != null) {
      into["bcc"] = RaviJson.from(bcc);
    }
    if (body != null) {
      into["body"] = RaviJson.from(body);
    }
    if (cc != null) {
      into["cc"] = RaviJson.from(cc);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (from != null) {
      into["from"] = RaviJson.from(from);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (subject != null) {
      into["subject"] = RaviJson.from(subject);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

class MailReplyReturn {
  const MailReplyReturn({required this.message, required this.outbox, required this.queued});

  final RaviJson message;
  final RaviJson outbox;
  final bool queued;

  factory MailReplyReturn.fromJson(Map<String, Object?> json) {
    return MailReplyReturn(
      message: RaviJson.from(json["message"]),
      outbox: RaviJson.from(json["outbox"]),
      queued: raviJsonAsBool(json["queued"]),
    );
  }

  static MailReplyReturn fromJsonValue(Object? json) {
    return MailReplyReturn.fromJson(raviJsonObject(json, "MailReplyReturn"));
  }
}

MailReplyReturn mailReplyReturnFromJson(Object? json) => MailReplyReturn.fromJsonValue(json);

class MailSendOptions {
  const MailSendOptions({this.body, this.execute, this.from, this.idempotencyKey, this.subject, this.to});

  final String? body;
  final bool? execute;
  final String? from;
  final String? idempotencyKey;
  final String? subject;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (body != null) {
      into["body"] = RaviJson.from(body);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (from != null) {
      into["from"] = RaviJson.from(from);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (subject != null) {
      into["subject"] = RaviJson.from(subject);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

class MailSendReturn {
  const MailSendReturn({required this.message, required this.outbox, required this.queued});

  final RaviJson message;
  final RaviJson outbox;
  final bool queued;

  factory MailSendReturn.fromJson(Map<String, Object?> json) {
    return MailSendReturn(
      message: RaviJson.from(json["message"]),
      outbox: RaviJson.from(json["outbox"]),
      queued: raviJsonAsBool(json["queued"]),
    );
  }

  static MailSendReturn fromJsonValue(Object? json) {
    return MailSendReturn.fromJson(raviJsonObject(json, "MailSendReturn"));
  }
}

MailSendReturn mailSendReturnFromJson(Object? json) => MailSendReturn.fromJsonValue(json);

class MailThreadsReadOptions {
  const MailThreadsReadOptions({this.addresses});

  final bool? addresses;

  void encodeBody(Map<String, RaviJson> into) {
    if (addresses != null) {
      into["addresses"] = RaviJson.from(addresses);
    }
  }
}

class MailThreadsReadReturn {
  const MailThreadsReadReturn({required this.messages, required this.thread});

  final List<RaviJson> messages;
  final RaviJson thread;

  factory MailThreadsReadReturn.fromJson(Map<String, Object?> json) {
    return MailThreadsReadReturn(
      messages: raviJsonAsList(json["messages"], RaviJson.from),
      thread: RaviJson.from(json["thread"]),
    );
  }

  static MailThreadsReadReturn fromJsonValue(Object? json) {
    return MailThreadsReadReturn.fromJson(raviJsonObject(json, "MailThreadsReadReturn"));
  }
}

MailThreadsReadReturn mailThreadsReadReturnFromJson(Object? json) => MailThreadsReadReturn.fromJsonValue(json);

class MediaSendOptions {
  const MediaSendOptions({this.account, this.caption, this.channel, this.execute, this.ptt, this.threadId, this.to});

  final String? account;
  final String? caption;
  final String? channel;
  final bool? execute;
  final bool? ptt;
  final String? threadId;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (caption != null) {
      into["caption"] = RaviJson.from(caption);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (ptt != null) {
      into["ptt"] = RaviJson.from(ptt);
    }
    if (threadId != null) {
      into["threadId"] = RaviJson.from(threadId);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

class MediaSendReturn {
  const MediaSendReturn({required this.delivery, required this.media, required this.success, required this.target});

  final Map<String, RaviJson> delivery;
  final RaviJson media;
  final bool success;
  final RaviJson target;

  factory MediaSendReturn.fromJson(Map<String, Object?> json) {
    return MediaSendReturn(
      delivery: raviJsonAsRaviJsonMap(json["delivery"]),
      media: RaviJson.from(json["media"]),
      success: raviJsonAsBool(json["success"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static MediaSendReturn fromJsonValue(Object? json) {
    return MediaSendReturn.fromJson(raviJsonObject(json, "MediaSendReturn"));
  }
}

MediaSendReturn mediaSendReturnFromJson(Object? json) => MediaSendReturn.fromJsonValue(json);

class MeetingsFinalizeOptions {
  const MeetingsFinalizeOptions({this.noPostTranscribe, this.runDir, this.title});

  final bool? noPostTranscribe;
  final String? runDir;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (noPostTranscribe != null) {
      into["noPostTranscribe"] = RaviJson.from(noPostTranscribe);
    }
    if (runDir != null) {
      into["runDir"] = RaviJson.from(runDir);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class MeetingsFinalizeReturn {
  const MeetingsFinalizeReturn({required this.artifactId, required this.artifactPath, required this.diagnosticCount, required this.handoffMessage, required this.mediaRefCount, required this.session, required this.transcriptSegmentCount});

  final String artifactId;
  final String artifactPath;
  final double diagnosticCount;
  final String handoffMessage;
  final double mediaRefCount;
  final RaviJson session;
  final double transcriptSegmentCount;

  factory MeetingsFinalizeReturn.fromJson(Map<String, Object?> json) {
    return MeetingsFinalizeReturn(
      artifactId: raviJsonAsString(json["artifactId"]),
      artifactPath: raviJsonAsString(json["artifactPath"]),
      diagnosticCount: raviJsonAsDouble(json["diagnosticCount"]),
      handoffMessage: raviJsonAsString(json["handoffMessage"]),
      mediaRefCount: raviJsonAsDouble(json["mediaRefCount"]),
      session: RaviJson.from(json["session"]),
      transcriptSegmentCount: raviJsonAsDouble(json["transcriptSegmentCount"]),
    );
  }

  static MeetingsFinalizeReturn fromJsonValue(Object? json) {
    return MeetingsFinalizeReturn.fromJson(raviJsonObject(json, "MeetingsFinalizeReturn"));
  }
}

MeetingsFinalizeReturn meetingsFinalizeReturnFromJson(Object? json) => MeetingsFinalizeReturn.fromJsonValue(json);

class MeetingsProfilesInitOptions {
  const MeetingsProfilesInitOptions({this.source});

  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class MeetingsProfilesInitReturn {
  const MeetingsProfilesInitReturn({required this.profileDir, required this.profilePath, required this.sourceKind});

  final String profileDir;
  final String profilePath;
  final String sourceKind;

  factory MeetingsProfilesInitReturn.fromJson(Map<String, Object?> json) {
    return MeetingsProfilesInitReturn(
      profileDir: raviJsonAsString(json["profileDir"]),
      profilePath: raviJsonAsString(json["profilePath"]),
      sourceKind: raviJsonAsString(json["sourceKind"]),
    );
  }

  static MeetingsProfilesInitReturn fromJsonValue(Object? json) {
    return MeetingsProfilesInitReturn.fromJson(raviJsonObject(json, "MeetingsProfilesInitReturn"));
  }
}

MeetingsProfilesInitReturn meetingsProfilesInitReturnFromJson(Object? json) => MeetingsProfilesInitReturn.fromJsonValue(json);

class MeetingsProfilesListOptions {
  const MeetingsProfilesListOptions({this.fields, this.limit, this.offset});

  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class MeetingsProfilesListReturn {
  const MeetingsProfilesListReturn({required this.items, required this.pagination, required this.profiles, required this.total});

  final List<RaviJson> items;
  final RaviJson pagination;
  final List<RaviJson> profiles;
  final double total;

  factory MeetingsProfilesListReturn.fromJson(Map<String, Object?> json) {
    return MeetingsProfilesListReturn(
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      profiles: raviJsonAsList(json["profiles"], RaviJson.from),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static MeetingsProfilesListReturn fromJsonValue(Object? json) {
    return MeetingsProfilesListReturn.fromJson(raviJsonObject(json, "MeetingsProfilesListReturn"));
  }
}

MeetingsProfilesListReturn meetingsProfilesListReturnFromJson(Object? json) => MeetingsProfilesListReturn.fromJsonValue(json);

class MeetingsProfilesShowReturn {
  const MeetingsProfilesShowReturn({required this.chrome, required this.defaults, required this.id, required this.label, required this.live, required this.provider, required this.source, required this.sourceKind, required this.version, required this.voice});

  final RaviJson chrome;
  final RaviJson defaults;
  final String id;
  final String label;
  final RaviJson live;
  final String provider;
  final String source;
  final String sourceKind;
  final String version;
  final RaviJson voice;

  factory MeetingsProfilesShowReturn.fromJson(Map<String, Object?> json) {
    return MeetingsProfilesShowReturn(
      chrome: RaviJson.from(json["chrome"]),
      defaults: RaviJson.from(json["defaults"]),
      id: raviJsonAsString(json["id"]),
      label: raviJsonAsString(json["label"]),
      live: RaviJson.from(json["live"]),
      provider: raviJsonAsString(json["provider"]),
      source: raviJsonAsString(json["source"]),
      sourceKind: raviJsonAsString(json["sourceKind"]),
      version: raviJsonAsString(json["version"]),
      voice: RaviJson.from(json["voice"]),
    );
  }

  static MeetingsProfilesShowReturn fromJsonValue(Object? json) {
    return MeetingsProfilesShowReturn.fromJson(raviJsonObject(json, "MeetingsProfilesShowReturn"));
  }
}

MeetingsProfilesShowReturn meetingsProfilesShowReturnFromJson(Object? json) => MeetingsProfilesShowReturn.fromJsonValue(json);

class MeetingsProfilesValidateReturn {
  const MeetingsProfilesValidateReturn({required this.results, required this.valid});

  final List<RaviJson> results;
  final bool valid;

  factory MeetingsProfilesValidateReturn.fromJson(Map<String, Object?> json) {
    return MeetingsProfilesValidateReturn(
      results: raviJsonAsList(json["results"], RaviJson.from),
      valid: raviJsonAsBool(json["valid"]),
    );
  }

  static MeetingsProfilesValidateReturn fromJsonValue(Object? json) {
    return MeetingsProfilesValidateReturn.fromJson(raviJsonObject(json, "MeetingsProfilesValidateReturn"));
  }
}

MeetingsProfilesValidateReturn meetingsProfilesValidateReturnFromJson(Object? json) => MeetingsProfilesValidateReturn.fromJsonValue(json);

class MeetingsVoiceRuntimesReturn {
  const MeetingsVoiceRuntimesReturn({required this.candidates, required this.defaultRuntimeId, required this.recommendation});

  final List<RaviJson> candidates;
  final String defaultRuntimeId;
  final String recommendation;

  factory MeetingsVoiceRuntimesReturn.fromJson(Map<String, Object?> json) {
    return MeetingsVoiceRuntimesReturn(
      candidates: raviJsonAsList(json["candidates"], RaviJson.from),
      defaultRuntimeId: raviJsonAsString(json["defaultRuntimeId"]),
      recommendation: raviJsonAsString(json["recommendation"]),
    );
  }

  static MeetingsVoiceRuntimesReturn fromJsonValue(Object? json) {
    return MeetingsVoiceRuntimesReturn.fromJson(raviJsonObject(json, "MeetingsVoiceRuntimesReturn"));
  }
}

MeetingsVoiceRuntimesReturn meetingsVoiceRuntimesReturnFromJson(Object? json) => MeetingsVoiceRuntimesReturn.fromJsonValue(json);

typedef MetricsDatesReturn = List<String>;

MetricsDatesReturn metricsDatesReturnFromJson(Object? json) => raviJsonAsList(json, raviJsonAsString);

class MetricsRollupOptions {
  const MetricsRollupOptions({this.since, this.through});

  final String? since;
  final String? through;

  void encodeBody(Map<String, RaviJson> into) {
    if (since != null) {
      into["since"] = RaviJson.from(since);
    }
    if (through != null) {
      into["through"] = RaviJson.from(through);
    }
  }
}

class MetricsRollupReturn {
  const MetricsRollupReturn({required this.dates, required this.rowsWritten});

  final List<String> dates;
  final double rowsWritten;

  factory MetricsRollupReturn.fromJson(Map<String, Object?> json) {
    return MetricsRollupReturn(
      dates: raviJsonAsList(json["dates"], raviJsonAsString),
      rowsWritten: raviJsonAsDouble(json["rowsWritten"]),
    );
  }

  static MetricsRollupReturn fromJsonValue(Object? json) {
    return MetricsRollupReturn.fromJson(raviJsonObject(json, "MetricsRollupReturn"));
  }
}

MetricsRollupReturn metricsRollupReturnFromJson(Object? json) => MetricsRollupReturn.fromJsonValue(json);

class MetricsShowOptions {
  const MetricsShowOptions({this.agent, this.by, this.days, this.fields, this.since, this.through});

  final String? agent;
  final String? by;
  final String? days;
  final String? fields;
  final String? since;
  final String? through;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (by != null) {
      into["by"] = RaviJson.from(by);
    }
    if (days != null) {
      into["days"] = RaviJson.from(days);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (since != null) {
      into["since"] = RaviJson.from(since);
    }
    if (through != null) {
      into["through"] = RaviJson.from(through);
    }
  }
}

typedef MetricsShowReturn = List<RaviJson>;

MetricsShowReturn metricsShowReturnFromJson(Object? json) => raviJsonAsList(json, RaviJson.from);

class ObserversListOptions {
  const ObserversListOptions({this.agent, this.fields, this.limit, this.offset, this.session});

  final String? agent;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? session;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
  }
}

class ObserversListReturn {
  const ObserversListReturn({required this.bindings, required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> bindings;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory ObserversListReturn.fromJson(Map<String, Object?> json) {
    return ObserversListReturn(
      bindings: raviJsonAsList(json["bindings"], raviJsonAsRaviJsonMap),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ObserversListReturn fromJsonValue(Object? json) {
    return ObserversListReturn.fromJson(raviJsonObject(json, "ObserversListReturn"));
  }
}

ObserversListReturn observersListReturnFromJson(Object? json) => ObserversListReturn.fromJsonValue(json);

class ObserversProfilesInitOptions {
  const ObserversProfilesInitOptions({this.overwrite, this.source});

  final bool? overwrite;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (overwrite != null) {
      into["overwrite"] = RaviJson.from(overwrite);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class ObserversProfilesInitReturn {
  const ObserversProfilesInitReturn({required this.profileDir, required this.profilePath, required this.sourceKind});

  final String profileDir;
  final String profilePath;
  final String sourceKind;

  factory ObserversProfilesInitReturn.fromJson(Map<String, Object?> json) {
    return ObserversProfilesInitReturn(
      profileDir: raviJsonAsString(json["profileDir"]),
      profilePath: raviJsonAsString(json["profilePath"]),
      sourceKind: raviJsonAsString(json["sourceKind"]),
    );
  }

  static ObserversProfilesInitReturn fromJsonValue(Object? json) {
    return ObserversProfilesInitReturn.fromJson(raviJsonObject(json, "ObserversProfilesInitReturn"));
  }
}

ObserversProfilesInitReturn observersProfilesInitReturnFromJson(Object? json) => ObserversProfilesInitReturn.fromJsonValue(json);

class ObserversProfilesListOptions {
  const ObserversProfilesListOptions({this.fields, this.limit, this.offset});

  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class ObserversProfilesListReturn {
  const ObserversProfilesListReturn({required this.items, required this.pagination, required this.profiles, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> profiles;
  final double total;

  factory ObserversProfilesListReturn.fromJson(Map<String, Object?> json) {
    return ObserversProfilesListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      profiles: raviJsonAsList(json["profiles"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ObserversProfilesListReturn fromJsonValue(Object? json) {
    return ObserversProfilesListReturn.fromJson(raviJsonObject(json, "ObserversProfilesListReturn"));
  }
}

ObserversProfilesListReturn observersProfilesListReturnFromJson(Object? json) => ObserversProfilesListReturn.fromJsonValue(json);

class ObserversProfilesPreviewOptions {
  const ObserversProfilesPreviewOptions({this.event});

  final String? event;

  void encodeBody(Map<String, RaviJson> into) {
    if (event != null) {
      into["event"] = RaviJson.from(event);
    }
  }
}

class ObserversProfilesPreviewReturn {
  const ObserversProfilesPreviewReturn({required this.eventMarkdown, required this.eventType, required this.profile, required this.prompt});

  final String eventMarkdown;
  final String eventType;
  final Map<String, RaviJson> profile;
  final String prompt;

  factory ObserversProfilesPreviewReturn.fromJson(Map<String, Object?> json) {
    return ObserversProfilesPreviewReturn(
      eventMarkdown: raviJsonAsString(json["eventMarkdown"]),
      eventType: raviJsonAsString(json["eventType"]),
      profile: raviJsonAsRaviJsonMap(json["profile"]),
      prompt: raviJsonAsString(json["prompt"]),
    );
  }

  static ObserversProfilesPreviewReturn fromJsonValue(Object? json) {
    return ObserversProfilesPreviewReturn.fromJson(raviJsonObject(json, "ObserversProfilesPreviewReturn"));
  }
}

ObserversProfilesPreviewReturn observersProfilesPreviewReturnFromJson(Object? json) => ObserversProfilesPreviewReturn.fromJsonValue(json);

class ObserversProfilesShowReturn {
  const ObserversProfilesShowReturn({required this.body, required this.profile});

  final String body;
  final Map<String, RaviJson> profile;

  factory ObserversProfilesShowReturn.fromJson(Map<String, Object?> json) {
    return ObserversProfilesShowReturn(
      body: raviJsonAsString(json["body"]),
      profile: raviJsonAsRaviJsonMap(json["profile"]),
    );
  }

  static ObserversProfilesShowReturn fromJsonValue(Object? json) {
    return ObserversProfilesShowReturn.fromJson(raviJsonObject(json, "ObserversProfilesShowReturn"));
  }
}

ObserversProfilesShowReturn observersProfilesShowReturnFromJson(Object? json) => ObserversProfilesShowReturn.fromJsonValue(json);

class ObserversProfilesValidateReturn {
  const ObserversProfilesValidateReturn({required this.errors, required this.ok, required this.profiles});

  final List<Map<String, RaviJson>> errors;
  final bool ok;
  final List<Map<String, RaviJson>> profiles;

  factory ObserversProfilesValidateReturn.fromJson(Map<String, Object?> json) {
    return ObserversProfilesValidateReturn(
      errors: raviJsonAsList(json["errors"], raviJsonAsRaviJsonMap),
      ok: raviJsonAsBool(json["ok"]),
      profiles: raviJsonAsList(json["profiles"], raviJsonAsRaviJsonMap),
    );
  }

  static ObserversProfilesValidateReturn fromJsonValue(Object? json) {
    return ObserversProfilesValidateReturn.fromJson(raviJsonObject(json, "ObserversProfilesValidateReturn"));
  }
}

ObserversProfilesValidateReturn observersProfilesValidateReturnFromJson(Object? json) => ObserversProfilesValidateReturn.fromJsonValue(json);

class ObserversRefreshOptions {
  const ObserversRefreshOptions({this.reconcile});

  final String? reconcile;

  void encodeBody(Map<String, RaviJson> into) {
    if (reconcile != null) {
      into["reconcile"] = RaviJson.from(reconcile);
    }
  }
}

class ObserversRefreshReturn {
  const ObserversRefreshReturn({required this.bindings, required this.created, required this.disabled, required this.mode, required this.refreshedProfiles, required this.skipped, required this.source, required this.total});

  final List<Map<String, RaviJson>> bindings;
  final List<Map<String, RaviJson>> created;
  final List<Map<String, RaviJson>> disabled;
  final String mode;
  final List<Map<String, RaviJson>> refreshedProfiles;
  final List<Map<String, RaviJson>> skipped;
  final RaviJson source;
  final double total;

  factory ObserversRefreshReturn.fromJson(Map<String, Object?> json) {
    return ObserversRefreshReturn(
      bindings: raviJsonAsList(json["bindings"], raviJsonAsRaviJsonMap),
      created: raviJsonAsList(json["created"], raviJsonAsRaviJsonMap),
      disabled: raviJsonAsList(json["disabled"], raviJsonAsRaviJsonMap),
      mode: raviJsonAsString(json["mode"]),
      refreshedProfiles: raviJsonAsList(json["refreshedProfiles"], raviJsonAsRaviJsonMap),
      skipped: raviJsonAsList(json["skipped"], raviJsonAsRaviJsonMap),
      source: RaviJson.from(json["source"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ObserversRefreshReturn fromJsonValue(Object? json) {
    return ObserversRefreshReturn.fromJson(raviJsonObject(json, "ObserversRefreshReturn"));
  }
}

ObserversRefreshReturn observersRefreshReturnFromJson(Object? json) => ObserversRefreshReturn.fromJsonValue(json);

class ObserversRulesDisableReturn {
  const ObserversRulesDisableReturn({required this.rule, required this.success});

  final Map<String, RaviJson> rule;
  final bool success;

  factory ObserversRulesDisableReturn.fromJson(Map<String, Object?> json) {
    return ObserversRulesDisableReturn(
      rule: raviJsonAsRaviJsonMap(json["rule"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ObserversRulesDisableReturn fromJsonValue(Object? json) {
    return ObserversRulesDisableReturn.fromJson(raviJsonObject(json, "ObserversRulesDisableReturn"));
  }
}

ObserversRulesDisableReturn observersRulesDisableReturnFromJson(Object? json) => ObserversRulesDisableReturn.fromJsonValue(json);

class ObserversRulesEnableReturn {
  const ObserversRulesEnableReturn({required this.rule, required this.success});

  final Map<String, RaviJson> rule;
  final bool success;

  factory ObserversRulesEnableReturn.fromJson(Map<String, Object?> json) {
    return ObserversRulesEnableReturn(
      rule: raviJsonAsRaviJsonMap(json["rule"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ObserversRulesEnableReturn fromJsonValue(Object? json) {
    return ObserversRulesEnableReturn.fromJson(raviJsonObject(json, "ObserversRulesEnableReturn"));
  }
}

ObserversRulesEnableReturn observersRulesEnableReturnFromJson(Object? json) => ObserversRulesEnableReturn.fromJsonValue(json);

class ObserversRulesExplainReturn {
  const ObserversRulesExplainReturn({required this.bindings, required this.rules, required this.source});

  final List<Map<String, RaviJson>> bindings;
  final List<Map<String, RaviJson>> rules;
  final Map<String, RaviJson> source;

  factory ObserversRulesExplainReturn.fromJson(Map<String, Object?> json) {
    return ObserversRulesExplainReturn(
      bindings: raviJsonAsList(json["bindings"], raviJsonAsRaviJsonMap),
      rules: raviJsonAsList(json["rules"], raviJsonAsRaviJsonMap),
      source: raviJsonAsRaviJsonMap(json["source"]),
    );
  }

  static ObserversRulesExplainReturn fromJsonValue(Object? json) {
    return ObserversRulesExplainReturn.fromJson(raviJsonObject(json, "ObserversRulesExplainReturn"));
  }
}

ObserversRulesExplainReturn observersRulesExplainReturnFromJson(Object? json) => ObserversRulesExplainReturn.fromJsonValue(json);

class ObserversRulesListOptions {
  const ObserversRulesListOptions({this.fields, this.limit, this.offset});

  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class ObserversRulesListReturn {
  const ObserversRulesListReturn({required this.items, required this.pagination, required this.rules, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> rules;
  final double total;

  factory ObserversRulesListReturn.fromJson(Map<String, Object?> json) {
    return ObserversRulesListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      rules: raviJsonAsList(json["rules"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ObserversRulesListReturn fromJsonValue(Object? json) {
    return ObserversRulesListReturn.fromJson(raviJsonObject(json, "ObserversRulesListReturn"));
  }
}

ObserversRulesListReturn observersRulesListReturnFromJson(Object? json) => ObserversRulesListReturn.fromJsonValue(json);

class ObserversRulesRmOptions {
  const ObserversRulesRmOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class ObserversRulesRmReturn {
  const ObserversRulesRmReturn({required this.deleted, required this.success});

  final RaviJson deleted;
  final bool success;

  factory ObserversRulesRmReturn.fromJson(Map<String, Object?> json) {
    return ObserversRulesRmReturn(
      deleted: RaviJson.from(json["deleted"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ObserversRulesRmReturn fromJsonValue(Object? json) {
    return ObserversRulesRmReturn.fromJson(raviJsonObject(json, "ObserversRulesRmReturn"));
  }
}

ObserversRulesRmReturn observersRulesRmReturnFromJson(Object? json) => ObserversRulesRmReturn.fromJsonValue(json);

class ObserversRulesSetOptions {
  const ObserversRulesSetOptions({this.delivery, this.disabled, this.events, this.meta, this.mode, this.model, this.permissions, this.priority, this.profile, this.provider, this.role, this.scope, this.selector, this.sourceAgent, this.sourceProfile, this.sourceProject, this.sourceSession, this.sourceTask, this.tag, this.tagInherited, this.tagTarget});

  final String? delivery;
  final bool? disabled;
  final String? events;
  final String? meta;
  final String? mode;
  final String? model;
  final String? permissions;
  final String? priority;
  final String? profile;
  final String? provider;
  final String? role;
  final String? scope;
  final String? selector;
  final String? sourceAgent;
  final String? sourceProfile;
  final String? sourceProject;
  final String? sourceSession;
  final String? sourceTask;
  final String? tag;
  final bool? tagInherited;
  final String? tagTarget;

  void encodeBody(Map<String, RaviJson> into) {
    if (delivery != null) {
      into["delivery"] = RaviJson.from(delivery);
    }
    if (disabled != null) {
      into["disabled"] = RaviJson.from(disabled);
    }
    if (events != null) {
      into["events"] = RaviJson.from(events);
    }
    if (meta != null) {
      into["meta"] = RaviJson.from(meta);
    }
    if (mode != null) {
      into["mode"] = RaviJson.from(mode);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (permissions != null) {
      into["permissions"] = RaviJson.from(permissions);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (selector != null) {
      into["selector"] = RaviJson.from(selector);
    }
    if (sourceAgent != null) {
      into["sourceAgent"] = RaviJson.from(sourceAgent);
    }
    if (sourceProfile != null) {
      into["sourceProfile"] = RaviJson.from(sourceProfile);
    }
    if (sourceProject != null) {
      into["sourceProject"] = RaviJson.from(sourceProject);
    }
    if (sourceSession != null) {
      into["sourceSession"] = RaviJson.from(sourceSession);
    }
    if (sourceTask != null) {
      into["sourceTask"] = RaviJson.from(sourceTask);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
    if (tagInherited != null) {
      into["tagInherited"] = RaviJson.from(tagInherited);
    }
    if (tagTarget != null) {
      into["tagTarget"] = RaviJson.from(tagTarget);
    }
  }
}

class ObserversRulesSetReturn {
  const ObserversRulesSetReturn({required this.rule, required this.success});

  final Map<String, RaviJson> rule;
  final bool success;

  factory ObserversRulesSetReturn.fromJson(Map<String, Object?> json) {
    return ObserversRulesSetReturn(
      rule: raviJsonAsRaviJsonMap(json["rule"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ObserversRulesSetReturn fromJsonValue(Object? json) {
    return ObserversRulesSetReturn.fromJson(raviJsonObject(json, "ObserversRulesSetReturn"));
  }
}

ObserversRulesSetReturn observersRulesSetReturnFromJson(Object? json) => ObserversRulesSetReturn.fromJsonValue(json);

class ObserversRulesShowReturn {
  const ObserversRulesShowReturn({required this.rule});

  final Map<String, RaviJson> rule;

  factory ObserversRulesShowReturn.fromJson(Map<String, Object?> json) {
    return ObserversRulesShowReturn(
      rule: raviJsonAsRaviJsonMap(json["rule"]),
    );
  }

  static ObserversRulesShowReturn fromJsonValue(Object? json) {
    return ObserversRulesShowReturn.fromJson(raviJsonObject(json, "ObserversRulesShowReturn"));
  }
}

ObserversRulesShowReturn observersRulesShowReturnFromJson(Object? json) => ObserversRulesShowReturn.fromJsonValue(json);

class ObserversRulesValidateReturn {
  const ObserversRulesValidateReturn({required this.errors, required this.ok});

  final List<Map<String, RaviJson>> errors;
  final bool ok;

  factory ObserversRulesValidateReturn.fromJson(Map<String, Object?> json) {
    return ObserversRulesValidateReturn(
      errors: raviJsonAsList(json["errors"], raviJsonAsRaviJsonMap),
      ok: raviJsonAsBool(json["ok"]),
    );
  }

  static ObserversRulesValidateReturn fromJsonValue(Object? json) {
    return ObserversRulesValidateReturn.fromJson(raviJsonObject(json, "ObserversRulesValidateReturn"));
  }
}

ObserversRulesValidateReturn observersRulesValidateReturnFromJson(Object? json) => ObserversRulesValidateReturn.fromJsonValue(json);

class ObserversShowReturn {
  const ObserversShowReturn({required this.binding});

  final Map<String, RaviJson> binding;

  factory ObserversShowReturn.fromJson(Map<String, Object?> json) {
    return ObserversShowReturn(
      binding: raviJsonAsRaviJsonMap(json["binding"]),
    );
  }

  static ObserversShowReturn fromJsonValue(Object? json) {
    return ObserversShowReturn.fromJson(raviJsonObject(json, "ObserversShowReturn"));
  }
}

ObserversShowReturn observersShowReturnFromJson(Object? json) => ObserversShowReturn.fromJsonValue(json);

class PagesCreateOptions {
  const PagesCreateOptions({this.console, this.defaultSite, this.execute, this.project, this.visibility});

  final String? console;
  final bool? defaultSite;
  final bool? execute;
  final String? project;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (defaultSite != null) {
      into["defaultSite"] = RaviJson.from(defaultSite);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class PagesCreateReturn {
  const PagesCreateReturn({required this.consoleUrl, required this.contentPublishCommand, required this.projectRef, required this.site, required this.success, required this.url});

  final String consoleUrl;
  final RaviJson contentPublishCommand;
  final String projectRef;
  final Map<String, RaviJson> site;
  final bool success;
  final RaviJson url;

  factory PagesCreateReturn.fromJson(Map<String, Object?> json) {
    return PagesCreateReturn(
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      contentPublishCommand: RaviJson.from(json["contentPublishCommand"]),
      projectRef: raviJsonAsString(json["projectRef"]),
      site: raviJsonAsRaviJsonMap(json["site"]),
      success: raviJsonAsBool(json["success"]),
      url: RaviJson.from(json["url"]),
    );
  }

  static PagesCreateReturn fromJsonValue(Object? json) {
    return PagesCreateReturn.fromJson(raviJsonObject(json, "PagesCreateReturn"));
  }
}

PagesCreateReturn pagesCreateReturnFromJson(Object? json) => PagesCreateReturn.fromJsonValue(json);

class PagesDomainsOptions {
  const PagesDomainsOptions({this.check, this.console, this.execute, this.project});

  final bool? check;
  final String? console;
  final bool? execute;
  final String? project;

  void encodeBody(Map<String, RaviJson> into) {
    if (check != null) {
      into["check"] = RaviJson.from(check);
    }
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
  }
}

class PagesDomainsReturn {
  const PagesDomainsReturn({required this.bindings, required this.consoleUrl, required this.hostnames, required this.projectRef, required this.site, required this.siteRef, required this.success, required this.total});

  final List<Map<String, RaviJson>> bindings;
  final String consoleUrl;
  final List<String> hostnames;
  final String projectRef;
  final Map<String, RaviJson> site;
  final String siteRef;
  final bool success;
  final double total;

  factory PagesDomainsReturn.fromJson(Map<String, Object?> json) {
    return PagesDomainsReturn(
      bindings: raviJsonAsList(json["bindings"], raviJsonAsRaviJsonMap),
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      hostnames: raviJsonAsList(json["hostnames"], raviJsonAsString),
      projectRef: raviJsonAsString(json["projectRef"]),
      site: raviJsonAsRaviJsonMap(json["site"]),
      siteRef: raviJsonAsString(json["siteRef"]),
      success: raviJsonAsBool(json["success"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static PagesDomainsReturn fromJsonValue(Object? json) {
    return PagesDomainsReturn.fromJson(raviJsonObject(json, "PagesDomainsReturn"));
  }
}

PagesDomainsReturn pagesDomainsReturnFromJson(Object? json) => PagesDomainsReturn.fromJsonValue(json);

class PagesListOptions {
  const PagesListOptions({this.console, this.fields, this.limit, this.offset});

  final String? console;
  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class PagesListReturn {
  const PagesListReturn({required this.consoleUrl, required this.items, required this.pagination, required this.projectRef, required this.sites, required this.success, required this.total});

  final String consoleUrl;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final String projectRef;
  final List<Map<String, RaviJson>> sites;
  final bool success;
  final double total;

  factory PagesListReturn.fromJson(Map<String, Object?> json) {
    return PagesListReturn(
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      projectRef: raviJsonAsString(json["projectRef"]),
      sites: raviJsonAsList(json["sites"], raviJsonAsRaviJsonMap),
      success: raviJsonAsBool(json["success"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static PagesListReturn fromJsonValue(Object? json) {
    return PagesListReturn.fromJson(raviJsonObject(json, "PagesListReturn"));
  }
}

PagesListReturn pagesListReturnFromJson(Object? json) => PagesListReturn.fromJsonValue(json);

class PagesPasswordRemoveOptions {
  const PagesPasswordRemoveOptions({this.console, this.execute, this.project, this.route, this.visibility});

  final String? console;
  final bool? execute;
  final String? project;
  final String? route;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (route != null) {
      into["route"] = RaviJson.from(route);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class PagesPasswordRemoveReturn {
  const PagesPasswordRemoveReturn({required this.action, required this.configured, required this.consoleUrl, required this.path, required this.policy, required this.projectRef, required this.release, required this.route, required this.scope, required this.site, required this.siteRef, required this.success, required this.url});

  final String action;
  final bool configured;
  final String consoleUrl;
  final String path;
  final RaviJson policy;
  final String projectRef;
  final Map<String, RaviJson> release;
  final Map<String, RaviJson> route;
  final String scope;
  final Map<String, RaviJson> site;
  final String siteRef;
  final bool success;
  final String url;

  factory PagesPasswordRemoveReturn.fromJson(Map<String, Object?> json) {
    return PagesPasswordRemoveReturn(
      action: raviJsonAsString(json["action"]),
      configured: raviJsonAsBool(json["configured"]),
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      path: raviJsonAsString(json["path"]),
      policy: RaviJson.from(json["policy"]),
      projectRef: raviJsonAsString(json["projectRef"]),
      release: raviJsonAsRaviJsonMap(json["release"]),
      route: raviJsonAsRaviJsonMap(json["route"]),
      scope: raviJsonAsString(json["scope"]),
      site: raviJsonAsRaviJsonMap(json["site"]),
      siteRef: raviJsonAsString(json["siteRef"]),
      success: raviJsonAsBool(json["success"]),
      url: raviJsonAsString(json["url"]),
    );
  }

  static PagesPasswordRemoveReturn fromJsonValue(Object? json) {
    return PagesPasswordRemoveReturn.fromJson(raviJsonObject(json, "PagesPasswordRemoveReturn"));
  }
}

PagesPasswordRemoveReturn pagesPasswordRemoveReturnFromJson(Object? json) => PagesPasswordRemoveReturn.fromJsonValue(json);

class PagesPasswordStatusOptions {
  const PagesPasswordStatusOptions({this.console, this.project, this.route});

  final String? console;
  final String? project;
  final String? route;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (route != null) {
      into["route"] = RaviJson.from(route);
    }
  }
}

class PagesPasswordStatusReturn {
  const PagesPasswordStatusReturn({required this.action, required this.configured, required this.consoleUrl, required this.path, required this.policy, required this.projectRef, required this.release, required this.route, required this.scope, required this.site, required this.siteRef, required this.success, required this.url});

  final String action;
  final bool configured;
  final String consoleUrl;
  final String path;
  final RaviJson policy;
  final String projectRef;
  final Map<String, RaviJson> release;
  final Map<String, RaviJson> route;
  final String scope;
  final Map<String, RaviJson> site;
  final String siteRef;
  final bool success;
  final String url;

  factory PagesPasswordStatusReturn.fromJson(Map<String, Object?> json) {
    return PagesPasswordStatusReturn(
      action: raviJsonAsString(json["action"]),
      configured: raviJsonAsBool(json["configured"]),
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      path: raviJsonAsString(json["path"]),
      policy: RaviJson.from(json["policy"]),
      projectRef: raviJsonAsString(json["projectRef"]),
      release: raviJsonAsRaviJsonMap(json["release"]),
      route: raviJsonAsRaviJsonMap(json["route"]),
      scope: raviJsonAsString(json["scope"]),
      site: raviJsonAsRaviJsonMap(json["site"]),
      siteRef: raviJsonAsString(json["siteRef"]),
      success: raviJsonAsBool(json["success"]),
      url: raviJsonAsString(json["url"]),
    );
  }

  static PagesPasswordStatusReturn fromJsonValue(Object? json) {
    return PagesPasswordStatusReturn.fromJson(raviJsonObject(json, "PagesPasswordStatusReturn"));
  }
}

PagesPasswordStatusReturn pagesPasswordStatusReturnFromJson(Object? json) => PagesPasswordStatusReturn.fromJsonValue(json);

class PagesPublishOptions {
  const PagesPublishOptions({this.artifactSlug, this.artifactVersion, this.assetBase, this.basePath, this.console, this.description, this.entrypoint, this.execute, this.idempotencyKey, this.noActivate, this.project, this.reason, this.replaceRelease, this.route, this.site, this.title, this.uploadSession, this.visibility});

  final String? artifactSlug;
  final String? artifactVersion;
  final String? assetBase;
  final String? basePath;
  final String? console;
  final String? description;
  final String? entrypoint;
  final bool? execute;
  final String? idempotencyKey;
  final bool? noActivate;
  final String? project;
  final String? reason;
  final bool? replaceRelease;
  final String? route;
  final String? site;
  final String? title;
  final String? uploadSession;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (artifactSlug != null) {
      into["artifactSlug"] = RaviJson.from(artifactSlug);
    }
    if (artifactVersion != null) {
      into["artifactVersion"] = RaviJson.from(artifactVersion);
    }
    if (assetBase != null) {
      into["assetBase"] = RaviJson.from(assetBase);
    }
    if (basePath != null) {
      into["basePath"] = RaviJson.from(basePath);
    }
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (entrypoint != null) {
      into["entrypoint"] = RaviJson.from(entrypoint);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (idempotencyKey != null) {
      into["idempotencyKey"] = RaviJson.from(idempotencyKey);
    }
    if (noActivate != null) {
      into["noActivate"] = RaviJson.from(noActivate);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
    if (replaceRelease != null) {
      into["replaceRelease"] = RaviJson.from(replaceRelease);
    }
    if (route != null) {
      into["route"] = RaviJson.from(route);
    }
    if (site != null) {
      into["site"] = RaviJson.from(site);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
    if (uploadSession != null) {
      into["uploadSession"] = RaviJson.from(uploadSession);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class PagesPublishReturn {
  const PagesPublishReturn({required this.artifact, required this.artifactVersion, required this.authenticated, required this.consoleUrl, required this.localSync, required this.publish, required this.release, required this.routes, required this.site, required this.success, required this.upload, required this.uploadSession, required this.url});

  final RaviJson artifact;
  final RaviJson artifactVersion;
  final bool authenticated;
  final String consoleUrl;
  final RaviJson localSync;
  final RaviJson publish;
  final RaviJson release;
  final List<Map<String, RaviJson>> routes;
  final RaviJson site;
  final bool success;
  final RaviJson upload;
  final RaviJson uploadSession;
  final RaviJson url;

  factory PagesPublishReturn.fromJson(Map<String, Object?> json) {
    return PagesPublishReturn(
      artifact: RaviJson.from(json["artifact"]),
      artifactVersion: RaviJson.from(json["artifactVersion"]),
      authenticated: raviJsonAsBool(json["authenticated"]),
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      localSync: RaviJson.from(json["localSync"]),
      publish: RaviJson.from(json["publish"]),
      release: RaviJson.from(json["release"]),
      routes: raviJsonAsList(json["routes"], raviJsonAsRaviJsonMap),
      site: RaviJson.from(json["site"]),
      success: raviJsonAsBool(json["success"]),
      upload: RaviJson.from(json["upload"]),
      uploadSession: RaviJson.from(json["uploadSession"]),
      url: RaviJson.from(json["url"]),
    );
  }

  static PagesPublishReturn fromJsonValue(Object? json) {
    return PagesPublishReturn.fromJson(raviJsonObject(json, "PagesPublishReturn"));
  }
}

PagesPublishReturn pagesPublishReturnFromJson(Object? json) => PagesPublishReturn.fromJsonValue(json);

class PagesPublishedOptions {
  const PagesPublishedOptions({this.console, this.fields, this.limit, this.offset});

  final String? console;
  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class PagesPublishedReturn {
  const PagesPublishedReturn({required this.consoleUrl, required this.items, required this.pages, required this.pagination, required this.projectRef, required this.success, required this.total});

  final String consoleUrl;
  final List<Map<String, RaviJson>> items;
  final List<Map<String, RaviJson>> pages;
  final RaviJson pagination;
  final String projectRef;
  final bool success;
  final double total;

  factory PagesPublishedReturn.fromJson(Map<String, Object?> json) {
    return PagesPublishedReturn(
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pages: raviJsonAsList(json["pages"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      projectRef: raviJsonAsString(json["projectRef"]),
      success: raviJsonAsBool(json["success"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static PagesPublishedReturn fromJsonValue(Object? json) {
    return PagesPublishedReturn.fromJson(raviJsonObject(json, "PagesPublishedReturn"));
  }
}

PagesPublishedReturn pagesPublishedReturnFromJson(Object? json) => PagesPublishedReturn.fromJsonValue(json);

class PagesUpdateOptions {
  const PagesUpdateOptions({this.console, this.execute, this.project, this.visibility});

  final String? console;
  final bool? execute;
  final String? project;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class PagesUpdateReturn {
  const PagesUpdateReturn({required this.consoleUrl, required this.edgeManifestRepair, required this.projectRef, required this.site, required this.siteRef, required this.success, required this.url});

  final String consoleUrl;
  final RaviJson edgeManifestRepair;
  final String projectRef;
  final Map<String, RaviJson> site;
  final String siteRef;
  final bool success;
  final RaviJson url;

  factory PagesUpdateReturn.fromJson(Map<String, Object?> json) {
    return PagesUpdateReturn(
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      edgeManifestRepair: RaviJson.from(json["edgeManifestRepair"]),
      projectRef: raviJsonAsString(json["projectRef"]),
      site: raviJsonAsRaviJsonMap(json["site"]),
      siteRef: raviJsonAsString(json["siteRef"]),
      success: raviJsonAsBool(json["success"]),
      url: RaviJson.from(json["url"]),
    );
  }

  static PagesUpdateReturn fromJsonValue(Object? json) {
    return PagesUpdateReturn.fromJson(raviJsonObject(json, "PagesUpdateReturn"));
  }
}

PagesUpdateReturn pagesUpdateReturnFromJson(Object? json) => PagesUpdateReturn.fromJsonValue(json);

class PagesVisibilityOptions {
  const PagesVisibilityOptions({this.console, this.execute, this.project});

  final String? console;
  final bool? execute;
  final String? project;

  void encodeBody(Map<String, RaviJson> into) {
    if (console != null) {
      into["console"] = RaviJson.from(console);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
  }
}

class PagesVisibilityReturn {
  const PagesVisibilityReturn({required this.consoleUrl, required this.edgeManifestRepair, required this.projectRef, required this.site, required this.siteRef, required this.success, required this.url});

  final String consoleUrl;
  final RaviJson edgeManifestRepair;
  final String projectRef;
  final Map<String, RaviJson> site;
  final String siteRef;
  final bool success;
  final RaviJson url;

  factory PagesVisibilityReturn.fromJson(Map<String, Object?> json) {
    return PagesVisibilityReturn(
      consoleUrl: raviJsonAsString(json["consoleUrl"]),
      edgeManifestRepair: RaviJson.from(json["edgeManifestRepair"]),
      projectRef: raviJsonAsString(json["projectRef"]),
      site: raviJsonAsRaviJsonMap(json["site"]),
      siteRef: raviJsonAsString(json["siteRef"]),
      success: raviJsonAsBool(json["success"]),
      url: RaviJson.from(json["url"]),
    );
  }

  static PagesVisibilityReturn fromJsonValue(Object? json) {
    return PagesVisibilityReturn.fromJson(raviJsonObject(json, "PagesVisibilityReturn"));
  }
}

PagesVisibilityReturn pagesVisibilityReturnFromJson(Object? json) => PagesVisibilityReturn.fromJsonValue(json);

class PermissionsAllowOptions {
  const PermissionsAllowOptions({this.agent, this.apply, this.capabilities, this.description, this.label, this.to});

  final String? agent;
  final bool? apply;
  final String? capabilities;
  final String? description;
  final String? label;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (apply != null) {
      into["apply"] = RaviJson.from(apply);
    }
    if (capabilities != null) {
      into["capabilities"] = RaviJson.from(capabilities);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

class PermissionsAllowReturn {
  const PermissionsAllowReturn({required this.agentCeilings, required this.capabilities, required this.changedCount, this.description, required this.dryRun, required this.label, this.nextCommand, required this.operations, required this.profile, required this.tagSlug, required this.targets});

  final List<String> agentCeilings;
  final List<RaviJson> capabilities;
  final double changedCount;
  final String? description;
  final bool dryRun;
  final String label;
  final String? nextCommand;
  final List<RaviJson> operations;
  final String profile;
  final String tagSlug;
  final List<RaviJson> targets;

  factory PermissionsAllowReturn.fromJson(Map<String, Object?> json) {
    return PermissionsAllowReturn(
      agentCeilings: raviJsonAsList(json["agentCeilings"], raviJsonAsString),
      capabilities: raviJsonAsList(json["capabilities"], RaviJson.from),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      description: json["description"] == null ? null : raviJsonAsString(json["description"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      label: raviJsonAsString(json["label"]),
      nextCommand: json["nextCommand"] == null ? null : raviJsonAsString(json["nextCommand"]),
      operations: raviJsonAsList(json["operations"], RaviJson.from),
      profile: raviJsonAsString(json["profile"]),
      tagSlug: raviJsonAsString(json["tagSlug"]),
      targets: raviJsonAsList(json["targets"], RaviJson.from),
    );
  }

  static PermissionsAllowReturn fromJsonValue(Object? json) {
    return PermissionsAllowReturn.fromJson(raviJsonObject(json, "PermissionsAllowReturn"));
  }
}

PermissionsAllowReturn permissionsAllowReturnFromJson(Object? json) => PermissionsAllowReturn.fromJsonValue(json);

class PermissionsCheckOptions {
  const PermissionsCheckOptions({this.localOperator, this.objectId, this.objectType, this.permission});

  final bool? localOperator;
  final String? objectId;
  final String? objectType;
  final String? permission;

  void encodeBody(Map<String, RaviJson> into) {
    if (localOperator != null) {
      into["localOperator"] = RaviJson.from(localOperator);
    }
    if (objectId != null) {
      into["objectId"] = RaviJson.from(objectId);
    }
    if (objectType != null) {
      into["objectType"] = RaviJson.from(objectType);
    }
    if (permission != null) {
      into["permission"] = RaviJson.from(permission);
    }
  }
}

class PermissionsCheckReturn {
  const PermissionsCheckReturn({required this.allowed, required this.decision, this.guidance});

  final bool allowed;
  final RaviJson decision;
  final RaviJson? guidance;

  factory PermissionsCheckReturn.fromJson(Map<String, Object?> json) {
    return PermissionsCheckReturn(
      allowed: raviJsonAsBool(json["allowed"]),
      decision: RaviJson.from(json["decision"]),
      guidance: json["guidance"] == null ? null : RaviJson.from(json["guidance"]),
    );
  }

  static PermissionsCheckReturn fromJsonValue(Object? json) {
    return PermissionsCheckReturn.fromJson(raviJsonObject(json, "PermissionsCheckReturn"));
  }
}

PermissionsCheckReturn permissionsCheckReturnFromJson(Object? json) => PermissionsCheckReturn.fromJsonValue(json);

class PermissionsMaterializeOptions {
  const PermissionsMaterializeOptions({this.subjectId, this.subjectType});

  final String? subjectId;
  final String? subjectType;

  void encodeBody(Map<String, RaviJson> into) {
    if (subjectId != null) {
      into["subjectId"] = RaviJson.from(subjectId);
    }
    if (subjectType != null) {
      into["subjectType"] = RaviJson.from(subjectType);
    }
  }
}

class PermissionsMaterializeReturn {
  const PermissionsMaterializeReturn({required this.capabilities, required this.guidance, required this.subject});

  final List<RaviJson> capabilities;
  final RaviJson guidance;
  final RaviJson subject;

  factory PermissionsMaterializeReturn.fromJson(Map<String, Object?> json) {
    return PermissionsMaterializeReturn(
      capabilities: raviJsonAsList(json["capabilities"], RaviJson.from),
      guidance: RaviJson.from(json["guidance"]),
      subject: RaviJson.from(json["subject"]),
    );
  }

  static PermissionsMaterializeReturn fromJsonValue(Object? json) {
    return PermissionsMaterializeReturn.fromJson(raviJsonObject(json, "PermissionsMaterializeReturn"));
  }
}

PermissionsMaterializeReturn permissionsMaterializeReturnFromJson(Object? json) => PermissionsMaterializeReturn.fromJsonValue(json);

class PermissionsResolveOptions {
  const PermissionsResolveOptions({this.apply, this.capabilities, this.profile});

  final bool? apply;
  final String? capabilities;
  final String? profile;

  void encodeBody(Map<String, RaviJson> into) {
    if (apply != null) {
      into["apply"] = RaviJson.from(apply);
    }
    if (capabilities != null) {
      into["capabilities"] = RaviJson.from(capabilities);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
  }
}

class PermissionsResolveReturn {
  const PermissionsResolveReturn({required this.agentCeilings, required this.capabilities, required this.changedCount, required this.denial, this.description, required this.dryRun, this.guidance, required this.label, this.nextCommand, required this.operations, required this.profile, required this.tagSlug, required this.targets});

  final List<String> agentCeilings;
  final List<RaviJson> capabilities;
  final double changedCount;
  final RaviJson denial;
  final String? description;
  final bool dryRun;
  final RaviJson? guidance;
  final String label;
  final String? nextCommand;
  final List<RaviJson> operations;
  final String profile;
  final String tagSlug;
  final List<RaviJson> targets;

  factory PermissionsResolveReturn.fromJson(Map<String, Object?> json) {
    return PermissionsResolveReturn(
      agentCeilings: raviJsonAsList(json["agentCeilings"], raviJsonAsString),
      capabilities: raviJsonAsList(json["capabilities"], RaviJson.from),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      denial: RaviJson.from(json["denial"]),
      description: json["description"] == null ? null : raviJsonAsString(json["description"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      guidance: json["guidance"] == null ? null : RaviJson.from(json["guidance"]),
      label: raviJsonAsString(json["label"]),
      nextCommand: json["nextCommand"] == null ? null : raviJsonAsString(json["nextCommand"]),
      operations: raviJsonAsList(json["operations"], RaviJson.from),
      profile: raviJsonAsString(json["profile"]),
      tagSlug: raviJsonAsString(json["tagSlug"]),
      targets: raviJsonAsList(json["targets"], RaviJson.from),
    );
  }

  static PermissionsResolveReturn fromJsonValue(Object? json) {
    return PermissionsResolveReturn.fromJson(raviJsonObject(json, "PermissionsResolveReturn"));
  }
}

PermissionsResolveReturn permissionsResolveReturnFromJson(Object? json) => PermissionsResolveReturn.fromJsonValue(json);

class PermissionsStatusReturn {
  const PermissionsStatusReturn({required this.authorizationProviders, required this.capabilityMaterializers, required this.guidance, required this.mutationCommands, required this.status});

  final List<RaviJson> authorizationProviders;
  final List<RaviJson> capabilityMaterializers;
  final RaviJson guidance;
  final RaviJson mutationCommands;
  final String status;

  factory PermissionsStatusReturn.fromJson(Map<String, Object?> json) {
    return PermissionsStatusReturn(
      authorizationProviders: raviJsonAsList(json["authorizationProviders"], RaviJson.from),
      capabilityMaterializers: raviJsonAsList(json["capabilityMaterializers"], RaviJson.from),
      guidance: RaviJson.from(json["guidance"]),
      mutationCommands: RaviJson.from(json["mutationCommands"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static PermissionsStatusReturn fromJsonValue(Object? json) {
    return PermissionsStatusReturn.fromJson(raviJsonObject(json, "PermissionsStatusReturn"));
  }
}

PermissionsStatusReturn permissionsStatusReturnFromJson(Object? json) => PermissionsStatusReturn.fromJsonValue(json);

class ProjectsCreateOptions {
  const ProjectsCreateOptions({this.hypothesis, this.lastSignalAt, this.nextStep, this.ownerAgent, this.session, this.slug, this.status, this.summary});

  final String? hypothesis;
  final String? lastSignalAt;
  final String? nextStep;
  final String? ownerAgent;
  final String? session;
  final String? slug;
  final String? status;
  final String? summary;

  void encodeBody(Map<String, RaviJson> into) {
    if (hypothesis != null) {
      into["hypothesis"] = RaviJson.from(hypothesis);
    }
    if (lastSignalAt != null) {
      into["lastSignalAt"] = RaviJson.from(lastSignalAt);
    }
    if (nextStep != null) {
      into["nextStep"] = RaviJson.from(nextStep);
    }
    if (ownerAgent != null) {
      into["ownerAgent"] = RaviJson.from(ownerAgent);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (slug != null) {
      into["slug"] = RaviJson.from(slug);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (summary != null) {
      into["summary"] = RaviJson.from(summary);
    }
  }
}

typedef ProjectsCreateReturn = Map<String, RaviJson>;

ProjectsCreateReturn projectsCreateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProjectsFixturesSeedOptions {
  const ProjectsFixturesSeedOptions({this.execute, this.ownerAgent});

  final bool? execute;
  final String? ownerAgent;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (ownerAgent != null) {
      into["ownerAgent"] = RaviJson.from(ownerAgent);
    }
  }
}

class ProjectsFixturesSeedReturn {
  const ProjectsFixturesSeedReturn({required this.fixtures, required this.total});

  final List<Map<String, RaviJson>> fixtures;
  final double total;

  factory ProjectsFixturesSeedReturn.fromJson(Map<String, Object?> json) {
    return ProjectsFixturesSeedReturn(
      fixtures: raviJsonAsList(json["fixtures"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProjectsFixturesSeedReturn fromJsonValue(Object? json) {
    return ProjectsFixturesSeedReturn.fromJson(raviJsonObject(json, "ProjectsFixturesSeedReturn"));
  }
}

ProjectsFixturesSeedReturn projectsFixturesSeedReturnFromJson(Object? json) => ProjectsFixturesSeedReturn.fromJsonValue(json);

class ProjectsInitOptions {
  const ProjectsInitOptions({this.hypothesis, this.lastSignalAt, this.nextStep, this.ownerAgent, this.resource, this.session, this.slug, this.status, this.summary, this.workflowRun, this.workflowTemplate});

  final String? hypothesis;
  final String? lastSignalAt;
  final String? nextStep;
  final String? ownerAgent;
  final List<String>? resource;
  final String? session;
  final String? slug;
  final String? status;
  final String? summary;
  final List<String>? workflowRun;
  final List<String>? workflowTemplate;

  void encodeBody(Map<String, RaviJson> into) {
    if (hypothesis != null) {
      into["hypothesis"] = RaviJson.from(hypothesis);
    }
    if (lastSignalAt != null) {
      into["lastSignalAt"] = RaviJson.from(lastSignalAt);
    }
    if (nextStep != null) {
      into["nextStep"] = RaviJson.from(nextStep);
    }
    if (ownerAgent != null) {
      into["ownerAgent"] = RaviJson.from(ownerAgent);
    }
    if (resource != null) {
      into["resource"] = RaviJson.from(resource);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (slug != null) {
      into["slug"] = RaviJson.from(slug);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (summary != null) {
      into["summary"] = RaviJson.from(summary);
    }
    if (workflowRun != null) {
      into["workflowRun"] = RaviJson.from(workflowRun);
    }
    if (workflowTemplate != null) {
      into["workflowTemplate"] = RaviJson.from(workflowTemplate);
    }
  }
}

class ProjectsInitReturn {
  const ProjectsInitReturn({required this.details, required this.workflows});

  final Map<String, RaviJson> details;
  final List<Map<String, RaviJson>> workflows;

  factory ProjectsInitReturn.fromJson(Map<String, Object?> json) {
    return ProjectsInitReturn(
      details: raviJsonAsRaviJsonMap(json["details"]),
      workflows: raviJsonAsList(json["workflows"], raviJsonAsRaviJsonMap),
    );
  }

  static ProjectsInitReturn fromJsonValue(Object? json) {
    return ProjectsInitReturn.fromJson(raviJsonObject(json, "ProjectsInitReturn"));
  }
}

ProjectsInitReturn projectsInitReturnFromJson(Object? json) => ProjectsInitReturn.fromJsonValue(json);

class ProjectsLinkOptions {
  const ProjectsLinkOptions({this.label, this.meta, this.resourceType, this.role});

  final String? label;
  final String? meta;
  final String? resourceType;
  final String? role;

  void encodeBody(Map<String, RaviJson> into) {
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (meta != null) {
      into["meta"] = RaviJson.from(meta);
    }
    if (resourceType != null) {
      into["resourceType"] = RaviJson.from(resourceType);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
  }
}

typedef ProjectsLinkReturn = Map<String, RaviJson>;

ProjectsLinkReturn projectsLinkReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProjectsListOptions {
  const ProjectsListOptions({this.fields, this.limit, this.offset, this.status, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? status;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class ProjectsListReturn {
  const ProjectsListReturn({required this.filters, required this.items, required this.pagination, required this.projects, required this.total});

  final Map<String, RaviJson> filters;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> projects;
  final double total;

  factory ProjectsListReturn.fromJson(Map<String, Object?> json) {
    return ProjectsListReturn(
      filters: raviJsonAsRaviJsonMap(json["filters"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      projects: raviJsonAsList(json["projects"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProjectsListReturn fromJsonValue(Object? json) {
    return ProjectsListReturn.fromJson(raviJsonObject(json, "ProjectsListReturn"));
  }
}

ProjectsListReturn projectsListReturnFromJson(Object? json) => ProjectsListReturn.fromJsonValue(json);

class ProjectsNextOptions {
  const ProjectsNextOptions({this.fields, this.status, this.tag});

  final String? fields;
  final String? status;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class ProjectsNextReturn {
  const ProjectsNextReturn({required this.filters, required this.projects, required this.total});

  final Map<String, RaviJson> filters;
  final List<Map<String, RaviJson>> projects;
  final double total;

  factory ProjectsNextReturn.fromJson(Map<String, Object?> json) {
    return ProjectsNextReturn(
      filters: raviJsonAsRaviJsonMap(json["filters"]),
      projects: raviJsonAsList(json["projects"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProjectsNextReturn fromJsonValue(Object? json) {
    return ProjectsNextReturn.fromJson(raviJsonObject(json, "ProjectsNextReturn"));
  }
}

ProjectsNextReturn projectsNextReturnFromJson(Object? json) => ProjectsNextReturn.fromJsonValue(json);

class ProjectsResourcesAddOptions {
  const ProjectsResourcesAddOptions({this.label, this.meta, this.role, this.type});

  final String? label;
  final String? meta;
  final String? role;
  final String? type;

  void encodeBody(Map<String, RaviJson> into) {
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (meta != null) {
      into["meta"] = RaviJson.from(meta);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
    if (type != null) {
      into["type"] = RaviJson.from(type);
    }
  }
}

typedef ProjectsResourcesAddReturn = Map<String, RaviJson>;

ProjectsResourcesAddReturn projectsResourcesAddReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProjectsResourcesImportOptions {
  const ProjectsResourcesImportOptions({this.group, this.meta, this.repo, this.role, this.url, this.worktree});

  final List<String>? group;
  final String? meta;
  final List<String>? repo;
  final String? role;
  final List<String>? url;
  final List<String>? worktree;

  void encodeBody(Map<String, RaviJson> into) {
    if (group != null) {
      into["group"] = RaviJson.from(group);
    }
    if (meta != null) {
      into["meta"] = RaviJson.from(meta);
    }
    if (repo != null) {
      into["repo"] = RaviJson.from(repo);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
    if (url != null) {
      into["url"] = RaviJson.from(url);
    }
    if (worktree != null) {
      into["worktree"] = RaviJson.from(worktree);
    }
  }
}

class ProjectsResourcesImportReturn {
  const ProjectsResourcesImportReturn({required this.resources, required this.total});

  final List<Map<String, RaviJson>> resources;
  final double total;

  factory ProjectsResourcesImportReturn.fromJson(Map<String, Object?> json) {
    return ProjectsResourcesImportReturn(
      resources: raviJsonAsList(json["resources"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProjectsResourcesImportReturn fromJsonValue(Object? json) {
    return ProjectsResourcesImportReturn.fromJson(raviJsonObject(json, "ProjectsResourcesImportReturn"));
  }
}

ProjectsResourcesImportReturn projectsResourcesImportReturnFromJson(Object? json) => ProjectsResourcesImportReturn.fromJsonValue(json);

class ProjectsResourcesListOptions {
  const ProjectsResourcesListOptions({this.fields, this.limit, this.offset, this.type});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? type;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (type != null) {
      into["type"] = RaviJson.from(type);
    }
  }
}

class ProjectsResourcesListReturn {
  const ProjectsResourcesListReturn({required this.items, required this.pagination, required this.resources, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> resources;
  final double total;

  factory ProjectsResourcesListReturn.fromJson(Map<String, Object?> json) {
    return ProjectsResourcesListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      resources: raviJsonAsList(json["resources"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProjectsResourcesListReturn fromJsonValue(Object? json) {
    return ProjectsResourcesListReturn.fromJson(raviJsonObject(json, "ProjectsResourcesListReturn"));
  }
}

ProjectsResourcesListReturn projectsResourcesListReturnFromJson(Object? json) => ProjectsResourcesListReturn.fromJsonValue(json);

typedef ProjectsResourcesShowReturn = Map<String, RaviJson>;

ProjectsResourcesShowReturn projectsResourcesShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ProjectsShowReturn = Map<String, RaviJson>;

ProjectsShowReturn projectsShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef ProjectsStatusReturn = Map<String, RaviJson>;

ProjectsStatusReturn projectsStatusReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProjectsTasksAttachOptions {
  const ProjectsTasksAttachOptions({this.agent, this.dispatch, this.session, this.workflow});

  final String? agent;
  final bool? dispatch;
  final String? session;
  final String? workflow;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (dispatch != null) {
      into["dispatch"] = RaviJson.from(dispatch);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (workflow != null) {
      into["workflow"] = RaviJson.from(workflow);
    }
  }
}

class ProjectsTasksAttachReturn {
  const ProjectsTasksAttachReturn({required this.defaults, required this.details, required this.workflow});

  final Map<String, RaviJson> defaults;
  final Map<String, RaviJson> details;
  final Map<String, RaviJson> workflow;

  factory ProjectsTasksAttachReturn.fromJson(Map<String, Object?> json) {
    return ProjectsTasksAttachReturn(
      defaults: raviJsonAsRaviJsonMap(json["defaults"]),
      details: raviJsonAsRaviJsonMap(json["details"]),
      workflow: raviJsonAsRaviJsonMap(json["workflow"]),
    );
  }

  static ProjectsTasksAttachReturn fromJsonValue(Object? json) {
    return ProjectsTasksAttachReturn.fromJson(raviJsonObject(json, "ProjectsTasksAttachReturn"));
  }
}

ProjectsTasksAttachReturn projectsTasksAttachReturnFromJson(Object? json) => ProjectsTasksAttachReturn.fromJsonValue(json);

class ProjectsTasksCreateOptions {
  const ProjectsTasksCreateOptions({this.agent, this.dispatch, this.instructions, this.priority, this.profile, this.session, this.workflow});

  final String? agent;
  final bool? dispatch;
  final String? instructions;
  final String? priority;
  final String? profile;
  final String? session;
  final String? workflow;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (dispatch != null) {
      into["dispatch"] = RaviJson.from(dispatch);
    }
    if (instructions != null) {
      into["instructions"] = RaviJson.from(instructions);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (workflow != null) {
      into["workflow"] = RaviJson.from(workflow);
    }
  }
}

class ProjectsTasksCreateReturn {
  const ProjectsTasksCreateReturn({required this.defaults, required this.details, required this.workflow});

  final Map<String, RaviJson> defaults;
  final Map<String, RaviJson> details;
  final Map<String, RaviJson> workflow;

  factory ProjectsTasksCreateReturn.fromJson(Map<String, Object?> json) {
    return ProjectsTasksCreateReturn(
      defaults: raviJsonAsRaviJsonMap(json["defaults"]),
      details: raviJsonAsRaviJsonMap(json["details"]),
      workflow: raviJsonAsRaviJsonMap(json["workflow"]),
    );
  }

  static ProjectsTasksCreateReturn fromJsonValue(Object? json) {
    return ProjectsTasksCreateReturn.fromJson(raviJsonObject(json, "ProjectsTasksCreateReturn"));
  }
}

ProjectsTasksCreateReturn projectsTasksCreateReturnFromJson(Object? json) => ProjectsTasksCreateReturn.fromJsonValue(json);

class ProjectsTasksDispatchOptions {
  const ProjectsTasksDispatchOptions({this.agent, this.execute, this.session});

  final String? agent;
  final bool? execute;
  final String? session;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
  }
}

class ProjectsTasksDispatchReturn {
  const ProjectsTasksDispatchReturn({required this.defaults, required this.details, required this.workflow});

  final Map<String, RaviJson> defaults;
  final Map<String, RaviJson> details;
  final Map<String, RaviJson> workflow;

  factory ProjectsTasksDispatchReturn.fromJson(Map<String, Object?> json) {
    return ProjectsTasksDispatchReturn(
      defaults: raviJsonAsRaviJsonMap(json["defaults"]),
      details: raviJsonAsRaviJsonMap(json["details"]),
      workflow: raviJsonAsRaviJsonMap(json["workflow"]),
    );
  }

  static ProjectsTasksDispatchReturn fromJsonValue(Object? json) {
    return ProjectsTasksDispatchReturn.fromJson(raviJsonObject(json, "ProjectsTasksDispatchReturn"));
  }
}

ProjectsTasksDispatchReturn projectsTasksDispatchReturnFromJson(Object? json) => ProjectsTasksDispatchReturn.fromJsonValue(json);

class ProjectsUpdateOptions {
  const ProjectsUpdateOptions({this.hypothesis, this.lastSignalAt, this.nextStep, this.ownerAgent, this.session, this.status, this.summary, this.title, this.touchSignal});

  final String? hypothesis;
  final String? lastSignalAt;
  final String? nextStep;
  final String? ownerAgent;
  final String? session;
  final String? status;
  final String? summary;
  final String? title;
  final bool? touchSignal;

  void encodeBody(Map<String, RaviJson> into) {
    if (hypothesis != null) {
      into["hypothesis"] = RaviJson.from(hypothesis);
    }
    if (lastSignalAt != null) {
      into["lastSignalAt"] = RaviJson.from(lastSignalAt);
    }
    if (nextStep != null) {
      into["nextStep"] = RaviJson.from(nextStep);
    }
    if (ownerAgent != null) {
      into["ownerAgent"] = RaviJson.from(ownerAgent);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (summary != null) {
      into["summary"] = RaviJson.from(summary);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
    if (touchSignal != null) {
      into["touchSignal"] = RaviJson.from(touchSignal);
    }
  }
}

typedef ProjectsUpdateReturn = Map<String, RaviJson>;

ProjectsUpdateReturn projectsUpdateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProjectsWorkflowsAttachOptions {
  const ProjectsWorkflowsAttachOptions({this.role});

  final String? role;

  void encodeBody(Map<String, RaviJson> into) {
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
  }
}

class ProjectsWorkflowsAttachReturn {
  const ProjectsWorkflowsAttachReturn({required this.details, required this.workflow});

  final Map<String, RaviJson> details;
  final Map<String, RaviJson> workflow;

  factory ProjectsWorkflowsAttachReturn.fromJson(Map<String, Object?> json) {
    return ProjectsWorkflowsAttachReturn(
      details: raviJsonAsRaviJsonMap(json["details"]),
      workflow: raviJsonAsRaviJsonMap(json["workflow"]),
    );
  }

  static ProjectsWorkflowsAttachReturn fromJsonValue(Object? json) {
    return ProjectsWorkflowsAttachReturn.fromJson(raviJsonObject(json, "ProjectsWorkflowsAttachReturn"));
  }
}

ProjectsWorkflowsAttachReturn projectsWorkflowsAttachReturnFromJson(Object? json) => ProjectsWorkflowsAttachReturn.fromJsonValue(json);

class ProjectsWorkflowsStartOptions {
  const ProjectsWorkflowsStartOptions({this.execute, this.role, this.runId});

  final bool? execute;
  final String? role;
  final String? runId;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
    if (runId != null) {
      into["runId"] = RaviJson.from(runId);
    }
  }
}

class ProjectsWorkflowsStartReturn {
  const ProjectsWorkflowsStartReturn({required this.details, required this.workflow});

  final Map<String, RaviJson> details;
  final Map<String, RaviJson> workflow;

  factory ProjectsWorkflowsStartReturn.fromJson(Map<String, Object?> json) {
    return ProjectsWorkflowsStartReturn(
      details: raviJsonAsRaviJsonMap(json["details"]),
      workflow: raviJsonAsRaviJsonMap(json["workflow"]),
    );
  }

  static ProjectsWorkflowsStartReturn fromJsonValue(Object? json) {
    return ProjectsWorkflowsStartReturn.fromJson(raviJsonObject(json, "ProjectsWorkflowsStartReturn"));
  }
}

ProjectsWorkflowsStartReturn projectsWorkflowsStartReturnFromJson(Object? json) => ProjectsWorkflowsStartReturn.fromJsonValue(json);

class ProxCallsCancelOptions {
  const ProxCallsCancelOptions({this.reason});

  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

class ProxCallsCancelReturn {
  const ProxCallsCancelReturn({required this.message, required this.requestId, required this.success});

  final String message;
  final String requestId;
  final bool success;

  factory ProxCallsCancelReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsCancelReturn(
      message: raviJsonAsString(json["message"]),
      requestId: raviJsonAsString(json["request_id"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static ProxCallsCancelReturn fromJsonValue(Object? json) {
    return ProxCallsCancelReturn.fromJson(raviJsonObject(json, "ProxCallsCancelReturn"));
  }
}

ProxCallsCancelReturn proxCallsCancelReturnFromJson(Object? json) => ProxCallsCancelReturn.fromJsonValue(json);

class ProxCallsEventsReturn {
  const ProxCallsEventsReturn({required this.events, required this.requestId, required this.total});

  final List<Map<String, RaviJson>> events;
  final String requestId;
  final double total;

  factory ProxCallsEventsReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsEventsReturn(
      events: raviJsonAsList(json["events"], raviJsonAsRaviJsonMap),
      requestId: raviJsonAsString(json["request_id"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProxCallsEventsReturn fromJsonValue(Object? json) {
    return ProxCallsEventsReturn.fromJson(raviJsonObject(json, "ProxCallsEventsReturn"));
  }
}

ProxCallsEventsReturn proxCallsEventsReturnFromJson(Object? json) => ProxCallsEventsReturn.fromJsonValue(json);

class ProxCallsProfilesConfigureOptions {
  const ProxCallsProfilesConfigureOptions({this.agentId, this.dynamicPlaceholder, this.execute, this.firstMessage, this.language, this.prompt, this.provider, this.skipProviderSync, this.systemPromptPath, this.twilioNumberId, this.voicemailPolicy});

  final String? agentId;
  final List<String>? dynamicPlaceholder;
  final bool? execute;
  final String? firstMessage;
  final String? language;
  final String? prompt;
  final String? provider;
  final bool? skipProviderSync;
  final String? systemPromptPath;
  final String? twilioNumberId;
  final String? voicemailPolicy;

  void encodeBody(Map<String, RaviJson> into) {
    if (agentId != null) {
      into["agentId"] = RaviJson.from(agentId);
    }
    if (dynamicPlaceholder != null) {
      into["dynamicPlaceholder"] = RaviJson.from(dynamicPlaceholder);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (firstMessage != null) {
      into["firstMessage"] = RaviJson.from(firstMessage);
    }
    if (language != null) {
      into["language"] = RaviJson.from(language);
    }
    if (prompt != null) {
      into["prompt"] = RaviJson.from(prompt);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (skipProviderSync != null) {
      into["skipProviderSync"] = RaviJson.from(skipProviderSync);
    }
    if (systemPromptPath != null) {
      into["systemPromptPath"] = RaviJson.from(systemPromptPath);
    }
    if (twilioNumberId != null) {
      into["twilioNumberId"] = RaviJson.from(twilioNumberId);
    }
    if (voicemailPolicy != null) {
      into["voicemailPolicy"] = RaviJson.from(voicemailPolicy);
    }
  }
}

class ProxCallsProfilesConfigureReturn {
  const ProxCallsProfilesConfigureReturn({required this.profile, required this.providerSync});

  final Map<String, RaviJson> profile;
  final RaviJson providerSync;

  factory ProxCallsProfilesConfigureReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsProfilesConfigureReturn(
      profile: raviJsonAsRaviJsonMap(json["profile"]),
      providerSync: RaviJson.from(json["provider_sync"]),
    );
  }

  static ProxCallsProfilesConfigureReturn fromJsonValue(Object? json) {
    return ProxCallsProfilesConfigureReturn.fromJson(raviJsonObject(json, "ProxCallsProfilesConfigureReturn"));
  }
}

ProxCallsProfilesConfigureReturn proxCallsProfilesConfigureReturnFromJson(Object? json) => ProxCallsProfilesConfigureReturn.fromJsonValue(json);

class ProxCallsProfilesListOptions {
  const ProxCallsProfilesListOptions({this.fields, this.limit, this.offset, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class ProxCallsProfilesListReturn {
  const ProxCallsProfilesListReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory ProxCallsProfilesListReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsProfilesListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProxCallsProfilesListReturn fromJsonValue(Object? json) {
    return ProxCallsProfilesListReturn.fromJson(raviJsonObject(json, "ProxCallsProfilesListReturn"));
  }
}

ProxCallsProfilesListReturn proxCallsProfilesListReturnFromJson(Object? json) => ProxCallsProfilesListReturn.fromJsonValue(json);

typedef ProxCallsProfilesShowReturn = Map<String, RaviJson>;

ProxCallsProfilesShowReturn proxCallsProfilesShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProxCallsRequestOptions {
  const ProxCallsRequestOptions({this.execute, this.force, this.person, this.phone, this.priority, this.profile, this.reason, this.skipOriginNotify, this.var_});

  final bool? execute;
  final bool? force;
  final String? person;
  final String? phone;
  final String? priority;
  final String? profile;
  final String? reason;
  final bool? skipOriginNotify;
  final List<String>? var_;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (force != null) {
      into["force"] = RaviJson.from(force);
    }
    if (person != null) {
      into["person"] = RaviJson.from(person);
    }
    if (phone != null) {
      into["phone"] = RaviJson.from(phone);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
    if (skipOriginNotify != null) {
      into["skipOriginNotify"] = RaviJson.from(skipOriginNotify);
    }
    if (var_ != null) {
      into["var"] = RaviJson.from(var_);
    }
  }
}

class ProxCallsRequestReturn {
  const ProxCallsRequestReturn({this.blockReason, required this.blocked, required this.hint, required this.providerMode, required this.request});

  final RaviJson? blockReason;
  final bool blocked;
  final String hint;
  final String providerMode;
  final Map<String, RaviJson> request;

  factory ProxCallsRequestReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsRequestReturn(
      blockReason: json["block_reason"] == null ? null : RaviJson.from(json["block_reason"]),
      blocked: raviJsonAsBool(json["blocked"]),
      hint: raviJsonAsString(json["hint"]),
      providerMode: raviJsonAsString(json["provider_mode"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
    );
  }

  static ProxCallsRequestReturn fromJsonValue(Object? json) {
    return ProxCallsRequestReturn.fromJson(raviJsonObject(json, "ProxCallsRequestReturn"));
  }
}

ProxCallsRequestReturn proxCallsRequestReturnFromJson(Object? json) => ProxCallsRequestReturn.fromJsonValue(json);

class ProxCallsRulesOptions {
  const ProxCallsRulesOptions({this.scope});

  final String? scope;

  void encodeBody(Map<String, RaviJson> into) {
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
  }
}

typedef ProxCallsRulesReturn = RaviJson;

ProxCallsRulesReturn proxCallsRulesReturnFromJson(Object? json) => RaviJson.from(json);

class ProxCallsShowReturn {
  const ProxCallsShowReturn({required this.request, required this.result, required this.runs});

  final Map<String, RaviJson> request;
  final RaviJson result;
  final List<Map<String, RaviJson>> runs;

  factory ProxCallsShowReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsShowReturn(
      request: raviJsonAsRaviJsonMap(json["request"]),
      result: RaviJson.from(json["result"]),
      runs: raviJsonAsList(json["runs"], raviJsonAsRaviJsonMap),
    );
  }

  static ProxCallsShowReturn fromJsonValue(Object? json) {
    return ProxCallsShowReturn.fromJson(raviJsonObject(json, "ProxCallsShowReturn"));
  }
}

ProxCallsShowReturn proxCallsShowReturnFromJson(Object? json) => ProxCallsShowReturn.fromJsonValue(json);

class ProxCallsToolsBindOptions {
  const ProxCallsToolsBindOptions({this.providerToolName, this.required_, this.toolPrompt});

  final String? providerToolName;
  final bool? required_;
  final String? toolPrompt;

  void encodeBody(Map<String, RaviJson> into) {
    if (providerToolName != null) {
      into["providerToolName"] = RaviJson.from(providerToolName);
    }
    if (required_ != null) {
      into["required"] = RaviJson.from(required_);
    }
    if (toolPrompt != null) {
      into["toolPrompt"] = RaviJson.from(toolPrompt);
    }
  }
}

typedef ProxCallsToolsBindReturn = Map<String, RaviJson>;

ProxCallsToolsBindReturn proxCallsToolsBindReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProxCallsToolsConfigureOptions {
  const ProxCallsToolsConfigureOptions({this.enabled, this.timeoutMs});

  final String? enabled;
  final String? timeoutMs;

  void encodeBody(Map<String, RaviJson> into) {
    if (enabled != null) {
      into["enabled"] = RaviJson.from(enabled);
    }
    if (timeoutMs != null) {
      into["timeoutMs"] = RaviJson.from(timeoutMs);
    }
  }
}

typedef ProxCallsToolsConfigureReturn = Map<String, RaviJson>;

ProxCallsToolsConfigureReturn proxCallsToolsConfigureReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProxCallsToolsCreateOptions {
  const ProxCallsToolsCreateOptions({this.description, this.executor, this.inputSchema, this.name, this.outputSchema, this.sideEffect});

  final String? description;
  final String? executor;
  final String? inputSchema;
  final String? name;
  final String? outputSchema;
  final String? sideEffect;

  void encodeBody(Map<String, RaviJson> into) {
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (executor != null) {
      into["executor"] = RaviJson.from(executor);
    }
    if (inputSchema != null) {
      into["inputSchema"] = RaviJson.from(inputSchema);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (outputSchema != null) {
      into["outputSchema"] = RaviJson.from(outputSchema);
    }
    if (sideEffect != null) {
      into["sideEffect"] = RaviJson.from(sideEffect);
    }
  }
}

typedef ProxCallsToolsCreateReturn = Map<String, RaviJson>;

ProxCallsToolsCreateReturn proxCallsToolsCreateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProxCallsToolsListOptions {
  const ProxCallsToolsListOptions({this.fields, this.limit, this.offset, this.profile, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? profile;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class ProxCallsToolsListReturn {
  const ProxCallsToolsListReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory ProxCallsToolsListReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsToolsListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProxCallsToolsListReturn fromJsonValue(Object? json) {
    return ProxCallsToolsListReturn.fromJson(raviJsonObject(json, "ProxCallsToolsListReturn"));
  }
}

ProxCallsToolsListReturn proxCallsToolsListReturnFromJson(Object? json) => ProxCallsToolsListReturn.fromJsonValue(json);

class ProxCallsToolsRunOptions {
  const ProxCallsToolsRunOptions({this.dryRun, this.input, this.profile});

  final bool? dryRun;
  final String? input;
  final String? profile;

  void encodeBody(Map<String, RaviJson> into) {
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
    if (input != null) {
      into["input"] = RaviJson.from(input);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
  }
}

class ProxCallsToolsRunReturn {
  const ProxCallsToolsRunReturn({required this.ok});

  final bool ok;

  factory ProxCallsToolsRunReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsToolsRunReturn(
      ok: raviJsonAsBool(json["ok"]),
    );
  }

  static ProxCallsToolsRunReturn fromJsonValue(Object? json) {
    return ProxCallsToolsRunReturn.fromJson(raviJsonObject(json, "ProxCallsToolsRunReturn"));
  }
}

ProxCallsToolsRunReturn proxCallsToolsRunReturnFromJson(Object? json) => ProxCallsToolsRunReturn.fromJsonValue(json);

class ProxCallsToolsRunsReturn {
  const ProxCallsToolsRunsReturn({required this.requestId, required this.toolRuns, required this.total});

  final String requestId;
  final List<Map<String, RaviJson>> toolRuns;
  final double total;

  factory ProxCallsToolsRunsReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsToolsRunsReturn(
      requestId: raviJsonAsString(json["request_id"]),
      toolRuns: raviJsonAsList(json["tool_runs"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProxCallsToolsRunsReturn fromJsonValue(Object? json) {
    return ProxCallsToolsRunsReturn.fromJson(raviJsonObject(json, "ProxCallsToolsRunsReturn"));
  }
}

ProxCallsToolsRunsReturn proxCallsToolsRunsReturnFromJson(Object? json) => ProxCallsToolsRunsReturn.fromJsonValue(json);

typedef ProxCallsToolsShowReturn = Map<String, RaviJson>;

ProxCallsToolsShowReturn proxCallsToolsShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProxCallsToolsUnbindReturn {
  const ProxCallsToolsUnbindReturn({required this.success, required this.toolId});

  final bool success;
  final String toolId;

  factory ProxCallsToolsUnbindReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsToolsUnbindReturn(
      success: raviJsonAsBool(json["success"]),
      toolId: raviJsonAsString(json["tool_id"]),
    );
  }

  static ProxCallsToolsUnbindReturn fromJsonValue(Object? json) {
    return ProxCallsToolsUnbindReturn.fromJson(raviJsonObject(json, "ProxCallsToolsUnbindReturn"));
  }
}

ProxCallsToolsUnbindReturn proxCallsToolsUnbindReturnFromJson(Object? json) => ProxCallsToolsUnbindReturn.fromJsonValue(json);

class ProxCallsTranscriptOptions {
  const ProxCallsTranscriptOptions({this.sync});

  final bool? sync;

  void encodeBody(Map<String, RaviJson> into) {
    if (sync != null) {
      into["sync"] = RaviJson.from(sync);
    }
  }
}

class ProxCallsTranscriptReturn {
  const ProxCallsTranscriptReturn({required this.outcome, required this.requestId, this.summary, required this.transcript});

  final String outcome;
  final String requestId;
  final RaviJson? summary;
  final String transcript;

  factory ProxCallsTranscriptReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsTranscriptReturn(
      outcome: raviJsonAsString(json["outcome"]),
      requestId: raviJsonAsString(json["request_id"]),
      summary: json["summary"] == null ? null : RaviJson.from(json["summary"]),
      transcript: raviJsonAsString(json["transcript"]),
    );
  }

  static ProxCallsTranscriptReturn fromJsonValue(Object? json) {
    return ProxCallsTranscriptReturn.fromJson(raviJsonObject(json, "ProxCallsTranscriptReturn"));
  }
}

ProxCallsTranscriptReturn proxCallsTranscriptReturnFromJson(Object? json) => ProxCallsTranscriptReturn.fromJsonValue(json);

class ProxCallsVoiceAgentsBindToolOptions {
  const ProxCallsVoiceAgentsBindToolOptions({this.providerToolName});

  final String? providerToolName;

  void encodeBody(Map<String, RaviJson> into) {
    if (providerToolName != null) {
      into["providerToolName"] = RaviJson.from(providerToolName);
    }
  }
}

typedef ProxCallsVoiceAgentsBindToolReturn = Map<String, RaviJson>;

ProxCallsVoiceAgentsBindToolReturn proxCallsVoiceAgentsBindToolReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProxCallsVoiceAgentsConfigureOptions {
  const ProxCallsVoiceAgentsConfigureOptions({this.firstMessage, this.providerAgentId, this.systemPromptPath, this.voiceId});

  final String? firstMessage;
  final String? providerAgentId;
  final String? systemPromptPath;
  final String? voiceId;

  void encodeBody(Map<String, RaviJson> into) {
    if (firstMessage != null) {
      into["firstMessage"] = RaviJson.from(firstMessage);
    }
    if (providerAgentId != null) {
      into["providerAgentId"] = RaviJson.from(providerAgentId);
    }
    if (systemPromptPath != null) {
      into["systemPromptPath"] = RaviJson.from(systemPromptPath);
    }
    if (voiceId != null) {
      into["voiceId"] = RaviJson.from(voiceId);
    }
  }
}

typedef ProxCallsVoiceAgentsConfigureReturn = Map<String, RaviJson>;

ProxCallsVoiceAgentsConfigureReturn proxCallsVoiceAgentsConfigureReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProxCallsVoiceAgentsCreateOptions {
  const ProxCallsVoiceAgentsCreateOptions({this.name, this.provider, this.systemPromptPath, this.voiceId});

  final String? name;
  final String? provider;
  final String? systemPromptPath;
  final String? voiceId;

  void encodeBody(Map<String, RaviJson> into) {
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (systemPromptPath != null) {
      into["systemPromptPath"] = RaviJson.from(systemPromptPath);
    }
    if (voiceId != null) {
      into["voiceId"] = RaviJson.from(voiceId);
    }
  }
}

typedef ProxCallsVoiceAgentsCreateReturn = Map<String, RaviJson>;

ProxCallsVoiceAgentsCreateReturn proxCallsVoiceAgentsCreateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProxCallsVoiceAgentsListOptions {
  const ProxCallsVoiceAgentsListOptions({this.fields, this.limit, this.offset, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class ProxCallsVoiceAgentsListReturn {
  const ProxCallsVoiceAgentsListReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory ProxCallsVoiceAgentsListReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsVoiceAgentsListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ProxCallsVoiceAgentsListReturn fromJsonValue(Object? json) {
    return ProxCallsVoiceAgentsListReturn.fromJson(raviJsonObject(json, "ProxCallsVoiceAgentsListReturn"));
  }
}

ProxCallsVoiceAgentsListReturn proxCallsVoiceAgentsListReturnFromJson(Object? json) => ProxCallsVoiceAgentsListReturn.fromJsonValue(json);

typedef ProxCallsVoiceAgentsShowReturn = Map<String, RaviJson>;

ProxCallsVoiceAgentsShowReturn proxCallsVoiceAgentsShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class ProxCallsVoiceAgentsSyncOptions {
  const ProxCallsVoiceAgentsSyncOptions({this.dryRun, this.provider});

  final bool? dryRun;
  final bool? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class ProxCallsVoiceAgentsSyncReturn {
  const ProxCallsVoiceAgentsSyncReturn({required this.dryRun, required this.intendedChanges, required this.provider, this.providerAgentId, required this.providerSync, required this.voiceAgentId});

  final bool dryRun;
  final Map<String, RaviJson> intendedChanges;
  final String provider;
  final RaviJson? providerAgentId;
  final String providerSync;
  final String voiceAgentId;

  factory ProxCallsVoiceAgentsSyncReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsVoiceAgentsSyncReturn(
      dryRun: raviJsonAsBool(json["dry_run"]),
      intendedChanges: raviJsonAsRaviJsonMap(json["intended_changes"]),
      provider: raviJsonAsString(json["provider"]),
      providerAgentId: json["provider_agent_id"] == null ? null : RaviJson.from(json["provider_agent_id"]),
      providerSync: raviJsonAsString(json["provider_sync"]),
      voiceAgentId: raviJsonAsString(json["voice_agent_id"]),
    );
  }

  static ProxCallsVoiceAgentsSyncReturn fromJsonValue(Object? json) {
    return ProxCallsVoiceAgentsSyncReturn.fromJson(raviJsonObject(json, "ProxCallsVoiceAgentsSyncReturn"));
  }
}

ProxCallsVoiceAgentsSyncReturn proxCallsVoiceAgentsSyncReturnFromJson(Object? json) => ProxCallsVoiceAgentsSyncReturn.fromJsonValue(json);

class ProxCallsVoiceAgentsUnbindToolReturn {
  const ProxCallsVoiceAgentsUnbindToolReturn({required this.success, required this.toolId});

  final bool success;
  final String toolId;

  factory ProxCallsVoiceAgentsUnbindToolReturn.fromJson(Map<String, Object?> json) {
    return ProxCallsVoiceAgentsUnbindToolReturn(
      success: raviJsonAsBool(json["success"]),
      toolId: raviJsonAsString(json["tool_id"]),
    );
  }

  static ProxCallsVoiceAgentsUnbindToolReturn fromJsonValue(Object? json) {
    return ProxCallsVoiceAgentsUnbindToolReturn.fromJson(raviJsonObject(json, "ProxCallsVoiceAgentsUnbindToolReturn"));
  }
}

ProxCallsVoiceAgentsUnbindToolReturn proxCallsVoiceAgentsUnbindToolReturnFromJson(Object? json) => ProxCallsVoiceAgentsUnbindToolReturn.fromJsonValue(json);

class ReactSendReturn {
  const ReactSendReturn({required this.event, required this.executionMode, this.idempotencyKey, this.nextAttemptAt, this.publishPending, this.publishedNow, required this.queued, required this.reaction, this.requestId, required this.status, required this.target, required this.topic});

  final RaviJson event;
  final String executionMode;
  final String? idempotencyKey;
  final double? nextAttemptAt;
  final bool? publishPending;
  final bool? publishedNow;
  final bool queued;
  final RaviJson reaction;
  final String? requestId;
  final String status;
  final RaviJson target;
  final String topic;

  factory ReactSendReturn.fromJson(Map<String, Object?> json) {
    return ReactSendReturn(
      event: RaviJson.from(json["event"]),
      executionMode: raviJsonAsString(json["executionMode"]),
      idempotencyKey: json["idempotencyKey"] == null ? null : raviJsonAsString(json["idempotencyKey"]),
      nextAttemptAt: json["nextAttemptAt"] == null ? null : raviJsonAsDouble(json["nextAttemptAt"]),
      publishPending: json["publishPending"] == null ? null : raviJsonAsBool(json["publishPending"]),
      publishedNow: json["publishedNow"] == null ? null : raviJsonAsBool(json["publishedNow"]),
      queued: raviJsonAsBool(json["queued"]),
      reaction: RaviJson.from(json["reaction"]),
      requestId: json["requestId"] == null ? null : raviJsonAsString(json["requestId"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      topic: raviJsonAsString(json["topic"]),
    );
  }

  static ReactSendReturn fromJsonValue(Object? json) {
    return ReactSendReturn.fromJson(raviJsonObject(json, "ReactSendReturn"));
  }
}

ReactSendReturn reactSendReturnFromJson(Object? json) => ReactSendReturn.fromJsonValue(json);

class RoutesExplainOptions {
  const RoutesExplainOptions({this.channel});

  final String? channel;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
  }
}

class RoutesExplainReturn {
  const RoutesExplainReturn({required this.channel, required this.configuredRoute, required this.instance, required this.liveEffect, required this.pattern, required this.target});

  final RaviJson channel;
  final RaviJson configuredRoute;
  final String instance;
  final RaviJson liveEffect;
  final RaviJson pattern;
  final Map<String, RaviJson> target;

  factory RoutesExplainReturn.fromJson(Map<String, Object?> json) {
    return RoutesExplainReturn(
      channel: RaviJson.from(json["channel"]),
      configuredRoute: RaviJson.from(json["configuredRoute"]),
      instance: raviJsonAsString(json["instance"]),
      liveEffect: RaviJson.from(json["liveEffect"]),
      pattern: RaviJson.from(json["pattern"]),
      target: raviJsonAsRaviJsonMap(json["target"]),
    );
  }

  static RoutesExplainReturn fromJsonValue(Object? json) {
    return RoutesExplainReturn.fromJson(raviJsonObject(json, "RoutesExplainReturn"));
  }
}

RoutesExplainReturn routesExplainReturnFromJson(Object? json) => RoutesExplainReturn.fromJsonValue(json);

class RoutesListOptions {
  const RoutesListOptions({this.fields, this.limit, this.offset, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class RoutesListReturn {
  const RoutesListReturn({required this.filter, required this.instance, required this.items, required this.pagination, required this.routes, required this.total});

  final Map<String, RaviJson> filter;
  final RaviJson instance;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> routes;
  final double total;

  factory RoutesListReturn.fromJson(Map<String, Object?> json) {
    return RoutesListReturn(
      filter: raviJsonAsRaviJsonMap(json["filter"]),
      instance: RaviJson.from(json["instance"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      routes: raviJsonAsList(json["routes"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static RoutesListReturn fromJsonValue(Object? json) {
    return RoutesListReturn.fromJson(raviJsonObject(json, "RoutesListReturn"));
  }
}

RoutesListReturn routesListReturnFromJson(Object? json) => RoutesListReturn.fromJsonValue(json);

class RoutesShowReturn {
  const RoutesShowReturn({required this.instance, required this.pattern, required this.route});

  final String instance;
  final String pattern;
  final Map<String, RaviJson> route;

  factory RoutesShowReturn.fromJson(Map<String, Object?> json) {
    return RoutesShowReturn(
      instance: raviJsonAsString(json["instance"]),
      pattern: raviJsonAsString(json["pattern"]),
      route: raviJsonAsRaviJsonMap(json["route"]),
    );
  }

  static RoutesShowReturn fromJsonValue(Object? json) {
    return RoutesShowReturn.fromJson(raviJsonObject(json, "RoutesShowReturn"));
  }
}

RoutesShowReturn routesShowReturnFromJson(Object? json) => RoutesShowReturn.fromJsonValue(json);

class RulesImportOptions {
  const RulesImportOptions({this.cwd, this.force, this.includeUser, this.write});

  final String? cwd;
  final bool? force;
  final bool? includeUser;
  final bool? write;

  void encodeBody(Map<String, RaviJson> into) {
    if (cwd != null) {
      into["cwd"] = RaviJson.from(cwd);
    }
    if (force != null) {
      into["force"] = RaviJson.from(force);
    }
    if (includeUser != null) {
      into["includeUser"] = RaviJson.from(includeUser);
    }
    if (write != null) {
      into["write"] = RaviJson.from(write);
    }
  }
}

class RulesImportReturn {
  const RulesImportReturn({required this.candidates, required this.counts, required this.cwd, required this.force, required this.includeUser, required this.rulesDir, required this.sources, required this.write});

  final List<Map<String, RaviJson>> candidates;
  final Map<String, RaviJson> counts;
  final String cwd;
  final bool force;
  final bool includeUser;
  final String rulesDir;
  final List<Map<String, RaviJson>> sources;
  final bool write;

  factory RulesImportReturn.fromJson(Map<String, Object?> json) {
    return RulesImportReturn(
      candidates: raviJsonAsList(json["candidates"], raviJsonAsRaviJsonMap),
      counts: raviJsonAsRaviJsonMap(json["counts"]),
      cwd: raviJsonAsString(json["cwd"]),
      force: raviJsonAsBool(json["force"]),
      includeUser: raviJsonAsBool(json["includeUser"]),
      rulesDir: raviJsonAsString(json["rulesDir"]),
      sources: raviJsonAsList(json["sources"], raviJsonAsRaviJsonMap),
      write: raviJsonAsBool(json["write"]),
    );
  }

  static RulesImportReturn fromJsonValue(Object? json) {
    return RulesImportReturn.fromJson(raviJsonObject(json, "RulesImportReturn"));
  }
}

RulesImportReturn rulesImportReturnFromJson(Object? json) => RulesImportReturn.fromJsonValue(json);

class RulesSourcesOptions {
  const RulesSourcesOptions({this.cwd, this.fields, this.includeUser});

  final String? cwd;
  final String? fields;
  final bool? includeUser;

  void encodeBody(Map<String, RaviJson> into) {
    if (cwd != null) {
      into["cwd"] = RaviJson.from(cwd);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (includeUser != null) {
      into["includeUser"] = RaviJson.from(includeUser);
    }
  }
}

class RulesSourcesReturn {
  const RulesSourcesReturn({required this.counts, required this.cwd, required this.includeUser, required this.provider, required this.sources});

  final RaviJson counts;
  final String cwd;
  final bool includeUser;
  final String provider;
  final List<Map<String, RaviJson>> sources;

  factory RulesSourcesReturn.fromJson(Map<String, Object?> json) {
    return RulesSourcesReturn(
      counts: RaviJson.from(json["counts"]),
      cwd: raviJsonAsString(json["cwd"]),
      includeUser: raviJsonAsBool(json["includeUser"]),
      provider: raviJsonAsString(json["provider"]),
      sources: raviJsonAsList(json["sources"], raviJsonAsRaviJsonMap),
    );
  }

  static RulesSourcesReturn fromJsonValue(Object? json) {
    return RulesSourcesReturn.fromJson(raviJsonObject(json, "RulesSourcesReturn"));
  }
}

RulesSourcesReturn rulesSourcesReturnFromJson(Object? json) => RulesSourcesReturn.fromJsonValue(json);

class RuntimeCredentialsAddOptions {
  const RuntimeCredentialsAddOptions({this.agents, this.authMethod, this.authProfile, this.label, this.models, this.notes, this.priority, this.provider, this.readOnly, this.remoteForward, this.secretEnv, this.targetEnv, this.taskProfiles, this.upstream});

  final String? agents;
  final String? authMethod;
  final String? authProfile;
  final String? label;
  final String? models;
  final String? notes;
  final String? priority;
  final String? provider;
  final bool? readOnly;
  final bool? remoteForward;
  final String? secretEnv;
  final String? targetEnv;
  final String? taskProfiles;
  final String? upstream;

  void encodeBody(Map<String, RaviJson> into) {
    if (agents != null) {
      into["agents"] = RaviJson.from(agents);
    }
    if (authMethod != null) {
      into["authMethod"] = RaviJson.from(authMethod);
    }
    if (authProfile != null) {
      into["authProfile"] = RaviJson.from(authProfile);
    }
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (models != null) {
      into["models"] = RaviJson.from(models);
    }
    if (notes != null) {
      into["notes"] = RaviJson.from(notes);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (readOnly != null) {
      into["readOnly"] = RaviJson.from(readOnly);
    }
    if (remoteForward != null) {
      into["remoteForward"] = RaviJson.from(remoteForward);
    }
    if (secretEnv != null) {
      into["secretEnv"] = RaviJson.from(secretEnv);
    }
    if (targetEnv != null) {
      into["targetEnv"] = RaviJson.from(targetEnv);
    }
    if (taskProfiles != null) {
      into["taskProfiles"] = RaviJson.from(taskProfiles);
    }
    if (upstream != null) {
      into["upstream"] = RaviJson.from(upstream);
    }
  }
}

class RuntimeCredentialsAddReturn {
  const RuntimeCredentialsAddReturn({required this.credential});

  final Map<String, RaviJson> credential;

  factory RuntimeCredentialsAddReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsAddReturn(
      credential: raviJsonAsRaviJsonMap(json["credential"]),
    );
  }

  static RuntimeCredentialsAddReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsAddReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsAddReturn"));
  }
}

RuntimeCredentialsAddReturn runtimeCredentialsAddReturnFromJson(Object? json) => RuntimeCredentialsAddReturn.fromJsonValue(json);

class RuntimeCredentialsClassifyOptions {
  const RuntimeCredentialsClassifyOptions({this.credential, this.headers, this.message, this.provider, this.providerCode, this.providerType, this.record, this.status, this.upstream});

  final String? credential;
  final String? headers;
  final String? message;
  final String? provider;
  final String? providerCode;
  final String? providerType;
  final bool? record;
  final String? status;
  final String? upstream;

  void encodeBody(Map<String, RaviJson> into) {
    if (credential != null) {
      into["credential"] = RaviJson.from(credential);
    }
    if (headers != null) {
      into["headers"] = RaviJson.from(headers);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (providerCode != null) {
      into["providerCode"] = RaviJson.from(providerCode);
    }
    if (providerType != null) {
      into["providerType"] = RaviJson.from(providerType);
    }
    if (record != null) {
      into["record"] = RaviJson.from(record);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (upstream != null) {
      into["upstream"] = RaviJson.from(upstream);
    }
  }
}

class RuntimeCredentialsClassifyReturn {
  const RuntimeCredentialsClassifyReturn({required this.pressure, required this.signal});

  final Map<String, RaviJson> pressure;
  final Map<String, RaviJson> signal;

  factory RuntimeCredentialsClassifyReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsClassifyReturn(
      pressure: raviJsonAsRaviJsonMap(json["pressure"]),
      signal: raviJsonAsRaviJsonMap(json["signal"]),
    );
  }

  static RuntimeCredentialsClassifyReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsClassifyReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsClassifyReturn"));
  }
}

RuntimeCredentialsClassifyReturn runtimeCredentialsClassifyReturnFromJson(Object? json) => RuntimeCredentialsClassifyReturn.fromJsonValue(json);

class RuntimeCredentialsDisableReturn {
  const RuntimeCredentialsDisableReturn({required this.credential});

  final Map<String, RaviJson> credential;

  factory RuntimeCredentialsDisableReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsDisableReturn(
      credential: raviJsonAsRaviJsonMap(json["credential"]),
    );
  }

  static RuntimeCredentialsDisableReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsDisableReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsDisableReturn"));
  }
}

RuntimeCredentialsDisableReturn runtimeCredentialsDisableReturnFromJson(Object? json) => RuntimeCredentialsDisableReturn.fromJsonValue(json);

class RuntimeCredentialsEnableReturn {
  const RuntimeCredentialsEnableReturn({required this.credential});

  final Map<String, RaviJson> credential;

  factory RuntimeCredentialsEnableReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsEnableReturn(
      credential: raviJsonAsRaviJsonMap(json["credential"]),
    );
  }

  static RuntimeCredentialsEnableReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsEnableReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsEnableReturn"));
  }
}

RuntimeCredentialsEnableReturn runtimeCredentialsEnableReturnFromJson(Object? json) => RuntimeCredentialsEnableReturn.fromJsonValue(json);

class RuntimeCredentialsImportOptions {
  const RuntimeCredentialsImportOptions({this.fromClaudeCode, this.fromCodexHome, this.label, this.managedRefresh, this.provider});

  final bool? fromClaudeCode;
  final String? fromCodexHome;
  final String? label;
  final bool? managedRefresh;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (fromClaudeCode != null) {
      into["fromClaudeCode"] = RaviJson.from(fromClaudeCode);
    }
    if (fromCodexHome != null) {
      into["fromCodexHome"] = RaviJson.from(fromCodexHome);
    }
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (managedRefresh != null) {
      into["managedRefresh"] = RaviJson.from(managedRefresh);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class RuntimeCredentialsImportReturn {
  const RuntimeCredentialsImportReturn({required this.credential});

  final Map<String, RaviJson> credential;

  factory RuntimeCredentialsImportReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsImportReturn(
      credential: raviJsonAsRaviJsonMap(json["credential"]),
    );
  }

  static RuntimeCredentialsImportReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsImportReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsImportReturn"));
  }
}

RuntimeCredentialsImportReturn runtimeCredentialsImportReturnFromJson(Object? json) => RuntimeCredentialsImportReturn.fromJsonValue(json);

class RuntimeCredentialsListOptions {
  const RuntimeCredentialsListOptions({this.all, this.fields, this.limit, this.offset, this.provider, this.status, this.upstream});

  final bool? all;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? provider;
  final String? status;
  final String? upstream;

  void encodeBody(Map<String, RaviJson> into) {
    if (all != null) {
      into["all"] = RaviJson.from(all);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (upstream != null) {
      into["upstream"] = RaviJson.from(upstream);
    }
  }
}

class RuntimeCredentialsListReturn {
  const RuntimeCredentialsListReturn({required this.credentials, required this.pagination, required this.providerHealth, required this.total});

  final List<Map<String, RaviJson>> credentials;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> providerHealth;
  final double total;

  factory RuntimeCredentialsListReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsListReturn(
      credentials: raviJsonAsList(json["credentials"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      providerHealth: raviJsonAsList(json["providerHealth"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static RuntimeCredentialsListReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsListReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsListReturn"));
  }
}

RuntimeCredentialsListReturn runtimeCredentialsListReturnFromJson(Object? json) => RuntimeCredentialsListReturn.fromJsonValue(json);

class RuntimeCredentialsRefreshOptions {
  const RuntimeCredentialsRefreshOptions({this.agent, this.force, this.model, this.provider, this.taskProfile, this.upstream});

  final String? agent;
  final bool? force;
  final String? model;
  final String? provider;
  final String? taskProfile;
  final String? upstream;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (force != null) {
      into["force"] = RaviJson.from(force);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (taskProfile != null) {
      into["taskProfile"] = RaviJson.from(taskProfile);
    }
    if (upstream != null) {
      into["upstream"] = RaviJson.from(upstream);
    }
  }
}

class RuntimeCredentialsRefreshReturn {
  const RuntimeCredentialsRefreshReturn({required this.refreshed});

  final List<Map<String, RaviJson>> refreshed;

  factory RuntimeCredentialsRefreshReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsRefreshReturn(
      refreshed: raviJsonAsList(json["refreshed"], raviJsonAsRaviJsonMap),
    );
  }

  static RuntimeCredentialsRefreshReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsRefreshReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsRefreshReturn"));
  }
}

RuntimeCredentialsRefreshReturn runtimeCredentialsRefreshReturnFromJson(Object? json) => RuntimeCredentialsRefreshReturn.fromJsonValue(json);

class RuntimeCredentialsResetHealthReturn {
  const RuntimeCredentialsResetHealthReturn({required this.credential, required this.health});

  final Map<String, RaviJson> credential;
  final RaviJson health;

  factory RuntimeCredentialsResetHealthReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsResetHealthReturn(
      credential: raviJsonAsRaviJsonMap(json["credential"]),
      health: RaviJson.from(json["health"]),
    );
  }

  static RuntimeCredentialsResetHealthReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsResetHealthReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsResetHealthReturn"));
  }
}

RuntimeCredentialsResetHealthReturn runtimeCredentialsResetHealthReturnFromJson(Object? json) => RuntimeCredentialsResetHealthReturn.fromJsonValue(json);

class RuntimeCredentialsSelectOptions {
  const RuntimeCredentialsSelectOptions({this.agent, this.model, this.provider, this.taskProfile, this.upstream});

  final String? agent;
  final String? model;
  final String? provider;
  final String? taskProfile;
  final String? upstream;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (taskProfile != null) {
      into["taskProfile"] = RaviJson.from(taskProfile);
    }
    if (upstream != null) {
      into["upstream"] = RaviJson.from(upstream);
    }
  }
}

class RuntimeCredentialsSelectReturn {
  const RuntimeCredentialsSelectReturn({required this.candidates, required this.rejected, required this.selected});

  final List<Map<String, RaviJson>> candidates;
  final List<Map<String, RaviJson>> rejected;
  final RaviJson selected;

  factory RuntimeCredentialsSelectReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsSelectReturn(
      candidates: raviJsonAsList(json["candidates"], raviJsonAsRaviJsonMap),
      rejected: raviJsonAsList(json["rejected"], raviJsonAsRaviJsonMap),
      selected: RaviJson.from(json["selected"]),
    );
  }

  static RuntimeCredentialsSelectReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsSelectReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsSelectReturn"));
  }
}

RuntimeCredentialsSelectReturn runtimeCredentialsSelectReturnFromJson(Object? json) => RuntimeCredentialsSelectReturn.fromJsonValue(json);

class RuntimeCredentialsStatusReturn {
  const RuntimeCredentialsStatusReturn({required this.credential, required this.health});

  final Map<String, RaviJson> credential;
  final RaviJson health;

  factory RuntimeCredentialsStatusReturn.fromJson(Map<String, Object?> json) {
    return RuntimeCredentialsStatusReturn(
      credential: raviJsonAsRaviJsonMap(json["credential"]),
      health: RaviJson.from(json["health"]),
    );
  }

  static RuntimeCredentialsStatusReturn fromJsonValue(Object? json) {
    return RuntimeCredentialsStatusReturn.fromJson(raviJsonObject(json, "RuntimeCredentialsStatusReturn"));
  }
}

RuntimeCredentialsStatusReturn runtimeCredentialsStatusReturnFromJson(Object? json) => RuntimeCredentialsStatusReturn.fromJsonValue(json);

class RuntimePresetsCreateOptions {
  const RuntimePresetsCreateOptions({this.description, this.disabled, this.model, this.provider});

  final String? description;
  final bool? disabled;
  final String? model;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (disabled != null) {
      into["disabled"] = RaviJson.from(disabled);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class RuntimePresetsCreateReturn {
  const RuntimePresetsCreateReturn({required this.action, required this.changed, required this.dryRun, required this.preset});

  final String action;
  final bool changed;
  final bool dryRun;
  final RaviJson preset;

  factory RuntimePresetsCreateReturn.fromJson(Map<String, Object?> json) {
    return RuntimePresetsCreateReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      preset: RaviJson.from(json["preset"]),
    );
  }

  static RuntimePresetsCreateReturn fromJsonValue(Object? json) {
    return RuntimePresetsCreateReturn.fromJson(raviJsonObject(json, "RuntimePresetsCreateReturn"));
  }
}

RuntimePresetsCreateReturn runtimePresetsCreateReturnFromJson(Object? json) => RuntimePresetsCreateReturn.fromJsonValue(json);

class RuntimePresetsDeleteOptions {
  const RuntimePresetsDeleteOptions({this.dryRun});

  final bool? dryRun;

  void encodeBody(Map<String, RaviJson> into) {
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
  }
}

class RuntimePresetsDeleteReturn {
  const RuntimePresetsDeleteReturn({required this.action, required this.changed, required this.dryRun, required this.preset});

  final String action;
  final bool changed;
  final bool dryRun;
  final RaviJson preset;

  factory RuntimePresetsDeleteReturn.fromJson(Map<String, Object?> json) {
    return RuntimePresetsDeleteReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      preset: RaviJson.from(json["preset"]),
    );
  }

  static RuntimePresetsDeleteReturn fromJsonValue(Object? json) {
    return RuntimePresetsDeleteReturn.fromJson(raviJsonObject(json, "RuntimePresetsDeleteReturn"));
  }
}

RuntimePresetsDeleteReturn runtimePresetsDeleteReturnFromJson(Object? json) => RuntimePresetsDeleteReturn.fromJsonValue(json);

class RuntimePresetsDisableOptions {
  const RuntimePresetsDisableOptions({this.dryRun});

  final bool? dryRun;

  void encodeBody(Map<String, RaviJson> into) {
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
  }
}

class RuntimePresetsDisableReturn {
  const RuntimePresetsDisableReturn({required this.action, required this.changed, required this.dryRun, required this.preset});

  final String action;
  final bool changed;
  final bool dryRun;
  final RaviJson preset;

  factory RuntimePresetsDisableReturn.fromJson(Map<String, Object?> json) {
    return RuntimePresetsDisableReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      preset: RaviJson.from(json["preset"]),
    );
  }

  static RuntimePresetsDisableReturn fromJsonValue(Object? json) {
    return RuntimePresetsDisableReturn.fromJson(raviJsonObject(json, "RuntimePresetsDisableReturn"));
  }
}

RuntimePresetsDisableReturn runtimePresetsDisableReturnFromJson(Object? json) => RuntimePresetsDisableReturn.fromJsonValue(json);

class RuntimePresetsEnableOptions {
  const RuntimePresetsEnableOptions({this.dryRun});

  final bool? dryRun;

  void encodeBody(Map<String, RaviJson> into) {
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
  }
}

class RuntimePresetsEnableReturn {
  const RuntimePresetsEnableReturn({required this.action, required this.changed, required this.dryRun, required this.preset});

  final String action;
  final bool changed;
  final bool dryRun;
  final RaviJson preset;

  factory RuntimePresetsEnableReturn.fromJson(Map<String, Object?> json) {
    return RuntimePresetsEnableReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      preset: RaviJson.from(json["preset"]),
    );
  }

  static RuntimePresetsEnableReturn fromJsonValue(Object? json) {
    return RuntimePresetsEnableReturn.fromJson(raviJsonObject(json, "RuntimePresetsEnableReturn"));
  }
}

RuntimePresetsEnableReturn runtimePresetsEnableReturnFromJson(Object? json) => RuntimePresetsEnableReturn.fromJsonValue(json);

class RuntimePresetsImpactOptions {
  const RuntimePresetsImpactOptions({this.limit, this.offset});

  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class RuntimePresetsImpactReturn {
  const RuntimePresetsImpactReturn({required this.agents, required this.correctionCommand, required this.enabled, required this.limit, required this.model, required this.offset, required this.pagination, required this.presetId, required this.provider, required this.referenced, required this.referencingAgentsTotal, required this.shadowingSessionsTotal, required this.version});

  final List<RaviJson> agents;
  final RaviJson correctionCommand;
  final bool enabled;
  final double limit;
  final String model;
  final double offset;
  final RaviJson pagination;
  final String presetId;
  final String provider;
  final bool referenced;
  final double referencingAgentsTotal;
  final double shadowingSessionsTotal;
  final double version;

  factory RuntimePresetsImpactReturn.fromJson(Map<String, Object?> json) {
    return RuntimePresetsImpactReturn(
      agents: raviJsonAsList(json["agents"], RaviJson.from),
      correctionCommand: RaviJson.from(json["correctionCommand"]),
      enabled: raviJsonAsBool(json["enabled"]),
      limit: raviJsonAsDouble(json["limit"]),
      model: raviJsonAsString(json["model"]),
      offset: raviJsonAsDouble(json["offset"]),
      pagination: RaviJson.from(json["pagination"]),
      presetId: raviJsonAsString(json["presetId"]),
      provider: raviJsonAsString(json["provider"]),
      referenced: raviJsonAsBool(json["referenced"]),
      referencingAgentsTotal: raviJsonAsDouble(json["referencingAgentsTotal"]),
      shadowingSessionsTotal: raviJsonAsDouble(json["shadowingSessionsTotal"]),
      version: raviJsonAsDouble(json["version"]),
    );
  }

  static RuntimePresetsImpactReturn fromJsonValue(Object? json) {
    return RuntimePresetsImpactReturn.fromJson(raviJsonObject(json, "RuntimePresetsImpactReturn"));
  }
}

RuntimePresetsImpactReturn runtimePresetsImpactReturnFromJson(Object? json) => RuntimePresetsImpactReturn.fromJsonValue(json);

class RuntimePresetsListOptions {
  const RuntimePresetsListOptions({this.disabled, this.enabled, this.fields, this.limit, this.offset, this.provider});

  final bool? disabled;
  final bool? enabled;
  final String? fields;
  final String? limit;
  final String? offset;
  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (disabled != null) {
      into["disabled"] = RaviJson.from(disabled);
    }
    if (enabled != null) {
      into["enabled"] = RaviJson.from(enabled);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class RuntimePresetsListReturn {
  const RuntimePresetsListReturn({required this.pagination, required this.presets, required this.total});

  final RaviJson pagination;
  final List<RaviJson> presets;
  final double total;

  factory RuntimePresetsListReturn.fromJson(Map<String, Object?> json) {
    return RuntimePresetsListReturn(
      pagination: RaviJson.from(json["pagination"]),
      presets: raviJsonAsList(json["presets"], RaviJson.from),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static RuntimePresetsListReturn fromJsonValue(Object? json) {
    return RuntimePresetsListReturn.fromJson(raviJsonObject(json, "RuntimePresetsListReturn"));
  }
}

RuntimePresetsListReturn runtimePresetsListReturnFromJson(Object? json) => RuntimePresetsListReturn.fromJsonValue(json);

class RuntimePresetsSetOptions {
  const RuntimePresetsSetOptions({this.dryRun});

  final bool? dryRun;

  void encodeBody(Map<String, RaviJson> into) {
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
  }
}

class RuntimePresetsSetReturn {
  const RuntimePresetsSetReturn({required this.action, required this.changed, required this.dryRun, required this.preset});

  final String action;
  final bool changed;
  final bool dryRun;
  final RaviJson preset;

  factory RuntimePresetsSetReturn.fromJson(Map<String, Object?> json) {
    return RuntimePresetsSetReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      preset: RaviJson.from(json["preset"]),
    );
  }

  static RuntimePresetsSetReturn fromJsonValue(Object? json) {
    return RuntimePresetsSetReturn.fromJson(raviJsonObject(json, "RuntimePresetsSetReturn"));
  }
}

RuntimePresetsSetReturn runtimePresetsSetReturnFromJson(Object? json) => RuntimePresetsSetReturn.fromJsonValue(json);

class RuntimePresetsShowReturn {
  const RuntimePresetsShowReturn({required this.preset, required this.referencingAgentsTotal});

  final RaviJson preset;
  final double referencingAgentsTotal;

  factory RuntimePresetsShowReturn.fromJson(Map<String, Object?> json) {
    return RuntimePresetsShowReturn(
      preset: RaviJson.from(json["preset"]),
      referencingAgentsTotal: raviJsonAsDouble(json["referencingAgentsTotal"]),
    );
  }

  static RuntimePresetsShowReturn fromJsonValue(Object? json) {
    return RuntimePresetsShowReturn.fromJson(raviJsonObject(json, "RuntimePresetsShowReturn"));
  }
}

RuntimePresetsShowReturn runtimePresetsShowReturnFromJson(Object? json) => RuntimePresetsShowReturn.fromJsonValue(json);

class SdkClientCheckOptions {
  const SdkClientCheckOptions({this.out, this.version});

  final String? out;
  final String? version;

  void encodeBody(Map<String, RaviJson> into) {
    if (out != null) {
      into["out"] = RaviJson.from(out);
    }
    if (version != null) {
      into["version"] = RaviJson.from(version);
    }
  }
}

class SdkClientCheckReturn {
  const SdkClientCheckReturn({required this.dir, required this.drift, required this.files});

  final String dir;
  final List<RaviJson> drift;
  final List<String> files;

  factory SdkClientCheckReturn.fromJson(Map<String, Object?> json) {
    return SdkClientCheckReturn(
      dir: raviJsonAsString(json["dir"]),
      drift: raviJsonAsList(json["drift"], RaviJson.from),
      files: raviJsonAsList(json["files"], raviJsonAsString),
    );
  }

  static SdkClientCheckReturn fromJsonValue(Object? json) {
    return SdkClientCheckReturn.fromJson(raviJsonObject(json, "SdkClientCheckReturn"));
  }
}

SdkClientCheckReturn sdkClientCheckReturnFromJson(Object? json) => SdkClientCheckReturn.fromJsonValue(json);

class SdkClientGenerateOptions {
  const SdkClientGenerateOptions({this.out, this.version});

  final String? out;
  final String? version;

  void encodeBody(Map<String, RaviJson> into) {
    if (out != null) {
      into["out"] = RaviJson.from(out);
    }
    if (version != null) {
      into["version"] = RaviJson.from(version);
    }
  }
}

class SdkClientGenerateReturn {
  const SdkClientGenerateReturn({required this.dir, required this.files, required this.status});

  final String dir;
  final List<RaviJson> files;
  final String status;

  factory SdkClientGenerateReturn.fromJson(Map<String, Object?> json) {
    return SdkClientGenerateReturn(
      dir: raviJsonAsString(json["dir"]),
      files: raviJsonAsList(json["files"], RaviJson.from),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SdkClientGenerateReturn fromJsonValue(Object? json) {
    return SdkClientGenerateReturn.fromJson(raviJsonObject(json, "SdkClientGenerateReturn"));
  }
}

SdkClientGenerateReturn sdkClientGenerateReturnFromJson(Object? json) => SdkClientGenerateReturn.fromJsonValue(json);

class SdkDartCheckOptions {
  const SdkDartCheckOptions({this.out, this.version});

  final String? out;
  final String? version;

  void encodeBody(Map<String, RaviJson> into) {
    if (out != null) {
      into["out"] = RaviJson.from(out);
    }
    if (version != null) {
      into["version"] = RaviJson.from(version);
    }
  }
}

class SdkDartCheckReturn {
  const SdkDartCheckReturn({required this.dir, required this.drift, required this.files});

  final String dir;
  final List<RaviJson> drift;
  final List<String> files;

  factory SdkDartCheckReturn.fromJson(Map<String, Object?> json) {
    return SdkDartCheckReturn(
      dir: raviJsonAsString(json["dir"]),
      drift: raviJsonAsList(json["drift"], RaviJson.from),
      files: raviJsonAsList(json["files"], raviJsonAsString),
    );
  }

  static SdkDartCheckReturn fromJsonValue(Object? json) {
    return SdkDartCheckReturn.fromJson(raviJsonObject(json, "SdkDartCheckReturn"));
  }
}

SdkDartCheckReturn sdkDartCheckReturnFromJson(Object? json) => SdkDartCheckReturn.fromJsonValue(json);

class SdkDartGenerateOptions {
  const SdkDartGenerateOptions({this.out, this.version});

  final String? out;
  final String? version;

  void encodeBody(Map<String, RaviJson> into) {
    if (out != null) {
      into["out"] = RaviJson.from(out);
    }
    if (version != null) {
      into["version"] = RaviJson.from(version);
    }
  }
}

class SdkDartGenerateReturn {
  const SdkDartGenerateReturn({required this.dir, required this.files, required this.status});

  final String dir;
  final List<RaviJson> files;
  final String status;

  factory SdkDartGenerateReturn.fromJson(Map<String, Object?> json) {
    return SdkDartGenerateReturn(
      dir: raviJsonAsString(json["dir"]),
      files: raviJsonAsList(json["files"], RaviJson.from),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SdkDartGenerateReturn fromJsonValue(Object? json) {
    return SdkDartGenerateReturn.fromJson(raviJsonObject(json, "SdkDartGenerateReturn"));
  }
}

SdkDartGenerateReturn sdkDartGenerateReturnFromJson(Object? json) => SdkDartGenerateReturn.fromJsonValue(json);

class SdkOpenapiCheckOptions {
  const SdkOpenapiCheckOptions({this.against});

  final String? against;

  void encodeBody(Map<String, RaviJson> into) {
    if (against != null) {
      into["against"] = RaviJson.from(against);
    }
  }
}

class SdkOpenapiCheckReturn {
  const SdkOpenapiCheckReturn({required this.drift, required this.liveBytes, required this.path, required this.storedBytes});

  final bool drift;
  final double liveBytes;
  final String path;
  final double storedBytes;

  factory SdkOpenapiCheckReturn.fromJson(Map<String, Object?> json) {
    return SdkOpenapiCheckReturn(
      drift: raviJsonAsBool(json["drift"]),
      liveBytes: raviJsonAsDouble(json["liveBytes"]),
      path: raviJsonAsString(json["path"]),
      storedBytes: raviJsonAsDouble(json["storedBytes"]),
    );
  }

  static SdkOpenapiCheckReturn fromJsonValue(Object? json) {
    return SdkOpenapiCheckReturn.fromJson(raviJsonObject(json, "SdkOpenapiCheckReturn"));
  }
}

SdkOpenapiCheckReturn sdkOpenapiCheckReturnFromJson(Object? json) => SdkOpenapiCheckReturn.fromJsonValue(json);

class SdkOpenapiEmitOptions {
  const SdkOpenapiEmitOptions({this.out, this.stdout});

  final String? out;
  final bool? stdout;

  void encodeBody(Map<String, RaviJson> into) {
    if (out != null) {
      into["out"] = RaviJson.from(out);
    }
    if (stdout != null) {
      into["stdout"] = RaviJson.from(stdout);
    }
  }
}

typedef SdkOpenapiEmitReturn = RaviJson;

SdkOpenapiEmitReturn sdkOpenapiEmitReturnFromJson(Object? json) => RaviJson.from(json);

class SdkSwiftCheckOptions {
  const SdkSwiftCheckOptions({this.out, this.version});

  final String? out;
  final String? version;

  void encodeBody(Map<String, RaviJson> into) {
    if (out != null) {
      into["out"] = RaviJson.from(out);
    }
    if (version != null) {
      into["version"] = RaviJson.from(version);
    }
  }
}

class SdkSwiftCheckReturn {
  const SdkSwiftCheckReturn({required this.dir, required this.drift, required this.files});

  final String dir;
  final List<RaviJson> drift;
  final List<String> files;

  factory SdkSwiftCheckReturn.fromJson(Map<String, Object?> json) {
    return SdkSwiftCheckReturn(
      dir: raviJsonAsString(json["dir"]),
      drift: raviJsonAsList(json["drift"], RaviJson.from),
      files: raviJsonAsList(json["files"], raviJsonAsString),
    );
  }

  static SdkSwiftCheckReturn fromJsonValue(Object? json) {
    return SdkSwiftCheckReturn.fromJson(raviJsonObject(json, "SdkSwiftCheckReturn"));
  }
}

SdkSwiftCheckReturn sdkSwiftCheckReturnFromJson(Object? json) => SdkSwiftCheckReturn.fromJsonValue(json);

class SdkSwiftGenerateOptions {
  const SdkSwiftGenerateOptions({this.out, this.version});

  final String? out;
  final String? version;

  void encodeBody(Map<String, RaviJson> into) {
    if (out != null) {
      into["out"] = RaviJson.from(out);
    }
    if (version != null) {
      into["version"] = RaviJson.from(version);
    }
  }
}

class SdkSwiftGenerateReturn {
  const SdkSwiftGenerateReturn({required this.dir, required this.files, required this.status});

  final String dir;
  final List<RaviJson> files;
  final String status;

  factory SdkSwiftGenerateReturn.fromJson(Map<String, Object?> json) {
    return SdkSwiftGenerateReturn(
      dir: raviJsonAsString(json["dir"]),
      files: raviJsonAsList(json["files"], RaviJson.from),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SdkSwiftGenerateReturn fromJsonValue(Object? json) {
    return SdkSwiftGenerateReturn.fromJson(raviJsonObject(json, "SdkSwiftGenerateReturn"));
  }
}

SdkSwiftGenerateReturn sdkSwiftGenerateReturnFromJson(Object? json) => SdkSwiftGenerateReturn.fromJsonValue(json);

class SelfChatOptions {
  const SelfChatOptions({this.depth});

  final String? depth;

  void encodeBody(Map<String, RaviJson> into) {
    if (depth != null) {
      into["depth"] = RaviJson.from(depth);
    }
  }
}

class SelfChatReturn {
  const SelfChatReturn({this.data, this.reason, required this.status});

  final RaviJson? data;
  final String? reason;
  final String status;

  factory SelfChatReturn.fromJson(Map<String, Object?> json) {
    return SelfChatReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SelfChatReturn fromJsonValue(Object? json) {
    return SelfChatReturn.fromJson(raviJsonObject(json, "SelfChatReturn"));
  }
}

SelfChatReturn selfChatReturnFromJson(Object? json) => SelfChatReturn.fromJsonValue(json);

class SelfContextOptions {
  const SelfContextOptions({this.depth, this.fields, this.limit});

  final String? depth;
  final String? fields;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (depth != null) {
      into["depth"] = RaviJson.from(depth);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class SelfContextReturn {
  const SelfContextReturn({required this.actor, required this.chat, required this.depth, required this.explain, required this.generatedAt, required this.identity, required this.knowledge, required this.limit, required this.nextReads, required this.permissions, required this.recent, required this.route, required this.session});

  final RaviJson actor;
  final RaviJson chat;
  final String depth;
  final List<Map<String, RaviJson>> explain;
  final double generatedAt;
  final Map<String, RaviJson> identity;
  final RaviJson knowledge;
  final double limit;
  final List<String> nextReads;
  final RaviJson permissions;
  final RaviJson recent;
  final RaviJson route;
  final RaviJson session;

  factory SelfContextReturn.fromJson(Map<String, Object?> json) {
    return SelfContextReturn(
      actor: RaviJson.from(json["actor"]),
      chat: RaviJson.from(json["chat"]),
      depth: raviJsonAsString(json["depth"]),
      explain: raviJsonAsList(json["explain"], raviJsonAsRaviJsonMap),
      generatedAt: raviJsonAsDouble(json["generatedAt"]),
      identity: raviJsonAsRaviJsonMap(json["identity"]),
      knowledge: RaviJson.from(json["knowledge"]),
      limit: raviJsonAsDouble(json["limit"]),
      nextReads: raviJsonAsList(json["nextReads"], raviJsonAsString),
      permissions: RaviJson.from(json["permissions"]),
      recent: RaviJson.from(json["recent"]),
      route: RaviJson.from(json["route"]),
      session: RaviJson.from(json["session"]),
    );
  }

  static SelfContextReturn fromJsonValue(Object? json) {
    return SelfContextReturn.fromJson(raviJsonObject(json, "SelfContextReturn"));
  }
}

SelfContextReturn selfContextReturnFromJson(Object? json) => SelfContextReturn.fromJsonValue(json);

class SelfExplainReturn {
  const SelfExplainReturn({required this.explain, required this.generatedAt, required this.nextReads});

  final List<Map<String, RaviJson>> explain;
  final double generatedAt;
  final List<String> nextReads;

  factory SelfExplainReturn.fromJson(Map<String, Object?> json) {
    return SelfExplainReturn(
      explain: raviJsonAsList(json["explain"], raviJsonAsRaviJsonMap),
      generatedAt: raviJsonAsDouble(json["generatedAt"]),
      nextReads: raviJsonAsList(json["nextReads"], raviJsonAsString),
    );
  }

  static SelfExplainReturn fromJsonValue(Object? json) {
    return SelfExplainReturn.fromJson(raviJsonObject(json, "SelfExplainReturn"));
  }
}

SelfExplainReturn selfExplainReturnFromJson(Object? json) => SelfExplainReturn.fromJsonValue(json);

class SelfKnowledgeReturn {
  const SelfKnowledgeReturn({this.data, this.reason, required this.status});

  final RaviJson? data;
  final String? reason;
  final String status;

  factory SelfKnowledgeReturn.fromJson(Map<String, Object?> json) {
    return SelfKnowledgeReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SelfKnowledgeReturn fromJsonValue(Object? json) {
    return SelfKnowledgeReturn.fromJson(raviJsonObject(json, "SelfKnowledgeReturn"));
  }
}

SelfKnowledgeReturn selfKnowledgeReturnFromJson(Object? json) => SelfKnowledgeReturn.fromJsonValue(json);

class SelfPermissionsReturn {
  const SelfPermissionsReturn({this.data, this.reason, required this.status});

  final RaviJson? data;
  final String? reason;
  final String status;

  factory SelfPermissionsReturn.fromJson(Map<String, Object?> json) {
    return SelfPermissionsReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SelfPermissionsReturn fromJsonValue(Object? json) {
    return SelfPermissionsReturn.fromJson(raviJsonObject(json, "SelfPermissionsReturn"));
  }
}

SelfPermissionsReturn selfPermissionsReturnFromJson(Object? json) => SelfPermissionsReturn.fromJsonValue(json);

class SelfRecentOptions {
  const SelfRecentOptions({this.limit});

  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class SelfRecentReturn {
  const SelfRecentReturn({this.data, this.reason, required this.status});

  final RaviJson? data;
  final String? reason;
  final String status;

  factory SelfRecentReturn.fromJson(Map<String, Object?> json) {
    return SelfRecentReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SelfRecentReturn fromJsonValue(Object? json) {
    return SelfRecentReturn.fromJson(raviJsonObject(json, "SelfRecentReturn"));
  }
}

SelfRecentReturn selfRecentReturnFromJson(Object? json) => SelfRecentReturn.fromJsonValue(json);

class SelfRouteReturn {
  const SelfRouteReturn({this.data, this.reason, required this.status});

  final RaviJson? data;
  final String? reason;
  final String status;

  factory SelfRouteReturn.fromJson(Map<String, Object?> json) {
    return SelfRouteReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SelfRouteReturn fromJsonValue(Object? json) {
    return SelfRouteReturn.fromJson(raviJsonObject(json, "SelfRouteReturn"));
  }
}

SelfRouteReturn selfRouteReturnFromJson(Object? json) => SelfRouteReturn.fromJsonValue(json);

class SelfWhoamiReturn {
  const SelfWhoamiReturn({required this.actor, required this.chat, required this.generatedAt, required this.identity, required this.nextReads, required this.route, required this.session});

  final RaviJson actor;
  final RaviJson chat;
  final double generatedAt;
  final Map<String, RaviJson> identity;
  final List<String> nextReads;
  final RaviJson route;
  final RaviJson session;

  factory SelfWhoamiReturn.fromJson(Map<String, Object?> json) {
    return SelfWhoamiReturn(
      actor: RaviJson.from(json["actor"]),
      chat: RaviJson.from(json["chat"]),
      generatedAt: raviJsonAsDouble(json["generatedAt"]),
      identity: raviJsonAsRaviJsonMap(json["identity"]),
      nextReads: raviJsonAsList(json["nextReads"], raviJsonAsString),
      route: RaviJson.from(json["route"]),
      session: RaviJson.from(json["session"]),
    );
  }

  static SelfWhoamiReturn fromJsonValue(Object? json) {
    return SelfWhoamiReturn.fromJson(raviJsonObject(json, "SelfWhoamiReturn"));
  }
}

SelfWhoamiReturn selfWhoamiReturnFromJson(Object? json) => SelfWhoamiReturn.fromJsonValue(json);

class SessionsActionsOptions {
  const SessionsActionsOptions({this.limit});

  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

typedef SessionsActionsReturn = Map<String, RaviJson>;

SessionsActionsReturn sessionsActionsReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsAnswerOptions {
  const SessionsAnswerOptions({this.barrier, this.channel, this.immediate, this.steer, this.to});

  final String? barrier;
  final String? channel;
  final bool? immediate;
  final bool? steer;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (barrier != null) {
      into["barrier"] = RaviJson.from(barrier);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (immediate != null) {
      into["immediate"] = RaviJson.from(immediate);
    }
    if (steer != null) {
      into["steer"] = RaviJson.from(steer);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

typedef SessionsAnswerReturn = Map<String, RaviJson>;

SessionsAnswerReturn sessionsAnswerReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsAskOptions {
  const SessionsAskOptions({this.barrier, this.channel, this.immediate, this.steer, this.to});

  final String? barrier;
  final String? channel;
  final bool? immediate;
  final bool? steer;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (barrier != null) {
      into["barrier"] = RaviJson.from(barrier);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (immediate != null) {
      into["immediate"] = RaviJson.from(immediate);
    }
    if (steer != null) {
      into["steer"] = RaviJson.from(steer);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

typedef SessionsAskReturn = Map<String, RaviJson>;

SessionsAskReturn sessionsAskReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsAttachOptions {
  const SessionsAttachOptions({this.chat, this.reason});

  final String? chat;
  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (chat != null) {
      into["chat"] = RaviJson.from(chat);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

typedef SessionsAttachReturn = Map<String, RaviJson>;

SessionsAttachReturn sessionsAttachReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsCloseThreadOptions {
  const SessionsCloseThreadOptions({this.return_, this.session});

  final String? return_;
  final String? session;

  void encodeBody(Map<String, RaviJson> into) {
    if (return_ != null) {
      into["return"] = RaviJson.from(return_);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
  }
}

class SessionsCloseThreadReturn {
  const SessionsCloseThreadReturn({required this.actionId, required this.changed, required this.childSession, required this.closeSequence, required this.closed, required this.parentReturn, required this.parentSession, required this.requestId, required this.slack, required this.status});

  final String actionId;
  final bool changed;
  final RaviJson childSession;
  final int closeSequence;
  final bool closed;
  final RaviJson parentReturn;
  final RaviJson parentSession;
  final String requestId;
  final RaviJson slack;
  final String status;

  factory SessionsCloseThreadReturn.fromJson(Map<String, Object?> json) {
    return SessionsCloseThreadReturn(
      actionId: raviJsonAsString(json["actionId"]),
      changed: raviJsonAsBool(json["changed"]),
      childSession: RaviJson.from(json["childSession"]),
      closeSequence: raviJsonAsInt(json["closeSequence"]),
      closed: raviJsonAsBool(json["closed"]),
      parentReturn: RaviJson.from(json["parentReturn"]),
      parentSession: RaviJson.from(json["parentSession"]),
      requestId: raviJsonAsString(json["requestId"]),
      slack: RaviJson.from(json["slack"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SessionsCloseThreadReturn fromJsonValue(Object? json) {
    return SessionsCloseThreadReturn.fromJson(raviJsonObject(json, "SessionsCloseThreadReturn"));
  }
}

SessionsCloseThreadReturn sessionsCloseThreadReturnFromJson(Object? json) => SessionsCloseThreadReturn.fromJsonValue(json);

class SessionsCreateThreadOptions {
  const SessionsCreateThreadOptions({this.model, this.session});

  final String? model;
  final String? session;

  void encodeBody(Map<String, RaviJson> into) {
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
  }
}

class SessionsCreateThreadReturn {
  const SessionsCreateThreadReturn({required this.actionId, required this.child, required this.executionMode, required this.idempotencyKey, required this.initiatorSession, this.nextAttemptAt, required this.parentSession, required this.publishPending, required this.publishedNow, required this.queued, required this.requestId, required this.slack, required this.status});

  final String actionId;
  final RaviJson child;
  final String executionMode;
  final String idempotencyKey;
  final RaviJson initiatorSession;
  final double? nextAttemptAt;
  final RaviJson parentSession;
  final bool publishPending;
  final bool publishedNow;
  final bool queued;
  final String requestId;
  final RaviJson slack;
  final String status;

  factory SessionsCreateThreadReturn.fromJson(Map<String, Object?> json) {
    return SessionsCreateThreadReturn(
      actionId: raviJsonAsString(json["actionId"]),
      child: RaviJson.from(json["child"]),
      executionMode: raviJsonAsString(json["executionMode"]),
      idempotencyKey: raviJsonAsString(json["idempotencyKey"]),
      initiatorSession: RaviJson.from(json["initiatorSession"]),
      nextAttemptAt: json["nextAttemptAt"] == null ? null : raviJsonAsDouble(json["nextAttemptAt"]),
      parentSession: RaviJson.from(json["parentSession"]),
      publishPending: raviJsonAsBool(json["publishPending"]),
      publishedNow: raviJsonAsBool(json["publishedNow"]),
      queued: raviJsonAsBool(json["queued"]),
      requestId: raviJsonAsString(json["requestId"]),
      slack: RaviJson.from(json["slack"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SessionsCreateThreadReturn fromJsonValue(Object? json) {
    return SessionsCreateThreadReturn.fromJson(raviJsonObject(json, "SessionsCreateThreadReturn"));
  }
}

SessionsCreateThreadReturn sessionsCreateThreadReturnFromJson(Object? json) => SessionsCreateThreadReturn.fromJsonValue(json);

class SessionsDeleteOptions {
  const SessionsDeleteOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef SessionsDeleteReturn = Map<String, RaviJson>;

SessionsDeleteReturn sessionsDeleteReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsDeleteMessageOptions {
  const SessionsDeleteMessageOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef SessionsDeleteMessageReturn = Map<String, RaviJson>;

SessionsDeleteMessageReturn sessionsDeleteMessageReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsDetachOptions {
  const SessionsDetachOptions({this.chat});

  final String? chat;

  void encodeBody(Map<String, RaviJson> into) {
    if (chat != null) {
      into["chat"] = RaviJson.from(chat);
    }
  }
}

typedef SessionsDetachReturn = Map<String, RaviJson>;

SessionsDetachReturn sessionsDetachReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsEditMessageOptions {
  const SessionsEditMessageOptions({this.execute, this.text});

  final bool? execute;
  final String? text;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (text != null) {
      into["text"] = RaviJson.from(text);
    }
  }
}

typedef SessionsEditMessageReturn = Map<String, RaviJson>;

SessionsEditMessageReturn sessionsEditMessageReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsExecuteOptions {
  const SessionsExecuteOptions({this.barrier, this.channel, this.immediate, this.steer, this.to});

  final String? barrier;
  final String? channel;
  final bool? immediate;
  final bool? steer;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (barrier != null) {
      into["barrier"] = RaviJson.from(barrier);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (immediate != null) {
      into["immediate"] = RaviJson.from(immediate);
    }
    if (steer != null) {
      into["steer"] = RaviJson.from(steer);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

typedef SessionsExecuteReturn = Map<String, RaviJson>;

SessionsExecuteReturn sessionsExecuteReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef SessionsExtendReturn = Map<String, RaviJson>;

SessionsExtendReturn sessionsExtendReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsFollowupsAddOptions {
  const SessionsFollowupsAddOptions({this.at, this.barrier, this.cron, this.description, this.disabled, this.every, this.message, this.owner, this.step, this.targetChat, this.targetList, this.targetSession, this.timezone});

  final String? at;
  final String? barrier;
  final String? cron;
  final String? description;
  final bool? disabled;
  final String? every;
  final String? message;
  final String? owner;
  final List<String>? step;
  final String? targetChat;
  final String? targetList;
  final String? targetSession;
  final String? timezone;

  void encodeBody(Map<String, RaviJson> into) {
    if (at != null) {
      into["at"] = RaviJson.from(at);
    }
    if (barrier != null) {
      into["barrier"] = RaviJson.from(barrier);
    }
    if (cron != null) {
      into["cron"] = RaviJson.from(cron);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (disabled != null) {
      into["disabled"] = RaviJson.from(disabled);
    }
    if (every != null) {
      into["every"] = RaviJson.from(every);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (step != null) {
      into["step"] = RaviJson.from(step);
    }
    if (targetChat != null) {
      into["targetChat"] = RaviJson.from(targetChat);
    }
    if (targetList != null) {
      into["targetList"] = RaviJson.from(targetList);
    }
    if (targetSession != null) {
      into["targetSession"] = RaviJson.from(targetSession);
    }
    if (timezone != null) {
      into["timezone"] = RaviJson.from(timezone);
    }
  }
}

typedef SessionsFollowupsAddReturn = Map<String, RaviJson>;

SessionsFollowupsAddReturn sessionsFollowupsAddReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsFollowupsInspectOptions {
  const SessionsFollowupsInspectOptions({this.runs});

  final String? runs;

  void encodeBody(Map<String, RaviJson> into) {
    if (runs != null) {
      into["runs"] = RaviJson.from(runs);
    }
  }
}

typedef SessionsFollowupsInspectReturn = Map<String, RaviJson>;

SessionsFollowupsInspectReturn sessionsFollowupsInspectReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsFollowupsListOptions {
  const SessionsFollowupsListOptions({this.includeDisabled, this.limit, this.offset, this.targetType});

  final bool? includeDisabled;
  final String? limit;
  final String? offset;
  final String? targetType;

  void encodeBody(Map<String, RaviJson> into) {
    if (includeDisabled != null) {
      into["includeDisabled"] = RaviJson.from(includeDisabled);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (targetType != null) {
      into["targetType"] = RaviJson.from(targetType);
    }
  }
}

class SessionsFollowupsListReturn {
  const SessionsFollowupsListReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory SessionsFollowupsListReturn.fromJson(Map<String, Object?> json) {
    return SessionsFollowupsListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SessionsFollowupsListReturn fromJsonValue(Object? json) {
    return SessionsFollowupsListReturn.fromJson(raviJsonObject(json, "SessionsFollowupsListReturn"));
  }
}

SessionsFollowupsListReturn sessionsFollowupsListReturnFromJson(Object? json) => SessionsFollowupsListReturn.fromJsonValue(json);

typedef SessionsFollowupsPauseReturn = Map<String, RaviJson>;

SessionsFollowupsPauseReturn sessionsFollowupsPauseReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef SessionsFollowupsResumeReturn = Map<String, RaviJson>;

SessionsFollowupsResumeReturn sessionsFollowupsResumeReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsFollowupsRetryOptions {
  const SessionsFollowupsRetryOptions({this.cadence});

  final String? cadence;

  void encodeBody(Map<String, RaviJson> into) {
    if (cadence != null) {
      into["cadence"] = RaviJson.from(cadence);
    }
  }
}

typedef SessionsFollowupsRetryReturn = Map<String, RaviJson>;

SessionsFollowupsRetryReturn sessionsFollowupsRetryReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef SessionsFollowupsRunReturn = Map<String, RaviJson>;

SessionsFollowupsRunReturn sessionsFollowupsRunReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsFollowupsRunsOptions {
  const SessionsFollowupsRunsOptions({this.cadence, this.limit, this.offset, this.status});

  final String? cadence;
  final String? limit;
  final String? offset;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (cadence != null) {
      into["cadence"] = RaviJson.from(cadence);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class SessionsFollowupsRunsReturn {
  const SessionsFollowupsRunsReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory SessionsFollowupsRunsReturn.fromJson(Map<String, Object?> json) {
    return SessionsFollowupsRunsReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SessionsFollowupsRunsReturn fromJsonValue(Object? json) {
    return SessionsFollowupsRunsReturn.fromJson(raviJsonObject(json, "SessionsFollowupsRunsReturn"));
  }
}

SessionsFollowupsRunsReturn sessionsFollowupsRunsReturnFromJson(Object? json) => SessionsFollowupsRunsReturn.fromJsonValue(json);

class SessionsFollowupsSnoozeOptions {
  const SessionsFollowupsSnoozeOptions({this.until});

  final String? until;

  void encodeBody(Map<String, RaviJson> into) {
    if (until != null) {
      into["until"] = RaviJson.from(until);
    }
  }
}

typedef SessionsFollowupsSnoozeReturn = Map<String, RaviJson>;

SessionsFollowupsSnoozeReturn sessionsFollowupsSnoozeReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsFollowupsUpdateOptions {
  const SessionsFollowupsUpdateOptions({this.barrier, this.description, this.message, this.name, this.recalculateNext, this.step});

  final String? barrier;
  final String? description;
  final String? message;
  final String? name;
  final bool? recalculateNext;
  final List<String>? step;

  void encodeBody(Map<String, RaviJson> into) {
    if (barrier != null) {
      into["barrier"] = RaviJson.from(barrier);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (recalculateNext != null) {
      into["recalculateNext"] = RaviJson.from(recalculateNext);
    }
    if (step != null) {
      into["step"] = RaviJson.from(step);
    }
  }
}

class SessionsFollowupsUpdateReturn {
  const SessionsFollowupsUpdateReturn({required this.followup});

  final RaviJson followup;

  factory SessionsFollowupsUpdateReturn.fromJson(Map<String, Object?> json) {
    return SessionsFollowupsUpdateReturn(
      followup: RaviJson.from(json["followup"]),
    );
  }

  static SessionsFollowupsUpdateReturn fromJsonValue(Object? json) {
    return SessionsFollowupsUpdateReturn.fromJson(raviJsonObject(json, "SessionsFollowupsUpdateReturn"));
  }
}

SessionsFollowupsUpdateReturn sessionsFollowupsUpdateReturnFromJson(Object? json) => SessionsFollowupsUpdateReturn.fromJsonValue(json);

class SessionsGoalOptions {
  const SessionsGoalOptions({this.budget, this.project, this.reason, this.seconds, this.task, this.tokens});

  final String? budget;
  final String? project;
  final String? reason;
  final String? seconds;
  final String? task;
  final String? tokens;

  void encodeBody(Map<String, RaviJson> into) {
    if (budget != null) {
      into["budget"] = RaviJson.from(budget);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
    if (seconds != null) {
      into["seconds"] = RaviJson.from(seconds);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
    if (tokens != null) {
      into["tokens"] = RaviJson.from(tokens);
    }
  }
}

class SessionsGoalReturn {
  const SessionsGoalReturn({required this.action, required this.changed, required this.goal, required this.session});

  final String action;
  final bool changed;
  final RaviJson goal;
  final RaviJson session;

  factory SessionsGoalReturn.fromJson(Map<String, Object?> json) {
    return SessionsGoalReturn(
      action: raviJsonAsString(json["action"]),
      changed: raviJsonAsBool(json["changed"]),
      goal: RaviJson.from(json["goal"]),
      session: RaviJson.from(json["session"]),
    );
  }

  static SessionsGoalReturn fromJsonValue(Object? json) {
    return SessionsGoalReturn.fromJson(raviJsonObject(json, "SessionsGoalReturn"));
  }
}

SessionsGoalReturn sessionsGoalReturnFromJson(Object? json) => SessionsGoalReturn.fromJsonValue(json);

typedef SessionsInfoReturn = Map<String, RaviJson>;

SessionsInfoReturn sessionsInfoReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsInformOptions {
  const SessionsInformOptions({this.barrier, this.channel, this.immediate, this.steer, this.to});

  final String? barrier;
  final String? channel;
  final bool? immediate;
  final bool? steer;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (barrier != null) {
      into["barrier"] = RaviJson.from(barrier);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (immediate != null) {
      into["immediate"] = RaviJson.from(immediate);
    }
    if (steer != null) {
      into["steer"] = RaviJson.from(steer);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

typedef SessionsInformReturn = Map<String, RaviJson>;

SessionsInformReturn sessionsInformReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef SessionsKeepReturn = Map<String, RaviJson>;

SessionsKeepReturn sessionsKeepReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsListOptions {
  const SessionsListOptions({this.agent, this.ephemeral, this.fields, this.limit, this.live, this.offset, this.tag});

  final String? agent;
  final bool? ephemeral;
  final String? fields;
  final String? limit;
  final bool? live;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (ephemeral != null) {
      into["ephemeral"] = RaviJson.from(ephemeral);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (live != null) {
      into["live"] = RaviJson.from(live);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class SessionsListReturn {
  const SessionsListReturn({required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory SessionsListReturn.fromJson(Map<String, Object?> json) {
    return SessionsListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SessionsListReturn fromJsonValue(Object? json) {
    return SessionsListReturn.fromJson(raviJsonObject(json, "SessionsListReturn"));
  }
}

SessionsListReturn sessionsListReturnFromJson(Object? json) => SessionsListReturn.fromJsonValue(json);

class SessionsPruneOptions {
  const SessionsPruneOptions({this.agent, this.ephemeral, this.execute, this.inactiveFor, this.namePrefix});

  final String? agent;
  final bool? ephemeral;
  final bool? execute;
  final String? inactiveFor;
  final String? namePrefix;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (ephemeral != null) {
      into["ephemeral"] = RaviJson.from(ephemeral);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (inactiveFor != null) {
      into["inactiveFor"] = RaviJson.from(inactiveFor);
    }
    if (namePrefix != null) {
      into["namePrefix"] = RaviJson.from(namePrefix);
    }
  }
}

typedef SessionsPruneReturn = Map<String, RaviJson>;

SessionsPruneReturn sessionsPruneReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsReadOptions {
  const SessionsReadOptions({this.count, this.messageId, this.visibility, this.workspace});

  final String? count;
  final String? messageId;
  final bool? visibility;
  final bool? workspace;

  void encodeBody(Map<String, RaviJson> into) {
    if (count != null) {
      into["count"] = RaviJson.from(count);
    }
    if (messageId != null) {
      into["messageId"] = RaviJson.from(messageId);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
    if (workspace != null) {
      into["workspace"] = RaviJson.from(workspace);
    }
  }
}

typedef SessionsReadReturn = RaviJson;

SessionsReadReturn sessionsReadReturnFromJson(Object? json) => RaviJson.from(json);

class SessionsRecapOptions {
  const SessionsRecapOptions({this.count});

  final String? count;

  void encodeBody(Map<String, RaviJson> into) {
    if (count != null) {
      into["count"] = RaviJson.from(count);
    }
  }
}

class SessionsRecapReturn {
  const SessionsRecapReturn({required this.computed, required this.decisions, required this.goal, required this.openLoops, required this.persisted, required this.pinned, required this.recent, required this.schemaVersion, required this.session, required this.sources, required this.summary});

  final bool computed;
  final List<String> decisions;
  final RaviJson goal;
  final List<String> openLoops;
  final bool persisted;
  final List<String> pinned;
  final RaviJson recent;
  final int schemaVersion;
  final RaviJson session;
  final RaviJson sources;
  final RaviJson summary;

  factory SessionsRecapReturn.fromJson(Map<String, Object?> json) {
    return SessionsRecapReturn(
      computed: raviJsonAsBool(json["computed"]),
      decisions: raviJsonAsList(json["decisions"], raviJsonAsString),
      goal: RaviJson.from(json["goal"]),
      openLoops: raviJsonAsList(json["openLoops"], raviJsonAsString),
      persisted: raviJsonAsBool(json["persisted"]),
      pinned: raviJsonAsList(json["pinned"], raviJsonAsString),
      recent: RaviJson.from(json["recent"]),
      schemaVersion: raviJsonAsInt(json["schemaVersion"]),
      session: RaviJson.from(json["session"]),
      sources: RaviJson.from(json["sources"]),
      summary: RaviJson.from(json["summary"]),
    );
  }

  static SessionsRecapReturn fromJsonValue(Object? json) {
    return SessionsRecapReturn.fromJson(raviJsonObject(json, "SessionsRecapReturn"));
  }
}

SessionsRecapReturn sessionsRecapReturnFromJson(Object? json) => SessionsRecapReturn.fromJsonValue(json);

typedef SessionsRenameReturn = Map<String, RaviJson>;

SessionsRenameReturn sessionsRenameReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsResetOptions {
  const SessionsResetOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef SessionsResetReturn = Map<String, RaviJson>;

SessionsResetReturn sessionsResetReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsRuntimeFollowUpOptions {
  const SessionsRuntimeFollowUpOptions({this.execute, this.expectedTurn, this.thread, this.turn});

  final bool? execute;
  final String? expectedTurn;
  final String? thread;
  final String? turn;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (expectedTurn != null) {
      into["expectedTurn"] = RaviJson.from(expectedTurn);
    }
    if (thread != null) {
      into["thread"] = RaviJson.from(thread);
    }
    if (turn != null) {
      into["turn"] = RaviJson.from(turn);
    }
  }
}

class SessionsRuntimeFollowUpReturn {
  const SessionsRuntimeFollowUpReturn({this.data, this.error, required this.ok, this.operation});

  final RaviJson? data;
  final String? error;
  final bool ok;
  final String? operation;

  factory SessionsRuntimeFollowUpReturn.fromJson(Map<String, Object?> json) {
    return SessionsRuntimeFollowUpReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      error: json["error"] == null ? null : raviJsonAsString(json["error"]),
      ok: raviJsonAsBool(json["ok"]),
      operation: json["operation"] == null ? null : raviJsonAsString(json["operation"]),
    );
  }

  static SessionsRuntimeFollowUpReturn fromJsonValue(Object? json) {
    return SessionsRuntimeFollowUpReturn.fromJson(raviJsonObject(json, "SessionsRuntimeFollowUpReturn"));
  }
}

SessionsRuntimeFollowUpReturn sessionsRuntimeFollowUpReturnFromJson(Object? json) => SessionsRuntimeFollowUpReturn.fromJsonValue(json);

class SessionsRuntimeForkOptions {
  const SessionsRuntimeForkOptions({this.cwd, this.execute, this.path});

  final String? cwd;
  final bool? execute;
  final String? path;

  void encodeBody(Map<String, RaviJson> into) {
    if (cwd != null) {
      into["cwd"] = RaviJson.from(cwd);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (path != null) {
      into["path"] = RaviJson.from(path);
    }
  }
}

class SessionsRuntimeForkReturn {
  const SessionsRuntimeForkReturn({this.data, this.error, required this.ok, this.operation});

  final RaviJson? data;
  final String? error;
  final bool ok;
  final String? operation;

  factory SessionsRuntimeForkReturn.fromJson(Map<String, Object?> json) {
    return SessionsRuntimeForkReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      error: json["error"] == null ? null : raviJsonAsString(json["error"]),
      ok: raviJsonAsBool(json["ok"]),
      operation: json["operation"] == null ? null : raviJsonAsString(json["operation"]),
    );
  }

  static SessionsRuntimeForkReturn fromJsonValue(Object? json) {
    return SessionsRuntimeForkReturn.fromJson(raviJsonObject(json, "SessionsRuntimeForkReturn"));
  }
}

SessionsRuntimeForkReturn sessionsRuntimeForkReturnFromJson(Object? json) => SessionsRuntimeForkReturn.fromJsonValue(json);

class SessionsRuntimeInterruptOptions {
  const SessionsRuntimeInterruptOptions({this.thread, this.turn});

  final String? thread;
  final String? turn;

  void encodeBody(Map<String, RaviJson> into) {
    if (thread != null) {
      into["thread"] = RaviJson.from(thread);
    }
    if (turn != null) {
      into["turn"] = RaviJson.from(turn);
    }
  }
}

class SessionsRuntimeInterruptReturn {
  const SessionsRuntimeInterruptReturn({this.data, this.error, required this.ok, this.operation});

  final RaviJson? data;
  final String? error;
  final bool ok;
  final String? operation;

  factory SessionsRuntimeInterruptReturn.fromJson(Map<String, Object?> json) {
    return SessionsRuntimeInterruptReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      error: json["error"] == null ? null : raviJsonAsString(json["error"]),
      ok: raviJsonAsBool(json["ok"]),
      operation: json["operation"] == null ? null : raviJsonAsString(json["operation"]),
    );
  }

  static SessionsRuntimeInterruptReturn fromJsonValue(Object? json) {
    return SessionsRuntimeInterruptReturn.fromJson(raviJsonObject(json, "SessionsRuntimeInterruptReturn"));
  }
}

SessionsRuntimeInterruptReturn sessionsRuntimeInterruptReturnFromJson(Object? json) => SessionsRuntimeInterruptReturn.fromJsonValue(json);

class SessionsRuntimeListOptions {
  const SessionsRuntimeListOptions({this.archived, this.cursor, this.cwd, this.limit, this.search});

  final bool? archived;
  final String? cursor;
  final String? cwd;
  final String? limit;
  final String? search;

  void encodeBody(Map<String, RaviJson> into) {
    if (archived != null) {
      into["archived"] = RaviJson.from(archived);
    }
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (cwd != null) {
      into["cwd"] = RaviJson.from(cwd);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (search != null) {
      into["search"] = RaviJson.from(search);
    }
  }
}

class SessionsRuntimeListReturn {
  const SessionsRuntimeListReturn({this.data, this.error, required this.ok, this.operation});

  final RaviJson? data;
  final String? error;
  final bool ok;
  final String? operation;

  factory SessionsRuntimeListReturn.fromJson(Map<String, Object?> json) {
    return SessionsRuntimeListReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      error: json["error"] == null ? null : raviJsonAsString(json["error"]),
      ok: raviJsonAsBool(json["ok"]),
      operation: json["operation"] == null ? null : raviJsonAsString(json["operation"]),
    );
  }

  static SessionsRuntimeListReturn fromJsonValue(Object? json) {
    return SessionsRuntimeListReturn.fromJson(raviJsonObject(json, "SessionsRuntimeListReturn"));
  }
}

SessionsRuntimeListReturn sessionsRuntimeListReturnFromJson(Object? json) => SessionsRuntimeListReturn.fromJsonValue(json);

class SessionsRuntimeReadOptions {
  const SessionsRuntimeReadOptions({this.summaryOnly});

  final bool? summaryOnly;

  void encodeBody(Map<String, RaviJson> into) {
    if (summaryOnly != null) {
      into["summaryOnly"] = RaviJson.from(summaryOnly);
    }
  }
}

class SessionsRuntimeReadReturn {
  const SessionsRuntimeReadReturn({this.data, this.error, required this.ok, this.operation});

  final RaviJson? data;
  final String? error;
  final bool ok;
  final String? operation;

  factory SessionsRuntimeReadReturn.fromJson(Map<String, Object?> json) {
    return SessionsRuntimeReadReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      error: json["error"] == null ? null : raviJsonAsString(json["error"]),
      ok: raviJsonAsBool(json["ok"]),
      operation: json["operation"] == null ? null : raviJsonAsString(json["operation"]),
    );
  }

  static SessionsRuntimeReadReturn fromJsonValue(Object? json) {
    return SessionsRuntimeReadReturn.fromJson(raviJsonObject(json, "SessionsRuntimeReadReturn"));
  }
}

SessionsRuntimeReadReturn sessionsRuntimeReadReturnFromJson(Object? json) => SessionsRuntimeReadReturn.fromJsonValue(json);

class SessionsRuntimeRollbackOptions {
  const SessionsRuntimeRollbackOptions({this.execute, this.thread});

  final bool? execute;
  final String? thread;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (thread != null) {
      into["thread"] = RaviJson.from(thread);
    }
  }
}

class SessionsRuntimeRollbackReturn {
  const SessionsRuntimeRollbackReturn({this.data, this.error, required this.ok, this.operation});

  final RaviJson? data;
  final String? error;
  final bool ok;
  final String? operation;

  factory SessionsRuntimeRollbackReturn.fromJson(Map<String, Object?> json) {
    return SessionsRuntimeRollbackReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      error: json["error"] == null ? null : raviJsonAsString(json["error"]),
      ok: raviJsonAsBool(json["ok"]),
      operation: json["operation"] == null ? null : raviJsonAsString(json["operation"]),
    );
  }

  static SessionsRuntimeRollbackReturn fromJsonValue(Object? json) {
    return SessionsRuntimeRollbackReturn.fromJson(raviJsonObject(json, "SessionsRuntimeRollbackReturn"));
  }
}

SessionsRuntimeRollbackReturn sessionsRuntimeRollbackReturnFromJson(Object? json) => SessionsRuntimeRollbackReturn.fromJsonValue(json);

class SessionsRuntimeSteerOptions {
  const SessionsRuntimeSteerOptions({this.expectedTurn, this.thread, this.turn});

  final String? expectedTurn;
  final String? thread;
  final String? turn;

  void encodeBody(Map<String, RaviJson> into) {
    if (expectedTurn != null) {
      into["expectedTurn"] = RaviJson.from(expectedTurn);
    }
    if (thread != null) {
      into["thread"] = RaviJson.from(thread);
    }
    if (turn != null) {
      into["turn"] = RaviJson.from(turn);
    }
  }
}

class SessionsRuntimeSteerReturn {
  const SessionsRuntimeSteerReturn({this.data, this.error, required this.ok, this.operation});

  final RaviJson? data;
  final String? error;
  final bool ok;
  final String? operation;

  factory SessionsRuntimeSteerReturn.fromJson(Map<String, Object?> json) {
    return SessionsRuntimeSteerReturn(
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      error: json["error"] == null ? null : raviJsonAsString(json["error"]),
      ok: raviJsonAsBool(json["ok"]),
      operation: json["operation"] == null ? null : raviJsonAsString(json["operation"]),
    );
  }

  static SessionsRuntimeSteerReturn fromJsonValue(Object? json) {
    return SessionsRuntimeSteerReturn.fromJson(raviJsonObject(json, "SessionsRuntimeSteerReturn"));
  }
}

SessionsRuntimeSteerReturn sessionsRuntimeSteerReturnFromJson(Object? json) => SessionsRuntimeSteerReturn.fromJsonValue(json);

class SessionsSendOptions {
  const SessionsSendOptions({this.agent, this.barrier, this.channel, this.effort, this.immediate, this.interactive, this.raw, this.steer, this.thread, this.threadOwner, this.threadScope, this.threadSummary, this.threadTitle, this.to, this.wait});

  final String? agent;
  final String? barrier;
  final String? channel;
  final String? effort;
  final bool? immediate;
  final bool? interactive;
  final bool? raw;
  final bool? steer;
  final String? thread;
  final String? threadOwner;
  final String? threadScope;
  final String? threadSummary;
  final String? threadTitle;
  final String? to;
  final bool? wait;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (barrier != null) {
      into["barrier"] = RaviJson.from(barrier);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (effort != null) {
      into["effort"] = RaviJson.from(effort);
    }
    if (immediate != null) {
      into["immediate"] = RaviJson.from(immediate);
    }
    if (interactive != null) {
      into["interactive"] = RaviJson.from(interactive);
    }
    if (raw != null) {
      into["raw"] = RaviJson.from(raw);
    }
    if (steer != null) {
      into["steer"] = RaviJson.from(steer);
    }
    if (thread != null) {
      into["thread"] = RaviJson.from(thread);
    }
    if (threadOwner != null) {
      into["threadOwner"] = RaviJson.from(threadOwner);
    }
    if (threadScope != null) {
      into["threadScope"] = RaviJson.from(threadScope);
    }
    if (threadSummary != null) {
      into["threadSummary"] = RaviJson.from(threadSummary);
    }
    if (threadTitle != null) {
      into["threadTitle"] = RaviJson.from(threadTitle);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
    if (wait != null) {
      into["wait"] = RaviJson.from(wait);
    }
  }
}

class SessionsSendReturn {
  const SessionsSendReturn({required this.action, required this.createdSession, required this.delivery, required this.mode, required this.promptLength, required this.published, this.response, required this.session, required this.thread});

  final String action;
  final bool createdSession;
  final Map<String, RaviJson> delivery;
  final String mode;
  final int promptLength;
  final bool published;
  final RaviJson? response;
  final RaviJson session;
  final RaviJson thread;

  factory SessionsSendReturn.fromJson(Map<String, Object?> json) {
    return SessionsSendReturn(
      action: raviJsonAsString(json["action"]),
      createdSession: raviJsonAsBool(json["createdSession"]),
      delivery: raviJsonAsRaviJsonMap(json["delivery"]),
      mode: raviJsonAsString(json["mode"]),
      promptLength: raviJsonAsInt(json["promptLength"]),
      published: raviJsonAsBool(json["published"]),
      response: json["response"] == null ? null : RaviJson.from(json["response"]),
      session: RaviJson.from(json["session"]),
      thread: RaviJson.from(json["thread"]),
    );
  }

  static SessionsSendReturn fromJsonValue(Object? json) {
    return SessionsSendReturn.fromJson(raviJsonObject(json, "SessionsSendReturn"));
  }
}

SessionsSendReturn sessionsSendReturnFromJson(Object? json) => SessionsSendReturn.fromJsonValue(json);

typedef SessionsSetDisplayReturn = Map<String, RaviJson>;

SessionsSetDisplayReturn sessionsSetDisplayReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsSetEffortReturn {
  const SessionsSetEffortReturn({required this.action, required this.after, required this.appliesOn, required this.before, required this.changed, required this.effectiveEffort, required this.effectiveEffortSource, required this.effortOverride, required this.sessionKey, required this.sessionName});

  final String action;
  final RaviJson after;
  final String appliesOn;
  final RaviJson before;
  final bool changed;
  final String effectiveEffort;
  final String effectiveEffortSource;
  final RaviJson effortOverride;
  final String sessionKey;
  final RaviJson sessionName;

  factory SessionsSetEffortReturn.fromJson(Map<String, Object?> json) {
    return SessionsSetEffortReturn(
      action: raviJsonAsString(json["action"]),
      after: RaviJson.from(json["after"]),
      appliesOn: raviJsonAsString(json["appliesOn"]),
      before: RaviJson.from(json["before"]),
      changed: raviJsonAsBool(json["changed"]),
      effectiveEffort: raviJsonAsString(json["effectiveEffort"]),
      effectiveEffortSource: raviJsonAsString(json["effectiveEffortSource"]),
      effortOverride: RaviJson.from(json["effortOverride"]),
      sessionKey: raviJsonAsString(json["sessionKey"]),
      sessionName: RaviJson.from(json["sessionName"]),
    );
  }

  static SessionsSetEffortReturn fromJsonValue(Object? json) {
    return SessionsSetEffortReturn.fromJson(raviJsonObject(json, "SessionsSetEffortReturn"));
  }
}

SessionsSetEffortReturn sessionsSetEffortReturnFromJson(Object? json) => SessionsSetEffortReturn.fromJsonValue(json);

typedef SessionsSetModelReturn = Map<String, RaviJson>;

SessionsSetModelReturn sessionsSetModelReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsSetProviderReturn {
  const SessionsSetProviderReturn({required this.action, required this.after, required this.appliesOn, required this.before, required this.changed, required this.effectiveProvider, required this.providerSource, required this.runtimeProviderOverride, required this.sessionKey, required this.sessionName});

  final String action;
  final RaviJson after;
  final String appliesOn;
  final RaviJson before;
  final bool changed;
  final String effectiveProvider;
  final String providerSource;
  final RaviJson runtimeProviderOverride;
  final String sessionKey;
  final RaviJson sessionName;

  factory SessionsSetProviderReturn.fromJson(Map<String, Object?> json) {
    return SessionsSetProviderReturn(
      action: raviJsonAsString(json["action"]),
      after: RaviJson.from(json["after"]),
      appliesOn: raviJsonAsString(json["appliesOn"]),
      before: RaviJson.from(json["before"]),
      changed: raviJsonAsBool(json["changed"]),
      effectiveProvider: raviJsonAsString(json["effectiveProvider"]),
      providerSource: raviJsonAsString(json["providerSource"]),
      runtimeProviderOverride: RaviJson.from(json["runtimeProviderOverride"]),
      sessionKey: raviJsonAsString(json["sessionKey"]),
      sessionName: RaviJson.from(json["sessionName"]),
    );
  }

  static SessionsSetProviderReturn fromJsonValue(Object? json) {
    return SessionsSetProviderReturn.fromJson(raviJsonObject(json, "SessionsSetProviderReturn"));
  }
}

SessionsSetProviderReturn sessionsSetProviderReturnFromJson(Object? json) => SessionsSetProviderReturn.fromJsonValue(json);

typedef SessionsSetThinkingReturn = Map<String, RaviJson>;

SessionsSetThinkingReturn sessionsSetThinkingReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef SessionsSetTtlReturn = Map<String, RaviJson>;

SessionsSetTtlReturn sessionsSetTtlReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef SessionsSubscriptionsReturn = Map<String, RaviJson>;

SessionsSubscriptionsReturn sessionsSubscriptionsReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SessionsTraceOptions {
  const SessionsTraceOptions({this.correlation, this.explain, this.includeStream, this.limit, this.message, this.only, this.raw, this.run, this.showSystemPrompt, this.showUserPrompt, this.since, this.turn, this.until});

  final String? correlation;
  final bool? explain;
  final bool? includeStream;
  final String? limit;
  final String? message;
  final String? only;
  final bool? raw;
  final String? run;
  final bool? showSystemPrompt;
  final bool? showUserPrompt;
  final String? since;
  final String? turn;
  final String? until;

  void encodeBody(Map<String, RaviJson> into) {
    if (correlation != null) {
      into["correlation"] = RaviJson.from(correlation);
    }
    if (explain != null) {
      into["explain"] = RaviJson.from(explain);
    }
    if (includeStream != null) {
      into["includeStream"] = RaviJson.from(includeStream);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (only != null) {
      into["only"] = RaviJson.from(only);
    }
    if (raw != null) {
      into["raw"] = RaviJson.from(raw);
    }
    if (run != null) {
      into["run"] = RaviJson.from(run);
    }
    if (showSystemPrompt != null) {
      into["showSystemPrompt"] = RaviJson.from(showSystemPrompt);
    }
    if (showUserPrompt != null) {
      into["showUserPrompt"] = RaviJson.from(showUserPrompt);
    }
    if (since != null) {
      into["since"] = RaviJson.from(since);
    }
    if (turn != null) {
      into["turn"] = RaviJson.from(turn);
    }
    if (until != null) {
      into["until"] = RaviJson.from(until);
    }
  }
}

typedef SessionsTraceReturn = Map<String, RaviJson>;

SessionsTraceReturn sessionsTraceReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

typedef SessionsVisibilityReturn = Map<String, RaviJson>;

SessionsVisibilityReturn sessionsVisibilityReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class SettingsDeleteOptions {
  const SettingsDeleteOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SettingsDeleteReturn {
  const SettingsDeleteReturn({required this.changedCount, required this.setting, required this.status, required this.target});

  final double changedCount;
  final RaviJson setting;
  final String status;
  final RaviJson target;

  factory SettingsDeleteReturn.fromJson(Map<String, Object?> json) {
    return SettingsDeleteReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      setting: RaviJson.from(json["setting"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static SettingsDeleteReturn fromJsonValue(Object? json) {
    return SettingsDeleteReturn.fromJson(raviJsonObject(json, "SettingsDeleteReturn"));
  }
}

SettingsDeleteReturn settingsDeleteReturnFromJson(Object? json) => SettingsDeleteReturn.fromJsonValue(json);

class SettingsGetReturn {
  const SettingsGetReturn({required this.setting});

  final RaviJson setting;

  factory SettingsGetReturn.fromJson(Map<String, Object?> json) {
    return SettingsGetReturn(
      setting: RaviJson.from(json["setting"]),
    );
  }

  static SettingsGetReturn fromJsonValue(Object? json) {
    return SettingsGetReturn.fromJson(raviJsonObject(json, "SettingsGetReturn"));
  }
}

SettingsGetReturn settingsGetReturnFromJson(Object? json) => SettingsGetReturn.fromJsonValue(json);

class SettingsListOptions {
  const SettingsListOptions({this.fields, this.legacy, this.limit, this.offset});

  final String? fields;
  final bool? legacy;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (legacy != null) {
      into["legacy"] = RaviJson.from(legacy);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class SettingsListReturn {
  const SettingsListReturn({required this.customSettings, required this.items, required this.knownSettings, required this.legacySettings, required this.pagination, required this.showLegacy, required this.total});

  final List<RaviJson> customSettings;
  final List<RaviJson> items;
  final List<RaviJson> knownSettings;
  final RaviJson legacySettings;
  final RaviJson pagination;
  final bool showLegacy;
  final double total;

  factory SettingsListReturn.fromJson(Map<String, Object?> json) {
    return SettingsListReturn(
      customSettings: raviJsonAsList(json["customSettings"], RaviJson.from),
      items: raviJsonAsList(json["items"], RaviJson.from),
      knownSettings: raviJsonAsList(json["knownSettings"], RaviJson.from),
      legacySettings: RaviJson.from(json["legacySettings"]),
      pagination: RaviJson.from(json["pagination"]),
      showLegacy: raviJsonAsBool(json["showLegacy"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SettingsListReturn fromJsonValue(Object? json) {
    return SettingsListReturn.fromJson(raviJsonObject(json, "SettingsListReturn"));
  }
}

SettingsListReturn settingsListReturnFromJson(Object? json) => SettingsListReturn.fromJsonValue(json);

class SettingsSetReturn {
  const SettingsSetReturn({required this.changedCount, required this.setting, required this.status, required this.target});

  final double changedCount;
  final RaviJson setting;
  final String status;
  final RaviJson target;

  factory SettingsSetReturn.fromJson(Map<String, Object?> json) {
    return SettingsSetReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      setting: RaviJson.from(json["setting"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static SettingsSetReturn fromJsonValue(Object? json) {
    return SettingsSetReturn.fromJson(raviJsonObject(json, "SettingsSetReturn"));
  }
}

SettingsSetReturn settingsSetReturnFromJson(Object? json) => SettingsSetReturn.fromJsonValue(json);

class SkillGatesDisableReturn {
  const SkillGatesDisableReturn({required this.rule, required this.success});

  final RaviJson rule;
  final bool success;

  factory SkillGatesDisableReturn.fromJson(Map<String, Object?> json) {
    return SkillGatesDisableReturn(
      rule: RaviJson.from(json["rule"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static SkillGatesDisableReturn fromJsonValue(Object? json) {
    return SkillGatesDisableReturn.fromJson(raviJsonObject(json, "SkillGatesDisableReturn"));
  }
}

SkillGatesDisableReturn skillGatesDisableReturnFromJson(Object? json) => SkillGatesDisableReturn.fromJsonValue(json);

class SkillGatesEnableReturn {
  const SkillGatesEnableReturn({required this.rule, required this.success});

  final RaviJson rule;
  final bool success;

  factory SkillGatesEnableReturn.fromJson(Map<String, Object?> json) {
    return SkillGatesEnableReturn(
      rule: RaviJson.from(json["rule"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static SkillGatesEnableReturn fromJsonValue(Object? json) {
    return SkillGatesEnableReturn.fromJson(raviJsonObject(json, "SkillGatesEnableReturn"));
  }
}

SkillGatesEnableReturn skillGatesEnableReturnFromJson(Object? json) => SkillGatesEnableReturn.fromJsonValue(json);

class SkillGatesListOptions {
  const SkillGatesListOptions({this.fields, this.limit, this.offset, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class SkillGatesListReturn {
  const SkillGatesListReturn({required this.configuredTotal, this.filters, required this.items, required this.pagination, required this.rules, required this.total});

  final double configuredTotal;
  final Map<String, RaviJson>? filters;
  final List<RaviJson> items;
  final RaviJson pagination;
  final List<RaviJson> rules;
  final double total;

  factory SkillGatesListReturn.fromJson(Map<String, Object?> json) {
    return SkillGatesListReturn(
      configuredTotal: raviJsonAsDouble(json["configuredTotal"]),
      filters: json["filters"] == null ? null : raviJsonAsRaviJsonMap(json["filters"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      rules: raviJsonAsList(json["rules"], RaviJson.from),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SkillGatesListReturn fromJsonValue(Object? json) {
    return SkillGatesListReturn.fromJson(raviJsonObject(json, "SkillGatesListReturn"));
  }
}

SkillGatesListReturn skillGatesListReturnFromJson(Object? json) => SkillGatesListReturn.fromJsonValue(json);

class SkillGatesResetOptions {
  const SkillGatesResetOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SkillGatesResetReturn {
  const SkillGatesResetReturn({required this.deleted, required this.success});

  final bool deleted;
  final bool success;

  factory SkillGatesResetReturn.fromJson(Map<String, Object?> json) {
    return SkillGatesResetReturn(
      deleted: raviJsonAsBool(json["deleted"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static SkillGatesResetReturn fromJsonValue(Object? json) {
    return SkillGatesResetReturn.fromJson(raviJsonObject(json, "SkillGatesResetReturn"));
  }
}

SkillGatesResetReturn skillGatesResetReturnFromJson(Object? json) => SkillGatesResetReturn.fromJsonValue(json);

class SkillGatesRmOptions {
  const SkillGatesRmOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SkillGatesRmReturn {
  const SkillGatesRmReturn({required this.action, this.deleted, this.rule, required this.success});

  final String action;
  final bool? deleted;
  final RaviJson? rule;
  final bool success;

  factory SkillGatesRmReturn.fromJson(Map<String, Object?> json) {
    return SkillGatesRmReturn(
      action: raviJsonAsString(json["action"]),
      deleted: json["deleted"] == null ? null : raviJsonAsBool(json["deleted"]),
      rule: json["rule"] == null ? null : RaviJson.from(json["rule"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static SkillGatesRmReturn fromJsonValue(Object? json) {
    return SkillGatesRmReturn.fromJson(raviJsonObject(json, "SkillGatesRmReturn"));
  }
}

SkillGatesRmReturn skillGatesRmReturnFromJson(Object? json) => SkillGatesRmReturn.fromJsonValue(json);

class SkillGatesSetOptions {
  const SkillGatesSetOptions({this.command, this.commandPrefix, this.commandRegex, this.groupRegex, this.pattern, this.tool, this.toolPrefix, this.toolRegex});

  final String? command;
  final String? commandPrefix;
  final String? commandRegex;
  final String? groupRegex;
  final String? pattern;
  final String? tool;
  final String? toolPrefix;
  final String? toolRegex;

  void encodeBody(Map<String, RaviJson> into) {
    if (command != null) {
      into["command"] = RaviJson.from(command);
    }
    if (commandPrefix != null) {
      into["commandPrefix"] = RaviJson.from(commandPrefix);
    }
    if (commandRegex != null) {
      into["commandRegex"] = RaviJson.from(commandRegex);
    }
    if (groupRegex != null) {
      into["groupRegex"] = RaviJson.from(groupRegex);
    }
    if (pattern != null) {
      into["pattern"] = RaviJson.from(pattern);
    }
    if (tool != null) {
      into["tool"] = RaviJson.from(tool);
    }
    if (toolPrefix != null) {
      into["toolPrefix"] = RaviJson.from(toolPrefix);
    }
    if (toolRegex != null) {
      into["toolRegex"] = RaviJson.from(toolRegex);
    }
  }
}

class SkillGatesSetReturn {
  const SkillGatesSetReturn({required this.rule, required this.success});

  final RaviJson rule;
  final bool success;

  factory SkillGatesSetReturn.fromJson(Map<String, Object?> json) {
    return SkillGatesSetReturn(
      rule: RaviJson.from(json["rule"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static SkillGatesSetReturn fromJsonValue(Object? json) {
    return SkillGatesSetReturn.fromJson(raviJsonObject(json, "SkillGatesSetReturn"));
  }
}

SkillGatesSetReturn skillGatesSetReturnFromJson(Object? json) => SkillGatesSetReturn.fromJsonValue(json);

class SkillGatesShowReturn {
  const SkillGatesShowReturn({required this.rule});

  final RaviJson rule;

  factory SkillGatesShowReturn.fromJson(Map<String, Object?> json) {
    return SkillGatesShowReturn(
      rule: RaviJson.from(json["rule"]),
    );
  }

  static SkillGatesShowReturn fromJsonValue(Object? json) {
    return SkillGatesShowReturn.fromJson(raviJsonObject(json, "SkillGatesShowReturn"));
  }
}

SkillGatesShowReturn skillGatesShowReturnFromJson(Object? json) => SkillGatesShowReturn.fromJsonValue(json);

class SkillsGrantOptions {
  const SkillsGrantOptions({this.note});

  final String? note;

  void encodeBody(Map<String, RaviJson> into) {
    if (note != null) {
      into["note"] = RaviJson.from(note);
    }
  }
}

class SkillsGrantReturn {
  const SkillsGrantReturn({required this.agentId, this.grant, required this.skillName, required this.success});

  final String agentId;
  final RaviJson? grant;
  final String skillName;
  final bool success;

  factory SkillsGrantReturn.fromJson(Map<String, Object?> json) {
    return SkillsGrantReturn(
      agentId: raviJsonAsString(json["agentId"]),
      grant: json["grant"] == null ? null : RaviJson.from(json["grant"]),
      skillName: raviJsonAsString(json["skillName"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static SkillsGrantReturn fromJsonValue(Object? json) {
    return SkillsGrantReturn.fromJson(raviJsonObject(json, "SkillsGrantReturn"));
  }
}

SkillsGrantReturn skillsGrantReturnFromJson(Object? json) => SkillsGrantReturn.fromJsonValue(json);

class SkillsGrantBatchOptions {
  const SkillsGrantBatchOptions({this.agent, this.allAgents, this.allSkills, this.dryRun, this.note, this.skill});

  final String? agent;
  final bool? allAgents;
  final bool? allSkills;
  final bool? dryRun;
  final String? note;
  final String? skill;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (allAgents != null) {
      into["allAgents"] = RaviJson.from(allAgents);
    }
    if (allSkills != null) {
      into["allSkills"] = RaviJson.from(allSkills);
    }
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
    if (note != null) {
      into["note"] = RaviJson.from(note);
    }
    if (skill != null) {
      into["skill"] = RaviJson.from(skill);
    }
  }
}

class SkillsGrantBatchReturn {
  const SkillsGrantBatchReturn({required this.agentsTargeted, required this.dryRun, required this.errors, required this.op, required this.pairsAffected, required this.pairsSkipped, required this.sampleAgents, required this.sampleSkills, required this.skillsTargeted});

  final double agentsTargeted;
  final bool dryRun;
  final List<RaviJson> errors;
  final String op;
  final double pairsAffected;
  final double pairsSkipped;
  final List<String> sampleAgents;
  final List<String> sampleSkills;
  final double skillsTargeted;

  factory SkillsGrantBatchReturn.fromJson(Map<String, Object?> json) {
    return SkillsGrantBatchReturn(
      agentsTargeted: raviJsonAsDouble(json["agentsTargeted"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      errors: raviJsonAsList(json["errors"], RaviJson.from),
      op: raviJsonAsString(json["op"]),
      pairsAffected: raviJsonAsDouble(json["pairsAffected"]),
      pairsSkipped: raviJsonAsDouble(json["pairsSkipped"]),
      sampleAgents: raviJsonAsList(json["sampleAgents"], raviJsonAsString),
      sampleSkills: raviJsonAsList(json["sampleSkills"], raviJsonAsString),
      skillsTargeted: raviJsonAsDouble(json["skillsTargeted"]),
    );
  }

  static SkillsGrantBatchReturn fromJsonValue(Object? json) {
    return SkillsGrantBatchReturn.fromJson(raviJsonObject(json, "SkillsGrantBatchReturn"));
  }
}

SkillsGrantBatchReturn skillsGrantBatchReturnFromJson(Object? json) => SkillsGrantBatchReturn.fromJsonValue(json);

class SkillsInspectReturn {
  const SkillsInspectReturn({required this.agentId, required this.allowlist, required this.hasConfiguration, required this.provenance});

  final String agentId;
  final List<String> allowlist;
  final bool hasConfiguration;
  final RaviJson provenance;

  factory SkillsInspectReturn.fromJson(Map<String, Object?> json) {
    return SkillsInspectReturn(
      agentId: raviJsonAsString(json["agentId"]),
      allowlist: raviJsonAsList(json["allowlist"], raviJsonAsString),
      hasConfiguration: raviJsonAsBool(json["hasConfiguration"]),
      provenance: RaviJson.from(json["provenance"]),
    );
  }

  static SkillsInspectReturn fromJsonValue(Object? json) {
    return SkillsInspectReturn.fromJson(raviJsonObject(json, "SkillsInspectReturn"));
  }
}

SkillsInspectReturn skillsInspectReturnFromJson(Object? json) => SkillsInspectReturn.fromJsonValue(json);

class SkillsInstallOptions {
  const SkillsInstallOptions({this.all, this.execute, this.overwrite, this.plugin, this.skill, this.skipCodexSync, this.source});

  final bool? all;
  final bool? execute;
  final bool? overwrite;
  final String? plugin;
  final String? skill;
  final bool? skipCodexSync;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (all != null) {
      into["all"] = RaviJson.from(all);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (overwrite != null) {
      into["overwrite"] = RaviJson.from(overwrite);
    }
    if (plugin != null) {
      into["plugin"] = RaviJson.from(plugin);
    }
    if (skill != null) {
      into["skill"] = RaviJson.from(skill);
    }
    if (skipCodexSync != null) {
      into["skipCodexSync"] = RaviJson.from(skipCodexSync);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class SkillsInstallReturn {
  const SkillsInstallReturn({required this.codexSynced, required this.installed, required this.source, required this.success});

  final List<String> codexSynced;
  final List<RaviJson> installed;
  final String source;
  final bool success;

  factory SkillsInstallReturn.fromJson(Map<String, Object?> json) {
    return SkillsInstallReturn(
      codexSynced: raviJsonAsList(json["codexSynced"], raviJsonAsString),
      installed: raviJsonAsList(json["installed"], RaviJson.from),
      source: raviJsonAsString(json["source"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static SkillsInstallReturn fromJsonValue(Object? json) {
    return SkillsInstallReturn.fromJson(raviJsonObject(json, "SkillsInstallReturn"));
  }
}

SkillsInstallReturn skillsInstallReturnFromJson(Object? json) => SkillsInstallReturn.fromJsonValue(json);

class SkillsListOptions {
  const SkillsListOptions({this.codex, this.fields, this.installed, this.limit, this.offset, this.source, this.tag});

  final bool? codex;
  final String? fields;
  final bool? installed;
  final String? limit;
  final String? offset;
  final String? source;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (codex != null) {
      into["codex"] = RaviJson.from(codex);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (installed != null) {
      into["installed"] = RaviJson.from(installed);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class SkillsListReturn {
  const SkillsListReturn({required this.items, required this.pagination, required this.skills, required this.source, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<RaviJson> skills;
  final String source;
  final double total;

  factory SkillsListReturn.fromJson(Map<String, Object?> json) {
    return SkillsListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      skills: raviJsonAsList(json["skills"], RaviJson.from),
      source: raviJsonAsString(json["source"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SkillsListReturn fromJsonValue(Object? json) {
    return SkillsListReturn.fromJson(raviJsonObject(json, "SkillsListReturn"));
  }
}

SkillsListReturn skillsListReturnFromJson(Object? json) => SkillsListReturn.fromJsonValue(json);

class SkillsRevokeReturn {
  const SkillsRevokeReturn({required this.agentId, this.grant, required this.skillName, required this.success});

  final String agentId;
  final RaviJson? grant;
  final String skillName;
  final bool success;

  factory SkillsRevokeReturn.fromJson(Map<String, Object?> json) {
    return SkillsRevokeReturn(
      agentId: raviJsonAsString(json["agentId"]),
      grant: json["grant"] == null ? null : RaviJson.from(json["grant"]),
      skillName: raviJsonAsString(json["skillName"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static SkillsRevokeReturn fromJsonValue(Object? json) {
    return SkillsRevokeReturn.fromJson(raviJsonObject(json, "SkillsRevokeReturn"));
  }
}

SkillsRevokeReturn skillsRevokeReturnFromJson(Object? json) => SkillsRevokeReturn.fromJsonValue(json);

class SkillsRevokeBatchOptions {
  const SkillsRevokeBatchOptions({this.agent, this.allAgents, this.allSkills, this.dryRun, this.skill});

  final String? agent;
  final bool? allAgents;
  final bool? allSkills;
  final bool? dryRun;
  final String? skill;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (allAgents != null) {
      into["allAgents"] = RaviJson.from(allAgents);
    }
    if (allSkills != null) {
      into["allSkills"] = RaviJson.from(allSkills);
    }
    if (dryRun != null) {
      into["dryRun"] = RaviJson.from(dryRun);
    }
    if (skill != null) {
      into["skill"] = RaviJson.from(skill);
    }
  }
}

class SkillsRevokeBatchReturn {
  const SkillsRevokeBatchReturn({required this.agentsTargeted, required this.dryRun, required this.errors, required this.op, required this.pairsAffected, required this.pairsSkipped, required this.sampleAgents, required this.sampleSkills, required this.skillsTargeted});

  final double agentsTargeted;
  final bool dryRun;
  final List<RaviJson> errors;
  final String op;
  final double pairsAffected;
  final double pairsSkipped;
  final List<String> sampleAgents;
  final List<String> sampleSkills;
  final double skillsTargeted;

  factory SkillsRevokeBatchReturn.fromJson(Map<String, Object?> json) {
    return SkillsRevokeBatchReturn(
      agentsTargeted: raviJsonAsDouble(json["agentsTargeted"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      errors: raviJsonAsList(json["errors"], RaviJson.from),
      op: raviJsonAsString(json["op"]),
      pairsAffected: raviJsonAsDouble(json["pairsAffected"]),
      pairsSkipped: raviJsonAsDouble(json["pairsSkipped"]),
      sampleAgents: raviJsonAsList(json["sampleAgents"], raviJsonAsString),
      sampleSkills: raviJsonAsList(json["sampleSkills"], raviJsonAsString),
      skillsTargeted: raviJsonAsDouble(json["skillsTargeted"]),
    );
  }

  static SkillsRevokeBatchReturn fromJsonValue(Object? json) {
    return SkillsRevokeBatchReturn.fromJson(raviJsonObject(json, "SkillsRevokeBatchReturn"));
  }
}

SkillsRevokeBatchReturn skillsRevokeBatchReturnFromJson(Object? json) => SkillsRevokeBatchReturn.fromJsonValue(json);

class SkillsShowOptions {
  const SkillsShowOptions({this.installed, this.source});

  final bool? installed;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (installed != null) {
      into["installed"] = RaviJson.from(installed);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class SkillsShowReturn {
  const SkillsShowReturn({required this.skill});

  final RaviJson skill;

  factory SkillsShowReturn.fromJson(Map<String, Object?> json) {
    return SkillsShowReturn(
      skill: RaviJson.from(json["skill"]),
    );
  }

  static SkillsShowReturn fromJsonValue(Object? json) {
    return SkillsShowReturn.fromJson(raviJsonObject(json, "SkillsShowReturn"));
  }
}

SkillsShowReturn skillsShowReturnFromJson(Object? json) => SkillsShowReturn.fromJsonValue(json);

class SkillsSyncReturn {
  const SkillsSyncReturn({required this.codexSynced, required this.success, required this.total});

  final List<String> codexSynced;
  final bool success;
  final double total;

  factory SkillsSyncReturn.fromJson(Map<String, Object?> json) {
    return SkillsSyncReturn(
      codexSynced: raviJsonAsList(json["codexSynced"], raviJsonAsString),
      success: raviJsonAsBool(json["success"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SkillsSyncReturn fromJsonValue(Object? json) {
    return SkillsSyncReturn.fromJson(raviJsonObject(json, "SkillsSyncReturn"));
  }
}

SkillsSyncReturn skillsSyncReturnFromJson(Object? json) => SkillsSyncReturn.fromJsonValue(json);

class SkillsWhoOptions {
  const SkillsWhoOptions({this.agent, this.fields});

  final String? agent;
  final String? fields;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
  }
}

class SkillsWhoReturn {
  const SkillsWhoReturn({required this.grants, this.skillName, required this.total});

  final List<RaviJson> grants;
  final String? skillName;
  final double total;

  factory SkillsWhoReturn.fromJson(Map<String, Object?> json) {
    return SkillsWhoReturn(
      grants: raviJsonAsList(json["grants"], RaviJson.from),
      skillName: json["skillName"] == null ? null : raviJsonAsString(json["skillName"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SkillsWhoReturn fromJsonValue(Object? json) {
    return SkillsWhoReturn.fromJson(raviJsonObject(json, "SkillsWhoReturn"));
  }
}

SkillsWhoReturn skillsWhoReturnFromJson(Object? json) => SkillsWhoReturn.fromJsonValue(json);

class SlackBlocksSendOptions {
  const SlackBlocksSendOptions({this.connection, this.ephemeralUser, this.execute, this.text, this.threadTs});

  final String? connection;
  final String? ephemeralUser;
  final bool? execute;
  final String? text;
  final String? threadTs;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (ephemeralUser != null) {
      into["ephemeralUser"] = RaviJson.from(ephemeralUser);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (text != null) {
      into["text"] = RaviJson.from(text);
    }
    if (threadTs != null) {
      into["threadTs"] = RaviJson.from(threadTs);
    }
  }
}

class SlackBlocksSendReturn {
  const SlackBlocksSendReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackBlocksSendReturn.fromJson(Map<String, Object?> json) {
    return SlackBlocksSendReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackBlocksSendReturn fromJsonValue(Object? json) {
    return SlackBlocksSendReturn.fromJson(raviJsonObject(json, "SlackBlocksSendReturn"));
  }
}

SlackBlocksSendReturn slackBlocksSendReturnFromJson(Object? json) => SlackBlocksSendReturn.fromJsonValue(json);

class SlackBlocksShowcaseOptions {
  const SlackBlocksShowcaseOptions({this.execute, this.threadTs});

  final bool? execute;
  final String? threadTs;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (threadTs != null) {
      into["threadTs"] = RaviJson.from(threadTs);
    }
  }
}

class SlackBlocksShowcaseReturn {
  const SlackBlocksShowcaseReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackBlocksShowcaseReturn.fromJson(Map<String, Object?> json) {
    return SlackBlocksShowcaseReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackBlocksShowcaseReturn fromJsonValue(Object? json) {
    return SlackBlocksShowcaseReturn.fromJson(raviJsonObject(json, "SlackBlocksShowcaseReturn"));
  }
}

SlackBlocksShowcaseReturn slackBlocksShowcaseReturnFromJson(Object? json) => SlackBlocksShowcaseReturn.fromJsonValue(json);

class SlackBlocksUpdateOptions {
  const SlackBlocksUpdateOptions({this.execute, this.text});

  final bool? execute;
  final String? text;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (text != null) {
      into["text"] = RaviJson.from(text);
    }
  }
}

class SlackBlocksUpdateReturn {
  const SlackBlocksUpdateReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackBlocksUpdateReturn.fromJson(Map<String, Object?> json) {
    return SlackBlocksUpdateReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackBlocksUpdateReturn fromJsonValue(Object? json) {
    return SlackBlocksUpdateReturn.fromJson(raviJsonObject(json, "SlackBlocksUpdateReturn"));
  }
}

SlackBlocksUpdateReturn slackBlocksUpdateReturnFromJson(Object? json) => SlackBlocksUpdateReturn.fromJsonValue(json);

class SlackBlocksValidateOptions {
  const SlackBlocksValidateOptions({this.channel, this.target});

  final String? channel;
  final String? target;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (target != null) {
      into["target"] = RaviJson.from(target);
    }
  }
}

class SlackBlocksValidateReturn {
  const SlackBlocksValidateReturn({required this.connection, this.item, required this.ok, required this.provider, this.raw, required this.source});

  final String connection;
  final RaviJson? item;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final String source;

  factory SlackBlocksValidateReturn.fromJson(Map<String, Object?> json) {
    return SlackBlocksValidateReturn(
      connection: raviJsonAsString(json["connection"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackBlocksValidateReturn fromJsonValue(Object? json) {
    return SlackBlocksValidateReturn.fromJson(raviJsonObject(json, "SlackBlocksValidateReturn"));
  }
}

SlackBlocksValidateReturn slackBlocksValidateReturnFromJson(Object? json) => SlackBlocksValidateReturn.fromJsonValue(json);

class SlackCanvasAccessDeleteOptions {
  const SlackCanvasAccessDeleteOptions({this.channel, this.channels, this.execute, this.users});

  final String? channel;
  final String? channels;
  final bool? execute;
  final String? users;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (channels != null) {
      into["channels"] = RaviJson.from(channels);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (users != null) {
      into["users"] = RaviJson.from(users);
    }
  }
}

class SlackCanvasAccessDeleteReturn {
  const SlackCanvasAccessDeleteReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackCanvasAccessDeleteReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasAccessDeleteReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasAccessDeleteReturn fromJsonValue(Object? json) {
    return SlackCanvasAccessDeleteReturn.fromJson(raviJsonObject(json, "SlackCanvasAccessDeleteReturn"));
  }
}

SlackCanvasAccessDeleteReturn slackCanvasAccessDeleteReturnFromJson(Object? json) => SlackCanvasAccessDeleteReturn.fromJsonValue(json);

class SlackCanvasAccessSetOptions {
  const SlackCanvasAccessSetOptions({this.channel, this.channels, this.execute, this.users});

  final String? channel;
  final String? channels;
  final bool? execute;
  final String? users;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (channels != null) {
      into["channels"] = RaviJson.from(channels);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (users != null) {
      into["users"] = RaviJson.from(users);
    }
  }
}

class SlackCanvasAccessSetReturn {
  const SlackCanvasAccessSetReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackCanvasAccessSetReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasAccessSetReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasAccessSetReturn fromJsonValue(Object? json) {
    return SlackCanvasAccessSetReturn.fromJson(raviJsonObject(json, "SlackCanvasAccessSetReturn"));
  }
}

SlackCanvasAccessSetReturn slackCanvasAccessSetReturnFromJson(Object? json) => SlackCanvasAccessSetReturn.fromJsonValue(json);

class SlackCanvasArtifactPublishOptions {
  const SlackCanvasArtifactPublishOptions({this.canvas, this.channel, this.execute, this.skipRefresh, this.slackChannel, this.title});

  final String? canvas;
  final String? channel;
  final bool? execute;
  final bool? skipRefresh;
  final String? slackChannel;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (canvas != null) {
      into["canvas"] = RaviJson.from(canvas);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (skipRefresh != null) {
      into["skipRefresh"] = RaviJson.from(skipRefresh);
    }
    if (slackChannel != null) {
      into["slackChannel"] = RaviJson.from(slackChannel);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class SlackCanvasArtifactPublishReturn {
  const SlackCanvasArtifactPublishReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackCanvasArtifactPublishReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasArtifactPublishReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasArtifactPublishReturn fromJsonValue(Object? json) {
    return SlackCanvasArtifactPublishReturn.fromJson(raviJsonObject(json, "SlackCanvasArtifactPublishReturn"));
  }
}

SlackCanvasArtifactPublishReturn slackCanvasArtifactPublishReturnFromJson(Object? json) => SlackCanvasArtifactPublishReturn.fromJsonValue(json);

class SlackCanvasArtifactStatusReturn {
  const SlackCanvasArtifactStatusReturn({required this.item, required this.ok, required this.provider});

  final Map<String, RaviJson> item;
  final bool ok;
  final String provider;

  factory SlackCanvasArtifactStatusReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasArtifactStatusReturn(
      item: raviJsonAsRaviJsonMap(json["item"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
    );
  }

  static SlackCanvasArtifactStatusReturn fromJsonValue(Object? json) {
    return SlackCanvasArtifactStatusReturn.fromJson(raviJsonObject(json, "SlackCanvasArtifactStatusReturn"));
  }
}

SlackCanvasArtifactStatusReturn slackCanvasArtifactStatusReturnFromJson(Object? json) => SlackCanvasArtifactStatusReturn.fromJsonValue(json);

class SlackCanvasChannelCreateOptions {
  const SlackCanvasChannelCreateOptions({this.artifact, this.ensure, this.execute, this.markdown, this.markdownFile, this.skipRefresh, this.title});

  final String? artifact;
  final bool? ensure;
  final bool? execute;
  final String? markdown;
  final String? markdownFile;
  final bool? skipRefresh;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (artifact != null) {
      into["artifact"] = RaviJson.from(artifact);
    }
    if (ensure != null) {
      into["ensure"] = RaviJson.from(ensure);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (markdown != null) {
      into["markdown"] = RaviJson.from(markdown);
    }
    if (markdownFile != null) {
      into["markdownFile"] = RaviJson.from(markdownFile);
    }
    if (skipRefresh != null) {
      into["skipRefresh"] = RaviJson.from(skipRefresh);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class SlackCanvasChannelCreateReturn {
  const SlackCanvasChannelCreateReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackCanvasChannelCreateReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasChannelCreateReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasChannelCreateReturn fromJsonValue(Object? json) {
    return SlackCanvasChannelCreateReturn.fromJson(raviJsonObject(json, "SlackCanvasChannelCreateReturn"));
  }
}

SlackCanvasChannelCreateReturn slackCanvasChannelCreateReturnFromJson(Object? json) => SlackCanvasChannelCreateReturn.fromJsonValue(json);

class SlackCanvasChannelShowcaseOptions {
  const SlackCanvasChannelShowcaseOptions({this.execute, this.title});

  final bool? execute;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class SlackCanvasChannelShowcaseReturn {
  const SlackCanvasChannelShowcaseReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackCanvasChannelShowcaseReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasChannelShowcaseReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasChannelShowcaseReturn fromJsonValue(Object? json) {
    return SlackCanvasChannelShowcaseReturn.fromJson(raviJsonObject(json, "SlackCanvasChannelShowcaseReturn"));
  }
}

SlackCanvasChannelShowcaseReturn slackCanvasChannelShowcaseReturnFromJson(Object? json) => SlackCanvasChannelShowcaseReturn.fromJsonValue(json);

class SlackCanvasCreateOptions {
  const SlackCanvasCreateOptions({this.artifact, this.channel, this.execute, this.markdown, this.markdownFile, this.skipRefresh, this.slackChannel, this.title});

  final String? artifact;
  final String? channel;
  final bool? execute;
  final String? markdown;
  final String? markdownFile;
  final bool? skipRefresh;
  final String? slackChannel;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (artifact != null) {
      into["artifact"] = RaviJson.from(artifact);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (markdown != null) {
      into["markdown"] = RaviJson.from(markdown);
    }
    if (markdownFile != null) {
      into["markdownFile"] = RaviJson.from(markdownFile);
    }
    if (skipRefresh != null) {
      into["skipRefresh"] = RaviJson.from(skipRefresh);
    }
    if (slackChannel != null) {
      into["slackChannel"] = RaviJson.from(slackChannel);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class SlackCanvasCreateReturn {
  const SlackCanvasCreateReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackCanvasCreateReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasCreateReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasCreateReturn fromJsonValue(Object? json) {
    return SlackCanvasCreateReturn.fromJson(raviJsonObject(json, "SlackCanvasCreateReturn"));
  }
}

SlackCanvasCreateReturn slackCanvasCreateReturnFromJson(Object? json) => SlackCanvasCreateReturn.fromJsonValue(json);

class SlackCanvasDeleteOptions {
  const SlackCanvasDeleteOptions({this.channel, this.execute});

  final String? channel;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SlackCanvasDeleteReturn {
  const SlackCanvasDeleteReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackCanvasDeleteReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasDeleteReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasDeleteReturn fromJsonValue(Object? json) {
    return SlackCanvasDeleteReturn.fromJson(raviJsonObject(json, "SlackCanvasDeleteReturn"));
  }
}

SlackCanvasDeleteReturn slackCanvasDeleteReturnFromJson(Object? json) => SlackCanvasDeleteReturn.fromJsonValue(json);

class SlackCanvasEditOptions {
  const SlackCanvasEditOptions({this.artifact, this.channel, this.execute, this.markdown, this.markdownFile, this.sectionId, this.skipRefresh, this.title});

  final String? artifact;
  final String? channel;
  final bool? execute;
  final String? markdown;
  final String? markdownFile;
  final String? sectionId;
  final bool? skipRefresh;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (artifact != null) {
      into["artifact"] = RaviJson.from(artifact);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (markdown != null) {
      into["markdown"] = RaviJson.from(markdown);
    }
    if (markdownFile != null) {
      into["markdownFile"] = RaviJson.from(markdownFile);
    }
    if (sectionId != null) {
      into["sectionId"] = RaviJson.from(sectionId);
    }
    if (skipRefresh != null) {
      into["skipRefresh"] = RaviJson.from(skipRefresh);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class SlackCanvasEditReturn {
  const SlackCanvasEditReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackCanvasEditReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasEditReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasEditReturn fromJsonValue(Object? json) {
    return SlackCanvasEditReturn.fromJson(raviJsonObject(json, "SlackCanvasEditReturn"));
  }
}

SlackCanvasEditReturn slackCanvasEditReturnFromJson(Object? json) => SlackCanvasEditReturn.fromJsonValue(json);

class SlackCanvasSectionsLookupOptions {
  const SlackCanvasSectionsLookupOptions({this.channel, this.containsText, this.fields, this.sectionTypes});

  final String? channel;
  final String? containsText;
  final String? fields;
  final String? sectionTypes;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (containsText != null) {
      into["containsText"] = RaviJson.from(containsText);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (sectionTypes != null) {
      into["sectionTypes"] = RaviJson.from(sectionTypes);
    }
  }
}

class SlackCanvasSectionsLookupReturn {
  const SlackCanvasSectionsLookupReturn({required this.connection, required this.items, required this.ok, required this.pagination, required this.provider, this.raw, required this.source});

  final String connection;
  final List<RaviJson> items;
  final bool ok;
  final RaviJson pagination;
  final String provider;
  final Map<String, RaviJson>? raw;
  final String source;

  factory SlackCanvasSectionsLookupReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasSectionsLookupReturn(
      connection: raviJsonAsString(json["connection"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      ok: raviJsonAsBool(json["ok"]),
      pagination: RaviJson.from(json["pagination"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasSectionsLookupReturn fromJsonValue(Object? json) {
    return SlackCanvasSectionsLookupReturn.fromJson(raviJsonObject(json, "SlackCanvasSectionsLookupReturn"));
  }
}

SlackCanvasSectionsLookupReturn slackCanvasSectionsLookupReturnFromJson(Object? json) => SlackCanvasSectionsLookupReturn.fromJsonValue(json);

class SlackCanvasShowcaseOptions {
  const SlackCanvasShowcaseOptions({this.channel, this.execute, this.slackChannel, this.title});

  final String? channel;
  final bool? execute;
  final String? slackChannel;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (slackChannel != null) {
      into["slackChannel"] = RaviJson.from(slackChannel);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class SlackCanvasShowcaseReturn {
  const SlackCanvasShowcaseReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackCanvasShowcaseReturn.fromJson(Map<String, Object?> json) {
    return SlackCanvasShowcaseReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackCanvasShowcaseReturn fromJsonValue(Object? json) {
    return SlackCanvasShowcaseReturn.fromJson(raviJsonObject(json, "SlackCanvasShowcaseReturn"));
  }
}

SlackCanvasShowcaseReturn slackCanvasShowcaseReturnFromJson(Object? json) => SlackCanvasShowcaseReturn.fromJsonValue(json);

class SlackChannelsCreateOptions {
  const SlackChannelsCreateOptions({this.channel, this.execute, this.private});

  final String? channel;
  final bool? execute;
  final bool? private;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (private != null) {
      into["private"] = RaviJson.from(private);
    }
  }
}

class SlackChannelsCreateReturn {
  const SlackChannelsCreateReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackChannelsCreateReturn.fromJson(Map<String, Object?> json) {
    return SlackChannelsCreateReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackChannelsCreateReturn fromJsonValue(Object? json) {
    return SlackChannelsCreateReturn.fromJson(raviJsonObject(json, "SlackChannelsCreateReturn"));
  }
}

SlackChannelsCreateReturn slackChannelsCreateReturnFromJson(Object? json) => SlackChannelsCreateReturn.fromJsonValue(json);

class SlackChannelsHistoryOptions {
  const SlackChannelsHistoryOptions({this.cursor, this.fields, this.inclusive, this.latest, this.limit, this.oldest});

  final String? cursor;
  final String? fields;
  final bool? inclusive;
  final String? latest;
  final String? limit;
  final String? oldest;

  void encodeBody(Map<String, RaviJson> into) {
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (inclusive != null) {
      into["inclusive"] = RaviJson.from(inclusive);
    }
    if (latest != null) {
      into["latest"] = RaviJson.from(latest);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (oldest != null) {
      into["oldest"] = RaviJson.from(oldest);
    }
  }
}

class SlackChannelsHistoryReturn {
  const SlackChannelsHistoryReturn({required this.connection, required this.items, required this.ok, required this.pagination, required this.provider, this.raw, required this.source});

  final String connection;
  final List<RaviJson> items;
  final bool ok;
  final RaviJson pagination;
  final String provider;
  final Map<String, RaviJson>? raw;
  final String source;

  factory SlackChannelsHistoryReturn.fromJson(Map<String, Object?> json) {
    return SlackChannelsHistoryReturn(
      connection: raviJsonAsString(json["connection"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      ok: raviJsonAsBool(json["ok"]),
      pagination: RaviJson.from(json["pagination"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackChannelsHistoryReturn fromJsonValue(Object? json) {
    return SlackChannelsHistoryReturn.fromJson(raviJsonObject(json, "SlackChannelsHistoryReturn"));
  }
}

SlackChannelsHistoryReturn slackChannelsHistoryReturnFromJson(Object? json) => SlackChannelsHistoryReturn.fromJsonValue(json);

class SlackChannelsInfoReturn {
  const SlackChannelsInfoReturn({required this.connection, this.item, required this.ok, required this.provider, this.raw, required this.source});

  final String connection;
  final RaviJson? item;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final String source;

  factory SlackChannelsInfoReturn.fromJson(Map<String, Object?> json) {
    return SlackChannelsInfoReturn(
      connection: raviJsonAsString(json["connection"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackChannelsInfoReturn fromJsonValue(Object? json) {
    return SlackChannelsInfoReturn.fromJson(raviJsonObject(json, "SlackChannelsInfoReturn"));
  }
}

SlackChannelsInfoReturn slackChannelsInfoReturnFromJson(Object? json) => SlackChannelsInfoReturn.fromJsonValue(json);

class SlackChannelsInviteOptions {
  const SlackChannelsInviteOptions({this.connection, this.execute});

  final String? connection;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SlackChannelsInviteReturn {
  const SlackChannelsInviteReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackChannelsInviteReturn.fromJson(Map<String, Object?> json) {
    return SlackChannelsInviteReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackChannelsInviteReturn fromJsonValue(Object? json) {
    return SlackChannelsInviteReturn.fromJson(raviJsonObject(json, "SlackChannelsInviteReturn"));
  }
}

SlackChannelsInviteReturn slackChannelsInviteReturnFromJson(Object? json) => SlackChannelsInviteReturn.fromJsonValue(json);

class SlackChannelsListOptions {
  const SlackChannelsListOptions({this.channel, this.cursor, this.fields, this.includeArchived, this.limit, this.types});

  final String? channel;
  final String? cursor;
  final String? fields;
  final bool? includeArchived;
  final String? limit;
  final String? types;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (includeArchived != null) {
      into["includeArchived"] = RaviJson.from(includeArchived);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (types != null) {
      into["types"] = RaviJson.from(types);
    }
  }
}

class SlackChannelsListReturn {
  const SlackChannelsListReturn({required this.connection, required this.items, required this.ok, required this.pagination, required this.provider, this.raw, required this.source});

  final String connection;
  final List<RaviJson> items;
  final bool ok;
  final RaviJson pagination;
  final String provider;
  final Map<String, RaviJson>? raw;
  final String source;

  factory SlackChannelsListReturn.fromJson(Map<String, Object?> json) {
    return SlackChannelsListReturn(
      connection: raviJsonAsString(json["connection"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      ok: raviJsonAsBool(json["ok"]),
      pagination: RaviJson.from(json["pagination"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackChannelsListReturn fromJsonValue(Object? json) {
    return SlackChannelsListReturn.fromJson(raviJsonObject(json, "SlackChannelsListReturn"));
  }
}

SlackChannelsListReturn slackChannelsListReturnFromJson(Object? json) => SlackChannelsListReturn.fromJsonValue(json);

class SlackChannelsRenameOptions {
  const SlackChannelsRenameOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SlackChannelsRenameReturn {
  const SlackChannelsRenameReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackChannelsRenameReturn.fromJson(Map<String, Object?> json) {
    return SlackChannelsRenameReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackChannelsRenameReturn fromJsonValue(Object? json) {
    return SlackChannelsRenameReturn.fromJson(raviJsonObject(json, "SlackChannelsRenameReturn"));
  }
}

SlackChannelsRenameReturn slackChannelsRenameReturnFromJson(Object? json) => SlackChannelsRenameReturn.fromJsonValue(json);

class SlackFilesListOptions {
  const SlackFilesListOptions({this.channel, this.cursor, this.fields, this.limit, this.slackChannel, this.user});

  final String? channel;
  final String? cursor;
  final String? fields;
  final String? limit;
  final String? slackChannel;
  final String? user;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (slackChannel != null) {
      into["slackChannel"] = RaviJson.from(slackChannel);
    }
    if (user != null) {
      into["user"] = RaviJson.from(user);
    }
  }
}

class SlackFilesListReturn {
  const SlackFilesListReturn({required this.connection, required this.items, required this.ok, required this.pagination, required this.provider, this.raw, required this.source});

  final String connection;
  final List<RaviJson> items;
  final bool ok;
  final RaviJson pagination;
  final String provider;
  final Map<String, RaviJson>? raw;
  final String source;

  factory SlackFilesListReturn.fromJson(Map<String, Object?> json) {
    return SlackFilesListReturn(
      connection: raviJsonAsString(json["connection"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      ok: raviJsonAsBool(json["ok"]),
      pagination: RaviJson.from(json["pagination"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackFilesListReturn fromJsonValue(Object? json) {
    return SlackFilesListReturn.fromJson(raviJsonObject(json, "SlackFilesListReturn"));
  }
}

SlackFilesListReturn slackFilesListReturnFromJson(Object? json) => SlackFilesListReturn.fromJsonValue(json);

class SlackInteractionsRespondOptions {
  const SlackInteractionsRespondOptions({this.channel, this.execute});

  final String? channel;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SlackInteractionsRespondReturn {
  const SlackInteractionsRespondReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackInteractionsRespondReturn.fromJson(Map<String, Object?> json) {
    return SlackInteractionsRespondReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackInteractionsRespondReturn fromJsonValue(Object? json) {
    return SlackInteractionsRespondReturn.fromJson(raviJsonObject(json, "SlackInteractionsRespondReturn"));
  }
}

SlackInteractionsRespondReturn slackInteractionsRespondReturnFromJson(Object? json) => SlackInteractionsRespondReturn.fromJsonValue(json);

class SlackMembersListOptions {
  const SlackMembersListOptions({this.cursor, this.limit});

  final String? cursor;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class SlackMembersListReturn {
  const SlackMembersListReturn({required this.connection, required this.items, required this.ok, required this.pagination, required this.provider, this.raw, required this.source});

  final String connection;
  final List<RaviJson> items;
  final bool ok;
  final RaviJson pagination;
  final String provider;
  final Map<String, RaviJson>? raw;
  final String source;

  factory SlackMembersListReturn.fromJson(Map<String, Object?> json) {
    return SlackMembersListReturn(
      connection: raviJsonAsString(json["connection"]),
      items: raviJsonAsList(json["items"], RaviJson.from),
      ok: raviJsonAsBool(json["ok"]),
      pagination: RaviJson.from(json["pagination"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackMembersListReturn fromJsonValue(Object? json) {
    return SlackMembersListReturn.fromJson(raviJsonObject(json, "SlackMembersListReturn"));
  }
}

SlackMembersListReturn slackMembersListReturnFromJson(Object? json) => SlackMembersListReturn.fromJsonValue(json);

class SlackMessagesInspectReturn {
  const SlackMessagesInspectReturn({required this.connection, this.item, required this.ok, required this.provider, this.raw, required this.source});

  final String connection;
  final RaviJson? item;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final String source;

  factory SlackMessagesInspectReturn.fromJson(Map<String, Object?> json) {
    return SlackMessagesInspectReturn(
      connection: raviJsonAsString(json["connection"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackMessagesInspectReturn fromJsonValue(Object? json) {
    return SlackMessagesInspectReturn.fromJson(raviJsonObject(json, "SlackMessagesInspectReturn"));
  }
}

SlackMessagesInspectReturn slackMessagesInspectReturnFromJson(Object? json) => SlackMessagesInspectReturn.fromJsonValue(json);

class SlackMessagesReplayOptions {
  const SlackMessagesReplayOptions({this.execute, this.force});

  final bool? execute;
  final bool? force;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (force != null) {
      into["force"] = RaviJson.from(force);
    }
  }
}

class SlackMessagesReplayReturn {
  const SlackMessagesReplayReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackMessagesReplayReturn.fromJson(Map<String, Object?> json) {
    return SlackMessagesReplayReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackMessagesReplayReturn fromJsonValue(Object? json) {
    return SlackMessagesReplayReturn.fromJson(raviJsonObject(json, "SlackMessagesReplayReturn"));
  }
}

SlackMessagesReplayReturn slackMessagesReplayReturnFromJson(Object? json) => SlackMessagesReplayReturn.fromJsonValue(json);

class SlackMessagesSendOptions {
  const SlackMessagesSendOptions({this.ephemeralUser, this.execute, this.threadTs});

  final String? ephemeralUser;
  final bool? execute;
  final String? threadTs;

  void encodeBody(Map<String, RaviJson> into) {
    if (ephemeralUser != null) {
      into["ephemeralUser"] = RaviJson.from(ephemeralUser);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (threadTs != null) {
      into["threadTs"] = RaviJson.from(threadTs);
    }
  }
}

class SlackMessagesSendReturn {
  const SlackMessagesSendReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackMessagesSendReturn.fromJson(Map<String, Object?> json) {
    return SlackMessagesSendReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackMessagesSendReturn fromJsonValue(Object? json) {
    return SlackMessagesSendReturn.fromJson(raviJsonObject(json, "SlackMessagesSendReturn"));
  }
}

SlackMessagesSendReturn slackMessagesSendReturnFromJson(Object? json) => SlackMessagesSendReturn.fromJsonValue(json);

class SlackModalsOpenOptions {
  const SlackModalsOpenOptions({this.channel, this.execute});

  final String? channel;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SlackModalsOpenReturn {
  const SlackModalsOpenReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackModalsOpenReturn.fromJson(Map<String, Object?> json) {
    return SlackModalsOpenReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackModalsOpenReturn fromJsonValue(Object? json) {
    return SlackModalsOpenReturn.fromJson(raviJsonObject(json, "SlackModalsOpenReturn"));
  }
}

SlackModalsOpenReturn slackModalsOpenReturnFromJson(Object? json) => SlackModalsOpenReturn.fromJsonValue(json);

class SlackModalsPushOptions {
  const SlackModalsPushOptions({this.channel, this.execute});

  final String? channel;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SlackModalsPushReturn {
  const SlackModalsPushReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackModalsPushReturn.fromJson(Map<String, Object?> json) {
    return SlackModalsPushReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackModalsPushReturn fromJsonValue(Object? json) {
    return SlackModalsPushReturn.fromJson(raviJsonObject(json, "SlackModalsPushReturn"));
  }
}

SlackModalsPushReturn slackModalsPushReturnFromJson(Object? json) => SlackModalsPushReturn.fromJsonValue(json);

class SlackModalsUpdateOptions {
  const SlackModalsUpdateOptions({this.channel, this.execute, this.externalId, this.hash});

  final String? channel;
  final bool? execute;
  final bool? externalId;
  final String? hash;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (externalId != null) {
      into["externalId"] = RaviJson.from(externalId);
    }
    if (hash != null) {
      into["hash"] = RaviJson.from(hash);
    }
  }
}

class SlackModalsUpdateReturn {
  const SlackModalsUpdateReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackModalsUpdateReturn.fromJson(Map<String, Object?> json) {
    return SlackModalsUpdateReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackModalsUpdateReturn fromJsonValue(Object? json) {
    return SlackModalsUpdateReturn.fromJson(raviJsonObject(json, "SlackModalsUpdateReturn"));
  }
}

SlackModalsUpdateReturn slackModalsUpdateReturnFromJson(Object? json) => SlackModalsUpdateReturn.fromJsonValue(json);

class SlackPermissionsListOptions {
  const SlackPermissionsListOptions({this.channel});

  final String? channel;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
  }
}

class SlackPermissionsListReturn {
  const SlackPermissionsListReturn({required this.connection, this.item, required this.ok, required this.provider, this.raw, required this.source});

  final String connection;
  final RaviJson? item;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final String source;

  factory SlackPermissionsListReturn.fromJson(Map<String, Object?> json) {
    return SlackPermissionsListReturn(
      connection: raviJsonAsString(json["connection"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackPermissionsListReturn fromJsonValue(Object? json) {
    return SlackPermissionsListReturn.fromJson(raviJsonObject(json, "SlackPermissionsListReturn"));
  }
}

SlackPermissionsListReturn slackPermissionsListReturnFromJson(Object? json) => SlackPermissionsListReturn.fromJsonValue(json);

class SlackTopologyOptions {
  const SlackTopologyOptions({this.channel, this.cursor, this.includeArchived, this.limit, this.types});

  final String? channel;
  final String? cursor;
  final bool? includeArchived;
  final String? limit;
  final String? types;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (includeArchived != null) {
      into["includeArchived"] = RaviJson.from(includeArchived);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (types != null) {
      into["types"] = RaviJson.from(types);
    }
  }
}

class SlackTopologyReturn {
  const SlackTopologyReturn({required this.accountId, required this.capabilities, required this.channels, required this.connection, required this.ok, required this.provider, required this.source, required this.ungroupedChannelIds});

  final String accountId;
  final Map<String, RaviJson> capabilities;
  final List<RaviJson> channels;
  final String connection;
  final bool ok;
  final String provider;
  final String source;
  final List<String> ungroupedChannelIds;

  factory SlackTopologyReturn.fromJson(Map<String, Object?> json) {
    return SlackTopologyReturn(
      accountId: raviJsonAsString(json["accountId"]),
      capabilities: raviJsonAsRaviJsonMap(json["capabilities"]),
      channels: raviJsonAsList(json["channels"], RaviJson.from),
      connection: raviJsonAsString(json["connection"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      source: raviJsonAsString(json["source"]),
      ungroupedChannelIds: raviJsonAsList(json["ungroupedChannelIds"], raviJsonAsString),
    );
  }

  static SlackTopologyReturn fromJsonValue(Object? json) {
    return SlackTopologyReturn.fromJson(raviJsonObject(json, "SlackTopologyReturn"));
  }
}

SlackTopologyReturn slackTopologyReturnFromJson(Object? json) => SlackTopologyReturn.fromJsonValue(json);

class SlackWorkObjectsPresentDetailsOptions {
  const SlackWorkObjectsPresentDetailsOptions({this.channel, this.connection, this.execute});

  final String? channel;
  final String? connection;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SlackWorkObjectsPresentDetailsReturn {
  const SlackWorkObjectsPresentDetailsReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackWorkObjectsPresentDetailsReturn.fromJson(Map<String, Object?> json) {
    return SlackWorkObjectsPresentDetailsReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackWorkObjectsPresentDetailsReturn fromJsonValue(Object? json) {
    return SlackWorkObjectsPresentDetailsReturn.fromJson(raviJsonObject(json, "SlackWorkObjectsPresentDetailsReturn"));
  }
}

SlackWorkObjectsPresentDetailsReturn slackWorkObjectsPresentDetailsReturnFromJson(Object? json) => SlackWorkObjectsPresentDetailsReturn.fromJsonValue(json);

class SlackWorkObjectsSendOptions {
  const SlackWorkObjectsSendOptions({this.connection, this.execute, this.text, this.threadTs});

  final String? connection;
  final bool? execute;
  final String? text;
  final String? threadTs;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (text != null) {
      into["text"] = RaviJson.from(text);
    }
    if (threadTs != null) {
      into["threadTs"] = RaviJson.from(threadTs);
    }
  }
}

class SlackWorkObjectsSendReturn {
  const SlackWorkObjectsSendReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackWorkObjectsSendReturn.fromJson(Map<String, Object?> json) {
    return SlackWorkObjectsSendReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackWorkObjectsSendReturn fromJsonValue(Object? json) {
    return SlackWorkObjectsSendReturn.fromJson(raviJsonObject(json, "SlackWorkObjectsSendReturn"));
  }
}

SlackWorkObjectsSendReturn slackWorkObjectsSendReturnFromJson(Object? json) => SlackWorkObjectsSendReturn.fromJsonValue(json);

class SlackWorkObjectsUnfurlOptions {
  const SlackWorkObjectsUnfurlOptions({this.connection, this.execute});

  final String? connection;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class SlackWorkObjectsUnfurlReturn {
  const SlackWorkObjectsUnfurlReturn({required this.connection, required this.dryRun, this.item, required this.method, required this.ok, required this.provider, this.raw, required this.request, required this.source});

  final String connection;
  final bool dryRun;
  final RaviJson? item;
  final String method;
  final bool ok;
  final String provider;
  final Map<String, RaviJson>? raw;
  final Map<String, RaviJson> request;
  final String source;

  factory SlackWorkObjectsUnfurlReturn.fromJson(Map<String, Object?> json) {
    return SlackWorkObjectsUnfurlReturn(
      connection: raviJsonAsString(json["connection"]),
      dryRun: raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      method: raviJsonAsString(json["method"]),
      ok: raviJsonAsBool(json["ok"]),
      provider: raviJsonAsString(json["provider"]),
      raw: json["raw"] == null ? null : raviJsonAsRaviJsonMap(json["raw"]),
      request: raviJsonAsRaviJsonMap(json["request"]),
      source: raviJsonAsString(json["source"]),
    );
  }

  static SlackWorkObjectsUnfurlReturn fromJsonValue(Object? json) {
    return SlackWorkObjectsUnfurlReturn.fromJson(raviJsonObject(json, "SlackWorkObjectsUnfurlReturn"));
  }
}

SlackWorkObjectsUnfurlReturn slackWorkObjectsUnfurlReturnFromJson(Object? json) => SlackWorkObjectsUnfurlReturn.fromJsonValue(json);

class SlackWorkObjectsValidateOptions {
  const SlackWorkObjectsValidateOptions({this.target});

  final String? target;

  void encodeBody(Map<String, RaviJson> into) {
    if (target != null) {
      into["target"] = RaviJson.from(target);
    }
  }
}

class SlackWorkObjectsValidateReturn {
  const SlackWorkObjectsValidateReturn({this.dryRun, this.item, required this.ok, this.outputFile, required this.provider});

  final bool? dryRun;
  final RaviJson? item;
  final bool ok;
  final String? outputFile;
  final String provider;

  factory SlackWorkObjectsValidateReturn.fromJson(Map<String, Object?> json) {
    return SlackWorkObjectsValidateReturn(
      dryRun: json["dryRun"] == null ? null : raviJsonAsBool(json["dryRun"]),
      item: json["item"] == null ? null : RaviJson.from(json["item"]),
      ok: raviJsonAsBool(json["ok"]),
      outputFile: json["outputFile"] == null ? null : raviJsonAsString(json["outputFile"]),
      provider: raviJsonAsString(json["provider"]),
    );
  }

  static SlackWorkObjectsValidateReturn fromJsonValue(Object? json) {
    return SlackWorkObjectsValidateReturn.fromJson(raviJsonObject(json, "SlackWorkObjectsValidateReturn"));
  }
}

SlackWorkObjectsValidateReturn slackWorkObjectsValidateReturnFromJson(Object? json) => SlackWorkObjectsValidateReturn.fromJsonValue(json);

class SpecsGetOptions {
  const SpecsGetOptions({this.mode});

  final String? mode;

  void encodeBody(Map<String, RaviJson> into) {
    if (mode != null) {
      into["mode"] = RaviJson.from(mode);
    }
  }
}

class SpecsGetReturn {
  const SpecsGetReturn({required this.context});

  final Map<String, RaviJson> context;

  factory SpecsGetReturn.fromJson(Map<String, Object?> json) {
    return SpecsGetReturn(
      context: raviJsonAsRaviJsonMap(json["context"]),
    );
  }

  static SpecsGetReturn fromJsonValue(Object? json) {
    return SpecsGetReturn.fromJson(raviJsonObject(json, "SpecsGetReturn"));
  }
}

SpecsGetReturn specsGetReturnFromJson(Object? json) => SpecsGetReturn.fromJsonValue(json);

class SpecsListOptions {
  const SpecsListOptions({this.domain, this.fields, this.kind, this.limit, this.offset});

  final String? domain;
  final String? fields;
  final String? kind;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (domain != null) {
      into["domain"] = RaviJson.from(domain);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class SpecsListReturn {
  const SpecsListReturn({required this.items, required this.pagination, required this.specs, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> specs;
  final double total;

  factory SpecsListReturn.fromJson(Map<String, Object?> json) {
    return SpecsListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      specs: raviJsonAsList(json["specs"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SpecsListReturn fromJsonValue(Object? json) {
    return SpecsListReturn.fromJson(raviJsonObject(json, "SpecsListReturn"));
  }
}

SpecsListReturn specsListReturnFromJson(Object? json) => SpecsListReturn.fromJsonValue(json);

class SpecsNewOptions {
  const SpecsNewOptions({this.full, this.kind, this.title});

  final bool? full;
  final String? kind;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (full != null) {
      into["full"] = RaviJson.from(full);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class SpecsNewReturn {
  const SpecsNewReturn({required this.createdFiles, required this.missingAncestors, required this.spec, required this.status});

  final List<String> createdFiles;
  final List<Map<String, RaviJson>> missingAncestors;
  final Map<String, RaviJson> spec;
  final String status;

  factory SpecsNewReturn.fromJson(Map<String, Object?> json) {
    return SpecsNewReturn(
      createdFiles: raviJsonAsList(json["createdFiles"], raviJsonAsString),
      missingAncestors: raviJsonAsList(json["missingAncestors"], raviJsonAsRaviJsonMap),
      spec: raviJsonAsRaviJsonMap(json["spec"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SpecsNewReturn fromJsonValue(Object? json) {
    return SpecsNewReturn.fromJson(raviJsonObject(json, "SpecsNewReturn"));
  }
}

SpecsNewReturn specsNewReturnFromJson(Object? json) => SpecsNewReturn.fromJsonValue(json);

class SpecsSyncReturn {
  const SpecsSyncReturn({required this.rootPath, required this.status, required this.total});

  final String rootPath;
  final String status;
  final double total;

  factory SpecsSyncReturn.fromJson(Map<String, Object?> json) {
    return SpecsSyncReturn(
      rootPath: raviJsonAsString(json["rootPath"]),
      status: raviJsonAsString(json["status"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static SpecsSyncReturn fromJsonValue(Object? json) {
    return SpecsSyncReturn.fromJson(raviJsonObject(json, "SpecsSyncReturn"));
  }
}

SpecsSyncReturn specsSyncReturnFromJson(Object? json) => SpecsSyncReturn.fromJsonValue(json);

class StickersAddOptions {
  const StickersAddOptions({this.agents, this.avoid, this.channels, this.description, this.disabled, this.label, this.overwrite});

  final String? agents;
  final String? avoid;
  final String? channels;
  final String? description;
  final bool? disabled;
  final String? label;
  final bool? overwrite;

  void encodeBody(Map<String, RaviJson> into) {
    if (agents != null) {
      into["agents"] = RaviJson.from(agents);
    }
    if (avoid != null) {
      into["avoid"] = RaviJson.from(avoid);
    }
    if (channels != null) {
      into["channels"] = RaviJson.from(channels);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (disabled != null) {
      into["disabled"] = RaviJson.from(disabled);
    }
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (overwrite != null) {
      into["overwrite"] = RaviJson.from(overwrite);
    }
  }
}

class StickersAddReturn {
  const StickersAddReturn({required this.action, required this.sticker, required this.success});

  final String action;
  final RaviJson sticker;
  final bool success;

  factory StickersAddReturn.fromJson(Map<String, Object?> json) {
    return StickersAddReturn(
      action: raviJsonAsString(json["action"]),
      sticker: RaviJson.from(json["sticker"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static StickersAddReturn fromJsonValue(Object? json) {
    return StickersAddReturn.fromJson(raviJsonObject(json, "StickersAddReturn"));
  }
}

StickersAddReturn stickersAddReturnFromJson(Object? json) => StickersAddReturn.fromJsonValue(json);

class StickersListOptions {
  const StickersListOptions({this.fields, this.limit, this.offset});

  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class StickersListReturn {
  const StickersListReturn({required this.items, required this.pagination, required this.stickers, required this.total});

  final List<RaviJson> items;
  final RaviJson pagination;
  final List<RaviJson> stickers;
  final double total;

  factory StickersListReturn.fromJson(Map<String, Object?> json) {
    return StickersListReturn(
      items: raviJsonAsList(json["items"], RaviJson.from),
      pagination: RaviJson.from(json["pagination"]),
      stickers: raviJsonAsList(json["stickers"], RaviJson.from),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static StickersListReturn fromJsonValue(Object? json) {
    return StickersListReturn.fromJson(raviJsonObject(json, "StickersListReturn"));
  }
}

StickersListReturn stickersListReturnFromJson(Object? json) => StickersListReturn.fromJsonValue(json);

class StickersRemoveOptions {
  const StickersRemoveOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class StickersRemoveReturn {
  const StickersRemoveReturn({required this.action, required this.stickerId, required this.success});

  final String action;
  final String stickerId;
  final bool success;

  factory StickersRemoveReturn.fromJson(Map<String, Object?> json) {
    return StickersRemoveReturn(
      action: raviJsonAsString(json["action"]),
      stickerId: raviJsonAsString(json["stickerId"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static StickersRemoveReturn fromJsonValue(Object? json) {
    return StickersRemoveReturn.fromJson(raviJsonObject(json, "StickersRemoveReturn"));
  }
}

StickersRemoveReturn stickersRemoveReturnFromJson(Object? json) => StickersRemoveReturn.fromJsonValue(json);

class StickersSendOptions {
  const StickersSendOptions({this.account, this.channel, this.execute, this.session, this.to});

  final String? account;
  final String? channel;
  final bool? execute;
  final String? session;
  final String? to;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (channel != null) {
      into["channel"] = RaviJson.from(channel);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (to != null) {
      into["to"] = RaviJson.from(to);
    }
  }
}

class StickersSendReturn {
  const StickersSendReturn({required this.event, required this.sticker, required this.success, required this.target, required this.topic});

  final Map<String, RaviJson> event;
  final RaviJson sticker;
  final bool success;
  final RaviJson target;
  final String topic;

  factory StickersSendReturn.fromJson(Map<String, Object?> json) {
    return StickersSendReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      sticker: RaviJson.from(json["sticker"]),
      success: raviJsonAsBool(json["success"]),
      target: RaviJson.from(json["target"]),
      topic: raviJsonAsString(json["topic"]),
    );
  }

  static StickersSendReturn fromJsonValue(Object? json) {
    return StickersSendReturn.fromJson(raviJsonObject(json, "StickersSendReturn"));
  }
}

StickersSendReturn stickersSendReturnFromJson(Object? json) => StickersSendReturn.fromJsonValue(json);

class StickersShowReturn {
  const StickersShowReturn({required this.sticker});

  final RaviJson sticker;

  factory StickersShowReturn.fromJson(Map<String, Object?> json) {
    return StickersShowReturn(
      sticker: RaviJson.from(json["sticker"]),
    );
  }

  static StickersShowReturn fromJsonValue(Object? json) {
    return StickersShowReturn.fromJson(raviJsonObject(json, "StickersShowReturn"));
  }
}

StickersShowReturn stickersShowReturnFromJson(Object? json) => StickersShowReturn.fromJsonValue(json);

typedef SyncInspectReturn = RaviJson;

SyncInspectReturn syncInspectReturnFromJson(Object? json) => RaviJson.from(json);

class SyncPullOptions {
  const SyncPullOptions({this.domain, this.execute, this.limit, this.project, this.projectId, this.projectRef, this.scope});

  final String? domain;
  final bool? execute;
  final String? limit;
  final String? project;
  final String? projectId;
  final String? projectRef;
  final String? scope;

  void encodeBody(Map<String, RaviJson> into) {
    if (domain != null) {
      into["domain"] = RaviJson.from(domain);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (projectId != null) {
      into["projectId"] = RaviJson.from(projectId);
    }
    if (projectRef != null) {
      into["projectRef"] = RaviJson.from(projectRef);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
  }
}

class SyncPullReturn {
  const SyncPullReturn({required this.applied, required this.cursor, required this.downloaded, required this.enqueued, this.errorCode, required this.failed, required this.linked, required this.skipped, required this.status});

  final double applied;
  final RaviJson cursor;
  final double downloaded;
  final double enqueued;
  final String? errorCode;
  final double failed;
  final bool linked;
  final double skipped;
  final String status;

  factory SyncPullReturn.fromJson(Map<String, Object?> json) {
    return SyncPullReturn(
      applied: raviJsonAsDouble(json["applied"]),
      cursor: RaviJson.from(json["cursor"]),
      downloaded: raviJsonAsDouble(json["downloaded"]),
      enqueued: raviJsonAsDouble(json["enqueued"]),
      errorCode: json["errorCode"] == null ? null : raviJsonAsString(json["errorCode"]),
      failed: raviJsonAsDouble(json["failed"]),
      linked: raviJsonAsBool(json["linked"]),
      skipped: raviJsonAsDouble(json["skipped"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static SyncPullReturn fromJsonValue(Object? json) {
    return SyncPullReturn.fromJson(raviJsonObject(json, "SyncPullReturn"));
  }
}

SyncPullReturn syncPullReturnFromJson(Object? json) => SyncPullReturn.fromJsonValue(json);

class SyncPushOptions {
  const SyncPushOptions({this.domain, this.execute, this.limit, this.maxBytes, this.project, this.projectId, this.projectRef, this.scope, this.traces});

  final String? domain;
  final bool? execute;
  final String? limit;
  final String? maxBytes;
  final String? project;
  final String? projectId;
  final String? projectRef;
  final String? scope;
  final bool? traces;

  void encodeBody(Map<String, RaviJson> into) {
    if (domain != null) {
      into["domain"] = RaviJson.from(domain);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (maxBytes != null) {
      into["maxBytes"] = RaviJson.from(maxBytes);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (projectId != null) {
      into["projectId"] = RaviJson.from(projectId);
    }
    if (projectRef != null) {
      into["projectRef"] = RaviJson.from(projectRef);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (traces != null) {
      into["traces"] = RaviJson.from(traces);
    }
  }
}

class SyncPushReturn {
  const SyncPushReturn({required this.acked, required this.attempted, this.errorCode, required this.failed, required this.linked, required this.sent, required this.status, this.trace});

  final double acked;
  final double attempted;
  final String? errorCode;
  final double failed;
  final bool linked;
  final double sent;
  final String status;
  final RaviJson? trace;

  factory SyncPushReturn.fromJson(Map<String, Object?> json) {
    return SyncPushReturn(
      acked: raviJsonAsDouble(json["acked"]),
      attempted: raviJsonAsDouble(json["attempted"]),
      errorCode: json["errorCode"] == null ? null : raviJsonAsString(json["errorCode"]),
      failed: raviJsonAsDouble(json["failed"]),
      linked: raviJsonAsBool(json["linked"]),
      sent: raviJsonAsDouble(json["sent"]),
      status: raviJsonAsString(json["status"]),
      trace: json["trace"] == null ? null : RaviJson.from(json["trace"]),
    );
  }

  static SyncPushReturn fromJsonValue(Object? json) {
    return SyncPushReturn.fromJson(raviJsonObject(json, "SyncPushReturn"));
  }
}

SyncPushReturn syncPushReturnFromJson(Object? json) => SyncPushReturn.fromJsonValue(json);

class SyncRetryOptions {
  const SyncRetryOptions({this.dead, this.id});

  final bool? dead;
  final String? id;

  void encodeBody(Map<String, RaviJson> into) {
    if (dead != null) {
      into["dead"] = RaviJson.from(dead);
    }
    if (id != null) {
      into["id"] = RaviJson.from(id);
    }
  }
}

class SyncRetryReturn {
  const SyncRetryReturn({required this.retried, required this.success});

  final double retried;
  final bool success;

  factory SyncRetryReturn.fromJson(Map<String, Object?> json) {
    return SyncRetryReturn(
      retried: raviJsonAsDouble(json["retried"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static SyncRetryReturn fromJsonValue(Object? json) {
    return SyncRetryReturn.fromJson(raviJsonObject(json, "SyncRetryReturn"));
  }
}

SyncRetryReturn syncRetryReturnFromJson(Object? json) => SyncRetryReturn.fromJsonValue(json);

class SyncStatusReturn {
  const SyncStatusReturn({required this.consoleUrl, required this.cursors, required this.inbox, required this.installationId, required this.lastDownload, required this.lastError, required this.lastUpload, required this.linked, required this.outbox, required this.runner});

  final RaviJson consoleUrl;
  final List<RaviJson> cursors;
  final RaviJson inbox;
  final RaviJson installationId;
  final RaviJson lastDownload;
  final RaviJson lastError;
  final RaviJson lastUpload;
  final bool linked;
  final RaviJson outbox;
  final RaviJson runner;

  factory SyncStatusReturn.fromJson(Map<String, Object?> json) {
    return SyncStatusReturn(
      consoleUrl: RaviJson.from(json["consoleUrl"]),
      cursors: raviJsonAsList(json["cursors"], RaviJson.from),
      inbox: RaviJson.from(json["inbox"]),
      installationId: RaviJson.from(json["installationId"]),
      lastDownload: RaviJson.from(json["lastDownload"]),
      lastError: RaviJson.from(json["lastError"]),
      lastUpload: RaviJson.from(json["lastUpload"]),
      linked: raviJsonAsBool(json["linked"]),
      outbox: RaviJson.from(json["outbox"]),
      runner: RaviJson.from(json["runner"]),
    );
  }

  static SyncStatusReturn fromJsonValue(Object? json) {
    return SyncStatusReturn.fromJson(raviJsonObject(json, "SyncStatusReturn"));
  }
}

SyncStatusReturn syncStatusReturnFromJson(Object? json) => SyncStatusReturn.fromJsonValue(json);

class TagRulesEvaluateOptions {
  const TagRulesEvaluateOptions({this.apply, this.file, this.target});

  final bool? apply;
  final String? file;
  final String? target;

  void encodeBody(Map<String, RaviJson> into) {
    if (apply != null) {
      into["apply"] = RaviJson.from(apply);
    }
    if (file != null) {
      into["file"] = RaviJson.from(file);
    }
    if (target != null) {
      into["target"] = RaviJson.from(target);
    }
  }
}

class TagRulesEvaluateReturn {
  const TagRulesEvaluateReturn({required this.apply, required this.outcomes, required this.ruleId, required this.target, required this.traces});

  final bool apply;
  final List<Map<String, RaviJson>> outcomes;
  final String ruleId;
  final Map<String, RaviJson> target;
  final List<Map<String, RaviJson>> traces;

  factory TagRulesEvaluateReturn.fromJson(Map<String, Object?> json) {
    return TagRulesEvaluateReturn(
      apply: raviJsonAsBool(json["apply"]),
      outcomes: raviJsonAsList(json["outcomes"], raviJsonAsRaviJsonMap),
      ruleId: raviJsonAsString(json["ruleId"]),
      target: raviJsonAsRaviJsonMap(json["target"]),
      traces: raviJsonAsList(json["traces"], raviJsonAsRaviJsonMap),
    );
  }

  static TagRulesEvaluateReturn fromJsonValue(Object? json) {
    return TagRulesEvaluateReturn.fromJson(raviJsonObject(json, "TagRulesEvaluateReturn"));
  }
}

TagRulesEvaluateReturn tagRulesEvaluateReturnFromJson(Object? json) => TagRulesEvaluateReturn.fromJsonValue(json);

class TagRulesExplainOptions {
  const TagRulesExplainOptions({this.target});

  final String? target;

  void encodeBody(Map<String, RaviJson> into) {
    if (target != null) {
      into["target"] = RaviJson.from(target);
    }
  }
}

class TagRulesExplainReturn {
  const TagRulesExplainReturn({required this.loaded, required this.outcomes, required this.rules, required this.target});

  final Map<String, RaviJson> loaded;
  final List<Map<String, RaviJson>> outcomes;
  final Map<String, RaviJson> rules;
  final Map<String, RaviJson> target;

  factory TagRulesExplainReturn.fromJson(Map<String, Object?> json) {
    return TagRulesExplainReturn(
      loaded: raviJsonAsRaviJsonMap(json["loaded"]),
      outcomes: raviJsonAsList(json["outcomes"], raviJsonAsRaviJsonMap),
      rules: raviJsonAsRaviJsonMap(json["rules"]),
      target: raviJsonAsRaviJsonMap(json["target"]),
    );
  }

  static TagRulesExplainReturn fromJsonValue(Object? json) {
    return TagRulesExplainReturn.fromJson(raviJsonObject(json, "TagRulesExplainReturn"));
  }
}

TagRulesExplainReturn tagRulesExplainReturnFromJson(Object? json) => TagRulesExplainReturn.fromJsonValue(json);

class TagRulesListOptions {
  const TagRulesListOptions({this.fields, this.limit, this.offset});

  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class TagRulesListReturn {
  const TagRulesListReturn({required this.errors, required this.pagination, required this.rules});

  final List<Map<String, RaviJson>> errors;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> rules;

  factory TagRulesListReturn.fromJson(Map<String, Object?> json) {
    return TagRulesListReturn(
      errors: raviJsonAsList(json["errors"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      rules: raviJsonAsList(json["rules"], raviJsonAsRaviJsonMap),
    );
  }

  static TagRulesListReturn fromJsonValue(Object? json) {
    return TagRulesListReturn.fromJson(raviJsonObject(json, "TagRulesListReturn"));
  }
}

TagRulesListReturn tagRulesListReturnFromJson(Object? json) => TagRulesListReturn.fromJsonValue(json);

class TagRulesShowReturn {
  const TagRulesShowReturn({required this.rule, this.source});

  final Map<String, RaviJson> rule;
  final String? source;

  factory TagRulesShowReturn.fromJson(Map<String, Object?> json) {
    return TagRulesShowReturn(
      rule: raviJsonAsRaviJsonMap(json["rule"]),
      source: json["source"] == null ? null : raviJsonAsString(json["source"]),
    );
  }

  static TagRulesShowReturn fromJsonValue(Object? json) {
    return TagRulesShowReturn.fromJson(raviJsonObject(json, "TagRulesShowReturn"));
  }
}

TagRulesShowReturn tagRulesShowReturnFromJson(Object? json) => TagRulesShowReturn.fromJsonValue(json);

class TagRulesTickOptions {
  const TagRulesTickOptions({this.apply, this.limit});

  final bool? apply;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (apply != null) {
      into["apply"] = RaviJson.from(apply);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class TagRulesTickReturn {
  const TagRulesTickReturn({required this.appliedActions, required this.contacts, required this.contactsProcessed, required this.loadErrors, required this.matched, required this.rulesLoaded});

  final double appliedActions;
  final List<Map<String, RaviJson>> contacts;
  final double contactsProcessed;
  final List<Map<String, RaviJson>> loadErrors;
  final double matched;
  final double rulesLoaded;

  factory TagRulesTickReturn.fromJson(Map<String, Object?> json) {
    return TagRulesTickReturn(
      appliedActions: raviJsonAsDouble(json["appliedActions"]),
      contacts: raviJsonAsList(json["contacts"], raviJsonAsRaviJsonMap),
      contactsProcessed: raviJsonAsDouble(json["contactsProcessed"]),
      loadErrors: raviJsonAsList(json["loadErrors"], raviJsonAsRaviJsonMap),
      matched: raviJsonAsDouble(json["matched"]),
      rulesLoaded: raviJsonAsDouble(json["rulesLoaded"]),
    );
  }

  static TagRulesTickReturn fromJsonValue(Object? json) {
    return TagRulesTickReturn.fromJson(raviJsonObject(json, "TagRulesTickReturn"));
  }
}

TagRulesTickReturn tagRulesTickReturnFromJson(Object? json) => TagRulesTickReturn.fromJsonValue(json);

class TagRulesValidateReturn {
  const TagRulesValidateReturn({required this.errors, required this.ruleCount, required this.status});

  final List<Map<String, RaviJson>> errors;
  final double ruleCount;
  final String status;

  factory TagRulesValidateReturn.fromJson(Map<String, Object?> json) {
    return TagRulesValidateReturn(
      errors: raviJsonAsList(json["errors"], raviJsonAsRaviJsonMap),
      ruleCount: raviJsonAsDouble(json["ruleCount"]),
      status: raviJsonAsString(json["status"]),
    );
  }

  static TagRulesValidateReturn fromJsonValue(Object? json) {
    return TagRulesValidateReturn.fromJson(raviJsonObject(json, "TagRulesValidateReturn"));
  }
}

TagRulesValidateReturn tagRulesValidateReturnFromJson(Object? json) => TagRulesValidateReturn.fromJsonValue(json);

class TagsAttachOptions {
  const TagsAttachOptions({this.agent, this.artifact, this.callProfile, this.callRequest, this.callTool, this.callVoiceAgent, this.chat, this.command, this.contact, this.cronJob, this.devinSession, this.hook, this.insight, this.instance, this.meta, this.profile, this.project, this.route, this.session, this.skill, this.skillGateRule, this.source, this.target, this.task, this.taskAutomation, this.trigger, this.workflowNode, this.workflowRun, this.workflowSpec});

  final String? agent;
  final String? artifact;
  final String? callProfile;
  final String? callRequest;
  final String? callTool;
  final String? callVoiceAgent;
  final String? chat;
  final String? command;
  final String? contact;
  final String? cronJob;
  final String? devinSession;
  final String? hook;
  final String? insight;
  final String? instance;
  final String? meta;
  final String? profile;
  final String? project;
  final String? route;
  final String? session;
  final String? skill;
  final String? skillGateRule;
  final String? source;
  final String? target;
  final String? task;
  final String? taskAutomation;
  final String? trigger;
  final String? workflowNode;
  final String? workflowRun;
  final String? workflowSpec;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (artifact != null) {
      into["artifact"] = RaviJson.from(artifact);
    }
    if (callProfile != null) {
      into["callProfile"] = RaviJson.from(callProfile);
    }
    if (callRequest != null) {
      into["callRequest"] = RaviJson.from(callRequest);
    }
    if (callTool != null) {
      into["callTool"] = RaviJson.from(callTool);
    }
    if (callVoiceAgent != null) {
      into["callVoiceAgent"] = RaviJson.from(callVoiceAgent);
    }
    if (chat != null) {
      into["chat"] = RaviJson.from(chat);
    }
    if (command != null) {
      into["command"] = RaviJson.from(command);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (cronJob != null) {
      into["cronJob"] = RaviJson.from(cronJob);
    }
    if (devinSession != null) {
      into["devinSession"] = RaviJson.from(devinSession);
    }
    if (hook != null) {
      into["hook"] = RaviJson.from(hook);
    }
    if (insight != null) {
      into["insight"] = RaviJson.from(insight);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (meta != null) {
      into["meta"] = RaviJson.from(meta);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (route != null) {
      into["route"] = RaviJson.from(route);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (skill != null) {
      into["skill"] = RaviJson.from(skill);
    }
    if (skillGateRule != null) {
      into["skillGateRule"] = RaviJson.from(skillGateRule);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
    if (target != null) {
      into["target"] = RaviJson.from(target);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
    if (taskAutomation != null) {
      into["taskAutomation"] = RaviJson.from(taskAutomation);
    }
    if (trigger != null) {
      into["trigger"] = RaviJson.from(trigger);
    }
    if (workflowNode != null) {
      into["workflowNode"] = RaviJson.from(workflowNode);
    }
    if (workflowRun != null) {
      into["workflowRun"] = RaviJson.from(workflowRun);
    }
    if (workflowSpec != null) {
      into["workflowSpec"] = RaviJson.from(workflowSpec);
    }
  }
}

class TagsAttachReturn {
  const TagsAttachReturn({this.behaviorConsumers, this.binding, required this.changedCount, required this.status, this.tag, required this.target});

  final List<Map<String, RaviJson>>? behaviorConsumers;
  final Map<String, RaviJson>? binding;
  final double changedCount;
  final String status;
  final Map<String, RaviJson>? tag;
  final Map<String, RaviJson> target;

  factory TagsAttachReturn.fromJson(Map<String, Object?> json) {
    return TagsAttachReturn(
      behaviorConsumers: json["behaviorConsumers"] == null ? null : raviJsonAsList(json["behaviorConsumers"], raviJsonAsRaviJsonMap),
      binding: json["binding"] == null ? null : raviJsonAsRaviJsonMap(json["binding"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      tag: json["tag"] == null ? null : raviJsonAsRaviJsonMap(json["tag"]),
      target: raviJsonAsRaviJsonMap(json["target"]),
    );
  }

  static TagsAttachReturn fromJsonValue(Object? json) {
    return TagsAttachReturn.fromJson(raviJsonObject(json, "TagsAttachReturn"));
  }
}

TagsAttachReturn tagsAttachReturnFromJson(Object? json) => TagsAttachReturn.fromJsonValue(json);

class TagsCreateOptions {
  const TagsCreateOptions({this.description, this.kind, this.label, this.meta, this.source});

  final String? description;
  final String? kind;
  final String? label;
  final String? meta;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (meta != null) {
      into["meta"] = RaviJson.from(meta);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class TagsCreateReturn {
  const TagsCreateReturn({this.behaviorConsumers, this.binding, required this.changedCount, required this.status, this.tag, required this.target});

  final List<Map<String, RaviJson>>? behaviorConsumers;
  final Map<String, RaviJson>? binding;
  final double changedCount;
  final String status;
  final Map<String, RaviJson>? tag;
  final Map<String, RaviJson> target;

  factory TagsCreateReturn.fromJson(Map<String, Object?> json) {
    return TagsCreateReturn(
      behaviorConsumers: json["behaviorConsumers"] == null ? null : raviJsonAsList(json["behaviorConsumers"], raviJsonAsRaviJsonMap),
      binding: json["binding"] == null ? null : raviJsonAsRaviJsonMap(json["binding"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      tag: json["tag"] == null ? null : raviJsonAsRaviJsonMap(json["tag"]),
      target: raviJsonAsRaviJsonMap(json["target"]),
    );
  }

  static TagsCreateReturn fromJsonValue(Object? json) {
    return TagsCreateReturn.fromJson(raviJsonObject(json, "TagsCreateReturn"));
  }
}

TagsCreateReturn tagsCreateReturnFromJson(Object? json) => TagsCreateReturn.fromJsonValue(json);

class TagsDetachOptions {
  const TagsDetachOptions({this.agent, this.artifact, this.callProfile, this.callRequest, this.callTool, this.callVoiceAgent, this.chat, this.command, this.contact, this.cronJob, this.devinSession, this.hook, this.insight, this.instance, this.profile, this.project, this.route, this.session, this.skill, this.skillGateRule, this.source, this.target, this.task, this.taskAutomation, this.trigger, this.workflowNode, this.workflowRun, this.workflowSpec});

  final String? agent;
  final String? artifact;
  final String? callProfile;
  final String? callRequest;
  final String? callTool;
  final String? callVoiceAgent;
  final String? chat;
  final String? command;
  final String? contact;
  final String? cronJob;
  final String? devinSession;
  final String? hook;
  final String? insight;
  final String? instance;
  final String? profile;
  final String? project;
  final String? route;
  final String? session;
  final String? skill;
  final String? skillGateRule;
  final String? source;
  final String? target;
  final String? task;
  final String? taskAutomation;
  final String? trigger;
  final String? workflowNode;
  final String? workflowRun;
  final String? workflowSpec;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (artifact != null) {
      into["artifact"] = RaviJson.from(artifact);
    }
    if (callProfile != null) {
      into["callProfile"] = RaviJson.from(callProfile);
    }
    if (callRequest != null) {
      into["callRequest"] = RaviJson.from(callRequest);
    }
    if (callTool != null) {
      into["callTool"] = RaviJson.from(callTool);
    }
    if (callVoiceAgent != null) {
      into["callVoiceAgent"] = RaviJson.from(callVoiceAgent);
    }
    if (chat != null) {
      into["chat"] = RaviJson.from(chat);
    }
    if (command != null) {
      into["command"] = RaviJson.from(command);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (cronJob != null) {
      into["cronJob"] = RaviJson.from(cronJob);
    }
    if (devinSession != null) {
      into["devinSession"] = RaviJson.from(devinSession);
    }
    if (hook != null) {
      into["hook"] = RaviJson.from(hook);
    }
    if (insight != null) {
      into["insight"] = RaviJson.from(insight);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (route != null) {
      into["route"] = RaviJson.from(route);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (skill != null) {
      into["skill"] = RaviJson.from(skill);
    }
    if (skillGateRule != null) {
      into["skillGateRule"] = RaviJson.from(skillGateRule);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
    if (target != null) {
      into["target"] = RaviJson.from(target);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
    if (taskAutomation != null) {
      into["taskAutomation"] = RaviJson.from(taskAutomation);
    }
    if (trigger != null) {
      into["trigger"] = RaviJson.from(trigger);
    }
    if (workflowNode != null) {
      into["workflowNode"] = RaviJson.from(workflowNode);
    }
    if (workflowRun != null) {
      into["workflowRun"] = RaviJson.from(workflowRun);
    }
    if (workflowSpec != null) {
      into["workflowSpec"] = RaviJson.from(workflowSpec);
    }
  }
}

class TagsDetachReturn {
  const TagsDetachReturn({required this.changedCount, required this.status, required this.target});

  final double changedCount;
  final String status;
  final Map<String, RaviJson> target;

  factory TagsDetachReturn.fromJson(Map<String, Object?> json) {
    return TagsDetachReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: raviJsonAsRaviJsonMap(json["target"]),
    );
  }

  static TagsDetachReturn fromJsonValue(Object? json) {
    return TagsDetachReturn.fromJson(raviJsonObject(json, "TagsDetachReturn"));
  }
}

TagsDetachReturn tagsDetachReturnFromJson(Object? json) => TagsDetachReturn.fromJsonValue(json);

class TagsListOptions {
  const TagsListOptions({this.cursor, this.fields, this.kind, this.limit, this.order, this.query, this.sort, this.source});

  final String? cursor;
  final String? fields;
  final String? kind;
  final String? limit;
  final String? order;
  final String? query;
  final String? sort;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (order != null) {
      into["order"] = RaviJson.from(order);
    }
    if (query != null) {
      into["query"] = RaviJson.from(query);
    }
    if (sort != null) {
      into["sort"] = RaviJson.from(sort);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class TagsListReturn {
  const TagsListReturn({required this.filters, required this.items, required this.page, required this.tags, required this.total});

  final Map<String, RaviJson> filters;
  final List<Map<String, RaviJson>> items;
  final RaviJson page;
  final List<Map<String, RaviJson>> tags;
  final double total;

  factory TagsListReturn.fromJson(Map<String, Object?> json) {
    return TagsListReturn(
      filters: raviJsonAsRaviJsonMap(json["filters"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      page: RaviJson.from(json["page"]),
      tags: raviJsonAsList(json["tags"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static TagsListReturn fromJsonValue(Object? json) {
    return TagsListReturn.fromJson(raviJsonObject(json, "TagsListReturn"));
  }
}

TagsListReturn tagsListReturnFromJson(Object? json) => TagsListReturn.fromJsonValue(json);

class TagsSearchOptions {
  const TagsSearchOptions({this.agent, this.artifact, this.callProfile, this.callRequest, this.callTool, this.callVoiceAgent, this.chat, this.command, this.contact, this.cronJob, this.cursor, this.devinSession, this.fields, this.hook, this.insight, this.instance, this.kind, this.limit, this.order, this.profile, this.project, this.route, this.session, this.skill, this.skillGateRule, this.sort, this.source, this.tag, this.target, this.task, this.taskAutomation, this.trigger, this.workflowNode, this.workflowRun, this.workflowSpec});

  final String? agent;
  final String? artifact;
  final String? callProfile;
  final String? callRequest;
  final String? callTool;
  final String? callVoiceAgent;
  final String? chat;
  final String? command;
  final String? contact;
  final String? cronJob;
  final String? cursor;
  final String? devinSession;
  final String? fields;
  final String? hook;
  final String? insight;
  final String? instance;
  final String? kind;
  final String? limit;
  final String? order;
  final String? profile;
  final String? project;
  final String? route;
  final String? session;
  final String? skill;
  final String? skillGateRule;
  final String? sort;
  final String? source;
  final String? tag;
  final String? target;
  final String? task;
  final String? taskAutomation;
  final String? trigger;
  final String? workflowNode;
  final String? workflowRun;
  final String? workflowSpec;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (artifact != null) {
      into["artifact"] = RaviJson.from(artifact);
    }
    if (callProfile != null) {
      into["callProfile"] = RaviJson.from(callProfile);
    }
    if (callRequest != null) {
      into["callRequest"] = RaviJson.from(callRequest);
    }
    if (callTool != null) {
      into["callTool"] = RaviJson.from(callTool);
    }
    if (callVoiceAgent != null) {
      into["callVoiceAgent"] = RaviJson.from(callVoiceAgent);
    }
    if (chat != null) {
      into["chat"] = RaviJson.from(chat);
    }
    if (command != null) {
      into["command"] = RaviJson.from(command);
    }
    if (contact != null) {
      into["contact"] = RaviJson.from(contact);
    }
    if (cronJob != null) {
      into["cronJob"] = RaviJson.from(cronJob);
    }
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (devinSession != null) {
      into["devinSession"] = RaviJson.from(devinSession);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (hook != null) {
      into["hook"] = RaviJson.from(hook);
    }
    if (insight != null) {
      into["insight"] = RaviJson.from(insight);
    }
    if (instance != null) {
      into["instance"] = RaviJson.from(instance);
    }
    if (kind != null) {
      into["kind"] = RaviJson.from(kind);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (order != null) {
      into["order"] = RaviJson.from(order);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (route != null) {
      into["route"] = RaviJson.from(route);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (skill != null) {
      into["skill"] = RaviJson.from(skill);
    }
    if (skillGateRule != null) {
      into["skillGateRule"] = RaviJson.from(skillGateRule);
    }
    if (sort != null) {
      into["sort"] = RaviJson.from(sort);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
    if (target != null) {
      into["target"] = RaviJson.from(target);
    }
    if (task != null) {
      into["task"] = RaviJson.from(task);
    }
    if (taskAutomation != null) {
      into["taskAutomation"] = RaviJson.from(taskAutomation);
    }
    if (trigger != null) {
      into["trigger"] = RaviJson.from(trigger);
    }
    if (workflowNode != null) {
      into["workflowNode"] = RaviJson.from(workflowNode);
    }
    if (workflowRun != null) {
      into["workflowRun"] = RaviJson.from(workflowRun);
    }
    if (workflowSpec != null) {
      into["workflowSpec"] = RaviJson.from(workflowSpec);
    }
  }
}

class TagsSearchReturn {
  const TagsSearchReturn({required this.behaviorConsumers, required this.bindings, required this.filters, required this.items, required this.page, required this.total});

  final List<Map<String, RaviJson>> behaviorConsumers;
  final List<Map<String, RaviJson>> bindings;
  final Map<String, RaviJson> filters;
  final List<Map<String, RaviJson>> items;
  final RaviJson page;
  final double total;

  factory TagsSearchReturn.fromJson(Map<String, Object?> json) {
    return TagsSearchReturn(
      behaviorConsumers: raviJsonAsList(json["behaviorConsumers"], raviJsonAsRaviJsonMap),
      bindings: raviJsonAsList(json["bindings"], raviJsonAsRaviJsonMap),
      filters: raviJsonAsRaviJsonMap(json["filters"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      page: RaviJson.from(json["page"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static TagsSearchReturn fromJsonValue(Object? json) {
    return TagsSearchReturn.fromJson(raviJsonObject(json, "TagsSearchReturn"));
  }
}

TagsSearchReturn tagsSearchReturnFromJson(Object? json) => TagsSearchReturn.fromJsonValue(json);

class TagsSetReturn {
  const TagsSetReturn({this.behaviorConsumers, this.binding, required this.changedCount, required this.status, this.tag, required this.target});

  final List<Map<String, RaviJson>>? behaviorConsumers;
  final Map<String, RaviJson>? binding;
  final double changedCount;
  final String status;
  final Map<String, RaviJson>? tag;
  final Map<String, RaviJson> target;

  factory TagsSetReturn.fromJson(Map<String, Object?> json) {
    return TagsSetReturn(
      behaviorConsumers: json["behaviorConsumers"] == null ? null : raviJsonAsList(json["behaviorConsumers"], raviJsonAsRaviJsonMap),
      binding: json["binding"] == null ? null : raviJsonAsRaviJsonMap(json["binding"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      tag: json["tag"] == null ? null : raviJsonAsRaviJsonMap(json["tag"]),
      target: raviJsonAsRaviJsonMap(json["target"]),
    );
  }

  static TagsSetReturn fromJsonValue(Object? json) {
    return TagsSetReturn.fromJson(raviJsonObject(json, "TagsSetReturn"));
  }
}

TagsSetReturn tagsSetReturnFromJson(Object? json) => TagsSetReturn.fromJsonValue(json);

class TagsShowReturn {
  const TagsShowReturn({required this.behaviorConsumers, required this.bindings, required this.tag});

  final List<Map<String, RaviJson>> behaviorConsumers;
  final List<Map<String, RaviJson>> bindings;
  final Map<String, RaviJson> tag;

  factory TagsShowReturn.fromJson(Map<String, Object?> json) {
    return TagsShowReturn(
      behaviorConsumers: raviJsonAsList(json["behaviorConsumers"], raviJsonAsRaviJsonMap),
      bindings: raviJsonAsList(json["bindings"], raviJsonAsRaviJsonMap),
      tag: raviJsonAsRaviJsonMap(json["tag"]),
    );
  }

  static TagsShowReturn fromJsonValue(Object? json) {
    return TagsShowReturn.fromJson(raviJsonObject(json, "TagsShowReturn"));
  }
}

TagsShowReturn tagsShowReturnFromJson(Object? json) => TagsShowReturn.fromJsonValue(json);

class TasksArchiveOptions {
  const TasksArchiveOptions({this.reason});

  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

class TasksArchiveReturn {
  const TasksArchiveReturn({required this.event, required this.task});

  final Map<String, RaviJson> event;
  final Map<String, RaviJson> task;

  factory TasksArchiveReturn.fromJson(Map<String, Object?> json) {
    return TasksArchiveReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksArchiveReturn fromJsonValue(Object? json) {
    return TasksArchiveReturn.fromJson(raviJsonObject(json, "TasksArchiveReturn"));
  }
}

TasksArchiveReturn tasksArchiveReturnFromJson(Object? json) => TasksArchiveReturn.fromJsonValue(json);

class TasksAutomationsAddOptions {
  const TasksAutomationsAddOptions({this.agent, this.checkpoint, this.detached, this.disabled, this.filter, this.freshCheckpoint, this.freshReportEvents, this.freshReportTo, this.freshWorktree, this.input, this.instructions, this.on, this.priority, this.profile, this.reportEvents, this.reportTo, this.session, this.title});

  final String? agent;
  final String? checkpoint;
  final bool? detached;
  final bool? disabled;
  final String? filter;
  final bool? freshCheckpoint;
  final bool? freshReportEvents;
  final bool? freshReportTo;
  final bool? freshWorktree;
  final List<String>? input;
  final String? instructions;
  final String? on;
  final String? priority;
  final String? profile;
  final String? reportEvents;
  final String? reportTo;
  final String? session;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (checkpoint != null) {
      into["checkpoint"] = RaviJson.from(checkpoint);
    }
    if (detached != null) {
      into["detached"] = RaviJson.from(detached);
    }
    if (disabled != null) {
      into["disabled"] = RaviJson.from(disabled);
    }
    if (filter != null) {
      into["filter"] = RaviJson.from(filter);
    }
    if (freshCheckpoint != null) {
      into["freshCheckpoint"] = RaviJson.from(freshCheckpoint);
    }
    if (freshReportEvents != null) {
      into["freshReportEvents"] = RaviJson.from(freshReportEvents);
    }
    if (freshReportTo != null) {
      into["freshReportTo"] = RaviJson.from(freshReportTo);
    }
    if (freshWorktree != null) {
      into["freshWorktree"] = RaviJson.from(freshWorktree);
    }
    if (input != null) {
      into["input"] = RaviJson.from(input);
    }
    if (instructions != null) {
      into["instructions"] = RaviJson.from(instructions);
    }
    if (on != null) {
      into["on"] = RaviJson.from(on);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (reportEvents != null) {
      into["reportEvents"] = RaviJson.from(reportEvents);
    }
    if (reportTo != null) {
      into["reportTo"] = RaviJson.from(reportTo);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class TasksAutomationsAddReturn {
  const TasksAutomationsAddReturn({required this.automation, required this.changedCount, required this.status, required this.target});

  final Map<String, RaviJson> automation;
  final double changedCount;
  final String status;
  final RaviJson target;

  factory TasksAutomationsAddReturn.fromJson(Map<String, Object?> json) {
    return TasksAutomationsAddReturn(
      automation: raviJsonAsRaviJsonMap(json["automation"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static TasksAutomationsAddReturn fromJsonValue(Object? json) {
    return TasksAutomationsAddReturn.fromJson(raviJsonObject(json, "TasksAutomationsAddReturn"));
  }
}

TasksAutomationsAddReturn tasksAutomationsAddReturnFromJson(Object? json) => TasksAutomationsAddReturn.fromJsonValue(json);

class TasksAutomationsDisableReturn {
  const TasksAutomationsDisableReturn({required this.automation, required this.changedCount, required this.status, required this.target});

  final Map<String, RaviJson> automation;
  final double changedCount;
  final String status;
  final RaviJson target;

  factory TasksAutomationsDisableReturn.fromJson(Map<String, Object?> json) {
    return TasksAutomationsDisableReturn(
      automation: raviJsonAsRaviJsonMap(json["automation"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static TasksAutomationsDisableReturn fromJsonValue(Object? json) {
    return TasksAutomationsDisableReturn.fromJson(raviJsonObject(json, "TasksAutomationsDisableReturn"));
  }
}

TasksAutomationsDisableReturn tasksAutomationsDisableReturnFromJson(Object? json) => TasksAutomationsDisableReturn.fromJsonValue(json);

class TasksAutomationsEnableReturn {
  const TasksAutomationsEnableReturn({required this.automation, required this.changedCount, required this.status, required this.target});

  final Map<String, RaviJson> automation;
  final double changedCount;
  final String status;
  final RaviJson target;

  factory TasksAutomationsEnableReturn.fromJson(Map<String, Object?> json) {
    return TasksAutomationsEnableReturn(
      automation: raviJsonAsRaviJsonMap(json["automation"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static TasksAutomationsEnableReturn fromJsonValue(Object? json) {
    return TasksAutomationsEnableReturn.fromJson(raviJsonObject(json, "TasksAutomationsEnableReturn"));
  }
}

TasksAutomationsEnableReturn tasksAutomationsEnableReturnFromJson(Object? json) => TasksAutomationsEnableReturn.fromJsonValue(json);

class TasksAutomationsListOptions {
  const TasksAutomationsListOptions({this.limit, this.offset, this.tag});

  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class TasksAutomationsListReturn {
  const TasksAutomationsListReturn({required this.automations, required this.filters, required this.items, required this.pagination, required this.total});

  final List<Map<String, RaviJson>> automations;
  final Map<String, RaviJson> filters;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;

  factory TasksAutomationsListReturn.fromJson(Map<String, Object?> json) {
    return TasksAutomationsListReturn(
      automations: raviJsonAsList(json["automations"], raviJsonAsRaviJsonMap),
      filters: raviJsonAsRaviJsonMap(json["filters"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static TasksAutomationsListReturn fromJsonValue(Object? json) {
    return TasksAutomationsListReturn.fromJson(raviJsonObject(json, "TasksAutomationsListReturn"));
  }
}

TasksAutomationsListReturn tasksAutomationsListReturnFromJson(Object? json) => TasksAutomationsListReturn.fromJsonValue(json);

class TasksAutomationsRmOptions {
  const TasksAutomationsRmOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class TasksAutomationsRmReturn {
  const TasksAutomationsRmReturn({required this.automation, required this.changedCount, required this.status, required this.target});

  final Map<String, RaviJson> automation;
  final double changedCount;
  final String status;
  final RaviJson target;

  factory TasksAutomationsRmReturn.fromJson(Map<String, Object?> json) {
    return TasksAutomationsRmReturn(
      automation: raviJsonAsRaviJsonMap(json["automation"]),
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
    );
  }

  static TasksAutomationsRmReturn fromJsonValue(Object? json) {
    return TasksAutomationsRmReturn.fromJson(raviJsonObject(json, "TasksAutomationsRmReturn"));
  }
}

TasksAutomationsRmReturn tasksAutomationsRmReturnFromJson(Object? json) => TasksAutomationsRmReturn.fromJsonValue(json);

class TasksAutomationsShowReturn {
  const TasksAutomationsShowReturn({required this.automation, required this.runs});

  final Map<String, RaviJson> automation;
  final List<Map<String, RaviJson>> runs;

  factory TasksAutomationsShowReturn.fromJson(Map<String, Object?> json) {
    return TasksAutomationsShowReturn(
      automation: raviJsonAsRaviJsonMap(json["automation"]),
      runs: raviJsonAsList(json["runs"], raviJsonAsRaviJsonMap),
    );
  }

  static TasksAutomationsShowReturn fromJsonValue(Object? json) {
    return TasksAutomationsShowReturn.fromJson(raviJsonObject(json, "TasksAutomationsShowReturn"));
  }
}

TasksAutomationsShowReturn tasksAutomationsShowReturnFromJson(Object? json) => TasksAutomationsShowReturn.fromJsonValue(json);

class TasksBlockOptions {
  const TasksBlockOptions({this.reason});

  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

class TasksBlockReturn {
  const TasksBlockReturn({required this.event, required this.task});

  final Map<String, RaviJson> event;
  final Map<String, RaviJson> task;

  factory TasksBlockReturn.fromJson(Map<String, Object?> json) {
    return TasksBlockReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksBlockReturn fromJsonValue(Object? json) {
    return TasksBlockReturn.fromJson(raviJsonObject(json, "TasksBlockReturn"));
  }
}

TasksBlockReturn tasksBlockReturnFromJson(Object? json) => TasksBlockReturn.fromJsonValue(json);

class TasksCommentReturn {
  const TasksCommentReturn({required this.comment, required this.event, required this.task});

  final Map<String, RaviJson> comment;
  final Map<String, RaviJson> event;
  final Map<String, RaviJson> task;

  factory TasksCommentReturn.fromJson(Map<String, Object?> json) {
    return TasksCommentReturn(
      comment: raviJsonAsRaviJsonMap(json["comment"]),
      event: raviJsonAsRaviJsonMap(json["event"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksCommentReturn fromJsonValue(Object? json) {
    return TasksCommentReturn.fromJson(raviJsonObject(json, "TasksCommentReturn"));
  }
}

TasksCommentReturn tasksCommentReturnFromJson(Object? json) => TasksCommentReturn.fromJsonValue(json);

class TasksCreateOptions {
  const TasksCreateOptions({this.agent, this.assignee, this.checkpoint, this.dependsOn, this.effort, this.input, this.instructions, this.model, this.parent, this.priority, this.profile, this.reportEvents, this.reportTo, this.session, this.tag, this.thinking, this.worktreeBranch, this.worktreeMode, this.worktreePath});

  final String? agent;
  final String? assignee;
  final String? checkpoint;
  final List<String>? dependsOn;
  final String? effort;
  final List<String>? input;
  final String? instructions;
  final String? model;
  final String? parent;
  final String? priority;
  final String? profile;
  final String? reportEvents;
  final String? reportTo;
  final String? session;
  final List<String>? tag;
  final String? thinking;
  final String? worktreeBranch;
  final String? worktreeMode;
  final String? worktreePath;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (assignee != null) {
      into["assignee"] = RaviJson.from(assignee);
    }
    if (checkpoint != null) {
      into["checkpoint"] = RaviJson.from(checkpoint);
    }
    if (dependsOn != null) {
      into["dependsOn"] = RaviJson.from(dependsOn);
    }
    if (effort != null) {
      into["effort"] = RaviJson.from(effort);
    }
    if (input != null) {
      into["input"] = RaviJson.from(input);
    }
    if (instructions != null) {
      into["instructions"] = RaviJson.from(instructions);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (parent != null) {
      into["parent"] = RaviJson.from(parent);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (reportEvents != null) {
      into["reportEvents"] = RaviJson.from(reportEvents);
    }
    if (reportTo != null) {
      into["reportTo"] = RaviJson.from(reportTo);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
    if (thinking != null) {
      into["thinking"] = RaviJson.from(thinking);
    }
    if (worktreeBranch != null) {
      into["worktreeBranch"] = RaviJson.from(worktreeBranch);
    }
    if (worktreeMode != null) {
      into["worktreeMode"] = RaviJson.from(worktreeMode);
    }
    if (worktreePath != null) {
      into["worktreePath"] = RaviJson.from(worktreePath);
    }
  }
}

class TasksCreateReturn {
  const TasksCreateReturn({required this.dependencies, required this.dependents, required this.event, required this.launchPlan, required this.parentTaskId, required this.readiness, required this.relatedEvents, required this.task, required this.taskProfile});

  final List<Map<String, RaviJson>> dependencies;
  final List<Map<String, RaviJson>> dependents;
  final Map<String, RaviJson> event;
  final RaviJson launchPlan;
  final RaviJson parentTaskId;
  final Map<String, RaviJson> readiness;
  final List<Map<String, RaviJson>> relatedEvents;
  final Map<String, RaviJson> task;
  final Map<String, RaviJson> taskProfile;

  factory TasksCreateReturn.fromJson(Map<String, Object?> json) {
    return TasksCreateReturn(
      dependencies: raviJsonAsList(json["dependencies"], raviJsonAsRaviJsonMap),
      dependents: raviJsonAsList(json["dependents"], raviJsonAsRaviJsonMap),
      event: raviJsonAsRaviJsonMap(json["event"]),
      launchPlan: RaviJson.from(json["launchPlan"]),
      parentTaskId: RaviJson.from(json["parentTaskId"]),
      readiness: raviJsonAsRaviJsonMap(json["readiness"]),
      relatedEvents: raviJsonAsList(json["relatedEvents"], raviJsonAsRaviJsonMap),
      task: raviJsonAsRaviJsonMap(json["task"]),
      taskProfile: raviJsonAsRaviJsonMap(json["taskProfile"]),
    );
  }

  static TasksCreateReturn fromJsonValue(Object? json) {
    return TasksCreateReturn.fromJson(raviJsonObject(json, "TasksCreateReturn"));
  }
}

TasksCreateReturn tasksCreateReturnFromJson(Object? json) => TasksCreateReturn.fromJsonValue(json);

class TasksDepsAddReturn {
  const TasksDepsAddReturn({required this.event, required this.task});

  final Map<String, RaviJson> event;
  final Map<String, RaviJson> task;

  factory TasksDepsAddReturn.fromJson(Map<String, Object?> json) {
    return TasksDepsAddReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksDepsAddReturn fromJsonValue(Object? json) {
    return TasksDepsAddReturn.fromJson(raviJsonObject(json, "TasksDepsAddReturn"));
  }
}

TasksDepsAddReturn tasksDepsAddReturnFromJson(Object? json) => TasksDepsAddReturn.fromJsonValue(json);

class TasksDepsLsOptions {
  const TasksDepsLsOptions({this.limit, this.offset});

  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class TasksDepsLsReturn {
  const TasksDepsLsReturn({required this.dependencies, required this.dependents, required this.items, required this.launchPlan, required this.pagination, required this.readiness, required this.taskId, required this.total});

  final List<Map<String, RaviJson>> dependencies;
  final List<Map<String, RaviJson>> dependents;
  final List<Map<String, RaviJson>> items;
  final RaviJson launchPlan;
  final RaviJson pagination;
  final Map<String, RaviJson> readiness;
  final String taskId;
  final double total;

  factory TasksDepsLsReturn.fromJson(Map<String, Object?> json) {
    return TasksDepsLsReturn(
      dependencies: raviJsonAsList(json["dependencies"], raviJsonAsRaviJsonMap),
      dependents: raviJsonAsList(json["dependents"], raviJsonAsRaviJsonMap),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      launchPlan: RaviJson.from(json["launchPlan"]),
      pagination: RaviJson.from(json["pagination"]),
      readiness: raviJsonAsRaviJsonMap(json["readiness"]),
      taskId: raviJsonAsString(json["taskId"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static TasksDepsLsReturn fromJsonValue(Object? json) {
    return TasksDepsLsReturn.fromJson(raviJsonObject(json, "TasksDepsLsReturn"));
  }
}

TasksDepsLsReturn tasksDepsLsReturnFromJson(Object? json) => TasksDepsLsReturn.fromJsonValue(json);

class TasksDepsRmOptions {
  const TasksDepsRmOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class TasksDepsRmReturn {
  const TasksDepsRmReturn({required this.event, required this.task});

  final Map<String, RaviJson> event;
  final Map<String, RaviJson> task;

  factory TasksDepsRmReturn.fromJson(Map<String, Object?> json) {
    return TasksDepsRmReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksDepsRmReturn fromJsonValue(Object? json) {
    return TasksDepsRmReturn.fromJson(raviJsonObject(json, "TasksDepsRmReturn"));
  }
}

TasksDepsRmReturn tasksDepsRmReturnFromJson(Object? json) => TasksDepsRmReturn.fromJsonValue(json);

class TasksDispatchOptions {
  const TasksDispatchOptions({this.actorSession, this.agent, this.checkpoint, this.effort, this.execute, this.model, this.reportEvents, this.reportTo, this.session, this.thinking});

  final String? actorSession;
  final String? agent;
  final String? checkpoint;
  final String? effort;
  final bool? execute;
  final String? model;
  final String? reportEvents;
  final String? reportTo;
  final String? session;
  final String? thinking;

  void encodeBody(Map<String, RaviJson> into) {
    if (actorSession != null) {
      into["actorSession"] = RaviJson.from(actorSession);
    }
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (checkpoint != null) {
      into["checkpoint"] = RaviJson.from(checkpoint);
    }
    if (effort != null) {
      into["effort"] = RaviJson.from(effort);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (model != null) {
      into["model"] = RaviJson.from(model);
    }
    if (reportEvents != null) {
      into["reportEvents"] = RaviJson.from(reportEvents);
    }
    if (reportTo != null) {
      into["reportTo"] = RaviJson.from(reportTo);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (thinking != null) {
      into["thinking"] = RaviJson.from(thinking);
    }
  }
}

class TasksDispatchReturn {
  const TasksDispatchReturn({required this.event, required this.mode, this.readiness, required this.task});

  final Map<String, RaviJson> event;
  final String mode;
  final Map<String, RaviJson>? readiness;
  final Map<String, RaviJson> task;

  factory TasksDispatchReturn.fromJson(Map<String, Object?> json) {
    return TasksDispatchReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      mode: raviJsonAsString(json["mode"]),
      readiness: json["readiness"] == null ? null : raviJsonAsRaviJsonMap(json["readiness"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksDispatchReturn fromJsonValue(Object? json) {
    return TasksDispatchReturn.fromJson(raviJsonObject(json, "TasksDispatchReturn"));
  }
}

TasksDispatchReturn tasksDispatchReturnFromJson(Object? json) => TasksDispatchReturn.fromJsonValue(json);

class TasksDoneOptions {
  const TasksDoneOptions({this.summary});

  final String? summary;

  void encodeBody(Map<String, RaviJson> into) {
    if (summary != null) {
      into["summary"] = RaviJson.from(summary);
    }
  }
}

class TasksDoneReturn {
  const TasksDoneReturn({required this.event, required this.task});

  final Map<String, RaviJson> event;
  final Map<String, RaviJson> task;

  factory TasksDoneReturn.fromJson(Map<String, Object?> json) {
    return TasksDoneReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksDoneReturn fromJsonValue(Object? json) {
    return TasksDoneReturn.fromJson(raviJsonObject(json, "TasksDoneReturn"));
  }
}

TasksDoneReturn tasksDoneReturnFromJson(Object? json) => TasksDoneReturn.fromJsonValue(json);

class TasksFailOptions {
  const TasksFailOptions({this.reason});

  final String? reason;

  void encodeBody(Map<String, RaviJson> into) {
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
  }
}

class TasksFailReturn {
  const TasksFailReturn({required this.event, required this.task});

  final Map<String, RaviJson> event;
  final Map<String, RaviJson> task;

  factory TasksFailReturn.fromJson(Map<String, Object?> json) {
    return TasksFailReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksFailReturn fromJsonValue(Object? json) {
    return TasksFailReturn.fromJson(raviJsonObject(json, "TasksFailReturn"));
  }
}

TasksFailReturn tasksFailReturnFromJson(Object? json) => TasksFailReturn.fromJsonValue(json);

class TasksListOptions {
  const TasksListOptions({this.agent, this.all, this.allTime, this.archived, this.cursor, this.fields, this.last, this.limit, this.mine, this.order, this.parent, this.profile, this.root, this.roots, this.session, this.since, this.sort, this.status, this.tag, this.text, this.until});

  final String? agent;
  final bool? all;
  final bool? allTime;
  final bool? archived;
  final String? cursor;
  final String? fields;
  final String? last;
  final String? limit;
  final bool? mine;
  final String? order;
  final String? parent;
  final String? profile;
  final String? root;
  final bool? roots;
  final String? session;
  final String? since;
  final String? sort;
  final String? status;
  final String? tag;
  final String? text;
  final String? until;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (all != null) {
      into["all"] = RaviJson.from(all);
    }
    if (allTime != null) {
      into["allTime"] = RaviJson.from(allTime);
    }
    if (archived != null) {
      into["archived"] = RaviJson.from(archived);
    }
    if (cursor != null) {
      into["cursor"] = RaviJson.from(cursor);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (last != null) {
      into["last"] = RaviJson.from(last);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (mine != null) {
      into["mine"] = RaviJson.from(mine);
    }
    if (order != null) {
      into["order"] = RaviJson.from(order);
    }
    if (parent != null) {
      into["parent"] = RaviJson.from(parent);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (root != null) {
      into["root"] = RaviJson.from(root);
    }
    if (roots != null) {
      into["roots"] = RaviJson.from(roots);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (since != null) {
      into["since"] = RaviJson.from(since);
    }
    if (sort != null) {
      into["sort"] = RaviJson.from(sort);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
    if (text != null) {
      into["text"] = RaviJson.from(text);
    }
    if (until != null) {
      into["until"] = RaviJson.from(until);
    }
  }
}

class TasksListReturn {
  const TasksListReturn({required this.archiveMode, required this.filters, required this.items, required this.limit, required this.page, required this.tasks, required this.total});

  final String archiveMode;
  final Map<String, RaviJson> filters;
  final List<Map<String, RaviJson>> items;
  final RaviJson limit;
  final Map<String, RaviJson> page;
  final List<Map<String, RaviJson>> tasks;
  final double total;

  factory TasksListReturn.fromJson(Map<String, Object?> json) {
    return TasksListReturn(
      archiveMode: raviJsonAsString(json["archiveMode"]),
      filters: raviJsonAsRaviJsonMap(json["filters"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      limit: RaviJson.from(json["limit"]),
      page: raviJsonAsRaviJsonMap(json["page"]),
      tasks: raviJsonAsList(json["tasks"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static TasksListReturn fromJsonValue(Object? json) {
    return TasksListReturn.fromJson(raviJsonObject(json, "TasksListReturn"));
  }
}

TasksListReturn tasksListReturnFromJson(Object? json) => TasksListReturn.fromJsonValue(json);

class TasksProfilesInitOptions {
  const TasksProfilesInitOptions({this.preset, this.source});

  final String? preset;
  final String? source;

  void encodeBody(Map<String, RaviJson> into) {
    if (preset != null) {
      into["preset"] = RaviJson.from(preset);
    }
    if (source != null) {
      into["source"] = RaviJson.from(source);
    }
  }
}

class TasksProfilesInitReturn {
  const TasksProfilesInitReturn({required this.manifestPath, required this.profileDir, required this.sourceKind});

  final String manifestPath;
  final String profileDir;
  final String sourceKind;

  factory TasksProfilesInitReturn.fromJson(Map<String, Object?> json) {
    return TasksProfilesInitReturn(
      manifestPath: raviJsonAsString(json["manifestPath"]),
      profileDir: raviJsonAsString(json["profileDir"]),
      sourceKind: raviJsonAsString(json["sourceKind"]),
    );
  }

  static TasksProfilesInitReturn fromJsonValue(Object? json) {
    return TasksProfilesInitReturn.fromJson(raviJsonObject(json, "TasksProfilesInitReturn"));
  }
}

TasksProfilesInitReturn tasksProfilesInitReturnFromJson(Object? json) => TasksProfilesInitReturn.fromJsonValue(json);

class TasksProfilesListOptions {
  const TasksProfilesListOptions({this.limit, this.offset});

  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class TasksProfilesListReturn {
  const TasksProfilesListReturn({required this.items, required this.pagination, required this.profiles, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> profiles;
  final double total;

  factory TasksProfilesListReturn.fromJson(Map<String, Object?> json) {
    return TasksProfilesListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      profiles: raviJsonAsList(json["profiles"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static TasksProfilesListReturn fromJsonValue(Object? json) {
    return TasksProfilesListReturn.fromJson(raviJsonObject(json, "TasksProfilesListReturn"));
  }
}

TasksProfilesListReturn tasksProfilesListReturnFromJson(Object? json) => TasksProfilesListReturn.fromJsonValue(json);

class TasksProfilesPreviewOptions {
  const TasksProfilesPreviewOptions({this.agent, this.input, this.instructions, this.session, this.title, this.worktreeBranch, this.worktreeMode, this.worktreePath});

  final String? agent;
  final List<String>? input;
  final String? instructions;
  final String? session;
  final String? title;
  final String? worktreeBranch;
  final String? worktreeMode;
  final String? worktreePath;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (input != null) {
      into["input"] = RaviJson.from(input);
    }
    if (instructions != null) {
      into["instructions"] = RaviJson.from(instructions);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
    if (worktreeBranch != null) {
      into["worktreeBranch"] = RaviJson.from(worktreeBranch);
    }
    if (worktreeMode != null) {
      into["worktreeMode"] = RaviJson.from(worktreeMode);
    }
    if (worktreePath != null) {
      into["worktreePath"] = RaviJson.from(worktreePath);
    }
  }
}

class TasksProfilesPreviewReturn {
  const TasksProfilesPreviewReturn({required this.profile, required this.rendered});

  final Map<String, RaviJson> profile;
  final Map<String, RaviJson> rendered;

  factory TasksProfilesPreviewReturn.fromJson(Map<String, Object?> json) {
    return TasksProfilesPreviewReturn(
      profile: raviJsonAsRaviJsonMap(json["profile"]),
      rendered: raviJsonAsRaviJsonMap(json["rendered"]),
    );
  }

  static TasksProfilesPreviewReturn fromJsonValue(Object? json) {
    return TasksProfilesPreviewReturn.fromJson(raviJsonObject(json, "TasksProfilesPreviewReturn"));
  }
}

TasksProfilesPreviewReturn tasksProfilesPreviewReturnFromJson(Object? json) => TasksProfilesPreviewReturn.fromJsonValue(json);

typedef TasksProfilesShowReturn = Map<String, RaviJson>;

TasksProfilesShowReturn tasksProfilesShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class TasksProfilesValidateReturn {
  const TasksProfilesValidateReturn({required this.results, required this.valid});

  final List<Map<String, RaviJson>> results;
  final bool valid;

  factory TasksProfilesValidateReturn.fromJson(Map<String, Object?> json) {
    return TasksProfilesValidateReturn(
      results: raviJsonAsList(json["results"], raviJsonAsRaviJsonMap),
      valid: raviJsonAsBool(json["valid"]),
    );
  }

  static TasksProfilesValidateReturn fromJsonValue(Object? json) {
    return TasksProfilesValidateReturn.fromJson(raviJsonObject(json, "TasksProfilesValidateReturn"));
  }
}

TasksProfilesValidateReturn tasksProfilesValidateReturnFromJson(Object? json) => TasksProfilesValidateReturn.fromJsonValue(json);

class TasksReportOptions {
  const TasksReportOptions({this.message, this.progress});

  final String? message;
  final String? progress;

  void encodeBody(Map<String, RaviJson> into) {
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (progress != null) {
      into["progress"] = RaviJson.from(progress);
    }
  }
}

class TasksReportReturn {
  const TasksReportReturn({required this.event, required this.task});

  final Map<String, RaviJson> event;
  final Map<String, RaviJson> task;

  factory TasksReportReturn.fromJson(Map<String, Object?> json) {
    return TasksReportReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksReportReturn fromJsonValue(Object? json) {
    return TasksReportReturn.fromJson(raviJsonObject(json, "TasksReportReturn"));
  }
}

TasksReportReturn tasksReportReturnFromJson(Object? json) => TasksReportReturn.fromJsonValue(json);

class TasksShowOptions {
  const TasksShowOptions({this.last});

  final String? last;

  void encodeBody(Map<String, RaviJson> into) {
    if (last != null) {
      into["last"] = RaviJson.from(last);
    }
  }
}

class TasksShowReturn {
  const TasksShowReturn({required this.comments, required this.dependencies, required this.dependents, required this.events, required this.historyLimit, required this.launchPlan, required this.readiness, required this.task});

  final List<Map<String, RaviJson>> comments;
  final List<Map<String, RaviJson>> dependencies;
  final List<Map<String, RaviJson>> dependents;
  final List<Map<String, RaviJson>> events;
  final RaviJson historyLimit;
  final RaviJson launchPlan;
  final Map<String, RaviJson> readiness;
  final Map<String, RaviJson> task;

  factory TasksShowReturn.fromJson(Map<String, Object?> json) {
    return TasksShowReturn(
      comments: raviJsonAsList(json["comments"], raviJsonAsRaviJsonMap),
      dependencies: raviJsonAsList(json["dependencies"], raviJsonAsRaviJsonMap),
      dependents: raviJsonAsList(json["dependents"], raviJsonAsRaviJsonMap),
      events: raviJsonAsList(json["events"], raviJsonAsRaviJsonMap),
      historyLimit: RaviJson.from(json["historyLimit"]),
      launchPlan: RaviJson.from(json["launchPlan"]),
      readiness: raviJsonAsRaviJsonMap(json["readiness"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksShowReturn fromJsonValue(Object? json) {
    return TasksShowReturn.fromJson(raviJsonObject(json, "TasksShowReturn"));
  }
}

TasksShowReturn tasksShowReturnFromJson(Object? json) => TasksShowReturn.fromJsonValue(json);

class TasksUnarchiveReturn {
  const TasksUnarchiveReturn({required this.event, required this.task});

  final Map<String, RaviJson> event;
  final Map<String, RaviJson> task;

  factory TasksUnarchiveReturn.fromJson(Map<String, Object?> json) {
    return TasksUnarchiveReturn(
      event: raviJsonAsRaviJsonMap(json["event"]),
      task: raviJsonAsRaviJsonMap(json["task"]),
    );
  }

  static TasksUnarchiveReturn fromJsonValue(Object? json) {
    return TasksUnarchiveReturn.fromJson(raviJsonObject(json, "TasksUnarchiveReturn"));
  }
}

TasksUnarchiveReturn tasksUnarchiveReturnFromJson(Object? json) => TasksUnarchiveReturn.fromJsonValue(json);

class ThreadsBriefOptions {
  const ThreadsBriefOptions({this.scope});

  final String? scope;

  void encodeBody(Map<String, RaviJson> into) {
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
  }
}

class ThreadsBriefReturn {
  const ThreadsBriefReturn({required this.action, required this.brief, required this.thread});

  final String action;
  final Map<String, RaviJson> brief;
  final Map<String, RaviJson> thread;

  factory ThreadsBriefReturn.fromJson(Map<String, Object?> json) {
    return ThreadsBriefReturn(
      action: raviJsonAsString(json["action"]),
      brief: raviJsonAsRaviJsonMap(json["brief"]),
      thread: raviJsonAsRaviJsonMap(json["thread"]),
    );
  }

  static ThreadsBriefReturn fromJsonValue(Object? json) {
    return ThreadsBriefReturn.fromJson(raviJsonObject(json, "ThreadsBriefReturn"));
  }
}

ThreadsBriefReturn threadsBriefReturnFromJson(Object? json) => ThreadsBriefReturn.fromJsonValue(json);

class ThreadsCloseOptions {
  const ThreadsCloseOptions({this.reason, this.scope});

  final String? reason;
  final String? scope;

  void encodeBody(Map<String, RaviJson> into) {
    if (reason != null) {
      into["reason"] = RaviJson.from(reason);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
  }
}

class ThreadsCloseReturn {
  const ThreadsCloseReturn({required this.action, required this.thread});

  final String action;
  final Map<String, RaviJson> thread;

  factory ThreadsCloseReturn.fromJson(Map<String, Object?> json) {
    return ThreadsCloseReturn(
      action: raviJsonAsString(json["action"]),
      thread: raviJsonAsRaviJsonMap(json["thread"]),
    );
  }

  static ThreadsCloseReturn fromJsonValue(Object? json) {
    return ThreadsCloseReturn.fromJson(raviJsonObject(json, "ThreadsCloseReturn"));
  }
}

ThreadsCloseReturn threadsCloseReturnFromJson(Object? json) => ThreadsCloseReturn.fromJsonValue(json);

class ThreadsCommentOptions {
  const ThreadsCommentOptions({this.scope, this.visibility});

  final String? scope;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class ThreadsCommentReturn {
  const ThreadsCommentReturn({required this.action, required this.entry, required this.thread});

  final String action;
  final Map<String, RaviJson> entry;
  final Map<String, RaviJson> thread;

  factory ThreadsCommentReturn.fromJson(Map<String, Object?> json) {
    return ThreadsCommentReturn(
      action: raviJsonAsString(json["action"]),
      entry: raviJsonAsRaviJsonMap(json["entry"]),
      thread: raviJsonAsRaviJsonMap(json["thread"]),
    );
  }

  static ThreadsCommentReturn fromJsonValue(Object? json) {
    return ThreadsCommentReturn.fromJson(raviJsonObject(json, "ThreadsCommentReturn"));
  }
}

ThreadsCommentReturn threadsCommentReturnFromJson(Object? json) => ThreadsCommentReturn.fromJsonValue(json);

class ThreadsCreateOptions {
  const ThreadsCreateOptions({this.defaultAgent, this.owner, this.scope, this.status, this.summary, this.title});

  final String? defaultAgent;
  final String? owner;
  final String? scope;
  final String? status;
  final String? summary;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (defaultAgent != null) {
      into["defaultAgent"] = RaviJson.from(defaultAgent);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
    if (summary != null) {
      into["summary"] = RaviJson.from(summary);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class ThreadsCreateReturn {
  const ThreadsCreateReturn({required this.action, required this.thread});

  final String action;
  final Map<String, RaviJson> thread;

  factory ThreadsCreateReturn.fromJson(Map<String, Object?> json) {
    return ThreadsCreateReturn(
      action: raviJsonAsString(json["action"]),
      thread: raviJsonAsRaviJsonMap(json["thread"]),
    );
  }

  static ThreadsCreateReturn fromJsonValue(Object? json) {
    return ThreadsCreateReturn.fromJson(raviJsonObject(json, "ThreadsCreateReturn"));
  }
}

ThreadsCreateReturn threadsCreateReturnFromJson(Object? json) => ThreadsCreateReturn.fromJsonValue(json);

class ThreadsEntriesOptions {
  const ThreadsEntriesOptions({this.limit, this.offset, this.scope});

  final String? limit;
  final String? offset;
  final String? scope;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
  }
}

class ThreadsEntriesReturn {
  const ThreadsEntriesReturn({required this.action, required this.entries, required this.thread});

  final String action;
  final List<Map<String, RaviJson>> entries;
  final Map<String, RaviJson> thread;

  factory ThreadsEntriesReturn.fromJson(Map<String, Object?> json) {
    return ThreadsEntriesReturn(
      action: raviJsonAsString(json["action"]),
      entries: raviJsonAsList(json["entries"], raviJsonAsRaviJsonMap),
      thread: raviJsonAsRaviJsonMap(json["thread"]),
    );
  }

  static ThreadsEntriesReturn fromJsonValue(Object? json) {
    return ThreadsEntriesReturn.fromJson(raviJsonObject(json, "ThreadsEntriesReturn"));
  }
}

ThreadsEntriesReturn threadsEntriesReturnFromJson(Object? json) => ThreadsEntriesReturn.fromJsonValue(json);

class ThreadsLinkOptions {
  const ThreadsLinkOptions({this.label, this.role, this.scope, this.visibility});

  final String? label;
  final String? role;
  final String? scope;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (label != null) {
      into["label"] = RaviJson.from(label);
    }
    if (role != null) {
      into["role"] = RaviJson.from(role);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class ThreadsLinkReturn {
  const ThreadsLinkReturn({required this.action, required this.link, required this.thread});

  final String action;
  final Map<String, RaviJson> link;
  final Map<String, RaviJson> thread;

  factory ThreadsLinkReturn.fromJson(Map<String, Object?> json) {
    return ThreadsLinkReturn(
      action: raviJsonAsString(json["action"]),
      link: raviJsonAsRaviJsonMap(json["link"]),
      thread: raviJsonAsRaviJsonMap(json["thread"]),
    );
  }

  static ThreadsLinkReturn fromJsonValue(Object? json) {
    return ThreadsLinkReturn.fromJson(raviJsonObject(json, "ThreadsLinkReturn"));
  }
}

ThreadsLinkReturn threadsLinkReturnFromJson(Object? json) => ThreadsLinkReturn.fromJsonValue(json);

class ThreadsListOptions {
  const ThreadsListOptions({this.fields, this.limit, this.offset, this.owner, this.scope, this.search, this.status});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? owner;
  final String? scope;
  final String? search;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (owner != null) {
      into["owner"] = RaviJson.from(owner);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (search != null) {
      into["search"] = RaviJson.from(search);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class ThreadsListReturn {
  const ThreadsListReturn({required this.action, required this.items, required this.pagination});

  final String action;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;

  factory ThreadsListReturn.fromJson(Map<String, Object?> json) {
    return ThreadsListReturn(
      action: raviJsonAsString(json["action"]),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
    );
  }

  static ThreadsListReturn fromJsonValue(Object? json) {
    return ThreadsListReturn.fromJson(raviJsonObject(json, "ThreadsListReturn"));
  }
}

ThreadsListReturn threadsListReturnFromJson(Object? json) => ThreadsListReturn.fromJsonValue(json);

class ThreadsNoteOptions {
  const ThreadsNoteOptions({this.scope, this.visibility});

  final String? scope;
  final String? visibility;

  void encodeBody(Map<String, RaviJson> into) {
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
    if (visibility != null) {
      into["visibility"] = RaviJson.from(visibility);
    }
  }
}

class ThreadsNoteReturn {
  const ThreadsNoteReturn({required this.action, required this.entry, required this.thread});

  final String action;
  final Map<String, RaviJson> entry;
  final Map<String, RaviJson> thread;

  factory ThreadsNoteReturn.fromJson(Map<String, Object?> json) {
    return ThreadsNoteReturn(
      action: raviJsonAsString(json["action"]),
      entry: raviJsonAsRaviJsonMap(json["entry"]),
      thread: raviJsonAsRaviJsonMap(json["thread"]),
    );
  }

  static ThreadsNoteReturn fromJsonValue(Object? json) {
    return ThreadsNoteReturn.fromJson(raviJsonObject(json, "ThreadsNoteReturn"));
  }
}

ThreadsNoteReturn threadsNoteReturnFromJson(Object? json) => ThreadsNoteReturn.fromJsonValue(json);

class ThreadsShowOptions {
  const ThreadsShowOptions({this.entries, this.scope});

  final String? entries;
  final String? scope;

  void encodeBody(Map<String, RaviJson> into) {
    if (entries != null) {
      into["entries"] = RaviJson.from(entries);
    }
    if (scope != null) {
      into["scope"] = RaviJson.from(scope);
    }
  }
}

class ThreadsShowReturn {
  const ThreadsShowReturn({required this.action, required this.entries, required this.links, required this.thread});

  final String action;
  final List<Map<String, RaviJson>> entries;
  final List<Map<String, RaviJson>> links;
  final Map<String, RaviJson> thread;

  factory ThreadsShowReturn.fromJson(Map<String, Object?> json) {
    return ThreadsShowReturn(
      action: raviJsonAsString(json["action"]),
      entries: raviJsonAsList(json["entries"], raviJsonAsRaviJsonMap),
      links: raviJsonAsList(json["links"], raviJsonAsRaviJsonMap),
      thread: raviJsonAsRaviJsonMap(json["thread"]),
    );
  }

  static ThreadsShowReturn fromJsonValue(Object? json) {
    return ThreadsShowReturn.fromJson(raviJsonObject(json, "ThreadsShowReturn"));
  }
}

ThreadsShowReturn threadsShowReturnFromJson(Object? json) => ThreadsShowReturn.fromJsonValue(json);

class ToolsInvokeReturn {
  const ToolsInvokeReturn({required this.args, required this.executed, required this.mode, required this.result, required this.tool});

  final Map<String, RaviJson> args;
  final bool executed;
  final String mode;
  final RaviJson result;
  final RaviJson tool;

  factory ToolsInvokeReturn.fromJson(Map<String, Object?> json) {
    return ToolsInvokeReturn(
      args: raviJsonAsRaviJsonMap(json["args"]),
      executed: raviJsonAsBool(json["executed"]),
      mode: raviJsonAsString(json["mode"]),
      result: RaviJson.from(json["result"]),
      tool: RaviJson.from(json["tool"]),
    );
  }

  static ToolsInvokeReturn fromJsonValue(Object? json) {
    return ToolsInvokeReturn.fromJson(raviJsonObject(json, "ToolsInvokeReturn"));
  }
}

ToolsInvokeReturn toolsInvokeReturnFromJson(Object? json) => ToolsInvokeReturn.fromJsonValue(json);

class ToolsListOptions {
  const ToolsListOptions({this.limit, this.offset});

  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class ToolsListReturn {
  const ToolsListReturn({required this.groups, required this.items, required this.pagination, required this.tools, required this.total});

  final List<RaviJson> groups;
  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> tools;
  final double total;

  factory ToolsListReturn.fromJson(Map<String, Object?> json) {
    return ToolsListReturn(
      groups: raviJsonAsList(json["groups"], RaviJson.from),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      tools: raviJsonAsList(json["tools"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ToolsListReturn fromJsonValue(Object? json) {
    return ToolsListReturn.fromJson(raviJsonObject(json, "ToolsListReturn"));
  }
}

ToolsListReturn toolsListReturnFromJson(Object? json) => ToolsListReturn.fromJsonValue(json);

class ToolsManifestReturn {
  const ToolsManifestReturn({required this.tools, required this.total});

  final List<Map<String, RaviJson>> tools;
  final double total;

  factory ToolsManifestReturn.fromJson(Map<String, Object?> json) {
    return ToolsManifestReturn(
      tools: raviJsonAsList(json["tools"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ToolsManifestReturn fromJsonValue(Object? json) {
    return ToolsManifestReturn.fromJson(raviJsonObject(json, "ToolsManifestReturn"));
  }
}

ToolsManifestReturn toolsManifestReturnFromJson(Object? json) => ToolsManifestReturn.fromJsonValue(json);

class ToolsSchemaReturn {
  const ToolsSchemaReturn({required this.schema});

  final Map<String, RaviJson> schema;

  factory ToolsSchemaReturn.fromJson(Map<String, Object?> json) {
    return ToolsSchemaReturn(
      schema: raviJsonAsRaviJsonMap(json["schema"]),
    );
  }

  static ToolsSchemaReturn fromJsonValue(Object? json) {
    return ToolsSchemaReturn.fromJson(raviJsonObject(json, "ToolsSchemaReturn"));
  }
}

ToolsSchemaReturn toolsSchemaReturnFromJson(Object? json) => ToolsSchemaReturn.fromJsonValue(json);

class ToolsSearchOptions {
  const ToolsSearchOptions({this.limit});

  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class ToolsSearchReturn {
  const ToolsSearchReturn({required this.items, required this.limit, required this.query, required this.returned, required this.total});

  final List<RaviJson> items;
  final double limit;
  final String query;
  final double returned;
  final double total;

  factory ToolsSearchReturn.fromJson(Map<String, Object?> json) {
    return ToolsSearchReturn(
      items: raviJsonAsList(json["items"], RaviJson.from),
      limit: raviJsonAsDouble(json["limit"]),
      query: raviJsonAsString(json["query"]),
      returned: raviJsonAsDouble(json["returned"]),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static ToolsSearchReturn fromJsonValue(Object? json) {
    return ToolsSearchReturn.fromJson(raviJsonObject(json, "ToolsSearchReturn"));
  }
}

ToolsSearchReturn toolsSearchReturnFromJson(Object? json) => ToolsSearchReturn.fromJsonValue(json);

class ToolsShowReturn {
  const ToolsShowReturn({required this.tool});

  final Map<String, RaviJson> tool;

  factory ToolsShowReturn.fromJson(Map<String, Object?> json) {
    return ToolsShowReturn(
      tool: raviJsonAsRaviJsonMap(json["tool"]),
    );
  }

  static ToolsShowReturn fromJsonValue(Object? json) {
    return ToolsShowReturn.fromJson(raviJsonObject(json, "ToolsShowReturn"));
  }
}

ToolsShowReturn toolsShowReturnFromJson(Object? json) => ToolsShowReturn.fromJsonValue(json);

class ToolsTestReturn {
  const ToolsTestReturn({required this.access, required this.args, required this.executed, required this.invokeCommand, required this.mode, required this.schema, required this.tool});

  final RaviJson access;
  final Map<String, RaviJson> args;
  final bool executed;
  final String invokeCommand;
  final String mode;
  final RaviJson schema;
  final RaviJson tool;

  factory ToolsTestReturn.fromJson(Map<String, Object?> json) {
    return ToolsTestReturn(
      access: RaviJson.from(json["access"]),
      args: raviJsonAsRaviJsonMap(json["args"]),
      executed: raviJsonAsBool(json["executed"]),
      invokeCommand: raviJsonAsString(json["invokeCommand"]),
      mode: raviJsonAsString(json["mode"]),
      schema: RaviJson.from(json["schema"]),
      tool: RaviJson.from(json["tool"]),
    );
  }

  static ToolsTestReturn fromJsonValue(Object? json) {
    return ToolsTestReturn.fromJson(raviJsonObject(json, "ToolsTestReturn"));
  }
}

ToolsTestReturn toolsTestReturnFromJson(Object? json) => ToolsTestReturn.fromJsonValue(json);

class TranscribeFileOptions {
  const TranscribeFileOptions({this.lang});

  final String? lang;

  void encodeBody(Map<String, RaviJson> into) {
    if (lang != null) {
      into["lang"] = RaviJson.from(lang);
    }
  }
}

class TranscribeFileReturn {
  const TranscribeFileReturn({required this.options, required this.source, required this.success, required this.transcription});

  final RaviJson options;
  final RaviJson source;
  final bool success;
  final RaviJson transcription;

  factory TranscribeFileReturn.fromJson(Map<String, Object?> json) {
    return TranscribeFileReturn(
      options: RaviJson.from(json["options"]),
      source: RaviJson.from(json["source"]),
      success: raviJsonAsBool(json["success"]),
      transcription: RaviJson.from(json["transcription"]),
    );
  }

  static TranscribeFileReturn fromJsonValue(Object? json) {
    return TranscribeFileReturn.fromJson(raviJsonObject(json, "TranscribeFileReturn"));
  }
}

TranscribeFileReturn transcribeFileReturnFromJson(Object? json) => TranscribeFileReturn.fromJsonValue(json);

class TriggersAddOptions {
  const TriggersAddOptions({this.account, this.agent, this.cooldown, this.envFile, this.exec, this.filter, this.message, this.onError, this.replySession, this.session, this.shell, this.timeout, this.topic});

  final String? account;
  final String? agent;
  final String? cooldown;
  final String? envFile;
  final String? exec;
  final String? filter;
  final String? message;
  final String? onError;
  final String? replySession;
  final String? session;
  final String? shell;
  final String? timeout;
  final String? topic;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (cooldown != null) {
      into["cooldown"] = RaviJson.from(cooldown);
    }
    if (envFile != null) {
      into["envFile"] = RaviJson.from(envFile);
    }
    if (exec != null) {
      into["exec"] = RaviJson.from(exec);
    }
    if (filter != null) {
      into["filter"] = RaviJson.from(filter);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (onError != null) {
      into["onError"] = RaviJson.from(onError);
    }
    if (replySession != null) {
      into["replySession"] = RaviJson.from(replySession);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (shell != null) {
      into["shell"] = RaviJson.from(shell);
    }
    if (timeout != null) {
      into["timeout"] = RaviJson.from(timeout);
    }
    if (topic != null) {
      into["topic"] = RaviJson.from(topic);
    }
  }
}

class TriggersAddReturn {
  const TriggersAddReturn({required this.changedCount, required this.status, required this.target, required this.trigger});

  final double changedCount;
  final String status;
  final RaviJson target;
  final RaviJson trigger;

  factory TriggersAddReturn.fromJson(Map<String, Object?> json) {
    return TriggersAddReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      trigger: RaviJson.from(json["trigger"]),
    );
  }

  static TriggersAddReturn fromJsonValue(Object? json) {
    return TriggersAddReturn.fromJson(raviJsonObject(json, "TriggersAddReturn"));
  }
}

TriggersAddReturn triggersAddReturnFromJson(Object? json) => TriggersAddReturn.fromJsonValue(json);

class TriggersDisableReturn {
  const TriggersDisableReturn({required this.changedCount, required this.status, required this.target, required this.trigger});

  final double changedCount;
  final String status;
  final RaviJson target;
  final RaviJson trigger;

  factory TriggersDisableReturn.fromJson(Map<String, Object?> json) {
    return TriggersDisableReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      trigger: RaviJson.from(json["trigger"]),
    );
  }

  static TriggersDisableReturn fromJsonValue(Object? json) {
    return TriggersDisableReturn.fromJson(raviJsonObject(json, "TriggersDisableReturn"));
  }
}

TriggersDisableReturn triggersDisableReturnFromJson(Object? json) => TriggersDisableReturn.fromJsonValue(json);

class TriggersEnableReturn {
  const TriggersEnableReturn({required this.changedCount, required this.status, required this.target, required this.trigger});

  final double changedCount;
  final String status;
  final RaviJson target;
  final RaviJson trigger;

  factory TriggersEnableReturn.fromJson(Map<String, Object?> json) {
    return TriggersEnableReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      trigger: RaviJson.from(json["trigger"]),
    );
  }

  static TriggersEnableReturn fromJsonValue(Object? json) {
    return TriggersEnableReturn.fromJson(raviJsonObject(json, "TriggersEnableReturn"));
  }
}

TriggersEnableReturn triggersEnableReturnFromJson(Object? json) => TriggersEnableReturn.fromJsonValue(json);

class TriggersListOptions {
  const TriggersListOptions({this.fields, this.limit, this.offset, this.tag});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? tag;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (tag != null) {
      into["tag"] = RaviJson.from(tag);
    }
  }
}

class TriggersListReturn {
  const TriggersListReturn({required this.items, required this.pagination, required this.total, required this.triggers});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;
  final List<Map<String, RaviJson>> triggers;

  factory TriggersListReturn.fromJson(Map<String, Object?> json) {
    return TriggersListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
      triggers: raviJsonAsList(json["triggers"], raviJsonAsRaviJsonMap),
    );
  }

  static TriggersListReturn fromJsonValue(Object? json) {
    return TriggersListReturn.fromJson(raviJsonObject(json, "TriggersListReturn"));
  }
}

TriggersListReturn triggersListReturnFromJson(Object? json) => TriggersListReturn.fromJsonValue(json);

class TriggersRmOptions {
  const TriggersRmOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class TriggersRmReturn {
  const TriggersRmReturn({required this.changedCount, required this.status, required this.target, required this.trigger});

  final double changedCount;
  final String status;
  final RaviJson target;
  final RaviJson trigger;

  factory TriggersRmReturn.fromJson(Map<String, Object?> json) {
    return TriggersRmReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      trigger: RaviJson.from(json["trigger"]),
    );
  }

  static TriggersRmReturn fromJsonValue(Object? json) {
    return TriggersRmReturn.fromJson(raviJsonObject(json, "TriggersRmReturn"));
  }
}

TriggersRmReturn triggersRmReturnFromJson(Object? json) => TriggersRmReturn.fromJsonValue(json);

class TriggersSetReturn {
  const TriggersSetReturn({required this.changedCount, required this.status, required this.target, required this.trigger});

  final double changedCount;
  final String status;
  final RaviJson target;
  final RaviJson trigger;

  factory TriggersSetReturn.fromJson(Map<String, Object?> json) {
    return TriggersSetReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      trigger: RaviJson.from(json["trigger"]),
    );
  }

  static TriggersSetReturn fromJsonValue(Object? json) {
    return TriggersSetReturn.fromJson(raviJsonObject(json, "TriggersSetReturn"));
  }
}

TriggersSetReturn triggersSetReturnFromJson(Object? json) => TriggersSetReturn.fromJsonValue(json);

class TriggersShowReturn {
  const TriggersShowReturn({required this.trigger});

  final Map<String, RaviJson> trigger;

  factory TriggersShowReturn.fromJson(Map<String, Object?> json) {
    return TriggersShowReturn(
      trigger: raviJsonAsRaviJsonMap(json["trigger"]),
    );
  }

  static TriggersShowReturn fromJsonValue(Object? json) {
    return TriggersShowReturn.fromJson(raviJsonObject(json, "TriggersShowReturn"));
  }
}

TriggersShowReturn triggersShowReturnFromJson(Object? json) => TriggersShowReturn.fromJsonValue(json);

class TriggersTestOptions {
  const TriggersTestOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class TriggersTestReturn {
  const TriggersTestReturn({required this.changedCount, required this.status, required this.target, required this.trigger});

  final double changedCount;
  final String status;
  final RaviJson target;
  final RaviJson trigger;

  factory TriggersTestReturn.fromJson(Map<String, Object?> json) {
    return TriggersTestReturn(
      changedCount: raviJsonAsDouble(json["changedCount"]),
      status: raviJsonAsString(json["status"]),
      target: RaviJson.from(json["target"]),
      trigger: RaviJson.from(json["trigger"]),
    );
  }

  static TriggersTestReturn fromJsonValue(Object? json) {
    return TriggersTestReturn.fromJson(raviJsonObject(json, "TriggersTestReturn"));
  }
}

TriggersTestReturn triggersTestReturnFromJson(Object? json) => TriggersTestReturn.fromJsonValue(json);

class TriggersTopicsReturn {
  const TriggersTopicsReturn({required this.topics});

  final List<Map<String, RaviJson>> topics;

  factory TriggersTopicsReturn.fromJson(Map<String, Object?> json) {
    return TriggersTopicsReturn(
      topics: raviJsonAsList(json["topics"], raviJsonAsRaviJsonMap),
    );
  }

  static TriggersTopicsReturn fromJsonValue(Object? json) {
    return TriggersTopicsReturn.fromJson(raviJsonObject(json, "TriggersTopicsReturn"));
  }
}

TriggersTopicsReturn triggersTopicsReturnFromJson(Object? json) => TriggersTopicsReturn.fromJsonValue(json);

class VideoAnalyzeOptions {
  const VideoAnalyzeOptions({this.forceAnalyze, this.output, this.prompt, this.strategy});

  final bool? forceAnalyze;
  final String? output;
  final String? prompt;
  final String? strategy;

  void encodeBody(Map<String, RaviJson> into) {
    if (forceAnalyze != null) {
      into["forceAnalyze"] = RaviJson.from(forceAnalyze);
    }
    if (output != null) {
      into["output"] = RaviJson.from(output);
    }
    if (prompt != null) {
      into["prompt"] = RaviJson.from(prompt);
    }
    if (strategy != null) {
      into["strategy"] = RaviJson.from(strategy);
    }
  }
}

class VideoAnalyzeReturn {
  const VideoAnalyzeReturn({required this.artifact, required this.options, required this.success, required this.video});

  final Map<String, RaviJson> artifact;
  final Map<String, RaviJson> options;
  final bool success;
  final RaviJson video;

  factory VideoAnalyzeReturn.fromJson(Map<String, Object?> json) {
    return VideoAnalyzeReturn(
      artifact: raviJsonAsRaviJsonMap(json["artifact"]),
      options: raviJsonAsRaviJsonMap(json["options"]),
      success: raviJsonAsBool(json["success"]),
      video: RaviJson.from(json["video"]),
    );
  }

  static VideoAnalyzeReturn fromJsonValue(Object? json) {
    return VideoAnalyzeReturn.fromJson(raviJsonObject(json, "VideoAnalyzeReturn"));
  }
}

VideoAnalyzeReturn videoAnalyzeReturnFromJson(Object? json) => VideoAnalyzeReturn.fromJsonValue(json);

class WatchConnectorsOptions {
  const WatchConnectorsOptions({this.provider});

  final String? provider;

  void encodeBody(Map<String, RaviJson> into) {
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
  }
}

class WatchConnectorsReturn {
  const WatchConnectorsReturn({required this.connectors, required this.items, required this.total});

  final List<Map<String, RaviJson>> connectors;
  final List<Map<String, RaviJson>> items;
  final double total;

  factory WatchConnectorsReturn.fromJson(Map<String, Object?> json) {
    return WatchConnectorsReturn(
      connectors: raviJsonAsList(json["connectors"], raviJsonAsRaviJsonMap),
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static WatchConnectorsReturn fromJsonValue(Object? json) {
    return WatchConnectorsReturn.fromJson(raviJsonObject(json, "WatchConnectorsReturn"));
  }
}

WatchConnectorsReturn watchConnectorsReturnFromJson(Object? json) => WatchConnectorsReturn.fromJsonValue(json);

class WatchCreateOptions {
  const WatchCreateOptions({this.event, this.installation, this.name, this.placement, this.project, this.resourceId});

  final String? event;
  final String? installation;
  final String? name;
  final String? placement;
  final String? project;
  final String? resourceId;

  void encodeBody(Map<String, RaviJson> into) {
    if (event != null) {
      into["event"] = RaviJson.from(event);
    }
    if (installation != null) {
      into["installation"] = RaviJson.from(installation);
    }
    if (name != null) {
      into["name"] = RaviJson.from(name);
    }
    if (placement != null) {
      into["placement"] = RaviJson.from(placement);
    }
    if (project != null) {
      into["project"] = RaviJson.from(project);
    }
    if (resourceId != null) {
      into["resourceId"] = RaviJson.from(resourceId);
    }
  }
}

class WatchCreateReturn {
  const WatchCreateReturn({required this.capabilities, required this.next, required this.status, required this.watch});

  final Map<String, RaviJson> capabilities;
  final Map<String, RaviJson> next;
  final String status;
  final Map<String, RaviJson> watch;

  factory WatchCreateReturn.fromJson(Map<String, Object?> json) {
    return WatchCreateReturn(
      capabilities: raviJsonAsRaviJsonMap(json["capabilities"]),
      next: raviJsonAsRaviJsonMap(json["next"]),
      status: raviJsonAsString(json["status"]),
      watch: raviJsonAsRaviJsonMap(json["watch"]),
    );
  }

  static WatchCreateReturn fromJsonValue(Object? json) {
    return WatchCreateReturn.fromJson(raviJsonObject(json, "WatchCreateReturn"));
  }
}

WatchCreateReturn watchCreateReturnFromJson(Object? json) => WatchCreateReturn.fromJsonValue(json);

class WatchDisableReturn {
  const WatchDisableReturn({required this.status, required this.watch});

  final String status;
  final Map<String, RaviJson> watch;

  factory WatchDisableReturn.fromJson(Map<String, Object?> json) {
    return WatchDisableReturn(
      status: raviJsonAsString(json["status"]),
      watch: raviJsonAsRaviJsonMap(json["watch"]),
    );
  }

  static WatchDisableReturn fromJsonValue(Object? json) {
    return WatchDisableReturn.fromJson(raviJsonObject(json, "WatchDisableReturn"));
  }
}

WatchDisableReturn watchDisableReturnFromJson(Object? json) => WatchDisableReturn.fromJsonValue(json);

class WatchEnableReturn {
  const WatchEnableReturn({required this.status, required this.watch});

  final String status;
  final Map<String, RaviJson> watch;

  factory WatchEnableReturn.fromJson(Map<String, Object?> json) {
    return WatchEnableReturn(
      status: raviJsonAsString(json["status"]),
      watch: raviJsonAsRaviJsonMap(json["watch"]),
    );
  }

  static WatchEnableReturn fromJsonValue(Object? json) {
    return WatchEnableReturn.fromJson(raviJsonObject(json, "WatchEnableReturn"));
  }
}

WatchEnableReturn watchEnableReturnFromJson(Object? json) => WatchEnableReturn.fromJsonValue(json);

class WatchEventsReturn {
  const WatchEventsReturn({required this.eventTypes, required this.subjects, required this.watchId});

  final List<String> eventTypes;
  final List<String> subjects;
  final String watchId;

  factory WatchEventsReturn.fromJson(Map<String, Object?> json) {
    return WatchEventsReturn(
      eventTypes: raviJsonAsList(json["eventTypes"], raviJsonAsString),
      subjects: raviJsonAsList(json["subjects"], raviJsonAsString),
      watchId: raviJsonAsString(json["watchId"]),
    );
  }

  static WatchEventsReturn fromJsonValue(Object? json) {
    return WatchEventsReturn.fromJson(raviJsonObject(json, "WatchEventsReturn"));
  }
}

WatchEventsReturn watchEventsReturnFromJson(Object? json) => WatchEventsReturn.fromJsonValue(json);

class WatchListOptions {
  const WatchListOptions({this.fields, this.limit, this.offset, this.provider, this.status});

  final String? fields;
  final String? limit;
  final String? offset;
  final String? provider;
  final String? status;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
    if (provider != null) {
      into["provider"] = RaviJson.from(provider);
    }
    if (status != null) {
      into["status"] = RaviJson.from(status);
    }
  }
}

class WatchListReturn {
  const WatchListReturn({required this.items, required this.pagination, required this.total, required this.watches});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final double total;
  final List<Map<String, RaviJson>> watches;

  factory WatchListReturn.fromJson(Map<String, Object?> json) {
    return WatchListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      total: raviJsonAsDouble(json["total"]),
      watches: raviJsonAsList(json["watches"], raviJsonAsRaviJsonMap),
    );
  }

  static WatchListReturn fromJsonValue(Object? json) {
    return WatchListReturn.fromJson(raviJsonObject(json, "WatchListReturn"));
  }
}

WatchListReturn watchListReturnFromJson(Object? json) => WatchListReturn.fromJsonValue(json);

class WatchRmOptions {
  const WatchRmOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class WatchRmReturn {
  const WatchRmReturn({required this.deleted, required this.id});

  final bool deleted;
  final String id;

  factory WatchRmReturn.fromJson(Map<String, Object?> json) {
    return WatchRmReturn(
      deleted: raviJsonAsBool(json["deleted"]),
      id: raviJsonAsString(json["id"]),
    );
  }

  static WatchRmReturn fromJsonValue(Object? json) {
    return WatchRmReturn.fromJson(raviJsonObject(json, "WatchRmReturn"));
  }
}

WatchRmReturn watchRmReturnFromJson(Object? json) => WatchRmReturn.fromJsonValue(json);

class WatchShowReturn {
  const WatchShowReturn({required this.watch});

  final Map<String, RaviJson> watch;

  factory WatchShowReturn.fromJson(Map<String, Object?> json) {
    return WatchShowReturn(
      watch: raviJsonAsRaviJsonMap(json["watch"]),
    );
  }

  static WatchShowReturn fromJsonValue(Object? json) {
    return WatchShowReturn.fromJson(raviJsonObject(json, "WatchShowReturn"));
  }
}

WatchShowReturn watchShowReturnFromJson(Object? json) => WatchShowReturn.fromJsonValue(json);

class WatchTriggerOptions {
  const WatchTriggerOptions({this.account, this.agent, this.cooldown, this.event, this.execute, this.message, this.session});

  final String? account;
  final String? agent;
  final String? cooldown;
  final String? event;
  final bool? execute;
  final String? message;
  final String? session;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (cooldown != null) {
      into["cooldown"] = RaviJson.from(cooldown);
    }
    if (event != null) {
      into["event"] = RaviJson.from(event);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (message != null) {
      into["message"] = RaviJson.from(message);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
  }
}

class WatchTriggerReturn {
  const WatchTriggerReturn({required this.status, required this.trigger, required this.watch});

  final String status;
  final Map<String, RaviJson> trigger;
  final Map<String, RaviJson> watch;

  factory WatchTriggerReturn.fromJson(Map<String, Object?> json) {
    return WatchTriggerReturn(
      status: raviJsonAsString(json["status"]),
      trigger: raviJsonAsRaviJsonMap(json["trigger"]),
      watch: raviJsonAsRaviJsonMap(json["watch"]),
    );
  }

  static WatchTriggerReturn fromJsonValue(Object? json) {
    return WatchTriggerReturn.fromJson(raviJsonObject(json, "WatchTriggerReturn"));
  }
}

WatchTriggerReturn watchTriggerReturnFromJson(Object? json) => WatchTriggerReturn.fromJsonValue(json);

class WhatsappDmAckOptions {
  const WhatsappDmAckOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappDmAckReturn = Map<String, RaviJson>;

WhatsappDmAckReturn whatsappDmAckReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappDmReadOptions {
  const WhatsappDmReadOptions({this.account, this.fields, this.last, this.noAck});

  final String? account;
  final String? fields;
  final String? last;
  final bool? noAck;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (last != null) {
      into["last"] = RaviJson.from(last);
    }
    if (noAck != null) {
      into["noAck"] = RaviJson.from(noAck);
    }
  }
}

typedef WhatsappDmReadReturn = Map<String, RaviJson>;

WhatsappDmReadReturn whatsappDmReadReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappDmSendOptions {
  const WhatsappDmSendOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappDmSendReturn = Map<String, RaviJson>;

WhatsappDmSendReturn whatsappDmSendReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupAddOptions {
  const WhatsappGroupAddOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappGroupAddReturn = Map<String, RaviJson>;

WhatsappGroupAddReturn whatsappGroupAddReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupCreateOptions {
  const WhatsappGroupCreateOptions({this.account, this.admin, this.admins, this.agent, this.agentCwd, this.agentModel, this.agentProvider, this.createAgent, this.execute, this.skipTaggedAdmins});

  final String? account;
  final List<String>? admin;
  final List<String>? admins;
  final String? agent;
  final String? agentCwd;
  final String? agentModel;
  final String? agentProvider;
  final bool? createAgent;
  final bool? execute;
  final bool? skipTaggedAdmins;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (admin != null) {
      into["admin"] = RaviJson.from(admin);
    }
    if (admins != null) {
      into["admins"] = RaviJson.from(admins);
    }
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (agentCwd != null) {
      into["agentCwd"] = RaviJson.from(agentCwd);
    }
    if (agentModel != null) {
      into["agentModel"] = RaviJson.from(agentModel);
    }
    if (agentProvider != null) {
      into["agentProvider"] = RaviJson.from(agentProvider);
    }
    if (createAgent != null) {
      into["createAgent"] = RaviJson.from(createAgent);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (skipTaggedAdmins != null) {
      into["skipTaggedAdmins"] = RaviJson.from(skipTaggedAdmins);
    }
  }
}

typedef WhatsappGroupCreateReturn = Map<String, RaviJson>;

WhatsappGroupCreateReturn whatsappGroupCreateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupDemoteOptions {
  const WhatsappGroupDemoteOptions({this.account});

  final String? account;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
  }
}

typedef WhatsappGroupDemoteReturn = Map<String, RaviJson>;

WhatsappGroupDemoteReturn whatsappGroupDemoteReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupDescriptionOptions {
  const WhatsappGroupDescriptionOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappGroupDescriptionReturn = Map<String, RaviJson>;

WhatsappGroupDescriptionReturn whatsappGroupDescriptionReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupInfoOptions {
  const WhatsappGroupInfoOptions({this.account});

  final String? account;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
  }
}

typedef WhatsappGroupInfoReturn = Map<String, RaviJson>;

WhatsappGroupInfoReturn whatsappGroupInfoReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupInviteOptions {
  const WhatsappGroupInviteOptions({this.account});

  final String? account;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
  }
}

typedef WhatsappGroupInviteReturn = Map<String, RaviJson>;

WhatsappGroupInviteReturn whatsappGroupInviteReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupJoinOptions {
  const WhatsappGroupJoinOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappGroupJoinReturn = Map<String, RaviJson>;

WhatsappGroupJoinReturn whatsappGroupJoinReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupLeaveOptions {
  const WhatsappGroupLeaveOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappGroupLeaveReturn = Map<String, RaviJson>;

WhatsappGroupLeaveReturn whatsappGroupLeaveReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupListOptions {
  const WhatsappGroupListOptions({this.account, this.fields, this.limit, this.offset});

  final String? account;
  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

typedef WhatsappGroupListReturn = Map<String, RaviJson>;

WhatsappGroupListReturn whatsappGroupListReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupPromoteOptions {
  const WhatsappGroupPromoteOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappGroupPromoteReturn = Map<String, RaviJson>;

WhatsappGroupPromoteReturn whatsappGroupPromoteReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupRemoveOptions {
  const WhatsappGroupRemoveOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappGroupRemoveReturn = Map<String, RaviJson>;

WhatsappGroupRemoveReturn whatsappGroupRemoveReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupRenameOptions {
  const WhatsappGroupRenameOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappGroupRenameReturn = Map<String, RaviJson>;

WhatsappGroupRenameReturn whatsappGroupRenameReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupRevokeInviteOptions {
  const WhatsappGroupRevokeInviteOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappGroupRevokeInviteReturn = Map<String, RaviJson>;

WhatsappGroupRevokeInviteReturn whatsappGroupRevokeInviteReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupSendOptions {
  const WhatsappGroupSendOptions({this.account, this.execute, this.mention});

  final String? account;
  final bool? execute;
  final List<String>? mention;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (mention != null) {
      into["mention"] = RaviJson.from(mention);
    }
  }
}

typedef WhatsappGroupSendReturn = Map<String, RaviJson>;

WhatsappGroupSendReturn whatsappGroupSendReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WhatsappGroupSettingsOptions {
  const WhatsappGroupSettingsOptions({this.account, this.execute});

  final String? account;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (account != null) {
      into["account"] = RaviJson.from(account);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

typedef WhatsappGroupSettingsReturn = Map<String, RaviJson>;

WhatsappGroupSettingsReturn whatsappGroupSettingsReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WorkObjectsActionOptions {
  const WorkObjectsActionOptions({this.execute, this.value});

  final bool? execute;
  final String? value;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (value != null) {
      into["value"] = RaviJson.from(value);
    }
  }
}

class WorkObjectsActionReturn {
  const WorkObjectsActionReturn({required this.providerId, required this.result});

  final String providerId;
  final RaviJson result;

  factory WorkObjectsActionReturn.fromJson(Map<String, Object?> json) {
    return WorkObjectsActionReturn(
      providerId: raviJsonAsString(json["providerId"]),
      result: RaviJson.from(json["result"]),
    );
  }

  static WorkObjectsActionReturn fromJsonValue(Object? json) {
    return WorkObjectsActionReturn.fromJson(raviJsonObject(json, "WorkObjectsActionReturn"));
  }
}

WorkObjectsActionReturn workObjectsActionReturnFromJson(Object? json) => WorkObjectsActionReturn.fromJsonValue(json);

class WorkObjectsResolveOptions {
  const WorkObjectsResolveOptions({this.id, this.type, this.url});

  final String? id;
  final String? type;
  final String? url;

  void encodeBody(Map<String, RaviJson> into) {
    if (id != null) {
      into["id"] = RaviJson.from(id);
    }
    if (type != null) {
      into["type"] = RaviJson.from(type);
    }
    if (url != null) {
      into["url"] = RaviJson.from(url);
    }
  }
}

class WorkObjectsResolveReturn {
  const WorkObjectsResolveReturn({required this.providerId, required this.result});

  final String providerId;
  final RaviJson result;

  factory WorkObjectsResolveReturn.fromJson(Map<String, Object?> json) {
    return WorkObjectsResolveReturn(
      providerId: raviJsonAsString(json["providerId"]),
      result: RaviJson.from(json["result"]),
    );
  }

  static WorkObjectsResolveReturn fromJsonValue(Object? json) {
    return WorkObjectsResolveReturn.fromJson(raviJsonObject(json, "WorkObjectsResolveReturn"));
  }
}

WorkObjectsResolveReturn workObjectsResolveReturnFromJson(Object? json) => WorkObjectsResolveReturn.fromJsonValue(json);

class WorkObjectsSuggestOptions {
  const WorkObjectsSuggestOptions({this.query});

  final String? query;

  void encodeBody(Map<String, RaviJson> into) {
    if (query != null) {
      into["query"] = RaviJson.from(query);
    }
  }
}

class WorkObjectsSuggestReturn {
  const WorkObjectsSuggestReturn({required this.providerId, required this.result});

  final String providerId;
  final List<RaviJson> result;

  factory WorkObjectsSuggestReturn.fromJson(Map<String, Object?> json) {
    return WorkObjectsSuggestReturn(
      providerId: raviJsonAsString(json["providerId"]),
      result: raviJsonAsList(json["result"], RaviJson.from),
    );
  }

  static WorkObjectsSuggestReturn fromJsonValue(Object? json) {
    return WorkObjectsSuggestReturn.fromJson(raviJsonObject(json, "WorkObjectsSuggestReturn"));
  }
}

WorkObjectsSuggestReturn workObjectsSuggestReturnFromJson(Object? json) => WorkObjectsSuggestReturn.fromJsonValue(json);

class WorkObjectsUpdateOptions {
  const WorkObjectsUpdateOptions({this.revision, this.values});

  final String? revision;
  final String? values;

  void encodeBody(Map<String, RaviJson> into) {
    if (revision != null) {
      into["revision"] = RaviJson.from(revision);
    }
    if (values != null) {
      into["values"] = RaviJson.from(values);
    }
  }
}

class WorkObjectsUpdateReturn {
  const WorkObjectsUpdateReturn({required this.providerId, required this.result});

  final String providerId;
  final RaviJson result;

  factory WorkObjectsUpdateReturn.fromJson(Map<String, Object?> json) {
    return WorkObjectsUpdateReturn(
      providerId: raviJsonAsString(json["providerId"]),
      result: RaviJson.from(json["result"]),
    );
  }

  static WorkObjectsUpdateReturn fromJsonValue(Object? json) {
    return WorkObjectsUpdateReturn.fromJson(raviJsonObject(json, "WorkObjectsUpdateReturn"));
  }
}

WorkObjectsUpdateReturn workObjectsUpdateReturnFromJson(Object? json) => WorkObjectsUpdateReturn.fromJsonValue(json);

class WorkflowsRunsArchiveNodeOptions {
  const WorkflowsRunsArchiveNodeOptions({this.execute});

  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class WorkflowsRunsArchiveNodeReturn {
  const WorkflowsRunsArchiveNodeReturn({required this.details});

  final Map<String, RaviJson> details;

  factory WorkflowsRunsArchiveNodeReturn.fromJson(Map<String, Object?> json) {
    return WorkflowsRunsArchiveNodeReturn(
      details: raviJsonAsRaviJsonMap(json["details"]),
    );
  }

  static WorkflowsRunsArchiveNodeReturn fromJsonValue(Object? json) {
    return WorkflowsRunsArchiveNodeReturn.fromJson(raviJsonObject(json, "WorkflowsRunsArchiveNodeReturn"));
  }
}

WorkflowsRunsArchiveNodeReturn workflowsRunsArchiveNodeReturnFromJson(Object? json) => WorkflowsRunsArchiveNodeReturn.fromJsonValue(json);

class WorkflowsRunsCancelReturn {
  const WorkflowsRunsCancelReturn({required this.details});

  final Map<String, RaviJson> details;

  factory WorkflowsRunsCancelReturn.fromJson(Map<String, Object?> json) {
    return WorkflowsRunsCancelReturn(
      details: raviJsonAsRaviJsonMap(json["details"]),
    );
  }

  static WorkflowsRunsCancelReturn fromJsonValue(Object? json) {
    return WorkflowsRunsCancelReturn.fromJson(raviJsonObject(json, "WorkflowsRunsCancelReturn"));
  }
}

WorkflowsRunsCancelReturn workflowsRunsCancelReturnFromJson(Object? json) => WorkflowsRunsCancelReturn.fromJsonValue(json);

class WorkflowsRunsListOptions {
  const WorkflowsRunsListOptions({this.fields, this.limit, this.offset});

  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class WorkflowsRunsListReturn {
  const WorkflowsRunsListReturn({required this.items, required this.pagination, required this.runs, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> runs;
  final double total;

  factory WorkflowsRunsListReturn.fromJson(Map<String, Object?> json) {
    return WorkflowsRunsListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      runs: raviJsonAsList(json["runs"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static WorkflowsRunsListReturn fromJsonValue(Object? json) {
    return WorkflowsRunsListReturn.fromJson(raviJsonObject(json, "WorkflowsRunsListReturn"));
  }
}

WorkflowsRunsListReturn workflowsRunsListReturnFromJson(Object? json) => WorkflowsRunsListReturn.fromJsonValue(json);

class WorkflowsRunsReleaseReturn {
  const WorkflowsRunsReleaseReturn({required this.details});

  final Map<String, RaviJson> details;

  factory WorkflowsRunsReleaseReturn.fromJson(Map<String, Object?> json) {
    return WorkflowsRunsReleaseReturn(
      details: raviJsonAsRaviJsonMap(json["details"]),
    );
  }

  static WorkflowsRunsReleaseReturn fromJsonValue(Object? json) {
    return WorkflowsRunsReleaseReturn.fromJson(raviJsonObject(json, "WorkflowsRunsReleaseReturn"));
  }
}

WorkflowsRunsReleaseReturn workflowsRunsReleaseReturnFromJson(Object? json) => WorkflowsRunsReleaseReturn.fromJsonValue(json);

typedef WorkflowsRunsShowReturn = Map<String, RaviJson>;

WorkflowsRunsShowReturn workflowsRunsShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WorkflowsRunsSkipReturn {
  const WorkflowsRunsSkipReturn({required this.details});

  final Map<String, RaviJson> details;

  factory WorkflowsRunsSkipReturn.fromJson(Map<String, Object?> json) {
    return WorkflowsRunsSkipReturn(
      details: raviJsonAsRaviJsonMap(json["details"]),
    );
  }

  static WorkflowsRunsSkipReturn fromJsonValue(Object? json) {
    return WorkflowsRunsSkipReturn.fromJson(raviJsonObject(json, "WorkflowsRunsSkipReturn"));
  }
}

WorkflowsRunsSkipReturn workflowsRunsSkipReturnFromJson(Object? json) => WorkflowsRunsSkipReturn.fromJsonValue(json);

class WorkflowsRunsStartOptions {
  const WorkflowsRunsStartOptions({this.execute, this.runId});

  final bool? execute;
  final String? runId;

  void encodeBody(Map<String, RaviJson> into) {
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (runId != null) {
      into["runId"] = RaviJson.from(runId);
    }
  }
}

typedef WorkflowsRunsStartReturn = Map<String, RaviJson>;

WorkflowsRunsStartReturn workflowsRunsStartReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WorkflowsRunsTaskAttachReturn {
  const WorkflowsRunsTaskAttachReturn({required this.details});

  final Map<String, RaviJson> details;

  factory WorkflowsRunsTaskAttachReturn.fromJson(Map<String, Object?> json) {
    return WorkflowsRunsTaskAttachReturn(
      details: raviJsonAsRaviJsonMap(json["details"]),
    );
  }

  static WorkflowsRunsTaskAttachReturn fromJsonValue(Object? json) {
    return WorkflowsRunsTaskAttachReturn.fromJson(raviJsonObject(json, "WorkflowsRunsTaskAttachReturn"));
  }
}

WorkflowsRunsTaskAttachReturn workflowsRunsTaskAttachReturnFromJson(Object? json) => WorkflowsRunsTaskAttachReturn.fromJsonValue(json);

class WorkflowsRunsTaskCreateOptions {
  const WorkflowsRunsTaskCreateOptions({this.agent, this.instructions, this.priority, this.profile, this.session, this.title});

  final String? agent;
  final String? instructions;
  final String? priority;
  final String? profile;
  final String? session;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (agent != null) {
      into["agent"] = RaviJson.from(agent);
    }
    if (instructions != null) {
      into["instructions"] = RaviJson.from(instructions);
    }
    if (priority != null) {
      into["priority"] = RaviJson.from(priority);
    }
    if (profile != null) {
      into["profile"] = RaviJson.from(profile);
    }
    if (session != null) {
      into["session"] = RaviJson.from(session);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class WorkflowsRunsTaskCreateReturn {
  const WorkflowsRunsTaskCreateReturn({required this.task, required this.workflow});

  final Map<String, RaviJson> task;
  final RaviJson workflow;

  factory WorkflowsRunsTaskCreateReturn.fromJson(Map<String, Object?> json) {
    return WorkflowsRunsTaskCreateReturn(
      task: raviJsonAsRaviJsonMap(json["task"]),
      workflow: RaviJson.from(json["workflow"]),
    );
  }

  static WorkflowsRunsTaskCreateReturn fromJsonValue(Object? json) {
    return WorkflowsRunsTaskCreateReturn.fromJson(raviJsonObject(json, "WorkflowsRunsTaskCreateReturn"));
  }
}

WorkflowsRunsTaskCreateReturn workflowsRunsTaskCreateReturnFromJson(Object? json) => WorkflowsRunsTaskCreateReturn.fromJsonValue(json);

class WorkflowsSpecsCreateOptions {
  const WorkflowsSpecsCreateOptions({this.definition, this.file});

  final String? definition;
  final String? file;

  void encodeBody(Map<String, RaviJson> into) {
    if (definition != null) {
      into["definition"] = RaviJson.from(definition);
    }
    if (file != null) {
      into["file"] = RaviJson.from(file);
    }
  }
}

typedef WorkflowsSpecsCreateReturn = Map<String, RaviJson>;

WorkflowsSpecsCreateReturn workflowsSpecsCreateReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class WorkflowsSpecsListOptions {
  const WorkflowsSpecsListOptions({this.fields, this.limit, this.offset});

  final String? fields;
  final String? limit;
  final String? offset;

  void encodeBody(Map<String, RaviJson> into) {
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (offset != null) {
      into["offset"] = RaviJson.from(offset);
    }
  }
}

class WorkflowsSpecsListReturn {
  const WorkflowsSpecsListReturn({required this.items, required this.pagination, required this.specs, required this.total});

  final List<Map<String, RaviJson>> items;
  final RaviJson pagination;
  final List<Map<String, RaviJson>> specs;
  final double total;

  factory WorkflowsSpecsListReturn.fromJson(Map<String, Object?> json) {
    return WorkflowsSpecsListReturn(
      items: raviJsonAsList(json["items"], raviJsonAsRaviJsonMap),
      pagination: RaviJson.from(json["pagination"]),
      specs: raviJsonAsList(json["specs"], raviJsonAsRaviJsonMap),
      total: raviJsonAsDouble(json["total"]),
    );
  }

  static WorkflowsSpecsListReturn fromJsonValue(Object? json) {
    return WorkflowsSpecsListReturn.fromJson(raviJsonObject(json, "WorkflowsSpecsListReturn"));
  }
}

WorkflowsSpecsListReturn workflowsSpecsListReturnFromJson(Object? json) => WorkflowsSpecsListReturn.fromJsonValue(json);

typedef WorkflowsSpecsShowReturn = Map<String, RaviJson>;

WorkflowsSpecsShowReturn workflowsSpecsShowReturnFromJson(Object? json) => raviJsonAsRaviJsonMap(json);

class YtAnalyticsCountriesOptions {
  const YtAnalyticsCountriesOptions({this.connection, this.days, this.limit});

  final String? connection;
  final String? days;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (days != null) {
      into["days"] = RaviJson.from(days);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class YtAnalyticsCountriesReturn {
  const YtAnalyticsCountriesReturn({required this.countries, required this.period, required this.success});

  final List<RaviJson> countries;
  final String period;
  final bool success;

  factory YtAnalyticsCountriesReturn.fromJson(Map<String, Object?> json) {
    return YtAnalyticsCountriesReturn(
      countries: raviJsonAsList(json["countries"], RaviJson.from),
      period: raviJsonAsString(json["period"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtAnalyticsCountriesReturn fromJsonValue(Object? json) {
    return YtAnalyticsCountriesReturn.fromJson(raviJsonObject(json, "YtAnalyticsCountriesReturn"));
  }
}

YtAnalyticsCountriesReturn ytAnalyticsCountriesReturnFromJson(Object? json) => YtAnalyticsCountriesReturn.fromJsonValue(json);

class YtAnalyticsDemographicsOptions {
  const YtAnalyticsDemographicsOptions({this.connection, this.days});

  final String? connection;
  final String? days;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (days != null) {
      into["days"] = RaviJson.from(days);
    }
  }
}

class YtAnalyticsDemographicsReturn {
  const YtAnalyticsDemographicsReturn({required this.demographics, required this.period, required this.success});

  final List<RaviJson> demographics;
  final String period;
  final bool success;

  factory YtAnalyticsDemographicsReturn.fromJson(Map<String, Object?> json) {
    return YtAnalyticsDemographicsReturn(
      demographics: raviJsonAsList(json["demographics"], RaviJson.from),
      period: raviJsonAsString(json["period"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtAnalyticsDemographicsReturn fromJsonValue(Object? json) {
    return YtAnalyticsDemographicsReturn.fromJson(raviJsonObject(json, "YtAnalyticsDemographicsReturn"));
  }
}

YtAnalyticsDemographicsReturn ytAnalyticsDemographicsReturnFromJson(Object? json) => YtAnalyticsDemographicsReturn.fromJsonValue(json);

class YtAnalyticsDevicesOptions {
  const YtAnalyticsDevicesOptions({this.connection, this.days});

  final String? connection;
  final String? days;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (days != null) {
      into["days"] = RaviJson.from(days);
    }
  }
}

class YtAnalyticsDevicesReturn {
  const YtAnalyticsDevicesReturn({required this.devices, required this.period, required this.success});

  final List<RaviJson> devices;
  final String period;
  final bool success;

  factory YtAnalyticsDevicesReturn.fromJson(Map<String, Object?> json) {
    return YtAnalyticsDevicesReturn(
      devices: raviJsonAsList(json["devices"], RaviJson.from),
      period: raviJsonAsString(json["period"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtAnalyticsDevicesReturn fromJsonValue(Object? json) {
    return YtAnalyticsDevicesReturn.fromJson(raviJsonObject(json, "YtAnalyticsDevicesReturn"));
  }
}

YtAnalyticsDevicesReturn ytAnalyticsDevicesReturnFromJson(Object? json) => YtAnalyticsDevicesReturn.fromJsonValue(json);

class YtAnalyticsOverviewOptions {
  const YtAnalyticsOverviewOptions({this.connection, this.days});

  final String? connection;
  final String? days;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (days != null) {
      into["days"] = RaviJson.from(days);
    }
  }
}

class YtAnalyticsOverviewReturn {
  const YtAnalyticsOverviewReturn({required this.overview, required this.period, required this.success});

  final RaviJson overview;
  final String period;
  final bool success;

  factory YtAnalyticsOverviewReturn.fromJson(Map<String, Object?> json) {
    return YtAnalyticsOverviewReturn(
      overview: RaviJson.from(json["overview"]),
      period: raviJsonAsString(json["period"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtAnalyticsOverviewReturn fromJsonValue(Object? json) {
    return YtAnalyticsOverviewReturn.fromJson(raviJsonObject(json, "YtAnalyticsOverviewReturn"));
  }
}

YtAnalyticsOverviewReturn ytAnalyticsOverviewReturnFromJson(Object? json) => YtAnalyticsOverviewReturn.fromJsonValue(json);

class YtAnalyticsSeriesOptions {
  const YtAnalyticsSeriesOptions({this.connection, this.days, this.metric});

  final String? connection;
  final String? days;
  final String? metric;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (days != null) {
      into["days"] = RaviJson.from(days);
    }
    if (metric != null) {
      into["metric"] = RaviJson.from(metric);
    }
  }
}

class YtAnalyticsSeriesReturn {
  const YtAnalyticsSeriesReturn({required this.data, required this.metric, required this.period, required this.success});

  final List<Map<String, RaviJson>> data;
  final String metric;
  final String period;
  final bool success;

  factory YtAnalyticsSeriesReturn.fromJson(Map<String, Object?> json) {
    return YtAnalyticsSeriesReturn(
      data: raviJsonAsList(json["data"], raviJsonAsRaviJsonMap),
      metric: raviJsonAsString(json["metric"]),
      period: raviJsonAsString(json["period"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtAnalyticsSeriesReturn fromJsonValue(Object? json) {
    return YtAnalyticsSeriesReturn.fromJson(raviJsonObject(json, "YtAnalyticsSeriesReturn"));
  }
}

YtAnalyticsSeriesReturn ytAnalyticsSeriesReturnFromJson(Object? json) => YtAnalyticsSeriesReturn.fromJsonValue(json);

class YtAnalyticsTopOptions {
  const YtAnalyticsTopOptions({this.connection, this.days, this.limit});

  final String? connection;
  final String? days;
  final String? limit;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (days != null) {
      into["days"] = RaviJson.from(days);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
  }
}

class YtAnalyticsTopReturn {
  const YtAnalyticsTopReturn({required this.period, required this.success, required this.videos});

  final String period;
  final bool success;
  final List<RaviJson> videos;

  factory YtAnalyticsTopReturn.fromJson(Map<String, Object?> json) {
    return YtAnalyticsTopReturn(
      period: raviJsonAsString(json["period"]),
      success: raviJsonAsBool(json["success"]),
      videos: raviJsonAsList(json["videos"], RaviJson.from),
    );
  }

  static YtAnalyticsTopReturn fromJsonValue(Object? json) {
    return YtAnalyticsTopReturn.fromJson(raviJsonObject(json, "YtAnalyticsTopReturn"));
  }
}

YtAnalyticsTopReturn ytAnalyticsTopReturnFromJson(Object? json) => YtAnalyticsTopReturn.fromJsonValue(json);

class YtAnalyticsTrafficOptions {
  const YtAnalyticsTrafficOptions({this.connection, this.days});

  final String? connection;
  final String? days;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (days != null) {
      into["days"] = RaviJson.from(days);
    }
  }
}

class YtAnalyticsTrafficReturn {
  const YtAnalyticsTrafficReturn({required this.period, required this.sources, required this.success});

  final String period;
  final List<RaviJson> sources;
  final bool success;

  factory YtAnalyticsTrafficReturn.fromJson(Map<String, Object?> json) {
    return YtAnalyticsTrafficReturn(
      period: raviJsonAsString(json["period"]),
      sources: raviJsonAsList(json["sources"], RaviJson.from),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtAnalyticsTrafficReturn fromJsonValue(Object? json) {
    return YtAnalyticsTrafficReturn.fromJson(raviJsonObject(json, "YtAnalyticsTrafficReturn"));
  }
}

YtAnalyticsTrafficReturn ytAnalyticsTrafficReturnFromJson(Object? json) => YtAnalyticsTrafficReturn.fromJsonValue(json);

class YtCaptionDownloadOptions {
  const YtCaptionDownloadOptions({this.connection, this.format, this.language});

  final String? connection;
  final String? format;
  final String? language;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (format != null) {
      into["format"] = RaviJson.from(format);
    }
    if (language != null) {
      into["language"] = RaviJson.from(language);
    }
  }
}

class YtCaptionDownloadReturn {
  const YtCaptionDownloadReturn({required this.captionId, required this.content, required this.format, required this.success});

  final String captionId;
  final String content;
  final String format;
  final bool success;

  factory YtCaptionDownloadReturn.fromJson(Map<String, Object?> json) {
    return YtCaptionDownloadReturn(
      captionId: raviJsonAsString(json["captionId"]),
      content: raviJsonAsString(json["content"]),
      format: raviJsonAsString(json["format"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtCaptionDownloadReturn fromJsonValue(Object? json) {
    return YtCaptionDownloadReturn.fromJson(raviJsonObject(json, "YtCaptionDownloadReturn"));
  }
}

YtCaptionDownloadReturn ytCaptionDownloadReturnFromJson(Object? json) => YtCaptionDownloadReturn.fromJsonValue(json);

class YtCaptionsOptions {
  const YtCaptionsOptions({this.connection});

  final String? connection;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
  }
}

class YtCaptionsReturn {
  const YtCaptionsReturn({required this.captions, required this.success, required this.totalResults, required this.videoId});

  final List<RaviJson> captions;
  final bool success;
  final double totalResults;
  final String videoId;

  factory YtCaptionsReturn.fromJson(Map<String, Object?> json) {
    return YtCaptionsReturn(
      captions: raviJsonAsList(json["captions"], RaviJson.from),
      success: raviJsonAsBool(json["success"]),
      totalResults: raviJsonAsDouble(json["totalResults"]),
      videoId: raviJsonAsString(json["videoId"]),
    );
  }

  static YtCaptionsReturn fromJsonValue(Object? json) {
    return YtCaptionsReturn.fromJson(raviJsonObject(json, "YtCaptionsReturn"));
  }
}

YtCaptionsReturn ytCaptionsReturnFromJson(Object? json) => YtCaptionsReturn.fromJsonValue(json);

class YtCommentsOptions {
  const YtCommentsOptions({this.connection, this.fields, this.limit, this.page});

  final String? connection;
  final String? fields;
  final String? limit;
  final String? page;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (page != null) {
      into["page"] = RaviJson.from(page);
    }
  }
}

class YtCommentsReturn {
  const YtCommentsReturn({required this.comments, this.nextPageToken, required this.success, required this.totalResults, required this.videoId});

  final List<RaviJson> comments;
  final String? nextPageToken;
  final bool success;
  final double totalResults;
  final String videoId;

  factory YtCommentsReturn.fromJson(Map<String, Object?> json) {
    return YtCommentsReturn(
      comments: raviJsonAsList(json["comments"], RaviJson.from),
      nextPageToken: json["nextPageToken"] == null ? null : raviJsonAsString(json["nextPageToken"]),
      success: raviJsonAsBool(json["success"]),
      totalResults: raviJsonAsDouble(json["totalResults"]),
      videoId: raviJsonAsString(json["videoId"]),
    );
  }

  static YtCommentsReturn fromJsonValue(Object? json) {
    return YtCommentsReturn.fromJson(raviJsonObject(json, "YtCommentsReturn"));
  }
}

YtCommentsReturn ytCommentsReturnFromJson(Object? json) => YtCommentsReturn.fromJsonValue(json);

class YtHealthOptions {
  const YtHealthOptions({this.connection});

  final String? connection;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
  }
}

class YtHealthReturn {
  const YtHealthReturn({required this.app, required this.authenticated, required this.connection, required this.credentialConfigured, required this.credentialStatus, required this.externalCheckPerformed, required this.message, required this.ready, required this.success});

  final String app;
  final bool authenticated;
  final String connection;
  final bool credentialConfigured;
  final String credentialStatus;
  final bool externalCheckPerformed;
  final String message;
  final bool ready;
  final bool success;

  factory YtHealthReturn.fromJson(Map<String, Object?> json) {
    return YtHealthReturn(
      app: raviJsonAsString(json["app"]),
      authenticated: raviJsonAsBool(json["authenticated"]),
      connection: raviJsonAsString(json["connection"]),
      credentialConfigured: raviJsonAsBool(json["credentialConfigured"]),
      credentialStatus: raviJsonAsString(json["credentialStatus"]),
      externalCheckPerformed: raviJsonAsBool(json["externalCheckPerformed"]),
      message: raviJsonAsString(json["message"]),
      ready: raviJsonAsBool(json["ready"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtHealthReturn fromJsonValue(Object? json) {
    return YtHealthReturn.fromJson(raviJsonObject(json, "YtHealthReturn"));
  }
}

YtHealthReturn ytHealthReturnFromJson(Object? json) => YtHealthReturn.fromJsonValue(json);

class YtInfoOptions {
  const YtInfoOptions({this.connection});

  final String? connection;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
  }
}

class YtInfoReturn {
  const YtInfoReturn({required this.channel, required this.success});

  final RaviJson channel;
  final bool success;

  factory YtInfoReturn.fromJson(Map<String, Object?> json) {
    return YtInfoReturn(
      channel: RaviJson.from(json["channel"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtInfoReturn fromJsonValue(Object? json) {
    return YtInfoReturn.fromJson(raviJsonObject(json, "YtInfoReturn"));
  }
}

YtInfoReturn ytInfoReturnFromJson(Object? json) => YtInfoReturn.fromJsonValue(json);

class YtPlaylistOptions {
  const YtPlaylistOptions({this.connection, this.fields, this.limit, this.page});

  final String? connection;
  final String? fields;
  final String? limit;
  final String? page;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (page != null) {
      into["page"] = RaviJson.from(page);
    }
  }
}

class YtPlaylistReturn {
  const YtPlaylistReturn({this.nextPageToken, required this.playlistId, required this.success, required this.totalResults, required this.videos});

  final String? nextPageToken;
  final String playlistId;
  final bool success;
  final double totalResults;
  final List<RaviJson> videos;

  factory YtPlaylistReturn.fromJson(Map<String, Object?> json) {
    return YtPlaylistReturn(
      nextPageToken: json["nextPageToken"] == null ? null : raviJsonAsString(json["nextPageToken"]),
      playlistId: raviJsonAsString(json["playlistId"]),
      success: raviJsonAsBool(json["success"]),
      totalResults: raviJsonAsDouble(json["totalResults"]),
      videos: raviJsonAsList(json["videos"], RaviJson.from),
    );
  }

  static YtPlaylistReturn fromJsonValue(Object? json) {
    return YtPlaylistReturn.fromJson(raviJsonObject(json, "YtPlaylistReturn"));
  }
}

YtPlaylistReturn ytPlaylistReturnFromJson(Object? json) => YtPlaylistReturn.fromJsonValue(json);

class YtPlaylistAddOptions {
  const YtPlaylistAddOptions({this.connection, this.execute});

  final String? connection;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class YtPlaylistAddReturn {
  const YtPlaylistAddReturn({required this.item, required this.success});

  final RaviJson item;
  final bool success;

  factory YtPlaylistAddReturn.fromJson(Map<String, Object?> json) {
    return YtPlaylistAddReturn(
      item: RaviJson.from(json["item"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtPlaylistAddReturn fromJsonValue(Object? json) {
    return YtPlaylistAddReturn.fromJson(raviJsonObject(json, "YtPlaylistAddReturn"));
  }
}

YtPlaylistAddReturn ytPlaylistAddReturnFromJson(Object? json) => YtPlaylistAddReturn.fromJsonValue(json);

class YtPlaylistCreateOptions {
  const YtPlaylistCreateOptions({this.connection, this.description, this.execute, this.privacy});

  final String? connection;
  final String? description;
  final bool? execute;
  final String? privacy;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (privacy != null) {
      into["privacy"] = RaviJson.from(privacy);
    }
  }
}

class YtPlaylistCreateReturn {
  const YtPlaylistCreateReturn({required this.playlist, required this.success});

  final RaviJson playlist;
  final bool success;

  factory YtPlaylistCreateReturn.fromJson(Map<String, Object?> json) {
    return YtPlaylistCreateReturn(
      playlist: RaviJson.from(json["playlist"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtPlaylistCreateReturn fromJsonValue(Object? json) {
    return YtPlaylistCreateReturn.fromJson(raviJsonObject(json, "YtPlaylistCreateReturn"));
  }
}

YtPlaylistCreateReturn ytPlaylistCreateReturnFromJson(Object? json) => YtPlaylistCreateReturn.fromJsonValue(json);

class YtPlaylistDeleteOptions {
  const YtPlaylistDeleteOptions({this.connection, this.execute});

  final String? connection;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class YtPlaylistDeleteReturn {
  const YtPlaylistDeleteReturn({required this.deleted, required this.success});

  final String deleted;
  final bool success;

  factory YtPlaylistDeleteReturn.fromJson(Map<String, Object?> json) {
    return YtPlaylistDeleteReturn(
      deleted: raviJsonAsString(json["deleted"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtPlaylistDeleteReturn fromJsonValue(Object? json) {
    return YtPlaylistDeleteReturn.fromJson(raviJsonObject(json, "YtPlaylistDeleteReturn"));
  }
}

YtPlaylistDeleteReturn ytPlaylistDeleteReturnFromJson(Object? json) => YtPlaylistDeleteReturn.fromJsonValue(json);

class YtPlaylistRemoveOptions {
  const YtPlaylistRemoveOptions({this.connection, this.execute});

  final String? connection;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class YtPlaylistRemoveReturn {
  const YtPlaylistRemoveReturn({required this.removed, required this.success});

  final String removed;
  final bool success;

  factory YtPlaylistRemoveReturn.fromJson(Map<String, Object?> json) {
    return YtPlaylistRemoveReturn(
      removed: raviJsonAsString(json["removed"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtPlaylistRemoveReturn fromJsonValue(Object? json) {
    return YtPlaylistRemoveReturn.fromJson(raviJsonObject(json, "YtPlaylistRemoveReturn"));
  }
}

YtPlaylistRemoveReturn ytPlaylistRemoveReturnFromJson(Object? json) => YtPlaylistRemoveReturn.fromJsonValue(json);

class YtPlaylistsOptions {
  const YtPlaylistsOptions({this.connection, this.fields, this.limit, this.page});

  final String? connection;
  final String? fields;
  final String? limit;
  final String? page;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (page != null) {
      into["page"] = RaviJson.from(page);
    }
  }
}

class YtPlaylistsReturn {
  const YtPlaylistsReturn({this.nextPageToken, required this.playlists, required this.success, required this.totalResults});

  final String? nextPageToken;
  final List<RaviJson> playlists;
  final bool success;
  final double totalResults;

  factory YtPlaylistsReturn.fromJson(Map<String, Object?> json) {
    return YtPlaylistsReturn(
      nextPageToken: json["nextPageToken"] == null ? null : raviJsonAsString(json["nextPageToken"]),
      playlists: raviJsonAsList(json["playlists"], RaviJson.from),
      success: raviJsonAsBool(json["success"]),
      totalResults: raviJsonAsDouble(json["totalResults"]),
    );
  }

  static YtPlaylistsReturn fromJsonValue(Object? json) {
    return YtPlaylistsReturn.fromJson(raviJsonObject(json, "YtPlaylistsReturn"));
  }
}

YtPlaylistsReturn ytPlaylistsReturnFromJson(Object? json) => YtPlaylistsReturn.fromJsonValue(json);

class YtReplyOptions {
  const YtReplyOptions({this.connection, this.execute});

  final String? connection;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class YtReplyReturn {
  const YtReplyReturn({required this.replyId, required this.success});

  final String replyId;
  final bool success;

  factory YtReplyReturn.fromJson(Map<String, Object?> json) {
    return YtReplyReturn(
      replyId: raviJsonAsString(json["replyId"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtReplyReturn fromJsonValue(Object? json) {
    return YtReplyReturn.fromJson(raviJsonObject(json, "YtReplyReturn"));
  }
}

YtReplyReturn ytReplyReturnFromJson(Object? json) => YtReplyReturn.fromJsonValue(json);

class YtSearchOptions {
  const YtSearchOptions({this.connection, this.fields, this.limit, this.page});

  final String? connection;
  final String? fields;
  final String? limit;
  final String? page;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (page != null) {
      into["page"] = RaviJson.from(page);
    }
  }
}

class YtSearchReturn {
  const YtSearchReturn({this.nextPageToken, required this.query, required this.success, required this.totalResults, required this.videos});

  final String? nextPageToken;
  final String query;
  final bool success;
  final double totalResults;
  final List<RaviJson> videos;

  factory YtSearchReturn.fromJson(Map<String, Object?> json) {
    return YtSearchReturn(
      nextPageToken: json["nextPageToken"] == null ? null : raviJsonAsString(json["nextPageToken"]),
      query: raviJsonAsString(json["query"]),
      success: raviJsonAsBool(json["success"]),
      totalResults: raviJsonAsDouble(json["totalResults"]),
      videos: raviJsonAsList(json["videos"], RaviJson.from),
    );
  }

  static YtSearchReturn fromJsonValue(Object? json) {
    return YtSearchReturn.fromJson(raviJsonObject(json, "YtSearchReturn"));
  }
}

YtSearchReturn ytSearchReturnFromJson(Object? json) => YtSearchReturn.fromJsonValue(json);

class YtStatsOptions {
  const YtStatsOptions({this.connection});

  final String? connection;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
  }
}

class YtStatsReturn {
  const YtStatsReturn({required this.stats, required this.success});

  final RaviJson stats;
  final bool success;

  factory YtStatsReturn.fromJson(Map<String, Object?> json) {
    return YtStatsReturn(
      stats: RaviJson.from(json["stats"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtStatsReturn fromJsonValue(Object? json) {
    return YtStatsReturn.fromJson(raviJsonObject(json, "YtStatsReturn"));
  }
}

YtStatsReturn ytStatsReturnFromJson(Object? json) => YtStatsReturn.fromJsonValue(json);

class YtSubscriptionsOptions {
  const YtSubscriptionsOptions({this.connection, this.fields, this.limit, this.page});

  final String? connection;
  final String? fields;
  final String? limit;
  final String? page;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (page != null) {
      into["page"] = RaviJson.from(page);
    }
  }
}

class YtSubscriptionsReturn {
  const YtSubscriptionsReturn({this.nextPageToken, required this.subscriptions, required this.success, required this.totalResults});

  final String? nextPageToken;
  final List<RaviJson> subscriptions;
  final bool success;
  final double totalResults;

  factory YtSubscriptionsReturn.fromJson(Map<String, Object?> json) {
    return YtSubscriptionsReturn(
      nextPageToken: json["nextPageToken"] == null ? null : raviJsonAsString(json["nextPageToken"]),
      subscriptions: raviJsonAsList(json["subscriptions"], RaviJson.from),
      success: raviJsonAsBool(json["success"]),
      totalResults: raviJsonAsDouble(json["totalResults"]),
    );
  }

  static YtSubscriptionsReturn fromJsonValue(Object? json) {
    return YtSubscriptionsReturn.fromJson(raviJsonObject(json, "YtSubscriptionsReturn"));
  }
}

YtSubscriptionsReturn ytSubscriptionsReturnFromJson(Object? json) => YtSubscriptionsReturn.fromJsonValue(json);

class YtUnansweredOptions {
  const YtUnansweredOptions({this.connection, this.fields, this.limit, this.page});

  final String? connection;
  final String? fields;
  final String? limit;
  final String? page;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (page != null) {
      into["page"] = RaviJson.from(page);
    }
  }
}

class YtUnansweredReturn {
  const YtUnansweredReturn({required this.comments, this.nextPageToken, required this.success, required this.totalUnanswered, required this.videoId});

  final List<RaviJson> comments;
  final String? nextPageToken;
  final bool success;
  final double totalUnanswered;
  final String videoId;

  factory YtUnansweredReturn.fromJson(Map<String, Object?> json) {
    return YtUnansweredReturn(
      comments: raviJsonAsList(json["comments"], RaviJson.from),
      nextPageToken: json["nextPageToken"] == null ? null : raviJsonAsString(json["nextPageToken"]),
      success: raviJsonAsBool(json["success"]),
      totalUnanswered: raviJsonAsDouble(json["totalUnanswered"]),
      videoId: raviJsonAsString(json["videoId"]),
    );
  }

  static YtUnansweredReturn fromJsonValue(Object? json) {
    return YtUnansweredReturn.fromJson(raviJsonObject(json, "YtUnansweredReturn"));
  }
}

YtUnansweredReturn ytUnansweredReturnFromJson(Object? json) => YtUnansweredReturn.fromJsonValue(json);

class YtVideoOptions {
  const YtVideoOptions({this.connection});

  final String? connection;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
  }
}

class YtVideoReturn {
  const YtVideoReturn({required this.success, required this.video});

  final bool success;
  final RaviJson video;

  factory YtVideoReturn.fromJson(Map<String, Object?> json) {
    return YtVideoReturn(
      success: raviJsonAsBool(json["success"]),
      video: RaviJson.from(json["video"]),
    );
  }

  static YtVideoReturn fromJsonValue(Object? json) {
    return YtVideoReturn.fromJson(raviJsonObject(json, "YtVideoReturn"));
  }
}

YtVideoReturn ytVideoReturnFromJson(Object? json) => YtVideoReturn.fromJsonValue(json);

class YtVideoCategoriesOptions {
  const YtVideoCategoriesOptions({this.connection, this.region});

  final String? connection;
  final String? region;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (region != null) {
      into["region"] = RaviJson.from(region);
    }
  }
}

class YtVideoCategoriesReturn {
  const YtVideoCategoriesReturn({required this.categories, required this.region, required this.success, required this.totalResults});

  final List<RaviJson> categories;
  final String region;
  final bool success;
  final double totalResults;

  factory YtVideoCategoriesReturn.fromJson(Map<String, Object?> json) {
    return YtVideoCategoriesReturn(
      categories: raviJsonAsList(json["categories"], RaviJson.from),
      region: raviJsonAsString(json["region"]),
      success: raviJsonAsBool(json["success"]),
      totalResults: raviJsonAsDouble(json["totalResults"]),
    );
  }

  static YtVideoCategoriesReturn fromJsonValue(Object? json) {
    return YtVideoCategoriesReturn.fromJson(raviJsonObject(json, "YtVideoCategoriesReturn"));
  }
}

YtVideoCategoriesReturn ytVideoCategoriesReturnFromJson(Object? json) => YtVideoCategoriesReturn.fromJsonValue(json);

class YtVideoDeleteOptions {
  const YtVideoDeleteOptions({this.connection, this.execute});

  final String? connection;
  final bool? execute;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
  }
}

class YtVideoDeleteReturn {
  const YtVideoDeleteReturn({required this.deleted, required this.success});

  final String deleted;
  final bool success;

  factory YtVideoDeleteReturn.fromJson(Map<String, Object?> json) {
    return YtVideoDeleteReturn(
      deleted: raviJsonAsString(json["deleted"]),
      success: raviJsonAsBool(json["success"]),
    );
  }

  static YtVideoDeleteReturn fromJsonValue(Object? json) {
    return YtVideoDeleteReturn.fromJson(raviJsonObject(json, "YtVideoDeleteReturn"));
  }
}

YtVideoDeleteReturn ytVideoDeleteReturnFromJson(Object? json) => YtVideoDeleteReturn.fromJsonValue(json);

class YtVideoUpdateOptions {
  const YtVideoUpdateOptions({this.category, this.connection, this.description, this.execute, this.privacy, this.tags, this.title});

  final String? category;
  final String? connection;
  final String? description;
  final bool? execute;
  final String? privacy;
  final String? tags;
  final String? title;

  void encodeBody(Map<String, RaviJson> into) {
    if (category != null) {
      into["category"] = RaviJson.from(category);
    }
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (description != null) {
      into["description"] = RaviJson.from(description);
    }
    if (execute != null) {
      into["execute"] = RaviJson.from(execute);
    }
    if (privacy != null) {
      into["privacy"] = RaviJson.from(privacy);
    }
    if (tags != null) {
      into["tags"] = RaviJson.from(tags);
    }
    if (title != null) {
      into["title"] = RaviJson.from(title);
    }
  }
}

class YtVideoUpdateReturn {
  const YtVideoUpdateReturn({required this.success, required this.video});

  final bool success;
  final RaviJson video;

  factory YtVideoUpdateReturn.fromJson(Map<String, Object?> json) {
    return YtVideoUpdateReturn(
      success: raviJsonAsBool(json["success"]),
      video: RaviJson.from(json["video"]),
    );
  }

  static YtVideoUpdateReturn fromJsonValue(Object? json) {
    return YtVideoUpdateReturn.fromJson(raviJsonObject(json, "YtVideoUpdateReturn"));
  }
}

YtVideoUpdateReturn ytVideoUpdateReturnFromJson(Object? json) => YtVideoUpdateReturn.fromJsonValue(json);

class YtVideosOptions {
  const YtVideosOptions({this.connection, this.fields, this.limit, this.page});

  final String? connection;
  final String? fields;
  final String? limit;
  final String? page;

  void encodeBody(Map<String, RaviJson> into) {
    if (connection != null) {
      into["connection"] = RaviJson.from(connection);
    }
    if (fields != null) {
      into["fields"] = RaviJson.from(fields);
    }
    if (limit != null) {
      into["limit"] = RaviJson.from(limit);
    }
    if (page != null) {
      into["page"] = RaviJson.from(page);
    }
  }
}

class YtVideosReturn {
  const YtVideosReturn({this.nextPageToken, required this.success, required this.totalResults, required this.videos});

  final String? nextPageToken;
  final bool success;
  final double totalResults;
  final List<RaviJson> videos;

  factory YtVideosReturn.fromJson(Map<String, Object?> json) {
    return YtVideosReturn(
      nextPageToken: json["nextPageToken"] == null ? null : raviJsonAsString(json["nextPageToken"]),
      success: raviJsonAsBool(json["success"]),
      totalResults: raviJsonAsDouble(json["totalResults"]),
      videos: raviJsonAsList(json["videos"], RaviJson.from),
    );
  }

  static YtVideosReturn fromJsonValue(Object? json) {
    return YtVideosReturn.fromJson(raviJsonObject(json, "YtVideosReturn"));
  }
}

YtVideosReturn ytVideosReturnFromJson(Object? json) => YtVideosReturn.fromJsonValue(json);
