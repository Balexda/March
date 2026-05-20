#!/usr/bin/env node
import { runCli } from "./cli/program.js";
import { initOtel } from "./observability/otel.js";

const otel = initOtel();
try {
  await runCli();
} finally {
  // Force-flush before the event loop drains; the CLI exits immediately after.
  await otel.shutdown();
}
