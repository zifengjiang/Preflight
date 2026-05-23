import { generateScriptFromVisualFlow } from "./codegen.js";
import { tryParseVisualFlow } from "./validate.js";
import type { VisualFlowDocument } from "./types.js";

export type { VisualFlowDocument, VisualStep, VisualFlowScriptVar } from "./types.js";

export type VisualFlowValidationResult =
  | { ok: true; value: VisualFlowDocument }
  | { ok: false; message: string };

export function validateVisualFlow(raw: unknown): VisualFlowValidationResult {
  return tryParseVisualFlow(raw);
}

export async function compileVisualFlow(raw: unknown): Promise<string> {
  const parsed = tryParseVisualFlow(raw);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return generateScriptFromVisualFlow(parsed.value, {
    loadCase: async () => null,
  });
}
