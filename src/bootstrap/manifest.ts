/**
 * MarchManifest tracks the state of a March installation.
 *
 * Stored at `~/.march/march-manifest.json`.
 */
export interface MarchManifest {
  /** Manifest schema version. Fixed at 1 for initial release. */
  version: number;

  /** Semantic version of the March CLI that created or last updated this manifest. */
  marchVersion: string;

  /** Deployment location. Always "user" for March. */
  deployLocation: string;

  /** Array of agent backends with deployed files. */
  agents: string[];

  /** Map of agent name to array of relative file paths deployed for that agent. */
  files: Record<string, string[]>;
}

/**
 * Checks whether a parsed JSON value has the shape of a valid MarchManifest.
 * Returns true only if all required fields are present with correct types.
 */
export function isValidManifest(value: unknown): value is MarchManifest {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.version === "number" &&
    typeof obj.marchVersion === "string" &&
    typeof obj.deployLocation === "string" &&
    Array.isArray(obj.agents) &&
    obj.agents.every((a: unknown) => typeof a === "string") &&
    typeof obj.files === "object" &&
    obj.files !== null
  );
}

/**
 * Creates a new MarchManifest with default values.
 *
 * @param cliVersion - The semantic version of the March CLI.
 * @returns A fresh manifest ready to be written to disk.
 */
export function createManifest(cliVersion: string): MarchManifest {
  return {
    version: 1,
    marchVersion: cliVersion,
    deployLocation: "user",
    agents: ["claude"],
    files: { claude: [] },
  };
}
