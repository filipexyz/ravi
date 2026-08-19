import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/gateway_settings.dart';
import 'errors.dart';
import 'models.dart';
import 'sse.dart';

/// Commands this first screen talks to. Names match CLI / `@ravi-os/sdk`.
abstract class RaviDeskApi {
  Future<AgentsListResult> listAgents({String limit = '50'});
  Future<AgentsSessionResult> agentSession(String id);
  Future<SessionReadResult> readSession({String? nameOrKey, String count = '50'});
  Future<SessionSendResult> sendSession({
    required String nameOrKey,
    required String prompt,
    bool wait = false,
  });
  Future<ContextIdentity> whoami();
  Stream<RaviSseEvent> streamSession(String name, {AbortSignal? signal});
}

class AbortSignal {
  AbortSignal() : _controller = StreamController<void>.broadcast();

  final StreamController<void> _controller;
  bool _aborted = false;

  bool get aborted => _aborted;
  Stream<void> get onAbort => _controller.stream;

  void abort() {
    if (_aborted) return;
    _aborted = true;
    _controller.add(null);
    _controller.close();
  }
}

/// Hand-written HTTP client for the Ravi SDK gateway.
///
/// This is **not** an official Dart SDK and does not cover the full registry.
/// Every call POSTs `${baseUrl}/api/v1/<group-segments>/<command>` with a flat
/// JSON body, `Authorization: Bearer <rctx_*>`, and optional drift headers.
class RaviHttpClient implements RaviDeskApi {
  RaviHttpClient({
    required this.settings,
    http.Client? httpClient,
    this.sdkVersion = kDeskSdkVersion,
    this.registryHash,
    this.timeout = const Duration(seconds: 20),
  }) : _http = httpClient ?? http.Client();

  GatewaySettings settings;
  final http.Client _http;
  final String sdkVersion;
  final String? registryHash;
  final Duration timeout;

  Uri commandUri(List<String> groupSegments, String command) {
    final path = ['api', 'v1', ...groupSegments, command].join('/');
    return settings.origin.replace(path: '/$path');
  }

  Uri streamUri(List<String> parts, [Map<String, String>? query]) {
    final path = ['api', 'v1', '_stream', ...parts].join('/');
    return settings.origin.replace(path: '/$path', queryParameters: query);
  }

  Map<String, String> _headers({bool sse = false}) {
    final key = settings.contextKey.trim();
    if (key.isEmpty) {
      throw RaviClientException.missingKey();
    }
    return {
      'accept': sse ? 'text/event-stream' : 'application/json',
      if (!sse) 'content-type': 'application/json',
      'authorization': 'Bearer $key',
      'x-ravi-sdk-version': sdkVersion,
      if (registryHash != null && registryHash!.isNotEmpty) 'x-ravi-registry-hash': registryHash!,
    };
  }

  Future<Map<String, Object?>> call(
    List<String> groupSegments,
    String command, {
    Map<String, Object?> body = const {},
    Duration? timeout,
  }) async {
    final commandLabel = [...groupSegments, command].join('.');
    final uri = commandUri(groupSegments, command);
    late final http.Response response;
    try {
      response = await _http
          .post(
            uri,
            headers: _headers(),
            body: jsonEncode(body),
          )
          .timeout(timeout ?? this.timeout);
    } on RaviClientException {
      rethrow;
    } on TimeoutException {
      throw RaviClientException.network('Timed out calling $commandLabel.', command: commandLabel);
    } catch (error) {
      throw RaviClientException.network(
        _networkMessage(error, commandLabel),
        command: commandLabel,
      );
    }

    Object? parsed;
    if (response.body.isNotEmpty) {
      try {
        parsed = jsonDecode(response.body);
      } catch (_) {
        parsed = response.body;
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw RaviClientException.fromGateway(
        status: response.statusCode,
        command: commandLabel,
        body: parsed,
      );
    }

    if (parsed is Map<String, Object?>) return parsed;
    if (parsed is Map) return parsed.cast<String, Object?>();
    return <String, Object?>{};
  }

  @override
  Future<AgentsListResult> listAgents({String limit = '50'}) async {
    final json = await call(['agents'], 'list', body: {'limit': limit});
    return AgentsListResult.fromJson(json);
  }

  @override
  Future<AgentsSessionResult> agentSession(String id) async {
    final json = await call(['agents'], 'session', body: {'id': id});
    return AgentsSessionResult.fromJson(json);
  }

  @override
  Future<SessionReadResult> readSession({String? nameOrKey, String count = '50'}) async {
    final json = await call(
      ['sessions'],
      'read',
      body: {
        if (nameOrKey != null && nameOrKey.isNotEmpty) 'nameOrKey': nameOrKey,
        'count': count,
      },
    );
    return SessionReadResult.fromJson(json);
  }

  @override
  Future<SessionSendResult> sendSession({
    required String nameOrKey,
    required String prompt,
    bool wait = false,
  }) async {
    final json = await call(
      ['sessions'],
      'send',
      body: {
        'nameOrKey': nameOrKey,
        'prompt': prompt,
        'wait': wait,
      },
      timeout: wait ? const Duration(minutes: 3) : timeout,
    );
    return SessionSendResult.fromJson(json);
  }

  @override
  Future<ContextIdentity> whoami() async {
    final json = await call(['context'], 'whoami');
    return ContextIdentity.fromJson(json);
  }

  @override
  Stream<RaviSseEvent> streamSession(String name, {AbortSignal? signal}) {
    return _openSse(streamUri(['sessions', name]), signal: signal);
  }

  Stream<RaviSseEvent> _openSse(Uri uri, {AbortSignal? signal}) async* {
    final request = http.Request('GET', uri);
    request.headers.addAll(_headers(sse: true));
    late final http.StreamedResponse response;
    try {
      response = await _http.send(request);
    } on RaviClientException {
      rethrow;
    } catch (error) {
      throw RaviClientException.network(_networkMessage(error, 'sdk.stream'), command: 'sdk.stream');
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      final raw = await response.stream.bytesToString();
      Object? parsed;
      try {
        parsed = raw.isEmpty ? null : jsonDecode(raw);
      } catch (_) {
        parsed = raw;
      }
      throw RaviClientException.fromGateway(
        status: response.statusCode,
        command: 'sdk.stream',
        body: parsed,
      );
    }

    if (signal?.aborted == true) {
      return;
    }

    final parser = SseParser();
    final controller = StreamController<RaviSseEvent>();
    StreamSubscription<List<int>>? sub;
    void closeAll() {
      sub?.cancel();
      if (!controller.isClosed) controller.close();
    }

    if (signal != null) {
      signal.onAbort.listen((_) => closeAll());
    }

    sub = response.stream.listen(
      (chunk) {
        for (final event in parser.add(utf8.decode(chunk))) {
          if (!controller.isClosed) controller.add(event);
        }
      },
      onError: (Object error, StackTrace stack) {
        if (!controller.isClosed) controller.addError(error, stack);
      },
      onDone: () {
        for (final event in parser.flushRemainder()) {
          if (!controller.isClosed) controller.add(event);
        }
        if (!controller.isClosed) controller.close();
      },
      cancelOnError: true,
    );

    yield* controller.stream;
  }

  static String _networkMessage(Object error, String command) {
    final text = error.toString();
    if (text.contains('Connection refused') || text.contains('Failed host lookup') || text.contains('Connection failed')) {
      return 'Cannot reach the Ravi gateway while calling $command.';
    }
    return 'Network error calling $command: $text';
  }

  void close() => _http.close();
}
