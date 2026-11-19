// Invoked by deployed conductor skills from the selected Git checkout.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args, env = process.env, timeout = 30_000) {
  return spawnSync(command, args, {
    env, timeout, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
}

function fail(message) {
  process.stderr.write(message + "\n");
  return 1;
}

function ghArgs(args, repo) {
  if (args[0] === "api") return args;
  if (args[0] === "repo") return ["repo", "view", repo, ...args.slice(2)];
  return [...args, "--repo", repo];
}

function confirmedUnauthorized(command, stderr) {
  return command === "gh"
    ? /^gh: [^\r\n]*\(HTTP 401\)\s*$|^HTTP 401:/m.test(stderr)
    : /^fatal: [^\r\n]*The requested URL returned error: 401\s*$/m.test(stderr);
}

function main() {
  const [command, access, ...args] = process.argv.slice(2);
  if (!["repo", "gh", "fetch"].includes(command)) return fail("Invalid conductor forge operation.");

  const remote = run("git", ["config", "--get", "remote.origin.url"], process.env, 5_000);
  const match = remote.stdout?.trim().match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|ssh:\/\/git@ssh\.github\.com:443\/|git@github\.com:)([\w.-]+\/[\w.-]+?)\/?$/i,
  );
  if (remote.status !== 0 || !match) return fail("Could not resolve a GitHub repository from origin.");
  const repo = match[1].replace(/\.git$/i, "");
  if (repo.split("/").some(part => !part || part === "." || part === "..")) {
    return fail("Could not resolve a GitHub repository from origin.");
  }
  if (command === "repo") {
    process.stdout.write(repo + "\n");
    return 0;
  }

  // Keep ambient credentials out of every forge child, and pass only the
  // explicitly opted-in migration credential to the Tessera CLI.
  const env = { ...process.env };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
    "GH_DEBUG", "DEBUG", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CURL_VERBOSE", "MARCH_TESSERA_CLIENT_KEY",
    ...Object.keys(env).filter(name => name.startsWith("GIT_TRACE"))]) {
    delete env[key];
  }
  const repoUrl = `https://github.com/${repo}.git`;
  const gitHeaderKey = `http.${repoUrl}.extraHeader`;
  for (const refresh of [false, true]) {
    const configDir = command === "gh" ? mkdtempSync(join(tmpdir(), "march-conductor-gh-")) : undefined;
    try {
      const issuance = run("march", [
        "tessera", "token", "--repo", repo, "--access", access, "--identity", "app",
        "--allow-migration-fallback", ...(refresh ? ["--refresh"] : []),
      ], { ...process.env, MARCH_OTEL_SERVICE_NAME: "march-legate" }, 12_000);
      const token = issuance.stdout?.trim();
      if (issuance.status !== 0 || !token || /\s/.test(token)) {
        const typedError = issuance.stderr?.match(/Tessera token request failed \([a-z_]+\)\./)?.[0];
        return fail(typedError || "Tessera token request failed.");
      }

      const result = command === "gh"
        ? run("gh", ghArgs(args, repo), {
            ...env, GH_TOKEN: token, GH_CONFIG_DIR: configDir, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1",
            GH_REPO: `github.com/${repo}`, GH_NO_UPDATE_NOTIFIER: "1",
          })
        : run("git", [
            "-c", "credential.helper=", "-c", "http.extraHeader=", "-c", `${gitHeaderKey}=`,
            "-c", "http.followRedirects=false", `--config-env=${gitHeaderKey}=MARCH_GIT_AUTH`,
            "fetch", "--quiet", "--no-recurse-submodules", "--", repoUrl, ...args,
          ], {
            ...env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https",
            GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG_COUNT: undefined,
            MARCH_GIT_AUTH: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          });

      if (result.status === 0) {
        process.stdout.write(result.stdout);
        return 0;
      }
      if (!refresh && confirmedUnauthorized(command, result.stderr || "")) continue;
      return fail(command === "gh" ? "GitHub CLI operation failed." : "GitHub fetch failed.");
    } finally {
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    }
  }
  return 1;
}

try {
  process.exitCode = main();
} catch {
  process.exitCode = fail("Could not complete the conductor forge operation.");
}
