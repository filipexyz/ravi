/// Thin models for the commands this first screen needs.
///
/// Shapes follow `@ravi-os/sdk` (`agents.list`, `sessions.read`, `sessions.send`).
library;

class AgentSummary {
  const AgentSummary({
    required this.id,
    required this.cwd,
    required this.isDefault,
    required this.effectiveProvider,
    this.name,
    this.mode,
    this.effectiveModel,
  });

  final String id;
  final String cwd;
  final bool isDefault;
  final String effectiveProvider;
  final String? name;
  final String? mode;
  final String? effectiveModel;

  String get displayName {
    final labeled = name?.trim();
    if (labeled != null && labeled.isNotEmpty) return labeled;
    return id;
  }

  String get initials {
    final source = displayName.trim();
    if (source.isEmpty) return '?';
    final parts = source.split(RegExp(r'[\s_\-:]+')).where((p) => p.isNotEmpty).toList();
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return source.substring(0, source.length >= 2 ? 2 : 1).toUpperCase();
  }

  factory AgentSummary.fromJson(Map<String, Object?> json) {
    return AgentSummary(
      id: json['id'] as String? ?? '',
      cwd: json['cwd'] as String? ?? '',
      isDefault: json['isDefault'] == true,
      effectiveProvider: json['effectiveProvider'] as String? ?? '',
      name: json['name'] as String?,
      mode: json['mode'] as String?,
      effectiveModel: json['effectiveModel'] as String?,
    );
  }
}

class AgentsListResult {
  const AgentsListResult({
    required this.agents,
    required this.defaultAgent,
  });

  final List<AgentSummary> agents;
  final String defaultAgent;

  factory AgentsListResult.fromJson(Map<String, Object?> json) {
    final raw = json['agents'] ?? json['items'];
    final agents = <AgentSummary>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          agents.add(AgentSummary.fromJson(item.cast<String, Object?>()));
        }
      }
    }
    return AgentsListResult(
      agents: agents,
      defaultAgent: json['defaultAgent'] as String? ?? '',
    );
  }
}

class AgentSessionInfo {
  const AgentSessionInfo({
    required this.name,
    required this.sessionKey,
    this.agentId,
    this.label,
  });

  final String name;
  final String sessionKey;
  final String? agentId;
  final String? label;

  factory AgentSessionInfo.fromJson(Map<String, Object?> json) {
    final name = (json['name'] as String?)?.trim();
    final sessionKey = (json['sessionKey'] as String?)?.trim() ?? '';
    return AgentSessionInfo(
      name: (name != null && name.isNotEmpty) ? name : sessionKey,
      sessionKey: sessionKey,
      agentId: json['agentId'] as String?,
      label: json['label'] as String?,
    );
  }
}

class AgentsSessionResult {
  const AgentsSessionResult({
    required this.sessions,
    required this.total,
  });

  final List<AgentSessionInfo> sessions;
  final int total;

  factory AgentsSessionResult.fromJson(Map<String, Object?> json) {
    final sessions = <AgentSessionInfo>[];
    final raw = json['sessions'];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          sessions.add(AgentSessionInfo.fromJson(item.cast<String, Object?>()));
        }
      }
    }
    return AgentsSessionResult(
      sessions: sessions,
      total: (json['total'] as num?)?.toInt() ?? sessions.length,
    );
  }

  /// Prefer the agent's main session, then the first listed session.
  String? resolveMainSessionName(String agentId) {
    if (sessions.isEmpty) return null;
    for (final session in sessions) {
      if (session.name == agentId ||
          session.name == 'main' ||
          session.name.endsWith(':main') ||
          session.sessionKey == 'agent:$agentId:main') {
        return session.name.isNotEmpty ? session.name : session.sessionKey;
      }
    }
    final first = sessions.first;
    return first.name.isNotEmpty ? first.name : first.sessionKey;
  }
}

class SessionMessage {
  const SessionMessage({
    required this.role,
    required this.text,
    this.id,
    this.time,
    this.createdAt,
    this.source,
  });

  final String role;
  final String text;
  final String? id;
  final String? time;
  final DateTime? createdAt;
  final String? source;

  bool get isUser => role == 'user';
  bool get isAssistant => role == 'assistant';

  String get preview {
    final compact = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (compact.length <= 72) return compact;
    return '${compact.substring(0, 71)}…';
  }

  String get timeLabel {
    if (time != null && time!.trim().isNotEmpty) {
      final value = time!.trim();
      if (value.length <= 12) return value;
      final parsed = DateTime.tryParse(value);
      if (parsed != null) return _clock(parsed.toLocal());
      return value;
    }
    if (createdAt != null) return _clock(createdAt!.toLocal());
    return '';
  }

