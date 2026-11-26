import type { ProviderAdapter, ProviderName } from "../types.js";
import { withRetry } from "./with-retry.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";

export { AnthropicProvider, OllamaProvider };

/**
 * Env-driven provider map for the harness (local-first: Ollama always works
 * with no API key; Anthropic joins when ANTHROPIC_API_KEY is set).
 *
 *   ANTHROPIC_API_KEY    enables the Anthropic provider
 *   ANTHROPIC_MODEL      default claude-sonnet-4-6
 *   OLLAMA_BASE_URL      default http://localhost:11434
 *   OLLAMA_MODEL         default llama3.1 (must be a tool-capable model)
 *   AGENT_DEFAULT_PROVIDER  "anthropic" | "ollama" (default: anthropic when keyed)
 */
export function buildProviders(env: NodeJS.ProcessEnv = process.env): {
  providers: Partial<Record<ProviderName, ProviderAdapter>>;
  defaultProvider: ProviderName;
} {
  // Every provider is wrapped, so a dropped stream costs a retry rather than
  // the run. AGENT_PROVIDER_ATTEMPTS=1 disables it.
  const attempts = env.AGENT_PROVIDER_ATTEMPTS ? Number(env.AGENT_PROVIDER_ATTEMPTS) : undefined;
  const retrying = (p: ProviderAdapter): ProviderAdapter => withRetry(p, { attempts });

  const providers: Partial<Record<ProviderName, ProviderAdapter>> = {
    ollama: retrying(
      new OllamaProvider(
        env.OLLAMA_MODEL ?? "llama3.1",
        env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      ),
    ),
  };
  if (env.ANTHROPIC_API_KEY) {
    providers.anthropic = retrying(
      new AnthropicProvider(env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"),
    );
  }

  const requested = env.AGENT_DEFAULT_PROVIDER as ProviderName | undefined;
  const defaultProvider: ProviderName =
    requested && providers[requested]
      ? requested
      : providers.anthropic
        ? "anthropic"
        : "ollama";

  return { providers, defaultProvider };
}
