import { afterEach, expect, test } from "bun:test";
import registerExtension from "./index.js";
import { NOTICES, TelegramService, containsMessageBody, splitMessage, stripInternal } from "./service.js";
import type { TelegramApi } from "./service.js";

const OPERATOR = 111222333;
const TARGET = "web:telegram";
const SERVICE_KEY = Symbol.for("piclaw.addon.telegram.service");
const START = 1_700_000_000_000;
const CONTINUATION = "Continue the current task from persisted state without repeating completed work.";

class FakeApi implements TelegramApi {
  batches: unknown[][] = [];
  sent: Array<[number, string]> = [];
  offsets: Array<number | undefined> = [];
  getMeErrors: unknown[] = [];
  sendErrors: unknown[] = [];
  polls = 0;
  wake?: () => void;
  async getMe() {
    const error = this.getMeErrors.shift();
    if (error) throw error;
    return { id: 42 };
  }
  async getUpdates(params: { offset?: number }, signal?: AbortSignal) {
    this.polls++;
    this.offsets.push(params.offset);
    const batch = this.batches.shift();
    if (batch) return batch;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return this.batches.shift() ?? [];
  }
  /** Delivers a batch to a long poll that is already waiting. */
  push(batch: unknown[]) {
    this.batches.push(batch);
    this.wake?.();
  }
  async sendMessage(chatId: number, text: string) {
    const error = this.sendErrors.shift();
    if (error) throw error;
    this.sent.push([chatId, text]);
    return {};
  }
  async sendChatAction() { return true; }
}

type HarnessOptions = {
  settings?: Record<string, unknown> | null;
  env?: Record<string, string>;
  keychain?: string | null;
  knownChats?: string[];
  runtimeApi?: boolean;
};

function harness(options: HarnessOptions = {}) {
  const kv = new Map<string, unknown>();
  if (options.settings !== null) {
    kv.set("global:settings", options.settings ?? { enabled: true, allowedUserIds: [String(OPERATOR)], targetChatJid: TARGET, pollingTimeout: 30 });
  }
  const api = new FakeApi();
  const enqueued: unknown[] = [];
  const shutdownHandlers: Array<() => void | Promise<void>> = [];
  const tokens: string[] = [];
  const timers: Array<() => void> = [];
  const clock = { now: START };
  let chatJid = TARGET;
  const known = new Set(options.knownChats ?? [TARGET]);
  const runtime = {
    lifecycle: { version: 1, onShutdown: (handler: () => void | Promise<void>) => { shutdownHandlers.push(handler); return () => {}; } },
    enqueueAgentMessage: async (request: unknown) => { enqueued.push(request); return { status: "ok" }; },
    messaging: { version: 1, resolveLocalTarget: async (input: { target_chat_jid: string }) => ({ status: known.has(input.target_chat_jid) ? "resolved" : "not_found" }) },
  };
  const interop = {
    getExtensionKvStore: () => ({
      get: (_addon: string, key: string, scope?: string) => kv.get(`${scope ?? "chat"}:${key}`) as never,
      set: (_addon: string, key: string, value: unknown, scope?: string) => { kv.set(`${scope ?? "chat"}:${key}`, value); },
    }),
    getKeychainEntry: async (name: string) => {
      if (name !== "telegram/bot-token" || options.keychain === null) throw new Error(`Keychain entry not found: ${name}`);
      return { secret: options.keychain ?? "123:keychain-token" };
    },
    getChatJid: () => chatJid,
  };
  const service = new TelegramService({
    runtime: () => (options.runtimeApi === false ? undefined : runtime),
    interop: () => interop,
    env: options.env ?? {},
    createApi: async (token) => { tokens.push(token); return api; },
    now: () => clock.now,
    sleep: async () => {},
    setTimer: (_ms, run) => { timers.push(run); return () => { const index = timers.indexOf(run); if (index >= 0) timers.splice(index, 1); }; },
    log: { info: () => {}, warn: () => {} },
  });
  (globalThis as Record<symbol, unknown>)[SERVICE_KEY] = service;
  (globalThis as Record<string, unknown>).__piclawRuntimeInterop = interop;
  return { service, api, kv, enqueued, shutdownHandlers, tokens, timers, clock, setChat: (jid: string) => { chatJid = jid; } };
}

function textUpdate(updateId: number, text: string, fromId = OPERATOR) {
  return {
    update_id: updateId,
    message: { message_id: updateId, date: START / 1000 + 1, from: { id: fromId, is_bot: false }, chat: { id: fromId, type: "private" }, text },
  };
}

