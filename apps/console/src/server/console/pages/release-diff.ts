// Pure comparison logic for Ravi Pages releases: which routes and files changed
// between two immutable site releases, and a line diff for one text file.

export type ReleaseDiffRouteInput = {
  path: string;
  matchType: string;
  priority: number;
  artifactId: string;
  artifactVersionId: string;
  artifactVersionNumber: number | null;
  entrypoint: string;
  visibility: string;
};

export type ReleaseDiffFileInput = {
  path: string;
  sha256: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
};

export type ReleaseDiffChangeStatus = "added" | "removed" | "changed" | "unchanged";

export type ReleaseDiffRouteSide = {
  artifactId: string;
  artifactVersionId: string;
  artifactVersionNumber: number | null;
  entrypoint: string;
  priority: number;
  visibility: string;
};

export type ReleaseDiffFile = {
  path: string;
  status: Exclude<ReleaseDiffChangeStatus, "unchanged">;
  base: ReleaseDiffFileInput | null;
  target: ReleaseDiffFileInput | null;
  textDiffAvailable: boolean;
};

export type ReleaseDiffRouteChange = "content" | "visibility" | "entrypoint" | "priority";

export type ReleaseDiffRoute = {
  path: string;
  matchType: string;
  status: ReleaseDiffChangeStatus;
  changes: ReleaseDiffRouteChange[];
  base: ReleaseDiffRouteSide | null;
  target: ReleaseDiffRouteSide | null;
  files: ReleaseDiffFile[];
  unchangedFileCount: number;
};

export type ReleaseDiffSummary = {
  routesAdded: number;
  routesRemoved: number;
  routesChanged: number;
  routesUnchanged: number;
  filesAdded: number;
  filesRemoved: number;
  filesChanged: number;
};

export const RELEASE_TEXT_DIFF_MAX_BYTES = 512 * 1024;

export function releaseRouteKey(route: { path: string; matchType: string }) {
  return `${route.matchType}:${route.path}`;
}

export function diffReleaseRoutes(input: {
  baseRoutes: ReleaseDiffRouteInput[];
  targetRoutes: ReleaseDiffRouteInput[];
  filesForVersion: (artifactVersionId: string) => ReleaseDiffFileInput[];
}): { routes: ReleaseDiffRoute[]; summary: ReleaseDiffSummary } {
  const baseByKey = new Map(input.baseRoutes.map((route) => [releaseRouteKey(route), route]));
  const targetByKey = new Map(input.targetRoutes.map((route) => [releaseRouteKey(route), route]));
  const keys = [...new Set([...targetByKey.keys(), ...baseByKey.keys()])];
  const routes: ReleaseDiffRoute[] = [];

  for (const key of keys) {
    const base = baseByKey.get(key) ?? null;
    const target = targetByKey.get(key) ?? null;
    const reference = (target ?? base)!;
    const changes: ReleaseDiffRouteChange[] = [];
    if (base && target) {
      if (base.artifactVersionId !== target.artifactVersionId) changes.push("content");
      if (base.visibility !== target.visibility) changes.push("visibility");
      if (base.entrypoint !== target.entrypoint) changes.push("entrypoint");
      if (base.priority !== target.priority) changes.push("priority");
    }

    const fileDiff =
      base && target && base.artifactVersionId === target.artifactVersionId
        ? { files: [], unchangedFileCount: input.filesForVersion(target.artifactVersionId).length }
        : diffReleaseFiles(
            base ? input.filesForVersion(base.artifactVersionId) : [],
            target ? input.filesForVersion(target.artifactVersionId) : [],
          );
    // Two versions can hold byte-identical files; that is not a content change.
    if (changes[0] === "content" && fileDiff.files.length === 0) changes.shift();

    const status: ReleaseDiffChangeStatus = !base ? "added" : !target ? "removed" : changes.length > 0 ? "changed" : "unchanged";
    routes.push({
      path: reference.path,
      matchType: reference.matchType,
      status,
      changes,
      base: base ? routeSide(base) : null,
      target: target ? routeSide(target) : null,
      files: fileDiff.files,
      unchangedFileCount: fileDiff.unchangedFileCount,
    });
  }

  routes.sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.path.localeCompare(right.path));

  const summary: ReleaseDiffSummary = {
    routesAdded: 0,
    routesRemoved: 0,
    routesChanged: 0,
    routesUnchanged: 0,
    filesAdded: 0,
    filesRemoved: 0,
    filesChanged: 0,
  };
  for (const route of routes) {
    if (route.status === "added") summary.routesAdded += 1;
    else if (route.status === "removed") summary.routesRemoved += 1;
    else if (route.status === "changed") summary.routesChanged += 1;
    else summary.routesUnchanged += 1;
    for (const file of route.files) {
      if (file.status === "added") summary.filesAdded += 1;
      else if (file.status === "removed") summary.filesRemoved += 1;
      else summary.filesChanged += 1;
    }
  }
  return { routes, summary };
}

