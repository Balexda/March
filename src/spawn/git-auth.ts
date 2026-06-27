/**
 * Per-invocation `git -c …` config that rewrites GitHub SSH remotes to
 * token-authenticated HTTPS, so a container with no ssh client / key / agent can
 * still fetch over the network (#300/#301 live-validation: the `march-herald`
 * image has no openssh, and `$HOME/.ssh` carried only a `config`, so
 * `git fetch origin` died with "cannot run ssh"). The token is the same
 * `GH_TOKEN` / `GITHUB_TOKEN` the rest of the stack uses for GitHub — passed
 * PER COMMAND (never written to the repo's config / disk), so it isn't
 * persisted. Returns `[]` when no token is set, in which case git uses the
 * remote as-is (unchanged behaviour — host-credential / SSH paths still work).
 *
 * Both the scp-short (`git@github.com:`) and `ssh://` remote forms are rewritten
 * to the SAME authenticated HTTPS base; git accumulates the repeated multi-valued
 * `insteadOf` entries (verified) so both rules apply.
 *
 * Shared by Herald's default-branch sync (`src/observe/sense-io.ts`) and the
 * Hatchery spawn base-pin (`src/hatchery/spawn-handoff.ts`, #460) so both fetch
 * the same way inside their containers.
 */
export function gitHubAuthConfigArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const token = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
  if (!token) return [];
  const https = `https://x-access-token:${token}@github.com/`;
  return [
    "-c",
    `url.${https}.insteadOf=git@github.com:`,
    "-c",
    `url.${https}.insteadOf=ssh://git@github.com/`,
  ];
}
