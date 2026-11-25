/** @l1 @deterministic @ci */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { TRIAGE_LABEL_CATALOG } from "./labels.js";
import { provisionTriageLabels } from "./provision-labels.js";

const span = vi.hoisted(() => ({ setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn() }));
vi.mock("../observability/triage-trace.js", () => ({ startTriageProvisionSpan: () => span }));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function checkout(repo: string) {
  const cwd = mkdtempSync(join(tmpdir(), "march-labels-"));
  dirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], { cwd });
  return cwd;
}

const names = TRIAGE_LABEL_CATALOG.map(item => item.name);
const march = "Org/march";
const smithycli = "Org/smithycli";
const overrides = [{ name: "bug", color: "ef0000" }, { name: names[0], color: "123456", description: "Custom" }];

function fixture() {
  const profiles = [
    { profile: "first", repoPath: checkout(march) },
    { profile: "second", repoPath: checkout(smithycli) },
    { profile: "duplicate", repoPath: checkout("org/MARCH") },
  ];
  const marchLabels = new Map(overrides.map(label => [label.name, label]));
  const definitions = new Map([[march, marchLabels], [smithycli, new Map()]]);
  const writes: Array<[string, string]> = [];
  const scenario: {
    create?: (repo: string, name: string) => Response | undefined;
    registry?: () => Promise<Response>;
    list?: (repo: string) => Promise<Response> | undefined;
  } = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "http://herald" && url.pathname === "/profiles") {
      return scenario.registry?.() ?? Response.json({ profiles });
    }

    expect(url.origin).toBe("https://api.github.com");
    const [, , owner, name, resource, requested] = url.pathname.split("/");
    expect(resource).toBe("labels");
    const repo = `${owner}/${name}`;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer scoped:${repo}`);
    const entries = definitions.get(repo)!;
    if (init?.method === "POST") {
      expect(requested).toBeUndefined();
      const definition = JSON.parse(String(init.body));
      writes.push([repo, definition.name]);
      const response = scenario.create?.(repo, definition.name);
      if (response) return response;
      expect(entries.has(definition.name)).toBe(false);
      entries.set(definition.name, definition);
      return Response.json(definition, { status: 201 });
    }
    expect(init?.method).toBeUndefined();
    if (requested) {
      const label = entries.get(decodeURIComponent(requested));
      return label ? Response.json(label) : new Response(null, { status: 404 });
    }
    const page = Number(url.searchParams.get("page"));
    return scenario.list?.(repo) ?? Response.json([...entries.values()].slice((page - 1) * 100, page * 100));
  };
  const tokenForRepository = vi.fn(async (repo: string) => `scoped:${repo}`);
  const run = (timeoutMs?: number) => provisionTriageLabels({
    heraldUrl: "http://herald", fetchImpl, tokenForRepository, timeoutMs,
  });
  return { marchLabels, definitions, writes, scenario, tokenForRepository, run };
}

it("provisions distinct repositories and makes zero mutations on a complete second run", async () => {
  const { marchLabels, writes, run, tokenForRepository } = fixture();
  overrides.forEach(label => marchLabels.delete(label.name));
  for (let i = 0; i < 100; i++) marchLabels.set(`area:${i}`, { name: `area:${i}`, color: "abcdef" });
  overrides.forEach(label => marchLabels.set(label.name, label));
  expect(await run()).toEqual({
    ok: true,
    repositories: [
      { repository: march, created: names.slice(1), alreadyPresent: names.slice(0, 1) },
      { repository: smithycli, created: names, alreadyPresent: [] },
    ],
  });
  expect(tokenForRepository.mock.calls.map(([repo]) => repo)).toEqual([march, smithycli]);
  expect(writes).toHaveLength(2 * names.length - 1);
  writes.length = 0;
  expect(await run()).toEqual({
    ok: true,
    repositories: [march, smithycli].map(repository => ({ repository, created: [], alreadyPresent: names })),
  });
  expect(writes).toEqual([]);
  expect([...marchLabels.values()].slice(100, 102)).toEqual(overrides);
  expect(marchLabels.get("area:0")).toEqual({ name: "area:0", color: "abcdef" });
});

it("counts a concurrent create only after confirming the label exists", async () => {
  const { marchLabels, scenario, run } = fixture();
  scenario.create = (repo, name) => {
    if (repo !== march || name !== names[1]) return;
    marchLabels.set(name, { name, color: "abcdef" });
    return Response.json({ errors: [{ code: "already_exists" }] }, { status: 422 });
  };
  const result = await run();
  expect(result).toMatchObject({
    ok: true,
    repositories: [
      { repository: march, created: names.slice(2), alreadyPresent: names.slice(0, 2) },
      { repository: smithycli },
    ],
  });
});

it("reports an unconfirmed conflict and retries only the remaining creates", async () => {
  const { writes, scenario, run } = fixture();
  scenario.create = (repo, name) => repo === smithycli && name === names[2]
    ? new Response(null, { status: 409 }) : undefined;
  expect(await run()).toMatchObject({ ok: false, operation: "confirm", repository: smithycli, label: names[2] });
  expect(span.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
  expect(span.end).toHaveBeenCalledOnce();
  writes.length = 0;
  delete scenario.create;
  expect(await run()).toEqual({
    ok: true,
    repositories: [
      { repository: march, created: [], alreadyPresent: names },
      { repository: smithycli, created: names.slice(2), alreadyPresent: names.slice(0, 2) },
    ],
  });
  expect(writes).toEqual(names.slice(2).map(name => [smithycli, name]));
});

it.each(["registry.list", "list"])("bounds a stalled %s call and reports the operation", async operation => {
  const { scenario, run, writes } = fixture();
  const stall = () => new Promise<Response>(() => {});
  if (operation === "registry.list") scenario.registry = stall;
  else scenario.list = stall;
  expect(await run(30)).toMatchObject({
    ok: false, operation, reason: "Operation timed out",
    ...(operation === "list" ? { repository: march } : {}),
  });
  expect(writes).toEqual([]);
});

it("reports malformed registry coverage instead of treating it as empty", async () => {
  const { scenario, run } = fixture();
  scenario.registry = async () => Response.json({});
  expect(await run()).toMatchObject({ ok: false, operation: "registry.list" });
});

it("rejects a relative checkout path before resolving any repository", async () => {
  const { scenario, run, writes, tokenForRepository } = fixture();
  scenario.registry = async () => Response.json({ profiles: [{ profile: "relative", repoPath: "." }] });
  expect(await run()).toMatchObject({ ok: false, operation: "registry.list", reason: "Invalid Herald profile response" });
  expect(tokenForRepository).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
});
