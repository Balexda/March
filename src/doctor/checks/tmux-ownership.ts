import { containerName } from "../../stack/services.js";
import type { DoctorContext } from "../context.js";
import type { CheckResult, Finding } from "../types.js";

/**
 * tmux server ownership — the default tmux server must run on the host, not
 * inside the castra container.
 *
 * castra is a containerized agent-deck that drives sessions over the host tmux
 * socket bind-mounted at `/tmp/tmux-<uid>/default`. Whichever process first
 * touches that socket *becomes* the server, and every pane it spawns — stewards
 * and the operator's own shells alike — runs in that process's namespace. If the
 * castra container won the race (e.g. it autostarted ahead of `march up`), the
 * server runs *inside* the container and new sessions open as a bare
 * `node@<container>` bash shell instead of the host shell. `march up` claims the
 * server host-side first (see ensureHostTmuxServer in src/stack/up.ts); this
 * check detects when that ownership has been lost.
 *
 * Read-only: compares the server's hostname (`#{host}`, evaluated server-side)
 * against this host's hostname. A mismatch means the server lives on another
 * machine — under Docker Desktop, the castra container, whose hostname is its
 * container id.
 */
export async function checkTmuxOwnership(ctx: DoctorContext): Promise<CheckResult> {
  const findings: Finding[] = [];
  const serverHost = ctx.tmuxServerHost();

  if (serverHost === null) {
    // No server reachable from here: tmux isn't installed, the server isn't up
    // yet, or `list-sessions` otherwise failed. The verdict depends on whether
    // the local stack is running. If castra is up, this is the same state
    // `march up` records as a failed anchor — castra may have won the socket
    // race and now owns a server we cannot inspect, so panes silently open
    // inside the container while ownership looks "fine". Warn rather than pass.
    if (ctx.containerState(containerName("castra")) === "running") {
      findings.push({
        check: "tmux-ownership",
        title: "tmux",
        severity: "warn",
        detail:
          "march-castra is running but no host tmux server is reachable — host " +
          "tmux ownership cannot be verified; castra may own the socket and " +
          "spawn sessions inside the container",
        remedy: "march down && march up (claims the host tmux server before castra starts)",
      });
      return { check: "tmux-ownership", findings };
    }
    // Stack is down (or castra absent): nothing to diagnose about ownership —
    // `march up` creates a host-owned server when it starts.
    findings.push({
      check: "tmux-ownership",
      title: "tmux",
      severity: "pass",
      detail: "no tmux server reachable and the stack is down (nothing to verify)",
    });
    return { check: "tmux-ownership", findings };
  }

  if (serverHost === ctx.localHostname) {
    findings.push({
      check: "tmux-ownership",
      title: "tmux",
      severity: "pass",
      detail: `tmux server is host-owned (${serverHost})`,
    });
    return { check: "tmux-ownership", findings };
  }

  // The server runs on a different host. Under Docker Desktop that is the castra
  // container (its hostname is the container id), so sessions spawn inside it.
  findings.push({
    check: "tmux-ownership",
    title: "tmux",
    severity: "warn",
    detail:
      `tmux server runs on "${serverHost}", not this host ("${ctx.localHostname}") — ` +
      "likely the march-castra container, so sessions open inside the container",
    remedy: "march down && march up (claims the host tmux server before castra starts)",
  });
  return { check: "tmux-ownership", findings };
}
