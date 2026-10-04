import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

/* eslint-disable no-console */

const PROVIDER_ID = "opencode-zen";
const BUILD_TAG = "0.3.6";
const ZEN_BASE_URL = "https://opencode.ai/zen";
const MODELS_URL = "https://opencode.ai/zen/v1/models";
const METADATA_URL = "https://models.dev/api.json";
const METADATA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* error classification / stop-reason / usage mapping (parity with    */
/* the reference dsh-llm adapters)                                    */
/* ------------------------------------------------------------------ */

const CONTEXT_WINDOW_EXCEEDED = "CONTEXT_WINDOW_EXCEEDED";
const EMPTY_RESPONSE = "EMPTY_RESPONSE";
const QUOTA_EXCEEDED = "QUOTA";
const FREE_TIER_BLOCKED = "FREE_TIER_BLOCKED";
const MODEL_ACCESS_DISABLED = "MODEL_ACCESS_DISABLED";

function classifyError(text) {
  if (/\bRegionError\b|not available in your country/i.test(text)) return "REGION_BLOCKED";
  if (/free.?tier|FreeTierError|only be used from within OpenCode/i.test(text)) return FREE_TIER_BLOCKED;
  if (/model access is disabled|access is disabled/i.test(text)) return MODEL_ACCESS_DISABLED;
  if (/insufficient|quota|billing|account funds/i.test(text)) return QUOTA_EXCEEDED;
  if (/\b(?:401|403)\b/.test(text)) return "AUTH";
  if (/\b429\b|rate.?limit/i.test(text)) return "RATE_LIMIT";
  if (/\b413\b|payload too large|request body too large/i.test(text)) return "INVALID_REQUEST";
  if (/\b400\b|invalid.?request/i.test(text)) return "INVALID_REQUEST";
  if (/\b5\d\d\b/.test(text)) return "SERVER";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return "TIMEOUT";
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return "TRANSPORT";
  return "UPSTREAM";
}

/** 追加到错误消息末尾的可操作提示（按错误码）。 */
function errorHint(code) {
  if (code === FREE_TIER_BLOCKED) return "免费模型（*-free）只能在 OpenCode 客户端内使用：请在「设置 → 插件 → OpenCode Zen → 配置」关闭“包含免费模型”，或改用付费模型。";
  if (code === MODEL_ACCESS_DISABLED) return "当前 Console 账号没有该模型的访问权限，请更换模型。";
  if (code === QUOTA_EXCEEDED) return "OpenCode Console 账户余额不足，请到 https://opencode.ai/console 充值。";
  if (code === "AUTH") return "API Key 无效或已失效，请在「设置 → 插件 → OpenCode Zen → 配置」重新粘贴。";
  if (code === "REGION_BLOCKED") return "当前网络所在地区被 OpenCode 限制。";
  return "";
}

function isContextOverflow(message, contextWindow) {
  return message.stopReason === "stop" && message.usage?.input > contextWindow;
}

function mapStopReason(message, contextWindow) {
  const reason = message.stopReason;
  if (message.errorMessage) {
    const code = classifyError(message.errorMessage);
    if (/context/i.test(message.errorMessage) && /exceed|window|length|token/i.test(message.errorMessage)) {
      return { kind: "error", failure: { message: message.errorMessage, code: CONTEXT_WINDOW_EXCEEDED } };
    }
    return { kind: "error", failure: { message: message.errorMessage, code } };
  }
  if (reason === "aborted") return { kind: "aborted" };
  if (isContextOverflow(message, contextWindow)) {
    return { kind: "error", failure: { message: `context window exceeded (${message.usage.input} input tokens > ${contextWindow})`, code: CONTEXT_WINDOW_EXCEEDED } };
  }
  if (reason === "stop") {
    const empty = message.usage?.output === 0 && !message.hasToolCalls && message.hasText !== true;
    if (empty) {
      return { kind: "error", failure: { message: "model returned an empty response", code: EMPTY_RESPONSE } };
    }
    return { kind: "stop" };
  }
  if (reason === "length") return { kind: "max-tokens" };
  if (reason === "toolUse") return { kind: "tool-calls" };
  if (reason === "error") return { kind: "error", failure: { message: message.errorMessage ?? "upstream error", code: classifyError(message.errorMessage ?? "") } };
  return { kind: "stop" };
}

function mapUsage(usage) {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  const out = { inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0 };
  if ((usage.cacheRead ?? 0) > 0) out.cacheReadTokens = usage.cacheRead;
  if ((usage.cacheWrite ?? 0) > 0) out.cacheWriteTokens = usage.cacheWrite;
  return out;
}

/* ------------------------------------------------------------------ */
/* reasoning effort ladder                                             */
/* ------------------------------------------------------------------ */

const REASONING_EFFORT_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_EFFORT_LADDER = ["off", "minimal", "low", "medium", "high"];

function reasoningEffortWire(id) {
  if (id === undefined) return undefined;
  if (id === "off") return "none";
  return REASONING_EFFORT_LADDER.includes(id) ? id : undefined;
}

function reasoningBudgetFor(effort) {
  switch (effort) {
    case "minimal": return 1024;
    case "low": return 4096;
    case "medium": return 8192;
    case "high": return 16384;
    case "xhigh": return 32768;
    case "max": return 65536;
    default: return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* model endpoint routing (docs/console/models table + live list)      */
/* ------------------------------------------------------------------ */

const RESPONSES_PREFIXES = ["gpt-", "grok-", "muse-spark"];
const ANTHROPIC_EXACT = new Set([
  "qwen3.8-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
]);

function apiForModel(id) {
  const m = String(id ?? "").toLowerCase();
  if (m.startsWith("jev")) return "excluded";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("claude")) return "anthropic";
  if (RESPONSES_PREFIXES.some((p) => m.startsWith(p))) return "responses";
  if (ANTHROPIC_EXACT.has(m)) return "anthropic";
  return "chat";
}

function isFreeModel(id) {
  return String(id ?? "").toLowerCase().includes("free");
}

/* ------------------------------------------------------------------ */
/* context window / output budget fallbacks                            */
/* ------------------------------------------------------------------ */

const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;

const STATIC_LIMITS = {
  "gpt-6-astra": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-6-sol": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-6.1-sol": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-6-luna": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.6-sol": { contextWindow: 1050000, maxTokens: 128000 },
  "gpt-5.6-terra": { contextWindow: 1050000, maxTokens: 128000 },
  "gpt-5.6-luna": { contextWindow: 1050000, maxTokens: 128000 },
  "gpt-5.5": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.5-pro": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.4": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.4-pro": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.4-mini": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.4-nano": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.3-codex": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.3-codex-spark": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.2": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.2-codex": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.1": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.1-codex": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.1-codex-max": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5.1-codex-mini": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5-codex": { contextWindow: 400000, maxTokens: 128000 },
  "gpt-5-nano": { contextWindow: 400000, maxTokens: 128000 },
  "grok-4.7": { contextWindow: 500000, maxTokens: 128000 },
  "grok-4.6": { contextWindow: 500000, maxTokens: 128000 },
  "grok-4.5": { contextWindow: 500000, maxTokens: 128000 },
  "grok-build-0.1": { contextWindow: 500000, maxTokens: 128000 },
  "muse-spark-1.3": { contextWindow: 400000, maxTokens: 128000 },
  "muse-spark-1.2": { contextWindow: 400000, maxTokens: 128000 },
  "claude-fable-5": { contextWindow: 400000, maxTokens: 64000 },
  "claude-fable-5-1": { contextWindow: 400000, maxTokens: 64000 },
  "claude-opus-5-5": { contextWindow: 400000, maxTokens: 64000 },
  "claude-opus-5": { contextWindow: 400000, maxTokens: 64000 },
  "claude-opus-4-8": { contextWindow: 200000, maxTokens: 64000 },
  "claude-opus-4-7": { contextWindow: 200000, maxTokens: 64000 },
  "claude-opus-4-6": { contextWindow: 200000, maxTokens: 64000 },
  "claude-opus-4-5": { contextWindow: 200000, maxTokens: 64000 },
  "claude-sonnet-5-5": { contextWindow: 400000, maxTokens: 64000 },
  "claude-sonnet-5": { contextWindow: 400000, maxTokens: 64000 },
  "claude-sonnet-4-6": { contextWindow: 200000, maxTokens: 64000 },
  "claude-sonnet-4-5": { contextWindow: 200000, maxTokens: 64000 },
  "claude-sonnet-4": { contextWindow: 200000, maxTokens: 64000 },
  "claude-haiku-4-5": { contextWindow: 200000, maxTokens: 64000 },
  "deepseek-v4.1-flash": { contextWindow: 1048576, maxTokens: 384000 },
  "deepseek-v4-pro": { contextWindow: 1048576, maxTokens: 384000 },
  "deepseek-v4-flash": { contextWindow: 1048576, maxTokens: 384000 },
  "deepseek-v4-flash-vision-exp": { contextWindow: 1048576, maxTokens: 384000 },
  "glm-5.3": { contextWindow: 1048576, maxTokens: 131072 },
  "glm-5.3-flash": { contextWindow: 1048576, maxTokens: 131072 },
  "glm-5.2": { contextWindow: 1048576, maxTokens: 131072 },
  "glm-5.1": { contextWindow: 1048576, maxTokens: 131072 },
  "glm-5": { contextWindow: 1048576, maxTokens: 131072 },
  "minimax-m3": { contextWindow: 1048576, maxTokens: 131072 },
  "minimax-m2.7": { contextWindow: 1048576, maxTokens: 131072 },
  "minimax-m2.5": { contextWindow: 1048576, maxTokens: 131072 },
  "kimi-k3": { contextWindow: 1048576, maxTokens: 131072 },
  "kimi-k2.7-code": { contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2.6": { contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2.5": { contextWindow: 262144, maxTokens: 65536 },
  "qwen3.8-flash": { contextWindow: 1048576, maxTokens: 131072 },
  "qwen3.7-max": { contextWindow: 262144, maxTokens: 65536 },
  "qwen3.8-max": { contextWindow: 1048576, maxTokens: 131072 },
  "big-pickle": { contextWindow: 262144, maxTokens: 32768 },
};

function contextWindowFor(entry) {
  const declared = entry?.contextWindow;
  return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW;
}

function defaultMaxTokensFor(entry) {
  const declared = entry?.maxTokens;
  return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_TOKENS;
}

function reasoningEffortsFor(entry) {
  const reasoning = entry?.reasoning;
  if (!reasoning) return undefined;
  const declared = [];
  for (const value of entry.effortValues ?? []) {
    const level = value === "none" ? "off" : value;
    if (REASONING_EFFORT_LADDER.includes(level) && !declared.includes(level)) declared.push(level);
  }
  const ladder = declared.length > 0
    ? declared.sort((a, b) => REASONING_EFFORT_LADDER.indexOf(a) - REASONING_EFFORT_LADDER.indexOf(b))
    : DEFAULT_EFFORT_LADDER;
  return ladder.map((level) => ({ id: level, name: level.charAt(0).toUpperCase() + level.slice(1) }));
}

function looksLikeVision(id) {
  const m = String(id ?? "").toLowerCase();
  return m.startsWith("claude-") || m.startsWith("gemini-") || m.startsWith("deepseek-v4-flash-vision") || m.includes("vision");
}

/* ------------------------------------------------------------------ */
/* static catalog (docs table, always usable offline)                  */
/* ------------------------------------------------------------------ */

const STATIC_MODELS = [
  "gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano",
  "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2", "gpt-5.2-codex",
  "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini",
  "gpt-5", "gpt-5-codex", "gpt-5-nano",
  "grok-4.7", "grok-4.6", "grok-4.5", "grok-build-0.1",
  "muse-spark-1.3", "muse-spark-1.2",
  "claude-fable-5", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5",
  "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4",
  "claude-haiku-4-5",
  "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
  "gemini-3.5-flash-lite", "gemini-3.1-pro", "gemini-3-flash",
  "deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp",
  "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5",
  "minimax-m3", "minimax-m2.7", "minimax-m2.5",
  "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
  "qwen3.8-flash", "qwen3.8-max", "qwen3.7-max", "qwen3.6-plus", "qwen3.5-plus",
  "big-pickle",
  "deepseek-v4-flash-free", "muse-spark-1.3-contributor-free", "muse-spark-1.2-contributor-free",
  "mimo-v2.6-flash-free", "space-bunny-free", "longcat-2.5-preview-free",
  "mimo-v2.5-free", "ling-3.0-flash-fin-free", "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free", "fledge-alpha-free",
];

/* reasoning-capable families (advertise the effort ladder) */
function looksLikeReasoning(id) {
  const m = String(id ?? "").toLowerCase();
  return m.startsWith("claude-") || m.startsWith("gpt-") || m.startsWith("grok-")
    || m.startsWith("deepseek-v4") || m.startsWith("glm-5") || m.startsWith("minimax-")
    || m.startsWith("kimi-") || m.startsWith("qwen3") || m.startsWith("gemini-")
    || m.startsWith("muse-spark");
}

function entryFor(id) {
  const api = apiForModel(id);
  if (api === "excluded") return null;
  const limits = STATIC_LIMITS[id] ?? {};
  return {
    id,
    name: id,
    api,
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    reasoning: looksLikeReasoning(id),
    inputModalities: looksLikeVision(id) ? ["text", "image"] : ["text"],
    free: isFreeModel(id),
  };
}

/* ------------------------------------------------------------------ */
/* models.dev metadata (context windows / output budgets)              */
/* ------------------------------------------------------------------ */

function decodeModelsDev(data) {
  const result = new Map();
  if (!data || typeof data !== "object") return result;
  const providers = data;
  const keys = Object.keys(providers).sort((a, b) => {
    const rank = (k) => {
      const lower = k.toLowerCase();
      if (lower === "opencode" || lower === "opencode-zen" || lower === "opencode_zen") return 0;
      if (lower.includes("opencode")) return 1;
      return 2;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (lower !== "opencode" && lower !== "opencode-zen" && lower !== "opencode_zen" && !lower.includes("opencode")) continue;
    const provider = providers[key];
    const models = provider?.models;
    if (!models || typeof models !== "object") continue;
    for (const [id, meta] of Object.entries(models)) {
      if (result.has(id)) continue;
      const contextWindow = meta?.limit?.context;
      const maxTokens = meta?.limit?.output;
      const effortValues = Array.isArray(meta?.reasoning_options?.efforts) ? meta.reasoning_options.efforts : [];
      result.set(id, {
        contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
        maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
        reasoning: meta?.reasoning === true,
        effortValues,
      });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* harness message conversion                                          */
/* ------------------------------------------------------------------ */

function dshHome() {
  const configured = process.env.DSH_HOME?.trim();
  if (configured) return configured;
  return join(homedir(), ".dsh");
}

function parseArguments(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

async function readImage(ref) {
  const attachment = ref ?? {};
  const id = typeof attachment.attachmentId === "string" ? attachment.attachmentId : "";
  const sha = id.startsWith("sha256:") ? id.slice(7) : id;
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    return { type: "text", text: `[image omitted: unreadable attachment reference ${JSON.stringify(id)}]` };
  }
  const path = join(dshHome(), "attachments", "v1", "objects", sha.slice(0, 2), sha);
  try {
    return {
      type: "image",
      data: (await readFile(path)).toString("base64"),
      mimeType: typeof attachment.mediaType === "string" && attachment.mediaType.length > 0 ? attachment.mediaType : "image/png",
    };
  } catch {
    return { type: "text", text: `[image omitted: failed to read normalized attachment ${JSON.stringify(id)}]` };
  }
}

async function contentParts(blocks) {
  const parts = [];
  for (const block of blocks ?? []) {
    if (block?.type === "text" && block.text.length > 0) {
      parts.push({ type: "text", text: block.text });
    } else if (block?.type === "image") {
      parts.push(await readImage(block.attachment));
    }
  }
  return parts;
}

function flattenText(blocks) {
  return (blocks ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
}

/* ---- wire builders (one per protocol) ---- */

async function buildChatMessages(options) {
  const messages = [];
  if (typeof options.system === "string" && options.system.length > 0) {
    messages.push({ role: "system", content: options.system });
  }
  for (const message of options.messages ?? []) {
    const role = message?.role;
    if (role === "system") {
      messages.push({ role: "system", content: flattenText(message.content) });
    } else if (role === "user") {
      const parts = await contentParts(message.content);
      const texts = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const images = parts.filter((p) => p.type === "image");
      const content = images.length > 0
        ? [
            ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } })),
            ...(texts.length > 0 ? [{ type: "text", text: texts }] : []),
          ]
        : texts;
      messages.push({ role: "user", content });
    } else if (role === "assistant") {
      const toolCalls = (message.content ?? []).filter((b) => b?.type === "tool-call").map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: typeof b.arguments === "string" ? b.arguments : JSON.stringify(parseArguments(b.arguments)) },
      }));
      const text = flattenText(message.content);
      const content = toolCalls.length > 0 ? (text.length > 0 ? text : undefined) : text;
      const entry = { role: "assistant" };
      if (content !== undefined && content.length > 0) entry.content = content;
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      if (entry.content === undefined && toolCalls.length === 0) entry.content = "";
      messages.push(entry);
    } else if (role === "tool-result") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: typeof message.content === "string" ? message.content : flattenText(message.content),
      });
    }
  }
  return messages;
}

