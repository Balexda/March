import { describe, expect, it } from "vitest";
import {
  createBackendRegistry,
  defaultBackendName,
  type SpawnBackend,
} from "./spawn-backend.js";
import type { LaunchSpawnContainerInput } from "./spawn/container-launch.js";

type Assert<T extends true> = T;
type IsExactly<T, U> =
  (<V>() => V extends T ? 1 : 2) extends
  (<V>() => V extends U ? 1 : 2)
    ? (<V>() => V extends U ? 1 : 2) extends
      (<V>() => V extends T ? 1 : 2)
      ? true
      : false
    : false;

type SpawnBackendKeysAreClosed = Assert<
  IsExactly<
    keyof SpawnBackend,
    "name" | "baseImage" | "requiredEnvVars" | "buildEntrypoint"
  >
>;

type EntrypointReturnMatchesLaunchEntrypoint = Assert<
  IsExactly<
    ReturnType<SpawnBackend["buildEntrypoint"]>,
    ReturnType<LaunchSpawnContainerInput["backend"]["buildEntrypoint"]>
  >
>;

void (undefined as unknown as SpawnBackendKeysAreClosed);
void (undefined as unknown as EntrypointReturnMatchesLaunchEntrypoint);

const fixtureBackend = (name: string): SpawnBackend => ({
  name,
  baseImage: `${name}:latest`,
  requiredEnvVars: [`${name.toUpperCase()}_API_KEY`],
  buildEntrypoint(promptFilePath: string): readonly string[] {
    return ["fixture", "--prompt-file", promptFilePath];
  },
});

describe("spawn-backend", () => {
  it("allows a plain object literal to satisfy the four-member interface", () => {
    const backend: SpawnBackend = {
      name: "fixture",
      baseImage: "fixture:latest",
      requiredEnvVars: ["FIXTURE_API_KEY"],
      buildEntrypoint(promptFilePath: string): readonly string[] {
        return ["fixture", promptFilePath];
      },
    };

    expect(Object.keys(backend).sort()).toEqual([
      "baseImage",
      "buildEntrypoint",
      "name",
      "requiredEnvVars",
    ]);
    expect(backend.requiredEnvVars).toEqual(["FIXTURE_API_KEY"]);
    expect(backend.buildEntrypoint("/march/prompt.txt")).toEqual([
      "fixture",
      "/march/prompt.txt",
    ]);
  });

  it("looks up registered backends by name", () => {
    const alpha = fixtureBackend("alpha");
    const beta = fixtureBackend("beta");
    const registry = createBackendRegistry([alpha, beta]);

    expect(registry.getBackend("alpha")).toBe(alpha);
    expect(registry.getBackend("beta")).toBe(beta);
  });

  it("returns undefined for unknown backend names", () => {
    const registry = createBackendRegistry([fixtureBackend("alpha")]);

    expect(registry.getBackend("missing")).toBeUndefined();
  });

  it("lists backend names in registration order without exposing objects", () => {
    const registry = createBackendRegistry([
      fixtureBackend("alpha"),
      fixtureBackend("beta"),
    ]);

    expect(registry.listBackends()).toEqual(["alpha", "beta"]);
  });

  it("exports and returns the default backend name", () => {
    const registry = createBackendRegistry([fixtureBackend("alpha")]);

    expect(defaultBackendName).toBe("claude-code");
    expect(registry.defaultBackendName).toBe(defaultBackendName);
  });

  it("rejects duplicate backend names when constructing the registry", () => {
    expect(() =>
      createBackendRegistry([
        fixtureBackend("duplicate"),
        fixtureBackend("duplicate"),
      ]),
    ).toThrow("Duplicate spawn backend name: duplicate");
  });
});
