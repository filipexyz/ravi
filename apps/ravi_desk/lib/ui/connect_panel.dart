import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/desk_controller.dart';
import '../theme.dart';
import 'settings_dialog.dart';

class ConnectPanel extends StatelessWidget {
  const ConnectPanel({super.key, required this.controller});

  final DeskController controller;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Container(
          margin: const EdgeInsets.all(24),
          padding: const EdgeInsets.fromLTRB(28, 28, 28, 24),
          decoration: BoxDecoration(
            color: DeskColors.sidebar,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: DeskColors.border),
          ),
          child: SingleChildScrollView(
            child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Connect Ravi Desk',
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              const Text(
                'This Flutter client talks to a running local Ravi daemon over the HTTP gateway. It does not use NATS, Tauri, or an official Dart/Rust SDK.',
                style: TextStyle(color: DeskColors.textSecondary, height: 1.45),
              ),
              const SizedBox(height: 20),
              _CommandBlock(
                title: '1. Start the daemon with the HTTP gateway',
                command: 'RAVI_HTTP_PORT=7777 ravi daemon start',
              ),
              const SizedBox(height: 12),
              const _CommandBlock(
                title: '2. Create a context key',
                command: 'ravi daemon init-admin-key\n# or a narrower app key:\nravi context issue desk --ttl 8h --json',
              ),
              if (controller.errorMessage != null) ...[
                const SizedBox(height: 16),
                Text(
                  controller.errorMessage!,
                  style: const TextStyle(color: DeskColors.danger, height: 1.4),
                ),
              ],
              const SizedBox(height: 20),
              Row(
                children: [
                  FilledButton(
                    onPressed: controller.connecting
                        ? null
                        : () async {
                            final next = await showGatewaySettingsDialog(
                              context,
                              current: controller.settings,
                            );
                            if (next != null) {
                              await controller.saveAndConnect(next);
                            }
                          },
                    child: Text(controller.connecting ? 'Connecting…' : 'Enter context key'),
                  ),
                  const SizedBox(width: 12),
                  TextButton(
                    onPressed: controller.connecting ? null : controller.connect,
                    child: const Text('Retry'),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                'Default gateway: ${controller.settings.baseUrl}',
                style: const TextStyle(color: DeskColors.textMuted, fontSize: 12),
              ),
            ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CommandBlock extends StatelessWidget {
  const _CommandBlock({required this.title, required this.command});

  final String title;
  final String command;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Material(
          color: DeskColors.canvas,
          borderRadius: BorderRadius.circular(10),
          child: InkWell(
            onTap: () async {
              await Clipboard.setData(ClipboardData(text: command));
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Copied command')),
                );
              }
            },
            borderRadius: BorderRadius.circular(10),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              child: Text(
                command,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12.5,
                  height: 1.45,
                  color: DeskColors.text,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
