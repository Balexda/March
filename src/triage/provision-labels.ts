import { isAbsolute } from "node:path";
import { SpanStatusCode } from "@opentelemetry/api";
import { resolveHeraldUrl } from "../herald/service/client.js";
import { startTriageProvisionSpan } from "../observability/triage-trace.js";
import { resolveOriginRepo } from "../shared/github-remote.js";
import { TRIAGE_LABEL_CATALOG } from "./labels.js";

export interface ProvisionLabelOptions {
  /** Supply a credential for only this repository, with GitHub Issues write access. */
  readonly tokenForRepository: (repository: string, signal: AbortSignal) => Promise<string>;
  readonly heraldUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

type Operation = "registry.list" | "repository.resolve" | "credential" | "list" | "create" | "confirm";
interface RepositoryLabels {
  repository: string;
  created: string[];
  alreadyPresent: string[];
}
export type ProvisionLabelResult =
  | { ok: true; repositories: RepositoryLabels[] }
  | { ok: false; operation: Operation; repository?: string; profile?: string; label?: string; reason: string };

class ProvisionError extends Error {}

async function bounded<T>(timeoutMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ProvisionError("Operation timed out"));
          controller.abort();
        }, timeoutMs);
      }),
      call(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function labelName(value: { name?: unknown } | null): string {
  if (typeof value?.name !== "string" || !value.name) throw new ProvisionError("Invalid GitHub label response");
  return value.name;
}

/** Ensure all active Herald repositories have every shared triage label definition. */
export async function provisionTriageLabels(options: ProvisionLabelOptions): Promise<ProvisionLabelResult> {
  const span = startTriageProvisionSpan();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? 15_000;
  let operation: Operation = "registry.list";
  let repository: string | undefined;
  let profile: string | undefined;
  let label: string | undefined;

  try {
    const profiles = await bounded(timeout, async signal => {
      const url = options.heraldUrl ?? resolveHeraldUrl();
      const response = await fetchImpl(`${url}/profiles`, { signal, redirect: "error" });
      if (response.status !== 200) throw new ProvisionError(`Herald HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body?.profiles) || !body.profiles.every(
        (row: { profile?: unknown; repoPath?: unknown } | null) =>
          typeof row?.profile === "string" && typeof row.repoPath === "string" && isAbsolute(row.repoPath),
      )) throw new ProvisionError("Invalid Herald profile response");
      return body.profiles as Array<{ profile: string; repoPath: string }>;
    });

    operation = "repository.resolve";
    const repos = new Map<string, string>();
    for (const row of profiles) {
      profile = row.profile;
      const slug = await resolveOriginRepo(row.repoPath);
      if (!slug) throw new ProvisionError("Could not resolve the checkout's GitHub origin");
      const key = slug.toLowerCase();
      if (!repos.has(key)) repos.set(key, slug);
    }
    profile = undefined;

    const repositories: RepositoryLabels[] = [];
    for (const slug of repos.values()) {
      repository = slug;
      operation = "credential";
      const token = await bounded(timeout, signal => options.tokenForRepository(slug, signal));
      if (!token) throw new ProvisionError("Missing repository credential");

      const endpoint = `https://api.github.com/repos/${slug}/labels`;
      const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      };
      const request = (url: string, signal: AbortSignal, init?: RequestInit) =>
        fetchImpl(url, { ...init, headers, signal, redirect: "error" });

      operation = "list";
      const names = await bounded(timeout, async signal => {
        const found = new Set<string>();
        for (let page = 1; ; page++) {
          const response = await request(`${endpoint}?per_page=100&page=${page}`, signal);
          if (response.status !== 200) throw new ProvisionError(`GitHub HTTP ${response.status}`);
          const labels = await response.json();
          if (!Array.isArray(labels)) throw new ProvisionError("Invalid GitHub label list");
          for (const entry of labels) found.add(labelName(entry).toLowerCase());
          if (labels.length < 100) return found;
        }
      });

      const result: RepositoryLabels = { repository: slug, created: [], alreadyPresent: [] };
      for (const { name } of TRIAGE_LABEL_CATALOG) {
        if (names.has(name)) {
          result.alreadyPresent.push(name);
          continue;
        }

        label = name;
        operation = "create";
        const created = await bounded(timeout, async signal => {
          const response = await request(endpoint, signal, {
            method: "POST", body: JSON.stringify({ name, color: "ededed" }),
          });
          if (response.status === 201 && labelName(await response.json()).toLowerCase() === name) return true;
          if (response.status === 409) return false;
          if (response.status === 422) {
            const body = await response.json();
            if (Array.isArray(body?.errors) && body.errors.some(
              (error: { code?: string } | null) => error?.code === "already_exists",
            )) return false;
          }
          throw new ProvisionError(`GitHub create could not confirm label (HTTP ${response.status})`);
        });
        if (created) {
          result.created.push(name);
        } else {
          operation = "confirm";
          await bounded(timeout, async signal => {
            const response = await request(`${endpoint}/${encodeURIComponent(name)}`, signal);
            if (response.status !== 200 || labelName(await response.json()).toLowerCase() !== name) {
              throw new ProvisionError(`Could not confirm conflicting label (HTTP ${response.status})`);
            }
          });
          result.alreadyPresent.push(name);
        }
        label = undefined;
      }
      repositories.push(result);
    }
    return { ok: true, repositories };
  } catch (error) {
    const reason = error instanceof ProvisionError ? error.message : "Request or response processing failed";
    const context = { ...(repository && { repository }), ...(profile && { profile }), ...(label && { label }) };
    span?.setAttributes({ "triage.provision.operation": operation, ...context });
    span?.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    return { ok: false, operation, ...context, reason };
  } finally {
    span?.end();
  }
}
