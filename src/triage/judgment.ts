import { validateTriageVerdict, type VerdictValidation } from "./verdict.js";

export interface TriageJudgmentInput {
  readonly title: string;
  readonly body: string;
  readonly repositoryContext: readonly string[];
  readonly rubricRevision: string;
}

export interface TriageJudgmentProvider {
  /** Evaluate untrusted issue text and return an untrusted JSON candidate. */
  judge(input: TriageJudgmentInput): Promise<string>;
}

export async function evaluateTriageJudgment(
  provider: TriageJudgmentProvider,
  { title, body, repositoryContext, rubricRevision }: TriageJudgmentInput,
): Promise<VerdictValidation> {
  const raw = await provider.judge({
    title,
    body,
    repositoryContext: [...repositoryContext],
    rubricRevision,
  });
  return validateTriageVerdict(raw);
}
