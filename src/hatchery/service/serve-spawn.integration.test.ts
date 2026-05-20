import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FINDER_BIN } from "../../shared/deps.js";
import { buildServer } from "./server.js";
import { buildServer as buildCastraServer } from "../../castra/server.js";
import { createAgentDeckAdapter } from "../../castra/adapter.js";
import type { FastifyInstance } from "fastify";

// Service-layer integration: drive the hatchery service with the REAL worker
// executor (the worker re-loads dist/cli.js via MARCH_HATCHERY_WORKER_ENTRY and
// runs runHatcherySpawn) against docker stubs and a REAL in-process Castra
// server whose agent-deck adapter shells out to an agent-deck stub. This
// exercises the full path the production container takes: hatchery worker →
// Castra HTTP → agent-deck. It is the coverage that previously lived in
// program.test.ts at the CLI layer — it moved here when the orchestration moved
// from the CLI into the service worker.

const CASTRA_TOKEN = "integration-test-token";

const CLI_PATH = resolve(import.meta.dirname, "../../../dist/cli.js");
const FINDER_PATH = execFileSync(FINDER_BIN, [FINDER_BIN], { encoding: "utf-8" }).trim();
const FAKE_CONTAINER_ID = "0123456789abcdef".repeat(4);

const silentLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
  level: "silent",
  child() {
    return this;
  },
} as never;

