/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { TESSERA_POLICY_FILE_ENV, resolvePolicyFile } from "../config.js";
import {
  POLICY_DENIED_MESSAGES,
  PolicyDeniedError,
  TesseraValidationError,
  type PolicyDimension,
} from "../types.js";
import {
  type AuthorizationRequest,
  type Policy,
  type PolicyFileReader,
  type PolicyRuleView,
  authorize,
  loadPolicy,
  loadPolicyFromFile,
  parsePolicy,
} from "./policy.js";

const CLIENTS = ["herald", "steward", "legate", "brood"] as const;

const validRules = [
  { client: "herald", identities: ["app"], repos: ["Acme/Widgets", "acme/gadgets"], max_access: "read" },
  { client: "steward", identities: ["app"], repos: ["acme/*"], max_access: "write" },
  { client: "legate", identities: ["app", "user"], repos: ["acme/widgets"], max_access: "write" },
];

const json = (value: unknown): string => JSON.stringify(value);

const readerFor =
  (contents: string): PolicyFileReader =>
  () =>
    contents;

/** One rule replaced in an otherwise valid policy, at position 2. */
function withRule(rule: unknown): string {
  return json([validRules[0], rule]);
}

function expectLoadError(contents: string, ...fragments: string[]): TesseraValidationError {
  let caught: unknown;
  try {
    parsePolicy(contents, CLIENTS);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TesseraValidationError);
  const message = (caught as Error).message;
  expect(message).toMatch(new RegExp(`^Invalid ${TESSERA_POLICY_FILE_ENV}: .+\\.$`));
  for (const fragment of fragments) expect(message).toContain(fragment);
  // Never file contents, repository values or client-supplied text.
  if (contents.trim().length > 8) expect(message).not.toContain(contents.trim());
  for (const leaked of ["acme", "Acme", "widgets", "intruder", "secret-value"]) {
    expect(message).not.toContain(leaked);
  }
  return caught as TesseraValidationError;
}

describe("resolvePolicyFile", () => {
  it("returns the trimmed path", () => {
    expect(resolvePolicyFile({ [TESSERA_POLICY_FILE_ENV]: " /etc/tessera/policy.json " })).toBe(
      "/etc/tessera/policy.json",
    );
  });

  it.each([undefined, "", "   "])("rejects an unset or blank setting (%j)", (value) => {
    const env = value === undefined ? {} : { [TESSERA_POLICY_FILE_ENV]: value };
    expect(() => resolvePolicyFile(env)).toThrow(TesseraValidationError);
    expect(() => resolvePolicyFile(env)).toThrow(TESSERA_POLICY_FILE_ENV);
  });
});

describe("parsePolicy: valid policies", () => {
  it("loads one rule per client with lower-cased repos", () => {
    const policy = parsePolicy(json(validRules), CLIENTS);
    expect(policy.size).toBe(3);
    expect(policy.ruleFor("herald")).toEqual({
      client: "herald",
      identities: ["app"],
      repos: ["acme/widgets", "acme/gadgets"],
      maxAccess: "read",
    });
    expect(policy.ruleFor("steward")?.repos).toEqual(["acme/*"]);
    expect(policy.ruleFor("legate")?.identities).toEqual(["app", "user"]);
  });

  it("treats a registered client with no rule as valid (no rule returned)", () => {
    const policy = parsePolicy(json(validRules), CLIENTS);
    expect(policy.ruleFor("brood")).toBeUndefined();
    expect(policy.ruleFor("nobody")).toBeUndefined();
  });

  it("lets a user-only legate rule omit repos", () => {
    const policy = parsePolicy(json([{ client: "legate", identities: ["user"], max_access: "write" }]), CLIENTS);
    expect(policy.ruleFor("legate")).toEqual({
      client: "legate",
      identities: ["user"],
      repos: [],
      maxAccess: "write",
    });
  });

  it("accepts the edge of the repository character and length rules", () => {
    const owner = "a".repeat(39);
    const name = "b".repeat(100);
    const policy = parsePolicy(
      json([
        {
          client: "herald",
          identities: ["app"],
          repos: [`${owner}/${name}`, "O_w.n-er/Re.po_-1", "x/.github", "y/*"],
          max_access: "read",
        },
      ]),
      CLIENTS,
    );
    expect(policy.ruleFor("herald")?.repos).toEqual([
      `${owner}/${name}`,
      "o_w.n-er/re.po_-1",
      "x/.github",
      "y/*",
    ]);
  });

  it("returns an immutable rule set", () => {
    const policy = parsePolicy(json(validRules), CLIENTS);
    const rule = policy.ruleFor("herald");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(rule)).toBe(true);
    expect(Object.isFrozen(rule?.identities)).toBe(true);
    expect(Object.isFrozen(rule?.repos)).toBe(true);
    expect(() => {
      (rule?.repos as string[]).push("evil/*");
    }).toThrow();
    expect(Object.keys(policy)).not.toContain("rules");
  });

  it("accepts any iterable of client names", () => {
    expect(parsePolicy(json(validRules), new Set(CLIENTS)).size).toBe(3);
  });
});

