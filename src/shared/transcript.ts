import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { asFields, type Fields } from "./json.ts";

/**
 * The JSON entries in the last `bytes` of a JSONL file. A line cut at the start of the window, or a
 * partial last line still being written, is skipped.
 */
export function readTail(path: string, bytes: number): Fields[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((line) => parseLine(line));
  } finally {
    closeSync(fd);
  }
}

function parseLine(line: string): Fields[] {
  if (line.trim() === "") return [];
  try {
    const entry = asFields(JSON.parse(line));
    return entry === undefined ? [] : [entry];
  } catch {
    return []; // a partial line: the next read has it whole
  }
}
