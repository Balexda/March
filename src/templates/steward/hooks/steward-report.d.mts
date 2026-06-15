// Type declarations for the self-contained steward self-report hook (#371).
// The runtime file is plain JS (shipped verbatim to ~/.march/steward/hooks);
// this lets TypeScript callers (the unit test) import its pure helpers with
// types while `tsc` stays `allowJs: false`.

export interface LastAssistantMessage {
  readonly text: string;
  readonly usedAskUserQuestion: boolean;
}

export type StewardReportStatus = "awaiting_input" | "reported" | "working";

export interface ClassifyResult {
  readonly status?: StewardReportStatus;
  readonly summary?: string;
  readonly classified: boolean;
}

export function clampSummary(text: string | null | undefined, max?: number): string;

export function extractLastAssistantMessage(
  transcriptText: string,
): LastAssistantMessage | null;

export function classify(
  message: LastAssistantMessage | null | undefined,
  eventName: string,
): ClassifyResult;

export function stewardRootFromHook(scriptPath: string): string;

export function sessionFileFor(root: string, cwd: string): string;
