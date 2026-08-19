import 'dart:async';

import 'package:flutter/foundation.dart';

import '../config/gateway_settings.dart';
import '../ravi/client.dart';
import '../ravi/errors.dart';
import '../ravi/models.dart';

enum DeskPhase { loading, setup, ready }

class ConversationPreview {
  const ConversationPreview({
    required this.agent,
    this.sessionName,
    this.snippet = '',
    this.timeLabel = '',
    this.hasUnread = false,
  });

  final AgentSummary agent;
  final String? sessionName;
  final String snippet;
  final String timeLabel;
  final bool hasUnread;

  ConversationPreview copyWith({
    String? sessionName,
    String? snippet,
    String? timeLabel,
    bool? hasUnread,
  }) {
    return ConversationPreview(
      agent: agent,
      sessionName: sessionName ?? this.sessionName,
      snippet: snippet ?? this.snippet,
      timeLabel: timeLabel ?? this.timeLabel,
      hasUnread: hasUnread ?? this.hasUnread,
    );
  }
}

class DeskController extends ChangeNotifier {
  DeskController({
    required this.store,
    RaviDeskApi Function(GatewaySettings settings)? clientFactory,
    this.pollInterval = const Duration(seconds: 3),
  }) : _clientFactory = clientFactory ?? ((settings) => RaviHttpClient(settings: settings));

  final SettingsStore store;
  final RaviDeskApi Function(GatewaySettings settings) _clientFactory;
  final Duration? pollInterval;

  DeskPhase phase = DeskPhase.loading;
  GatewaySettings settings = const GatewaySettings(baseUrl: kDefaultGatewayBaseUrl, contextKey: '');
  RaviDeskApi? _client;
  String? errorMessage;
  bool connecting = false;

  List<ConversationPreview> conversations = const [];
  String searchQuery = '';
  AgentSummary? selectedAgent;
  String? selectedSessionName;
  List<SessionMessage> messages = const [];
  bool loadingTranscript = false;
  bool sending = false;
  ContextIdentity? identity;
  bool streamConnected = false;

  AbortSignal? _streamSignal;
  Timer? _pollTimer;

  List<ConversationPreview> get visibleConversations {
    final query = searchQuery.trim().toLowerCase();
    if (query.isEmpty) return conversations;
    return conversations.where((item) {
      return item.agent.displayName.toLowerCase().contains(query) ||
          item.agent.id.toLowerCase().contains(query) ||
          item.snippet.toLowerCase().contains(query);
    }).toList();
  }

  Future<void> start() async {
    settings = await store.load();
    await connect();
  }

  Future<void> saveAndConnect(GatewaySettings next) async {
    settings = next;
    await store.save(next);
    await connect();
  }

  Future<void> connect() async {
    connecting = true;
    errorMessage = null;
    notifyListeners();

    if (!settings.hasContextKey) {
      phase = DeskPhase.setup;
      connecting = false;
      errorMessage = 'Add a runtime context key (rctx_*) to talk to the local daemon.';
      notifyListeners();
      return;
    }

    _client = _clientFactory(settings);
    try {
      identity = await _client!.whoami();
      await refreshAgents();
      phase = DeskPhase.ready;
    } on RaviClientException catch (error) {
      identity = null;
      conversations = const [];
      messages = const [];
      selectedAgent = null;
      if (error.isMissingKey || error.isAuth || error.isNetwork) {
        phase = DeskPhase.setup;
      } else {
        phase = DeskPhase.setup;
      }
      errorMessage = error.message;
    } catch (error) {
      phase = DeskPhase.setup;
      errorMessage = error.toString();
    } finally {
      connecting = false;
      notifyListeners();
    }
  }

  Future<void> refreshAgents() async {
    final client = _client;
    if (client == null) return;
    final listed = await client.listAgents();
    final next = <ConversationPreview>[];
    for (final agent in listed.agents) {
      String? sessionName;
      var snippet = agent.mode == 'sentinel' ? 'Sentinel · observing' : 'No messages yet';
      var timeLabel = '';
      try {
        final status = await client.agentSession(agent.id);
        sessionName = status.resolveMainSessionName(agent.id) ?? agent.id;
        final read = await client.readSession(nameOrKey: sessionName, count: '1');
        if (read.messages.isNotEmpty) {
          final last = read.messages.last;
          snippet = last.preview;
          timeLabel = last.timeLabel;
        }
        sessionName = read.sessionName ?? sessionName;
      } catch (_) {
        sessionName ??= agent.id;
      }
      next.add(
        ConversationPreview(
          agent: agent,
          sessionName: sessionName,
          snippet: snippet,
          timeLabel: timeLabel,
        ),
      );
    }
    conversations = next;
    if (selectedAgent == null && next.isNotEmpty) {
      await selectAgent(next.first.agent);
    } else if (selectedAgent != null) {
      final still = next.where((item) => item.agent.id == selectedAgent!.id);
      if (still.isNotEmpty) {
        await selectAgent(still.first.agent, force: true);
      }
    }
    notifyListeners();
  }