async function buildAnthropicMessages(options) {
  const messages = [];
  for (const message of options.messages ?? []) {
    const role = message?.role;
    if (role === "system") continue;
    if (role === "user") {
      const parts = await contentParts(message.content);
      const blocks = parts.map((p) => p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } });
      messages.push({ role: "user", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
    } else if (role === "assistant") {
      const blocks = [];
      const text = flattenText(message.content);
      if (text.length > 0) blocks.push({ type: "text", text });
      for (const b of message.content ?? []) {
        if (b?.type === "tool-call") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: parseArguments(b.arguments) });
      }
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
    } else if (role === "tool-result") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: typeof message.content === "string" ? message.content : flattenText(message.content),
          is_error: message.isError === true,
        }],
      });
    }
  }
  return messages;
}

async function buildResponsesInput(options) {
  const input = [];
  const systemText = typeof options.system === "string" && options.system.length > 0
    ? options.system
    : (options.messages ?? []).filter((m) => m?.role === "system").map((m) => flattenText(m.content)).join("\n");
  if (systemText.length > 0) {
    input.push({ role: "developer", content: [{ type: "input_text", text: systemText }] });
  }
  for (const message of options.messages ?? []) {
    const role = message?.role;
    if (role === "system") continue;
    if (role === "user") {
      const parts = await contentParts(message.content);
      const blocks = parts.map((p) => p.type === "text"
        ? { type: "input_text", text: p.text }
        : { type: "input_image", image_url: `data:${p.mimeType};base64,${p.data}` });
      input.push({ role: "user", content: blocks.length > 0 ? blocks : [{ type: "input_text", text: "" }] });
    } else if (role === "assistant") {
      const text = flattenText(message.content);
      const toolCalls = (message.content ?? []).filter((b) => b?.type === "tool-call");
      if (text.length > 0) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const b of toolCalls) {
        input.push({
          type: "function_call",
          call_id: b.id,
          name: b.name,
          arguments: typeof b.arguments === "string" ? b.arguments : JSON.stringify(parseArguments(b.arguments)),
        });
      }
    } else if (role === "tool-result") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: typeof message.content === "string" ? message.content : flattenText(message.content),
      });
    }
  }
  return input;
}

