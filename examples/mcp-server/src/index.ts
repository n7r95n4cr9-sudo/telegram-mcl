import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

type TelegramEnv = Env & {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
};

async function discoverChatId(token: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?limit=100`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      ok?: boolean;
      result?: Array<{ message?: { text?: string; chat?: { id?: number; type?: string } } }>;
    };
    if (!data.ok) return null;
    const ids = new Set(
      (data.result ?? [])
        .filter(({ message }) =>
          message?.chat?.type === "private" &&
          message.text?.startsWith("/start") &&
          typeof message.chat.id === "number" &&
          Number.isSafeInteger(message.chat.id)
        )
        .map(({ message }) => String(message!.chat!.id))
    );
    return ids.size === 1 ? [...ids][0] : null;
  } catch {
    return null;
  }
}

function createServer(env: TelegramEnv) {
  const server = new McpServer({
    name: "telegram-report",
    version: "1.0.0"
  });

  server.registerTool(
    "send_report",
    {
      description: "Send one plain-text report to the configured Telegram chat. With no chat ID configured, a unique private /start chat is used for setup. The dedupe_key is required but duplicate suppression is not implemented yet.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(3500),
        dedupe_key: z.string().trim().min(1).max(200)
      })
    },
    async ({ title, body }) => {
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        return {
          isError: true,
          content: [{ type: "text", text: "Telegram is not configured on this Worker." }]
        };
      }

      const chatId = env.TELEGRAM_CHAT_ID ?? (await discoverChatId(token));
      if (!chatId) {
        return {
          isError: true,
          content: [{ type: "text", text: "No unique private /start chat found. Configure TELEGRAM_CHAT_ID." }]
        };
      }

      let response: Response;
      try {
        response = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `${title}\n\n${body}` }),
            signal: AbortSignal.timeout(10_000)
          }
        );
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "Telegram request failed or timed out." }]
        };
      }

      let result: { ok?: boolean; result?: { message_id?: number } };
      try {
        result = (await response.json()) as typeof result;
      } catch {
        result = {};
      }
      if (!response.ok || !result.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Telegram rejected the report (HTTP ${response.status}).` }]
        };
      }

      return {
        content: [{
          type: "text",
          text: `Report sent to Telegram (message ID ${result.result?.message_id ?? "unknown"}).${env.TELEGRAM_CHAT_ID ? "" : ` Set TELEGRAM_CHAT_ID to ${chatId}.`} Duplicate suppression is not active.`
        }]
      };
    }
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => createServer(env as TelegramEnv)).fetch(request, env, ctx);
  }
};