export function diffReleaseFiles(baseFiles: ReleaseDiffFileInput[], targetFiles: ReleaseDiffFileInput[]) {
  const baseByPath = new Map(baseFiles.map((file) => [file.path, file]));
  const targetByPath = new Map(targetFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...baseByPath.keys(), ...targetByPath.keys()])].sort((left, right) => left.localeCompare(right));
  const files: ReleaseDiffFile[] = [];
  let unchangedFileCount = 0;

  for (const path of paths) {
    const base = baseByPath.get(path) ?? null;
    const target = targetByPath.get(path) ?? null;
    if (base && target && sameFileContent(base, target)) {
      unchangedFileCount += 1;
      continue;
    }
    files.push({
      path,
      status: !base ? "added" : !target ? "removed" : "changed",
      base,
      target,
      textDiffAvailable: [base, target].every((file) => !file || isTextDiffable(file)),
    });
  }
  return { files, unchangedFileCount };
}

function sameFileContent(left: ReleaseDiffFileInput, right: ReleaseDiffFileInput) {
  if (left.sha256 && right.sha256) return left.sha256 === right.sha256;
  return false;
}

function routeSide(route: ReleaseDiffRouteInput): ReleaseDiffRouteSide {
  return {
    artifactId: route.artifactId,
    artifactVersionId: route.artifactVersionId,
    artifactVersionNumber: route.artifactVersionNumber,
    entrypoint: route.entrypoint,
    priority: route.priority,
    visibility: route.visibility,
  };
}

function statusRank(status: ReleaseDiffChangeStatus) {
  return status === "changed" ? 0 : status === "added" ? 1 : status === "removed" ? 2 : 3;
}

const TEXT_EXTENSIONS = new Set([
  "css",
  "csv",
  "htm",
  "html",
  "js",
  "json",
  "jsx",
  "map",
  "md",
  "mjs",
  "svg",
  "ts",
  "tsx",
  "txt",
  "webmanifest",
  "xml",
  "yaml",
  "yml",
]);

export function isTextDiffable(file: ReleaseDiffFileInput) {
  if (file.sizeBytes !== null && file.sizeBytes > RELEASE_TEXT_DIFF_MAX_BYTES) return false;
  const mime = (file.mimeType ?? "").toLowerCase().split(";")[0]!.trim();
  if (mime.startsWith("text/")) return true;
  // Subtype or structured suffix only: "officedocument...xml.document" is a ZIP, not XML.
  if (/^[a-z]+\/(?:[a-z0-9.-]+\+)?(json|javascript|ecmascript|xml|yaml|x-yaml|markdown)$/.test(mime)) return true;
  // A specific non-text type wins over the extension (".ts" as video/mp2t).
  if (mime && mime !== "application/octet-stream") return false;
  const extension = file.path.toLowerCase().split(".").pop() ?? "";
  return TEXT_EXTENSIONS.has(extension);
}

export type TextDiffLine = {
  type: "context" | "added" | "removed";
  text: string;
  baseLine: number | null;
  targetLine: number | null;
};
export type TextDiffHunk = { lines: TextDiffLine[] };
export type TextDiffResult =
  | { kind: "text"; hunks: TextDiffHunk[]; added: number; removed: number; truncated: boolean }
  | { kind: "too_large" };