async function buildGoogleContents(options) {
  const contents = [];
  for (const message of options.messages ?? []) {
    const role = message?.role;
    if (role === "system") continue;
    if (role === "user") {
      const parts = await contentParts(message.content);
      contents.push({
        role: "user",
        parts: parts.map((p) => p.type === "text" ? { text: p.text } : { inlineData: { mime_type: p.mimeType, data: p.data } }),
      });
    } else if (role === "assistant") {
      const parts = [];
      const text = flattenText(message.content);
      if (text.length > 0) parts.push({ text });
      for (const b of message.content ?? []) {
        if (b?.type === "tool-call") parts.push({ functionCall: { name: b.name, args: parseArguments(b.arguments) } });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else if (role === "tool-result") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "";
      const content = typeof message.content === "string" ? message.content : flattenText(message.content);
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: toolName, response: { name: toolName, content } } }],
      });
    }
  }
  return contents;
}

function toolsPayload(options) {
  return (options.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.parameters ?? { type: "object", properties: {} },
  }));
}

/* ------------------------------------------------------------------ */
/* SSE stream -> harness chunks (four protocols)                       */
/* ------------------------------------------------------------------ */

async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try { yield JSON.parse(data); } catch { /* ignore malformed frames */ }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function errorChunk(message, code) {
  return { type: "finish", reason: { kind: "error", failure: { message, code } } };
}

