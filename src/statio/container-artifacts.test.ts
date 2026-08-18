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

function flattenPanels(panel: unknown): Array<Record<string, unknown>> {
  if (!panel || typeof panel !== "object") return [];
  const record = panel as Record<string, unknown>;
  const children = Array.isArray(record.panels)
    ? record.panels.flatMap((child) => flattenPanels(child))
    : [];
  return [record, ...children];
}

function targetExpressions(dashboard: Record<string, unknown>): string[] {
  const panels = Array.isArray(dashboard.panels) ? dashboard.panels : [];
  return panels.flatMap((panel) =>
    flattenPanels(panel).flatMap((flatPanel) => {
      const targets = Array.isArray(flatPanel.targets) ? flatPanel.targets : [];
      return targets.flatMap((target) => {
        if (!target || typeof target !== "object") return [];
        const expr = (target as Record<string, unknown>).expr;
        return typeof expr === "string" ? [expr] : [];
      });
    }),
  );
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
    expect(compose).toContain("MARCH_OTEL=${MARCH_OTEL:-1}");
    expect(compose).toContain("external: true");
    expect(compose).toContain("name: march");
    expect(compose).not.toMatch(/-\s*"0\.0\.0\.0:\$\{MARCH_STATIO_PORT:-9689\}/);
    expect(compose).not.toMatch(/-\s*"\$\{MARCH_STATIO_PORT:-9689\}:/);
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

  it("provisions a parseable Statio Grafana dashboard with the existing provider", () => {
    const provider = read("docker/grafana/provisioning/dashboards/march.yaml");
    const dashboard = JSON.parse(read("docker/grafana/dashboards/march-statio.json")) as {
      title?: string;
      uid?: string;
      panels?: unknown[];
    };

    expect(provider).toContain("path: /etc/march/dashboards");
    expect(provider).toContain('folder: "March"');
    expect(dashboard.title).toBe("March — Statio forge gateway");
    expect(dashboard.uid).toBe("march-statio");
    expect(dashboard.panels?.length).toBeGreaterThan(0);
  });

  it("keeps Statio dashboard queries on service-owned low-cardinality labels", () => {
    const dashboard = JSON.parse(
      read("docker/grafana/dashboards/march-statio.json"),
    ) as Record<string, unknown>;
    const dashboardText = JSON.stringify(dashboard);
    const expressions = targetExpressions(dashboard);

    expect(dashboardText).toContain("service.name");
    expect(dashboardText).toContain("march-statio");
    expect(expressions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("march_statio_requests_total"),
        expect.stringContaining("march_statio_request_duration_seconds_bucket"),
        expect.stringContaining("march_statio_heartbeat_total"),
        expect.stringContaining("march_statio_uptime_seconds"),
      ]),
    );
    expect(dashboardText).toContain("Recent Statio logs");
    expect(dashboardText).toContain("Recent Statio traces");
    expect(dashboardText).not.toMatch(/\b(pr|number|path|slice_id|token)=/);
    expect(dashboardText).not.toContain("MARCH_STATIO_TOKEN");
  });
});
