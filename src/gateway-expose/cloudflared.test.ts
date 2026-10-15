import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  CLOUDFLARE_DEVELOPER_TEAM_ID,
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  type CloudflaredAsset,
  type CloudflaredFetch,
  type CloudflaredPlatformKey,
  cloudflaredCodesignArgs,
  cloudflaredPlatformKey,
  type CommandOutput,
  extractCloudflaredFromTgz,
  installCloudflared,
  locateCloudflared,
  pinnedCloudflaredPath,
} from "./cloudflared.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function tarEntry(name: string, data: Uint8Array, type = "0"): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.fill(" ", 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  Buffer.from(data).copy(padded);
  return Buffer.concat([header, padded]);
}

const tgz = (...entries: Uint8Array[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

const BINARY = Buffer.from("#!/bin/sh\necho fake cloudflared\n");
const VERSION_OK = { status: 0, stdout: `cloudflared version ${CLOUDFLARED_VERSION} (built 2026-09-11)\n`, stderr: "" };

function assetsFor(key: CloudflaredPlatformKey, asset: CloudflaredAsset) {
  return { ...CLOUDFLARED_ASSETS, [key]: asset };
}

const TEST_TEAM_ID = "ABCDE12345";

/** A darwin-arm64 install whose asset, executable pin and Team ID the test controls. */
function darwinDeps(
  archive: Uint8Array,
  order: string[],
  codesign: CommandOutput = { status: 0, stdout: "", stderr: "" },
) {
  return {
    platform: "darwin" as const,
    arch: "arm64",
    binDir,
    env: {},
    codesignTeamId: TEST_TEAM_ID,
    runCodesign: (args: string[]) => {
      order.push(`codesign ${args.join(" ")}`);
      return codesign;
    },
    assets: assetsFor("darwin-arm64", {
      url: CLOUDFLARED_ASSETS["darwin-arm64"].url,
      sha256: sha256(archive),
      archive: "tgz",
      binarySha256: sha256(BINARY),
    }),
  };
}

/** github.com answers with a redirect to `redirectTo`; that host serves `body`. */
function fakeRelease(body: Uint8Array, redirectTo = "https://release-assets.githubusercontent.com/blob") {
  const calls: string[] = [];
  const fetch: CloudflaredFetch = async (url) => {
    calls.push(url);
    if (new URL(url).hostname === "github.com") {
      return new Response(null, { status: 302, headers: { location: redirectTo } });
    }
    return new Response(body, { status: 200 });
  };
  return { fetch, calls };
}

let binDir: string;
beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "ravi-cloudflared-"));
});
afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

const leftovers = () => readdirSync(binDir);

describe("pinned release table", () => {
  test("every supported platform has a 64-hex SHA-256 and a URL on the pinned GitHub release", () => {
    expect(Object.keys(CLOUDFLARED_ASSETS).sort()).toEqual([
      "darwin-amd64",
      "darwin-arm64",
      "linux-amd64",
      "linux-arm64",
    ]);
    for (const [key, asset] of Object.entries(CLOUDFLARED_ASSETS)) {
      expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.url, key).toStartWith(
        `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-${key}`,
      );
      expect(asset.archive, key).toBe(key.startsWith("darwin") ? "tgz" : "binary");
      // A bare binary's own hash is its download hash; a darwin executable's needs the extracted
      // bytes, so it stays an explicit placeholder until a human pins it (RUNBOOK §Bumping the pin).
      expect(asset.binarySha256, key).toBe(key.startsWith("darwin") ? null : asset.sha256);
    }
    // Not guessed: a human reads it with `codesign -dv` and pins it.
    expect(CLOUDFLARE_DEVELOPER_TEAM_ID).toBeNull();
    expect(new Set(Object.values(CLOUDFLARED_ASSETS).map((asset) => asset.sha256)).size).toBe(4);
  });

  test("maps node platform/arch and refuses anything else with a clear error", () => {
    expect(cloudflaredPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cloudflaredPlatformKey("darwin", "x64")).toBe("darwin-amd64");
    expect(cloudflaredPlatformKey("linux", "x64")).toBe("linux-amd64");
    expect(cloudflaredPlatformKey("linux", "arm64")).toBe("linux-arm64");
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["linux", "ia32"],
      ["freebsd", "x64"],
    ] as const) {
      expect(() => cloudflaredPlatformKey(platform, arch)).toThrow(/No pinned cloudflared .* build for/);
      // No pointer to a flag that does not exist.
      expect(() => cloudflaredPlatformKey(platform, arch)).not.toThrow(/--cloudflared/);
    }
  });
});