/** Minimal pi stand-in: collects handlers so tests can emit session events. */
function fakePi() {
  const handlers = new Map<string, Array<(event: any) => unknown>>();
  const pi = { on: (name: string, handler: (event: any) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
  registerExtension(pi as never);
  return {
    handlers,
    emit: async (name: string, event: Record<string, unknown> = {}) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }); },
  };
}

async function settle(condition: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const prompt = (text: string) => `Channel: web\n\nChat: ${TARGET}\n\nuser @ 2026-10-12T10:00:00Z:\n${text.split("\n").map((line) => `  ${line}`).join("\n")}`;
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });

let active: TelegramService | null = null;
afterEach(async () => {
  await active?.stop();
  active = null;
  delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
  delete (globalThis as Record<string, unknown>).__piclawRuntimeInterop;
});

test("boot restore starts polling from saved settings without any agent session", async () => {
  const h = harness();
  active = h.service;
  await h.service.start();
  await settle(() => h.api.polls > 0, "first poll");
  expect(h.service.connected).toBeTrue();
  expect(h.tokens).toEqual(["123:keychain-token"]);
  expect(h.shutdownHandlers).toHaveLength(1);
});

test("allowlisted messages are queued into the dedicated chat through the runtime API", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(1, "hello")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  expect(h.enqueued[0]).toEqual({ chatJid: TARGET, content: "hello", mode: "queue", source: "telegram" });
});

test("unauthorized senders are ignored without a reply", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(1, "let me in", 999), { update_id: 2, edited_message: textUpdate(2, "edit").message }]);
  await h.service.start();
  await settle(() => h.api.polls > 1, "second poll");
  expect(h.enqueued).toEqual([]);
  expect(h.api.sent).toEqual([]);
});

test.each([
  ["no allowlist", { settings: { enabled: true, allowedUserIds: [], targetChatJid: TARGET } }, "Inactive: no allowed Telegram user IDs"],
  ["no target chat", { settings: { enabled: true, allowedUserIds: [String(OPERATOR)], targetChatJid: "" } }, "Inactive: no dedicated target chat"],
  ["web:default as target", { settings: { enabled: true, allowedUserIds: [String(OPERATOR)], targetChatJid: "web:default" } }, "Disabled"],
  ["unknown target chat", { knownChats: [] }, "Inactive: target chat not found"],
  ["missing bot token", { keychain: null }, "Inactive: bot token missing"],
  ["disabled", { settings: { enabled: false, allowedUserIds: [String(OPERATOR)], targetChatJid: TARGET } }, "Disabled"],
  ["no runtime API", { runtimeApi: false }, "Inactive: this Piclaw version lacks the add-on runtime API"],
])("fails closed with %s", async (_label, options, status) => {
  const h = harness(options as HarnessOptions);
  active = h.service;
  await h.service.start();
  expect(h.tokens).toEqual([]);
  expect(h.api.polls).toBe(0);
  expect(h.service.status).toBe(status);
});

test("environment token takes precedence over the keychain", async () => {
  const h = harness({ env: { TELEGRAM_BOT_TOKEN: "999:env-token" } });
  active = h.service;
  await h.service.start();
  expect(h.tokens).toEqual(["999:env-token"]);
});

test("session shutdown leaves polling running; lifecycle shutdown stops it", async () => {
  const h = harness();
  active = h.service;
  const pi = fakePi();
  expect(pi.handlers.has("session_start")).toBeFalse();
  expect(pi.handlers.has("session_shutdown")).toBeFalse();
  await h.service.start();
  await settle(() => h.api.polls > 0, "first poll");
  await pi.emit("session_shutdown");
  expect(h.service.connected).toBeTrue();

  await h.shutdownHandlers[0]();
  expect(h.service.connected).toBeFalse();
  await h.service.start();
  expect(h.api.polls).toBe(1);
});

test("the settled reply of the claimed run goes back to the sender once", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "line one\nline two")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");

  await session.emit("before_agent_start", { prompt: prompt("line one\nline two") });
  await session.emit("agent_end", { messages: [assistant("", "error")] });
  await session.emit("agent_end", { messages: [assistant("Here you go.<internal>scratch <internal>nested</internal> still hidden</internal>")] });
  await session.emit("agent_settled", { aborted: false });
  await settle(() => h.api.sent.length === 1, "reply");
  expect(h.api.sent).toEqual([[OPERATOR, "Here you go."]]);

  await session.emit("agent_settled", { aborted: false });
  expect(h.api.sent).toHaveLength(1);
});

