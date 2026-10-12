/**
 * service.ts — Process-wide Telegram channel service.
 *
 * Owned by the startup runtime entry (runtime.ts), not by agent sessions:
 * polling starts at boot when enabled, survives individual session shutdowns
 * and stops through the Piclaw lifecycle API.
 *
 * Inbound text from allowlisted users is queued into one dedicated web chat via
 * `__piclaw_runtime.enqueueAgentMessage`. The pi extension (index.ts) claims
 * the agent run whose prompt contains that text as a message body and hands its
 * final reply back here once the run has settled, including Piclaw's recovery
 * continuations. Only one Telegram message is in flight at a time.
 */

/// <reference path="./grammy.d.ts" />

import { posix } from "node:path";
import { evaluateUpdate, isDedicatedChatJid, parseAllowedUserIds } from "./gate.js";
import { isRecoverableTelegramNetworkError } from "./telegram-network-errors.js";
import { resolveTelegramLongPollTimeoutSeconds } from "./telegram-request-timeouts.js";

export const ADDON_ID = "telegram";
export const BOT_TOKEN_KEYCHAIN = "telegram/bot-token";
const SETTINGS_KEY = "settings";
const SERVICE_KEY = Symbol.for("piclaw.addon.telegram.service");
const TELEGRAM_MESSAGE_LIMIT = 4096;
// An unclaimed message was never picked up by a run; a claimed one may still be recovering.
const UNCLAIMED_TTL_MS = 30 * 60 * 1000;
const CLAIMED_TTL_MS = 3 * 60 * 60 * 1000;
// After a failed attempt Piclaw may re-prompt with a neutral continuation; wait before giving up.
const FAILURE_GRACE_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 30_000;
const SEND_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;
/**
 * Piclaw's neutral recovery prompt (runtime/src/agent-pool/context-pressure-retry.ts).
 * Only this exact text continues a failed claim; if Piclaw changes it, the sender
 * gets the failure notice instead and no unrelated reply is ever forwarded.
 */
const RECOVERY_CONTINUATION_PROMPTS = new Set(["Continue the current task from persisted state without repeating completed work."]);

export const NOTICES = {
  start: "Connected to Piclaw. Send a plain text message.",
  command: "Commands (/, !) and @mentions are not available over Telegram.",
  unsupported: "Only plain text messages are supported.",
  busy: "Still working on your previous message. Please wait for the reply.",
  failed: "Could not deliver your message to Piclaw.",
  noText: "The agent finished without a text reply.",
  aborted: "The agent run was aborted.",
  runFailed: "The agent run failed. Check the target web chat for details.",
} as const;

export type TelegramSettings = {
  enabled: boolean;
  allowedUserIds: string[];
  targetChatJid: string;
  pollingTimeout: number;
};

const DEFAULT_SETTINGS: TelegramSettings = { enabled: false, allowedUserIds: [], targetChatJid: "", pollingTimeout: 30 };

