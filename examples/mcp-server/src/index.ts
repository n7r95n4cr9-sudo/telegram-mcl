import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

type TelegramEnv = Env & {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  REPORT_DB?: D1Database;
};

type DeliveryRow = {
  payload_hash: string;
  status: string;
  chunks_total: number;
  chunks_sent: number;
  last_message_id: number | null;
};

type TelegramReply = {
  ok?: boolean;
  result?: { message_id?: number };
  parameters?: { retry_after?: number };
};

function message(text: string, isError = false) {
  return { isError, content: [{ type: "text" as const, text }] };
}

function splitReport(title: string, body: string): string[] {
  const characters = Array.from(body);
  const chunkSize = 3300;
  const total = Math.ceil(characters.length / chunkSize);
  return Array.from({ length: total }, (_, index) => {
    const heading = total > 1 ? title + " (" + (index + 1) + "/" + total + ")" : title;
    return heading + "\n\n" + characters.slice(index * chunkSize, (index + 1) * chunkSize).join("");
  });
}

async function payloadHash(title: string, body: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([title, body]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function markDelivery(
  db: D1Database,
  dedupeKey: string,
  status: "sending" | "sent" | "uncertain" | "failed",
  chunksSent: number,
  messageId: number | null,
): Promise<void> {
  await db.prepare(
    "UPDATE report_delivery SET status = ?, chunks_sent = ?, last_message_id = COALESCE(?, last_message_id), updated_at = CURRENT_TIMESTAMP WHERE dedupe_key = ?",
  ).bind(status, chunksSent, messageId, dedupeKey).run();
}

function createServer(env: TelegramEnv) {
  const server = new McpServer({ name: "telegram-report", version: "1.1.0" });

  server.registerTool(
    "send_report",
    {
      description: "Send a plain-text report to the configured private Telegram chat. Use a stable unique dedupe_key per report; repeating a key never sends again. Reports up to 16000 characters are split into numbered Telegram messages.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(16000),
        dedupe_key: z.string().trim().min(1).max(200),
      }),
    },
    async ({ title, body, dedupe_key }) => {
      const token = env.TELEGRAM_BOT_TOKEN;
      const chatId = env.TELEGRAM_CHAT_ID;
      const db = env.REPORT_DB;
      if (!token || !chatId || !db) {
        return message("Telegram delivery is not fully configured on this Worker.", true);
      }

      const chunks = splitReport(title, body);
      const hash = await payloadHash(title, body);
      let sent = 0;
      let lastMessageId: number | null = null;

      try {
        const claim = await db.prepare(
          "INSERT OR IGNORE INTO report_delivery (dedupe_key, payload_hash, status, chunks_total) VALUES (?, ?, 'sending', ?)",
        ).bind(dedupe_key, hash, chunks.length).run();
        if (claim.meta.changes !== 1) {
          const existing = await db.prepare(
            "SELECT payload_hash, status, chunks_total, chunks_sent, last_message_id FROM report_delivery WHERE dedupe_key = ?",
          ).bind(dedupe_key).first<DeliveryRow>();
          if (!existing) return message("Could not read the existing delivery record.", true);
          if (existing.payload_hash !== hash) {
            return message("This dedupe_key already belongs to a different report. Choose a new key.", true);
          }
          if (existing.status === "sent") {
            return message("Report already sent; no duplicate created (" + existing.chunks_sent + "/" + existing.chunks_total + " parts). Last message ID " + (existing.last_message_id ?? "unknown") + ".");
          }
          return message("This dedupe_key is already reserved (" + existing.chunks_sent + "/" + existing.chunks_total + " parts, state " + existing.status + "). No duplicate sent. Review delivery state before trying a new key.", true);
        }

        for (const chunk of chunks) {
          let reply: TelegramReply | null = null;
          let httpStatus = 0;
          for (let attempt = 0; attempt < 3; attempt++) {
            let response: Response;
            try {
              response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text: chunk }),
                signal: AbortSignal.timeout(10_000),
              });
            } catch {
              await markDelivery(db, dedupe_key, "uncertain", sent, lastMessageId);
              return message("Telegram request failed or timed out. Delivery outcome is uncertain; this key will not send again automatically.", true);
            }
            httpStatus = response.status;
            try {
              reply = (await response.json()) as TelegramReply;
            } catch {
              reply = null;
            }
            if (response.ok && reply?.ok && Number.isSafeInteger(reply.result?.message_id)) break;
            const retryAfter = reply?.parameters?.retry_after;
            if (httpStatus === 429 && attempt < 2 && typeof retryAfter === "number" && retryAfter >= 0 && retryAfter <= 5) {
              await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
              continue;
            }
            break;
          }
          if (httpStatus < 200 || httpStatus >= 300 || !reply?.ok || !Number.isSafeInteger(reply.result?.message_id)) {
            const status = httpStatus === 429 || (httpStatus >= 400 && httpStatus < 500) ? "failed" : "uncertain";
            await markDelivery(db, dedupe_key, status, sent, lastMessageId);
            return message("Telegram did not confirm part " + (sent + 1) + "/" + chunks.length + " (HTTP " + httpStatus + "). Already confirmed: " + sent + ". State: " + status + ". Do not use a new key without checking Telegram.", true);
          }
          lastMessageId = reply.result!.message_id!;
          sent++;
          await markDelivery(db, dedupe_key, sent === chunks.length ? "sent" : "sending", sent, lastMessageId);
        }
        return message("Report sent to Telegram (" + sent + "/" + chunks.length + " parts; last message ID " + lastMessageId + ").");
      } catch {
        return message("Delivery state could not be confirmed. The key is reserved if it was saved; check Telegram and the D1 record before retrying.", true);
      }
    },
  );
  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => createServer(env as TelegramEnv)).fetch(request, env, ctx);
  },
};
