/**
 * @rcarmo/piclaw-addon-telegram — Telegram Bot channel addon for PiClaw.
 *
 * Polling, settings and delivery live in the startup runtime entry
 * (runtime.ts → service.ts). This pi extension only links agent runs in the
 * dedicated target chat back to the in-flight Telegram message, so the final
 * reply of that run (after retries and recovery continuations) is sent to
 * Telegram. Session start or shutdown never connects or disconnects the channel.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { peekTelegramService } from "./service.js";

type AgentMessageLike = { role?: string; content?: unknown; stopReason?: string };

/** Text of the last assistant message, or null when the run ended in an error or abort. */
export function finalAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as AgentMessageLike | null;
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") return null;
    const parts = Array.isArray(message.content) ? message.content : [];
    return parts
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return null;
}

function currentChatJid(): string {
  const interop = (globalThis as { __piclawRuntimeInterop?: { getChatJid?: (defaultValue?: string) => string } }).__piclawRuntimeInterop;
  try { return interop?.getChatJid?.("") || ""; } catch { return ""; }
}

const register: ExtensionFactory = (pi: ExtensionAPI) => {
  // Per-session state: side sessions get their own factory instance and never see this claim.
  let claimed: number | null = null;
  let lastText: string | null = null;

  const settle = (aborted: boolean) => {
    const runId = claimed;
    if (runId === null) return;
    // Without a successful reply the claim stays open for Piclaw's recovery continuation.
    if (lastText !== null || aborted) claimed = null;
    void peekTelegramService()?.completeRun(runId, lastText, aborted).catch(() => {});
  };

  pi.on("before_agent_start", (event) => {
    const service = peekTelegramService();
    if (claimed !== null) {
      // Piclaw re-prompts the same session with a neutral continuation after a failed attempt.
      if (service?.continueRun(claimed, event.prompt)) return;
      claimed = null;
    }
    const runId = service?.claimRun(currentChatJid(), event.prompt) ?? null;
    if (runId !== null) {
      claimed = runId;
      lastText = null;
    }
  });

  // Retries emit agent_end more than once; keep the latest successful reply.
  pi.on("agent_end", (event) => {
    if (claimed === null) return;
    const text = finalAssistantText(event.messages);
    if (text !== null) lastText = text;
  });

  // `aborted` was added to agent_settled in later Pi releases; older ones omit it.
  pi.on("agent_settled", (event) => settle((event as { aborted?: unknown }).aborted === true));
};

export default register;
