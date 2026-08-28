import 'ravi_json.dart';

abstract class RaviTransport {
  Future<T> callJson<T>({
    required List<String> groupSegments,
    required String command,
    required Map<String, RaviJson> body,
    required T Function(Object? json) decode,
  });

  Future<RaviBinaryResponse> callBinary({
    required List<String> groupSegments,
    required String command,
    required Map<String, RaviJson> body,
  });
}

class RaviBinaryResponse {
  const RaviBinaryResponse({
    required this.bytes,
    this.contentType,
    required this.statusCode,
    required this.headers,
  });

  final List<int> bytes;
  final String? contentType;
  final int statusCode;
  final Map<String, String> headers;
}
