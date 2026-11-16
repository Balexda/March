/**
 * Tessera per-client policy (data model "Policy Rule").
 *
 * The policy file named by `TESSERA_POLICY_FILE` is a JSON array of
 * `{ "client": string, "identities": ("app"|"user")[], "repos"?: string[],
 * "max_access": "read"|"write" }` rows. It is loaded once at startup, validated
 * against the registered client names, into an immutable {@link Policy}: at
 * most one rule per client. A registered client with no rule is valid and is
 * denied at request time (default deny).
 *
 * {@link authorize} decides one parsed request against the caller's rule.
 *
 * Load errors are typed {@link TesseraValidationError}s that name the setting
 * and the rule position only — never a path, a repository, a client name or
 * any other file contents.
 */
import { readFileSync } from "node:fs";
import { TESSERA_POLICY_FILE_ENV, resolvePolicyFile } from "../config.js";
import { isValidOwner, isValidRepoName } from "../repo-name.js";
import {
  type AccessLevel,
  type EntitlementRequest,
  type Identity,
  PolicyDeniedError,
  TesseraValidationError,
} from "../types.js";

/** Reads the policy file's raw bytes; injectable for tests. */
export type PolicyFileReader = (path: string) => Buffer | string;

/** The only client that may be granted the `user` identity in v1. */
export const USER_IDENTITY_CLIENT = "legate";

/** Read-only view of one client's validated rule. */
export interface PolicyRuleView {
  readonly client: string;
  /** Granted identities, in file order, without duplicates. */
  readonly identities: readonly Identity[];
  /**
   * Repository allowlist, lower-cased, in file order: `owner/name` or
   * `owner/*`. Empty only for a `user`-only rule that omitted `repos`.
   */
  readonly repos: readonly string[];
  /** Access ceiling. */
  readonly maxAccess: AccessLevel;
}

/** An immutable set of policy rules, at most one per registered client. */
export interface Policy {
  /** Number of rules. */
  readonly size: number;
  /** The rule for `client`, or `undefined` when it has none (default deny). */
  ruleFor(client: string): PolicyRuleView | undefined;
}

const IDENTITIES: ReadonlySet<string> = new Set<Identity>(["app", "user"]);
const ACCESS_LEVELS: ReadonlySet<string> = new Set<AccessLevel>(["read", "write"]);
const ALLOWED_FIELDS: ReadonlySet<string> = new Set(["client", "identities", "repos", "max_access"]);
const OWNER_WILDCARD = "*";

function invalid(problem: string): TesseraValidationError {
  return new TesseraValidationError(`Invalid ${TESSERA_POLICY_FILE_ENV}: ${problem}.`);
}

/** Exactly `owner/name` or `owner/*`, using the request validator's segment rules. */
function isValidRepoEntry(entry: string): boolean {
  const parts = entry.split("/");
  if (parts.length !== 2) return false;
  const [owner = "", name = ""] = parts;
  return isValidOwner(owner) && (name === OWNER_WILDCARD || isValidRepoName(name));
}

class RuleSet implements Policy {
  readonly size: number;
  readonly #rules: ReadonlyMap<string, PolicyRuleView>;

  constructor(rules: readonly PolicyRuleView[]) {
    this.#rules = new Map(rules.map((rule) => [rule.client, rule]));
    this.size = this.#rules.size;
    Object.freeze(this);
  }

  ruleFor(client: string): PolicyRuleView | undefined {
    return this.#rules.get(client);
  }
}

function parseIdentities(value: unknown, at: string): Identity[] {
  const expected = '(expected a non-empty array of "app" and/or "user")';
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(`${at} has a missing or invalid "identities" ${expected}`);
  }
  const identities: Identity[] = [];
  for (const identity of value) {
    if (typeof identity !== "string" || !IDENTITIES.has(identity)) {
      throw invalid(`${at} has an invalid "identities" ${expected}`);
    }
    if (identities.includes(identity as Identity)) {
      throw invalid(`${at} has a duplicate identity in "identities"`);
    }
    identities.push(identity as Identity);
  }
  return identities;
}

function parseRepos(value: unknown, at: string, requireNonEmpty: boolean): string[] {
  if (value === undefined) {
    if (requireNonEmpty) throw invalid(`${at} grants "app" but has no "repos"`);
    return [];
  }
  if (!Array.isArray(value)) throw invalid(`${at} has an invalid "repos" (expected an array)`);
  if (requireNonEmpty && value.length === 0) throw invalid(`${at} grants "app" but has empty "repos"`);

  const repos: string[] = [];
  const positions = new Map<string, number>();
  value.forEach((entry: unknown, index) => {
    const position = index + 1;
    if (typeof entry !== "string" || !isValidRepoEntry(entry)) {
      throw invalid(`${at} has an invalid repos entry ${position} (expected owner/name or owner/*)`);
    }
    const lowered = entry.toLowerCase();
    const prior = positions.get(lowered);
    if (prior !== undefined) {
      throw invalid(`${at} has a duplicate repos entry ${position} (same as entry ${prior}, ignoring case)`);
    }
    positions.set(lowered, position);
    repos.push(lowered);
  });
  return repos;
}

