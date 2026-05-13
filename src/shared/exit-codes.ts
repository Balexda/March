/**
 * Process exit codes for the March CLI.
 */

/** Command completed successfully. */
export const SUCCESS = 0;

/** Command failed due to a runtime error. */
export const ERROR = 1;

/** Command failed due to incorrect usage (bad args, unknown command). */
export const USAGE_ERROR = 2;
