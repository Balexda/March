/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { describeExecError } from "./exec.js";

describe("describeExecError", () => {
  it("prefers the child's stderr (the actionable Docker/Compose diagnostic)", () => {
    const err = Object.assign(new Error("Command failed: docker compose down"), {
      stderr: Buffer.from("error while interpolating services.legate...\n"),
    });
    expect(describeExecError(err)).toBe(
      "error while interpolating services.legate...",
    );
  });

  it("accepts a string stderr as well as a Buffer", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "  port is already allocated  ",
    });
    expect(describeExecError(err)).toBe("port is already allocated");
  });

  it("falls back to the message when stderr is empty", () => {
    const err = Object.assign(new Error("Command failed: docker"), {
      stderr: Buffer.from("   "),
    });
    expect(describeExecError(err)).toBe("Command failed: docker");
  });

  it("handles non-Error values", () => {
    expect(describeExecError("boom")).toBe("boom");
  });
});
