import 'dart:convert';

class RaviIssue {
  const RaviIssue({this.path, this.code, this.message});

  final List<Object>? path;
  final String? code;
  final String? message;

  factory RaviIssue.fromJson(Map<String, Object?> json) {
    final rawPath = json['path'];
    return RaviIssue(
      path: rawPath is List
          ? rawPath.whereType<Object>().toList(growable: false)
          : null,
      code: json['code'] is String ? json['code'] as String : null,
      message: json['message'] is String ? json['message'] as String : null,
    );
  }
}

enum RaviContractOutcome {
  blocked,
  usageError,
  denied,
  failed;

  static RaviContractOutcome? tryParse(String? value) {
    switch (value) {
      case 'blocked':
        return RaviContractOutcome.blocked;
      case 'usage_error':
        return RaviContractOutcome.usageError;
      case 'denied':
        return RaviContractOutcome.denied;
      case 'failed':
        return RaviContractOutcome.failed;
      default:
        return null;
    }
  }
}

class RaviDiagnosticActor {
  const RaviDiagnosticActor({required this.type, required this.id});

  final String type;
  final String id;

  static RaviDiagnosticActor? tryParse(Object? value) {
    if (value is! Map) return null;
    final type = value['type'];
    final id = value['id'];
    if (type is! String ||
        id is! String ||
        !RegExp(r'^[a-z][a-z0-9_-]{0,31}$').hasMatch(type) ||
        !RegExp(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$').hasMatch(id) ||
        !_isDiagnosticIdentifier(id))
      return null;
    return RaviDiagnosticActor(type: type, id: id);
  }

  Map<String, Object?> toJson() => {'type': type, 'id': id};
}

class RaviDiagnosticContext {
  const RaviDiagnosticContext({
    this.status,
    this.provider,
    this.model,
    this.operation,
    this.actor,
    this.file,
    this.syscall,
    this.code,
  });

  final int? status;
  final String? provider;
  final String? model;
  final String? operation;
  final RaviDiagnosticActor? actor;
  final String? file;
  final String? syscall;
  final String? code;

  factory RaviDiagnosticContext.fromJson(Map<Object?, Object?> value) {
    String? text(String key) => value[key] is String
        ? _sanitizeContractString(value[key] as String)
        : null;
    String? identifier(String key) {
      final field = value[key];
      if (field is! String ||
          !RegExp(r'^[A-Za-z0-9_][A-Za-z0-9_.:/ -]{0,159}$').hasMatch(field) ||
          !_isDiagnosticIdentifier(field))
        return null;
      return field;
    }

    final status = value['status'];
    final file = text('file');
    return RaviDiagnosticContext(
      status:
          status is num &&
              status.isFinite &&
              status == status.roundToDouble() &&
              status >= 100 &&
              status <= 599
          ? status.toInt()
          : null,
      provider: identifier('provider'),
      model: identifier('model'),
      operation: identifier('operation'),
      file: file != null && file.length <= 4096 ? file : null,
      syscall: identifier('syscall'),
      code: identifier('code'),
      actor: RaviDiagnosticActor.tryParse(value['actor']),
    );
  }

  Map<String, Object?> toJson() => {
    if (status != null) 'status': status,
    if (provider != null) 'provider': provider,
    if (model != null) 'model': model,
    if (operation != null) 'operation': operation,
    if (actor != null) 'actor': actor!.toJson(),
    if (file != null) 'file': file,
    if (syscall != null) 'syscall': syscall,
    if (code != null) 'code': code,
  };
}

bool _isDiagnosticIdentifier(String value) =>
    !value.contains('://') &&
    _sanitizeContractString(value) == value &&
    !RegExp(
      r'(?:rctx_|sk-|gsk_|gh[pousr]_|github_pat_|xox[baprs]-|xapp-)',
      caseSensitive: false,
    ).hasMatch(value);

String _safeContractCode(String value) =>
    RegExp(r'^[A-Za-z][A-Za-z0-9_]{0,95}$').hasMatch(value) &&
        _isDiagnosticIdentifier(value)
    ? value
    : 'REMOTE_ERROR';

String _safeContractOperation(String value) =>
    value.length <= 160 &&
        RegExp(r'^[A-Za-z][A-Za-z0-9_-]*(?:[ .][A-Za-z][A-Za-z0-9_-]*)*$')
            .hasMatch(value) &&
        _isDiagnosticIdentifier(value)
    ? value
    : 'gateway';

class RaviContractErrorPayload {
  const RaviContractErrorPayload({
    required this.code,
    required this.message,
    required this.retryable,
    this.cause,
    this.context,
    this.details = const {},
  });