  void setSearch(String value) {
    searchQuery = value;
    notifyListeners();
  }

  Future<void> selectAgent(AgentSummary agent, {bool force = false}) async {
    if (!force && selectedAgent?.id == agent.id) {
      notifyListeners();
      return;
    }
    selectedAgent = agent;
    loadingTranscript = true;
    notifyListeners();

    final preview = conversations.cast<ConversationPreview?>().firstWhere(
      (item) => item?.agent.id == agent.id,
      orElse: () => null,
    );
    final sessionName = preview?.sessionName ?? agent.id;
    selectedSessionName = sessionName;
    await _loadTranscript(sessionName);
    _listenToSession(sessionName);
    conversations = [
      for (final item in conversations)
        if (item.agent.id == agent.id) item.copyWith(hasUnread: false) else item,
    ];
    loadingTranscript = false;
    notifyListeners();
  }

  Future<void> _loadTranscript(String sessionName) async {
    final client = _client;
    if (client == null) return;
    try {
      final read = await client.readSession(nameOrKey: sessionName, count: '80');
      messages = read.messages;
      selectedSessionName = read.sessionName ?? sessionName;
    } on RaviClientException catch (error) {
      errorMessage = error.message;
      messages = const [];
    }
  }

  void _listenToSession(String sessionName) {
    _streamSignal?.abort();
    _pollTimer?.cancel();
    streamConnected = false;
    final client = _client;
    if (client == null) return;
    final signal = AbortSignal();
    _streamSignal = signal;
    client.streamSession(sessionName, signal: signal).listen(
      (event) {
        if (event.isEnd) return;
        streamConnected = true;
        notifyListeners();
        unawaited(_refreshSelected());
      },
      onError: (_) {
        streamConnected = false;
        notifyListeners();
        _startPollFallback();
      },
      onDone: () {
        streamConnected = false;
        notifyListeners();
      },
      cancelOnError: true,
    );
    _startPollFallback();
  }

  void _startPollFallback() {
    _pollTimer?.cancel();
    final interval = pollInterval;
    if (interval == null || interval == Duration.zero) return;
    _pollTimer = Timer.periodic(interval, (_) {
      unawaited(_refreshSelected());
    });
  }

  Future<void> _refreshSelected() async {
    final sessionName = selectedSessionName;
    if (sessionName == null || _client == null) return;
    try {
      final read = await _client!.readSession(nameOrKey: sessionName, count: '80');
      final next = read.messages;
      if (!_sameMessages(messages, next)) {
        messages = next;
        _updatePreviewFromMessages(selectedAgent?.id, next);
        notifyListeners();
      }
    } catch (_) {
      // Keep the last good transcript if a refresh fails mid-stream.
    }
  }

  Future<void> send(String text) async {
    final trimmed = text.trim();
    final client = _client;
    final agent = selectedAgent;
    if (trimmed.isEmpty || client == null || agent == null) return;
    final sessionName = selectedSessionName ?? agent.id;
    sending = true;
    messages = [
      ...messages,
      SessionMessage(role: 'user', text: trimmed, time: _nowClock()),
    ];
    _updatePreviewFromMessages(agent.id, messages);
    notifyListeners();

    try {
      final result = await client.sendSession(nameOrKey: sessionName, prompt: trimmed);
      selectedSessionName = result.sessionName ?? sessionName;
      if (result.responseText != null && result.responseText!.isNotEmpty) {
        messages = [
          ...messages,
          SessionMessage(role: 'assistant', text: result.responseText!, time: _nowClock()),
        ];
        _updatePreviewFromMessages(agent.id, messages);
      }
      errorMessage = null;
    } on RaviClientException catch (error) {
      errorMessage = error.message;
    } finally {
      sending = false;
      notifyListeners();
      unawaited(_refreshSelected());
    }
  }

  void _updatePreviewFromMessages(String? agentId, List<SessionMessage> next) {
    if (agentId == null || next.isEmpty) return;
    final last = next.last;
    conversations = [
      for (final item in conversations)
        if (item.agent.id == agentId)
          item.copyWith(snippet: last.preview, timeLabel: last.timeLabel)
        else
          item,
    ];
  }

  static bool _sameMessages(List<SessionMessage> a, List<SessionMessage> b) {
    if (a.length != b.length) return false;
    if (a.isEmpty) return true;
    return a.last.text == b.last.text && a.last.role == b.last.role && a.first.text == b.first.text;
  }

  static String _nowClock() {
    final now = DateTime.now();
    final hh = now.hour.toString().padLeft(2, '0');
    final mm = now.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }

  @override
  void dispose() {
    _streamSignal?.abort();
    _pollTimer?.cancel();
    final client = _client;
    if (client is RaviHttpClient) client.close();
    super.dispose();
  }
}
