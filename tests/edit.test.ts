import { expect, test } from "vitest";
import { applyEdits } from "../src/lib/edit";
import { NeoError } from "../src/lib/errors";

test("applyEdits replaces unique non-overlapping spans on the original text", () => {
  expect(
    applyEdits("alpha beta gamma", [
      { oldText: "alpha", newText: "A" },
      { oldText: "gamma", newText: "C" },
    ]),
  ).toBe("A beta C");
});

test("applyEdits allows deleting a unique span", () => {
  expect(applyEdits("keep gone keep", [{ oldText: " gone", newText: "" }])).toBe("keep keep");
});

test("applyEdits rejects missing, duplicate, empty, overlapping, and empty-list edits", () => {
  expect(() => applyEdits("abc", [{ oldText: "z", newText: "y" }])).toThrow(NeoError);
  expect(() => applyEdits("abcabc", [{ oldText: "abc", newText: "x" }])).toThrow(/not unique/);
  expect(() => applyEdits("abc", [{ oldText: "", newText: "x" }])).toThrow(/empty/);
  expect(() =>
    applyEdits("abcdef", [
      { oldText: "bcd", newText: "X" },
      { oldText: "cde", newText: "Y" },
    ]),
  ).toThrow(/overlap/);
  expect(() => applyEdits("abc", [])).toThrow(/at least one/);
});
