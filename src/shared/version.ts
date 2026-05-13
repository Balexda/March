import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readPackageVersion(): string {
  const candidates = ["../package.json", "../../package.json"] as const;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return (require(candidate) as { version: string }).version;
    } catch (err) {
      // Source imports resolve via ../../package.json; bundled dist resolves
      // via ../package.json. Try both before surfacing the module error.
      lastError = err;
    }
  }
  const cause =
    lastError instanceof Error && lastError.message ? ` Last error: ${lastError.message}` : "";
  throw new Error(
    `Unable to locate package.json for CLI version. Tried: ${candidates.join(", ")}.${cause}`,
  );
}

export const CLI_VERSION: string = readPackageVersion();