  final String code;
  final String message;
  final bool retryable;
  final String? cause;
  final RaviDiagnosticContext? context;
  final Map<String, Object?> details;

  Map<String, Object?> toJson() => {
    ...details,
    'code': code,
    'message': message,
    'retryable': retryable,
    if (cause != null) 'cause': cause,
    if (context != null) 'context': context!.toJson(),
  };
}

class RaviContractErrorBody {
  const RaviContractErrorBody({
    required this.op,
    required this.error,
    required this.exitCode,
    required this.outcome,
  });

  final String op;
  final RaviContractErrorPayload error;
  final int exitCode;
  final RaviContractOutcome outcome;

  Map<String, Object?> toJson() => {
    'success': false,
    'op': op,
    'error': error.toJson(),
    'exitCode': exitCode,
    'outcome': outcome == RaviContractOutcome.usageError
        ? 'usage_error'
        : outcome.name,
  };
}

class RaviError implements Exception {
  const RaviError(this.message, {this.status = 0, this.command, this.body});

  final String message;
  final int status;
  final String? command;
  final Map<String, Object?>? body;

  @override
  String toString() => 'RaviError($status): $message';
}

class RaviAuthError extends RaviError {
  const RaviAuthError(super.message, {super.body, super.command, this.reason})
    : super(status: 401);
  final String? reason;
}

class RaviPermissionError extends RaviError {
  const RaviPermissionError(
    super.message, {
    super.body,
    super.command,
    this.reason,
  }) : super(status: 403);
  final String? reason;
}

class RaviValidationError extends RaviError {
  const RaviValidationError(
    super.message, {
    this.issues = const [],
    super.status = 400,
    super.body,
    super.command,
  });

  final List<RaviIssue> issues;
}

class RaviInternalError extends RaviError {
  const RaviInternalError(
    super.message, {
    super.body,
    super.status = 500,
    super.command,
  });
}

class RaviTransportError extends RaviError {
  const RaviTransportError(super.message, {this.cause, super.command})
    : super(status: 0);
  final Object? cause;
}

class RaviContractError extends RaviError {
  const RaviContractError(
    super.message, {
    required this.op,
    required this.code,
    required this.retryable,
    required this.exitCode,
    required this.outcome,
    this.contractBody,
    super.status = 0,
    super.body,
    super.command,
  });

  factory RaviContractError.returnShape(
    String message, {
    String? command,
    Map<String, Object?>? body,
  }) {
    return RaviContractError(
      message,
      op: command ?? 'sdk.decode',
      code: 'RETURN_SHAPE',
      retryable: false,
      exitCode: 1,
      outcome: RaviContractOutcome.failed,
      command: command,
      body: body,
    );
  }

