// Offline test of the Ask function: fakes the Anthropic API and the limits store.
// Run with: npm test   (no API key or network needed)
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.DAILY_LIMIT_PER_VISITOR = "3";
process.env.DAILY_LIMIT_TOTAL = "5";

const { default: handler, __setStore } = await import("../netlify/functions/ask.mjs");

// In-memory stand-in for Netlify Blobs.
const mem = new Map();
__setStore({
  get: async (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
  setJSON: async (k, v) => { mem.set(k, JSON.stringify(v)); },
});

// Fake Claude: round 1 asks for a tool, round 2 answers using the tool result.
let calls = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push(body);
  assert.equal(opts.headers["x-api-key"], "test-key");
  const lastMsg = body.messages[body.messages.length - 1];
  const hasToolResult = Array.isArray(lastMsg.content) && lastMsg.content[0].type === "tool_result";
  const payload = hasToolResult
    ? { stop_reason: "end_turn", content: [{ type: "text", text: "Strong El Niño. Based on: test " + lastMsg.content[0].content.slice(0, 40) }] }
    : { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "get_enso_status", input: {} }] };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
};

const ask = (q, ip = "1.2.3.4", ctx = { locationId: "bothell", monthId: "2026-11" }) =>
  handler(new Request("http://x/api/ask", { method: "POST", body: JSON.stringify({ question: q, ctx }) }), { ip });

// 1. Happy path with one tool round
let r = await ask("What is the El Niño status?");
let d = await r.json();
assert.equal(r.status, 200, JSON.stringify(d));
assert.match(d.text, /Strong El Niño/);
assert.match(d.text, /El Niño/);                  // tool result reached the model
assert.equal(d.rounds, 2);
assert.equal(d.remainingToday, 2);
assert.ok(calls[0].tools.length >= 8 && calls[0].tools.every((t) => t.input_schema));
assert.match(calls[0].messages[0].content, /Bothell/);
console.log("ok  happy path, tools:", calls[0].tools.map((t) => t.name).join(", "));

// 2. Bad input
r = await ask("   "); assert.equal(r.status, 400);
r = await handler(new Request("http://x/api/ask", { method: "GET" }), {}); assert.equal(r.status, 405);
console.log("ok  bad input rejected");

// 3. Per-visitor limit (3/day)
await ask("q2"); await ask("q3");
r = await ask("q4"); d = await r.json();
assert.equal(r.status, 429); assert.equal(d.error, "rate_limited_visitor");
console.log("ok  per-visitor daily limit");

// 4. Site-wide limit (5/day): 3 used + 2 more from another visitor, then blocked
await ask("a", "9.9.9.9"); await ask("b", "9.9.9.9");
r = await ask("c", "8.8.8.8"); d = await r.json();
assert.equal(d.error, "rate_limited_total");
console.log("ok  site-wide daily limit");

// 5. Raw IPs are never stored
assert.ok([...mem.keys()].every((k) => !k.includes("1.2.3.4")));
console.log("ok  only hashed visitor ids stored");

// 6. Out of credits maps to a friendly code
mem.clear();
globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Your credit balance is too low to access the Anthropic API." } }), { status: 400 });
r = await ask("anything"); d = await r.json();
assert.equal(d.error, "out_of_credits");
console.log("ok  out-of-credits handled");

// 7. Missing key
delete process.env.ANTHROPIC_API_KEY;
r = await ask("anything"); d = await r.json();
assert.equal(d.error, "not_configured");
console.log("ok  missing key handled");

// 8. Every engine tool runs server-side
process.env.ANTHROPIC_API_KEY = "test-key";
const engine = (await import("../netlify/functions/_engine.cjs")).default;
const ctx = { locationId: "seattle", zone: "CW", monthId: "2026-11", calMonth: 11, today: "2026-11-09" };
const args = { place: "Seattle", month: "2026-12", plant: "garlic", zoneId: "CW", which: "herbs" };
for (const t of engine.askTools(ctx)) {
  const out = JSON.stringify(t.execute(args, {}));
  assert.ok(out && out.length > 20 && !/"error"/.test(out.slice(0, 20)), t.name);
}
console.log("ok  all", engine.askTools(ctx).length, "tools execute in Node");
console.log("\nAll tests passed.");
