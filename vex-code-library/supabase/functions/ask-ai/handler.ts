// Ask AI backend for the V5 Unit 2 Code Library.
//
// The page sends its built-in instructions (the snippet library plus the rules)
// and the chat turns. The instructions are accepted only when their SHA-256
// fingerprint is on the approved list, so the endpoint can't be used as a
// general-purpose Claude proxy. It also rate-limits per visitor and per day
// before spending anything.
//
// Request:  {"system": "<the page's instructions>", "messages": [{"role":"user","content":"..."}]}
//
// Response: newline-delimited JSON (application/x-ndjson), one event per line:
//   {"type":"text","text":"..."}        a piece of the answer
//   {"type":"done","truncated":false}   the answer finished
//   {"type":"refused"}                  Claude declined; discard the partial answer
//   {"type":"error","code":"...","message":"..."}
// Errors before streaming starts are plain JSON: {"error":{"code","message"}}.
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";

export const MODEL = "claude-opus-5-5";
export const MAX_TURNS = 12;
export const MAX_USER_CHARS = 2000;
export const MAX_ASSISTANT_CHARS = 12000;
export const MAX_SYSTEM_CHARS = 120000;
export const MAX_BODY_BYTES = 256 * 1024;
/** Fingerprint of the instructions built into index.html. If you change the
 *  snippets or rules, set PROMPT_SHA256 (the function logs the new value). */
export const DEFAULT_PROMPT_SHA256 = "8b159b98838276b75a163ad50b3cc9ebfeaf48d552855e951b1ba6c967ebc211";
const DEFAULT_ORIGINS = ["https://jordanengrashes-ux.github.io"];

type Turn = { role: "user" | "assistant"; content: string };

