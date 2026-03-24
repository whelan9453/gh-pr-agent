import { describe, expect, it } from "vitest";

import { buildNumberedContext, buildNumberedPatch, truncateText } from "../src/diff-line-mapper.js";

describe("buildNumberedPatch", () => {
  it("maps new lines and changed lines", () => {
    const patch = `@@ -1,3 +1,4 @@
 line one
 line two
 line three
+line four`;
    const result = buildNumberedPatch(patch);
    expect(result.numberedPatch).toContain("[new:1]  line one");
    expect(result.numberedPatch).toContain("[new:4] +line four");
    expect(result.validNewLines).toEqual(new Set([1, 2, 3, 4]));
    expect(result.changedNewLines).toEqual(new Set([4]));
  });
});

describe("buildNumberedContext", () => {
  it("renders nearby lines", () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = buildNumberedContext(content, [10], 1);
    expect(result.context).toContain("    9 | line 9");
    expect(result.context).toContain("   10 | line 10");
    expect(result.context).toContain("   11 | line 11");
  });
});

describe("truncateText", () => {
  it("marks truncation", () => {
    const result = truncateText("abcdef", 3, "patch");
    expect(result.truncated).toBe(true);
    expect(result.context).toContain("[truncated patch]");
  });
});
