import 'package:flutter_test/flutter_test.dart';
import 'package:ravi_desk/ravi/models.dart';

void main() {
  test('parses agents.list payload', () {
    final result = AgentsListResult.fromJson({
      'defaultAgent': 'main',
      'agents': [
        {
          'id': 'main',
          'cwd': '/home/luis/ravi/main',
          'isDefault': true,
          'effectiveProvider': 'claude',
          'effectiveModel': 'sonnet',
          'mode': 'active',
          'name': 'Main',
        },
      ],
    });
    expect(result.defaultAgent, 'main');
    expect(result.agents.single.id, 'main');
    expect(result.agents.single.displayName, 'Main');
    expect(result.agents.single.initials, 'MA');
  });

  test('parses both sessions.read message shapes', () {
    final result = SessionReadResult.fromJson({
      'session': {
        'sessionKey': 'agent:main:main',
        'label': 'main',
        'agentId': 'main',
        'name': 'main',
      },
      'transcript': {'available': true},
      'messages': [
        {'role': 'user', 'text': 'Hello', 'time': '14:30'},
        {
          'id': 'm2',
          'role': 'assistant',
          'content': 'Hi there',
          'createdAt': 1706619000000,
          'source': 'runtime',
        },
      ],
    });
    expect(result.messages, hasLength(2));
    expect(result.messages.first.text, 'Hello');
    expect(result.messages.first.timeLabel, '14:30');
    expect(result.messages.last.text, 'Hi there');
    expect(result.messages.last.isAssistant, isTrue);
  });

  test('resolves the main session from agents.session', () {
    final result = AgentsSessionResult.fromJson({
      'agent': {'id': 'jarvis'},
      'total': 2,
      'sessions': [
        {'name': 'jarvis-cron', 'sessionKey': 'agent:jarvis:cron:1'},
        {'name': 'jarvis', 'sessionKey': 'agent:jarvis:main'},
      ],
    });
    expect(result.resolveMainSessionName('jarvis'), 'jarvis');
  });
}
