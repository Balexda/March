/**
 * In-process fake of the GitHub REST endpoints Tessera's github-app provider
 * calls, for tests only (FR-042). It listens on an ephemeral loopback port, so
 * no test reaches the real network.
 *
 * Served endpoints (mirroring {@link GitHubClient}):
 * - `GET /app`
 * - `GET /orgs/{owner}/installation` (404 for `User` owners) and `GET /users/{owner}/installation`
 * - `POST /app/installations/{id}/access_tokens` (404 unknown installation, 422 repo not covered)
 * - `GET /users/{login}` (the bot user, unauthenticated)
 *
 * It records every call (method, raw path, parsed body, whether a Bearer
 * header was present — never the header value), counts mints, and supports
 * failure injection per endpoint: a status code, a hang, or refusing
 * connections entirely via {@link FakeGitHub.refuseConnections}.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { verify, type KeyObject } from "node:crypto";

/** Endpoint names used for failure injection; match {@link GitHubOperation}. */
export type FakeGitHubEndpoint = "app" | "installation" | "token" | "user";

/** An injected failure: a status (optionally with `Retry-After`) or a never-answered request. */
export type FakeGitHubFailure =
  | { readonly status: number; readonly retryAfter?: string; readonly body?: unknown }
  | { readonly hang: true };

/** One installation of the fake app. */
export interface FakeInstallation {
  readonly id: number;
  /** Account type; `/orgs/{owner}/installation` answers 404 for `User`. Default `Organization`. */
  readonly type?: "Organization" | "User";
  /** Repository names (without owner) the installation covers, or `"all"`. Default `"all"`. */
  readonly repos?: readonly string[] | "all";
}

/** One recorded request. Authorization header values are never recorded. */
export interface FakeGitHubCall {
  readonly method: string;
  /** Raw request path as sent (percent-encoding preserved), without query. */
  readonly path: string;
  readonly endpoint: FakeGitHubEndpoint | null;
  /** Parsed JSON body, or `undefined` when none. */
  readonly body: unknown;
  readonly bearer: boolean;
}

/** Options for {@link startFakeGitHub}. */
export interface FakeGitHubOptions {
  readonly app?: { readonly id: number; readonly slug: string; readonly name?: string };
  /** Bot user id; login is `${slug}[bot]`. */
  readonly botUserId?: number;
  /** Installations keyed by owner login. Owners absent here are uninstalled. */
  readonly installations?: Readonly<Record<string, FakeInstallation>>;
  /** Lifetime of minted tokens in ms. Default one hour. */
  readonly tokenTtlMs?: number;
  /** When set, `/app*` calls must carry an RS256 assertion verifying against this key, else 401. */
  readonly publicKey?: KeyObject;
  /** Wall clock in ms for token expiry and assertion checks. */
  readonly now?: () => number;
}

/** Handle to a running fake GitHub. */
export interface FakeGitHub {
  /** `http://127.0.0.1:<port>`; pass as the client's `baseUrl`. */
  readonly baseUrl: string;
  readonly calls: readonly FakeGitHubCall[];
  /** Number of `POST .../access_tokens` requests received (including failed ones). */
  mintCount(): number;
  /** Number of tokens actually issued. */
  issuedCount(): number;
  /** Override the expiry for subsequent mints: a fixed RFC 3339 string or a lifetime in ms. */
  setTokenExpiry(expiry: string | number): void;
  /** Install (or replace) the app on `owner`. */
  setInstallation(owner: string, installation: FakeInstallation): void;
  /** Make `owner` uninstalled; its installation id also stops minting. */
  uninstallOwner(owner: string): void;
  /** Inject a failure on every later call to `endpoint`, or clear it with `null`. */
  fail(endpoint: FakeGitHubEndpoint, failure: FakeGitHubFailure | null): void;
  /** Close the listener so later calls get connection refused. */
  refuseConnections(): Promise<void>;
  /** Forget recorded calls and counters. */
  reset(): void;
  close(): Promise<void>;
}