export type TelegramApi = {
  getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }>;
  getUpdates(params: { offset?: number; timeout?: number; allowed_updates?: string[] }, signal?: AbortSignal): Promise<unknown[]>;
  sendMessage(chatId: number, text: string, other?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  sendChatAction(chatId: number, action: "typing", other?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type KvStore = {
  get(addon: string, key: string, scope?: "chat" | "global", scopeKey?: string): JsonValue | undefined;
  set(addon: string, key: string, value: unknown, scope?: "chat" | "global", scopeKey?: string): void;
};

type RuntimeApi = {
  lifecycle?: { version: number; onShutdown(handler: () => void | Promise<void>): () => void };
  enqueueAgentMessage?: (request: { chatJid: string; content: string; mode?: "auto" | "queue" | "steer"; source?: string }) => Promise<{ status?: string }>;
  messaging?: { version: number; resolveLocalTarget(input: { target_chat_jid: string }): Promise<{ status?: string }> };
};

type RuntimeInterop = {
  getExtensionKvStore?: () => KvStore;
  getKeychainEntry?: (name: string) => Promise<{ secret?: unknown }>;
  getChatJid?: (defaultValue?: string) => string;
};

export type TelegramServiceDeps = {
  runtime: () => RuntimeApi | undefined;
  interop: () => RuntimeInterop | undefined;
  env: Record<string, string | undefined>;
  createApi: (token: string) => Promise<TelegramApi>;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  setTimer: (ms: number, run: () => void) => () => void;
  log: { info(message: string): void; warn(message: string): void };
};

type Pending = { runId: number; chatId: number; text: string; createdAt: number; claimedAt: number | null; cancelFailureTimer?: () => void };
type ActiveRun = { abort: AbortController; api: TelegramApi; loop: Promise<void>; settings: TelegramSettings; token: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 120;
}

/** Parses a settings payload; returns an error string for anything invalid. */
export function parseSettings(value: unknown, base: TelegramSettings = DEFAULT_SETTINGS): TelegramSettings | string {
  if (!isRecord(value)) return "Settings must be an object.";
  const next = { ...base };
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") return "enabled must be a boolean.";
    next.enabled = value.enabled;
  }
  if (value.allowedUserIds !== undefined) {
    const ids = parseAllowedUserIds(value.allowedUserIds);
    if (!ids) return "allowedUserIds must contain numeric Telegram user IDs.";
    next.allowedUserIds = ids;
  }
  if (value.targetChatJid !== undefined) {
    const jid = typeof value.targetChatJid === "string" ? value.targetChatJid.trim() : null;
    if (jid === null || (jid !== "" && !isDedicatedChatJid(jid))) return "targetChatJid must be a dedicated web chat (not web:default).";
    next.targetChatJid = jid;
  }
  if (value.pollingTimeout !== undefined) {
    if (typeof value.pollingTimeout !== "number" || !Number.isFinite(value.pollingTimeout)) return "pollingTimeout must be a number.";
    next.pollingTimeout = Math.max(5, Math.min(120, Math.round(value.pollingTimeout)));
  }
  return next;
}

const REFERENCE_HEADER = /^(?:files|folders):$/i;
const REFERENCE_LINE = /^(\s*-\s+)(.+?)\s*$/;

/** Marks the lines Piclaw treats as Files:/Folders: entries (mirrors its prompt formatter). */
function referenceLines(lines: string[]): boolean[] {
  let inBlock = false;
  return lines.map((line) => {
    const header = line.trim();
    if (REFERENCE_HEADER.test(header)) { inBlock = true; return false; }
    if (!inBlock) return false;
    if (REFERENCE_LINE.test(line)) return true;
    if (header !== "") inBlock = false;
    return false;
  });
}

function bodyLineMatches(promptLine: string, line: string, isReference: boolean): boolean {
  const actual = promptLine.trimEnd();
  if (actual === `  ${line}`.trimEnd()) return true;
  if (!isReference) return false;
  // Piclaw rewrites relative reference entries to absolute workspace paths.
  const [, prefix, value] = REFERENCE_LINE.exec(line)!;
  if (value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  const relative = posix.normalize(value.replace(/^\.\//, ""));
  // Paths escaping the workspace resolve elsewhere; do not guess.
  if (relative === ".." || relative.startsWith("../")) return false;
  const rewritten = actual.startsWith(`  ${prefix}/`) ? actual.slice(2 + prefix.length) : "";
  return rewritten !== "" && posix.normalize(rewritten).endsWith(`/${relative}`);
}

/**
 * True when `text` appears in `prompt` as a message body: Piclaw's prompt
 * formatter indents every body line by two spaces under a sender header, so
 * header and metadata lines (Channel:, Chat:) never match.
 */
export function containsMessageBody(prompt: string, text: string): boolean {
  const promptLines = prompt.split("\n");
  const allLines = text.replace(/\r\n?/g, "\n").split("\n");
  const references = referenceLines(allLines);
  let first = 0;
  let last = allLines.length - 1;
  while (first <= last && !allLines[first].trim()) first++;
  while (last >= first && !allLines[last].trim()) last--;
  if (first > last) return false;
  const lines = allLines.slice(first, last + 1);
  const isReference = references.slice(first, last + 1);
  for (let start = 0; start + lines.length <= promptLines.length; start++) {
    if (lines.every((line, offset) => bodyLineMatches(promptLines[start + offset], line, isReference[offset]))) return true;
  }
  return false;
}

/** Splits text into Telegram-sized chunks without breaking surrogate pairs. */
export function splitMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let end = rest.lastIndexOf("\n", limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1] ?? "")) end--;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Drops <internal> blocks fail-closed: nesting is counted and an unclosed tag hides the rest. */
export function stripInternal(text: string): string {
  let result = "";
  let depth = 0;
  for (let index = 0; index < text.length;) {
    if (text.startsWith("<internal>", index)) { depth++; index += 10; continue; }
    if (text.startsWith("</internal>", index)) { if (depth > 0) depth--; index += 11; continue; }
    if (depth === 0) result += text[index];
    index++;
  }
  return result.trim();
}

function errorCode(error: unknown): number {
  const code = isRecord(error) ? error.error_code : undefined;
  return typeof code === "number" ? code : 0;
}

function retryAfterMs(error: unknown): number {
  const parameters = isRecord(error) && isRecord(error.parameters) ? error.parameters : undefined;
  const seconds = parameters?.retry_after;
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : 0;
}

function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5));
}