describe("installCloudflared", () => {
  test("downloads through an allowed redirect, checks the hash, installs 0700 and checks --version", async () => {
    const { fetch, calls } = fakeRelease(BINARY);
    const versionCalls: string[] = [];
    const installed = await installCloudflared({
      fetch,
      platform: "linux",
      arch: "x64",
      binDir,
      assets: assetsFor("linux-amd64", {
        url: CLOUDFLARED_ASSETS["linux-amd64"].url,
        sha256: sha256(BINARY),
        archive: "binary",
        binarySha256: sha256(BINARY),
      }),
      runVersion: (path) => {
        versionCalls.push(path);
        return VERSION_OK;
      },
    });
    expect(installed).toMatchObject({
      path: pinnedCloudflaredPath(binDir),
      reused: false,
      version: CLOUDFLARED_VERSION,
    });
    expect(calls).toEqual([CLOUDFLARED_ASSETS["linux-amd64"].url, "https://release-assets.githubusercontent.com/blob"]);
    // The version check ran on the staged copy, before it was moved into place.
    expect(versionCalls[0]).toContain(".cloudflared-install-");
    expect(statSync(installed.path).mode & 0o777).toBe(0o700);
    expect(statSync(binDir).mode & 0o777).toBe(0o700);
    expect(leftovers()).toEqual([`cloudflared-${CLOUDFLARED_VERSION}`]);

    // Already installed and answering the pinned version: nothing is downloaded.
    const again = await installCloudflared({
      fetch: async () => {
        throw new Error("no download expected");
      },
      platform: "linux",
      arch: "x64",
      binDir,
      assets: assetsFor("linux-amd64", { ...CLOUDFLARED_ASSETS["linux-amd64"], binarySha256: sha256(BINARY) }),
      runVersion: () => VERSION_OK,
    });
    expect(again.reused).toBe(true);
  });

  test("extracts only the cloudflared member of a darwin tgz, then checks its hash and signature before --version", async () => {
    const archive = tgz(tarEntry("._cloudflared", Buffer.from("appledouble")), tarEntry("cloudflared", BINARY));
    const { fetch } = fakeRelease(archive);
    const order: string[] = [];
    const installed = await installCloudflared({
      ...darwinDeps(archive, order),
      fetch,
      runVersion: (path) => {
        order.push(`version ${path}`);
        return VERSION_OK;
      },
    });
    expect(readFileSync(installed.path)).toEqual(BINARY);
    // codesign ran on the staged copy, with the Team ID requirement, before the binary was ever run.
    expect(order).toHaveLength(2);
    expect(order[0]).toStartWith(
      'codesign --verify --strict -R=anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345" ',
    );
    expect(order[0]).toContain(".cloudflared-install-");
    expect(order[1]).toStartWith("version ");
  });

  test("a checksum mismatch aborts before extraction and leaves nothing installed", async () => {
    const { fetch } = fakeRelease(BINARY);
    let versionRan = false;
    await expect(
      installCloudflared({
        fetch,
        platform: "linux",
        arch: "x64",
        binDir,
        runVersion: () => {
          versionRan = true;
          return VERSION_OK;
        },
      }),
    ).rejects.toMatchObject({ code: "checksum_mismatch" });
    expect(versionRan).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(existsSync(pinnedCloudflaredPath(binDir))).toBe(false);
  });

  test("a redirect to a host outside the GitHub release hosts is refused", async () => {
    for (const target of ["https://evil.example/cloudflared", "http://release-assets.githubusercontent.com/blob"]) {
      const { fetch, calls } = fakeRelease(BINARY, target);
      await expect(
        installCloudflared({
          fetch,
          platform: "linux",
          arch: "x64",
          binDir,
          assets: assetsFor("linux-amd64", {
            url: CLOUDFLARED_ASSETS["linux-amd64"].url,
            sha256: sha256(BINARY),
            archive: "binary",
            binarySha256: sha256(BINARY),
          }),
          runVersion: () => VERSION_OK,
        }),
      ).rejects.toMatchObject({ code: "redirect_refused" });
      expect(calls).toHaveLength(1);
      expect(leftovers()).toEqual([]);
    }
  });

  test("a binary that does not report the pinned version is not installed", async () => {
    const { fetch } = fakeRelease(BINARY);
    await expect(
      installCloudflared({
        fetch,
        platform: "linux",
        arch: "arm64",
        binDir,
        assets: assetsFor("linux-arm64", {
          url: CLOUDFLARED_ASSETS["linux-arm64"].url,
          sha256: sha256(BINARY),
          archive: "binary",
          binarySha256: sha256(BINARY),
        }),
        runVersion: () => ({ status: 0, stdout: "cloudflared version 2025.1.0\n", stderr: "" }),
      }),
    ).rejects.toMatchObject({ code: "version_mismatch" });
    expect(leftovers()).toEqual([]);
  });

  test("an unsupported platform fails before any download", async () => {
    await expect(
      installCloudflared({
        fetch: async () => {
          throw new Error("no download expected");
        },
        platform: "win32",
        arch: "x64",
        binDir,
      }),
    ).rejects.toMatchObject({ code: "unsupported_platform" });
  });
});

