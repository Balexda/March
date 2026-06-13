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
});