const MAX_DIFF_CELLS = 4_000_000;
const MAX_HUNK_LINES = 2_000;
const MAX_LINE_LENGTH = 2_000;

// Line diff with common prefix/suffix trimming and an LCS over the middle. Large
// rewrites past MAX_DIFF_CELLS report "too_large" instead of burning CPU.
export function diffTextLines(baseText: string, targetText: string, context = 3): TextDiffResult {
  const base = splitLines(baseText);
  const target = splitLines(targetText);
  let prefix = 0;
  while (prefix < base.length && prefix < target.length && base[prefix] === target[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < target.length - prefix &&
    base[base.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const baseMiddle = base.slice(prefix, base.length - suffix);
  const targetMiddle = target.slice(prefix, target.length - suffix);
  if ((baseMiddle.length + 1) * (targetMiddle.length + 1) > MAX_DIFF_CELLS) return { kind: "too_large" };

  type Op = { type: TextDiffLine["type"]; text: string; baseLine: number; targetLine: number };
  const ops: Op[] = [];
  for (let index = 0; index < prefix; index += 1) {
    ops.push({ type: "context", text: base[index]!, baseLine: index + 1, targetLine: index + 1 });
  }
  const rows = baseMiddle.length;
  const cols = targetMiddle.length;
  const table = new Uint32Array((rows + 1) * (cols + 1));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      table[row * (cols + 1) + col] =
        baseMiddle[row] === targetMiddle[col]
          ? table[(row + 1) * (cols + 1) + col + 1]! + 1
          : Math.max(table[(row + 1) * (cols + 1) + col]!, table[row * (cols + 1) + col + 1]!);
    }
  }
  let row = 0;
  let col = 0;
  while (row < rows || col < cols) {
    if (row < rows && col < cols && baseMiddle[row] === targetMiddle[col]) {
      ops.push({ type: "context", text: baseMiddle[row]!, baseLine: prefix + row + 1, targetLine: prefix + col + 1 });
      row += 1;
      col += 1;
    } else if (row < rows && (col >= cols || table[(row + 1) * (cols + 1) + col]! >= table[row * (cols + 1) + col + 1]!)) {
      // Removals before additions, like unified diff.
      ops.push({ type: "removed", text: baseMiddle[row]!, baseLine: prefix + row + 1, targetLine: prefix + col });
      row += 1;
    } else {
      ops.push({ type: "added", text: targetMiddle[col]!, baseLine: prefix + row, targetLine: prefix + col + 1 });
      col += 1;
    }
  }
  for (let index = 0; index < suffix; index += 1) {
    ops.push({
      type: "context",
      text: base[base.length - suffix + index]!,
      baseLine: base.length - suffix + index + 1,
      targetLine: target.length - suffix + index + 1,
    });
  }

  const hunks: TextDiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let emitted = 0;
  let truncated = false;
  let current: TextDiffHunk | null = null;
  let lastIncluded = -1;
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]!;
    if (op.type === "context") continue;
    if (op.type === "added") added += 1;
    else removed += 1;
    const start = Math.max(index - context, lastIncluded + 1);
    if (!current || start > lastIncluded + 1) {
      current = { lines: [] };
      hunks.push(current);
    }
    const end = Math.min(ops.length - 1, index + context);
    for (let cursor = start; cursor <= end; cursor += 1) {
      if (cursor <= lastIncluded) continue;
      // A later change inside this context window extends the hunk on its own turn.
      if (cursor > index && ops[cursor]!.type !== "context") break;
      if (emitted >= MAX_HUNK_LINES) {
        truncated = true;
        break;
      }
      const line = ops[cursor]!;
      current.lines.push({
        type: line.type,
        text: clipLine(line.text),
        baseLine: line.type === "added" ? null : line.baseLine,
        targetLine: line.type === "removed" ? null : line.targetLine,
      });
      emitted += 1;
      lastIncluded = cursor;
    }
    if (truncated) break;
  }
  if (truncated) {
    added = ops.filter((op) => op.type === "added").length;
    removed = ops.filter((op) => op.type === "removed").length;
  }
  return { kind: "text", hunks, added, removed, truncated };
}

function splitLines(text: string) {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function clipLine(text: string) {
  return text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text;
}