test("other runs in the target chat, side sessions and other chats are not mirrored", async () => {
  const h = harness();
  active = h.service;
  const main = fakePi();
  const side = fakePi();
  h.api.batches.push([textUpdate(1, "status please")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");

  await main.emit("before_agent_start", { prompt: prompt("an unrelated web message") });
  await main.emit("agent_end", { messages: [assistant("web reply")] });
  await main.emit("agent_settled");

  h.setChat("web:other");
  await side.emit("before_agent_start", { prompt: prompt("status please") });
  await side.emit("agent_settled");
  h.setChat(TARGET);

  await main.emit("before_agent_start", { prompt: prompt("status please") });
  await side.emit("before_agent_start", { prompt: prompt("status please") });
  await side.emit("agent_end", { messages: [assistant("side reply")] });
  await side.emit("agent_settled");
  await main.emit("agent_end", { messages: [assistant("all good")] });
  await main.emit("agent_settled");
  await settle(() => h.api.sent.length === 1, "reply");
  expect(h.api.sent).toEqual([[OPERATOR, "all good"]]);
});

test("a second message while one is in flight is refused", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(1, "first"), textUpdate(2, "second")]);
  await h.service.start();
  await settle(() => h.api.sent.length === 1, "busy notice");
  expect(h.enqueued).toHaveLength(1);
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.busy]]);
});

test("commands are answered locally and never queued", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(1, "/compact"), textUpdate(2, "/start")]);
  await h.service.start();
  await settle(() => h.api.sent.length === 2, "notices");
  expect(h.enqueued).toEqual([]);
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.command], [OPERATOR, NOTICES.start]]);
});

test("settings are validated, stored globally without secrets and applied on reload", async () => {
  const h = harness({ settings: null });
  active = h.service;
  expect(() => h.service.saveSettings({ targetChatJid: "web:default" })).toThrow();
  expect(() => h.service.saveSettings({ allowedUserIds: "12,abc" })).toThrow();
  h.service.saveSettings({ enabled: true, allowedUserIds: `${OPERATOR}`, targetChatJid: TARGET, pollingTimeout: 999, botToken: "must-not-be-stored" });
  expect(h.kv.get("global:settings")).toEqual({ enabled: true, allowedUserIds: [String(OPERATOR)], targetChatJid: TARGET, pollingTimeout: 120 });
  await h.service.reload();
  await settle(() => h.api.polls > 0, "poll after reload");
  expect(h.service.connected).toBeTrue();
});

test("a failed attempt waits for Piclaw's recovery continuation in the same session", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "do the thing")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");

  await session.emit("before_agent_start", { prompt: prompt("do the thing") });
  await session.emit("agent_end", { messages: [assistant("", "error")] });
  await session.emit("agent_settled", { aborted: false });
  expect(h.api.sent).toEqual([]);
  expect(h.timers).toHaveLength(1);

  await session.emit("before_agent_start", { prompt: CONTINUATION });
  expect(h.timers).toHaveLength(0);
  await session.emit("agent_end", { messages: [assistant("Done after recovery.")] });
  await session.emit("agent_settled", { aborted: false });
  await settle(() => h.api.sent.length === 1, "reply");
  expect(h.api.sent).toEqual([[OPERATOR, "Done after recovery."]]);
});

test("a web turn after a failed attempt is not treated as recovery", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "telegram task")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  await session.emit("before_agent_start", { prompt: prompt("telegram task") });
  await session.emit("agent_end", { messages: [assistant("", "error")] });
  await session.emit("agent_settled", { aborted: false });

  await session.emit("before_agent_start", { prompt: prompt("a web user typing in the same chat") });
  await session.emit("agent_end", { messages: [assistant("web-only reply")] });
  await session.emit("agent_settled", { aborted: false });
  expect(h.api.sent).toEqual([]);
  expect(h.timers).toHaveLength(1);
  h.timers.shift()!();
  await settle(() => h.api.sent.length === 1, "failure notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.runFailed]]);
});

test("a failed run without recovery reports failure after the grace period and frees the channel", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "first")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  await session.emit("before_agent_start", { prompt: prompt("first") });
  await session.emit("agent_end", { messages: [assistant("", "error")] });
  await session.emit("agent_settled", { aborted: false });
  h.timers.shift()!();
  await settle(() => h.api.sent.length === 1, "failure notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.runFailed]]);

  h.api.push([textUpdate(2, "second")]);
  await settle(() => h.enqueued.length === 2, "second enqueue");
});

