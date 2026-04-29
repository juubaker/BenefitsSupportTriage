// Thin client for the local /api routes. All network calls go through
// the Express server so the Anthropic key never touches the browser.

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.error || JSON.stringify(j);
    } catch {
      detail = await res.text();
    }
    throw new Error(`${path} failed (${res.status}): ${detail}`);
  }
  return res.json();
}

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.error || JSON.stringify(j);
    } catch {
      detail = await res.text();
    }
    throw new Error(`${path} failed (${res.status}): ${detail}`);
  }
  return res.json();
}

export function listPosts() {
  return getJson('/api/posts');
}

export function categorizePost({ postId, title, body }) {
  return postJson('/api/categorize', { postId, title, body });
}

export function draftResponse({ postId, title, body }) {
  return postJson('/api/draft', { postId, title, body });
}

export async function getHealth() {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error('Health check failed');
  return res.json();
}
