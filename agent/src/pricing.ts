/**
 * $ per million tokens, keyed by model id. Both the run row's total and the
 * per-call ledger rows are costed from this; without it every run records
 * zero, which reads as "free" rather than "unknown".
 *
 * Published prices change, so treat this as a default rather than a source of
 * truth: AGENT_PRICING_JSON overrides or extends it at runtime, e.g.
 *
 *   AGENT_PRICING_JSON='{"claude-sonnet-4-6":{"inputPerMTok":3,"outputPerMTok":15}}'
 *
 * Local models are listed at zero deliberately: they are genuinely free to
 * call, and listing them keeps "zero because local" distinguishable from
 * "zero because the model is missing from the table" (see unpricedModels).
 */

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export type PricingTable = Record<string, ModelPrice>;

export const DEFAULT_PRICING: PricingTable = {
  // Anthropic, list prices as of this writing.
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
  // Local inference: no marginal cost per token.
  "llama3.1": { inputPerMTok: 0, outputPerMTok: 0 },
  "qwen2.5": { inputPerMTok: 0, outputPerMTok: 0 },
  "nomic-embed-text": { inputPerMTok: 0, outputPerMTok: 0 },
};

export function loadPricing(env: NodeJS.ProcessEnv = process.env): PricingTable {
  if (!env.AGENT_PRICING_JSON) return { ...DEFAULT_PRICING };
  try {
    const override = JSON.parse(env.AGENT_PRICING_JSON) as PricingTable;
    return { ...DEFAULT_PRICING, ...override };
  } catch {
    console.warn("AGENT_PRICING_JSON is not valid JSON; using default pricing");
    return { ...DEFAULT_PRICING };
  }
}

/** Models a run used that carry no price, so a zero total can be explained. */
export function unpricedModels(table: PricingTable, models: Iterable<string>): string[] {
  return [...new Set(models)].filter((m) => !(m in table));
}
