/*
 * PNW El Niño Almanac — Ask endpoint (POST /api/ask)
 *
 * Holds the Anthropic API key (env ANTHROPIC_API_KEY) on the server, runs the
 * tool-use loop against the same engine the page uses, and enforces daily
 * question limits per visitor and for the whole site.
 *
 * Environment variables (Netlify > Site configuration > Environment variables):
 *   ANTHROPIC_API_KEY        required, secret
 *   MODEL                    optional, default "claude-haiku-5-5"
 *   DAILY_LIMIT_PER_VISITOR  optional, default 15
 *   DAILY_LIMIT_TOTAL        optional, default 300
 */
import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import engine from "./_engine.cjs";

const MODEL = process.env.MODEL || "claude-haiku-5-5";
const PER_VISITOR = Number(process.env.DAILY_LIMIT_PER_VISITOR || 15);
const TOTAL = Number(process.env.DAILY_LIMIT_TOTAL || 300);
const MAX_QUESTION = 500;
const MAX_ROUNDS = 6;
const API_URL = "https://api.anthropic.com/v1/messages";

export const config = { path: "/api/ask" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/* ---------- daily limits (Netlify Blobs) ---------- */
let storeOverride = null; // tests only
export function __setStore(s) { storeOverride = s; }

function limitsStore() {
  if (storeOverride) return storeOverride;
  return getStore("ask-limits");
}
function visitorId(ip) {
  // Store a one-way hash, never the raw IP address.
  return createHash("sha256").update("pnw-almanac:" + String(ip || "unknown")).digest("hex").slice(0, 24);
}
async function checkAndCount(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const vKey = `${day}/v/${visitorId(ip)}`;
  const tKey = `${day}/total`;
  let store;
  try { store = limitsStore(); } catch (e) {
    console.warn("Blobs unavailable, limits skipped:", e.message);
    return { ok: true, remaining: null };
  }
  try {
    const [v, t] = await Promise.all([store.get(vKey, { type: "json" }), store.get(tKey, { type: "json" })]);
    const vCount = (v && v.n) || 0, tCount = (t && t.n) || 0;
    if (tCount >= TOTAL) return { ok: false, error: "rate_limited_total" };
    if (vCount >= PER_VISITOR) return { ok: false, error: "rate_limited_visitor" };
    await Promise.all([store.setJSON(vKey, { n: vCount + 1 }), store.setJSON(tKey, { n: tCount + 1 })]);
    return { ok: true, remaining: PER_VISITOR - vCount - 1 };
  } catch (e) {
    // Fail open: prepaid credits with auto-reload off are the hard stop.
    console.warn("Limit check failed, allowing request:", e.message);
    return { ok: true, remaining: null };
  }
}

/* ---------- Claude call ---------- */
async function callClaude(body, signal) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || "";
    const err = new Error(`Anthropic ${res.status}: ${msg}`);
    err.code =
      res.status === 401 || res.status === 403 ? "not_configured"
      : /credit balance|usage limits/i.test(msg) ? "out_of_credits"
      : res.status === 429 || res.status === 529 || res.status >= 500 ? "busy"
      : "upstream";
    throw err;
  }
  return data;
}

function toolDefs(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));
}

function runTool(tools, name, input) {
  const t = tools.find((x) => x.name === name);
  if (!t) return { content: `Error: unknown tool ${name}`, is_error: true };
  try {
    let out = t.execute(input || {}, {});
    out = typeof out === "string" ? out : JSON.stringify(out);
    return { content: out.length > 32000 ? out.slice(0, 32000) : out };
  } catch (e) {
    return { content: "Error: " + e.message, is_error: true };
  }
}

/* ---------- handler ---------- */
export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "not_configured" }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const question = String((body && body.question) || "").trim().slice(0, MAX_QUESTION);
  if (!question) return json({ error: "bad_request" }, 400);

  // Validate the page context against the engine's own data.
  const c = (body && body.ctx) || {};
  const loc = engine.LOCATIONS.find((l) => l.id === c.locationId) || engine.LOCATIONS.find((l) => l.id === "seattle");
  const month = engine.monthById(String(c.monthId || "")) || engine.monthById(new Date().toISOString().slice(0, 7)) || engine.months[0];
  const ctx = {
    locationId: loc.id, zone: loc.zone, monthId: month.id, calMonth: month.month + 1,
    today: new Date().toISOString().slice(0, 10),
  };

  const limit = await checkAndCount(context && context.ip);
  if (!limit.ok) return json({ error: limit.error }, 429);

  const tools = engine.askTools(ctx);
  const system = engine.ASK_RULES + "\n\nUse the tools to fetch the data you need before answering.";
  const messages = [{ role: "user", content: engine.askContext(ctx) + "\n\nQUESTION: " + question }];

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 50000);
  const t0 = Date.now();
  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS;
      const resp = await callClaude({
        model: MODEL,
        max_tokens: 800,
        system,
        tools: toolDefs(tools),
        ...(last ? { tool_choice: { type: "none" } } : {}),
        messages,
      }, ctl.signal);

      const blocks = resp.content || [];
      const uses = blocks.filter((b) => b.type === "tool_use");
      if (resp.stop_reason === "tool_use" && uses.length && !last) {
        messages.push({ role: "assistant", content: blocks });
        messages.push({
          role: "user",
          content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, ...runTool(tools, u.name, u.input) })),
        });
        continue;
      }
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (!text) return json({ error: "upstream" }, 502);
      return json({ text, ms: Date.now() - t0, rounds: round, remainingToday: limit.remaining });
    }
    return json({ error: "upstream" }, 502);
  } catch (e) {
    console.error(e.message);
    if (e.name === "AbortError") return json({ error: "timeout" }, 504);
    return json({ error: e.code || "upstream" }, e.code === "busy" ? 503 : 502);
  } finally {
    clearTimeout(timer);
  }
};
