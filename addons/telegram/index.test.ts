import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finalAssistantText } from "./index.js";

const SERVICE_KEY = Symbol.for("piclaw.addon.telegram.service");
const previousRegistrar = (globalThis as any).__piclaw_registerAddonConfigApi;
const registrations: any[] = [];
(globalThis as any).__piclaw_registerAddonConfigApi = (...args: any[]) => { registrations.push(args); return "created"; };
// Importing the startup entry without Piclaw's runtime API must not throw.
await import(`./runtime.ts?test=${Date.now()}`);

afterAll(() => {
  delete (globalThis as any)[SERVICE_KEY];
  if (previousRegistrar === undefined) delete (globalThis as any).__piclaw_registerAddonConfigApi;
  else (globalThis as any).__piclaw_registerAddonConfigApi = previousRegistrar;
});

test("manifest declares a startup runtime entry and the supported Piclaw range", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  expect(manifest.piclaw.compatibleVersions).toBe(">=3.3.2");
  expect(manifest.pi.runtime).toEqual({ entries: ["runtime.ts"], load: "startup" });
  expect(manifest.dependencies?.grammy).toBe("1.46.0");
});

test("startup entry registers the module-scope config API and stays inactive without host APIs", async () => {
  expect(registrations).toHaveLength(1);
  const [addonId, action, handlers, extensionPath] = registrations[0];
  expect(addonId).toBe("telegram");
  expect(action).toBe("config");
  expect(typeof handlers.get).toBe("function");
  expect(typeof handlers.set).toBe("function");
  expect(extensionPath).toBe(import.meta.dir);
  const view = await handlers.get({}, new Request("http://localhost/"), null);
  expect(view).toMatchObject({ enabled: false, connected: false, botTokenKeychain: "telegram/bot-token", targets: [] });
  expect(view.status).toStartWith("Inactive");
});

test("final reply text skips failed attempts", () => {
  expect(finalAssistantText([{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }], stopReason: "stop" }])).toBe("ab");
  expect(finalAssistantText([{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error" }])).toBeNull();
  expect(finalAssistantText([{ role: "assistant", content: [], stopReason: "aborted" }])).toBeNull();
  expect(finalAssistantText(undefined)).toBeNull();
});

test("web pane saves the bot token through keychain only", () => {
  const source = readFileSync(join(import.meta.dir, "web", "index.ts"), "utf8");
  expect(source).toContain('const BOT_TOKEN_KEYCHAIN = "telegram/bot-token"');
  expect(source).toContain('fetch("/agent/keychain"');
  expect(source).not.toContain("botToken:");
  expect(source).toContain("allowedUserIds");
  expect(source).toContain("targetChatJid");
});
