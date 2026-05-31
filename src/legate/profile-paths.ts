import os from "node:os";
import path from "node:path";
import type { ProfileRecord } from "../herald/profiles/types.js";
import type { LoopMeta } from "./loop/meta.js";

/**
 * Per-profile filesystem layout for the profile-agnostic legate. One shared
 * `march-legate` container drives N profiles, so each profile gets its own
 * sub-directory under `~/.march/legate/<profile>/` for its action log + events
 * (replacing the per-conductor `legate-loop-meta.json` deployment dir). The
 * single Herald cursor lives one level up (container-wide), so it is NOT here.
 */
export function profileStateDir(profile: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".march", "legate", profile);
}

/** Container-wide dir holding the single Herald cursor (one multiplexed stream). */
export function legateStateDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".march", "legate");
}

/**
 * Synthesize the loose `LoopMeta` the runtime + handlers consume from a registry
 * {@link ProfileRecord}. The runtime treats `meta` duck-typed (mostly paths +
 * repo + profile + worker_group), so this carries exactly those, with per-profile
 * file paths under {@link profileStateDir}. OTel/herald endpoints are container-
 * wide (env), not per-profile.
 */
export function metaForProfileRecord(
  rec: ProfileRecord,
  opts: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): LoopMeta {
  const homeDir = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;
  const dir = profileStateDir(rec.profile, homeDir);
  const conductor = rec.conductorName ?? `${rec.profile}-legate-agent`;
  return {
    schema_version: 2,
    profile: rec.profile,
    paired_legate: conductor,
    loop_name: `${rec.profile}-legate`,
    processor_name: `${rec.profile}-legate`,
    repo: { name: rec.repoName, path: rec.repoPath },
    march_cli_path: rec.marchCliPath ?? null,
    worker_group: rec.workerGroup,
    legate_state_path: path.join(dir, "state.json"),
    loop_log_path: path.join(dir, "legate.log"),
    loop_events_path: path.join(dir, "legate.ndjson"),
    loop_heartbeat_log_path: path.join(dir, "legate-heartbeat.log"),
    loop_heartbeat_events_path: path.join(dir, "legate-heartbeat.ndjson"),
    processor_log_path: path.join(dir, "legate.log"),
    processor_events_path: path.join(dir, "legate.ndjson"),
    processor_requests_path: path.join(dir, "legate-requests.ndjson"),
    legate_conductor_dir: dir,
    otel: {
      enabled: (env.MARCH_OTEL ?? "").trim() === "1",
      endpoint: env.MARCH_OTEL_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
    },
    brood_endpoint: rec.broodEndpoint ?? null,
    herald_endpoint: env.MARCH_HERALD_URL ?? null,
    mode: rec.mode ?? "terminal-pr-maintenance",
  } as unknown as LoopMeta;
}