function usageFinish(usage, stopReason, contextWindow, hasToolCalls, errorMessage, hasText = false) {
  const message = { stopReason, usage, hasToolCalls, hasText, errorMessage };
  return [
    { type: "usage", usage: mapUsage(usage) },
    { type: "finish", reason: mapStopReason(message, contextWindow) },
  ];
}

async function* streamChatCompletions(response, options, contextWindow, watchdog) {
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = "stop";
  let hasToolCalls = false;
  let hasText = false;
  let errorMessage = undefined;
  let reasoningIndex = -1;
  let textIndex = -1;
  const toolAccum = new Map();
  const textBlocks = new Map();
  const reasoningBlocks = new Map();
  let anyEvent = false;

  for await (const event of parseSSE(response.body)) {
    anyEvent = true;
    watchdog.beat();
    if (event.usage) {
      usage = {
        input: event.usage.prompt_tokens ?? 0,
        output: event.usage.completion_tokens ?? 0,
        cacheRead: event.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
      };
    }
    const choice = event.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      if (reasoningIndex < 0) { reasoningIndex = 0; yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" }; }
      reasoningBlocks.set(reasoningIndex, (reasoningBlocks.get(reasoningIndex) ?? "") + delta.reasoning_content);
      yield { type: "reasoning-delta", index: reasoningIndex, text: delta.reasoning_content };
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      hasText = true;
      if (textIndex < 0) { textIndex = reasoningIndex >= 0 ? 1 : 0; yield { type: "block-start", index: textIndex, blockType: "text" }; }
      textBlocks.set(textIndex, (textBlocks.get(textIndex) ?? "") + delta.content);
      yield { type: "text-delta", index: textIndex, text: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      hasToolCalls = true;
      const key = tc.index ?? 0;
      let acc = toolAccum.get(key);
      if (!acc) {
        acc = { idx: 1000 + toolAccum.size, id: tc.id ?? `call_${key}`, name: "", args: "" };
        toolAccum.set(key, acc);
        yield { type: "block-start", index: acc.idx, blockType: "tool-call" };
      }
      if (typeof tc.id === "string" && tc.id.length > 0) acc.id = tc.id;
      if (typeof tc.function?.name === "string" && tc.function.name.length > 0) acc.name = tc.function.name;
      if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
      yield {
        type: "tool-call-delta",
        index: acc.idx,
        id: acc.id,
        ...acc.name.length > 0 ? { name: acc.name } : {},
        argumentsDelta: tc.function?.arguments ?? "",
      };
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
      if (choice.finish_reason === "length") stopReason = "length";
      else if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") stopReason = "toolUse";
      else if (choice.finish_reason === "content_filter") { stopReason = "error"; errorMessage = "content_filter"; }
      else stopReason = "stop";
    }
  }

  if (!anyEvent) {
    yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    yield errorChunk("opencode-zen: stream ended without any event", "TRANSPORT");
    return;
  }

  for (const acc of toolAccum.values()) {
    yield { type: "block-end", index: acc.idx, block: { type: "tool-call", id: acc.id, name: acc.name, arguments: JSON.stringify(parseArguments(acc.args)) } };
  }
  if (textIndex >= 0) yield { type: "block-end", index: textIndex, block: { type: "text", text: textBlocks.get(textIndex) ?? "" } };
  if (reasoningIndex >= 0) yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningBlocks.get(reasoningIndex) ?? "" } };
  yield* usageFinish(usage, stopReason, contextWindow, hasToolCalls, errorMessage, hasText);
}