/** 401/404 mean the token is invalid or revoked; retrying cannot help. */
function isFatal(error: unknown): boolean {
  const code = errorCode(error);
  return code === 401 || code === 404;
}

export class TelegramService {
  status = "Disabled";
  connected = false;
  private active: ActiveRun | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private nextRunId = 1;
  private offset = 0;
  private lifecycleRegistered = false;
  private stopped = false;

  constructor(private readonly deps: TelegramServiceDeps) {}

  private kv(): KvStore | undefined {
    try { return this.deps.interop()?.getExtensionKvStore?.(); } catch { return undefined; }
  }

  readStoredSettings(): TelegramSettings {
    let raw: unknown;
    try { raw = this.kv()?.get(ADDON_ID, SETTINGS_KEY, "global"); } catch { raw = undefined; }
    const parsed = parseSettings(isRecord(raw) ? raw : {});
    return typeof parsed === "string" ? { ...DEFAULT_SETTINGS } : parsed;
  }

  /** Stored settings with environment overrides applied. */
  effectiveSettings(): TelegramSettings {
    const env = this.deps.env;
    const settings = this.readStoredSettings();
    if (env.PICLAW_TELEGRAM_ENABLED === "1") settings.enabled = true;
    const ids = env.PICLAW_TELEGRAM_ALLOWED_USER_IDS !== undefined ? parseAllowedUserIds(env.PICLAW_TELEGRAM_ALLOWED_USER_IDS) : undefined;
    if (ids !== undefined) settings.allowedUserIds = ids ?? [];
    const target = env.PICLAW_TELEGRAM_TARGET_CHAT_JID?.trim();
    if (target !== undefined && target !== "") settings.targetChatJid = isDedicatedChatJid(target) ? target : "";
    const timeout = Number(env.PICLAW_TELEGRAM_POLLING_TIMEOUT);
    if (validTimeout(timeout)) settings.pollingTimeout = timeout;
    return settings;
  }

  saveSettings(payload: unknown): TelegramSettings {
    const next = parseSettings(payload, this.readStoredSettings());
    if (typeof next === "string") throw new Error(`Invalid Telegram settings: ${next}`);
    const kv = this.kv();
    if (!kv) throw new Error("Telegram settings storage is unavailable.");
    kv.set(ADDON_ID, SETTINGS_KEY, { ...next }, "global");
    return next;
  }

  /** Token lookup order: environment, Piclaw keychain, legacy extension KV. */
  async resolveToken(): Promise<string> {
    const env = this.deps.env;
    const fromEnv = env.TELEGRAM_BOT_TOKEN?.trim() || env.PICLAW_TELEGRAM_BOT_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    const interop = this.deps.interop();
    try {
      const entry = await interop?.getKeychainEntry?.(BOT_TOKEN_KEYCHAIN);
      if (typeof entry?.secret === "string" && entry.secret.trim()) return entry.secret.trim();
    } catch { /* missing entry: fall through */ }
    try {
      const legacy = this.kv()?.get(ADDON_ID, "botToken");
      if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
    } catch { /* ignore */ }
    return "";
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serial.then(run);
    this.serial = next.catch(() => {});
    return next;
  }