describe("parsePolicy: file-level rejections", () => {
  it.each([
    ["an empty file", "", "the file is empty"],
    ["a whitespace-only file", "  \n\t ", "the file is empty"],
    ["non-JSON", "{not json secret-value", "not valid JSON"],
    ["a non-array", json({ client: "herald" }), "expected a JSON array"],
    ["an empty array", "[]", "at least one policy rule"],
  ])("rejects %s", (_label, contents, fragment) => {
    expectLoadError(contents, fragment);
  });
});

describe("parsePolicy: rule-level rejections", () => {
  const base = { client: "steward", identities: ["app"], repos: ["acme/widgets"], max_access: "write" };

  it.each<[string, unknown, string]>([
    ["a non-object entry", "secret-value", "not an object"],
    ["a null entry", null, "not an object"],
    ["an array entry", [], "not an object"],
    ["an unknown field", { ...base, secret_value: true }, "unknown field"],
    ["a missing client", { ...base, client: undefined }, '"client"'],
    ["a non-string client", { ...base, client: 7 }, '"client"'],
    ["an unregistered client", { ...base, client: "intruder" }, "not registered"],
    ["missing identities", { ...base, identities: undefined }, '"identities"'],
    ["non-array identities", { ...base, identities: "app" }, '"identities"'],
    ["empty identities", { ...base, identities: [] }, '"identities"'],
    ["an unknown identity", { ...base, identities: ["app", "secret-value"] }, '"identities"'],
    ["a duplicate identity", { ...base, identities: ["app", "app"] }, "duplicate identity"],
    ["user for a non-legate client", { ...base, identities: ["app", "user"] }, '"user"'],
    ["a missing max_access", { ...base, max_access: undefined }, '"max_access"'],
    ["an unknown max_access", { ...base, max_access: "admin" }, '"max_access"'],
    ["missing repos for app", { ...base, repos: undefined }, '"repos"'],
    ["empty repos for app", { ...base, repos: [] }, '"repos"'],
    ["non-array repos", { ...base, repos: "acme/widgets" }, '"repos"'],
  ])("rejects %s, naming the rule position", (_label, rule, fragment) => {
    const cleaned =
      rule !== null && typeof rule === "object" && !Array.isArray(rule)
        ? Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== undefined))
        : rule;
    expectLoadError(withRule(cleaned), "rule 2", fragment);
  });

  it("rejects invalid repos for a user-only rule", () => {
    expectLoadError(
      withRule({ client: "legate", identities: ["user"], repos: ["*"], max_access: "write" }),
      "rule 2",
      "repos entry 1",
    );
  });

  it.each([
    "*",
    "*/name",
    "*/*",
    "acme/",
    "/widgets",
    "acme/*/x",
    "acme/widgets/x",
    "",
    "acme",
    "../widgets",
    "acme/..",
    "./*",
    "ac me/widgets",
    "acme/wid*",
    "acme*/widgets",
    `${"a".repeat(40)}/widgets`,
    `acme/${"b".repeat(101)}`,
  ])("rejects the repository entry %j", (entry) => {
    expectLoadError(
      withRule({ client: "steward", identities: ["app"], repos: ["acme/ok", entry], max_access: "write" }),
      "rule 2",
      "repos entry 2",
    );
  });

  it("rejects a non-string repository entry", () => {
    expectLoadError(
      withRule({ client: "steward", identities: ["app"], repos: [42], max_access: "write" }),
      "rule 2",
      "repos entry 1",
    );
  });

  it("rejects a duplicate repository entry, ignoring case", () => {
    expectLoadError(
      withRule({ client: "steward", identities: ["app"], repos: ["acme/widgets", "ACME/Widgets"], max_access: "write" }),
      "rule 2",
      "repos entry 2",
      "duplicate",
    );
  });

  it("rejects a second rule for the same client", () => {
    expectLoadError(
      json([validRules[0], validRules[1], { ...validRules[1], max_access: "read" }]),
      "rule 3",
      "rule 2",
    );
  });
});

