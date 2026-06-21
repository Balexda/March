import fs from "node:fs";
import os from "node:os";
import { CastraClient, resolveCastraBaseUrl } from "../castra/client.js";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { containerName } from "../stack/services.js";
import { defaultTokenPath } from "../stack/up.js";
import { BroodClient } from "../brood/service/client.js";
import { HeraldClient } from "../herald/service/client.js";
import { ProfileClient } from "../herald/profiles/client.js";
import type { ProfileRecord } from "../herald/profiles/types.js";
import type { CastraAuthVerdict, DoctorContext } from "./context.js";
import type { Finding } from "./types.js";
import {
  dockerContainerEnv,
  dockerContainerState,
  pathExists,
  runGit,
  tmuxServerHost,
} from "./probes.js";

export interface WireOptions {
  /** Scope the run to a single profile (`--profile`). */
  readonly profile?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Wire a {@link DoctorContext} against the real service clients (resolved from
 * `CASTRA_URL` / `MARCH_BROOD_URL` / `MARCH_HERALD_URL` and the docker socket)
 * and resolve the in-scope profiles from Herald's registry.
 *
 * Profile resolution is the one piece of setup that can hard-fail the run: every
 * profile-scoped check needs the list. When Herald is unreachable, or a named
 * `--profile` is unknown, we return a setup finding (surfaced in the report) and
 * an empty profile set — the profile-agnostic checks (token wiring) still run.
 */
export async function wireDoctorContext(
  options: WireOptions = {},
): Promise<{ context: DoctorContext; setupFindings: Finding[] }> {
  const env = options.env ?? process.env;
  const setupFindings: Finding[] = [];

  let profiles: ProfileRecord[] = [];
  try {
    const all = await new ProfileClient({ env }).list();
    if (options.profile) {
      const match = all.find((p) => p.profile === options.profile);
      if (match) {
        profiles = [match];
      } else {
        setupFindings.push({
          check: "session-consistency",
          title: options.profile,
          severity: "fail",
          detail: `no profile "${options.profile}" is registered with Herald`,
          remedy: "march profile list (to see registered profiles)",
        });
      }
    } else {
      profiles = all;
    }
  } catch (err) {
    setupFindings.push({
      check: "session-consistency",
      title: "Herald",
      severity: "fail",
      detail: `could not list profiles from Herald: ${err instanceof Error ? err.message : String(err)}`,
      remedy: "verify the stack is up (`march status`) and MARCH_HERALD_URL is set",
    });
  }

  const baseUrl = resolveCastraBaseUrl(env);
  const context: DoctorContext = {
    profiles,
    // Doctor must authenticate to Castra to read live sessions. Resolve the
    // shared token the way `march up`/`status` do — env, else the token
    // persisted at `~/.march/castra-token` — and finally fall back to the token
    // the castra container actually runs with (read over the docker socket), so
    // a host with a stale/missing `~/.march` can still diagnose.
    castra: new CastraClient({ env, token: resolveSharedToken(env) }),
    brood: new BroodClient({ env }),
    herald: new HeraldClient({ env }),
    containerEnv: dockerContainerEnv,
    containerState: dockerContainerState,
    castraAuthProbe: (token) => probeCastraAuthHttp(baseUrl, token),
    git: runGit,
    pathExists,
    tmuxServerHost,
    localHostname: os.hostname(),
    env,
  };

  return { context, setupFindings };
}

/**
 * The shared `CASTRA_API_TOKEN`, resolved without minting one (doctor is
 * read-only): an operator-set env value wins, else the token `march up`
 * persisted to `~/.march/castra-token`, else the token the castra container is
 * running with (read over the docker socket), else undefined.
 */
function resolveSharedToken(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env[CASTRA_TOKEN_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const fromFile = fs.readFileSync(defaultTokenPath(), "utf-8").trim();
    if (fromFile) return fromFile;
  } catch {
    // No persisted token — fall through to the container token.
  }
  const fromContainer = dockerContainerEnv(containerName("castra"), CASTRA_TOKEN_ENV);
  return fromContainer && fromContainer.trim() ? fromContainer.trim() : undefined;
}

/**
 * Probe Castra's token gate over HTTP with an explicit bearer. The gate sits
 * upstream of routing, so any response that is not a 401/403 means the bearer
 * was accepted; a 401/403 means it was rejected; no token or a transport
 * failure is `unverified` (Castra's own liveness problem, not a token fault).
 */
async function probeCastraAuthHttp(
  baseUrl: string,
  token: string | undefined,
): Promise<CastraAuthVerdict> {
  if (!token) return "unverified";
  try {
    // 10s, not a tight 3s: every check runs concurrently, so this probe races
    // session-consistency's and worktree's Castra calls — agent-deck-backed
    // Castra can be slow under that load, and a timeout here would falsely read
    // as "auth not verifiable" on a healthy stack.
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/sessions?profile=default`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 401 || res.status === 403 ? "rejected" : "accepted";
  } catch {
    return "unverified";
  }
}