  final String op;
  final String code;
  final bool retryable;
  final int exitCode;
  final RaviContractOutcome outcome;
  final RaviContractErrorBody? contractBody;
  String? get cause => contractBody?.error.cause;
  RaviDiagnosticContext? get context => contractBody?.error.context;
}

RaviError buildRaviError({
  required int statusCode,
  required String body,
  String? command,
}) {
  final parsed = tryParseJsonObject(body);
  final contract = parsed == null ? null : tryContractBody(parsed);
  if (contract != null) {
    return RaviContractError(
      contract.error.message,
      op: contract.op,
      code: contract.error.code,
      retryable: contract.error.retryable,
      exitCode: contract.exitCode,
      outcome: contract.outcome,
      contractBody: contract,
      status: statusCode,
      body: contract.toJson(),
      command: command,
    );
  }

  final message =
      _pickMessage(parsed) ?? 'Ravi gateway returned HTTP $statusCode';
  switch (statusCode) {
    case 401:
      return RaviAuthError(
        message,
        body: parsed,
        command: command,
        reason: parsed?['reason'] is String
            ? parsed!['reason'] as String
            : null,
      );
    case 403:
      return RaviPermissionError(
        message,
        body: parsed,
        command: command,
        reason: parsed?['reason'] is String
            ? parsed!['reason'] as String
            : message,
      );
    default:
      if (statusCode >= 400 && statusCode < 500) {
        return RaviValidationError(
          message,
          issues: parseIssues(parsed?['issues']),
          status: statusCode,
          body: parsed,
          command: command,
        );
      }
      if (statusCode >= 500) {
        return RaviInternalError(
          message,
          body: parsed,
          status: statusCode,
          command: command,
        );
      }
      return RaviError(
        message,
        status: statusCode,
        body: parsed,
        command: command,
      );
  }
}

Map<String, Object?>? tryParseJsonObject(String raw) {
  if (raw.isEmpty) return null;
  try {
    final decoded = jsonDecode(raw);
    if (decoded is Map<String, Object?>) return decoded;
    if (decoded is Map) {
      return {
        for (final entry in decoded.entries) entry.key.toString(): entry.value,
      };
    }
    return {
      'error': 'MalformedResponse',
      'message': raw.length > 1024 ? raw.substring(0, 1024) : raw,
    };
  } catch (_) {
    return {
      'error': 'MalformedResponse',
      'message': raw.length > 1024 ? raw.substring(0, 1024) : raw,
    };
  }
}

RaviContractErrorBody? tryContractBody(Map<String, Object?> body) {
  if (body['success'] != false || body['op'] is! String) return null;
  final exitCode = body['exitCode'];
  if (exitCode != 1 && exitCode != 2 && exitCode != 3) return null;
  final outcome = RaviContractOutcome.tryParse(
    body['outcome'] is String ? body['outcome'] as String : null,
  );
  if (outcome == null) return null;
  final expected = exitCode == 1
      ? {RaviContractOutcome.failed, RaviContractOutcome.denied}
      : exitCode == 2
      ? {RaviContractOutcome.usageError}
      : {RaviContractOutcome.blocked};
  if (!expected.contains(outcome)) return null;
  final error = body['error'];
  if (error is! Map) return null;
  final errorMap = {
    for (final entry in error.entries) entry.key.toString(): entry.value,
  };
  final code = errorMap['code'];
  final message = errorMap['message'];
  final retryable = errorMap['retryable'];
  if (code is! String || message is! String || retryable is! bool) return null;
  if (outcome == RaviContractOutcome.denied && code != 'PERMISSION_DENIED')
    return null;
  if (code == 'PERMISSION_DENIED' && outcome != RaviContractOutcome.denied)
    return null;
  return RaviContractErrorBody(
    op: _safeContractOperation(body['op'] as String),
    error: RaviContractErrorPayload(
      code: _safeContractCode(code),
      message: message,
      retryable: retryable,
      cause: errorMap['cause'] is String
          ? _sanitizeContractString(errorMap['cause'] as String)
          : null,
      context: errorMap['context'] is Map
          ? RaviDiagnosticContext.fromJson(errorMap['context'] as Map)
          : null,
      details: _projectContractDetails(errorMap),
    ),
    exitCode: exitCode as int,
    outcome: outcome,
  );
}

Map<String, Object?> _projectContractDetails(Map<String, Object?> source) {
  final result = <String, Object?>{};
  for (final key in ['suggestedAction', 'usage']) {
    final value = source[key];
    if (value is String) result[key] = _sanitizeContractString(value);
  }
  for (final key in [
    'suggestions',
    'acceptedFlags',
    'acceptedPositionals',
    'acceptedValues',
  ]) {
    final value = source[key];
    if (value is List) {
      result[key] = value
          .whereType<String>()
          .take(64)
          .map(_sanitizeContractString)
          .toList(growable: false);
    }
  }
  for (final key in ['requestId', 'diagnosticRequestId']) {
    final value = source[key];
    if (value is String &&
        RegExp(
          r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$',
          caseSensitive: false,
        ).hasMatch(value)) {
      result[key] = value;
    }
  }
  final field = source['field'];
  if (field is String && RegExp(r'^[a-z][A-Za-z0-9_]{0,63}$').hasMatch(field))
    result['field'] = field;
  final argument = source['argument'];
  if (argument is String &&
      RegExp(r'^--[a-z][a-z0-9-]{0,63}$').hasMatch(argument))
    result['argument'] = argument;
  if (source['dryRun'] is bool) result['dryRun'] = source['dryRun'];
  final status = source['status'];
  if (status is num && status.isFinite) result['status'] = status;
  return result;
}

String _sanitizeContractString(String value) => value
    .replaceAll(RegExp(r'rctx_[A-Za-z0-9_-]+'), '[REDACTED:rctx]')
    .replaceAll(
      RegExp(r'\bBearer\s+[A-Za-z0-9._~+/-]+=*', caseSensitive: false),
      'Bearer [REDACTED]',
    )
    .replaceAll(
      RegExp(r'\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b'),
      '[REDACTED:token]',
    );

List<RaviIssue> parseIssues(Object? value) {
  if (value is! List) return const [];
  return value
      .whereType<Map<Object?, Object?>>()
      .map(
        (issue) => RaviIssue.fromJson({
          for (final entry in issue.entries) entry.key.toString(): entry.value,
        }),
      )
      .toList(growable: false);
}

String? _pickMessage(Map<String, Object?>? body) {
  if (body == null) return null;
  for (final key in ['message', 'reason', 'error']) {
    final value = body[key];
    if (value is String && value.isNotEmpty) return value;
  }
  return null;
}
