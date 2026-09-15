import 'dart:convert';

import 'package:http/http.dart' as http;

import 'ravi_error.dart';
import 'ravi_json.dart';
import 'ravi_transport.dart';
import 'ravi_version.generated.dart';

class HttpTransport implements RaviTransport {
  HttpTransport({
    required this.baseUrl,
    required this.contextKey,
    http.Client? client,
    this.timeout,
    this.headers = const {},
  }) : _client = client ?? http.Client(),
       _ownsClient = client == null;

  final Uri baseUrl;
  final String contextKey;
  final Duration? timeout;
  final Map<String, String> headers;
  final http.Client _client;
  final bool _ownsClient;

  void close() {
    if (_ownsClient) _client.close();
  }

  @override
  Future<T> callJson<T>({
    required List<String> groupSegments,
    required String command,
    required Map<String, RaviJson> body,
    required T Function(Object? json) decode,
  }) async {
    final commandLabel = '${groupSegments.join('.')}.$command';
    final response = await _send(
      groupSegments: groupSegments,
      command: command,
      body: body,
      binary: false,
      commandLabel: commandLabel,
    );
    final raw = response.body;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw buildRaviError(statusCode: response.statusCode, body: raw, command: commandLabel);
    }
    if (raw.isEmpty) {
      try {
        return decode(<String, Object?>{});
      } on FormatException catch (error) {
        throw RaviContractError.returnShape(error.message, command: commandLabel, body: const {});
      }
    }
    Object? parsed;
    try {
      parsed = jsonDecode(raw);
    } on FormatException catch (error) {
      throw RaviContractError.returnShape(
        'Malformed JSON response: ${error.message}',
        command: commandLabel,
        body: {'error': 'MalformedResponse', 'message': raw.length > 1024 ? raw.substring(0, 1024) : raw},
      );
    }
    try {
      return decode(parsed);
    } on FormatException catch (error) {
      throw RaviContractError.returnShape(
        error.message,
        command: commandLabel,
        body: parsed is Map<String, Object?>
            ? parsed
            : parsed is Map
            ? {for (final entry in parsed.entries) entry.key.toString(): entry.value}
            : {'value': parsed},
      );
    }
  }

  @override
  Future<RaviBinaryResponse> callBinary({
    required List<String> groupSegments,
    required String command,
    required Map<String, RaviJson> body,
  }) async {
    final commandLabel = '${groupSegments.join('.')}.$command';
    final response = await _send(
      groupSegments: groupSegments,
      command: command,
      body: body,
      binary: true,
      commandLabel: commandLabel,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw buildRaviError(statusCode: response.statusCode, body: response.body, command: commandLabel);
    }
    return RaviBinaryResponse(
      bytes: response.bodyBytes,
      contentType: response.headers['content-type'],
      statusCode: response.statusCode,
      headers: response.headers,
    );
  }

  Future<http.Response> _send({
    required List<String> groupSegments,
    required String command,
    required Map<String, RaviJson> body,
    required bool binary,
    required String commandLabel,
  }) async {
    final url = _commandUrl(groupSegments, command);
    final requestHeaders = <String, String>{
      'content-type': 'application/json',
      'accept': binary ? 'application/octet-stream, */*' : 'application/json',
      'authorization': 'Bearer $contextKey',
      'x-ravi-sdk-version': raviSdkVersion,
      'x-ravi-registry-hash': raviRegistryHash,
      ...headers,
    };
    try {
      final future = _client.post(
        url,
        headers: requestHeaders,
        body: jsonEncode(RaviJson.encodeBody(body)),
      );
      return timeout == null ? await future : await future.timeout(timeout!);
    } catch (error) {
      throw RaviTransportError(
        error is Exception ? error.toString() : 'network error calling $commandLabel',
        cause: error,
        command: commandLabel,
      );
    }
  }

  Uri _commandUrl(List<String> groupSegments, String command) {
    final existing = baseUrl.path.replaceAll(RegExp(r'^/+|/+$'), '');
    final apiPath = ['api', 'v1', ...groupSegments, command].map(Uri.encodeComponent).join('/');
    final path = '/${[existing, apiPath].where((part) => part.isNotEmpty).join('/')}';
    return baseUrl.replace(path: path);
  }
}
