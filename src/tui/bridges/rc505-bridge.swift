import Foundation
import CoreMIDI

struct SourceDescriptor {
  let index: Int
  let endpoint: MIDIEndpointRef
  let displayName: String?
  let name: String?
  let manufacturer: String?
  let model: String?

  var resolvedName: String {
    displayName ?? name ?? model ?? manufacturer ?? "unknown-source"
  }

  var searchableFields: [(String, String)] {
    [
      ("displayName", displayName),
      ("name", name),
      ("manufacturer", manufacturer),
      ("model", model)
    ].compactMap { label, value in
      guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return nil
      }
      return (label, value)
    }
  }
}

func emit(_ payload: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload) else {
    return
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

func stringProperty(_ object: MIDIObjectRef, property: CFString) -> String? {
  var value: Unmanaged<CFString>?
  let status = MIDIObjectGetStringProperty(object, property, &value)
  guard status == noErr, let value else {
    return nil
  }
  return value.takeRetainedValue() as String
}

func sourceDescriptor(for source: MIDIEndpointRef, index: Int) -> SourceDescriptor {
  SourceDescriptor(
    index: index,
    endpoint: source,
    displayName: stringProperty(source, property: kMIDIPropertyDisplayName),
    name: stringProperty(source, property: kMIDIPropertyName),
    manufacturer: stringProperty(source, property: kMIDIPropertyManufacturer),
    model: stringProperty(source, property: kMIDIPropertyModel)
  )
}

func rc505MatchReasons(for descriptor: SourceDescriptor) -> [String] {
  let tokens = ["rc-505", "rc505", "boss rc"]
  var reasons: [String] = []

  for (label, value) in descriptor.searchableFields {
    let lower = value.lowercased()
    for token in tokens where lower.contains(token) {
      reasons.append("\(label) contains \"\(token)\"")
    }
  }

  if reasons.isEmpty {
    reasons.append("none of displayName/name/manufacturer/model contains rc-505, rc505, or boss rc")
  }

  return reasons
}

func isRc505Source(_ descriptor: SourceDescriptor) -> Bool {
  rc505MatchReasons(for: descriptor).contains { !$0.hasPrefix("none of") }
}

func listSources() -> [SourceDescriptor] {
  let totalSources = MIDIGetNumberOfSources()
  return (0..<totalSources).map { index in
    sourceDescriptor(for: MIDIGetSource(index), index: Int(index))
  }
}

func printDebugScan(_ sources: [SourceDescriptor]) {
  print("RC-505 bridge source scan")
  print("Total MIDI sources: \(sources.count)")
  print("")

  if sources.isEmpty {
    print("No MIDI sources exposed by CoreMIDI.")
    return
  }

  for source in sources {
    let reasons = rc505MatchReasons(for: source)
    let matched = isRc505Source(source)
    print("[\(source.index)] \(source.resolvedName)")
    print("  match: \(matched ? "YES" : "NO")")
    print("  displayName: \(source.displayName ?? "(none)")")
    print("  name: \(source.name ?? "(none)")")
    print("  manufacturer: \(source.manufacturer ?? "(none)")")
    print("  model: \(source.model ?? "(none)")")
    print("  why:")
    for reason in reasons {
      print("    - \(reason)")
    }
    print("")
  }
}

func midiBytes(from packet: MIDIPacket) -> [UInt8] {
  let count = Int(packet.length)
  guard count > 0 else { return [] }
  return Mirror(reflecting: packet.data).children.prefix(count).compactMap { $0.value as? UInt8 }
}

func eventSummary(bytes: [UInt8]) -> (kind: String, summary: String) {
  guard let status = bytes.first else {
    return ("empty", "empty MIDI packet")
  }

  let command = status & 0xF0
  if command == 0xB0, bytes.count >= 3 {
    return ("cc", "cc \(bytes[1]) -> \(bytes[2])")
  }
  if command == 0x90, bytes.count >= 3 {
    if bytes[2] == 0 {
      return ("note-off", "note \(bytes[1]) off")
    }
    return ("note-on", "note \(bytes[1]) vel \(bytes[2])")
  }
  if command == 0x80, bytes.count >= 3 {
    return ("note-off", "note \(bytes[1]) off")
  }

  return ("midi", bytes.map(String.init).joined(separator: " "))
}

let debugSourcesMode = CommandLine.arguments.contains("--debug-sources")
let sources = listSources()

if debugSourcesMode {
  printDebugScan(sources)
  exit(0)
}

var client = MIDIClientRef()
var inputPort = MIDIPortRef()

let clientStatus = MIDIClientCreateWithBlock("Ravi RC-505 Bridge" as CFString, &client) { notificationPointer in
  let messageID = notificationPointer.pointee.messageID.rawValue
  emit([
    "type": "status",
    "connected": false,
    "message": "midi-notification \(messageID)"
  ])
}

guard clientStatus == noErr else {
  emit([
    "type": "error",
    "message": "failed to create MIDI client",
    "status": clientStatus
  ])
  exit(1)
}

let inputStatus = MIDIInputPortCreateWithBlock(client, "Ravi RC-505 Input" as CFString, &inputPort) {
  packetListPointer, srcConnRefCon in
  let source = srcConnRefCon.map {
    Unmanaged<NSString>.fromOpaque($0).takeUnretainedValue() as String
  } ?? "unknown-source"

  var packet = packetListPointer.pointee.packet
  for _ in 0..<packetListPointer.pointee.numPackets {
    let bytes = midiBytes(from: packet)
    if !bytes.isEmpty {
      let event = eventSummary(bytes: bytes)
      emit([
        "type": "event",
        "source": source,
        "receivedAt": Int(Date().timeIntervalSince1970 * 1000),
        "kind": event.kind,
        "summary": event.summary,
        "bytes": bytes
      ])
    }
    packet = MIDIPacketNext(&packet).pointee
  }
}

guard inputStatus == noErr else {
  emit([
    "type": "error",
    "message": "failed to create MIDI input port",
    "status": inputStatus
  ])
  exit(1)
}

let sourceNames = sources.map(\.resolvedName)
let matchedDescriptors = sources.filter(isRc505Source)
var matchedSources: [String] = []

for descriptor in matchedDescriptors {
  matchedSources.append(descriptor.resolvedName)
  let refCon = Unmanaged.passRetained(descriptor.resolvedName as NSString).toOpaque()
  MIDIPortConnectSource(inputPort, descriptor.endpoint, refCon)
}

emit([
  "type": "status",
  "connected": !matchedSources.isEmpty,
  "message": matchedSources.isEmpty ? "no RC-505 source matched at startup" : "listening",
  "sourceNames": sourceNames,
  "matchedSources": matchedSources
])

RunLoop.current.run()
