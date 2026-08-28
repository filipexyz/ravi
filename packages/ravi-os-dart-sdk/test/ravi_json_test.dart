import 'package:ravi_sdk/ravi_sdk.dart';
import 'package:test/test.dart';

void main() {
  test('round-trips arbitrary JSON', () {
    final json = RaviJson.from({
      'ok': true,
      'count': 2,
      'name': 'ravi',
      'nested': ['a', null],
    });
    expect(json.toJson(), {
      'ok': true,
      'count': 2,
      'name': 'ravi',
      'nested': ['a', null],
    });
  });

  test('encodes a flat request body', () {
    expect(RaviJson.encodeBody({'id': RaviJson.from('art_1'), 'live': RaviJson.from(true)}), {
      'id': 'art_1',
      'live': true,
    });
  });
}