test("a claimed run is not displaced by the unclaimed timeout", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "long task")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  await session.emit("before_agent_start", { prompt: prompt("long task") });
  h.clock.now += 45 * 60 * 1000;
  h.api.push([{ ...textUpdate(2, "another"), message: { ...textUpdate(2, "another").message, date: h.clock.now / 1000 } }]);
  await settle(() => h.api.sent.length === 1, "busy notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.busy]]);
  await session.emit("agent_end", { messages: [assistant("finally")] });
  await session.emit("agent_settled", { aborted: false });
  await settle(() => h.api.sent.length === 2, "reply");
  expect(h.api.sent[1]).toEqual([OPERATOR, "finally"]);
  expect(h.enqueued).toHaveLength(1);
});

test("Telegram text equal to prompt metadata does not claim a foreign run", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "Channel: web")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  await session.emit("before_agent_start", { prompt: prompt("an unrelated web message") });
  await session.emit("agent_end", { messages: [assistant("web reply")] });
  await session.emit("agent_settled", { aborted: false });
  expect(h.api.sent).toEqual([]);
});

test("transient failures while connecting and sending are retried", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.getMeErrors.push(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }));
  h.api.sendErrors.push({ error_code: 429, parameters: { retry_after: 240 }, message: "Too Many Requests" });
  h.api.batches.push([textUpdate(1, "hi")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue after reconnect");
  await session.emit("before_agent_start", { prompt: prompt("hi") });
  await session.emit("agent_end", { messages: [assistant("hello")] });
  await session.emit("agent_settled", { aborted: false });
  await settle(() => h.api.sent.length === 1, "reply after retry");
  expect(h.api.sent).toEqual([[OPERATOR, "hello"]]);
});

test("notices from the poll loop are not retried", async () => {
  const h = harness();
  active = h.service;
  h.api.sendErrors.push({ error_code: 429, parameters: { retry_after: 240 }, message: "Too Many Requests" });
  h.api.batches.push([textUpdate(1, "/start"), textUpdate(2, "/help")]);
  await h.service.start();
  await settle(() => h.api.sent.length === 1, "second notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.command]]);
});

test("a rejected token stops the channel instead of retrying", async () => {
  const h = harness();
  active = h.service;
  h.api.getMeErrors.push({ error_code: 401, message: "Unauthorized" });
  await h.service.start();
  await settle(() => h.service.status === "Error: Telegram rejected the bot token", "fatal status");
  expect(h.api.polls).toBe(0);
});

test("reload starts from a fresh update offset", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(500, "/start")]);
  await h.service.start();
  await settle(() => h.api.offsets.length === 2, "second poll");
  expect(h.api.offsets).toEqual([undefined, 501]);
  await h.service.reload();
  await settle(() => h.api.offsets.length === 3, "poll after reload");
  expect(h.api.offsets[2]).toBeUndefined();
});

test("helpers", () => {
  expect(containsMessageBody(prompt("a\nb"), "a\nb")).toBeTrue();
  expect(containsMessageBody(prompt("xa\nb"), "a\nb")).toBeFalse();
  expect(containsMessageBody(prompt("other"), "Channel: web")).toBeFalse();
  expect(containsMessageBody(prompt("Files:\n- /workspace/docs/README.md"), "Files:\n- docs/README.md")).toBeTrue();
  expect(containsMessageBody(prompt("Files:\n- /workspace/other.md"), "Files:\n- docs/README.md")).toBeFalse();
  expect(containsMessageBody(prompt("Folders:\n- /workspace/README.md"), "Folders:\n- docs/../README.md")).toBeTrue();
  expect(containsMessageBody(prompt("Files:\n- /workspace/docs/a.md"), "Files:\n- docs//a.md")).toBeTrue();
  expect(containsMessageBody(prompt("- unrelated/report.txt"), "- report.txt")).toBeFalse();
  expect(containsMessageBody(prompt("Files:\n- /workspace/report.txt"), "Files:\n- ../report.txt")).toBeFalse();
  expect(containsMessageBody(prompt("Files:\n- relative/report.txt"), "Files:\n- report.txt")).toBeFalse();
  expect(stripInternal("visible<internal>hidden")).toBe("visible");
  expect(stripInternal("a<internal>x<internal>y</internal>z</internal>b")).toBe("ab");
  expect(splitMessage("x".repeat(5000)).map((chunk) => chunk.length)).toEqual([4096, 904]);
  expect(splitMessage(`${"a".repeat(4095)}😀`)).toEqual(["a".repeat(4095), "😀"]);
});