  private redact(message: string, token: string): string {
    return token ? message.split(token).join("<redacted>") : message;
  }

  /** Starts polling if every precondition holds. Never throws. */
  start(): Promise<void> {
    return this.serialized(() => this.startNow());
  }

  /** Stops polling and re-evaluates settings, e.g. after a settings change. */
  reload(): Promise<void> {
    return this.serialized(async () => {
      await this.stopNow();
      await this.startNow();
    });
  }

  stop(): Promise<void> {
    return this.serialized(() => this.stopNow());
  }

  private async startNow(): Promise<void> {
    if (this.stopped || this.active) return;
    const runtime = this.deps.runtime();
    if (typeof runtime?.enqueueAgentMessage !== "function" || runtime.lifecycle?.version !== 1 || runtime.messaging?.version !== 1) {
      this.status = "Inactive: this Piclaw version lacks the add-on runtime API";
      return;
    }
    if (!this.lifecycleRegistered) {
      this.lifecycleRegistered = true;
      runtime.lifecycle.onShutdown(async () => {
        this.stopped = true;
        await this.stop();
      });
    }
    const settings = this.effectiveSettings();
    if (!settings.enabled) { this.status = "Disabled"; return; }
    if (!settings.allowedUserIds.length) { this.status = "Inactive: no allowed Telegram user IDs"; return; }
    if (!isDedicatedChatJid(settings.targetChatJid)) { this.status = "Inactive: no dedicated target chat"; return; }
    if (!(await this.targetExists(settings.targetChatJid))) { this.status = "Inactive: target chat not found"; return; }
    const token = await this.resolveToken();
    if (!token) { this.status = "Inactive: bot token missing"; return; }

    let api: TelegramApi;
    try {
      api = await this.deps.createApi(token);
    } catch {
      this.status = "Error: Telegram client unavailable";
      return;
    }
    // Update IDs are per bot; never carry a previous bot's offset over.
    this.offset = 0;
    this.status = "Connecting";
    const run: ActiveRun = { abort: new AbortController(), api, settings, token, loop: Promise.resolve() };
    run.loop = this.runLoop(run);
    this.active = run;
  }

  /** Connects (retrying transient failures) and then long-polls until aborted. */
  private async runLoop(run: ActiveRun): Promise<void> {
    const signal = run.abort.signal;
    for (let failures = 1; !signal.aborted; failures++) {
      try {
        const me = await run.api.getMe(signal);
        this.deps.log.info(`[telegram] Connected as bot ${me.id}`);
        break;
      } catch (error) {
        if (signal.aborted) return;
        if (this.failFatal(run, error)) return;
        this.status = "Retrying: could not connect to Telegram";
        this.deps.log.warn(`[telegram] Connect failed: ${this.redact(String((error as Error)?.message ?? error), run.token)}`);
        await this.deps.sleep(backoffMs(failures), signal);
      }
    }
    if (signal.aborted) return;
    this.connected = true;
    this.status = "Connected";
    await this.pollLoop(run, Math.floor(this.deps.now() / 1000));
  }

  private failFatal(run: ActiveRun, error: unknown): boolean {
    if (!isFatal(error)) return false;
    this.status = "Error: Telegram rejected the bot token";
    this.connected = false;
    run.abort.abort();
    return true;
  }

  private async stopNow(): Promise<void> {
    const run = this.active;
    this.active = null;
    this.clearPending();
    this.connected = false;
    if (!run) return;
    run.abort.abort();
    await run.loop.catch(() => {});
    if (!this.stopped) this.status = "Stopped";
  }

  private async targetExists(chatJid: string): Promise<boolean> {
    try {
      const result = await this.deps.runtime()?.messaging?.resolveLocalTarget({ target_chat_jid: chatJid });
      return result?.status === "resolved";
    } catch { return false; }
  }

