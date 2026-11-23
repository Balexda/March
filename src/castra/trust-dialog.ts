import os from "node:os";
import path from "node:path";
import { stewardPluginDir, stewardSkillsRoot } from "./steward-skills.js";

/**
 * Claude Code's directory-trust dialog, and when Castra may answer it.
 *
 * Stewards launched before #608 loaded the steward skills with `--add-dir
 * ~/.march/steward`. Since Claude Code 2.1.326 that raises
 *
 *     Adding a new directory:
 *     /home/<user>/.march/steward
 *     ❯ No, exit
 *       Yes, add it
 *
 * in the idle steward's composer. agent-deck then refuses every send ("composer
 * is occupied or unreadable"), so the steward never gets its manager prompt.
 *
 * Castra provisioned that directory itself, so it answers "Yes, add it" — but
 * only when the dialog names Castra's own steward root or plugin dir. A trust
 * dialog for any other directory is left for the operator and reported.
 *
 * The dialog defaults to "No, exit", and Enter on that option exits Claude.
 * {@link resolveTrustDialog} therefore moves the selection one step at a time,
 * re-reads the pane after each step, and presses Enter only when the cursor is
 * on "Yes, add it".
 */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const HEADER = /Adding a new directory/i;
const NO_OPTION = /No,\s*exit/i;
const YES_OPTION = /Yes,\s*add it/i;
const CURSOR = /[❯›>]/;
/** Box-drawing borders around the dialog; never part of a directory. */
const BORDER = /[\u2500-\u257f]/g;

export interface TrustDialog {
  /** The directory the dialog asks to trust, as printed (may start with `~`). */
  readonly dir: string;
  /** True when the cursor is on "Yes, add it". */
  readonly cursorOnYes: boolean;
  /** True when the cursor is on "No, exit". */
  readonly cursorOnNo: boolean;
  /** True when "Yes, add it" is listed below "No, exit". */
  readonly yesBelowNo: boolean;
}

/**
 * Parse a captured pane. Returns the dialog when the header and both options
 * are visible and the directory can be read; otherwise null.
 */
export function parseTrustDialog(pane: string): TrustDialog | null {
  const lines = pane.replace(ANSI, "").split("\n");
  const headerIdx = lines.findIndex((l) => HEADER.test(l));
  if (headerIdx < 0) return null;
  const noIdx = lines.findIndex((l, i) => i > headerIdx && NO_OPTION.test(l));
  const yesIdx = lines.findIndex((l, i) => i > headerIdx && YES_OPTION.test(l));
  if (noIdx < 0 || yesIdx < 0) return null;

  // The directory follows the header on the same line, or on the next line
  // that has text. It is that WHOLE line (borders and edge whitespace aside):
  // a directory with spaces or quotes is never cut down to an owned prefix.
  // Fail closed when the line is not a path, or when the next line is not
  // blank (a long path wrapped onto it, so this line is only a prefix).
  const clean = (text: string) => text.replace(BORDER, " ").trim();
  const afterHeader = clean((lines[headerIdx]!.split(HEADER)[1] ?? "").replace(/^\s*:/, ""));
  const between = lines.slice(headerIdx + 1, Math.min(noIdx, yesIdx)).map(clean);
  const candidates = [afterHeader, ...between];
  const at = candidates.findIndex((text) => text.length > 0);
  if (at < 0) return null;
  const dir = candidates[at]!;
  if (!/^(?:~|\/)/.test(dir) || dir.length < 2) return null;
  const next = candidates[at + 1];
  if (next !== undefined && next.length > 0) return null;

  const hasCursor = (line: string) => CURSOR.test(line.split(/No,|Yes,/)[0] ?? "");
  return {
    dir,
    cursorOnYes: hasCursor(lines[yesIdx]!),
    cursorOnNo: hasCursor(lines[noIdx]!),
    yesBelowNo: yesIdx > noIdx,
  };
}

function normalizeDir(dir: string): string {
  const expanded = dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir;
  const resolved = path.resolve(expanded);
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}

