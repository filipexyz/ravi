import 'dart:convert';

class RaviIssue {
  const RaviIssue({this.path, this.code, this.message});

  final List<Object>? path;
  final String? code;
  final String? message;

  factory RaviIssue.fromJson(Map<String, Object?> json) {
    final rawPath = json['path'];
    return RaviIssue(
      path: rawPath is List ? rawPath.whereType<Object>().toList(growable: false) : null,
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

class RaviContractErrorPayload {
  const RaviContractErrorPayload({
    required this.code,
    required this.message,
    required this.retryable,
    this.details = const {},
  });

  final String code;
  final String message;
  final bool retryable;
  final Map<String, Object?> details;
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
  const RaviAuthError(super.message, {super.body, super.command, this.reason}) : super(status: 401);
  final String? reason;
}

class RaviPermissionError extends RaviError {
  const RaviPermissionError(super.message, {super.body, super.command, this.reason}) : super(status: 403);
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
  const RaviInternalError(super.message, {super.body, super.status = 500, super.command});
}

class RaviTransportError extends RaviError {
  const RaviTransportError(super.message, {this.cause, super.command}) : super(status: 0);
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

  factory RaviContractError.returnShape(String message, {String? command, Map<String, Object?>? body}) {
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
      body: parsed,
      command: command,
    );
  }

  final message = _pickMessage(parsed) ?? 'Ravi gateway returned HTTP $statusCode';
  switch (statusCode) {
    case 401:
      return RaviAuthError(
        message,
        body: parsed,
        command: command,
        reason: parsed?['reason'] is String ? parsed!['reason'] as String : null,
      );
    case 403:
      return RaviPermissionError(
        message,
        body: parsed,
        command: command,
        reason: parsed?['reason'] is String ? parsed!['reason'] as String : message,
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
        return RaviInternalError(message, body: parsed, status: statusCode, command: command);
      }
      return RaviError(message, status: statusCode, body: parsed, command: command);
  }
}

Map<String, Object?>? tryParseJsonObject(String raw) {
  if (raw.isEmpty) return null;
  try {
    final decoded = jsonDecode(raw);
    if (decoded is Map<String, Object?>) return decoded;
    if (decoded is Map) {
      return {for (final entry in decoded.entries) entry.key.toString(): entry.value};
    }
    return {'error': 'MalformedResponse', 'message': raw.length > 1024 ? raw.substring(0, 1024) : raw};
  } catch (_) {
    return {'error': 'MalformedResponse', 'message': raw.length > 1024 ? raw.substring(0, 1024) : raw};
  }
}

RaviContractErrorBody? tryContractBody(Map<String, Object?> body) {
  if (body['success'] != false || body['op'] is! String) return null;
  final exitCode = body['exitCode'];
  if (exitCode != 1 && exitCode != 2 && exitCode != 3) return null;
  final outcome = RaviContractOutcome.tryParse(body['outcome'] is String ? body['outcome'] as String : null);
  if (outcome == null) return null;
  final expected = exitCode == 1
      ? {RaviContractOutcome.failed, RaviContractOutcome.denied}
      : exitCode == 2
      ? {RaviContractOutcome.usageError}
      : {RaviContractOutcome.blocked};
  if (!expected.contains(outcome)) return null;
  final error = body['error'];
  if (error is! Map) return null;
  final errorMap = {for (final entry in error.entries) entry.key.toString(): entry.value};
  final code = errorMap['code'];
  final message = errorMap['message'];
  final retryable = errorMap['retryable'];
  if (code is! String || message is! String || retryable is! bool) return null;
  if (outcome == RaviContractOutcome.denied && code != 'PERMISSION_DENIED') return null;
  if (code == 'PERMISSION_DENIED' && outcome != RaviContractOutcome.denied) return null;
  return RaviContractErrorBody(
    op: body['op'] as String,
    error: RaviContractErrorPayload(code: code, message: message, retryable: retryable),
    exitCode: exitCode as int,
    outcome: outcome,
  );
}

List<RaviIssue> parseIssues(Object? value) {
  if (value is! List) return const [];
  return value
      .whereType<Map<Object?, Object?>>()
      .map((issue) => RaviIssue.fromJson({for (final entry in issue.entries) entry.key.toString(): entry.value}))
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
