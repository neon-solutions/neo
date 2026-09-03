import { NeoError } from "./errors";

export type FileEdit = {
  oldText: string;
  newText: string;
};

type Range = {
  start: number;
  end: number;
  newText: string;
};

export function applyEdits(content: string, edits: FileEdit[]): string {
  if (edits.length === 0) {
    throw new NeoError("neo: edit requires at least one replacement");
  }

  const ranges: Range[] = [];
  for (const edit of edits) {
    if (edit.oldText.length === 0) {
      throw new NeoError("neo: edit oldText must not be empty");
    }
    const start = content.indexOf(edit.oldText);
    if (start === -1) {
      throw new NeoError("neo: edit oldText not found");
    }
    const second = content.indexOf(edit.oldText, start + 1);
    if (second !== -1) {
      throw new NeoError("neo: edit oldText is not unique");
    }
    ranges.push({ start, end: start + edit.oldText.length, newText: edit.newText });
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1];
    const current = ranges[i];
    if (prev === undefined || current === undefined) {
      continue;
    }
    if (current.start < prev.end) {
      throw new NeoError("neo: edit replacements overlap");
    }
  }

  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += content.slice(cursor, range.start);
    out += range.newText;
    cursor = range.end;
  }
  out += content.slice(cursor);
  return out;
}
