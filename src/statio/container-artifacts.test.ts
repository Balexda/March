/**
 * @l0 @deterministic @ci
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

describe("statio container artifacts", () => {
  it("exposes image build scripts through npm", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    expect(pkg.scripts["build:statio-image"]).toBe(
      "docker build -t march-statio:latest -f docker/statio.Dockerfile .",
    );
    expect(pkg.scripts["build:images"]).toContain("npm run build:statio-image");
  });

  it("packages the Statio runtime with only forge-read dependencies", () => {
    const dockerfile = read("docker/statio.Dockerfile");

    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends");
    expect(dockerfile).toContain(" gh ");
    expect(dockerfile).toContain(" git ");
    expect(dockerfile).toContain("ln -sf /app/dist/cli.js /usr/local/bin/march");
    expect(dockerfile).toContain('CMD ["statio", "serve", "--host", "0.0.0.0"]');
    expect(dockerfile).not.toContain("docker.sock");
    expect(dockerfile).not.toContain("agent-deck");
    expect(dockerfile).not.toContain("tmux");
  });

  it("requires a token, binds localhost, joins the march network, and starts the service", () => {
    const compose = read("docker/statio.docker-compose.yml");

    expect(compose).toContain(
      "MARCH_STATIO_TOKEN=${MARCH_STATIO_TOKEN:?MARCH_STATIO_TOKEN must be set;",
    );
    expect(compose).toContain(
      '"127.0.0.1:${MARCH_STATIO_PORT:-9689}:${MARCH_STATIO_PORT:-9689}"',
    );
    expect(compose).toContain(
      'command: ["statio", "serve", "--host", "0.0.0.0", "--port", "${MARCH_STATIO_PORT:-9689}"]',
    );
    expect(compose).toContain(
      "MARCH_STATIO_URL=${MARCH_STATIO_URL:-http://statio:${MARCH_STATIO_PORT:-9689}}",
    );
    expect(compose).toContain("external: true");
    expect(compose).toContain("name: march");
    expect(compose).not.toContain("/var/run/docker.sock");
    expect(compose).not.toContain("/tmp/tmux-");
    expect(compose).not.toContain(".local/bin");
  });

  it("redirects gh cache/state/data to a writable path so the read-only HOME does not break forge reads", () => {
    const compose = read("docker/statio.docker-compose.yml");

    expect(compose).toContain("XDG_CACHE_HOME=/tmp/gh/cache");
    expect(compose).toContain("XDG_STATE_HOME=/tmp/gh/state");
    expect(compose).toContain("XDG_DATA_HOME=/tmp/gh/data");
    expect(compose).toContain("GH_NO_UPDATE_NOTIFIER=1");
    // Config still resolves from the read-only HOME mount, so the config-dir
    // override must NOT be set (that would hide the mounted gh credentials).
    expect(compose).not.toContain("XDG_CONFIG_HOME=");
    // HOME remains mounted read-only.
    expect(compose).toContain(":ro");
  });
});