describe("loadPolicyFromFile and loadPolicy", () => {
  it("loads a file through the reader", () => {
    const policy = loadPolicyFromFile("/p.json", CLIENTS, () => Buffer.from(json(validRules), "utf8"));
    expect(policy.size).toBe(3);
  });

  it("maps a missing or unreadable file to a typed error naming only the setting", () => {
    const path = "/no/such/secret-value-policy.json";
    let caught: unknown;
    try {
      loadPolicyFromFile(path, CLIENTS, () => {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TesseraValidationError);
    expect((caught as Error).message).toBe(
      `Invalid ${TESSERA_POLICY_FILE_ENV}: the file could not be read.`,
    );
  });

  it("reads a real missing file as a typed error", () => {
    expect(() => loadPolicyFromFile("/definitely/not/here/policy.json", CLIENTS)).toThrow(
      TesseraValidationError,
    );
  });

  it("resolves the setting from env", () => {
    let seen: string | undefined;
    const policy = loadPolicy(CLIENTS, { [TESSERA_POLICY_FILE_ENV]: " /etc/p.json " }, (p) => {
      seen = p;
      return json(validRules);
    });
    expect(seen).toBe("/etc/p.json");
    expect(policy.size).toBe(3);
  });

  it("rejects an unset setting before reading anything", () => {
    let read = false;
    expect(() =>
      loadPolicy(CLIENTS, {}, () => {
        read = true;
        return json(validRules);
      }),
    ).toThrow(TesseraValidationError);
    expect(read).toBe(false);
  });

  it("propagates content errors from the reader", () => {
    expect(() => loadPolicy(CLIENTS, { [TESSERA_POLICY_FILE_ENV]: "/p" }, readerFor("[]"))).toThrow(
      "at least one policy rule",
    );
  });
});

describe("PolicyDeniedError", () => {
  it.each<PolicyDimension>(["identity", "repository", "access"])(
    "is a 403 policy_denied with a fixed message for %s",
    (dimension) => {
      const err = new PolicyDeniedError(dimension);
      expect(err.status).toBe(403);
      expect(err.code).toBe("policy_denied");
      expect(err.dimension).toBe(dimension);
      expect(err.message).toBe(POLICY_DENIED_MESSAGES[dimension]);
      expect(err.message.toLowerCase()).toContain(dimension === "repository" ? "repository" : dimension);
    },
  );

  it("uses a distinct message per dimension", () => {
    expect(new Set(Object.values(POLICY_DENIED_MESSAGES)).size).toBe(3);
  });
});

describe("authorize", () => {
  const policy = parsePolicy(
    json([
      { client: "herald", identities: ["app"], repos: ["acme/*"], max_access: "read" },
      { client: "steward", identities: ["app"], repos: ["Octo/Widgets"], max_access: "write" },
      { client: "legate", identities: ["app", "user"], repos: ["acme/widgets", "octo/*"], max_access: "write" },
    ]),
    CLIENTS,
  );

  function denial(client: string, request: AuthorizationRequest, against: Policy = policy): PolicyDimension | null {
    try {
      authorize(against, client, request);
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError);
      return (err as PolicyDeniedError).dimension;
    }
  }

  it("allows a request inside the client's rule", () => {
    expect(denial("herald", { identity: "app", repo: "acme/widgets", access: "read" })).toBeNull();
    expect(denial("steward", { identity: "app", repo: "octo/widgets", access: "write" })).toBeNull();
    expect(denial("steward", { identity: "app", repo: "octo/widgets", access: "read" })).toBeNull();
  });

  it("denies a client with no rule for every request (identity)", () => {
    for (const request of [
      { identity: "app", repo: "acme/widgets", access: "read" },
      { identity: "user", access: "read" },
    ] as const) {
      expect(denial("brood", request)).toBe("identity");
      expect(denial("unregistered", request)).toBe("identity");
    }
  });

  it("denies an identity the rule does not grant", () => {
    expect(denial("herald", { identity: "user", access: "read" })).toBe("identity");
  });

  it("denies user to any client but legate, even if a rule lists it", () => {
    const forged: Policy = {
      size: 1,
      ruleFor: (client): PolicyRuleView | undefined =>
        client === "herald"
          ? { client, identities: ["app", "user"], repos: ["acme/*"], maxAccess: "write" }
          : undefined,
    };
    expect(denial("herald", { identity: "user", access: "read" }, forged)).toBe("identity");
    expect(denial("herald", { identity: "app", repo: "acme/x", access: "read" }, forged)).toBeNull();
  });

  it("denies a repository outside the allowlist", () => {
    expect(denial("herald", { identity: "app", repo: "other/widgets", access: "read" })).toBe("repository");
    expect(denial("steward", { identity: "app", repo: "octo/gadgets", access: "read" })).toBe("repository");
  });

  it("matches owner/* for every repository of that owner only, ignoring case", () => {
    for (const repo of ["acme/widgets", "ACME/Gadgets", "Acme/anything.else"]) {
      expect(denial("herald", { identity: "app", repo, access: "read" })).toBeNull();
    }
    for (const repo of ["acme-evil/widgets", "xacme/widgets", "acm/widgets", "acmee/x"]) {
      expect(denial("herald", { identity: "app", repo, access: "read" })).toBe("repository");
    }
  });

  it("matches an exact entry ignoring case and nothing else", () => {
    expect(denial("steward", { identity: "app", repo: "OCTO/WIDGETS", access: "write" })).toBeNull();
    expect(denial("steward", { identity: "app", repo: "octo/widgets-2", access: "write" })).toBe("repository");
  });

  it("denies an app request with no repository", () => {
    expect(denial("herald", { identity: "app", access: "read" })).toBe("repository");
  });

  it("denies access above the ceiling, for app and user alike", () => {
    expect(denial("herald", { identity: "app", repo: "acme/widgets", access: "write" })).toBe("access");
    const readOnlyLegate = parsePolicy(
      json([{ client: "legate", identities: ["user"], max_access: "read" }]),
      CLIENTS,
    );
    expect(denial("legate", { identity: "user", access: "read" }, readOnlyLegate)).toBeNull();
    expect(denial("legate", { identity: "user", access: "write" }, readOnlyLegate)).toBe("access");
  });

  it("does not check the allowlist for a user request, even when it carries a repo", () => {
    expect(denial("legate", { identity: "user", access: "write" })).toBeNull();
    expect(denial("legate", { identity: "user", repo: "elsewhere/x", access: "write" })).toBeNull();
  });

  it("checks identity before repository before access", () => {
    expect(denial("herald", { identity: "user", repo: "other/x", access: "write" })).toBe("identity");
    expect(denial("herald", { identity: "app", repo: "other/x", access: "write" })).toBe("repository");
  });
});
