import { AIChatAgent } from "@cloudflare/ai-chat";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { routeAgentRequest } from "agents";

// Re-export so Wrangler can bind the Workflow class at the module boundary
export { DeepResearchWorkflow } from "./workflow";

interface Env {
  AI: Ai;
  DEEP_RESEARCH: Workflow; // Cloudflare Workflow binding
  REPORTS: KVNamespace;    // KV store for completed research reports
}

interface ResearchNote {
  id: number;
  title: string;
  content: string;
  tags: string;
  created_at: string;
}


export class TradingAgent extends AIChatAgent<Env> {
  // Initialize persistent tables on first use
  async onStart() {
    // User research notes (manual saves)
    this.sql`
      CREATE TABLE IF NOT EXISTS research_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `;

    // Tracks deep research jobs triggered from this session.
    // Actual report data lives in KV (REPORTS binding).
    this.sql`
      CREATE TABLE IF NOT EXISTS research_reports (
        id TEXT PRIMARY KEY,           -- Our UUID, also the KV key suffix
        workflow_id TEXT,              -- Cloudflare Workflow instance ID (for status)
        symbol TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `;
  }

  // ── Tool implementations (called directly by the dispatch loop) ────────────

  // Fetch a single symbol via the v8/chart endpoint (no auth required)
  private async fetchChartMeta(symbol: string): Promise<{
    symbol: string; shortName?: string; currency?: string;
    regularMarketPrice: number; chartPreviousClose: number;
    marketState?: string; fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number;
  } | null> {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=false`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://finance.yahoo.com/",
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      chart: {
        result?: Array<{
          meta: {
            symbol: string; shortName?: string; currency?: string;
            regularMarketPrice: number; chartPreviousClose: number;
            marketState?: string; fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number;
          };
        }>;
      };
    };
    return data.chart.result?.[0]?.meta ?? null;
  }

  private async toolGetQuote(symbols: string[]): Promise<string> {
    try {
      const metas = await Promise.all(symbols.map((s) => this.fetchChartMeta(s)));
      const lines: string[] = [];
      for (let i = 0; i < symbols.length; i++) {
        const m = metas[i];
        if (!m) { lines.push(`${symbols[i]}: no data`); continue; }
        const prev = m.chartPreviousClose || m.regularMarketPrice;
        const price = m.regularMarketPrice;
        const change = price - prev;
        const changePct = prev ? (change / prev) * 100 : 0;
        const row = [
          `${m.symbol}${m.shortName ? `  (${m.shortName})` : ""}  [${m.marketState ?? ""}]`,
          `  Price: ${m.currency ?? "USD"} ${price.toFixed(2)}  ` +
            `${change >= 0 ? "▲" : "▼"} ${Math.abs(changePct).toFixed(2)}%  ` +
            `(${change >= 0 ? "+" : ""}${change.toFixed(2)})`,
        ];
        if (m.fiftyTwoWeekHigh && m.fiftyTwoWeekLow)
          row.push(`  52w: $${m.fiftyTwoWeekLow.toFixed(2)} – $${m.fiftyTwoWeekHigh.toFixed(2)}`);
        lines.push(row.join("\n"));
      }
      return lines.join("\n\n");
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  }

  private async toolGetYieldCurve(): Promise<string> {
    try {
      const yieldSymbols = ["^IRX", "^FVX", "^TNX", "^TYX"];
      const nameMap: Record<string, string> = {
        "^IRX": " 3-Month T-Bill", "^FVX": " 5-Year Treasury",
        "^TNX": "10-Year Treasury", "^TYX": "30-Year Treasury",
      };
      const metas = await Promise.all(yieldSymbols.map((s) => this.fetchChartMeta(s)));
      const m: Record<string, number> = {};
      const rows: string[] = ["── US Treasury Yield Curve ──"];
      for (let i = 0; i < yieldSymbols.length; i++) {
        const sym = yieldSymbols[i];
        const meta = metas[i];
        if (meta) {
          m[sym] = meta.regularMarketPrice;
          rows.push(`  ${nameMap[sym]}: ${meta.regularMarketPrice.toFixed(3)}%`);
        }
      }
      rows.push("\n── Key Spreads ──");
      if (m["^TNX"] && m["^TYX"]) rows.push(`  30Y–10Y: ${((m["^TYX"] - m["^TNX"]) * 100).toFixed(0)}bps  ${m["^TYX"] > m["^TNX"] ? "(normal)" : "(inverted)"}`);
      if (m["^TNX"] && m["^FVX"]) rows.push(`  10Y–5Y:  ${((m["^TNX"] - m["^FVX"]) * 100).toFixed(0)}bps`);
      if (m["^TNX"] && m["^IRX"]) rows.push(`  10Y–3M:  ${((m["^TNX"] - m["^IRX"]) * 100).toFixed(0)}bps  ${m["^TNX"] > m["^IRX"] ? "(normal)" : "(inverted — recessionary signal)"}`);
      return rows.join("\n");
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  }

  private async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "getQuote":
        return this.toolGetQuote(args.symbols as string[]);
      case "getYieldCurve":
        return this.toolGetYieldCurve();
      case "saveNote": {
        const { title, content, tags = "" } = args as { title: string; content: string; tags?: string };
        this.sql`INSERT INTO research_notes (title, content, tags) VALUES (${title}, ${content}, ${tags})`;
        return `✓ Saved: "${title}"`;
      }
      case "listNotes": {
        const { tag } = args as { tag?: string };
        const notes: ResearchNote[] = tag
          ? this.sql<ResearchNote>`SELECT * FROM research_notes WHERE tags LIKE ${"%" + tag + "%"} ORDER BY created_at DESC LIMIT 20`
          : this.sql<ResearchNote>`SELECT * FROM research_notes ORDER BY created_at DESC LIMIT 20`;
        if (!notes.length) return tag ? `No notes tagged "${tag}".` : "No notes saved yet.";
        return `── Notes (${notes.length}) ──\n\n` + notes.map((n) =>
          `[#${n.id}] ${n.title}${n.tags ? `  [${n.tags}]` : ""}\n${n.content.substring(0, 200)}${n.content.length > 200 ? "…" : ""}\n${n.created_at}`
        ).join("\n\n");
      }
      case "searchNotes": {
        const { query } = args as { query: string };
        const p = `%${query}%`;
        const notes = this.sql<ResearchNote>`SELECT * FROM research_notes WHERE title LIKE ${p} OR content LIKE ${p} OR tags LIKE ${p} ORDER BY created_at DESC`;
        if (!notes.length) return `No notes matching "${query}".`;
        return `Found ${notes.length} result(s):\n\n` + notes.map((n) => `[#${n.id}] ${n.title}\n${n.content}`).join("\n\n");
      }
      case "deleteNote": {
        const { id } = args as { id: number };
        this.sql`DELETE FROM research_notes WHERE id = ${id}`;
        return `✓ Note #${id} deleted.`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  }

