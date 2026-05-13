import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readPackageVersion(): string {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      return (require(candidate) as { version: string }).version;
    } catch {
      // Source imports resolve via ../../package.json; bundled dist resolves
      // via ../package.json. Try both before surfacing the module error.
    }
  }
  return (require("../../package.json") as { version: string }).version;
}

export const CLI_VERSION: string = readPackageVersion();
