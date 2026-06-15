import fs from "node:fs";
import path from "node:path";

/**
 * Shared JSON/JSONL persistence helpers. The point is uniform durability: every
 * full-file writer goes through writeJsonFileAtomic (tmp + rename) so a crash
 * mid-write can never truncate a live file, and every append goes through
 * appendJsonl (open + fsync) so an audit line survives a power loss immediately.
 * The read helpers mirror the stores' existing "return a fallback on any error"
 * shape so a corrupt file degrades gracefully instead of crashing startup.
 */

/** Read + parse a JSON file, returning the fallback on any error (missing file,
 * unreadable, or malformed JSON). Mirrors each store's existing try/catch-default. */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write a value as pretty JSON atomically: serialize to `${file}.tmp`, then
 * rename onto `file` (atomic on the same filesystem). Creates the parent dir if
 * needed. A crash before the rename leaves the previous file fully intact. */
export function writeJsonFileAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** Read a .jsonl file, parsing each non-empty line. Returns the parsed records
 * and a count of malformed lines dropped (e.g. a truncated final line from a
 * process killed mid-append). Returns an empty result if the file is missing. */
export function readJsonl<T>(file: string): { records: T[]; dropped: number } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { records: [], dropped: 0 };
  }
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const records: T[] = [];
  let dropped = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      dropped += 1;
    }
  }
  return { records, dropped };
}

/** Append one JSON line to a .jsonl file with an fsync for durability — open +
 * write + fsync + close so the line survives a crash immediately after the
 * append (a plain appendFileSync can leave it buffered in the OS). Throws on I/O
 * error; best-effort call sites wrap this in try/catch. */
export function appendJsonl(file: string, record: unknown): void {
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
