/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { SPAWN_CONFIG, type SpawnConfig } from "../hatchery/spawn-config.js";
import {
  validateProfile,
  type ContainerSecurity,
  type NetworkPolicy,
  type Profile,
  type ResourceLimits,
  type ValidationError,
  type ValidationErrorCode,
  type ValidationResult,
} from "./index.js";

type AssertTrue<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsEqual<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? true
    : false;
type RetainedSpawnConfig = Omit<SpawnConfig, "networkMode">;
type ProfileSpawnConfigParity = ContainerSecurity & ResourceLimits;
type DocumentedContainerFields = "capDrop" | "user" | "envWhitelist";
type DocumentedNetworkModes = "bridge" | "none" | "allowlist";
type InlineEnvContainerFields =
  | "env"
  | "envFile"
  | "environment"
  | "passthrough";
type AllowlistField<T> = T extends { readonly allowlist: infer Allowlist }
  ? Allowlist
  : never;
type _RetainedSpawnConfigFieldsAssignToProfileSubtypes = AssertTrue<
  IsAssignable<RetainedSpawnConfig, ProfileSpawnConfigParity>
>;
type _RetainedSpawnConfigOmitsNetworkMode = AssertTrue<
  Extract<keyof RetainedSpawnConfig, "networkMode"> extends never ? true : false
>;
type _ProfileContainerOnlyExposesDocumentedFields = AssertTrue<
  IsEqual<keyof Profile["container"], DocumentedContainerFields>
>;
type _ProfileContainerHasNoInlineEnvFields = AssertTrue<
  Extract<keyof Profile["container"], InlineEnvContainerFields> extends never
    ? true
    : false
>;
type _ContainerSecurityOnlyExposesDocumentedFields = AssertTrue<
  IsEqual<keyof ContainerSecurity, DocumentedContainerFields>
>;
type _ContainerSecurityHasNoInlineEnvFields = AssertTrue<
  Extract<keyof ContainerSecurity, InlineEnvContainerFields> extends never
    ? true
    : false
>;
type _ProfileContainerEnvWhitelistIsOnlyEnvRelatedField = AssertTrue<
  IsEqual<Extract<keyof Profile["container"], `env${string}`>, "envWhitelist">
>;
type _ContainerSecurityEnvWhitelistIsOnlyEnvRelatedField = AssertTrue<
  IsEqual<Extract<keyof ContainerSecurity, `env${string}`>, "envWhitelist">
>;
type _ProfileNetworkAssignsToExportedNetworkPolicy = AssertTrue<
  IsAssignable<Profile["network"], NetworkPolicy>
>;
type _NetworkPolicyModeValuesAreClosed = AssertTrue<
  IsEqual<NetworkPolicy["mode"], DocumentedNetworkModes>
>;
type _BridgeNetworkHasNoAllowlistField = AssertTrue<
  AllowlistField<Extract<NetworkPolicy, { readonly mode: "bridge" }>> extends never
    ? true
    : false
>;
type _NoneNetworkHasNoAllowlistField = AssertTrue<
  AllowlistField<Extract<NetworkPolicy, { readonly mode: "none" }>> extends never
    ? true
    : false
>;
type _AllowlistFieldOnlyExistsOnAllowlistNetwork = AssertTrue<
  IsEqual<
    Extract<NetworkPolicy, { readonly allowlist: readonly unknown[] }>,
    Extract<NetworkPolicy, { readonly mode: "allowlist" }>
  >
>;

function assertProfileType(_profile: Profile): void {
  return;
}

function assertValidationResultNarrowing(result: ValidationResult): void {
  if (result.ok) {
    const profile: Profile = result.value;
    assertProfileType(profile);
    return;
  }

  const errors: readonly ValidationError[] = result.errors;
  const code: ValidationErrorCode = errors[0]?.code ?? "WrongType";
  expect(code).toBeTruthy();
}

function makeM1ParityProfile(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    name: "spawn",
    baseImage: "march-spawn-claude:latest",
    container: {
      capDrop: SPAWN_CONFIG.capDrop,
      user: SPAWN_CONFIG.user,
      envWhitelist: SPAWN_CONFIG.envWhitelist,
    },
    resources: {
      memoryLimit: SPAWN_CONFIG.memoryLimit,
      cpuLimit: SPAWN_CONFIG.cpuLimit,
      timeoutSeconds: SPAWN_CONFIG.timeoutSeconds,
    },
    fileMounts: [],
    network: { mode: "bridge" },
    ...overrides,
  };
}

