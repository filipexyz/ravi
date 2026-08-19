import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ravi_desk/config/gateway_settings.dart';
import 'package:ravi_desk/main.dart';
import 'package:ravi_desk/ravi/client.dart';
import 'package:ravi_desk/ravi/models.dart';
import 'package:ravi_desk/state/desk_controller.dart';

class FakeRaviClient implements RaviDeskApi {
  FakeRaviClient({this.agents = const []});

  final List<AgentSummary> agents;
  final sent = <Map<String, String>>[];

  @override
  Future<AgentsSessionResult> agentSession(String id) async {
    return AgentsSessionResult(
      total: 1,
      sessions: [AgentSessionInfo(name: id, sessionKey: 'agent:$id:main', agentId: id)],
    );
  }

  @override
  Future<AgentsListResult> listAgents({String limit = '50'}) async {
    return AgentsListResult(agents: agents, defaultAgent: agents.isEmpty ? '' : agents.first.id);
  }

  @override
  Future<SessionReadResult> readSession({String? nameOrKey, String count = '50'}) async {
    return SessionReadResult(
      sessionName: nameOrKey,
      sessionKey: 'agent:${nameOrKey ?? 'main'}:main',
      agentId: nameOrKey,
      messages: const [
        SessionMessage(role: 'user', text: 'Status?', time: '10:00'),
        SessionMessage(role: 'assistant', text: 'All good.', time: '10:01'),
      ],
    );
  }

  @override
  Future<SessionSendResult> sendSession({
    required String nameOrKey,
    required String prompt,
    bool wait = false,
  }) async {
    sent.add({'nameOrKey': nameOrKey, 'prompt': prompt});
    return SessionSendResult(
      published: true,
      mode: 'fire-and-forget',
      sessionName: nameOrKey,
      sessionKey: 'agent:$nameOrKey:main',
      agentId: nameOrKey,
    );
  }

  @override
  Stream<RaviSseEvent> streamSession(String name, {AbortSignal? signal}) {
    return const Stream.empty();
  }

  @override
  Future<ContextIdentity> whoami() async {
    return const ContextIdentity(contextId: 'rctx_test', kind: 'admin', issuedFor: 'Luis');
  }
}

void main() {
  testWidgets('shows connect setup when the context key is missing', (tester) async {
    final controller = DeskController(
      store: MemorySettingsStore(
        const GatewaySettings(baseUrl: kDefaultGatewayBaseUrl, contextKey: ''),
      ),
      pollInterval: null,
    );
    addTearDown(controller.dispose);
    await controller.start();
    await tester.pumpWidget(RaviDeskApp(controller: controller));
    expect(find.text('Connect Ravi Desk'), findsOneWidget);
    expect(find.textContaining('RAVI_HTTP_PORT=7777'), findsOneWidget);
  });

  testWidgets('lists a real agent and sends through sessions.send', (tester) async {
    final api = FakeRaviClient(
      agents: const [
        AgentSummary(
          id: 'main',
          cwd: '/tmp',
          isDefault: true,
          effectiveProvider: 'claude',
          name: 'Main',
          mode: 'active',
          effectiveModel: 'sonnet',
        ),
      ],
    );
    final controller = DeskController(
      store: MemorySettingsStore(
        const GatewaySettings(baseUrl: kDefaultGatewayBaseUrl, contextKey: 'rctx_test'),
      ),
      clientFactory: (_) => api,
      pollInterval: null,
    );
    addTearDown(controller.dispose);
    await controller.start();
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(RaviDeskApp(controller: controller));
    await tester.pumpAndSettle();
    expect(find.text('Main'), findsWidgets);
    expect(find.text('All good.'), findsWidgets);
    await tester.enterText(find.byType(TextField).last, 'hello from desk');
    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pumpAndSettle();
    expect(api.sent.single['prompt'], 'hello from desk');
    expect(api.sent.single['nameOrKey'], 'main');
  });
}