  private async pollLoop(run: ActiveRun, activatedAt: number): Promise<void> {
    const allowed = new Set(run.settings.allowedUserIds);
    const timeout = resolveTelegramLongPollTimeoutSeconds(run.settings.pollingTimeout);
    let failures = 0;
    while (!run.abort.signal.aborted) {
      let updates: unknown[];
      try {
        updates = await run.api.getUpdates({ offset: this.offset || undefined, timeout, allowed_updates: ["message"] }, run.abort.signal);
      } catch (error) {
        if (run.abort.signal.aborted) break;
        if (this.failFatal(run, error)) break;
        const code = errorCode(error);
        failures++;
        this.connected = false;
        this.status = code === 409 ? "Retrying: another client is polling this bot" : "Retrying: Telegram unreachable";
        if (!code && !isRecoverableTelegramNetworkError(error)) {
          this.deps.log.warn(`[telegram] Polling error: ${this.redact(String((error as Error)?.message ?? error), run.token)}`);
        }
        // Honour Telegram's full retry_after; the wait ends early on stop.
        await this.deps.sleep(retryAfterMs(error) || backoffMs(failures), run.abort.signal);
        continue;
      }
      failures = 0;
      this.connected = true;
      this.status = "Connected";
      for (const update of Array.isArray(updates) ? updates : []) {
        if (run.abort.signal.aborted) break;
        const updateId = isRecord(update) ? update.update_id : undefined;
        if (typeof updateId === "number" && Number.isSafeInteger(updateId)) this.offset = Math.max(this.offset, updateId + 1);
        await this.handleUpdate(run, update, allowed, activatedAt);
      }
    }
    this.connected = false;
  }

  private async handleUpdate(run: ActiveRun, update: unknown, allowed: ReadonlySet<string>, activatedAt: number): Promise<void> {
    const decision = evaluateUpdate(update, allowed, activatedAt);
    if (decision.kind === "ignore") return;
    if (decision.kind !== "accept") {
      await this.send(run, decision.chatId, NOTICES[decision.kind], false);
      return;
    }
    const now = this.deps.now();
    if (this.pending && !this.isExpired(this.pending, now)) {
      await this.send(run, decision.chatId, NOTICES.busy, false);
      return;
    }
    this.clearPending();
    const pending: Pending = { runId: this.nextRunId++, chatId: decision.chatId, text: decision.text, createdAt: now, claimedAt: null };
    this.pending = pending;
    try {
      if (!(await this.targetExists(run.settings.targetChatJid))) throw new Error("target chat not found");
      const result = await this.deps.runtime()!.enqueueAgentMessage!({
        chatJid: run.settings.targetChatJid,
        content: decision.text,
        mode: "queue",
        source: "telegram",
      });
      if (result?.status !== "ok") throw new Error("enqueue not accepted");
    } catch (error) {
      if (this.pending === pending) this.clearPending();
      this.deps.log.warn(`[telegram] Delivery to ${run.settings.targetChatJid} failed: ${String((error as Error)?.message ?? error)}`);
      await this.send(run, decision.chatId, NOTICES.failed, false);
      return;
    }
    run.api.sendChatAction(decision.chatId, "typing", undefined, run.abort.signal).catch(() => {});
  }

  /**
   * Notices from the poll loop are sent once so they never stall polling; agent
   * replies (sent outside the loop) retry rate limits, server errors and
   * transient network failures, honouring Telegram's retry_after.
   */
  private async send(run: ActiveRun, chatId: number, text: string, retry = true): Promise<boolean> {
    for (const chunk of splitMessage(text)) {
      if (!(await this.sendChunk(run, chatId, chunk, retry ? SEND_ATTEMPTS : 1))) return false;
    }
    return true;
  }

  private async sendChunk(run: ActiveRun, chatId: number, chunk: string, attempts: number): Promise<boolean> {
    for (let attempt = 1; !run.abort.signal.aborted; attempt++) {
      try {
        await run.api.sendMessage(chatId, chunk, { link_preview_options: { is_disabled: true } }, run.abort.signal);
        return true;
      } catch (error) {
        const code = errorCode(error);
        const retryable = code === 429 || code >= 500 || (!code && isRecoverableTelegramNetworkError(error));
        const wait = retryAfterMs(error) || backoffMs(attempt - 1);
        if (!retryable || attempt >= attempts || wait > MAX_RETRY_AFTER_MS || run.abort.signal.aborted) {
          this.deps.log.warn(`[telegram] Send failed: ${this.redact(String((error as Error)?.message ?? error), run.token)}`);
          return false;
        }
        await this.deps.sleep(wait, run.abort.signal);
      }
    }
    return false;
  }

