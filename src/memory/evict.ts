/**
 * R11 deterministic eviction fallback (spec memory/deterministic-loop).
 *
 * When the LLM curator fails to consolidate a store back under cap within
 * `consolidationMaxAttempts`, the runtime MUST NOT freeze memory silently. It
 * evicts the OLDEST `## Diário` rows FIFO (by absolute date, R16 provenance)
 * until the projected write fits, then lets the write proceed and emits an
 * `R11:evicted` counter so a churning store is observable.
 *
 * Eviction is bounded and structure-scoped: it only ever removes data rows from
 * the Diário table. If a store has no Diário table (nothing safe to evict), the
 * caller keeps the honest terminal outcome rather than corrupting the index.
 */

const DIARY_HEADING_RE = /^#{1,6}\s+Di[aá]rio\b.*$/im;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

export interface EvictionResult {
  /** Content with oldest Diário rows removed (original order preserved). */
  content: string;
  /** How many data rows were evicted. */
  evictedRows: number;
  /** Characters freed by the eviction (including row newlines). */
  freedChars: number;
}

interface DiaryTable {
  /** Index in `lines` of the first data row. */
  dataStart: number;
  /** Index in `lines` just past the last data row. */
  dataEnd: number;
}

/**
 * Evict the oldest Diário data rows until at least `needChars` are freed.
 *
 * Rows are ordered oldest-first by their absolute date column (deterministic
 * regardless of append order); rows without a parseable date are treated as
 * oldest so a malformed row is a first eviction candidate, never a sticky one.
 * The table header + separator rows are always preserved. Returns
 * `evictedRows: 0` unchanged when there is no Diário table or no data rows.
 */
export function evictOldestDiaryRows(currentContent: string, needChars: number): EvictionResult {
  if (needChars <= 0 || !currentContent) {
    return { content: currentContent, evictedRows: 0, freedChars: 0 };
  }

  const lines = currentContent.split("\n");
  const table = locateDiaryTable(lines);
  if (!table) {
    return { content: currentContent, evictedRows: 0, freedChars: 0 };
  }

  const dataRows: Array<{ index: number; date: string; chars: number }> = [];
  for (let i = table.dataStart; i < table.dataEnd; i += 1) {
    const line = lines[i]!;
    const dateMatch = line.match(ISO_DATE_RE);
    dataRows.push({
      index: i,
      // Rows with no date sort oldest ("") so they are evicted first.
      date: dateMatch ? dateMatch[0] : "",
      chars: line.length + 1, // +1 for the newline the row occupies
    });
  }
  if (dataRows.length === 0) {
    return { content: currentContent, evictedRows: 0, freedChars: 0 };
  }

  const byOldest = [...dataRows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.index - b.index));

  const evictIndices = new Set<number>();
  let freedChars = 0;
  for (const row of byOldest) {
    if (freedChars >= needChars) break;
    evictIndices.add(row.index);
    freedChars += row.chars;
  }

  if (evictIndices.size === 0) {
    return { content: currentContent, evictedRows: 0, freedChars: 0 };
  }

  const kept = lines.filter((_, idx) => !evictIndices.has(idx));
  return {
    content: kept.join("\n"),
    evictedRows: evictIndices.size,
    freedChars,
  };
}

/**
 * Locate the Diário table's data-row span. The table starts at the first `|`
 * row after the heading; the header row and the `|---|` separator row are NOT
 * data and are excluded from the evictable span.
 */
function locateDiaryTable(lines: string[]): DiaryTable | null {
  const headingIdx = lines.findIndex((l) => DIARY_HEADING_RE.test(l));
  if (headingIdx === -1) {
    return null;
  }

  let cursor = headingIdx + 1;
  // Skip blank lines between heading and the table.
  while (cursor < lines.length && lines[cursor]!.trim() === "") {
    cursor += 1;
  }
  // Expect a markdown table header row.
  if (cursor >= lines.length || !isTableRow(lines[cursor]!)) {
    return null;
  }
  const headerIdx = cursor;
  const separatorIdx = headerIdx + 1;
  if (separatorIdx >= lines.length || !isSeparatorRow(lines[separatorIdx]!)) {
    return null;
  }

  const dataStart = separatorIdx + 1;
  let dataEnd = dataStart;
  while (dataEnd < lines.length && isTableRow(lines[dataEnd]!)) {
    dataEnd += 1;
  }
  if (dataEnd === dataStart) {
    return null;
  }
  return { dataStart, dataEnd };
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && /^[|\s:-]+$/.test(trimmed) && trimmed.includes("-");
}
