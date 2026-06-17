import fs from "node:fs";
import { CastraClient } from "../castra/client.js";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { defaultTokenPath } from "../stack/up.js";
import { BroodClient } from "../brood/service/client.js";
import { HeraldClient } from "../herald/service/client.js";
import { ProfileClient } from "../herald/profiles/client.js";
import type { ProfileRecord } from "../herald/profiles/types.js";
import type { DoctorContext } from "./context.js";
import type { Finding } from "./types.js";
import {
  dockerContainerEnv,
  dockerContainerState,
  pathExists,
  runGit,
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

  const context: DoctorContext = {
    profiles,
    // Doctor must authenticate to Castra to read live sessions and probe the
    // token gate. Resolve the shared token the way `march up`/`status` do — env
    // first, else the token persisted at `~/.march/castra-token` — so a host
    // that ran `march up` can diagnose without re-exporting CASTRA_API_TOKEN.
    castra: new CastraClient({ env, token: resolveSharedToken(env) }),
    brood: new BroodClient({ env }),
    herald: new HeraldClient({ env }),
    containerEnv: dockerContainerEnv,
    containerState: dockerContainerState,
    git: runGit,
    pathExists,
    env,
  };

  return { context, setupFindings };
}

/**
 * The shared `CASTRA_API_TOKEN`, resolved without minting one (doctor is
 * read-only): an operator-set env value wins, else the token `march up`
 * persisted to `~/.march/castra-token`, else undefined.
 */
function resolveSharedToken(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env[CASTRA_TOKEN_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const fromFile = fs.readFileSync(defaultTokenPath(), "utf-8").trim();
    if (fromFile) return fromFile;
  } catch {
    // No persisted token — doctor proceeds tokenless and the token-wiring check
    // reports that Castra auth could not be verified.
  }
  return undefined;
}
