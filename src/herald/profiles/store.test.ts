/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDatabaseSync, sqliteAvailable } from "../service/sqlite.js";
import { ProfileStore } from "./store.js";
import type { RegisterProfileInput } from "./types.js";

function makeStore(): ProfileStore {
  return new ProfileStore({ dbPath: ":memory:" });
}

const input = (over: Partial<RegisterProfileInput> = {}): RegisterProfileInput => ({
  profile: "march",
  repoName: "March",
  repoPath: "/home/u/Development/March",
  workerGroup: "march-workers",
  ...over,
});

describe.skipIf(!sqliteAvailable)("ProfileStore", () => {
  it("registers a profile and reads it back", () => {
    const store = makeStore();
    const rec = store.register(input({ conductorName: "march-legate-agent" }));
    expect(rec.profile).toBe("march");
    expect(rec.status).toBe("active");
    expect(rec.conductorName).toBe("march-legate-agent");
    expect(rec.createdAt).toBeTruthy();
    expect(store.get("march")).toMatchObject({ profile: "march", repoName: "March" });
    store.close();
  });

  it("upsert is idempotent and preserves createdAt while merging new fields", () => {
    const store = makeStore();
    const first = store.register(input());
    const second = store.register(input({ workerGroup: "renamed", broodEndpoint: "http://brood:9748" }));
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.workerGroup).toBe("renamed");
    expect(second.broodEndpoint).toBe("http://brood:9748");
    expect(store.count()).toBe(1);
    store.close();
  });

  it("list returns active profiles only by default; ?includeRemoved surfaces removed", () => {
    const store = makeStore();
    store.register(input({ profile: "a", repoName: "A", repoPath: "/a" }));
    store.register(input({ profile: "b", repoName: "B", repoPath: "/b" }));
    expect(store.list().map((p) => p.profile)).toEqual(["a", "b"]);
    store.remove("a");
    expect(store.list().map((p) => p.profile)).toEqual(["b"]);
    expect(store.list({ includeRemoved: true }).map((p) => p.profile)).toEqual(["a", "b"]);
    store.close();
  });

  it("remove soft-deletes; get hides it unless includeRemoved", () => {
    const store = makeStore();
    store.register(input({ profile: "a" }));
    const removed = store.remove("a");
    expect(removed?.status).toBe("removed");
    expect(store.get("a")).toBeUndefined();
    expect(store.get("a", { includeRemoved: true })?.status).toBe("removed");
    store.close();
  });

  it("re-registering a removed profile reactivates it and keeps the original createdAt", () => {
    const store = makeStore();
    const first = store.register(input({ profile: "a" }));
    store.remove("a");
    const back = store.register(input({ profile: "a" }));
    expect(back.status).toBe("active");
    expect(back.createdAt).toBe(first.createdAt);
    store.close();
  });

  it("remove on an unknown profile returns undefined", () => {
    const store = makeStore();
    expect(store.remove("ghost")).toBeUndefined();
    store.close();
  });

  it("round-trips a merge policy through register/get", () => {
    const store = makeStore();
    const policy = { byTaskType: { cut: { approval: false } } };
    const rec = store.register(input({ mergePolicy: policy }));
    expect(rec.mergePolicy).toEqual(policy);
    expect(store.get("march")?.mergePolicy).toEqual(policy);
    store.close();
  });

  it("a profile without a policy reads back as undefined (all-required)", () => {
    const store = makeStore();
    store.register(input());
    expect(store.get("march")?.mergePolicy).toBeUndefined();
    store.close();
  });

  it("a plain re-register preserves an existing merge policy", () => {
    const store = makeStore();
    const policy = { byTaskType: { cut: { approval: false } } };
    store.register(input({ mergePolicy: policy }));
    // Re-register without a policy (the `march legate init` shape).
    const back = store.register(input({ workerGroup: "renamed" }));
    expect(back.workerGroup).toBe("renamed");
    expect(back.mergePolicy).toEqual(policy);
    store.close();
  });

  it("round-trips a toolchain through register/get", () => {
    const store = makeStore();
    const rec = store.register(input({ toolchain: "jvm" }));
    expect(rec.toolchain).toBe("jvm");
    expect(store.get("march")?.toolchain).toBe("jvm");
    store.close();
  });

  it("a profile without a toolchain reads back as undefined (auto)", () => {
    const store = makeStore();
    store.register(input());
    expect(store.get("march")?.toolchain).toBeUndefined();
    store.close();
  });

  it("round-trips a priority through register/get (including 0)", () => {
    const store = makeStore();
    expect(store.register(input({ priority: 0 })).priority).toBe(0);
    expect(store.get("march")?.priority).toBe(0);
    store.close();
  });

  it("a profile without a priority reads back as undefined (default)", () => {
    const store = makeStore();
    store.register(input());
    expect(store.get("march")?.priority).toBeUndefined();
    store.close();
  });

  it("a plain re-register preserves an existing priority", () => {
    const store = makeStore();
    store.register(input({ priority: 2 }));
    const back = store.register(input({ workerGroup: "renamed" }));
    expect(back.workerGroup).toBe("renamed");
    expect(back.priority).toBe(2);
    store.close();
  });

  it("a plain re-register preserves an existing toolchain", () => {
    const store = makeStore();
    store.register(input({ toolchain: "jvm" }));
    const back = store.register(input({ workerGroup: "renamed" }));
    expect(back.workerGroup).toBe("renamed");
    expect(back.toolchain).toBe("jvm");
    store.close();
  });
});