describe("validateProfile", () => {
  it.each([null, undefined, true, false, 42, "string", Symbol("profile"), []])(
    "returns a root WrongType failure for non-object input %#",
    (input) => {
      expect(() => validateProfile(input)).not.toThrow();

      expect(validateProfile(input)).toEqual({
        ok: false,
        errors: [
          {
            code: "WrongType",
            path: "",
            message: "Profile must be an object.",
          },
        ],
      });
    },
  );

  it("lets TypeScript consumers narrow on result.ok", () => {
    assertValidationResultNarrowing(validateProfile(null));
  });

  it.each([
    { name: "spawn", baseImage: "march-base:latest" },
    { version: "1", name: "spawn", baseImage: "march-base:latest" },
    { version: 2, name: "spawn", baseImage: "march-base:latest" },
  ])("returns one UnsupportedSchemaVersion error for %#", (input) => {
    expect(validateProfile(input)).toEqual({
      ok: false,
      errors: [
        {
          code: "UnsupportedSchemaVersion",
          path: "/version",
          message: "Profile version must be the supported schema version 1.",
        },
      ],
    });
  });

  it("short-circuits version failures before identity field validation", () => {
    const result = validateProfile({
      version: "1",
      name: "Spawn",
      baseImage: "",
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "UnsupportedSchemaVersion",
          path: "/version",
          message: "Profile version must be the supported schema version 1.",
        },
      ],
    });
  });

  it("accepts a profile with valid identity fields", () => {
    expect(
      validateProfile({
        version: 1,
        name: "spawn",
        baseImage: "march-base:latest",
      }),
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        name: "spawn",
        baseImage: "march-base:latest",
      },
    });
  });

  it.each(["Spawn", "1spawn", ""])(
    "returns InvalidName at /name for invalid profile name %s",
    (name) => {
      expect(
        validateProfile({
          version: 1,
          name,
          baseImage: "march-base:latest",
        }),
      ).toEqual({
        ok: false,
        errors: [
          {
            code: "InvalidName",
            path: "/name",
            message:
              "Profile name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.",
          },
        ],
      });
    },
  );

  it.each([
    ["", "InvalidImageReference"],
    ["march base:latest", "InvalidImageReference"],
    [42, "WrongType"],
  ] as const)(
    "returns %s at /baseImage for invalid image reference %#",
    (baseImage, code) => {
      expect(
        validateProfile({
          version: 1,
          name: "spawn",
          baseImage,
        }),
      ).toEqual({
        ok: false,
        errors: [
          {
            code,
            path: "/baseImage",
            message:
              code === "WrongType"
                ? "Profile baseImage must be a string."
                : "Profile baseImage must be a valid Docker image reference.",
          },
        ],
      });
    },
  );

  it("returns MissingField for an omitted name", () => {
    expect(
      validateProfile({ version: 1, baseImage: "march-base:latest" }),
    ).toEqual({
      ok: false,
      errors: [
        {
          code: "MissingField",
          path: "/name",
          message: "Profile name is required.",
        },
      ],
    });
  });

  it.each([null, 42])(
    "returns WrongType at /name for non-string name %#",
    (name) => {
      expect(
        validateProfile({ version: 1, name, baseImage: "march-base:latest" }),
      ).toEqual({
        ok: false,
        errors: [
          {
            code: "WrongType",
            path: "/name",
            message: "Profile name must be a string.",
          },
        ],
      });
    },
  );

  it("returns MissingField for an omitted baseImage", () => {
    expect(validateProfile({ version: 1, name: "spawn" })).toEqual({
      ok: false,
      errors: [
        {
          code: "MissingField",
          path: "/baseImage",
          message: "Profile baseImage is required.",
        },
      ],
    });
  });

  it("returns WrongType at /baseImage for a present non-string baseImage", () => {
    expect(
      validateProfile({ version: 1, name: "spawn", baseImage: null }),
    ).toEqual({
      ok: false,
      errors: [
        {
          code: "WrongType",
          path: "/baseImage",
          message: "Profile baseImage must be a string.",
        },
      ],
    });
  });

  it("accepts digest-pinned image references", () => {
    expect(
      validateProfile({
        version: 1,
        name: "spawn",
        baseImage:
          "march-base:latest@sha256:0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd",
      }),
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        name: "spawn",
        baseImage:
          "march-base:latest@sha256:0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd",
      },
    });
  });

  it("orders identity field errors deterministically by path and code", () => {
    const result = validateProfile({
      version: 1,
      name: "Spawn",
      baseImage: "",
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "InvalidImageReference",
          path: "/baseImage",
          message: "Profile baseImage must be a valid Docker image reference.",
        },
        {
          code: "InvalidName",
          path: "/name",
          message:
            "Profile name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.",
        },
      ],
    });
  });

  it("accepts M1-equivalent container and resource fields copied from SPAWN_CONFIG", () => {
    const profile = makeM1ParityProfile();

    expect(validateProfile(profile)).toEqual({ ok: true, value: profile });
  });

  it.each([
    [{ user: "march", envWhitelist: SPAWN_CONFIG.envWhitelist }],
    [{ capDrop: "ALL", user: "march", envWhitelist: SPAWN_CONFIG.envWhitelist }],
    [{ capDrop: [], user: "march", envWhitelist: SPAWN_CONFIG.envWhitelist }],
    [{ capDrop: ["NET_ADMIN"], user: "march", envWhitelist: SPAWN_CONFIG.envWhitelist }],
  ])("reports malformed capDrop with InvalidCapDrop %#", (container) => {
    expect(
      validateProfile(makeM1ParityProfile({ container })),
    ).toMatchObject({
      ok: false,
      errors: [
        {
          code: "InvalidCapDrop",
          path: "/container/capDrop",
        },
      ],
    });
  });

  it.each(["march", "user_name", "1000", "1000:1000"])(
    "accepts documented container.user form %s",
    (user) => {
      expect(
        validateProfile(
          makeM1ParityProfile({
            container: {
              capDrop: SPAWN_CONFIG.capDrop,
              user,
              envWhitelist: SPAWN_CONFIG.envWhitelist,
            },
          }),
        ),
      ).toMatchObject({ ok: true });
    },
  );

  it.each(["", "March", "root:root", "1000:march", "bad user"])(
    "reports invalid container.user value %s",
    (user) => {
      expect(
        validateProfile(
          makeM1ParityProfile({
            container: {
              capDrop: SPAWN_CONFIG.capDrop,
              user,
              envWhitelist: SPAWN_CONFIG.envWhitelist,
            },
          }),
        ),
      ).toMatchObject({
        ok: false,
        errors: [
          {
            code: "InvalidUser",
            path: "/container/user",
          },
        ],
      });
    },
  );

  it.each([
    [{ memoryLimit: "4GB", cpuLimit: "2", timeoutSeconds: 3600 }, "InvalidMemoryLimit", "/resources/memoryLimit"],
    [{ memoryLimit: "4g", cpuLimit: "0", timeoutSeconds: 3600 }, "InvalidCpuLimit", "/resources/cpuLimit"],
    [{ memoryLimit: "4g", cpuLimit: "2", timeoutSeconds: 0 }, "InvalidTimeout", "/resources/timeoutSeconds"],
    [{ memoryLimit: "4g", cpuLimit: "2", timeoutSeconds: 1.5 }, "InvalidTimeout", "/resources/timeoutSeconds"],
  ] as const)(
    "reports invalid resource field with %s",
    (resources, code, path) => {
      expect(
        validateProfile(makeM1ParityProfile({ resources })),
      ).toMatchObject({
        ok: false,
        errors: [
          {
            code,
            path,
          },
        ],
      });
    },
  );

  it("aggregates and deterministically orders container and resource errors", () => {
    const result = validateProfile(
      makeM1ParityProfile({
        container: {
          capDrop: ["NET_ADMIN"],
          user: "root:root",
          envWhitelist: SPAWN_CONFIG.envWhitelist,
        },
        resources: {
          memoryLimit: "4 GB",
          cpuLimit: "0",
          timeoutSeconds: -1,
        },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      errors: [
        { code: "InvalidCapDrop", path: "/container/capDrop" },
        { code: "InvalidUser", path: "/container/user" },
        { code: "InvalidCpuLimit", path: "/resources/cpuLimit" },
        { code: "InvalidMemoryLimit", path: "/resources/memoryLimit" },
        { code: "InvalidTimeout", path: "/resources/timeoutSeconds" },
      ],
    });
  });

  it("rejects legacy root networkMode without masking valid parity sections", () => {
    expect(
      validateProfile(makeM1ParityProfile({ networkMode: SPAWN_CONFIG.networkMode })),
    ).toMatchObject({
      ok: false,
      errors: [
        {
          code: "UnknownField",
          path: "/networkMode",
        },
      ],
    });
  });
});