interface Route {
  readonly endpoint: FakeGitHubEndpoint;
  readonly handle: (body: unknown) => { status: number; body: unknown };
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function decodeJwtPart(part: string | undefined): Record<string, unknown> | null {
  if (part === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function assertionValid(token: string, publicKey: KeyObject, nowMs: number): boolean {
  const [header, payload, signature] = token.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return false;
  if (decodeJwtPart(header)?.alg !== "RS256") return false;
  const ok = verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`, "utf8"),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  const exp = decodeJwtPart(payload)?.exp;
  return ok && typeof exp === "number" && exp * 1000 > nowMs;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Start a fake GitHub on an ephemeral loopback port. */
export async function startFakeGitHub(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const app = { id: 1, slug: "march-bot", name: "March Bot", ...options.app };
  const botUser = { id: options.botUserId ?? 123456, login: `${app.slug}[bot]` };
  const installations = new Map<string, FakeInstallation>(Object.entries(options.installations ?? {}));
  const now = options.now ?? Date.now;
  const failures = new Map<FakeGitHubEndpoint, FakeGitHubFailure>();
  const calls: FakeGitHubCall[] = [];
  let tokenExpiry: string | number = options.tokenTtlMs ?? DEFAULT_TTL_MS;
  let mints = 0;
  let issued = 0;

  const json = (status: number, body: unknown) => ({ status, body });
  const notFound = () => json(404, { message: "Not Found" });

  function installationFor(owner: string, viaOrg: boolean) {
    const inst = installations.get(owner);
    if (inst === undefined || (viaOrg && inst.type === "User")) return notFound();
    return json(200, { id: inst.id, account: { login: owner, type: inst.type ?? "Organization" } });
  }

  function mint(installationId: number, body: unknown) {
    const entry = [...installations.entries()].find(([, inst]) => inst.id === installationId);
    if (entry === undefined) return notFound();
    const [owner, inst] = entry;
    const req = (typeof body === "object" && body !== null ? body : {}) as {
      repositories?: unknown;
      permissions?: unknown;
    };
    const repos = Array.isArray(req.repositories) ? (req.repositories as unknown[]) : [];
    const covered = inst.repos ?? "all";
    if (covered !== "all" && repos.some((repo) => typeof repo !== "string" || !covered.includes(repo))) {
      return json(422, { message: "There is at least one repository that is not accessible to the installation." });
    }
    issued += 1;
    const expiresAt =
      typeof tokenExpiry === "string" ? tokenExpiry : new Date(now() + tokenExpiry).toISOString().replace(/\.\d{3}Z$/, "Z");
    return json(201, {
      token: `ghs_fake${String(issued).padStart(4, "0")}`,
      expires_at: expiresAt,
      permissions: req.permissions ?? {},
      repository_selection: "selected",
      repositories: repos.map((name) => ({ name, full_name: `${owner}/${String(name)}` })),
    });
  }

  function route(method: string, segments: readonly string[]): Route | null {
    const [a, b, c, d] = segments;
    if (method === "GET" && segments.length === 1 && a === "app") {
      return { endpoint: "app", handle: () => json(200, { id: app.id, slug: app.slug, name: app.name }) };
    }
    if (method === "GET" && segments.length === 3 && (a === "orgs" || a === "users") && c === "installation") {
      return { endpoint: "installation", handle: () => installationFor(b ?? "", a === "orgs") };
    }
    if (method === "POST" && segments.length === 4 && a === "app" && b === "installations" && d === "access_tokens") {
      return {
        endpoint: "token",
        handle: (body) => (/^\d+$/.test(c ?? "") ? mint(Number(c), body) : notFound()),
      };
    }
    if (method === "GET" && segments.length === 2 && a === "users") {
      return {
        endpoint: "user",
        handle: () => (b === botUser.login ? json(200, { id: botUser.id, login: botUser.login, type: "Bot" }) : notFound()),
      };
    }
    return null;
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw === "" ? undefined : (JSON.parse(raw) as unknown);
    } catch {
      body = raw;
    }
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ");
    let segments: string[];
    try {
      segments = path.split("/").filter((s) => s !== "").map((s) => decodeURIComponent(s));
    } catch {
      segments = [];
    }
    const matched = route(method, segments);
    calls.push({ method, path, endpoint: matched?.endpoint ?? null, body, bearer });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };

    if (matched === null) return send(404, { message: "Not Found" });
    if (matched.endpoint === "token") mints += 1;

    const failure = failures.get(matched.endpoint);
    if (failure !== undefined) {
      if ("hang" in failure) return; // never respond
      return send(failure.status, failure.body ?? { message: "injected failure" }, {
        ...(failure.retryAfter === undefined ? {} : { "retry-after": failure.retryAfter }),
      });
    }

    if (matched.endpoint !== "user") {
      const token = bearer ? (authorization as string).slice("Bearer ".length) : "";
      if (!bearer || (options.publicKey !== undefined && !assertionValid(token, options.publicKey, now()))) {
        return send(401, { message: "A JSON web token could not be decoded" });
      }
    }
    const result = matched.handle(body);
    send(result.status, result.body);
  }

  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    mintCount: () => mints,
    issuedCount: () => issued,
    setTokenExpiry: (expiry) => {
      tokenExpiry = expiry;
    },
    setInstallation: (owner, installation) => {
      installations.set(owner, installation);
    },
    uninstallOwner: (owner) => {
      installations.delete(owner);
    },
    fail: (endpoint, failure) => {
      if (failure === null) failures.delete(endpoint);
      else failures.set(endpoint, failure);
    },
    refuseConnections: close,
    reset: () => {
      calls.length = 0;
      mints = 0;
      issued = 0;
    },
    close,
  };
}
