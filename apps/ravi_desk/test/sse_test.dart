import 'package:flutter_test/flutter_test.dart';
import 'package:ravi_desk/ravi/sse.dart';

void main() {
  test('parses framed SSE events and ignores keepalives', () {
    final parser = SseParser();
    final events = parser.add(
      ': ping\n'
      '\n'
      'id: 1\n'
      'event: session.event\n'
      'data: {"type":"session.event","sessionName":"main"}\n'
      '\n'
      'event: end\n'
      'data: {"type":"stream.end"}\n'
      '\n',
    );
    expect(events, hasLength(2));
    expect(events.first.event, 'session.event');
    expect(events.first.id, '1');
    expect((events.first.data as Map)['sessionName'], 'main');
    expect(events.last.isEnd, isTrue);
  });
}
