import { createInterface } from "node:readline";
import { ERROR, SUCCESS, USAGE_ERROR } from "../shared/exit-codes.js";
import { TesseraClientError } from "./client.js";
import { REPO_PATTERN } from "./models.js";
import { issueTesseraCliToken } from "./token-cli.js";

export async function runTesseraGitCredential(operation: string): Promise<number> {
  if (operation !== "get" && operation !== "store" && operation !== "erase") {
    process.stderr.write("Usage: march tessera git-credential <get|store|erase>\n");
    return USAGE_ERROR;
  }

  const fields = new Map<string, string>();
  let ambiguous = false;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (line === "") break;
      if (operation !== "get") continue;
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      if (separator < 0 || key === "url") ambiguous = true;
      if (key !== "host" && key !== "path" && key !== "protocol") continue;
      if (fields.has(key)) ambiguous = true;
      fields.set(key, line.slice(separator + 1));
    }
    if (operation !== "get") return SUCCESS;

    const host = fields.get("host")?.toLowerCase();
    const repo = fields.get("path")?.replace(/\.git$/i, "");
    if (host && !ambiguous && !/^github\.com\.?(?::|$)/.test(host)) return SUCCESS;
    if (ambiguous || (host !== "github.com" && host !== "github.com:443") ||
      fields.get("protocol") !== "https" || !repo || /\s/.test(repo) ||
      !REPO_PATTERN.test(repo) || repo.split("/").some(part => part === "." || part === "..")) {
      throw new TesseraClientError("invalid_repository_context");
    }
    const token = await issueTesseraCliToken({ repo, access: "write", identity: "app" });
    process.stdout.write(`username=x-access-token\npassword=${token}\n\n`);
    return SUCCESS;
  } catch (error) {
    const code = error instanceof TesseraClientError ? error.code : "invalid_request";
    // Git ignores helper exit status when deciding whether to try another helper.
    process.stdout.write("quit=true\n\n");
    process.stderr.write(`Tessera Git credential request failed (${code}).\n`);
    return ERROR;
  } finally {
    input.close();
  }
}
