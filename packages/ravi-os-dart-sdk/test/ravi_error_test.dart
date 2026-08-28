import 'package:ravi_os_sdk/ravi_os_sdk.dart';
import 'package:test/test.dart';

void main() {
  test('maps 401 to auth errors', () {
    final error = buildRaviError(
      statusCode: 401,
      body: '{"error":"unauthorized","message":"missing key","reason":"missing"}',
    );
    expect(error, isA<RaviAuthError>());
    expect((error as RaviAuthError).reason, 'missing');
  });

  test('maps contract envelopes', () {
    final error = buildRaviError(
      statusCode: 400,
      body:
          '{"success":false,"op":"sessions.send","error":{"code":"USAGE_ERROR","message":"bad","retryable":false},"exitCode":2,"outcome":"usage_error"}',
    );
    expect(error, isA<RaviContractError>());
    expect((error as RaviContractError).code, 'USAGE_ERROR');
  });

  test('return-shape errors are contract failures', () {
    final error = RaviContractError.returnShape('Expected a JSON object for SessionsSendReturn');
    expect(error.code, 'RETURN_SHAPE');
    expect(error.outcome, RaviContractOutcome.failed);
  });
}
