/**
 * Preflight each configured provider and print exactly why it fails.
 *
 * The harness fails over from Anthropic to Ollama on any provider error, and
 * until now it swallowed the reason unless OTLP tracing happened to be on.
 * That is why every run has silently landed on llama3.1 with no explanation.
 * This script makes one trivial tool-using call per provider and prints the
 * HTTP status and cause chain, which is normally the whole diagnosis:
 *
 *   401  the API key is missing, malformed or revoked
 *   403  the key is valid but not permitted for this model
 *   404  the model name does not exist (check ANTHROPIC_MODEL)
 *   429  rate limited
 *   529  the API is overloaded — retry
 *   ECONNREFUSED / fetch failed   nothing is listening (Ollama not running)
 *
 * Run it with the same environment the server uses:
 *
 *   cd agent && npx tsx scripts/provider-check.ts
 */

import { buildProviders } from "../src/providers/index.js";
import { formatError } from "../src/describe-error.js";
import type { ProviderAdapter, ToolSpec } from "../src/types.js";

// A single tool so the call exercises the same path a real step does: a
// provider can answer plain text and still reject a tool schema.
const PROBE_TOOL: ToolSpec = {
  name: "ping",
  description: "Returns the word pong. Call it exactly once.",
  inputSchema: {
    type: "object",
    properties: { note: { type: "string", description: "Anything." } },
    required: [],
    additionalProperties: false,
  },
};

async function probe(provider: ProviderAdapter): Promise<void> {
  const label = `${provider.name} (${provider.model})`;
  const started = Date.now();
  try {
    const turn = await provider.chat({
      system: "You are a connectivity probe. Call the ping tool, then stop.",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      tools: [PROBE_TOOL],
      maxTokens: 64,
      temperature: 0,
    });
    const ms = Date.now() - started;
    const calls = turn.toolCalls.map((c) => c.name).join(", ") || "none";
    console.log(`  OK   ${label}  ${ms}ms`);
    console.log(`       stop_reason=${turn.stopReason} tool_calls=${calls}`);
    console.log(
      `       tokens in=${turn.usage.inputTokens} out=${turn.usage.outputTokens} ` +
        `cache_read=${turn.usage.cacheReadTokens} cache_write=${turn.usage.cacheWriteTokens}`,
    );
    if (turn.toolCalls.length === 0) {
      console.log(
        "       note: answered without calling the tool. The provider is reachable, " +
          "but tool use may be unreliable on this model.",
      );
    }
  } catch (err) {
    console.log(`  FAIL ${label}  ${Date.now() - started}ms`);
    console.log(`       ${formatError(err)}`);
  }
}

async function main(): Promise<void> {
  const { providers, defaultProvider } = buildProviders();
  const names = Object.keys(providers);
  console.log(`configured providers: ${names.join(", ")}`);
  console.log(`default provider:     ${defaultProvider}`);
  console.log(
    `ANTHROPIC_API_KEY:    ${
      process.env.ANTHROPIC_API_KEY
        ? `set (${process.env.ANTHROPIC_API_KEY.length} chars, ends ...${process.env.ANTHROPIC_API_KEY.slice(-4)})`
        : "NOT SET — the anthropic provider will not be built at all"
    }`,
  );
  console.log("");

  for (const provider of Object.values(providers)) {
    if (provider) await probe(provider);
  }

  console.log(
    "\nIf anthropic FAILs here, the server's failover to ollama is working as designed —\n" +
      "the line above is the reason it has been firing on every run.",
  );
}

main().catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});
