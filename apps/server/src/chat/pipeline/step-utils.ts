/**
 * Phase 6.3 — small shared helpers for pipeline steps.
 *
 * Lives outside any single step file so the orchestrator + tests can
 * import the helpers without dragging a step's dependencies along.
 */

/**
 * Marker error every step throws when its LLM output fails the zod
 * contract. The orchestrator translates this into the §4.1 "retry
 * once, then mark step failed with `error_code='invalid_step_output'`"
 * policy and routes the message to a graceful "I couldn't process
 * that" assistant answer.
 *
 * Note: the orchestrator inspects `error instanceof InvalidStepOutputError`,
 * so test fixtures importing from `chat/pipeline/step-utils` see the
 * same constructor identity as production code.
 */
export class InvalidStepOutputError extends Error {
  readonly stepKind: string;
  readonly errorCode = 'invalid_step_output';

  constructor(stepKind: string, message: string) {
    super(`invalid_step_output[${stepKind}]: ${message}`);
    this.name = 'InvalidStepOutputError';
    this.stepKind = stepKind;
  }
}

/**
 * Best-effort JSON extraction from a model response. Strips a
 * ` ```json ... ``` ` fence if the model produced one despite the
 * system prompt asking for raw JSON. Returns `null` when nothing
 * JSON-shaped is in the string (callers convert that to a zod parse
 * failure so the retry path kicks in).
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const stripped = stripFence(trimmed);
  try {
    return JSON.parse(stripped);
  } catch {
    // One more shot: pull the first {...} substring.
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function stripFence(text: string): string {
  if (!text.startsWith('```')) return text;
  // Drop the opening fence (` ```json ` or ` ``` `) and the trailing ` ``` `.
  const firstNl = text.indexOf('\n');
  if (firstNl === -1) return text;
  const body = text.slice(firstNl + 1);
  const lastFence = body.lastIndexOf('```');
  return lastFence === -1 ? body : body.slice(0, lastFence);
}

/**
 * Sleeps the given milliseconds. Used by the inline retry helper.
 * Kept here so the orchestrator + steps share one impl.
 */
export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
