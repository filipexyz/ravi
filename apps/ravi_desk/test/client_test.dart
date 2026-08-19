import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ravi_desk/config/gateway_settings.dart';
import 'package:ravi_desk/ravi/client.dart';
import 'package:ravi_desk/ravi/errors.dart';

void main() {
  test('posts agents.list with bearer auth and a flat JSON body', () async {
    late http.Request seen;
    final client = RaviHttpClient(
      settings: const GatewaySettings(
        baseUrl: 'http://127.0.0.1:7777',
        contextKey: 'rctx_test',
      ),
      httpClient: MockClient((request) async {
        seen = request;
        return http.Response(
          jsonEncode({
            'defaultAgent': 'main',
            'agents': [
              {
                'id': 'main',
                'cwd': '/tmp',
                'isDefault': true,
                'effectiveProvider': 'claude',
                'effectiveModel': 'sonnet',
              },
            ],
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final result = await client.listAgents();
    expect(result.agents.single.id, 'main');
    expect(seen.url.toString(), 'http://127.0.0.1:7777/api/v1/agents/list');
    expect(seen.method, 'POST');
    expect(seen.headers['authorization'], 'Bearer rctx_test');
    expect(seen.headers['x-ravi-sdk-version'], kDeskSdkVersion);
    expect(jsonDecode(seen.body), {'limit': '50'});
  });

  test('sessions.send uses nameOrKey + prompt', () async {
    late http.Request seen;
    final client = RaviHttpClient(
      settings: const GatewaySettings(
        baseUrl: 'http://127.0.0.1:7777/',
        contextKey: 'rctx_test',
      ),
      httpClient: MockClient((request) async {
        seen = request;
        return http.Response(
          jsonEncode({
            'action': 'send',
            'mode': 'fire-and-forget',
            'published': true,
            'createdSession': false,
            'promptLength': 5,
            'delivery': {},
            'thread': null,
            'session': {
              'sessionKey': 'agent:main:main',
              'label': 'main',
              'agentId': 'main',
              'name': 'main',
            },
          }),
          200,
        );
      }),
    );

    final result = await client.sendSession(nameOrKey: 'main', prompt: 'hello');
    expect(result.published, isTrue);
    expect(seen.url.path, '/api/v1/sessions/send');
    expect(jsonDecode(seen.body), {
      'nameOrKey': 'main',
      'prompt': 'hello',
      'wait': false,
    });
  });

  test('refuses to call the gateway without a context key', () async {
    final client = RaviHttpClient(
      settings: const GatewaySettings(baseUrl: kDefaultGatewayBaseUrl, contextKey: ''),
      httpClient: MockClient((request) async => http.Response('nope', 500)),
    );
    expect(
      () => client.listAgents(),
      throwsA(isA<RaviClientException>().having((e) => e.isMissingKey, 'missing key', isTrue)),
    );
  });
}
