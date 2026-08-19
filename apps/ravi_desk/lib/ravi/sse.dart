import 'dart:convert';

import 'models.dart';

/// Incremental Server-Sent Events parser for `/api/v1/_stream/*`.
///
/// Matches the `@ravi-os/sdk` streaming contract: `event:` + single-line JSON
/// `data:`, `id:`, and comment keepalives (`: ping`).
class SseParser {
  final StringBuffer _buffer = StringBuffer();
  String _eventName = 'message';
  String? _eventId;
  final List<String> _dataLines = [];

  List<RaviSseEvent> add(String chunk) {
    _buffer.write(chunk.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
    final events = <RaviSseEvent>[];
    var text = _buffer.toString();
    var newline = text.indexOf('\n');
    while (newline != -1) {
      final line = text.substring(0, newline);
      text = text.substring(newline + 1);
      final event = _handleLine(line);
      if (event != null) events.add(event);
      newline = text.indexOf('\n');
    }
    _buffer
      ..clear()
      ..write(text);
    return events;
  }

  List<RaviSseEvent> flushRemainder() {
    final leftover = _buffer.toString();
    _buffer.clear();
    if (leftover.isEmpty) {
      final event = _flushEvent();
      return event == null ? const [] : [event];
    }
    final events = <RaviSseEvent>[];
    for (final line in leftover.split('\n')) {
      final event = _handleLine(line);
      if (event != null) events.add(event);
    }
    final trailing = _flushEvent();
    if (trailing != null) events.add(trailing);
    return events;
  }

  RaviSseEvent? _handleLine(String line) {
    if (line.isEmpty) return _flushEvent();
    if (line.startsWith(':')) return null;
    final colon = line.indexOf(':');
    final field = colon == -1 ? line : line.substring(0, colon);
    var value = colon == -1 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'event':
        _eventName = value.isEmpty ? 'message' : value;
      case 'id':
        _eventId = value;
      case 'data':
        _dataLines.add(value);
    }
    return null;
  }

  RaviSseEvent? _flushEvent() {
    if (_dataLines.isEmpty) {
      _eventName = 'message';
      _eventId = null;
      return null;
    }
    final raw = _dataLines.join('\n');
    Object? data = raw;
    if (raw.isNotEmpty) {
      try {
        data = jsonDecode(raw);
      } catch (_) {
        data = raw;
      }
    }
    final event = RaviSseEvent(
      event: _eventName,
      id: _eventId,
      data: data,
    );
    _eventName = 'message';
    _eventId = null;
    _dataLines.clear();
    return event;
  }
}
