import 'package:flutter/material.dart';

import '../config/gateway_settings.dart';
import '../theme.dart';

Future<GatewaySettings?> showGatewaySettingsDialog(
  BuildContext context, {
  required GatewaySettings current,
}) {
  return showDialog<GatewaySettings>(
    context: context,
    builder: (context) => _SettingsDialog(current: current),
  );
}

class _SettingsDialog extends StatefulWidget {
  const _SettingsDialog({required this.current});

  final GatewaySettings current;

  @override
  State<_SettingsDialog> createState() => _SettingsDialogState();
}

class _SettingsDialogState extends State<_SettingsDialog> {
  late final TextEditingController _baseUrl;
  late final TextEditingController _contextKey;

  @override
  void initState() {
    super.initState();
    _baseUrl = TextEditingController(text: widget.current.baseUrl);
    _contextKey = TextEditingController(text: widget.current.contextKey);
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _contextKey.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: DeskColors.sidebar,
      title: const Text('Connect to Ravi'),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Talks to the local HTTP gateway. No official Dart or Rust SDK — this client only covers agents.list, agents.session, sessions.read, sessions.send, context.whoami, and SSE.',
              style: TextStyle(color: DeskColors.textSecondary, height: 1.4),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _baseUrl,
              decoration: const InputDecoration(
                labelText: 'Gateway base URL',
                hintText: kDefaultGatewayBaseUrl,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _contextKey,
              obscureText: true,
              decoration: const InputDecoration(
                labelText: 'Context key (rctx_*)',
                hintText: 'Paste a key from ravi daemon init-admin-key',
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            Navigator.of(context).pop(
              GatewaySettings(
                baseUrl: _baseUrl.text.trim().isEmpty ? kDefaultGatewayBaseUrl : _baseUrl.text.trim(),
                contextKey: _contextKey.text.trim(),
              ),
            );
          },
          child: const Text('Save and connect'),
        ),
      ],
    );
  }
}
