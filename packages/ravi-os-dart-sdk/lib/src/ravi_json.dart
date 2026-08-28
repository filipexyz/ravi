sealed class RaviJson {
  const RaviJson();

  factory RaviJson.from(Object? value) {
    if (value is RaviJson) return value;
    if (value == null) return const RaviJsonNull();
    if (value is bool) return RaviJsonBool(value);
    if (value is num) return RaviJsonNumber(value);
    if (value is String) return RaviJsonString(value);
    if (value is List) {
      return RaviJsonArray(value.map(RaviJson.from).toList(growable: false));
    }
    if (value is Map) {
      return RaviJsonObject({
        for (final entry in value.entries) entry.key.toString(): RaviJson.from(entry.value),
      });
    }
    throw FormatException('Unsupported JSON value: ${value.runtimeType}');
  }

  Object? toJson();

  static Map<String, Object?> encodeBody(Map<String, RaviJson> body) {
    return {for (final entry in body.entries) entry.key: entry.value.toJson()};
  }
}

final class RaviJsonNull extends RaviJson {
  const RaviJsonNull();

  @override
  Object? toJson() => null;

  @override
  bool operator ==(Object other) => other is RaviJsonNull;

  @override
  int get hashCode => 0;
}

final class RaviJsonBool extends RaviJson {
  const RaviJsonBool(this.value);
  final bool value;

  @override
  Object? toJson() => value;

  @override
  bool operator ==(Object other) => other is RaviJsonBool && other.value == value;

  @override
  int get hashCode => value.hashCode;
}

final class RaviJsonNumber extends RaviJson {
  const RaviJsonNumber(this.value);
  final num value;

  @override
  Object? toJson() => value;

  @override
  bool operator ==(Object other) => other is RaviJsonNumber && other.value == value;

  @override
  int get hashCode => value.hashCode;
}

final class RaviJsonString extends RaviJson {
  const RaviJsonString(this.value);
  final String value;

  @override
  Object? toJson() => value;

  @override
  bool operator ==(Object other) => other is RaviJsonString && other.value == value;

  @override
  int get hashCode => value.hashCode;
}

final class RaviJsonArray extends RaviJson {
  const RaviJsonArray(this.value);
  final List<RaviJson> value;

  @override
  Object? toJson() => value.map((item) => item.toJson()).toList(growable: false);

  @override
  bool operator ==(Object other) => other is RaviJsonArray && _listEquals(other.value, value);

  @override
  int get hashCode => Object.hashAll(value);
}

final class RaviJsonObject extends RaviJson {
  const RaviJsonObject(this.value);
  final Map<String, RaviJson> value;

  @override
  Object? toJson() => {for (final entry in value.entries) entry.key: entry.value.toJson()};

  @override
  bool operator ==(Object other) => other is RaviJsonObject && _mapEquals(other.value, value);

  @override
  int get hashCode => Object.hashAll(value.entries.map((entry) => Object.hash(entry.key, entry.value)));
}

Map<String, Object?> raviJsonObject(Object? json, String typeName) {
  if (json is Map<String, Object?>) return json;
  if (json is Map) {
    return {for (final entry in json.entries) entry.key.toString(): entry.value};
  }
  throw FormatException('Expected a JSON object for $typeName');
}

String raviJsonAsString(Object? value) {
  if (value is String) return value;
  throw FormatException('Expected a JSON string, got ${value.runtimeType}');
}

bool raviJsonAsBool(Object? value) {
  if (value is bool) return value;
  throw FormatException('Expected a JSON boolean, got ${value.runtimeType}');
}

int raviJsonAsInt(Object? value) {
  if (value is int) return value;
  if (value is num && value == value.roundToDouble()) return value.toInt();
  throw FormatException('Expected a JSON integer, got ${value.runtimeType}');
}

double raviJsonAsDouble(Object? value) {
  if (value is double) return value;
  if (value is num) return value.toDouble();
  throw FormatException('Expected a JSON number, got ${value.runtimeType}');
}

List<T> raviJsonAsList<T>(Object? value, T Function(Object? json) decode) {
  if (value is List) return value.map(decode).toList(growable: false);
  throw FormatException('Expected a JSON array, got ${value.runtimeType}');
}

Map<String, RaviJson> raviJsonAsRaviJsonMap(Object? value) {
  return raviJsonAsMap(value, RaviJson.from);
}

Map<String, T> raviJsonAsMap<T>(Object? value, T Function(Object? json) decode) {
  if (value is Map) {
    return {for (final entry in value.entries) entry.key.toString(): decode(entry.value)};
  }
  throw FormatException('Expected a JSON object, got ${value.runtimeType}');
}

bool _listEquals(List<RaviJson> a, List<RaviJson> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

bool _mapEquals(Map<String, RaviJson> a, Map<String, RaviJson> b) {
  if (a.length != b.length) return false;
  for (final entry in a.entries) {
    if (b[entry.key] != entry.value) return false;
  }
  return true;
}