export interface Deps {
  /** Reads a setting (Deno.env.get in production). */
  env: (name: string) => string | undefined;
  /** Counts one use in a bucket; resolves false when the bucket is over its limit. */
  takeToken: (bucket: string, limit: number, windowSeconds: number) => Promise<boolean>;
  /** Builds the Anthropic client (a fake in tests). */
  anthropic: (apiKey: string) => Anthropic;
  /** Server-side log line. */
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

function intSetting(deps: Deps, name: string, fallback: number): number {
  const n = Number.parseInt(deps.env(name) ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function allowedOrigins(deps: Deps): string[] | "*" {
  const raw = (deps.env("ALLOWED_ORIGINS") ?? "").trim();
  if (raw === "*") return "*";
  if (!raw) return DEFAULT_ORIGINS;
  return raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

function corsHeaders(origin: string | null, allowed: string[] | "*"): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && (allowed === "*" || allowed.includes(origin))) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function jsonError(status: number, code: string, message: string, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function approvedPrompts(deps: Deps): string[] {
  const raw = (deps.env("PROMPT_SHA256") ?? "").trim().toLowerCase();
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [DEFAULT_PROMPT_SHA256];
}

/** Returns the validated turns, or a message saying what is wrong. */
export function validateTurns(body: unknown): Turn[] | string {
  if (!body || typeof body !== "object" || !Array.isArray((body as { messages?: unknown }).messages)) {
    return "Send JSON like {\"messages\":[{\"role\":\"user\",\"content\":\"...\"}]}.";
  }
  const raw = (body as { messages: unknown[] }).messages;
  if (raw.length < 1 || raw.length > MAX_TURNS) return `Send between 1 and ${MAX_TURNS} turns.`;
  const turns: Turn[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as { role?: unknown; content?: unknown };
    const want = i % 2 === 0 ? "user" : "assistant";
    if (!t || t.role !== want) return `Turn ${i + 1} must have role "${want}".`;
    if (typeof t.content !== "string" || !t.content.trim()) return `Turn ${i + 1} needs text content.`;
    const cap = want === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS;
    if (t.content.length > cap) return `Turn ${i + 1} is longer than ${cap} characters.`;
    turns.push({ role: want, content: t.content });
  }
  if (turns[turns.length - 1].role !== "user") return "The last turn must be the user's question.";
  return turns;
}

async function visitorKey(req: Request, salt: string): Promise<string> {
  // Prefer headers set by the proxies in front of Supabase; a visitor can forge x-forwarded-for.
  // The daily total limit caps spending even if a visitor dodges the per-visitor one.
  const fwd = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const ip = req.headers.get("cf-connecting-ip")?.trim() || req.headers.get("x-real-ip")?.trim() || fwd || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|" + ip));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((msg, data) => console.log(JSON.stringify({ msg, ...data })));

  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const allowed = allowedOrigins(deps);
    const cors = corsHeaders(origin, allowed);
    const originOk = !origin || allowed === "*" || allowed.includes(origin);

    if (req.method === "OPTIONS") return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (req.method !== "POST") return jsonError(405, "method_not_allowed", "Use POST.", cors);
    if (!originOk) return jsonError(403, "origin_not_allowed", "This website is not allowed to use Ask AI.", cors);

    const apiKey = deps.env("ANTHROPIC_API_KEY");
    if (!apiKey) return jsonError(503, "not_configured", "Ask AI has no Claude API key yet.", cors);

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return jsonError(413, "too_large", "That request is too large.", cors);
    let text: string;
    try {
      text = await req.text();
    } catch {
      return jsonError(400, "bad_request", "Could not read the request.", cors);
    }
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return jsonError(413, "too_large", "That request is too large.", cors);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonError(400, "bad_request", "The request is not valid JSON.", cors);
    }
    const turns = validateTurns(parsed);
    if (typeof turns === "string") return jsonError(400, "bad_request", turns, cors);
    const system = (parsed as { system?: unknown }).system;
    if (typeof system !== "string" || !system.trim() || system.length > MAX_SYSTEM_CHARS) {
      return jsonError(400, "bad_request", "Send the page's instructions as \"system\".", cors);
    }
    const fingerprint = await sha256Hex(system);
    if (!approvedPrompts(deps).includes(fingerprint)) {
      log("instructions not approved", { received_sha256: fingerprint, length: system.length });
      return jsonError(409, "prompt_mismatch", "This page's Ask AI instructions are not approved on the server.", cors);
    }

    // Rate limits run before any Claude spend. If the limiter is down, refuse
    // rather than spend without limits.
    const perHour = intSetting(deps, "RATE_PER_VISITOR_PER_HOUR", 30);
    const perDay = intSetting(deps, "RATE_TOTAL_PER_DAY", 200);
    try {
      const who = await visitorKey(req, deps.env("RATE_SALT") ?? "vex-code-library");
      if (!(await deps.takeToken("visitor:" + who, perHour, 3600))) {
        return jsonError(429, "rate_limited", "Too many questions from you this hour. Try again later.", cors);
      }
      if (!(await deps.takeToken("total", perDay, 86400))) {
        return jsonError(429, "rate_limited", "Ask AI has reached today's limit. Try again tomorrow.", cors);
      }
    } catch (err) {
      log("rate limiter failed", { error: String(err) });
      return jsonError(503, "limiter_unavailable", "Ask AI is unavailable right now.", cors);
    }

    const client = deps.anthropic(apiKey);
    const enc = new TextEncoder();
    let stream: ReturnType<typeof client.beta.messages.stream> | null = null;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (ev: Record<string, unknown>) => controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
        try {
          stream = client.beta.messages.stream({
            model: MODEL,
            // Cost cap for a public page: answers are short; this leaves room for thinking.
            max_tokens: 8000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            output_config: { effort: "low" },
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            messages: turns,
          });
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
              send({ type: "text", text: event.delta.text });
            }
          }
          const final = await stream.finalMessage();
          log("answered", {
            model: final.model,
            stop_reason: final.stop_reason,
            input_tokens: final.usage.input_tokens,
            cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
            output_tokens: final.usage.output_tokens,
          });
          if (final.stop_reason === "refusal") send({ type: "refused" });
          else send({ type: "done", truncated: final.stop_reason === "max_tokens" });
        } catch (err) {
          if (err instanceof Anthropic.APIUserAbortError) {
            // The visitor pressed Stop or left; nothing more to send.
          } else if (err instanceof Anthropic.RateLimitError) {
            log("claude rate limited", { status: err.status });
            send({ type: "error", code: "rate_limited", message: "Claude is busy. Try again in a minute." });
          } else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
            log("claude key rejected", { status: err.status });
            send({ type: "error", code: "upstream_error", message: "Ask AI's Claude key was rejected." });
          } else if (err instanceof Anthropic.APIError) {
            log("claude api error", { status: err.status, message: err.message });
            send({ type: "error", code: "upstream_error", message: "Claude had a problem. Ask again." });
          } else {
            log("unexpected error", { error: String(err) });
            send({ type: "error", code: "upstream_error", message: "Something went wrong. Ask again." });
          }
        } finally {
          try {
            controller.close();
          } catch {
            // already closed because the visitor went away
          }
        }
      },
      cancel() {
        stream?.abort();
      },
    });

    return new Response(body, {
      status: 200,
      headers: { ...cors, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
    });
  };
}

/** Rate-limit counter backed by the public.ask_ai_take() database function. */
export function postgresTakeToken(supabaseUrl: string, secretKey: string) {
  return async (bucket: string, limit: number, windowSeconds: number): Promise<boolean> => {
    const headers: Record<string, string> = { "Content-Type": "application/json", apikey: secretKey };
    // Legacy service_role keys are JWTs and also go on Authorization; new sb_secret_ keys must not.
    if (secretKey.startsWith("eyJ")) headers.Authorization = `Bearer ${secretKey}`;
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/ask_ai_take`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds }),
    });
    if (!res.ok) throw new Error(`ask_ai_take failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) === true;
  };
}

/** The project's secret key: the new sb_secret_ key if present, else the legacy service_role key. */
export function secretKeyFromEnv(env: (name: string) => string | undefined): string {
  const keys = env("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (first) return first;
    } catch {
      // fall through to the legacy key
    }
  }
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("No Supabase secret key in the environment");
  return legacy;
}
