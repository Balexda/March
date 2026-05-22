import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeCodeBackend,
  codexBackend,
  CONTAINER_WORKDIR,
  defaultBackendName,
  getBackend,
  listBackends,
  missingCredentialMounts,
  missingRequiredEnvVars,
  resolveBackendSelection,
  resolveCredentialMounts,
  type SpawnBackend,
} from "./backends.js";

const expectedBackendKeys = [
  "allowedEgressHosts",
  "baseImage",
  "buildEntrypoint",
  "credentialMounts",
  "name",
  "requiredEnvVars",
];

describe("spawn backends", () => {
  it("keeps the SpawnBackend contract at the F4 six-member surface", () => {
    const fixtureBackend: SpawnBackend = {
      name: "fixture",
      baseImage: "fixture-image:latest",
      requiredEnvVars: [],
      credentialMounts: [],
      buildEntrypoint: () => ["sh", "-c", "true"],
      allowedEgressHosts: ["api.example.test"],
    };

    for (const backend of [claudeCodeBackend, codexBackend, fixtureBackend]) {
      expect(Object.keys(backend).sort()).toEqual(expectedBackendKeys);
    }
  });

  it("lists registered backend names in stable order", () => {
    expect(listBackends()).toEqual(["claude-code", "codex"]);
  });

  it("defaults to Claude Code for backward-compatible dispatch", () => {
    expect(defaultBackendName).toBe("claude-code");
    expect(resolveBackendSelection({}).backend).toBe(claudeCodeBackend);
  });

  it("resolves flag over env var", () => {
    const selection = resolveBackendSelection({
      flagValue: "codex",
      envValue: "claude-code",
    });
    expect(selection.source).toBe("flag");
    expect(selection.backend).toBe(codexBackend);
  });

  it("resolves MARCH_BACKEND when the flag is absent", () => {
    const selection = resolveBackendSelection({ envValue: "codex" });
    expect(selection.source).toBe("env");
    expect(selection.backend).toBe(codexBackend);
  });

  it("returns undefined for unknown backends", () => {
    expect(getBackend("missing")).toBeUndefined();
    expect(resolveBackendSelection({ flagValue: "missing" })).toMatchObject({
      requestedName: "missing",
      source: "flag",
      backend: undefined,
    });
  });

  it("defines the Claude Code backend", () => {
    expect(claudeCodeBackend.baseImage).toBe("march-spawn-claude:latest");
    expect(claudeCodeBackend.requiredEnvVars).toEqual(["ANTHROPIC_API_KEY"]);
    expect(claudeCodeBackend.credentialMounts).toEqual([]);
    expect(claudeCodeBackend.allowedEgressHosts).toEqual(["api.anthropic.com"]);
    expect(claudeCodeBackend.buildEntrypoint("/march/prompt.txt")).toEqual([
      "sh",
      "-c",
      'claude -p "$(cat /march/prompt.txt)" --output-format json --dangerously-skip-permissions --bare --no-session-persistence',
    ]);
  });

  it("defines the Codex exec backend for ChatGPT session auth", () => {
    expect(codexBackend.baseImage).toBe("march-spawn-codex:latest");
    expect(codexBackend.requiredEnvVars).toEqual([]);
    expect(codexBackend.allowedEgressHosts).toEqual(["chatgpt.com"]);
    expect(codexBackend.buildEntrypoint("/march/prompt.txt")).toEqual([
      "sh",
      "-c",
      `cp -R /march/codex-auth/. /march/codex-home/ && chmod -R u+rwX /march/codex-home && codex exec --json --ephemeral --ignore-rules --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd ${CONTAINER_WORKDIR} - < /march/prompt.txt`,
    ]);
  });

  it("resolves Codex credential mounts from CODEX_HOME", () => {
    expect(
      resolveCredentialMounts(codexBackend, {
        CODEX_HOME: "/tmp/codex-home",
        HOME: "/tmp/home",
      }),
    ).toEqual([
      {
        hostPath: "/tmp/codex-home",
        containerPath: "/march/codex-auth",
        readOnly: true,
        env: { CODEX_HOME: "/march/codex-home" },
      },
    ]);
  });

  it("falls back to HOME/.codex for Codex credentials", () => {
    expect(
      resolveCredentialMounts(codexBackend, { HOME: "/tmp/home" })[0]
        .hostPath,
    ).toBe("/tmp/home/.codex");
  });

  it("treats missing or empty required env vars as absent", () => {
    expect(missingRequiredEnvVars(claudeCodeBackend, {})).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
    expect(
      missingRequiredEnvVars(claudeCodeBackend, { ANTHROPIC_API_KEY: "" }),
    ).toEqual(["ANTHROPIC_API_KEY"]);
    expect(
      missingRequiredEnvVars(claudeCodeBackend, { ANTHROPIC_API_KEY: "x" }),
    ).toEqual([]);
  });

  it("detects missing credential directories", () => {
    const missing = missingCredentialMounts(codexBackend, {
      CODEX_HOME: "/path/that/does/not/exist",
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].hostPath).toBe("/path/that/does/not/exist");
  });

  it("rejects credential paths that exist but are not directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "march-codex-home-"));
    const filePath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(filePath, "not a directory\n");
    try {
      const missing = missingCredentialMounts(codexBackend, {
        CODEX_HOME: filePath,
      });
      expect(missing).toHaveLength(1);
      expect(missing[0].hostPath).toBe(filePath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts readable credential directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "march-codex-home-"));
    try {
      expect(
        missingCredentialMounts(codexBackend, {
          CODEX_HOME: tmpDir,
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
