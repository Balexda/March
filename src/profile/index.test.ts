import { describe, expect, it } from "vitest";
import {
  validateProfile,
  type Profile,
  type ValidationError,
  type ValidationErrorCode,
  type ValidationResult,
} from "./index.js";

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
});