async function* streamResponses(response, options, contextWindow, watchdog) {
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = "stop";
  let hasToolCalls = false;
  let hasText = false;
  let errorMessage = undefined;
  let textIndex = -1;
  let reasoningIndex = -1;
  let toolCounter = 0;
  let currentToolIdx = -1;
  const openTools = new Map();
  const textBlocks = new Map();
  const reasoningBlocks = new Map();
  let anyEvent = false;

  for await (const event of parseSSE(response.body)) {
    anyEvent = true;
    watchdog.beat();
    const type = event.type ?? "";
    if (type === "response.output_text.delta") {
      hasText = true;
      if (textIndex < 0) { textIndex = 0; yield { type: "block-start", index: textIndex, blockType: "text" }; }
      textBlocks.set(textIndex, (textBlocks.get(textIndex) ?? "") + (event.delta ?? ""));
      yield { type: "text-delta", index: textIndex, text: event.delta ?? "" };
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      if (reasoningIndex < 0) { reasoningIndex = 1; yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" }; }
      reasoningBlocks.set(reasoningIndex, (reasoningBlocks.get(reasoningIndex) ?? "") + (event.delta ?? ""));
      yield { type: "reasoning-delta", index: reasoningIndex, text: event.delta ?? "" };
    } else if (type === "response.output_item.added" && event.item?.type === "function_call") {
      hasToolCalls = true;
      const idx = 100 + toolCounter++;
      const acc = { idx, id: event.item.call_id ?? `call_${idx}`, name: event.item.name ?? "", args: "" };
      openTools.set(idx, acc);
      currentToolIdx = idx;
      yield { type: "block-start", index: idx, blockType: "tool-call" };
    } else if (type === "response.function_call_arguments.delta") {
      const acc = openTools.get(currentToolIdx) ?? [...openTools.values()][0];
      if (acc) {
        acc.args += event.delta ?? "";
        yield { type: "tool-call-delta", index: acc.idx, id: acc.id, ...acc.name.length > 0 ? { name: acc.name } : {}, argumentsDelta: event.delta ?? "" };
      }
    } else if (type === "response.output_item.done" && event.item?.type === "function_call") {
      for (const [idx, acc] of openTools) {
        if (acc.id === event.item.call_id || acc.name === event.item.name) {
          yield { type: "block-end", index: idx, block: { type: "tool-call", id: acc.id, name: acc.name, arguments: JSON.stringify(parseArguments(acc.args)) } };
          openTools.delete(idx);
          if (currentToolIdx === idx) currentToolIdx = -1;
          break;
        }
      }
    } else if (type === "response.completed" && event.response?.usage) {
      const u = event.response.usage;
      usage = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.input_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
      };
      if (event.response.incomplete_details?.reason === "max_output_tokens") stopReason = "length";
    } else if (type === "response.failed" && event.response?.error) {
      stopReason = "error";
      errorMessage = event.response.error.message ?? "response failed";
    } else if (type === "error") {
      stopReason = "error";
      errorMessage = event.message ?? event.error?.message ?? "upstream error";
    }
  }

  if (!anyEvent) {
    yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    yield errorChunk("opencode-zen: stream ended without any event", "TRANSPORT");
    return;
  }

  for (const [idx, acc] of openTools) {
    yield { type: "block-end", index: idx, block: { type: "tool-call", id: acc.id, name: acc.name, arguments: JSON.stringify(parseArguments(acc.args)) } };
  }
  if (textIndex >= 0) yield { type: "block-end", index: textIndex, block: { type: "text", text: textBlocks.get(textIndex) ?? "" } };
  if (reasoningIndex >= 0) yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningBlocks.get(reasoningIndex) ?? "" } };
  yield* usageFinish(usage, stopReason, contextWindow, hasToolCalls, errorMessage, hasText);
}

async function* streamAnthropic(response, options, contextWindow, watchdog) {
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = "stop";
  let hasToolCalls = false;
  let hasText = false;
  let errorMessage = undefined;
  const blocks = new Map();
  const blockText = new Map();
  let anyEvent = false;

  for await (const event of parseSSE(response.body)) {
    anyEvent = true;
    watchdog.beat();
    if (event.type === "message_start" && event.message?.usage) {
      usage.input = event.message.usage.input_tokens ?? 0;
      usage.cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
    } else if (event.type === "content_block_start") {
      const idx = event.index ?? 0;
      const block = event.content_block ?? {};
      if (block.type === "text") {
        blocks.set(idx, { kind: "text" });
        blockText.set(idx, block.text ?? "");
        yield { type: "block-start", index: idx, blockType: "text" };
      } else if (block.type === "thinking") {
        blocks.set(idx, { kind: "reasoning" });
        blockText.set(idx, block.thinking ?? "");
        yield { type: "block-start", index: idx, blockType: "reasoning" };
      } else if (block.type === "tool_use") {
        hasToolCalls = true;
        blocks.set(idx, { kind: "tool-call", id: block.id ?? `call_${idx}`, name: block.name ?? "", args: "" });
        yield { type: "block-start", index: idx, blockType: "tool-call" };
      }
    } else if (event.type === "content_block_delta") {
      const idx = event.index ?? 0;
      const delta = event.delta ?? {};
      const acc = blocks.get(idx);
      if (delta.type === "text_delta") {
        hasText = true;
        blockText.set(idx, (blockText.get(idx) ?? "") + (delta.text ?? ""));
        yield { type: "text-delta", index: idx, text: delta.text ?? "" };
      } else if (delta.type === "thinking_delta") {
        blockText.set(idx, (blockText.get(idx) ?? "") + (delta.thinking ?? ""));
        yield { type: "reasoning-delta", index: idx, text: delta.thinking ?? "" };
      } else if (delta.type === "input_json_delta" && acc?.kind === "tool-call") {
        acc.args += delta.partial_json ?? "";
        yield { type: "tool-call-delta", index: idx, id: acc.id, ...acc.name.length > 0 ? { name: acc.name } : {}, argumentsDelta: delta.partial_json ?? "" };
      }
    } else if (event.type === "content_block_stop") {
      const idx = event.index ?? 0;
      const acc = blocks.get(idx);
      if (acc) {
        if (acc.kind === "text") yield { type: "block-end", index: idx, block: { type: "text", text: blockText.get(idx) ?? "" } };
        else if (acc.kind === "reasoning") yield { type: "block-end", index: idx, block: { type: "reasoning", text: blockText.get(idx) ?? "" } };
        else if (acc.kind === "tool-call") yield { type: "block-end", index: idx, block: { type: "tool-call", id: acc.id, name: acc.name, arguments: JSON.stringify(parseArguments(acc.args)) } };
        blocks.delete(idx);
      }
    } else if (event.type === "message_delta") {
      if (event.usage?.output_tokens !== undefined) usage.output = event.usage.output_tokens;
      const sr = event.delta?.stop_reason;
      if (sr === "end_turn" || sr === "stop_sequence") stopReason = "stop";
      else if (sr === "max_tokens") stopReason = "length";
      else if (sr === "tool_use") stopReason = "toolUse";
    } else if (event.type === "error") {
      stopReason = "error";
      errorMessage = event.error?.message ?? "upstream error";
    }
  }

  if (!anyEvent) {
    yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    yield errorChunk("opencode-zen: stream ended without any event", "TRANSPORT");
    return;
  }

  for (const [idx, acc] of blocks) {
    if (acc.kind === "tool-call") yield { type: "block-end", index: idx, block: { type: "tool-call", id: acc.id, name: acc.name, arguments: JSON.stringify(parseArguments(acc.args)) } };
  }
  yield* usageFinish(usage, stopReason, contextWindow, hasToolCalls, errorMessage, hasText);
}

