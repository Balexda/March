/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  createPostgresSessionRepository,
  createSessionRepository,
} from "./repository.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";

describe("createSessionRepository", () => {
  // The sqlite backend needs node:sqlite (Node >= 22.5); the rest of the seam
  // (selection + the not-yet-implemented backend) is exercised regardless.
  describe.skipIf(!sqliteAvailable)("sqlite backend", () => {
    it("defaults to the sqlite backend", () => {
      const repo = createSessionRepository({ dbPath: ":memory:" });
      expect(repo).toBeInstanceOf(SessionStore);
      repo.close();
    });

    it("builds the sqlite backend when selected explicitly", () => {
      const repo = createSessionRepository({
        backend: "sqlite",
        dbPath: ":memory:",
      });
      const rec = repo.register({ id: "s1", kind: "spawn" });
      expect(rec.id).toBe("s1");
      expect(repo.get("s1")?.kind).toBe("spawn");
      repo.close();
    });
  });

  it("throws a clear error for the not-yet-implemented postgres backend", () => {
    expect(() => createSessionRepository({ backend: "postgres" })).toThrow(
      /not implemented yet/i,
    );
    expect(() =>
      createPostgresSessionRepository({ backend: "postgres" }),
    ).toThrow(/not implemented yet/i);
  });
});
