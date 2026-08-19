import 'package:flutter/material.dart';

import '../state/desk_controller.dart';
import '../theme.dart';
import 'settings_dialog.dart';

class DeskSidebar extends StatelessWidget {
  const DeskSidebar({
    super.key,
    required this.controller,
    this.onClose,
  });

  final DeskController controller;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: DeskColors.sidebar,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 12, 8),
            child: Row(
              children: [
                const Expanded(
                  child: Text(
                    'Ravi Desk',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, letterSpacing: -0.3),
                  ),
                ),
                if (onClose != null)
                  IconButton(
                    tooltip: 'Close',
                    onPressed: onClose,
                    icon: const Icon(Icons.close, size: 18),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: TextField(
              onChanged: controller.setSearch,
              decoration: InputDecoration(
                hintText: 'Search agents',
                prefixIcon: const Icon(Icons.search, size: 18, color: DeskColors.textMuted),
                filled: true,
                fillColor: DeskColors.canvas,
                isDense: true,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide.none,
                ),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              ),
            ),
          ),
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(vertical: 4),
              itemCount: controller.visibleConversations.length,
              itemBuilder: (context, index) {
                final item = controller.visibleConversations[index];
                final selected = controller.selectedAgent?.id == item.agent.id;
                return _ConversationTile(
                  preview: item,
                  selected: selected,
                  onTap: () => controller.selectAgent(item.agent),
                );
              },
            ),
          ),
          const _PluginsRow(),
          _ProfileRow(controller: controller),
        ],
      ),
    );
  }
}

class _ConversationTile extends StatelessWidget {
  const _ConversationTile({
    required this.preview,
    required this.selected,
    required this.onTap,
  });

  final ConversationPreview preview;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final agent = preview.agent;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: selected ? DeskColors.selected : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
            child: Row(
              children: [
                _Avatar(initials: agent.initials, selected: selected),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              agent.displayName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontWeight: FontWeight.w600),
                            ),
                          ),
                          if (preview.timeLabel.isNotEmpty)
                            Text(
                              preview.timeLabel,
                              style: const TextStyle(color: DeskColors.textMuted, fontSize: 11),
                            ),
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        preview.snippet,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: DeskColors.textSecondary, fontSize: 12.5),
                      ),
                    ],
                  ),
                ),
                if (preview.hasUnread) ...[
                  const SizedBox(width: 8),
                  const _UnreadDot(),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.initials, this.selected = false, this.size = 38});

  final String initials;
  final bool selected;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: selected ? DeskColors.accentMuted : DeskColors.sidebarElevated,
        shape: BoxShape.circle,
        border: Border.all(color: selected ? DeskColors.accent : DeskColors.border),
      ),
      child: Text(
        initials,
        style: TextStyle(
          fontSize: size * 0.32,
          fontWeight: FontWeight.w700,
          color: selected ? DeskColors.accent : DeskColors.text,
        ),
      ),
    );
  }
}

class _UnreadDot extends StatelessWidget {
  const _UnreadDot();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 8,
      height: 8,
      decoration: const BoxDecoration(color: DeskColors.unread, shape: BoxShape.circle),
    );
  }
}

class _PluginsRow extends StatelessWidget {
  const _PluginsRow();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: DeskColors.border)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Plugins',
            style: TextStyle(color: DeskColors.textMuted, fontSize: 11, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              for (final label in const ['Tasks', 'Events', 'Files'])
                _PluginChip(
                  label: label,
                  onTap: () {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('$label is not in this first slice.')),
                    );
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _PluginChip extends StatelessWidget {
  const _PluginChip({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: DeskColors.sidebarElevated,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: DeskColors.border),
        ),
        child: Text(label, style: const TextStyle(fontSize: 12, color: DeskColors.textSecondary)),
      ),
    );
  }
}

class _ProfileRow extends StatelessWidget {
  const _ProfileRow({required this.controller});

  final DeskController controller;

  @override
  Widget build(BuildContext context) {
    final identity = controller.identity;
    final name = identity?.displayName ?? 'Local runtime';
    final initials = identity?.initials ?? 'RD';
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 12),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: DeskColors.border)),
      ),
      child: Row(
        children: [
          _Avatar(initials: initials, size: 34),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text(
                  identity?.kind.isNotEmpty == true ? identity!.kind : 'Ravi Desk',
                  style: const TextStyle(color: DeskColors.textMuted, fontSize: 11),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Gateway settings',
            onPressed: () async {
              final next = await showGatewaySettingsDialog(context, current: controller.settings);
              if (next != null) {
                await controller.saveAndConnect(next);
              }
            },
            icon: const Icon(Icons.settings_outlined, size: 18, color: DeskColors.textSecondary),
          ),
        ],
      ),
    );
  }
}
