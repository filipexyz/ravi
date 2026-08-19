import 'package:flutter/material.dart';

import '../state/desk_controller.dart';
import '../theme.dart';
import 'chat_pane.dart';
import 'connect_panel.dart';
import 'sidebar.dart';

class DeskShell extends StatelessWidget {
  const DeskShell({super.key, required this.controller});

  final DeskController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        if (controller.phase == DeskPhase.loading) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator(color: DeskColors.accent)),
          );
        }
        if (controller.phase == DeskPhase.setup) {
          return Scaffold(body: ConnectPanel(controller: controller));
        }
        return Scaffold(
          body: LayoutBuilder(
            builder: (context, constraints) {
              final wide = constraints.maxWidth >= 860;
              if (wide) {
                return Row(
                  children: [
                    SizedBox(width: 320, child: DeskSidebar(controller: controller)),
                    const VerticalDivider(width: 1, color: DeskColors.border),
                    Expanded(child: ChatPane(controller: controller)),
                  ],
                );
              }
              return _NarrowDesk(controller: controller);
            },
          ),
        );
      },
    );
  }
}

class _NarrowDesk extends StatefulWidget {
  const _NarrowDesk({required this.controller});

  final DeskController controller;

  @override
  State<_NarrowDesk> createState() => _NarrowDeskState();
}

class _NarrowDeskState extends State<_NarrowDesk> {
  bool _showChat = false;

  @override
  Widget build(BuildContext context) {
    if (_showChat && widget.controller.selectedAgent != null) {
      return ChatPane(
        controller: widget.controller,
        onOpenSidebar: () => setState(() => _showChat = false),
      );
    }
    return DeskSidebar(
      controller: widget.controller,
      onClose: null,
    );
  }

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChange);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChange);
    super.dispose();
  }

  void _onChange() {
    if (widget.controller.selectedAgent != null && !_showChat) {
      setState(() => _showChat = true);
    }
  }
}
