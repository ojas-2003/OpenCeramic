import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("runs vitest with the @/ alias configured", async () => {
    const { inngest } = await import("@/inngest/client");
    expect(inngest.id).toBe("openceramic");
  });
});