describe.skipIf(!sqliteAvailable)("ProfileStore migration", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function v1DbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-mig-"));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, "profiles.db");
    const DatabaseSync = getDatabaseSync();
    const db = new DatabaseSync(dbPath);
    // Recreate the v1 schema: no merge_policy column, version pinned to 1.
    db.exec(`
      CREATE TABLE profiles (
        profile        TEXT PRIMARY KEY,
        repo_name      TEXT NOT NULL,
        repo_path      TEXT NOT NULL,
        worker_group   TEXT NOT NULL,
        conductor_name TEXT,
        brood_endpoint TEXT,
        march_cli_path TEXT,
        mode           TEXT,
        status         TEXT NOT NULL DEFAULT 'active',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE TABLE profile_schema_meta (version INTEGER NOT NULL);
      INSERT INTO profile_schema_meta (version) VALUES (1);
      INSERT INTO profiles (profile, repo_name, repo_path, worker_group, status, created_at, updated_at)
        VALUES ('legacy', 'Legacy', '/legacy', 'legacy-workers', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    db.close();
    return dbPath;
  }

  it("upgrades a v1 DB: adds merge_policy, preserves existing rows", () => {
    const dbPath = v1DbPath();
    const store = new ProfileStore({ dbPath });
    const legacy = store.get("legacy");
    expect(legacy?.repoName).toBe("Legacy");
    expect(legacy?.mergePolicy).toBeUndefined();
    // The new column is writable post-migration.
    const policy = { byTaskType: { cut: { approval: false } } };
    store.register({
      profile: "legacy",
      repoName: "Legacy",
      repoPath: "/legacy",
      workerGroup: "legacy-workers",
      mergePolicy: policy,
    });
    expect(store.get("legacy")?.mergePolicy).toEqual(policy);
    store.close();
    // Re-opening the same file is a no-op migration (version already 2).
    const reopened = new ProfileStore({ dbPath });
    expect(reopened.get("legacy")?.mergePolicy).toEqual(policy);
    reopened.close();
  });

  function v2DbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-mig-"));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, "profiles.db");
    const DatabaseSync = getDatabaseSync();
    const db = new DatabaseSync(dbPath);
    // Recreate the v2 schema: has merge_policy but no toolchain, version 2.
    db.exec(`
      CREATE TABLE profiles (
        profile        TEXT PRIMARY KEY,
        repo_name      TEXT NOT NULL,
        repo_path      TEXT NOT NULL,
        worker_group   TEXT NOT NULL,
        conductor_name TEXT,
        brood_endpoint TEXT,
        march_cli_path TEXT,
        mode           TEXT,
        merge_policy   TEXT,
        status         TEXT NOT NULL DEFAULT 'active',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE TABLE profile_schema_meta (version INTEGER NOT NULL);
      INSERT INTO profile_schema_meta (version) VALUES (2);
      INSERT INTO profiles (profile, repo_name, repo_path, worker_group, status, created_at, updated_at)
        VALUES ('legacy', 'Legacy', '/legacy', 'legacy-workers', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    db.close();
    return dbPath;
  }

  it("upgrades a v2 DB: adds toolchain, preserves existing rows", () => {
    const dbPath = v2DbPath();
    const store = new ProfileStore({ dbPath });
    const legacy = store.get("legacy");
    expect(legacy?.repoName).toBe("Legacy");
    expect(legacy?.toolchain).toBeUndefined();
    // The new column is writable post-migration.
    store.register({
      profile: "legacy",
      repoName: "Legacy",
      repoPath: "/legacy",
      workerGroup: "legacy-workers",
      toolchain: "jvm",
    });
    expect(store.get("legacy")?.toolchain).toBe("jvm");
    store.close();
    const reopened = new ProfileStore({ dbPath });
    expect(reopened.get("legacy")?.toolchain).toBe("jvm");
    reopened.close();
  });
});
