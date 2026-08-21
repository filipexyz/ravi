import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dir, "..");
const sourceRoot = join(projectRoot, "native", "specs-safe-fs");
const prebuildRoot = join(projectRoot, "native", "prebuilds");
const temporaryRoot = join(projectRoot, ".tmp", "specs-native-build");
const nodeAddonInclude = dirname(require.resolve("node-addon-api/package.json"));
const nodeHeaders = require("node-api-headers") as {
  include_dir: string;
};

type SupportedPlatform = "linux" | "win32";
const supportedPlatforms: SupportedPlatform[] = ["linux", "win32"];
const addonName = "ravi_specs_safe_fs.node";

function assertGeneratedPath(path: string, root: string): void {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (!resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Refusing to alter generated path outside ${resolvedRoot}: ${resolvedPath}`);
  }
}

function resetGeneratedDirectory(path: string, root: string): void {
  assertGeneratedPath(path, root);
  rmSync(path, { force: true, recursive: true });
  mkdirSync(path, { recursive: true });
}

function cleanAllPrebuilds(): void {
  if (resolve(prebuildRoot) !== resolve(projectRoot, "native", "prebuilds")) {
    throw new Error(`Refusing to clean unexpected prebuild root: ${prebuildRoot}`);
  }
  rmSync(prebuildRoot, { force: true, recursive: true });
  mkdirSync(prebuildRoot, { recursive: true });
}

function verifyPublishedPrebuilds(requiredPlatforms: SupportedPlatform[] = []): void {
  const requiredDirectories = new Set(requiredPlatforms.map((platform) => `${platform}-x64`));
  const actualDirectories = existsSync(prebuildRoot) ? readdirSync(prebuildRoot, { withFileTypes: true }) : [];

  for (const entry of actualDirectories) {
    if (!entry.isDirectory() || !supportedPlatforms.some((platform) => entry.name === `${platform}-x64`)) {
      throw new Error(`Unexpected native package artifact: native/prebuilds/${entry.name}`);
    }
    requiredDirectories.delete(entry.name);
    const directory = join(prebuildRoot, entry.name);
    const contents = readdirSync(directory, { withFileTypes: true });
    if (contents.length !== 1 || !contents[0]?.isFile() || contents[0].name !== addonName) {
      const names = contents.map((item) => item.name).join(", ") || "<empty>";
      throw new Error(`Native package directory ${entry.name} must contain only ${addonName}; found ${names}.`);
    }
    const addon = join(directory, addonName);
    if (statSync(addon).size === 0) throw new Error(`Native package artifact is empty: ${addon}`);
  }

  if (requiredDirectories.size > 0) {
    throw new Error(`Missing native package directories: ${[...requiredDirectories].join(", ")}`);
  }
}

function normalizeWindowsPeTimestamps(path: string): void {
  const image = readFileSync(path);
  if (image.length < 0x40) throw new Error(`Invalid PE image: ${path}`);
  const peOffset = image.readUInt32LE(0x3c);
  if (peOffset + 24 > image.length || image.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`Invalid PE signature: ${path}`);
  }

  const numberOfSections = image.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = image.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  const magic = image.readUInt16LE(optionalHeader);
  const dataDirectories = optionalHeader + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  if (dataDirectories < optionalHeader) throw new Error(`Unsupported PE optional header: ${path}`);

  const debugDirectoryEntry = dataDirectories + 6 * 8;
  if (debugDirectoryEntry + 8 > optionalHeader + optionalHeaderSize) {
    throw new Error(`Invalid PE debug directory table: ${path}`);
  }
  const debugRva = image.readUInt32LE(debugDirectoryEntry);
  const debugSize = image.readUInt32LE(debugDirectoryEntry + 4);
  const sectionTable = optionalHeader + optionalHeaderSize;

  image.writeUInt32LE(0, peOffset + 8);
  if (debugRva !== 0 && debugSize !== 0) {
    let debugOffset: number | undefined;
    for (let index = 0; index < numberOfSections; index += 1) {
      const section = sectionTable + index * 40;
      if (section + 40 > image.length) throw new Error(`Truncated PE section table: ${path}`);
      const virtualSize = image.readUInt32LE(section + 8);
      const virtualAddress = image.readUInt32LE(section + 12);
      const rawSize = image.readUInt32LE(section + 16);
      const rawOffset = image.readUInt32LE(section + 20);
      const mappedSize = Math.max(virtualSize, rawSize);
      if (debugRva >= virtualAddress && debugRva < virtualAddress + mappedSize) {
        debugOffset = rawOffset + (debugRva - virtualAddress);
        break;
      }
    }
    if (debugOffset === undefined || debugOffset + debugSize > image.length || debugSize % 28 !== 0) {
      throw new Error(`Invalid PE debug directory: ${path}`);
    }
    for (let offset = debugOffset; offset < debugOffset + debugSize; offset += 28) {
      image.writeUInt32LE(0, offset + 4);
    }
  }

  writeFileSync(path, image);
}

function relativeCompilerPath(path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

function pathMapArgs(path: string, replacement: string): string[] {
  const absolutePath = resolve(path);
  const spellings = new Set([absolutePath, absolutePath.replaceAll("\\", "/")]);
  return [...spellings].flatMap((spelling) => [
    `-ffile-prefix-map=${spelling}=${replacement}`,
    `-fdebug-prefix-map=${spelling}=${replacement}`,
    `-fmacro-prefix-map=${spelling}=${replacement}`,
  ]);
}

function zigToolchain(): { executable: string; root: string } {
  if (process.arch !== "x64") {
    throw new Error(`The specs native layer currently supports x64 builds, got ${process.arch}.`);
  }
  const packageName = `@oven/zig-${process.platform}-${process.arch}`;
  const packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  const executable = join(packageRoot, process.platform === "win32" ? "zig.exe" : "zig");
  if (!existsSync(executable)) throw new Error(`Zig compiler not found at ${executable}.`);
  return { executable, root: packageRoot };
}

function build(platform: SupportedPlatform): void {
  const temporaryDirectory = join(temporaryRoot, `${platform}-x64`);
  const outputDirectory = join(prebuildRoot, `${platform}-x64`);
  resetGeneratedDirectory(temporaryDirectory, temporaryRoot);
  const temporaryOutput = join(temporaryDirectory, addonName);
  const zig = zigToolchain();

  const target = platform === "win32" ? "x86_64-windows-gnu" : "x86_64-linux-gnu.2.17";
  const platformSource = join(sourceRoot, platform === "win32" ? "platform_windows.cc" : "platform_linux.cc");
  const args = [
    "c++",
    "-std=c++20",
    "-O2",
    "-shared",
    "-fexceptions",
    `-target`,
    target,
    "-DNAPI_VERSION=8",
    "-DNODE_ADDON_API_DISABLE_DEPRECATED",
    "-fdebug-compilation-dir=.",
    ...pathMapArgs(projectRoot, "."),
    ...pathMapArgs(zig.root, ".zig"),
    ...pathMapArgs(nodeHeaders.include_dir, ".node-api-headers"),
    ...pathMapArgs(nodeAddonInclude, ".node-addon-api"),
    `-I${relativeCompilerPath(nodeHeaders.include_dir)}`,
    `-I${relativeCompilerPath(nodeAddonInclude)}`,
    `-I${relativeCompilerPath(sourceRoot)}`,
    relativeCompilerPath(join(sourceRoot, "addon.cc")),
    relativeCompilerPath(platformSource),
    ...(platform === "win32"
      ? [relativeCompilerPath(join(sourceRoot, "napi_dynamic_windows.cc")), "-lntdll"]
      : ["-Wl,--allow-shlib-undefined"]),
    "-Wl,--strip-debug",
    "-o",
    relativeCompilerPath(temporaryOutput),
  ];
  try {
    const result = spawnSync(zig.executable, args, {
      cwd: projectRoot,
      env: { ...process.env, SOURCE_DATE_EPOCH: "0" },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Native specs build failed for ${platform} with exit ${result.status}.`);
    if (!existsSync(temporaryOutput) || statSync(temporaryOutput).size === 0) {
      throw new Error(`Native specs build did not produce ${temporaryOutput}.`);
    }
    if (platform === "win32") normalizeWindowsPeTimestamps(temporaryOutput);

    resetGeneratedDirectory(outputDirectory, prebuildRoot);
    const publishedOutput = join(outputDirectory, addonName);
    copyFileSync(temporaryOutput, publishedOutput);
    verifyPublishedPrebuilds();
    console.log(`Built ${publishedOutput}`);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
    try {
      rmdirSync(temporaryRoot);
    } catch (error) {
      if (!new Set(["ENOENT", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

const requested = process.argv[2] ?? "current";
if (requested === "all") {
  cleanAllPrebuilds();
  build("linux");
  build("win32");
  verifyPublishedPrebuilds(supportedPlatforms);
} else if (requested === "current") {
  if (process.platform !== "linux" && process.platform !== "win32") {
    throw new Error(`The specs native layer does not support ${process.platform}.`);
  }
  build(process.platform);
} else if (requested === "check") {
  verifyPublishedPrebuilds(supportedPlatforms);
} else {
  throw new Error(`Unknown native build target: ${requested}. Use current|all|check.`);
}