async function* streamGoogle(response, options, contextWindow, watchdog) {
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = "stop";
  let hasToolCalls = false;
  let hasText = false;
  let errorMessage = undefined;
  let textIndex = -1;
  let reasoningIndex = -1;
  let toolCounter = 0;
  const textBlocks = new Map();
  const reasoningBlocks = new Map();
  let anyEvent = false;

  for await (const event of parseSSE(response.body)) {
    anyEvent = true;
    watchdog.beat();
    const candidate = event.candidates?.[0];
    if (event.usageMetadata) {
      usage.input = event.usageMetadata.promptTokenCount ?? usage.input;
      usage.output = event.usageMetadata.candidatesTokenCount ?? usage.output;
      usage.cacheRead = event.usageMetadata.cachedContentTokenCount ?? usage.cacheRead;
    }
    if (!candidate) continue;
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text.length > 0) {
        if (part.thought === true) {
          if (reasoningIndex < 0) { reasoningIndex = 1; yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" }; }
          reasoningBlocks.set(reasoningIndex, (reasoningBlocks.get(reasoningIndex) ?? "") + part.text);
          yield { type: "reasoning-delta", index: reasoningIndex, text: part.text };
        } else {
          hasText = true;
          if (textIndex < 0) { textIndex = 0; yield { type: "block-start", index: textIndex, blockType: "text" }; }
          textBlocks.set(textIndex, (textBlocks.get(textIndex) ?? "") + part.text);
          yield { type: "text-delta", index: textIndex, text: part.text };
        }
      } else if (part.functionCall) {
        hasToolCalls = true;
        const idx = 100 + toolCounter++;
        const args = JSON.stringify(part.functionCall.args ?? {});
        const name = typeof part.functionCall.name === "string" ? part.functionCall.name : "";
        yield { type: "block-start", index: idx, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: idx, id: `call_${idx}`, ...name.length > 0 ? { name } : {}, argumentsDelta: args };
        yield { type: "block-end", index: idx, block: { type: "tool-call", id: `call_${idx}`, name, arguments: args } };
      }
    }
    const fr = candidate.finishReason;
    if (fr === "MAX_TOKENS") stopReason = "length";
    else if (fr === "SAFETY" || fr === "RECITATION" || fr === "BLOCKLIST") { stopReason = "error"; errorMessage = `finishReason ${fr}`; }
    else if (fr === "STOP") stopReason = "stop";
  }

  if (!anyEvent) {
    yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    yield errorChunk("opencode-zen: stream ended without any event", "TRANSPORT");
    return;
  }

  if (textIndex >= 0) yield { type: "block-end", index: textIndex, block: { type: "text", text: textBlocks.get(textIndex) ?? "" } };
  if (reasoningIndex >= 0) yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningBlocks.get(reasoningIndex) ?? "" } };
  yield* usageFinish(usage, stopReason, contextWindow, hasToolCalls, errorMessage, hasText);
}

/* ------------------------------------------------------------------ */
/* watchdog                                                            */
/* ------------------------------------------------------------------ */

const WATCHDOG_FIRST_MS = 120_000;
const WATCHDOG_IDLE_MS = 300_000;

function createWatchdog(controller) {
  let timer = null;
  let disposed = false;
  const arm = (ms) => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new Error("opencode-zen: stream watchdog timeout (no events)"));
    }, ms);
    timer.unref?.();
  };
  arm(WATCHDOG_FIRST_MS);
  return {
    beat() { arm(WATCHDOG_IDLE_MS); },
    dispose() { disposed = true; if (timer) clearTimeout(timer); },
  };
}

/* ------------------------------------------------------------------ */
/* model catalog                                                       */
/* ------------------------------------------------------------------ */

class ModelCatalog {
  constructor(options = {}) {
    this.readSettings = options.readSettings ?? (() => ({}));
    this.cachePath = options.cachePath;
    this.onRefresh = options.onRefresh;
    this.liveIds = [];
    this.metadata = new Map();
    this.status = { status: "pending", total: 0, updatedAt: 0, lastError: "" };
    this.timer = null;
    this.stopped = false;
  }