describe("extractCloudflaredFromTgz", () => {
  test("refuses a symlink or a missing member", () => {
    expect(() => extractCloudflaredFromTgz(tgz(tarEntry("cloudflared", Buffer.alloc(0), "2")))).toThrow(
      /not a regular file/,
    );
    expect(() => extractCloudflaredFromTgz(tgz(tarEntry("other", BINARY)))).toThrow(/does not contain/);
    expect(() => extractCloudflaredFromTgz(Buffer.from("not gzip"))).toThrow(/not gzip/);
    expect(Buffer.from(extractCloudflaredFromTgz(tgz(tarEntry("./cloudflared", BINARY))))).toEqual(BINARY);
  });
});

describe("locateCloudflared", () => {
  test("prefers the pinned install; an explicit path is reported unverified", () => {
    const linux = {
      binDir,
      platform: "linux" as const,
      arch: "x64",
      assets: assetsFor("linux-amd64", { ...CLOUDFLARED_ASSETS["linux-amd64"], binarySha256: sha256(BINARY) }),
    };
    expect(locateCloudflared(linux)).toMatchObject({ found: false, reason: "not_installed" });
    const pinned = pinnedCloudflaredPath(binDir);
    writeFileSync(pinned, BINARY, { mode: 0o700 });
    expect(locateCloudflared(linux)).toEqual({
      found: true,
      path: pinned,
      verified: true,
      source: "pinned",
      version: CLOUDFLARED_VERSION,
    });
    // A group- or world-accessible pinned binary is not trusted.
    chmodSync(pinned, 0o755);
    expect(locateCloudflared(linux)).toMatchObject({ found: false, reason: "not_installed" });

    expect(locateCloudflared({ binDir, explicitPath: pinned })).toEqual({
      found: true,
      path: pinned,
      verified: false,
      source: "explicit",
      version: null,
    });
    expect(locateCloudflared({ explicitPath: "cloudflared" })).toMatchObject({
      found: false,
      reason: "explicit_invalid",
    });
    expect(locateCloudflared({ explicitPath: join(binDir, "missing") })).toMatchObject({ found: false });
  });
});

