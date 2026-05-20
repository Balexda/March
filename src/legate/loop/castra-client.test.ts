import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: childProcessMock.execFileSync }));

import {
  CastraClientError,
  castraLaunch,
  castraListSessions,
  castraRemove,
  resolveCastraUrl,
} from "./castra-client.js";

/** curl emits the body followed by `\n<http_code>` (see castra-client `-w`). */
function curlReply(body: unknown, code = 200): string {
  return `${typeof body === "string" ? body : JSON.stringify(body)}\n${code}`;
}

const ENV = { CASTRA_API_TOKEN: "tok", MARCH_CASTRA_URL: "http://castra:9264" } as NodeJS.ProcessEnv;

describe("castra-client", () => {
  afterEach(() => childProcessMock.execFileSync.mockReset());

  it("resolves the base url from env with a localhost default", () => {
    expect(resolveCastraUrl({})).toBe("http://localhost:9264");
    expect(resolveCastraUrl({ MARCH_CASTRA_URL: "http://castra:9264/" } as NodeJS.ProcessEnv)).toBe(
      "http://castra:9264",
    );
  });

  it("maps Castra sessions to the agent-deck-shaped objects the loop consumes", () => {
    childProcessMock.execFileSync.mockReturnValue(
      curlReply({
        sessions: [
          {
            sessionId: "s1",
            title: "Steward",
            group: "legate-workers",
            branch: "b",
            worktreePath: "/repo/feature-b",
            createdAt: "t",
            status: "running",
          },
        ],
      }),
    );
    const sessions = castraListSessions("smithy", undefined, ENV);
    expect(sessions).toEqual([
      {
        id: "s1",
        title: "Steward",
        name: "Steward",
        group: "legate-workers",
        status: "running",
        branch: "b",
        worktree_path: "/repo/feature-b",
        created_at: "t",
      },
    ]);
    // bearer token + profile query are on the curl invocation
    const args = childProcessMock.execFileSync.mock.calls[0][1] as string[];
    expect(args).toContain("authorization: Bearer tok");
    expect(args.some((a) => a.includes("/v1/sessions?profile=smithy"))).toBe(true);
  });

  it("throws CastraClientError carrying the status on a non-2xx envelope", () => {
    childProcessMock.execFileSync.mockReturnValue(
      curlReply({ error: { code: "not_found", message: "no session" } }, 404),
    );
    try {
      castraListSessions("smithy", undefined, ENV);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CastraClientError);
      expect((err as CastraClientError).status).toBe(404);
      expect((err as Error).message).toBe("no session");
    }
  });

  it("sends createBranch:false only for an attach launch", () => {
    childProcessMock.execFileSync.mockReturnValue(
      curlReply({ session: { sessionId: "s2", title: "t", group: "g", branch: "b", worktreePath: "/w", createdAt: "c", status: "idle" } }, 201),
    );
    castraLaunch(
      { profile: "smithy", repoPath: "/r", branch: "b", title: "t", group: "g", createBranch: false },
      ENV,
    );
    const args = childProcessMock.execFileSync.mock.calls[0][1] as string[];
    const body = JSON.parse(args[args.indexOf("--data-binary") + 1]!);
    expect(body.createBranch).toBe(false);
    expect(body).toMatchObject({ profile: "smithy", repoPath: "/r", branch: "b", group: "g" });
  });

  it("treats DELETE removed flag as the result", () => {
    childProcessMock.execFileSync.mockReturnValue(curlReply({ ok: true, removed: true }));
    expect(castraRemove("smithy", "s1", true, ENV)).toEqual({ removed: true });
  });
});
