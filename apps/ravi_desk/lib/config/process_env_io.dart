import 'dart:io';

Map<String, String> readProcessEnv() {
  try {
    return Platform.environment;
  } catch (_) {
    return const {};
  }
}