/** The directories Castra provisioned and may trust: the steward root and its plugin dir. */
export function castraOwnedTrustDirs(): string[] {
  return [normalizeDir(stewardSkillsRoot()), normalizeDir(stewardPluginDir())];
}

/** Is `dir` exactly one of Castra's own steward directories? Descendants and siblings are not. */
export function isCastraOwnedDir(dir: string, owned: readonly string[] = castraOwnedTrustDirs()): boolean {
  const normalized = normalizeDir(dir);
  return owned.some((o) => normalizeDir(o) === normalized);
}

/** Outcome of one attempt to answer a trust dialog. */
export type TrustDialogOutcome =
  /** "Yes, add it" was confirmed and the dialog is gone. */
  | "resolved"
  /** The dialog names a directory Castra does not own; nothing was typed. */
  | "not_owned"
  /** No trust dialog on screen. */
  | "not_shown"
  /** The dialog is Castra's but could not be answered safely. */
  | "failed";

export interface TrustDialogResolution {
  readonly outcome: TrustDialogOutcome;
  /** The directory the dialog named, when one was shown. */
  readonly dir?: string;
  /** Why a `failed` attempt stopped. */
  readonly detail?: string;
}

/** The pane access {@link resolveTrustDialog} needs. */
export interface TrustDialogIo {
  /** Visible pane text, or `""` when it can't be read. */
  capture(): Promise<string>;
  /** Send one tmux key name (`Down`, `Up`, `Enter`). */
  sendKey(key: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface ResolveTrustDialogOptions {
  /** Directories Castra may trust; defaults to {@link castraOwnedTrustDirs}. */
  readonly ownedDirs?: readonly string[];
  /** Wait after each key for the dialog to redraw. Default 300ms. */
  readonly settleMs?: number;
  /** Most selection moves before giving up. Default 3. */
  readonly maxMoves?: number;
}

/**
 * Answer a Castra-owned trust dialog with "Yes, add it". Never presses Enter
 * unless the cursor is verified on "Yes, add it"; never types anything for a
 * directory Castra does not own.
 */
export async function resolveTrustDialog(
  io: TrustDialogIo,
  options: ResolveTrustDialogOptions = {},
): Promise<TrustDialogResolution> {
  const owned = options.ownedDirs ?? castraOwnedTrustDirs();
  const settleMs = options.settleMs ?? 300;
  const maxMoves = options.maxMoves ?? 3;

  let dialog = parseTrustDialog(await io.capture());
  if (!dialog) return { outcome: "not_shown" };
  const dir = dialog.dir;
  if (!isCastraOwnedDir(dir, owned)) return { outcome: "not_owned", dir };

  for (let moves = 0; ; moves++) {
    if (dialog.cursorOnYes) {
      await io.sendKey("Enter");
      await io.sleep(settleMs);
      const after = parseTrustDialog(await io.capture());
      // Gone, or a different directory's dialog took its place: ours is answered.
      if (!after || normalizeDir(after.dir) !== normalizeDir(dir)) {
        return { outcome: "resolved", dir };
      }
      return { outcome: "failed", dir, detail: "the dialog was still shown after confirming" };
    }
    if (!dialog.cursorOnNo) {
      return { outcome: "failed", dir, detail: "the selection cursor could not be located" };
    }
    if (moves >= maxMoves) {
      return { outcome: "failed", dir, detail: `the selection did not reach "Yes, add it" after ${maxMoves} moves` };
    }
    await io.sendKey(dialog.yesBelowNo ? "Down" : "Up");
    await io.sleep(settleMs);
    const next = parseTrustDialog(await io.capture());
    if (!next) return { outcome: "failed", dir, detail: "the dialog closed before it was confirmed" };
    if (normalizeDir(next.dir) !== normalizeDir(dir)) {
      return { outcome: "failed", dir, detail: "the dialog changed directory while answering" };
    }
    dialog = next;
  }
}