  // Parse Hermes-2-Pro's native <tool_call> XML output and return the first call found.
  // The model outputs either JSON or Python-dict syntax inside the tags.
  private parseToolCall(text: string): { name: string; arguments: Record<string, unknown> } | null {
    const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
    if (!match) return null;
    try {
      // Model sometimes uses single quotes (Python dict style) — normalise to JSON
      const normalized = match[1]
        .trim()
        .replace(/'/g, '"')           // single → double quotes
        .replace(/True/g, "true")
        .replace(/False/g, "false")
        .replace(/None/g, "null");
      const parsed = JSON.parse(normalized);
      // Model outputs { name, arguments } or { name, parameters }
      const name = parsed.name ?? parsed.function;
      const args = parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};
      if (typeof name !== "string") return null;
      return { name, arguments: typeof args === "string" ? JSON.parse(args) : args };
    } catch {
      return null;
    }
  }

  // Strip <tool_call>…</tool_call> blocks from a response string
  private stripToolCalls(text: string): string {
    return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
  }

  async onChatMessage() {
    const MODEL = "@hf/nousresearch/hermes-2-pro-mistral-7b";
    type Msg = { role: string; content: string };

    // ── Extract text from the last user message ──────────────────────────────
    const lastMsg = this.messages.at(-1);
    const userText = lastMsg
      ? (lastMsg.parts ?? [])
          .filter((p: { type: string }) => p.type === "text")
          .map((p: { type: string; text?: string }) => p.text ?? "")
          .join("")
      : "";

    // ── Pre-fetch market data BEFORE calling the model ────────────────────────
    // Extract ticker symbols (1–5 uppercase letters) from the user message.
    const STOPWORDS = new Set([
      "I","A","AN","THE","BE","DO","IS","IN","ON","AT","OR","AND","FOR","NOT",
      "CAN","YOU","ME","MY","US","IT","AS","IF","OF","TO","UP","NO","SO","BY",
      "GO","WE","OK","GET","NEW","ALL","ANY","ARE","WAS","HAS","HAD","ITS",
    ]);
    const tickers = [
      ...new Set(
        Array.from(userText.matchAll(/\b([A-Z]{1,5})\b/g), (m) => m[1])
      ),
    ].filter((t) => !STOPWORDS.has(t));

    let dataContext = "";

    if (tickers.length > 0) {
      const quoteData = await this.toolGetQuote(tickers);
      dataContext += `\n\n--- Live Market Data (pre-fetched) ---\n${quoteData}\n---`;
    }

    if (/\b(yield|treasury|t-bill|10.year|10-year|interest rate|bond market)\b/i.test(userText)) {
      const yieldData = await this.toolGetYieldCurve();
      dataContext += `\n\n--- Live Yield Curve (pre-fetched) ---\n${yieldData}\n---`;
    }

    // ── Build system prompt ───────────────────────────────────────────────────
    const SYSTEM = `You are a trading and financial markets research assistant.
${dataContext
  ? `LIVE MARKET DATA HAS BEEN FETCHED AND IS SHOWN BELOW. Present it clearly to the user.\n${dataContext}\n`
  : ""}
You can save, list, search, and delete research notes. For note operations ONLY, output a single <tool_call> tag:
  Save:   <tool_call>{"name": "saveNote", "arguments": {"title": "...", "content": "...", "tags": "..."}}</tool_call>
  List:   <tool_call>{"name": "listNotes", "arguments": {}}</tool_call>
  Search: <tool_call>{"name": "searchNotes", "arguments": {"query": "..."}}</tool_call>
  Delete: <tool_call>{"name": "deleteNote", "arguments": {"id": 1}}</tool_call>

LIMITATIONS: No backtesting · No historical data · No options chains · No charts · No trade execution.`;

    // ── Build message history (last 6 only to prevent poisoning) ─────────────
    const recentMessages = this.messages.slice(-6);
    const history: Msg[] = recentMessages.map((m) => ({
      role: m.role,
      content:
        (m.parts ?? [])
          .filter((p: { type: string }) => p.type === "text")
          .map((p: { type: string; text?: string }) => p.text ?? "")
          .join("") || "",
    }));

    const messages: Msg[] = [{ role: "system", content: SYSTEM }, ...history];

    // ── First model call ──────────────────────────────────────────────────────
    const raw1 = await this.env.AI.run(
      MODEL,
      { messages } as Parameters<Ai["run"]>[1]
    );
    const responseText =
      raw1 && typeof raw1 === "object" && !("getReader" in (raw1 as object))
        ? ((raw1 as { response?: string }).response ?? "")
        : "";

    // ── Handle note tool calls ────────────────────────────────────────────────
    const toolCall = this.parseToolCall(responseText);
    if (toolCall) {
      let toolResult: string;
      try {
        toolResult = await this.dispatchTool(toolCall.name, toolCall.arguments);
      } catch (e) {
        toolResult = `Tool error: ${String(e)}`;
      }

      const messages2: Msg[] = [
        ...messages,
        { role: "assistant", content: responseText },
        {
          role: "user",
          content: `[${toolCall.name} result]\n${toolResult}\n\nRespond to the user based on this result. Do not output any <tool_call> tags.`,
        },
      ];

      const raw2 = await this.env.AI.run(
        MODEL,
        { messages: messages2 } as Parameters<Ai["run"]>[1]
      );
      const finalText =
        raw2 && typeof raw2 === "object" && !("getReader" in (raw2 as object))
          ? this.stripToolCalls((raw2 as { response?: string }).response ?? "")
          : toolResult; // fallback: show the raw tool result

      const textId = crypto.randomUUID();
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: "text-start", id: textId });
          writer.write({ type: "text-delta", id: textId, delta: finalText });
          writer.write({ type: "text-end", id: textId });
        },
      });
      return createUIMessageStreamResponse({ stream });
    }

    // ── Plain text response ───────────────────────────────────────────────────
    const text = this.stripToolCalls(responseText);
    const textId = crypto.randomUUID();
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: text });
        writer.write({ type: "text-end", id: textId });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env);
    return agentResponse ?? new Response("Not found", { status: 404 });
  },
};