  start() {
    const tick = () => {
      if (this.stopped) return;
      const seconds = Number(this.readSettings().refreshSeconds);
      const ms = (Number.isFinite(seconds) && seconds >= 30 ? seconds : 300) * 1000;
      this.timer = setTimeout(() => { this.refreshOnce().finally(tick); }, ms);
      this.timer.unref?.();
    };
    this.refreshOnce().finally(tick);
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  async refreshOnce() {
    const errors = [];
    try {
      const baseUrl = (this.readSettings().baseUrl ?? ZEN_BASE_URL).replace(/\/+$/, "");
      const response = await fetch(`${baseUrl}/v1/models`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        const payload = await response.json();
        const ids = Array.isArray(payload?.data) ? payload.data.map((m) => m?.id).filter((id) => typeof id === "string" && id.length > 0) : [];
        this.liveIds = ids;
      } else {
        errors.push(`models list HTTP ${response.status}`);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    await this.loadMetadata();
    const list = this.list();
    this.status = {
      status: errors.length > 0 && list.length === 0 ? "error" : "ok",
      total: list.length,
      updatedAt: Date.now(),
      lastError: errors.join("; "),
    };
    this.onRefresh?.(this.status);
  }

  async loadMetadata() {
    const fresh = await this.readCache();
    if (fresh) { this.metadata = fresh; return; }
    try {
      const response = await fetch(METADATA_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return;
      const data = await response.json();
      const decoded = decodeModelsDev(data);
      if (decoded.size > 0) {
        this.metadata = decoded;
        await this.writeCache(data);
      }
    } catch { /* metadata is optional */ }
  }

  async readCache() {
    if (!this.cachePath) return null;
    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed?.savedAt || typeof parsed.savedAt !== "number") return null;
      if (Date.now() - parsed.savedAt > METADATA_MAX_AGE_MS) return null;
      return decodeModelsDev(parsed.data);
    } catch { return null; }
  }

  async writeCache(data) {
    if (!this.cachePath) return;
    try {
      await mkdir(join(this.cachePath, ".."), { recursive: true });
      const tmp = `${this.cachePath}.tmp`;
      await writeFile(tmp, JSON.stringify({ savedAt: Date.now(), data }), "utf8");
      await rename(tmp, this.cachePath);
    } catch { /* cache write is best-effort */ }
  }

  list() {
    const ids = new Set(this.liveIds);
    for (const id of STATIC_MODELS) ids.add(id);
    const result = [];
    for (const id of ids) {
      const entry = entryFor(id);
      if (!entry) continue;
      if (this.readSettings().includeFreeModels === false && entry.free) continue;
      result.push(this.decorate(entry));
    }
    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
  }

  resolve(id) {
    const entry = entryFor(id);
    if (!entry) return null;
    return this.decorate(entry);
  }

  decorate(entry) {
    const meta = this.metadata.get(entry.id);
    const contextWindow = meta?.contextWindow ?? entry.contextWindow;
    const maxTokens = meta?.maxTokens ?? entry.maxTokens;
    const reasoning = meta?.reasoning ?? entry.reasoning;
    return {
      ...entry,
      contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
      maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
      reasoning,
      effortValues: meta?.effortValues ?? [],
    };
  }
}

/* ------------------------------------------------------------------ */
/* volatile config reading                                             */
/* ------------------------------------------------------------------ */

/** 与参考插件一致：Loader 的 volatile 引用只要具备 get() 即视为引用。
 *  （此前额外要求 commit/onChange，导致本版本的引用被误判为普通对象，
 *   于是 config.console.apiKey 永远读不到。） */
function isVolatileRef(value) {
  return typeof value === "object" && value !== null && typeof value.get === "function";
}

function readVolatile(value) {
  if (value === undefined || value === null) return undefined;
  if (isVolatileRef(value)) {
    let current;
    try {
      current = value.get();
    } catch {
      return value;
    }
    return current === undefined || current === null ? value : current;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* LLM adapter                                                         */
/* ------------------------------------------------------------------ */

class ZenAdapter {
  constructor(catalog, readSettings, report) {
    this.catalog = catalog;
    this.readSettings = readSettings;
    this.report = typeof report === "function" ? report : () => {};
  }

  providerInfo(provider) {
    return { id: provider, name: "OpenCode Zen" };
  }

  providerRetryPolicy() { return undefined; }

  imageRequestPricing() { return undefined; }

  listModels(provider) {
    return this.catalog.list().map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.inputModalities,
    }));
  }

  resolveModel(provider, model) {
    const entry = this.catalog.resolve(model) ?? { id: model, name: model, api: apiForModel(model), inputModalities: ["text"] };
    const resolved = {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.inputModalities,
      context: { contextWindow: contextWindowFor(entry) },
      defaultMaxTokens: defaultMaxTokensFor(entry),
    };
    const efforts = reasoningEffortsFor(entry);
    if (efforts) resolved.reasoning = { efforts: entry.api === "responses" ? efforts.filter((effort) => effort.id !== "off") : efforts };
    return resolved;
  }

  async prepareCall(provider, model, signal) {
    const resolved = this.resolveModel(provider, model);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  async *stream(options) {
    const settings = this.readSettings() ?? {};
    const configured = typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
    const envKey = typeof process !== "undefined" && process.env ? String(process.env.OPENCODE_ZEN_API_KEY ?? "").trim() : "";
    const apiKey = configured.length > 0 ? configured : envKey;
    if (!apiKey) {
      this.report(`no-api-key configured=${configured.length > 0} env=${envKey.length > 0}`);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      yield errorChunk("opencode-zen: OpenCode Console API Key not configured. Paste it in 设置 → 插件 → OpenCode Zen → 配置 (or provide OPENCODE_ZEN_API_KEY).", "AUTH");
      return;
    }
    const modelId = typeof options.model === "string" ? options.model : options.model?.id;
    const entry = this.catalog.resolve(modelId) ?? entryFor(modelId);
    const api = entry?.api ?? apiForModel(modelId);
    if (api === "excluded") {
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      yield errorChunk(`opencode-zen: model ${modelId} uses the SystemOne endpoint and is not chat-capable`, "INVALID_REQUEST");
      return;
    }
    const baseUrl = (typeof settings.baseUrl === "string" && settings.baseUrl.length > 0 ? settings.baseUrl : ZEN_BASE_URL).replace(/\/+$/, "");
    const contextWindow = contextWindowFor(entry);
    const effort = typeof options.reasoningEffort === "string"
      ? options.reasoningEffort
      : (typeof options.reasoning === "string" ? options.reasoning : undefined);
    const controller = new AbortController();
    const watchdog = createWatchdog(controller);
    const onAbort = () => controller.abort(options.signal?.reason ?? new Error("aborted"));
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason ?? new Error("aborted"));
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const headers = {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "user-agent": `@a42null/dsh-opencode-zen-plugin/${BUILD_TAG}`,
      };
      let url;
      let body;
      if (api === "responses") {
        url = `${baseUrl}/v1/responses`;
        body = {
          model: modelId,
          stream: true,
          input: await buildResponsesInput(options),
          ...(toolsPayload(options).length > 0 ? { tools: toolsPayload(options).map((t) => ({ type: "function", ...t })) } : {}),
          ...(reasoningEffortWire(effort) ? { reasoning: { effort: reasoningEffortWire(effort) } } : {}),
          ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
        };
      } else if (api === "anthropic") {
        url = `${baseUrl}/v1/messages`;
        headers["anthropic-version"] = "2023-06-01";
        headers["x-api-key"] = apiKey;
        const budget = effort === "off" ? undefined : reasoningBudgetFor(effort);
        const systemText = typeof options.system === "string" && options.system.length > 0
          ? options.system
          : (options.messages ?? []).filter((m) => m?.role === "system").map((m) => flattenText(m.content)).join("\n");
        body = {
          model: modelId,
          stream: true,
          max_tokens: Math.max(options.maxTokens ?? defaultMaxTokensFor(entry), budget ? budget + 1024 : 0),
          ...(systemText.length > 0 ? { system: systemText } : {}),
          messages: await buildAnthropicMessages(options),
          ...(toolsPayload(options).length > 0 ? { tools: toolsPayload(options) } : {}),
          ...budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {},
        };
      } else if (api === "google") {
        url = `${baseUrl}/v1/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
        headers["x-goog-api-key"] = apiKey;
        const budget = effort === "off" ? 0 : reasoningBudgetFor(effort);
        const googleSystem = typeof options.system === "string" && options.system.length > 0
          ? options.system
          : (options.messages ?? []).filter((m) => m?.role === "system").map((m) => flattenText(m.content)).join("\n");
        body = {
          contents: await buildGoogleContents(options),
          ...(googleSystem.length > 0 ? { systemInstruction: { parts: [{ text: googleSystem }] } } : {}),
          ...(toolsPayload(options).length > 0 ? { tools: [{ functionDeclarations: toolsPayload(options) }] } : {}),
          generationConfig: {
            ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
            ...budget !== undefined ? { thinkingConfig: { thinkingBudget: budget } } : {},
          },
        };
      } else {
        url = `${baseUrl}/v1/chat/completions`;
        body = {
          model: modelId,
          stream: true,
          stream_options: { include_usage: true },
          messages: await buildChatMessages(options),
          ...(toolsPayload(options).length > 0 ? { tools: toolsPayload(options).map((t) => ({ type: "function", function: t })) } : {}),
          ...(reasoningEffortWire(effort) ? { reasoning_effort: reasoningEffortWire(effort) } : {}),
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        };
      }

      let response;
      try {
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted && options.signal?.aborted) {
          yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
          yield { type: "finish", reason: { kind: "aborted" } };
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        const code = classifyError(message);
        const hint = errorHint(code);
        this.report(`fetch-failed api=${api} model=${modelId} code=${code} message=${message}`);
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
        yield errorChunk(`opencode-zen: request failed: ${message}${hint ? ` — ${hint}` : ""}`, code);
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const snippet = text.length > 0 ? text.slice(0, 500) : "";
        const code = classifyError(`${response.status} ${snippet}`);
        const hint = errorHint(code);
        this.report(`http-${response.status} api=${api} model=${modelId} code=${code} body=${snippet.slice(0, 200)}`);
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
        yield errorChunk(`opencode-zen: HTTP ${response.status} ${response.statusText}${snippet ? ` — ${snippet}` : ""}${hint ? ` — ${hint}` : ""}`, code);
        return;
      }

      if (!response.body) {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
        yield errorChunk("opencode-zen: response has no body", "TRANSPORT");
        return;
      }

      if (api === "responses") yield* streamResponses(response, options, contextWindow, watchdog);
      else if (api === "anthropic") yield* streamAnthropic(response, options, contextWindow, watchdog);
      else if (api === "google") yield* streamGoogle(response, options, contextWindow, watchdog);
      else yield* streamChatCompletions(response, options, contextWindow, watchdog);
    } finally {
      watchdog.dispose();
      if (options.signal) options.signal.removeEventListener?.("abort", onAbort);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Config / plugin entry                                               */
/* ------------------------------------------------------------------ */

const ConsoleConfigSchema = Schema.object({
  apiKey: Schema.string().role("secret").default("").description("OpenCode Console API Key（https://opencode.ai/console 获取）"),
  baseUrl: Schema.string().default(ZEN_BASE_URL).description("OpenCode Zen 网关地址"),
  includeFreeModels: Schema.boolean().default(false).description("是否在模型列表中包含免费模型（*-free 只能在 OpenCode 客户端内使用，经 Console API 调用会返回 FreeTierError）"),
  refreshSeconds: Schema.number().step(1).min(30).max(86400).default(300).description("模型目录自动刷新间隔（秒）"),
});

const Config = Schema.object({
  console: ConsoleConfigSchema.volatile(),
  providerId: Schema.string().default(PROVIDER_ID).description("DSH 中显示的 Provider ID"),
});

const name = PROVIDER_ID;
const inject = ["llm"];

function apply(ctx, config = {}) {
  const log = ctx.logger ?? { info: (...a) => console.info("[opencode-zen]", ...a), warn: (...a) => console.warn("[opencode-zen]", ...a), error: (...a) => console.error("[opencode-zen]", ...a) };
  if (!ctx.llm || typeof ctx.llm.registerAdapter !== "function") {
    log.warn("opencode-zen: llm service unavailable; adapter not registered");
    return { ready: false };
  }
  const providerId = typeof config.providerId === "string" && config.providerId.length > 0 ? config.providerId : PROVIDER_ID;
  const readSettings = () => {
    const raw = readVolatile(config.console) ?? {};
    return {
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
      baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.length > 0 ? raw.baseUrl : ZEN_BASE_URL,
      includeFreeModels: raw.includeFreeModels === true,
      refreshSeconds: typeof raw.refreshSeconds === "number" ? raw.refreshSeconds : 300,
    };
  };
  const dataDir = join(homedir(), ".opencode-zen");
  const errorsLog = join(dataDir, "errors.log");
  /** 诊断通道：把每次失败的原始码/响应体追加到 ~/.opencode-zen/errors.log（上限 128 KB）。 */
  const report = (line) => {
    const text = `${new Date().toISOString()} ${line}`;
    void mkdir(dataDir, { recursive: true })
      .then(async () => {
        const info = await stat(errorsLog).catch(() => null);
        if (info && info.size > 128 * 1024) await writeFile(errorsLog, "", "utf8");
        await appendFile(errorsLog, `${text}\n`, "utf8");
      })
      .catch(() => {});
  };
  const catalog = new ModelCatalog({
    readSettings,
    cachePath: join(dataDir, "models.dev.json"),
    onRefresh: (status) => {
      log.info(`opencode-zen: catalog ${status.status}, ${status.total} models${status.lastError ? ` (${status.lastError})` : ""}`);
      void mkdir(dataDir, { recursive: true })
        .then(() => writeFile(join(dataDir, "adapter-status.json"), JSON.stringify({ ...status, writtenAt: Date.now() }, null, 2), "utf8"))
        .catch(() => {});
    },
  });
  const adapter = new ZenAdapter(catalog, readSettings, report);
  const registration = ctx.llm.registerAdapter([providerId], adapter);
  catalog.start();
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      registration?.dispose?.();
      catalog.stop();
    });
  }
  // 加载标记：用于确认运行中的 DSH 载入的是哪一版代码、以及配置是否真的读到。
  const initial = readSettings();
  void mkdir(dataDir, { recursive: true })
    .then(() =>
      writeFile(
        join(dataDir, "plugin-load.json"),
        JSON.stringify(
          {
            loadedAt: new Date().toISOString(),
            pid: typeof process !== "undefined" ? process.pid : null,
            providerId,
            build: BUILD_TAG,
            consoleIsVolatileRef: isVolatileRef(config.console),
            apiKeyLength: initial.apiKey.length,
            apiKeyPrefix: initial.apiKey.slice(0, 10),
            baseUrl: initial.baseUrl,
            includeFreeModels: initial.includeFreeModels,
            refreshSeconds: initial.refreshSeconds,
          },
          null,
          2,
        ),
        "utf8",
      ),
    )
    .catch(() => {});
  log.info(`opencode-zen: registered provider "${providerId}" (Console API key from plugin settings) [${BUILD_TAG}]`);
  return { ready: true };
}

export { Config, apply, inject, name };