  private isExpired(pending: Pending, now: number): boolean {
    return pending.claimedAt === null
      ? now - pending.createdAt >= UNCLAIMED_TTL_MS
      : now - pending.claimedAt >= CLAIMED_TTL_MS;
  }

  private clearPending(): void {
    this.pending?.cancelFailureTimer?.();
    this.pending = null;
  }

  /**
   * Called from the pi extension when an agent run starts. Returns a run ID when
   * the run belongs to the in-flight Telegram message, otherwise null.
   */
  claimRun(chatJid: string, prompt: unknown): number | null {
    const run = this.active;
    const pending = this.pending;
    if (!run || !pending || pending.claimedAt !== null || chatJid !== run.settings.targetChatJid || typeof prompt !== "string") return null;
    if (this.isExpired(pending, this.deps.now())) { this.clearPending(); return null; }
    if (!containsMessageBody(prompt, pending.text)) return null;
    pending.claimedAt = this.deps.now();
    return pending.runId;
  }

  /**
   * After a failed attempt, Piclaw's recovery continuation in the claiming
   * session keeps the claim open. Any other prompt is a different turn.
   */
  continueRun(runId: number, prompt: unknown): boolean {
    const pending = this.pending;
    if (!this.active || pending?.runId !== runId || !pending.cancelFailureTimer) return false;
    if (typeof prompt !== "string" || !RECOVERY_CONTINUATION_PROMPTS.has(prompt)) return false;
    pending.cancelFailureTimer();
    pending.cancelFailureTimer = undefined;
    return true;
  }

  /**
   * Called when a claimed run settles. A successful or aborted run is answered
   * immediately; a failed attempt waits for a recovery continuation first.
   */
  async completeRun(runId: number, text: string | null, aborted: boolean): Promise<void> {
    const run = this.active;
    const pending = this.pending;
    if (!run || !pending || pending.runId !== runId) return;
    if (text === null && !aborted) {
      pending.cancelFailureTimer?.();
      pending.cancelFailureTimer = this.deps.setTimer(FAILURE_GRACE_MS, () => {
        if (this.pending !== pending || this.active !== run) return;
        this.pending = null;
        void this.send(run, pending.chatId, NOTICES.runFailed);
      });
      return;
    }
    this.clearPending();
    const reply = text === null ? "" : stripInternal(text);
    await this.send(run, pending.chatId, reply || (aborted ? NOTICES.aborted : NOTICES.noText));
  }

  async view(): Promise<Record<string, unknown>> {
    const settings = this.effectiveSettings();
    return {
      ...settings,
      connected: this.connected,
      status: this.status,
      botTokenConfigured: Boolean(await this.resolveToken()),
      botTokenKeychain: BOT_TOKEN_KEYCHAIN,
    };
  }
}

type PiclawHost = typeof globalThis & { __piclaw_runtime?: RuntimeApi; __piclawRuntimeInterop?: RuntimeInterop };

function defaultDeps(): TelegramServiceDeps {
  const host = globalThis as PiclawHost;
  return {
    runtime: () => host.__piclaw_runtime,
    interop: () => host.__piclawRuntimeInterop,
    env: process.env,
    createApi: async (token) => {
      const mod = await import("grammy");
      // SAFETY: TelegramApi is the subset of grammY's Api used here; grammy.d.ts mirrors those signatures.
      return new mod.Api(token) as unknown as TelegramApi;
    },
    now: () => Date.now(),
    setTimer: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
      signal.addEventListener("abort", done, { once: true });
    }),
    log: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
  };
}

/** One service per process, shared by the runtime entry and every pi session. */
export function getTelegramService(): TelegramService {
  const host = globalThis as Record<symbol, TelegramService | undefined>;
  return (host[SERVICE_KEY] ??= new TelegramService(defaultDeps()));
}

export function peekTelegramService(): TelegramService | undefined {
  return (globalThis as Record<symbol, TelegramService | undefined>)[SERVICE_KEY];
}
