import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitImageAtlas } from "./atlas.js";

const hasMagick = spawnSync("magick", ["-version"], { stdio: "ignore" }).status === 0;
const maybeIt = hasMagick ? it : it.skip;

function writePpmAtlas(path: string): void {
  const width = 6;
  const height = 4;
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
  ];
  const pixels: string[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const col = Math.floor(x / 2);
      const row = Math.floor(y / 2);
      pixels.push(colors[row * 3 + col].join(" "));
    }
  }
  writeFileSync(path, `P3\n${width} ${height}\n255\n${pixels.join("\n")}\n`);
}

describe("image atlas", () => {
  maybeIt("splits an atlas into raw deterministic grid cells and writes a manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-atlas-test-"));
    try {
      const input = join(dir, "atlas.ppm");
      const outputDir = join(dir, "crops");
      writePpmAtlas(input);

      const manifest = splitImageAtlas({
        input,
        outputDir,
        cols: 3,
        rows: 2,
        names: ["one", "two", "three", "four", "five", "six"],
      });

      expect(manifest.width).toBe(6);
      expect(manifest.height).toBe(4);
      expect(manifest.mode).toBe("raw");
      expect(manifest.rawCells).toBe(true);
      expect(manifest.results).toHaveLength(6);
      expect(manifest.results[0]).toMatchObject({
        name: "one",
        index: 0,
        row: 0,
        col: 0,
        grid: { x: 0, y: 0, width: 2, height: 2 },
        outputSize: { width: 2, height: 2 },
      });
      expect(existsSync(join(outputDir, "one.png"))).toBe(true);
      expect(existsSync(join(outputDir, "six.png"))).toBe(true);
      expect(JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8")).results).toHaveLength(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  maybeIt("rejects names that collide after sanitization", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-atlas-test-"));
    try {
      const input = join(dir, "atlas.ppm");
      writePpmAtlas(input);

      expect(() =>
        splitImageAtlas({
          input,
          outputDir: join(dir, "crops"),
          cols: 2,
          rows: 1,
          names: ["same!", "same?"],
        }),
      ).toThrow("names must be unique after sanitization");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
