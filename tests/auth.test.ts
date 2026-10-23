import { describe, expect, it } from "vitest";
import { derivePassword, hashPassword, verifyPassword } from "../src/worker/auth";

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.iterations).toBe(100_000);
    expect(await verifyPassword("correct horse battery staple", stored.hash, stored.salt, stored.iterations)).toBe(
      true,
    );
    expect(await verifyPassword("wrong password", stored.hash, stored.salt, stored.iterations)).toBe(
      false,
    );
  });

  it("uses a unique salt for each hash", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
  });

  it("is deterministic for a given salt and iteration count", async () => {
    const stored = await hashPassword("deterministic");
    expect(await derivePassword("deterministic", stored.salt, stored.iterations)).toBe(stored.hash);
  });
});
