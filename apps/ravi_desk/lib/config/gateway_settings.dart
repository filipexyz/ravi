import 'package:shared_preferences/shared_preferences.dart';

import 'process_env_stub.dart' if (dart.library.io) 'process_env_io.dart';

const kDefaultGatewayBaseUrl = 'http://127.0.0.1:7777';
const kDeskSdkVersion = 'ravi-desk/0.1.0';

class GatewaySettings {
  const GatewaySettings({
    required this.baseUrl,
    required this.contextKey,
  });

  final String baseUrl;
  final String contextKey;

  bool get hasContextKey => contextKey.trim().isNotEmpty;

  Uri get origin {
    final trimmed = baseUrl.trim().isEmpty ? kDefaultGatewayBaseUrl : baseUrl.trim();
    return Uri.parse(trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed);
  }

  GatewaySettings copyWith({String? baseUrl, String? contextKey}) {
    return GatewaySettings(
      baseUrl: baseUrl ?? this.baseUrl,
      contextKey: contextKey ?? this.contextKey,
    );
  }

  factory GatewaySettings.fromEnvironment() {
    final env = readProcessEnv();
    const definedBase = String.fromEnvironment('RAVI_BASE_URL');
    const definedKey = String.fromEnvironment('RAVI_CONTEXT_KEY');
    const definedPort = String.fromEnvironment('RAVI_HTTP_PORT');

    final port = env['RAVI_HTTP_PORT'] ?? (definedPort.isEmpty ? null : definedPort);
    final envBase = env['RAVI_BASE_URL'];
    final baseUrl = (envBase != null && envBase.isNotEmpty)
        ? envBase
        : (definedBase.isNotEmpty
            ? definedBase
            : (port != null && port.isNotEmpty
                ? 'http://127.0.0.1:$port'
                : kDefaultGatewayBaseUrl));

    final envKey = env['RAVI_CONTEXT_KEY'];
    final contextKey = (envKey != null && envKey.isNotEmpty) ? envKey : definedKey;

    return GatewaySettings(baseUrl: baseUrl, contextKey: contextKey);
  }
}

abstract class SettingsStore {
  Future<GatewaySettings> load();
  Future<void> save(GatewaySettings settings);
}

class MemorySettingsStore implements SettingsStore {
  MemorySettingsStore([GatewaySettings? initial]) : _settings = initial ?? GatewaySettings.fromEnvironment();

  GatewaySettings _settings;

  @override
  Future<GatewaySettings> load() async => _settings;

  @override
  Future<void> save(GatewaySettings settings) async {
    _settings = settings;
  }
}

class PrefsSettingsStore implements SettingsStore {
  PrefsSettingsStore({this._prefs});

  SharedPreferences? _prefs;

  static const _baseUrlKey = 'ravi.baseUrl';
  static const _contextKeyKey = 'ravi.contextKey';

  @override
  Future<GatewaySettings> load() async {
    final defaults = GatewaySettings.fromEnvironment();
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    _prefs = prefs;
    return GatewaySettings(
      baseUrl: prefs.getString(_baseUrlKey) ?? defaults.baseUrl,
      contextKey: prefs.getString(_contextKeyKey) ?? defaults.contextKey,
    );
  }

  @override
  Future<void> save(GatewaySettings settings) async {
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    _prefs = prefs;
    await prefs.setString(_baseUrlKey, settings.baseUrl);
    await prefs.setString(_contextKeyKey, settings.contextKey);
  }
}
