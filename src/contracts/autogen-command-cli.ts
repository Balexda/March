import {
  formatArgumentDiagnostics,
  formatAutogenCommandResult,
  parseAutogenCommandArgs,
  runAutogenCommand,
} from "./autogen-command.js";

const parsed = parseAutogenCommandArgs(process.argv.slice(2));

if (!parsed.mode || parsed.diagnostics.length > 0) {
  process.stdout.write(formatArgumentDiagnostics(parsed.diagnostics));
  process.exitCode = 2;
} else {
  const result = runAutogenCommand({
    mode: parsed.mode,
    repoRoot: parsed.repoRoot,
    configPath: parsed.configPath,
  });
  process.stdout.write(formatAutogenCommandResult(result));
  process.exitCode = result.status === "pass" ? 0 : 1;
}