describe("hatchery service spawn (real worker, Castra HTTP + stubbed agent-deck/docker)", () => {
  const tmpDirs: string[] = [];
  // Mutate (never reassign) process.env: workers copy the real environment, and
  // reassigning process.env to a plain object detaches those writes from it.
  const MANAGED_KEYS = [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "MARCH_OTEL",
    "MARCH_HATCHERY_WORKER_ENTRY",
    "CASTRA_URL",
    "CASTRA_API_TOKEN",
  ] as const;
  let savedKeys: Record<string, string | undefined>;
  let basePath: string;
  let app: FastifyInstance | undefined;
  let castraApp: FastifyInstance | undefined;

  beforeEach(() => {
    savedKeys = {};
    for (const key of MANAGED_KEYS) savedKeys[key] = process.env[key];
    basePath = process.env.PATH ?? "";
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await castraApp?.close();
    castraApp = undefined;
    for (const key of MANAGED_KEYS) {
      const value = savedKeys[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-hatchery-it-"));
    tmpDirs.push(dir);
    return dir;
  }

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
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"],
      { cwd: repoRoot, env },
    );
    return repoRoot;
  }

  function makeAgentDeckStubBinDir(invocationLog: string): string {
    const binDir = path.join(makeTmpDir(), "agent-bin");
    fs.mkdirSync(binDir);
    const agentDeckStub = path.join(binDir, "agent-deck");
    fs.writeFileSync(
      agentDeckStub,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${invocationLog}"
# Castra always passes an explicit -p <profile>; strip it before dispatching so
# the positional handling below matches regardless of the active profile.
if [ "$1" = "-p" ]; then shift 2; fi
if [ "$1" = "launch" ]; then
  REPO="$2"
  BRANCH=""
  TITLE=""
  GROUP=""
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --worktree|-w|-worktree) BRANCH="$2"; shift 2 ;;
      -t|-title|--title) TITLE="$2"; shift 2 ;;
      -g|-group|--group) GROUP="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  SAFE_BRANCH=$(printf '%s' "$BRANCH" | tr '/' '-')
  WORKTREE="$(dirname "$REPO")/agent-deck-worktrees/feature-$SAFE_BRANCH"
  mkdir -p "$(dirname "$WORKTREE")"
  git -C "$REPO" worktree add -q -b "$BRANCH" "$WORKTREE" HEAD
  printf '{"id":"manager-session","title":"%s","group":"%s","worktree_branch":"%s","worktree_path":"%s","created_at":"2026-05-14T00:00:00Z"}\\n' "$TITLE" "$GROUP" "$BRANCH" "$WORKTREE" > "${invocationLog}.session.json"
  exit 0
fi
if [ "$1" = "list" ]; then
  if [ -f "${invocationLog}.session.json" ]; then
    printf '['
    cat "${invocationLog}.session.json"
    printf ']\\n'
  else
    printf '[]\\n'
  fi
  exit 0
fi
if [ "$1" = "session" ] && [ "$2" = "send" ]; then
  printf '%s\\n' "$4" > "${invocationLog}.prompt"
  exit 0
fi
if [ "$1" = "session" ] && [ "$2" = "show" ]; then
  printf '{"id":"%s"}\\n' "$3"
  exit 0
fi
if [ "$1" = "session" ] && [ "$2" = "remove" ]; then
  rm -f "${invocationLog}.session.json"
  exit 0
fi
exit 0
`,
    );
    fs.chmodSync(agentDeckStub, 0o755);
    return binDir;
  }

  function makeDockerStub(invocationLog: string, logsBody: string): string {
    const binDir = path.join(makeTmpDir(), "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(FINDER_PATH, path.join(binDir, path.basename(FINDER_PATH)));
    const dockerStub = path.join(binDir, "docker");
    fs.writeFileSync(
      dockerStub,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${invocationLog}"
if [ "$1" = "create" ]; then
  echo "${FAKE_CONTAINER_ID}"
  exit 0
fi
if [ "$1" = "wait" ]; then
  echo "0"
  exit 0
fi
if [ "$1" = "logs" ]; then
  cat <<'LOGS'
${logsBody}
LOGS
  exit 0
fi
exit 0
`,
    );
    fs.chmodSync(dockerStub, 0o755);
    return binDir;
  }

  // Backslash-n sequences (not real newlines) so the stub emits a single JSON
  // line; runHatcherySpawn's JSON patch extractor turns them into newlines.
  const PATCH_LOGS =
    '{"patch":"diff --git a/generated.txt b/generated.txt\\nnew file mode 100644\\nindex 0000000..c1827f0\\n--- /dev/null\\n+++ b/generated.txt\\n@@ -0,0 +1 @@\\n+generated\\n"}';

  function startService(env: {
    repoParent: string;
    home: string;
    codexHome: string;
    agentDeckBin: string;
    dockerBin: string;
  }): void {
    const nodeBinDir = path.dirname(process.execPath);
    process.env.PATH = [
      nodeBinDir,
      env.agentDeckBin,
      env.dockerBin,
      basePath,
    ].join(path.delimiter);
    process.env.HOME = env.home;
    process.env.CODEX_HOME = env.codexHome;
    process.env.MARCH_OTEL = "0";
    process.env.MARCH_HATCHERY_WORKER_ENTRY = CLI_PATH;
  }

  // Stand up a real Castra server (in the main thread) whose adapter shells out
  // to the agent-deck stub on PATH, then point the worker at it via env. Must
  // run AFTER startService so the adapter inherits the stubbed PATH, and BEFORE
  // submit() so the worker's env snapshot includes CASTRA_URL/CASTRA_API_TOKEN.
  async function startCastra(): Promise<void> {
    const castra = buildCastraServer({
      adapter: createAgentDeckAdapter(),
      token: CASTRA_TOKEN,
      logger: false,
    });
    await castra.listen({ port: 0, host: "127.0.0.1" });
    castraApp = castra;
    const address = castra.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.CASTRA_URL = `http://127.0.0.1:${port}`;
    process.env.CASTRA_API_TOKEN = CASTRA_TOKEN;
  }

  async function poll(id: string): Promise<{ status: string; result?: unknown; error?: { message: string } }> {
    for (let i = 0; i < 600; i++) {
      const res = await app!.inject({ method: "GET", url: `/spawns/${id}` });
      const job = res.json();
      if (job.status === "succeeded" || job.status === "failed") return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("spawn job did not finish in time");
  }

  async function submit(repoRoot: string, extra: Record<string, string> = {}): Promise<string> {
    const built = await buildServer({ logger: silentLogger });
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/spawns",
      payload: { prompt: "add a generated file", backend: "codex", repoPath: repoRoot, ...extra },
    });
    expect(res.statusCode).toBe(202);
    return (res.json() as { id: string }).id;
  }

  it("launches a manager, captures patch artifacts, and sends the manager prompt", async () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const codexHome = path.join(home, "codex-home");
    fs.mkdirSync(codexHome);
    const agentDeckLog = path.join(home, "agent-deck.log");
    const dockerLog = path.join(home, "docker.log");
    startService({
      repoParent: path.dirname(repoRoot),
      home,
      codexHome,
      agentDeckBin: makeAgentDeckStubBinDir(agentDeckLog),
      dockerBin: makeDockerStub(dockerLog, PATCH_LOGS),
    });
    await startCastra();

    const id = await submit(repoRoot, { title: "manager title", branch: "smithy/cut/generated" });
    const job = await poll(id);
    expect(job.status).toBe("succeeded");

    // Castra prefixes every agent-deck invocation with `-p <profile>`; the
    // Hatchery falls back to the default profile when none is supplied.
    const agentDeckInvocations = fs.readFileSync(agentDeckLog, "utf-8");
    expect(agentDeckInvocations).toMatch(/^-p default launch /m);
    expect(agentDeckInvocations).toContain("--worktree smithy/cut/generated");
    expect(agentDeckInvocations).toContain("manager title");
    expect(agentDeckInvocations).toMatch(/^-p default session send manager-session /m);

    const worktreeParent = path.join(path.dirname(repoRoot), "agent-deck-worktrees");
    const managerWorktrees = fs.readdirSync(worktreeParent);
    expect(managerWorktrees).toHaveLength(1);
    const managerWorktree = path.join(worktreeParent, managerWorktrees[0]);
    expect(fs.readFileSync(path.join(managerWorktree, "generated.txt"), "utf-8")).toBe(
      "generated\n",
    );

    const logsRoot = path.join(home, ".march", "logs", "hatchery-spawns");
    const handoffDir = path.join(logsRoot, fs.readdirSync(logsRoot)[0]);
    expect(fs.readFileSync(path.join(handoffDir, "patch.diff"), "utf-8")).toContain(
      "diff --git a/generated.txt b/generated.txt",
    );
  }, 30000);

  it("record write failure prunes the manager session", async () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const codexHome = path.join(home, "codex-home");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(home, ".march"), "not a dir");
    const agentDeckLog = path.join(home, "agent-deck.log");
    startService({
      repoParent: path.dirname(repoRoot),
      home,
      codexHome,
      agentDeckBin: makeAgentDeckStubBinDir(agentDeckLog),
      dockerBin: makeDockerStub(path.join(home, "docker.log"), PATCH_LOGS),
    });
    await startCastra();

    const id = await submit(repoRoot);
    const job = await poll(id);
    expect(job.status).toBe("failed");
    const agentDeckInvocations = fs.readFileSync(agentDeckLog, "utf-8");
    expect(agentDeckInvocations).toMatch(/^-p default launch /m);
    expect(agentDeckInvocations).toMatch(
      /^-p default session remove manager-session --prune-worktree --force$/m,
    );
  }, 30000);

  it("malformed spawn output is persisted before failing", async () => {
    const repoRoot = makeRealRepo();
    const home = makeTmpDir();
    const codexHome = path.join(home, "codex-home");
    fs.mkdirSync(codexHome);
    const agentDeckLog = path.join(home, "agent-deck.log");
    startService({
      repoParent: path.dirname(repoRoot),
      home,
      codexHome,
      agentDeckBin: makeAgentDeckStubBinDir(agentDeckLog),
      dockerBin: makeDockerStub(path.join(home, "docker.log"), "completed without a patch"),
    });
    await startCastra();

    const id = await submit(repoRoot);
    const job = await poll(id);
    expect(job.status).toBe("failed");
    expect(job.error?.message).toContain("no git patch");

    const logsRoot = path.join(home, ".march", "logs", "hatchery-spawns");
    const handoffDir = path.join(logsRoot, fs.readdirSync(logsRoot)[0]);
    expect(
      fs.readFileSync(path.join(handoffDir, "spawn-output.log"), "utf-8"),
    ).toContain("completed without a patch");
    expect(fs.readFileSync(path.join(handoffDir, "patch.diff"), "utf-8")).toBe("");
    expect(fs.readFileSync(agentDeckLog, "utf-8")).toMatch(
      /^-p default session remove manager-session --prune-worktree --force$/m,
    );
  }, 30000);
});
