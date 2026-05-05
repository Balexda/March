import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FINDER_BIN } from "./deps.js";

const CLI_PATH = resolve(import.meta.dirname, "../dist/cli.js");

// Absolute path to the finder binary (which on Unix, where on Windows) —
// used to build isolated test PATHs.
const FINDER_PATH = execFileSync(FINDER_BIN, [FINDER_BIN], {
  encoding: "utf-8",
}).trim();

function run(
  args: string[],
  options?: { env?: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      env: options?.env,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; status: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

describe("march CLI", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-cli-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  /**
   * Runs the CLI with a fully controlled environment. Uses `spawnSync` instead
   * of `execFileSync` so both stdout and stderr are captured regardless of
   * exit code.
   */
  function runWithEnv(
    args: string[],
    env: Record<string, string | undefined>,
    options?: { cwd?: string },
  ): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      ...(options?.cwd ? { cwd: options.cwd } : {}),
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  }

  /**
   * Creates a temporary bin directory containing a symlink to the finder
   * binary (which/where) plus optional stub executables for each name in
   * `stubs`. Returns the bin directory path — the parent tmpdir is tracked
   * for cleanup in afterEach.
   */
  function makeFakeBin(stubs: string[] = []): string {
    const fakeBin = path.join(makeTmpDir(), "bin");
    fs.mkdirSync(fakeBin);
    // Always include the finder binary so isFinderAvailable() returns true.
    fs.symlinkSync(FINDER_PATH, path.join(fakeBin, path.basename(FINDER_PATH)));
    for (const name of stubs) {
      const stub = path.join(fakeBin, name);
      fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(stub, 0o755);
    }
    return fakeBin;
  }

  it("march init runs successfully on clean home", () => {
    const tmpDir = makeTmpDir();
    const result = run(["init"], {
      env: { ...process.env, HOME: tmpDir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("initialized successfully");
  });

  it("march with no args exits 2 with usage", () => {
    const result = run([]);
    expect(result.exitCode).toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/usage|Usage/i);
    // AS 4.1: no-args output lists all five registered commands (two-tier listing).
    // Match command-list entries (leading whitespace + command name as first word)
    // to avoid false positives from --help/--version in the Options section.
    for (const cmd of ["init", "update", "help", "version", "spawn"]) {
      expect(combined).toMatch(new RegExp(`^\\s+${cmd}\\b`, "m"));
    }
  });

  it("march with unknown command exits 2 with error and valid commands", () => {
    const result = run(["nonexistent"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nonexistent");
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("init");
  });

  it("--yes flag is accepted without error", () => {
    // With --yes but no command, should still exit 2 (no command given)
    const result = run(["--yes"]);
    expect(result.exitCode).toBe(2);
    // Should not contain any error about unknown option
    expect(result.stderr).not.toContain("unknown option");
  });

  it("march --version prints 0.1.0", () => {
    const result = run(["--version"]);
    expect(result.stdout).toContain("0.1.0");
  });

  it("march version exits 0 and stdout contains the package version", () => {
    const result = run(["version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("0.1.0");
  });

  it("march version stdout is byte-for-byte identical to march --version stdout", () => {
    const versionSubcommand = run(["version"]);
    const versionFlag = run(["--version"]);
    expect(versionFlag.exitCode).toBe(0);
    expect(versionSubcommand.stdout).toBe(versionFlag.stdout);
  });

  it("march help exits 0 and stdout lists init, version, and help", () => {
    const result = run(["help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("version");
    expect(result.stdout).toContain("help");
  });

  it("march help stdout is byte-for-byte identical to march --help stdout", () => {
    const helpSubcommand = run(["help"]);
    const helpFlag = run(["--help"]);
    expect(helpFlag.exitCode).toBe(0);
    expect(helpSubcommand.stdout).toBe(helpFlag.stdout);
  });

  it("march help init exits 0 and stdout contains init-specific help text", () => {
    const result = run(["help", "init"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init");
  });

  it("march help version exits 0 and stdout contains version-specific help text", () => {
    const result = run(["help", "version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("version");
  });

  it("march help nonexistent exits 2", () => {
    const result = run(["help", "nonexistent"]);
    expect(result.exitCode).toBe(2);
  });

  it("march init --help exits 0 and stdout contains init and its description", () => {
    const result = run(["init", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("Initialize");
  });

  it("march update --help exits 0 and stdout contains update", () => {
    const result = run(["update", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("update");
  });

  it("march version --help exits 0 and stdout contains version", () => {
    const result = run(["version", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("version");
  });

  it("march help --help exits 0 and stdout contains help", () => {
    const result = run(["help", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("help");
  });

  it("march spawn --help exits 0 and stdout contains spawn", () => {
    const result = run(["spawn", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("spawn");
  });

  // --- spawn dispatch dependency validation (Story 2 acceptance scenarios) ---

  it("spawn dispatch: git missing — exit 1, stderr contains 'git not found', no Docker error", () => {
    const fakeBin = makeFakeBin(); // which only, no git or docker
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git not found");
    expect(result.stderr).not.toContain("Docker");
  });

  it("spawn dispatch: docker missing — exit 1, stderr contains 'Docker not found'", () => {
    const fakeBin = makeFakeBin(["git"]); // git only, no docker
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, fakeBin].join(path.delimiter),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Docker not found");
  });

  it("spawn dispatch: not in a git repo — exit 1, stderr contains 'Not inside a git repository'", () => {
    // Smart git stub: fails on `rev-parse` (simulates being outside a repo),
    // succeeds for other git commands so isOnPath("git") passes.
    const tmpDir = makeTmpDir();
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    const gitStub = path.join(binDir, "git");
    fs.writeFileSync(
      gitStub,
      '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then\n  exit 128\nfi\nexit 0\n',
    );
    fs.chmodSync(gitStub, 0o755);
    const dockerStub = path.join(binDir, "docker");
    fs.writeFileSync(dockerStub, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(dockerStub, 0o755);

    const nodeBinDir = path.dirname(process.execPath);
    // Create a temp dir outside any git repo.
    const nonRepoDir = makeTmpDir();
    const result = runWithEnv(
      ["spawn", "dispatch"],
      { PATH: [nodeBinDir, binDir].join(path.delimiter) },
      { cwd: nonRepoDir },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Not inside a git repository");
  });

  it("spawn dispatch: base image unavailable — exit 1, stderr identifies the image name", () => {
    // Docker stub that fails on `image inspect` and `pull` subcommands.
    const fakeBin = makeTmpDir();
    const binDir = path.join(fakeBin, "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    // Simple git stub.
    const gitStub = path.join(binDir, "git");
    fs.writeFileSync(gitStub, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(gitStub, 0o755);
    // Smart docker stub: fails on `image` and `pull`, succeeds otherwise.
    const dockerStub = path.join(binDir, "docker");
    fs.writeFileSync(
      dockerStub,
      '#!/bin/sh\nif [ "$1" = "image" ] || [ "$1" = "pull" ]; then\n  exit 1\nfi\nexit 0\n',
    );
    fs.chmodSync(dockerStub, 0o755);

    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(["spawn", "dispatch"], {
      PATH: [nodeBinDir, binDir].join(path.delimiter),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("march-base:latest");
  });

  // --- spawn dispatch worktree + initial SpawnRecord (Story 3) ---

  /**
   * Initializes a real git repo in a fresh tmp dir and returns its
   * absolute path. The repo has a single committed file so HEAD is
   * resolvable and `git worktree add` has something to check out.
   *
   * The repo is nested one level inside a tmp parent so the worktree
   * sibling (`<parent>/worktrees/march/`) stays isolated per test.
   */
  function makeRealRepo(): string {
    const parent = makeTmpDir();
    const repoRoot = path.join(parent, "repo");
    fs.mkdirSync(repoRoot);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot, env });
    fs.writeFileSync(path.join(repoRoot, "README.md"), "hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot, env });
    // Disable GPG signing explicitly so the test commit does not depend
    // on a signing key in the host environment.
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"],
      { cwd: repoRoot, env },
    );
    return repoRoot;
  }

  /**
   * Builds a bin dir containing a smart docker stub (succeeds on `image
   * inspect`) plus a finder symlink, keeping the real git on PATH. The
   * bin dir comes first in PATH so the docker stub wins over any system
   * docker, while git is resolved by fall-through to the inherited PATH.
   */
  function makeDockerStubBinDir(): string {
    const binDir = path.join(makeTmpDir(), "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    const dockerStub = path.join(binDir, "docker");
    // Succeeds for every subcommand, including `image inspect`, `pull`,
    // and `build`, so checkSpawnDependencies' base-image check passes
    // and the snapshot/build stage in dispatch returns success.
    fs.writeFileSync(dockerStub, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(dockerStub, 0o755);
    return binDir;
  }

  /**
   * Builds a bin dir containing a docker stub that succeeds on every
   * subcommand EXCEPT `build` (which exits 1). Used to simulate a docker
   * build failure during dispatch so tests can exercise the Story 4
   * rollback path: SpawnRecord transitions to "failed" and is preserved
   * on disk while the worktree, branch, and any partially tagged image
   * are cleaned up.
   */
  function makeDockerBuildFailBinDir(): string {
    const binDir = path.join(makeTmpDir(), "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    const dockerStub = path.join(binDir, "docker");
    fs.writeFileSync(
      dockerStub,
      '#!/bin/sh\nif [ "$1" = "build" ]; then\n  echo "simulated build failure" >&2\n  exit 1\nfi\nexit 0\n',
    );
    fs.chmodSync(dockerStub, 0o755);
    return binDir;
  }

  it("spawn dispatch: success path creates branch, worktree, and SpawnRecord", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const dockerStubDir = makeDockerStubBinDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      ["spawn", "dispatch"],
      {
        // Docker stub first, then real PATH for git.
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
      },
      { cwd: repoRoot },
    );

    // No dependency-validation errors on stderr.
    expect(result.stderr).not.toContain("not found");
    expect(result.stderr).not.toContain("Not inside a git repository");
    expect(result.stderr).not.toContain("march-base:latest");
    // Dispatch continues to the placeholder stub after worktree + record
    // creation; the stub sets exit code 1 with its message on stdout.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("march spawn is not yet implemented");

    // Exactly one march/spawn/* branch was created in the source repo.
    // `git branch --list` prefixes the current branch with "* " and any
    // branch checked out in a linked worktree with "+ ", so we use
    // for-each-ref for a clean machine-readable listing.
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(branches).toHaveLength(1);
    const branch = branches[0];
    expect(branch).toMatch(/^march\/spawn\/\d{8}-[0-9a-f]{6}$/);

    // Sibling worktree directory exists at <repo>/../worktrees/march/<id>.
    const spawnId = branch.replace("march/spawn/", "");
    const worktreePath = path.join(
      path.dirname(repoRoot),
      "worktrees",
      "march",
      spawnId,
    );
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, "README.md"))).toBe(true);

    // Initial SpawnRecord file exists and validates against the data model
    // for the `"created"` state.
    const recordPath = path.join(
      home,
      ".march",
      "spawns",
      `${spawnId}.json`,
    );
    expect(fs.existsSync(recordPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    expect(record.version).toBe(1);
    expect(record.id).toBe(spawnId);
    expect(record.repoPath).toBe(repoRoot);
    expect(record.branch).toBe(branch);
    expect(record.worktreePath).toBe(worktreePath);
    expect(record.backend).toBe("claude-code");
    expect(record.status).toBe("created");
    expect(record.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // Story 4: imageId is populated by the snapshot/build stage on the
    // success path. Status remains "created" — Story 7 owns transitions
    // out of "created" to "running" / "stopped".
    expect(record.imageId).toBe(`march-spawn-${spawnId}`);
    // Other conditional fields are still absent at this state.
    expect(record.containerId).toBeUndefined();
    expect(record.startedAt).toBeUndefined();
    expect(record.exitCode).toBeUndefined();
    expect(record.stoppedAt).toBeUndefined();
  });

  it("spawn dispatch: docker build failure transitions SpawnRecord to failed and cleans up worktree+branch+image", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    // Docker stub that succeeds on `image inspect` / `pull` (so the
    // dependency check passes) but fails on `build` so the Story 4
    // snapshot+build stage exercises its failure path.
    const dockerStubDir = makeDockerBuildFailBinDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      ["spawn", "dispatch"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
      },
      { cwd: repoRoot },
    );

    // Build failure → exit 1 with a clear stderr message surfacing the
    // docker stderr tail.
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    // End-to-end check that the docker stderr tail surfaces through
    // BuildError.message to the operator-facing stream — locks Task 2's
    // "message includes the docker stderr tail so operators can diagnose"
    // acceptance criterion as integration-tested.
    expect(result.stderr).toContain("simulated build failure");

    // No residual march/spawn/* branch — the rollback must delete it via
    // removeSpawnWorktree.
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(branches.trim()).toBe("");

    // No residual worktree directory under <parent>/worktrees/march/.
    const worktreeParent = path.join(
      path.dirname(repoRoot),
      "worktrees",
      "march",
    );
    const leftover =
      fs.existsSync(worktreeParent) && fs.readdirSync(worktreeParent);
    expect(!leftover || leftover.length === 0).toBe(true);

    // The SpawnRecord file IS preserved on disk per the data-model
    // `created → failed` transition and the contracts' "stage 7 Record
    // runs unconditionally" rule. Status is "failed" and stoppedAt is
    // populated.
    const spawnsDir = path.join(home, ".march", "spawns");
    expect(fs.existsSync(spawnsDir)).toBe(true);
    const recordFiles = fs
      .readdirSync(spawnsDir)
      .filter((f) => f.endsWith(".json"));
    expect(recordFiles).toHaveLength(1);
    const record = JSON.parse(
      fs.readFileSync(path.join(spawnsDir, recordFiles[0]), "utf-8"),
    );
    expect(record.status).toBe("failed");
    expect(record.stoppedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // The Story 3 fields the initial write populated must still be
    // intact on the failed record.
    expect(record.version).toBe(1);
    expect(record.id).toBe(recordFiles[0].replace(/\.json$/, ""));
    expect(record.repoPath).toBe(repoRoot);
    expect(record.branch).toBe(`march/spawn/${record.id}`);
    expect(record.backend).toBe("claude-code");
    // imageId must NOT be populated — the build failed before
    // updateSpawnRecordImageId ran.
    expect(record.imageId).toBeUndefined();
  });

  it("spawn dispatch: worktree creation failure rolls back branch and leaves no SpawnRecord", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const dockerStubDir = makeDockerStubBinDir();
    const nodeBinDir = path.dirname(process.execPath);

    // Force `git worktree add` to fail AFTER creating the branch by
    // installing a post-checkout hook that always exits 1. Per git's
    // documented behavior the hook's exit status becomes the operation's
    // exit status, so this is a permission-independent way to exercise
    // the rollback path (important when tests run as root).
    const hookPath = path.join(repoRoot, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hookPath, 0o755);

    const result = runWithEnv(
      ["spawn", "dispatch"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
      },
      { cwd: repoRoot },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);

    // No residual march/spawn/* branch (ref should be rolled back).
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(branches.trim()).toBe("");

    // No residual worktree directory under <parent>/worktrees/march/.
    const worktreeParent = path.join(
      path.dirname(repoRoot),
      "worktrees",
      "march",
    );
    const leftover =
      fs.existsSync(worktreeParent) && fs.readdirSync(worktreeParent);
    expect(!leftover || leftover.length === 0).toBe(true);

    // No SpawnRecord file in the isolated HOME.
    const spawnsDir = path.join(home, ".march", "spawns");
    const hasAnyRecord =
      fs.existsSync(spawnsDir) &&
      fs.readdirSync(spawnsDir).some((f) => f.endsWith(".json"));
    expect(hasAnyRecord).toBe(false);
  });

  it("spawn dispatch: SpawnRecord write failure rolls back worktree and branch", () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    // Pre-create `<home>/.march` as a regular file so writing the record
    // under `<home>/.march/spawns/` fails (ENOTDIR on mkdir), while the
    // worktree step — which runs first — succeeds.
    fs.writeFileSync(path.join(home, ".march"), "not a dir");

    const dockerStubDir = makeDockerStubBinDir();
    const nodeBinDir = path.dirname(process.execPath);
    const result = runWithEnv(
      ["spawn", "dispatch"],
      {
        PATH: [nodeBinDir, dockerStubDir, process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        HOME: home,
      },
      { cwd: repoRoot },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);

    // No residual march/spawn/* branch — record-write failure rolls back
    // the worktree and branch.
    const branches = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/march/spawn/"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(branches.trim()).toBe("");

    // No sibling worktree directory either.
    const worktreeParent = path.join(
      path.dirname(repoRoot),
      "worktrees",
      "march",
    );
    const leftover =
      fs.existsSync(worktreeParent) && fs.readdirSync(worktreeParent);
    expect(!leftover || leftover.length === 0).toBe(true);
  });
});
