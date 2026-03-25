import { describe, expect, it } from "vitest";

import { buildWalkthroughOrder } from "../src/walkthrough-order.js";

describe("buildWalkthroughOrder", () => {
  it("returns an empty array for empty input", () => {
    expect(buildWalkthroughOrder([])).toEqual([]);
  });

  it("returns a single file unchanged", () => {
    expect(buildWalkthroughOrder(["src/app.ts"])).toEqual(["src/app.ts"]);
  });

  it("puts types files before domain/service files", () => {
    const files = ["src/services/user.ts", "src/types.ts"];
    const order = buildWalkthroughOrder(files);
    expect(order.indexOf("src/types.ts")).toBeLessThan(
      order.indexOf("src/services/user.ts")
    );
  });

  it("puts domain/service files before ui/component files", () => {
    const files = ["src/components/Button.tsx", "src/services/auth.ts"];
    const order = buildWalkthroughOrder(files);
    expect(order.indexOf("src/services/auth.ts")).toBeLessThan(
      order.indexOf("src/components/Button.tsx")
    );
  });

  it("puts test files near the end", () => {
    // format.test.ts lives in a top-level __tests__ dir (not inside a service dir),
    // so it only matches the tests category and not the domain/service/utils category.
    const files = [
      "__tests__/format.test.ts",
      "src/utils/format.ts",
      "src/types/index.ts"
    ];
    const order = buildWalkthroughOrder(files);
    expect(order.indexOf("__tests__/format.test.ts")).toBeGreaterThan(
      order.indexOf("src/utils/format.ts")
    );
  });

  it("puts config/tooling files after tests", () => {
    const files = [
      "jest.config.ts",
      "src/utils/format.test.ts",
      "src/services/api.ts"
    ];
    const order = buildWalkthroughOrder(files);
    expect(order.indexOf("jest.config.ts")).toBeGreaterThan(
      order.indexOf("src/utils/format.test.ts")
    );
  });

  it("preserves relative order of files in the same category", () => {
    const files = ["src/services/a.ts", "src/services/b.ts", "src/services/c.ts"];
    const order = buildWalkthroughOrder(files);
    expect(order).toEqual(["src/services/a.ts", "src/services/b.ts", "src/services/c.ts"]);
  });

  it("handles spec files as tests", () => {
    // foo.spec.ts at src root level (not inside a services dir) — only matches tests category
    const files = ["src/foo.spec.ts", "src/services/foo.ts"];
    const order = buildWalkthroughOrder(files);
    expect(order.indexOf("src/services/foo.ts")).toBeLessThan(
      order.indexOf("src/foo.spec.ts")
    );
  });

  it("handles unknown files — places them after known categories", () => {
    const files = ["README.md", "src/types.ts"];
    const order = buildWalkthroughOrder(files);
    expect(order.indexOf("src/types.ts")).toBeLessThan(order.indexOf("README.md"));
  });
});