/**
 * Validate policy file contents against the registered client names and build
 * the rule set. Rejects a blank file, non-JSON, a non-array top level, an
 * empty list, and any rule with an unknown or missing field, an unregistered
 * client, a second rule for a client, invalid or duplicate identities, `user`
 * for any client but `legate`, an unknown `max_access`, `app` without repos,
 * or an invalid or duplicate repository entry.
 */
export function parsePolicy(contents: string, clientNames: Iterable<string>): Policy {
  if (contents.trim().length === 0) throw invalid("the file is empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw invalid("the file is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw invalid("expected a JSON array of policy rules");
  if (parsed.length === 0) throw invalid("expected at least one policy rule");

  const registered: ReadonlySet<string> = new Set(clientNames);
  const clientPositions = new Map<string, number>();
  const rules: PolicyRuleView[] = [];

  parsed.forEach((entry: unknown, index) => {
    const position = index + 1;
    const at = `rule ${position}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalid(`${at} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (!ALLOWED_FIELDS.has(field)) throw invalid(`${at} has an unknown field`);
    }

    const client = record.client;
    if (typeof client !== "string") throw invalid(`${at} has a missing or invalid "client"`);
    if (!registered.has(client)) throw invalid(`${at} names a client that is not registered`);
    const prior = clientPositions.get(client);
    if (prior !== undefined) throw invalid(`${at} is a second rule for the client of rule ${prior}`);

    const identities = parseIdentities(record.identities, at);
    if (identities.includes("user") && client !== USER_IDENTITY_CLIENT) {
      throw invalid(`${at} grants "user", which only the ${USER_IDENTITY_CLIENT} client may hold`);
    }

    const maxAccess = record.max_access;
    if (typeof maxAccess !== "string" || !ACCESS_LEVELS.has(maxAccess)) {
      throw invalid(`${at} has a missing or invalid "max_access" (expected "read" or "write")`);
    }

    const repos = parseRepos(record.repos, at, identities.includes("app"));

    clientPositions.set(client, position);
    rules.push(
      Object.freeze({
        client,
        identities: Object.freeze(identities),
        repos: Object.freeze(repos),
        maxAccess: maxAccess as AccessLevel,
      }),
    );
  });

  return new RuleSet(rules);
}

/**
 * Load and validate the policy file at `path`. A missing or unreadable file is
 * a typed validation error that names the setting, not the path.
 */
export function loadPolicyFromFile(
  path: string,
  clientNames: Iterable<string>,
  readFile: PolicyFileReader = (p) => readFileSync(p),
): Policy {
  let raw: Buffer | string;
  try {
    raw = readFile(path);
  } catch {
    throw invalid("the file could not be read");
  }
  return parsePolicy(typeof raw === "string" ? raw : raw.toString("utf8"), clientNames);
}

/**
 * Resolve `TESSERA_POLICY_FILE` from `env` and load the policy. An unset or
 * blank setting is a typed validation error, never "allow all".
 */
export function loadPolicy(
  clientNames: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
  readFile?: PolicyFileReader,
): Policy {
  return loadPolicyFromFile(resolvePolicyFile(env), clientNames, readFile);
}

/**
 * The decision inputs of an Entitlement Request. `subject` is deliberately
 * absent: it is audited only and never affects a decision (FR-015).
 */
export type AuthorizationRequest = Pick<EntitlementRequest, "identity" | "repo" | "access">;

const ACCESS_RANK: Readonly<Record<AccessLevel, number>> = Object.freeze({ read: 0, write: 1 });

/** `repo` (any case) matches an exact `owner/name` entry or that owner's `owner/*`. */
function repoAllowed(repos: readonly string[], repo: string): boolean {
  const lowered = repo.toLowerCase();
  const owner = lowered.split("/")[0] ?? "";
  return repos.some((entry) => entry === lowered || entry === `${owner}/${OWNER_WILDCARD}`);
}

/**
 * Authorize `client`'s request against its policy rule; returns normally when
 * allowed, otherwise throws {@link PolicyDeniedError} naming the first
 * dimension denied, checked in this order:
 *
 * 1. identity - no rule for the client (default deny), an identity the rule
 *    does not grant, or `user` from any client but `legate` (defence in depth:
 *    the loader already refuses such a rule);
 * 2. repository - for `app`, the repo must match the allowlist ignoring case;
 * 3. access - the requested access must not exceed the rule's ceiling.
 *
 * Working assumptions for open specification debt: the access ceiling applies
 * to every identity, including `user` (SD-015, option a); and a `user`
 * request is not checked against the repository allowlist even when it
 * carries a repo, because the PAT cannot be repository-scoped (SD-016).
 */
export function authorize(policy: Policy, client: string, request: AuthorizationRequest): void {
  const rule = policy.ruleFor(client);
  if (rule === undefined) throw new PolicyDeniedError("identity");
  if (!rule.identities.includes(request.identity)) throw new PolicyDeniedError("identity");
  if (request.identity === "user" && client !== USER_IDENTITY_CLIENT) {
    throw new PolicyDeniedError("identity");
  }
  if (request.identity === "app") {
    if (request.repo === undefined || !repoAllowed(rule.repos, request.repo)) {
      throw new PolicyDeniedError("repository");
    }
  }
  if (ACCESS_RANK[request.access] > ACCESS_RANK[rule.maxAccess]) {
    throw new PolicyDeniedError("access");
  }
}
