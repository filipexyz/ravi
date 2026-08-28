import 'package:ravi_sdk/ravi_sdk.dart';

/// HTTP-only client against the local Ravi gateway.
///
/// Start the daemon with `RAVI_HTTP_PORT=7777` and issue a context key before
/// running this example.
Future<void> main() async {
  final client = RaviClient(
    HttpTransport(
      baseUrl: Uri.parse('http://127.0.0.1:7777'),
      contextKey: const String.fromEnvironment(
        'RAVI_CONTEXT_KEY',
        defaultValue: 'rctx_replace_me',
      ),
    ),
  );

  final whoami = await client.context.whoami();
  final history = await client.sessions.read(
    'main',
    const SessionsReadOptions(count: '10'),
  );
  final reply = await client.sessions.send(
    'main',
    'Summarize the current work.',
    const SessionsSendOptions(wait: true),
  );

  print('registry hash: $raviRegistryHash');
  print('whoami: $whoami');
  print('history: $history');
  print('reply: $reply');
}
