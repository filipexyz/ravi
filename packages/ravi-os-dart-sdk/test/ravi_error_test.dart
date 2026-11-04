import 'dart:convert';

import 'package:ravi_sdk/ravi_sdk.dart';
import 'package:test/test.dart';

void main() {
  test('rejects_malformed_contract_identifiers_without_discarding_cause', () {
    for (final fields in [
      ['rctx_sdk_code_secret798', 'rctx_sdk_op_secret798'],
      [
        'AUTH_REQUIRED?token=SDK_CODE_QUERY_798',
        'audio generate?key=SDK_OP_QUERY_798',
      ],
      ['A' * 97, 'a' * 161],
    ]) {
      final error = buildRaviError(
        statusCode: 422,
        body: jsonEncode({
          'success': false,
          'op': fields[1],
          'exitCode': 1,
          'outcome': 'failed',
          'error': {
            'code': fields[0],
            'message': 'Provider refused request',
            'cause': 'provider rejected the request',
            'retryable': false,
          },
        }),
      ) as RaviContractError;
      expect(error.code, 'REMOTE_ERROR');
      expect(error.op, 'gateway');
      expect(error.cause, 'provider rejected the request');
      expect(jsonEncode(error.body), isNot(contains(fields[0])));
      expect(jsonEncode(error.body), isNot(contains(fields[1])));
    }
    final error = buildRaviError(
      statusCode: 422,
      body: jsonEncode({
        'success': false,
        'op': 'apps showManifest',
        'exitCode': 1,
        'outcome': 'failed',
        'error': {
          'code': 'not_found',
          'message': 'App missing',
          'retryable': false,
        },
      }),
    ) as RaviContractError;
    expect(error.code, 'not_found');
    expect(error.op, 'apps showManifest');
  });

  test('preserves_specific_cause_and_typed_context', () {
    const cause =
        'Cannot read audio\nCaused by: EACCES: permission denied, open /tmp/audio.wav; token=[redacted:token]';
    const sentinel = 'PRIVATE_DIAGNOSTIC_PAYLOAD';
    final error = buildRaviError(
      statusCode: 422,
      body: jsonEncode({
        'success': false,
        'op': 'transcribe file',
        'exitCode': 1,
        'outcome': 'failed',
        'error': {
          'code': 'TRANSCRIPTION_FAILED',
          'message': 'Cannot read audio',
          'retryable': false,
          'cause': cause,
          'body': sentinel,
          'headers': {'cookie': sentinel},
          'stack': sentinel,
          'context': {
            'status': 403,
            'provider': 'openai',
            'model': 'whisper-1',
            'operation': 'transcribe file',
            'code': 'EACCES',
            'syscall': 'open',
            'file': '/tmp/audio.wav',
            'actor': {
              'type': 'agent',
              'id': 'main',
              'profile': sentinel,
              'credential': sentinel,
            },
            'headers': sentinel,
            'cookies': sentinel,
            'query': sentinel,
            'body': sentinel,
            'stack': sentinel,
          },
        },
      }),
    ) as RaviContractError;
    expect(error.code, 'TRANSCRIPTION_FAILED');
    expect(error.cause, cause);
    expect(error.contractBody!.error.cause, cause);
    expect(error.context!.toJson(), {
      'status': 403,
      'provider': 'openai',
      'model': 'whisper-1',
      'operation': 'transcribe file',
      'code': 'EACCES',
      'syscall': 'open',
      'file': '/tmp/audio.wav',
      'actor': {'type': 'agent', 'id': 'main'},
    });
    expect((error.body!['error'] as Map)['cause'], cause);
    expect(jsonEncode(error.body), isNot(contains(sentinel)));
  });

  test('rejects_invalid_diagnostic_fields_without_discarding_cause', () {
    for (final status in [99, 600, 401.5, '401']) {
      final error = buildRaviError(
        statusCode: 422,
        body: jsonEncode({
          'success': false,
          'op': 'transcribe file',
          'exitCode': 1,
          'outcome': 'failed',
          'error': {
            'code': 'TRANSCRIPTION_FAILED',
            'message': 'quota exceeded',
            'retryable': false,
            'cause': 'quota exceeded',
            'context': {
              'status': status,
              'provider': 'https://host?key=private',
              'actor': {'type': 'agent', 'id': 'rctx_privatecredential'},
            },
          },
        }),
      ) as RaviContractError;
      expect(error.cause, 'quota exceeded');
      expect(error.context!.toJson(), isEmpty);
    }
  });

  test('maps 401 to auth errors', () {
    final error = buildRaviError(
      statusCode: 401,
      body:
          '{"error":"unauthorized","message":"missing key","reason":"missing"}',
    );
    expect(error, isA<RaviAuthError>());
    expect((error as RaviAuthError).reason, 'missing');
  });

  test('maps contract envelopes', () {
    final error = buildRaviError(
      statusCode: 400,
      body: '{"success":false,"op":"sessions.send","error":{"code":"USAGE_ERROR","message":"bad","retryable":false},"exitCode":2,"outcome":"usage_error"}',
    );
    expect(error, isA<RaviContractError>());
    expect((error as RaviContractError).code, 'USAGE_ERROR');
  });

  test('return-shape errors are contract failures', () {
    final error = RaviContractError.returnShape(
      'Expected a JSON object for SessionsSendReturn',
    );
    expect(error.code, 'RETURN_SHAPE');
    expect(error.outcome, RaviContractOutcome.failed);
  });
}
