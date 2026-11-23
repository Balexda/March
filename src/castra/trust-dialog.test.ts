/**
 * @l0 @deterministic @ci
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  castraOwnedTrustDirs,
  isCastraOwnedDir,
  parseTrustDialog,
  resolveTrustDialog,
  type TrustDialogIo,
} from "./trust-dialog.js";

const ROOT = "/home/u/.march/steward";

function dialogPane(dir: string, cursorOnYes = false): string {
  return [
    "─".repeat(80),
    " Adding a new directory:",
    ` ${dir}`,
    "",
    " Claude Code will be able to read and edit files in this directory.",
    "",
    ` ${cursorOnYes ? " " : "❯"} No, exit`,
    ` ${cursorOnYes ? "❯" : " "} Yes, add it`,
    " Enter to confirm · Esc to cancel",
    "",
  ].join("\n");
}

/** A fake pane: Down/Up move the cursor, Enter on "Yes" closes the dialog, Enter on "No" exits. */
function fakePane(dir: string, opts: { stuck?: boolean } = {}) {
  let cursorOnYes = false;
  let open = true;
  let exited = false;
  const keys: string[] = [];
  const io: TrustDialogIo = {
    async capture() {
      if (exited) return "$ ";
      return open ? dialogPane(dir, cursorOnYes) : "❯ \n  ? for shortcuts";
    },
    async sendKey(key) {
      keys.push(key);
      if (key === "Down" && !opts.stuck) cursorOnYes = true;
      if (key === "Up" && !opts.stuck) cursorOnYes = false;
      if (key === "Enter") {
        if (cursorOnYes) open = false;
        else exited = true;
      }
    },
    async sleep() {},
  };
  return { io, keys, isExited: () => exited, isOpen: () => open };
}

describe("parseTrustDialog", () => {
  it("reads the directory and cursor from Claude's trust dialog", () => {
    expect(parseTrustDialog(dialogPane(ROOT))).toEqual({
      dir: ROOT,
      cursorOnYes: false,
      cursorOnNo: true,
      yesBelowNo: true,
    });
    expect(parseTrustDialog(dialogPane(ROOT, true))?.cursorOnYes).toBe(true);
  });

  it("accepts the directory on the header line and ignores ANSI colour", () => {
    const pane = `\x1b[1mAdding a new directory: ${ROOT}\x1b[0m\n❯ No, exit\n  Yes, add it`;
    expect(parseTrustDialog(pane)?.dir).toBe(ROOT);
  });

  it("is null without the header or without both options", () => {
    expect(parseTrustDialog("❯ No, exit\n  Yes, add it")).toBeNull();
    expect(parseTrustDialog(` Adding a new directory:\n ${ROOT}\n ❯ No, exit`)).toBeNull();
    expect(parseTrustDialog("❯ ready to work")).toBeNull();
  });
});

describe("isCastraOwnedDir", () => {
  const prev = process.env.MARCH_STEWARD_SKILLS_DIR;
  beforeEach(() => {
    process.env.MARCH_STEWARD_SKILLS_DIR = ROOT;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
    else process.env.MARCH_STEWARD_SKILLS_DIR = prev;
  });

  it("owns exactly the steward root and its plugin dir", () => {
    expect(castraOwnedTrustDirs()).toEqual([ROOT, path.join(ROOT, "plugin")]);
    expect(isCastraOwnedDir(ROOT)).toBe(true);
    expect(isCastraOwnedDir(`${ROOT}/`)).toBe(true);
    expect(isCastraOwnedDir(path.join(ROOT, "plugin"))).toBe(true);
  });

  it("does not own any other directory, including descendants, parents and look-alikes", () => {
    expect(isCastraOwnedDir("/home/u/.march")).toBe(false);
    expect(isCastraOwnedDir(path.join(ROOT, "sessions"))).toBe(false);
    expect(isCastraOwnedDir(`${ROOT}-evil`)).toBe(false);
    expect(isCastraOwnedDir("/home/u/src/other-repo")).toBe(false);
    expect(isCastraOwnedDir(`${ROOT}/../../.ssh`)).toBe(false);
  });

  it("expands ~ against the home directory", () => {
    const owned = [path.join(os.homedir(), ".march", "steward")];
    expect(isCastraOwnedDir("~/.march/steward", owned)).toBe(true);
    expect(isCastraOwnedDir("~/.ssh", owned)).toBe(false);
  });
});

describe("resolveTrustDialog", () => {
  it("moves to 'Yes, add it' and confirms it for Castra's own steward dir", async () => {
    const pane = fakePane(ROOT);
    const result = await resolveTrustDialog(pane.io, { ownedDirs: [ROOT] });
    expect(result).toEqual({ outcome: "resolved", dir: ROOT });
    expect(pane.keys).toEqual(["Down", "Enter"]);
    expect(pane.isExited()).toBe(false);
  });

  it("confirms directly when the cursor is already on 'Yes, add it'", async () => {
    const keys: string[] = [];
    let open = true;
    const result = await resolveTrustDialog(
      {
        capture: async () => (open ? dialogPane(ROOT, true) : ""),
        sendKey: async (k) => {
          keys.push(k);
          open = false;
        },
        sleep: async () => {},
      },
      { ownedDirs: [ROOT] },
    );
    expect(result.outcome).toBe("resolved");
    expect(keys).toEqual(["Enter"]);
  });

  it("reads the whole directory: an owned prefix with a space or quote is not owned", async () => {
    for (const dir of [`${ROOT} backup`, `${ROOT}"x`, `${ROOT}'s copy`]) {
      const pane = fakePane(dir);
      const result = await resolveTrustDialog(pane.io, { ownedDirs: [ROOT] });
      expect(result).toEqual({ outcome: "not_owned", dir });
      expect(pane.keys).toEqual([]);
    }
  });

  it("fails closed on a directory wrapped onto the next line", async () => {
    const pane = ` Adding a new directory:\n ${ROOT}\n-evil\n\n ❯ No, exit\n   Yes, add it`;
    expect(parseTrustDialog(pane)).toBeNull();
    const keys: string[] = [];
    const result = await resolveTrustDialog(
      { capture: async () => pane, sendKey: async (k) => { keys.push(k); }, sleep: async () => {} },
      { ownedDirs: [ROOT] },
    );
    expect(result.outcome).not.toBe("resolved");
    expect(keys).toEqual([]);
  });

  it("types nothing for a directory Castra does not own", async () => {
    const pane = fakePane("/home/u/src/other-repo");
    const result = await resolveTrustDialog(pane.io, { ownedDirs: [ROOT] });
    expect(result).toEqual({ outcome: "not_owned", dir: "/home/u/src/other-repo" });
    expect(pane.keys).toEqual([]);
  });

  it("never presses Enter while the cursor is on 'No, exit'", async () => {
    const pane = fakePane(ROOT, { stuck: true });
    const result = await resolveTrustDialog(pane.io, { ownedDirs: [ROOT], maxMoves: 3 });
    expect(result.outcome).toBe("failed");
    expect(pane.keys).not.toContain("Enter");
    expect(pane.isExited()).toBe(false);
  });

  it("reports not_shown when no dialog is on screen", async () => {
    const pane = fakePane(ROOT);
    await pane.io.sendKey("Down");
    await pane.io.sendKey("Enter");
    pane.keys.length = 0;
    expect(await resolveTrustDialog(pane.io, { ownedDirs: [ROOT] })).toEqual({ outcome: "not_shown" });
    expect(pane.keys).toEqual([]);
  });
});
