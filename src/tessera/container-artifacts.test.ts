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

/** Strip `#` comments so assertions only see the effective compose config. */
function effective(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

/** Every entry listed under a `ports:` key in the compose file. */
function portEntries(compose: string): string[] {
  const lines = effective(compose).split("\n");
  const entries: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)ports:\s*$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") continue;
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) break;
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) entries.push(item[1].replace(/^["']|["']$/g, ""));
    }
  }
  return entries;
}

describe("tessera container artifacts", () => {
  it("exposes the image build script through npm and chains it into build:images", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    expect(pkg.scripts["build:tessera-image"]).toBe(
      "docker build -t march-tessera:latest -f docker/tessera.Dockerfile .",
    );
    expect(pkg.scripts["build:images"]).toContain("npm run build:tessera-image");
  });

  it("packages the Tessera runtime without gh, git or host-control tooling", () => {
    const dockerfile = read("docker/tessera.Dockerfile");
    const body = effective(dockerfile);

    expect(body).toContain("RUN npm run build");
    expect(body).toContain("ln -sf /app/dist/cli.js /usr/local/bin/march");
    expect(body).toContain('ENTRYPOINT ["march"]');
    expect(body).toContain('CMD ["tessera", "serve", "--host", "0.0.0.0"]');
    expect(body).not.toMatch(/\bgh\b/);
    expect(body).not.toMatch(/\bgit\b/);
    expect(body).not.toContain("githubcli");
    expect(body).not.toContain("docker.sock");
    expect(body).not.toContain("agent-deck");
    expect(body).not.toContain("tmux");
  });

  it("binds loopback only, joins the march network, and health-checks /healthz", () => {
    const compose = read("docker/tessera.docker-compose.yml");
    const body = effective(compose);

    expect(body).toContain("name: march-tessera");
    expect(body).toMatch(/^\s{2}tessera:\s*$/m);
    expect(body).toContain(
      'command: ["tessera", "serve", "--host", "0.0.0.0", "--port", "${MARCH_TESSERA_PORT:-9477}"]',
    );
    expect(portEntries(compose)).toEqual([
      "127.0.0.1:${MARCH_TESSERA_PORT:-9477}:${MARCH_TESSERA_PORT:-9477}",
    ]);
    expect(body).toContain("/healthz");
    expect(body).toMatch(/healthcheck:\s*\n\s*test:.*http:\/\/localhost:\$\{MARCH_TESSERA_PORT:-9477\}\/healthz/);
    expect(body).toContain("external: true");
    expect(body).toMatch(/networks:\s*\n\s*march:\s*\n\s*external: true\s*\n\s*name: march/);
    expect(body).toContain("MARCH_OTEL=${MARCH_OTEL:-1}");
    expect(body).toContain("MARCH_OTEL_ENDPOINT=http://otel-lgtm:4318");
    expect(body).toContain("MARCH_OTEL_SERVICE_NAME=march-tessera");
    expect(body).toContain("MARCH_TESSERA_LOG_DIR=/march/logs");
    expect(body).toContain("march-tessera-logs:/march/logs");
  });

  it("rejects any non-loopback port publication", () => {
    const compose = read("docker/tessera.docker-compose.yml");
    const entries = portEntries(compose);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.startsWith("127.0.0.1:")).toBe(true);
    }
    // Sanity-check the guard itself: a bare or 0.0.0.0 publication is caught.
    const bad = portEntries(
      'services:\n  x:\n    ports:\n      - "0.0.0.0:9477:9477"\n      - "9477:9477"\n',
    );
    expect(bad.filter((entry) => !entry.startsWith("127.0.0.1:"))).toHaveLength(2);
  });

  it("mounts no host HOME or docker socket and passes no GitHub tokens", () => {
    const body = effective(read("docker/tessera.docker-compose.yml"));

    expect(body).not.toContain("docker.sock");
    expect(body).not.toContain("MARCH_HOST_");
    expect(body).not.toMatch(/\bHOME=/);
    expect(body).not.toContain("XDG_");
    expect(body).not.toContain("GH_TOKEN");
    expect(body).not.toContain("GITHUB_TOKEN");
    expect(body).not.toContain("/tmp/tmux-");
    expect(body).not.toContain(":?");
  });

  it("passes the GitHub App settings through as optional values", () => {
    const body = effective(read("docker/tessera.docker-compose.yml"));

    expect(body).toContain("TESSERA_GITHUB_APP_ID=${TESSERA_GITHUB_APP_ID:-}");
    expect(body).toContain("TESSERA_GITHUB_APP_KEY_FILE=${TESSERA_GITHUB_APP_KEY_FILE:-}");
    expect(body).toContain(
      "TESSERA_GITHUB_INSTALLATION_ID=${TESSERA_GITHUB_INSTALLATION_ID:-}",
    );
  });

  it("documents setup, the optional App settings, and what arrives later", () => {
    const compose = read("docker/tessera.docker-compose.yml");

    expect(compose).toContain("npm run build:tessera-image");
    expect(compose).toContain("HOST-SPECIFIC CONFIG");
    expect(compose).toContain("TESSERA_GITHUB_APP_ID");
    expect(compose).toContain("User Story 3");
    expect(compose).toContain("User Story 2");
    expect(compose).toMatch(/unauthenticated/i);
  });
});
