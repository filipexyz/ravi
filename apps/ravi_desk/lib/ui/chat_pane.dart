import 'package:flutter/material.dart';

import '../ravi/models.dart';
import '../state/desk_controller.dart';
import '../theme.dart';
import 'composer.dart';

class ChatPane extends StatelessWidget {
  const ChatPane({super.key, required this.controller, this.onOpenSidebar});

  final DeskController controller;
  final VoidCallback? onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    final agent = controller.selectedAgent;
    if (agent == null) {
      return const Center(
        child: Text('Select an agent', style: TextStyle(color: DeskColors.textSecondary)),
      );
    }
    return Column(
      children: [
        _ChatHeader(
          agent: agent,
          sessionName: controller.selectedSessionName,
          live: controller.streamConnected,
          onOpenSidebar: onOpenSidebar,
        ),
        Expanded(
          child: controller.loadingTranscript
              ? const Center(child: CircularProgressIndicator(color: DeskColors.accent))
              : _Transcript(messages: controller.messages),
        ),
        if (controller.errorMessage != null && controller.phase.name == 'ready')
          Material(
            color: const Color(0x33E35D6A),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(
                children: [
                  const Icon(Icons.error_outline, size: 16, color: DeskColors.danger),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      controller.errorMessage!,
                      style: const TextStyle(color: DeskColors.danger, fontSize: 12.5),
                    ),
                  ),
                ],
              ),
            ),
          ),
        Composer(
          enabled: true,
          sending: controller.sending,
          onSend: controller.send,
        ),
      ],
    );
  }
}

class _ChatHeader extends StatelessWidget {
  const _ChatHeader({
    required this.agent,
    required this.sessionName,
    required this.live,
    this.onOpenSidebar,
  });

  final AgentSummary agent;
  final String? sessionName;
  final bool live;
  final VoidCallback? onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 64,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: const BoxDecoration(
        color: DeskColors.sidebar,
        border: Border(bottom: BorderSide(color: DeskColors.border)),
      ),
      child: Row(
        children: [
          if (onOpenSidebar != null)
            IconButton(
              tooltip: 'Conversations',
              onPressed: onOpenSidebar,
              icon: const Icon(Icons.menu),
            ),
          Container(
            width: 36,
            height: 36,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: DeskColors.sidebarElevated,
              shape: BoxShape.circle,
              border: Border.all(color: DeskColors.accent.withValues(alpha: 0.5)),
            ),
            child: Text(agent.initials, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(agent.displayName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                Text(
                  [
                    if (agent.effectiveModel?.isNotEmpty == true) agent.effectiveModel!,
                    ?sessionName,
                    ?agent.mode,
                  ].join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: DeskColors.textMuted, fontSize: 12),
                ),
              ],
            ),
          ),
          Container(
            width: 8,
            height: 8,
            margin: const EdgeInsets.only(right: 6),
            decoration: BoxDecoration(
              color: live ? DeskColors.accent : DeskColors.textMuted,
              shape: BoxShape.circle,
            ),
          ),
          Text(
            live ? 'Live' : 'Polling',
            style: const TextStyle(color: DeskColors.textMuted, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _Transcript extends StatelessWidget {
  const _Transcript({required this.messages});

  final List<SessionMessage> messages;

  @override
  Widget build(BuildContext context) {
    if (messages.isEmpty) {
      return const Center(
        child: Text(
          'No messages in this session yet.\nSend a prompt to the local daemon.',
          textAlign: TextAlign.center,
          style: TextStyle(color: DeskColors.textSecondary, height: 1.45),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
      itemCount: messages.length,
      itemBuilder: (context, index) {
        return _Bubble(message: messages[index]);
      },
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message});

  final SessionMessage message;

  @override
  Widget build(BuildContext context) {
    final mine = message.isUser;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
          decoration: BoxDecoration(
            color: mine ? DeskColors.userBubble : DeskColors.assistantBubble,
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(14),
              topRight: const Radius.circular(14),
              bottomLeft: Radius.circular(mine ? 14 : 4),
              bottomRight: Radius.circular(mine ? 4 : 14),
            ),
            border: Border.all(color: DeskColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                mine ? 'You' : 'Agent',
                style: const TextStyle(color: DeskColors.textMuted, fontSize: 11, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 4),
              SelectableText(message.text, style: const TextStyle(height: 1.4)),
              if (message.timeLabel.isNotEmpty) ...[
                const SizedBox(height: 6),
                Align(
                  alignment: Alignment.centerRight,
                  child: Text(
                    message.timeLabel,
                    style: const TextStyle(color: DeskColors.textMuted, fontSize: 11),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