describe("cloudflared supply chain: executable pin and Developer ID signature", () => {
  test("a darwin binary failing the codesign requirement is never run or installed", async () => {
    const archive = tgz(tarEntry("cloudflared", BINARY));
    const order: string[] = [];
    await expect(
      installCloudflared({
        ...darwinDeps(archive, order, { status: 3, stdout: "", stderr: "test-requirement: code failed to satisfy" }),
        fetch: fakeRelease(archive).fetch,
        runVersion: () => {
          order.push("version");
          return VERSION_OK;
        },
      }),
    ).rejects.toMatchObject({ code: "codesign_failed" });
    expect(order).toHaveLength(1);
    expect(order[0]).toStartWith("codesign ");
    expect(leftovers()).toEqual([]);
  });

  test("the unpinned Team ID refuses a darwin install before any download, unless RAVI_CLOUDFLARED_SKIP_CODESIGN=1", async () => {
    const archive = tgz(tarEntry("cloudflared", BINARY));
    const order: string[] = [];
    const noDownload: CloudflaredFetch = async () => {
      throw new Error("no download expected");
    };
    await expect(
      installCloudflared({ ...darwinDeps(archive, order), codesignTeamId: undefined, fetch: noDownload }),
    ).rejects.toMatchObject({
      code: "codesign_unpinned",
      message: expect.stringContaining("codesign team id not pinned yet"),
    });
    expect(leftovers()).toEqual([]);

    const installed = await installCloudflared({
      ...darwinDeps(archive, order),
      codesignTeamId: undefined,
      env: { RAVI_CLOUDFLARED_SKIP_CODESIGN: "1" },
      fetch: fakeRelease(archive).fetch,
      runVersion: () => VERSION_OK,
    });
    expect(installed.reused).toBe(false);
    expect(order).toEqual([]); // the override skipped codesign, nothing else
  });

  test("the extracted executable must match its own pin; an unpinned one needs RAVI_CLOUDFLARED_SKIP_BINARY_PIN=1", async () => {
    const archive = tgz(tarEntry("cloudflared", BINARY));
    const order: string[] = [];
    const deps = darwinDeps(archive, order);
    const other = Buffer.from("#!/bin/sh\necho another build\n");
    await expect(
      installCloudflared({
        ...deps,
        fetch: fakeRelease(archive).fetch,
        assets: assetsFor("darwin-arm64", { ...deps.assets["darwin-arm64"], binarySha256: sha256(other) }),
        runVersion: () => VERSION_OK,
      }),
    ).rejects.toMatchObject({ code: "binary_mismatch" });
    expect(order).toEqual([]); // neither codesign nor --version saw it
    expect(leftovers()).toEqual([]);

    const unpinned = assetsFor("darwin-arm64", { ...deps.assets["darwin-arm64"], binarySha256: null });
    await expect(
      installCloudflared({
        ...deps,
        assets: unpinned,
        fetch: async () => {
          throw new Error("no download expected");
        },
      }),
    ).rejects.toMatchObject({ code: "binary_unpinned" });
    const installed = await installCloudflared({
      ...deps,
      assets: unpinned,
      env: { RAVI_CLOUDFLARED_SKIP_BINARY_PIN: "1" },
      fetch: fakeRelease(archive).fetch,
      runVersion: () => VERSION_OK,
    });
    expect(readFileSync(installed.path)).toEqual(BINARY);
  });

  test("reuse and locate re-check the installed executable's hash", async () => {
    const assets = assetsFor("linux-amd64", {
      url: CLOUDFLARED_ASSETS["linux-amd64"].url,
      sha256: sha256(BINARY),
      archive: "binary",
      binarySha256: sha256(BINARY),
    });
    const linux = { platform: "linux" as const, arch: "x64", binDir, assets };
    const pinned = pinnedCloudflaredPath(binDir);
    // A swapped binary at the pinned path (same mode, same owner).
    writeFileSync(pinned, Buffer.from("#!/bin/sh\necho swapped\n"), { mode: 0o700 });
    expect(locateCloudflared(linux)).toMatchObject({ found: false, reason: "binary_mismatch" });

    const { fetch, calls } = fakeRelease(BINARY);
    const ranVersion: string[] = [];
    const installed = await installCloudflared({
      ...linux,
      fetch,
      runVersion: (path) => {
        ranVersion.push(path);
        return VERSION_OK;
      },
    });
    // Not reused (and the swapped binary was never run): downloaded and replaced.
    expect(installed.reused).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(ranVersion.every((path) => path !== pinned)).toBe(true);
    expect(readFileSync(pinned)).toEqual(BINARY);
    expect(locateCloudflared(linux)).toMatchObject({ found: true, verified: true });

    // darwin with the executable hash still unpinned: refused, or accepted unverified with the override.
    const darwin = { platform: "darwin" as const, arch: "arm64", binDir };
    expect(locateCloudflared({ ...darwin, env: {} })).toMatchObject({ found: false, reason: "binary_unpinned" });
    expect(locateCloudflared({ ...darwin, env: { RAVI_CLOUDFLARED_SKIP_BINARY_PIN: "1" } })).toEqual({
      found: true,
      path: pinned,
      verified: false,
      source: "pinned",
      version: CLOUDFLARED_VERSION,
    });
  });

  test("the designated requirement pins an Apple-anchored Developer ID leaf to the Team ID", () => {
    expect(cloudflaredCodesignArgs("/tmp/x/cloudflared", "ABCDE12345")).toEqual([
      "--verify",
      "--strict",
      '-R=anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"',
      "/tmp/x/cloudflared",
    ]);
  });
});
