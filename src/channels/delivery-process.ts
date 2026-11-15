import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync, realpathSync } from "node:fs";

export type DeliveryProcessObservation = Readonly<{
  pid: number;
  processStartToken: string;
  executablePath: string;
  argv: readonly string[];
}>;

function observeLinux(pid: number): DeliveryProcessObservation | null {
  const prefix = `/proc/${pid}`;
  const stat = readFileSync(`${prefix}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  if (fields[0] === "Z" || !/^\d+$/.test(fields[19] ?? "")) return null;
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(bootId)) return null;
  const argv = readFileSync(`${prefix}/cmdline`, "utf8").split("\0");
  if (argv.at(-1) === "") argv.pop();
  if (!argv.length || !argv[0]) return null;
  return {
    pid,
    processStartToken: `linux:${bootId}:${fields[19]}`,
    executablePath: realpathSync(`${prefix}/exe`),
    argv,
  };
}

function openDarwinLibraries() {
  return {
    proc: dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    }),
    system: dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
    }),
  };
}

let darwinLibraries: ReturnType<typeof openDarwinLibraries> | undefined;

function observeDarwin(pid: number): DeliveryProcessObservation | null {
  const libraries = (darwinLibraries ??= openDarwinLibraries());
  // Public proc_bsdinfo ABI (sys/proc_info.h), including microsecond start identity.
  const info = Buffer.alloc(136);
  if (libraries.proc.symbols.proc_pidinfo(pid, 3, 0, ptr(info), info.length) !== info.length) return null;
  if (info.readUInt32LE(12) !== pid || info.readUInt32LE(4) === 5) return null; // SZOMB
  const seconds = info.readBigUInt64LE(120);
  const microseconds = info.readBigUInt64LE(128);
  if (seconds === 0n || microseconds >= 1_000_000n) return null;
  const executable = Buffer.alloc(4096);
  if (libraries.proc.symbols.proc_pidpath(pid, ptr(executable), executable.length) <= 0) return null;
  const executableEnd = executable.indexOf(0);
  if (executableEnd < 1) return null;

  // KERN_PROCARGS2 supplies argv with NUL boundaries, unlike ps command rendering.
  const mib = new Int32Array([1, 49, pid]);
  const length = new BigUint64Array(1);
  if (libraries.system.symbols.sysctl(ptr(mib), 3, null, ptr(length), null, 0) !== 0) return null;
  const size = Number(length[0]);
  if (!Number.isSafeInteger(size) || size < 5 || size > 1024 * 1024) return null;
  const args = Buffer.alloc(size);
  if (libraries.system.symbols.sysctl(ptr(mib), 3, ptr(args), ptr(length), null, 0) !== 0) return null;
  const argc = args.readInt32LE(0);
  if (argc < 1 || argc > 4096) return null;
  let cursor = args.indexOf(0, 4) + 1;
  if (cursor < 5) return null;
  while (cursor < args.length && args[cursor] === 0) cursor++;
  const argv: string[] = [];
  for (let index = 0; index < argc; index++) {
    const end = args.indexOf(0, cursor);
    if (end < cursor) return null;
    argv.push(args.toString("utf8", cursor, end));
    cursor = end + 1;
  }
  if (!argv[0]) return null;
  return {
    pid,
    processStartToken: `darwin:${seconds}:${microseconds}`,
    executablePath: realpathSync(executable.toString("utf8", 0, executableEnd)),
    argv,
  };
}

/** Missing permissions, unsupported OS, dead/reused PID or torn observations fail closed. */
export function observeDeliveryProcess(pid: number): DeliveryProcessObservation | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const read = process.platform === "linux" ? observeLinux : process.platform === "darwin" ? observeDarwin : null;
    if (!read) return null;
    const first = read(pid);
    const second = read(pid);
    if (!first || !second || JSON.stringify(first) !== JSON.stringify(second)) return null;
    return second;
  } catch {
    // no-cause: Kernel observation failure is unknown identity, never proof of a compatible live boot.
    return null;
  }
}