  factory SessionMessage.fromJson(Map<String, Object?> json) {
    final text = (json['text'] as String?) ?? (json['content'] as String?) ?? '';
    return SessionMessage(
      role: json['role'] as String? ?? 'assistant',
      text: text,
      id: json['id'] as String?,
      time: json['time'] as String?,
      createdAt: _parseTimestamp(json['createdAt']),
      source: json['source'] as String?,
    );
  }

  static DateTime? _parseTimestamp(Object? value) {
    if (value is num) {
      final n = value.toInt();
      if (n > 1000000000000) return DateTime.fromMillisecondsSinceEpoch(n);
      if (n > 1000000000) return DateTime.fromMillisecondsSinceEpoch(n * 1000);
    }
    if (value is String && value.isNotEmpty) return DateTime.tryParse(value);
    return null;
  }

  static String _clock(DateTime time) {
    final hh = time.hour.toString().padLeft(2, '0');
    final mm = time.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }
}

class SessionReadResult {
  const SessionReadResult({
    required this.messages,
    this.sessionName,
    this.sessionKey,
    this.agentId,
    this.label,
  });

  final List<SessionMessage> messages;
  final String? sessionName;
  final String? sessionKey;
  final String? agentId;
  final String? label;

  factory SessionReadResult.fromJson(Map<String, Object?> json) {
    if (json['ok'] == false) {
      return const SessionReadResult(messages: []);
    }
    final messages = <SessionMessage>[];
    final raw = json['messages'];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          messages.add(SessionMessage.fromJson(item.cast<String, Object?>()));
        }
      }
    }
    final session = json['session'];
    Map<String, Object?>? sessionMap;
    if (session is Map) {
      sessionMap = session.cast<String, Object?>();
    }
    return SessionReadResult(
      messages: messages,
      sessionName: sessionMap?['name'] as String?,
      sessionKey: sessionMap?['sessionKey'] as String?,
      agentId: sessionMap?['agentId'] as String?,
      label: sessionMap?['label'] as String?,
    );
  }
}

class SessionSendResult {
  const SessionSendResult({
    required this.published,
    required this.mode,
    this.responseText,
    this.sessionName,
    this.sessionKey,
    this.agentId,
  });

  final bool published;
  final String mode;
  final String? responseText;
  final String? sessionName;
  final String? sessionKey;
  final String? agentId;

  factory SessionSendResult.fromJson(Map<String, Object?> json) {
    final session = json['session'];
    Map<String, Object?>? sessionMap;
    if (session is Map) {
      sessionMap = session.cast<String, Object?>();
    }
    final response = json['response'];
    String? responseText;
    if (response is Map) {
      responseText = response['text'] as String?;
    }
    return SessionSendResult(
      published: json['published'] == true,
      mode: json['mode'] as String? ?? 'fire-and-forget',
      responseText: responseText,
      sessionName: sessionMap?['name'] as String?,
      sessionKey: sessionMap?['sessionKey'] as String?,
      agentId: sessionMap?['agentId'] as String?,
    );
  }
}

class ContextIdentity {
  const ContextIdentity({
    required this.contextId,
    required this.kind,
    this.issuedFor,
    this.agentId,
    this.sessionName,
    this.status,
  });

  final String contextId;
  final String kind;
  final String? issuedFor;
  final String? agentId;
  final String? sessionName;
  final String? status;

  String get displayName {
    final named = issuedFor?.trim();
    if (named != null && named.isNotEmpty) return named;
    if (kind.isNotEmpty) return kind;
    return 'Local runtime';
  }

  String get initials {
    final source = displayName.trim();
    if (source.isEmpty) return 'RD';
    final parts = source.split(RegExp(r'[\s_\-:]+')).where((p) => p.isNotEmpty).toList();
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return source.substring(0, source.length >= 2 ? 2 : 1).toUpperCase();
  }

  factory ContextIdentity.fromJson(Map<String, Object?> json) {
    return ContextIdentity(
      contextId: json['contextId'] as String? ?? '',
      kind: json['kind'] as String? ?? '',
      issuedFor: json['issuedFor'] as String?,
      agentId: json['agentId'] as String?,
      sessionName: json['sessionName'] as String?,
      status: json['status'] as String?,
    );
  }
}

class RaviSseEvent {
  const RaviSseEvent({
    required this.event,
    this.id,
    this.data,
  });

  final String event;
  final String? id;
  final Object? data;

  bool get isEnd => event == 'end';
}
