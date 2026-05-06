import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export type AtlasSplitFit = "contain" | "cover";
export type AtlasSplitMode = "raw" | "trim";

export interface AtlasGridBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AtlasCropResult {
  name: string;
  output: string;
  index: number;
  row: number;
  col: number;
  grid: AtlasGridBox;
  outputSize: {
    width: number;
    height: number;
  };
  square?: {
    side: number;
    offsetX: number;
    offsetY: number;
    size: number;
    fit: AtlasSplitFit;
    background: string;
  };
}

export interface AtlasSplitManifest {
  input: string;
  output: string;
  manifestPath: string;
  source: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  mode: AtlasSplitMode;
  rawCells: boolean;
  trim: boolean;
  size: number | null;
  fuzz: number;
  pad: number;
  fit: AtlasSplitFit;
  background: string;
  results: AtlasCropResult[];
}

export interface SplitImageAtlasOptions {
  input: string;
  outputDir: string;
  cols: number;
  rows: number;
  names?: string[];
  mode?: AtlasSplitMode;
  size?: number;
  fuzz?: number;
  pad?: number;
  fit?: AtlasSplitFit;
  background?: string;
  debug?: boolean;
}

const DEFAULT_FUZZ = 3;
const DEFAULT_SIZE = 512;
const DEFAULT_FIT: AtlasSplitFit = "contain";

function ensurePositiveInteger(value: number, label: string, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
}

function ensureNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be an integer >= 0`);
  }
}

function magick(args: string[]): string {
  try {
    return execFileSync("magick", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("ImageMagick CLI not found. Install `magick` to split image atlases.");
    }
    throw error;
  }
}

function identifySize(file: string): { width: number; height: number } {
  const output = magick(["identify", "-format", "%w %h", file]).trim();
  const [width, height] = output.split(/\s+/).map(Number);
  if (!width || !height) throw new Error(`Could not read image size: ${file}`);
  return { width, height };
}

function samplePixel(file: string, coordinate = "0,0"): string {
  return magick([file, "-format", `%[pixel:p{${coordinate}}]`, "info:"]).trim();
}

export function sanitizeAtlasCellName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "cell";
}

function resolveCellNames(names: string[] | undefined, expected: number): string[] {
  const resolved =
    names && names.length > 0
      ? names.map((name) => sanitizeAtlasCellName(name))
      : Array.from({ length: expected }, (_, i) => `cell-${i + 1}`);
  if (resolved.length !== expected) {
    throw new Error(`names must include exactly ${expected} values`);
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of resolved) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  if (duplicates.size > 0) {
    throw new Error(`names must be unique after sanitization: ${[...duplicates].join(", ")}`);
  }
  return resolved;
}

function copyImage(input: string, output: string): void {
  magick([input, output]);
}

export function splitImageAtlas(options: SplitImageAtlasOptions): AtlasSplitManifest {
  const input = resolve(options.input);
  const output = resolve(options.outputDir);
  const cols = options.cols;
  const rows = options.rows;
  const mode = options.mode ?? "raw";
  const rawCells = mode === "raw";
  const trim = mode === "trim";
  const size = rawCells ? null : (options.size ?? DEFAULT_SIZE);
  const fuzz = options.fuzz ?? DEFAULT_FUZZ;
  const pad = options.pad ?? 0;
  const fit = options.fit ?? DEFAULT_FIT;
  const backgroundOption = options.background ?? "auto";

  if (!existsSync(input)) throw new Error(`Input not found: ${input}`);
  ensurePositiveInteger(cols, "cols");
  ensurePositiveInteger(rows, "rows");
  if (size !== null) ensurePositiveInteger(size, "size", 16);
  if (!Number.isFinite(fuzz) || fuzz < 0) throw new Error("fuzz must be >= 0");
  ensureNonNegativeInteger(pad, "pad");
  if (mode !== "raw" && mode !== "trim") throw new Error("mode must be raw or trim");
  if (fit !== "contain" && fit !== "cover") throw new Error("fit must be contain or cover");

  mkdirSync(output, { recursive: true });
  const tempRoot = join(tmpdir(), `ravi-image-atlas-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempRoot, { recursive: true });

  const { width, height } = identifySize(input);
  const names = resolveCellNames(options.names, cols * rows);
  const results: AtlasCropResult[] = [];

  try {
    let cellIndex = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x0 = Math.round((col * width) / cols);
        const x1 = Math.round(((col + 1) * width) / cols);
        const y0 = Math.round((row * height) / rows);
        const y1 = Math.round(((row + 1) * height) / rows);
        const cellWidth = x1 - x0;
        const cellHeight = y1 - y0;
        const name = names[cellIndex];
        const rawCell = join(tempRoot, `${name}.cell.png`);
        const trimmed = join(tempRoot, `${name}.trim.png`);
        const cropPath = join(output, `${name}.png`);

        magick([input, "-crop", `${cellWidth}x${cellHeight}+${x0}+${y0}`, "+repage", rawCell]);

        if (rawCells) {
          copyImage(rawCell, cropPath);
          const outputSize = identifySize(cropPath);
          results.push({
            name,
            output: cropPath,
            index: cellIndex,
            row,
            col,
            grid: { x: x0, y: y0, width: cellWidth, height: cellHeight },
            outputSize,
          });
          cellIndex++;
          continue;
        }

        if (trim) {
          const trimArgs = [rawCell, "-alpha", "off", "-fuzz", `${fuzz}%`, "-trim", "+repage"];
          if (pad > 0) {
            trimArgs.push("-bordercolor", "white", "-border", String(pad));
          }
          trimArgs.push(trimmed);
          magick(trimArgs);
        } else {
          copyImage(rawCell, trimmed);
        }

        const trimSize = identifySize(trimmed);
        const background = backgroundOption === "auto" ? samplePixel(trimmed) : backgroundOption;
        let side = Math.max(trimSize.width, trimSize.height);
        let offsetX = 0;
        let offsetY = 0;

        if (fit === "cover") {
          side = Math.min(trimSize.width, trimSize.height);
          offsetX = Math.floor((trimSize.width - side) / 2);
          offsetY = Math.floor((trimSize.height - side) / 2);
          magick([
            trimmed,
            "-crop",
            `${side}x${side}+${offsetX}+${offsetY}`,
            "+repage",
            "-resize",
            `${size}x${size}`,
            cropPath,
          ]);
        } else {
          magick([
            trimmed,
            "-background",
            background,
            "-gravity",
            "center",
            "-extent",
            `${side}x${side}`,
            "-resize",
            `${size}x${size}`,
            cropPath,
          ]);
        }

        const outputSize = identifySize(cropPath);
        results.push({
          name,
          output: cropPath,
          index: cellIndex,
          row,
          col,
          grid: { x: x0, y: y0, width: cellWidth, height: cellHeight },
          outputSize,
          square: { side, offsetX, offsetY, size: size ?? DEFAULT_SIZE, fit, background },
        });

        cellIndex++;
      }
    }
  } finally {
    if (!options.debug) rmSync(tempRoot, { recursive: true, force: true });
  }

  const manifestPath = join(output, "manifest.json");
  const manifest: AtlasSplitManifest = {
    input,
    output,
    manifestPath,
    source: basename(input),
    width,
    height,
    cols,
    rows,
    mode,
    rawCells,
    trim,
    size,
    fuzz,
    pad,
    fit,
    background: backgroundOption,
    results,
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
