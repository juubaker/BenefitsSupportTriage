# Add `draftGrounded({ system, user })` to your LLM adapters

Your adapters expose purpose-named methods (`classify`, `draft`). The grounded
draft needs a custom **system** prompt plus a fully-assembled **user** message
(the retrieved context), which `draft({title, body})` can't carry — so add a
sibling method `draftGrounded({ system, user })` that returns the model's text.

Add it to **every** adapter in `server/llm/` so the route works under any
`LLM_PROVIDER`. Below are Anthropic and Ollama. They reuse `this.draftModel`,
which your code already reads (`draft.draftModel` in app.js).

> If your adapters already have a generic completion method (e.g. `.message()`
> or `.complete()`), you don't need this — just point `groundedDraft.js` at it
> instead. Paste the adapter and I'll match the exact signature.

## Anthropic adapter

```js
async draftGrounded({ system, user }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: this.draftModel,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic draftGrounded failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
```

## Ollama adapter

```js
async draftGrounded({ system, user }) {
  // Match `baseUrl` to whatever field your Ollama adapter already uses for its
  // host (it may be this.baseUrl, this.host, or a module constant).
  const base = this.baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434';
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: this.draftModel,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama draftGrounded failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.message?.content ?? '';
}
```

## Why this keeps the abstraction intact

`groundedDraft.js` only ever calls `provider.draftGrounded(...)`. It never
references Anthropic or Ollama by name. So a `LLM_PROVIDER=ollama` run drafts
locally, `LLM_PROVIDER=anthropic` drafts with Claude — same as your existing
routes. The RAG logic (retrieval, citation verification, abstention) is
provider-independent and lives entirely in the orchestrator.
