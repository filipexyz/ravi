/// Errors raised by the thin Ravi HTTP client.
class RaviClientException implements Exception {
  const RaviClientException(
    this.message, {
    this.status,
    this.command,
    this.isAuth = false,
    this.isNetwork = false,
    this.isMissingKey = false,
  });

  final String message;
  final int? status;
  final String? command;
  final bool isAuth;
  final bool isNetwork;
  final bool isMissingKey;

  factory RaviClientException.missingKey() {
    return const RaviClientException(
      'A runtime context key (rctx_*) is required.',
      isAuth: true,
      isMissingKey: true,
    );
  }

  factory RaviClientException.network(String message, {String? command}) {
    return RaviClientException(
      message,
      command: command,
      isNetwork: true,
    );
  }

  factory RaviClientException.fromGateway({
    required int status,
    required String command,
    Object? body,
  }) {
    final parsed = _messageFromBody(body);
    return RaviClientException(
      parsed ?? 'Gateway returned $status for $command.',
      status: status,
      command: command,
      isAuth: status == 401 || status == 403,
    );
  }

  static String? _messageFromBody(Object? body) {
    if (body is Map) {
      final error = body['error'];
      if (error is Map) {
        final nested = error['message'];
        if (nested is String && nested.isNotEmpty) return nested;
      }
      final message = body['message'];
      if (message is String && message.isNotEmpty) return message;
      if (error is String && error.isNotEmpty) return error;
    }
    if (body is String && body.isNotEmpty) return body;
    return null;
  }

  @override
  String toString() => message;
}
