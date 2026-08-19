import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.enabled,
    required this.sending,
    required this.onSend,
  });

  final bool enabled;
  final bool sending;
  final Future<void> Function(String text) onSend;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focus = FocusNode();

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!widget.enabled || widget.sending) return;
    final text = _controller.text;
    if (text.trim().isEmpty) return;
    _controller.clear();
    await widget.onSend(text);
    _focus.requestFocus();
  }

  void _notYet(String feature) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$feature is not in this first slice.')),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Shortcuts(
      shortcuts: {
        LogicalKeySet(LogicalKeyboardKey.enter): _SubmitIntent(),
        LogicalKeySet(LogicalKeyboardKey.shift, LogicalKeyboardKey.enter): _NewlineIntent(),
      },
      child: Actions(
        actions: {
          _SubmitIntent: CallbackAction<_SubmitIntent>(onInvoke: (_) {
            _submit();
            return null;
          }),
          _NewlineIntent: CallbackAction<_NewlineIntent>(onInvoke: (_) {
            final value = _controller.value;
            final text = '${value.text}\n';
            _controller.value = value.copyWith(
              text: text,
              selection: TextSelection.collapsed(offset: value.selection.baseOffset + 1),
            );
            return null;
          }),
        },
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 14),
          decoration: const BoxDecoration(
            color: DeskColors.sidebar,
            border: Border(top: BorderSide(color: DeskColors.border)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              IconButton(
                tooltip: 'Attach',
                onPressed: widget.enabled ? () => _notYet('Attachments') : null,
                icon: const Icon(Icons.attach_file, color: DeskColors.textSecondary),
              ),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  decoration: BoxDecoration(
                    color: DeskColors.composer,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: DeskColors.border),
                  ),
                  child: TextField(
                    controller: _controller,
                    focusNode: _focus,
                    enabled: widget.enabled,
                    minLines: 1,
                    maxLines: 6,
                    decoration: const InputDecoration(
                      hintText: 'Message the selected agent…',
                      border: InputBorder.none,
                    ),
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Voice',
                onPressed: widget.enabled ? () => _notYet('Microphone') : null,
                icon: const Icon(Icons.mic_none, color: DeskColors.textSecondary),
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: FilledButton(
                  onPressed: widget.enabled && !widget.sending ? _submit : null,
                  style: FilledButton.styleFrom(
                    backgroundColor: DeskColors.accent,
                    foregroundColor: const Color(0xFF062113),
                    minimumSize: const Size(44, 40),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: widget.sending
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF062113)),
                        )
                      : const Icon(Icons.send_rounded, size: 18),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SubmitIntent extends Intent {}

class _NewlineIntent extends Intent {}
