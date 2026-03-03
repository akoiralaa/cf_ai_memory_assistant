/**
 * DeepResearchWorkflow
 *
 * A durable, resumable Cloudflare Workflow that orchestrates multi-step research
 * on a given stock symbol. Each step is independently retried on failure — the
 * workflow picks up exactly where it left off, not from scratch.
 *
 * Steps:
 *   1. fetch-market-data   → Yahoo Finance equity quote (retries 3×)
 *   2. fetch-macro-context → Treasury yields + VIX + SPX (retries 3×)
 *   3. synthesize-report   → Hermes-2-Pro Mistral 7B structured JSON analysis (retries 2×)
 *   4. persist-report      → Save completed report to KV (30-day TTL)
 *
 * This separation of real-time chat (Durable Object) from long-running
 * orchestration (Workflow) is the core architectural distinction:
 *   - DO  = per-session, low-latency, stateful actor
 *   - Workflow = multi-step, durable, retry-aware job runner
 */

import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

interface Env {
  AI: Ai;
  REPORTS: KVNamespace;
}

export interface DeepResearchParams {
  reportId: string;  // Caller-generated UUID — used as KV key
  symbol: string;
  noteContext: string; // Relevant saved notes from the DO, injected for context
}

// ── Output types ──────────────────────────────────────────────────────────────

interface MarketSnapshot {
  symbol: string;
  name?: string;
  price: number;
  changePercent: number;
  marketCap?: number;
  pe?: number;
  forwardPE?: number;
  beta?: number;
  weekHigh52?: number;
  weekLow52?: number;
}

interface MacroSnapshot {
  tenYrYield?: number;
  threeMonthYield?: number;
  vix?: number;
  spxLevel?: number;
  spxChangePercent?: number;
}

interface StructuredAnalysis {
  summary: string;
  macro_context: string;
  bull_case: string;
  bear_case: string;
  key_risks: string[];
  sentiment: "bullish" | "bearish" | "neutral";
  confidence_score: number;
}

export interface ResearchReport extends StructuredAnalysis {
  reportId: string;
  symbol: string;
  generatedAt: string;
  marketSnapshot: MarketSnapshot;
  macroSnapshot: MacroSnapshot;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildAnalysisPrompt(
  symbol: string,
  market: MarketSnapshot,
  macro: MacroSnapshot,
  noteContext: string
): string {
  return `You are a senior equity analyst. Analyze ${market.name ?? symbol} (${symbol}).

MARKET DATA:
- Price: $${market.price?.toFixed(2)} (${market.changePercent >= 0 ? "+" : ""}${market.changePercent?.toFixed(2)}% today)
- Market Cap: ${market.marketCap ? "$" + (market.marketCap / 1e9).toFixed(1) + "B" : "N/A"}
- P/E (TTM): ${market.pe?.toFixed(1) ?? "N/A"} | Forward P/E: ${market.forwardPE?.toFixed(1) ?? "N/A"}
- Beta: ${market.beta?.toFixed(2) ?? "N/A"}
- 52-Week Range: $${market.weekLow52?.toFixed(2)} – $${market.weekHigh52?.toFixed(2)}

MACRO CONTEXT:
- 10Y Treasury Yield: ${macro.tenYrYield?.toFixed(3) ?? "N/A"}%
- 3M T-Bill Yield:    ${macro.threeMonthYield?.toFixed(3) ?? "N/A"}%
- VIX (Fear Index):   ${macro.vix?.toFixed(2) ?? "N/A"}
- S&P 500:            ${macro.spxLevel?.toFixed(0) ?? "N/A"} (${macro.spxChangePercent != null ? (macro.spxChangePercent >= 0 ? "+" : "") + macro.spxChangePercent.toFixed(2) + "%" : "N/A"})

SAVED RESEARCH NOTES ON THIS NAME:
${noteContext || "None."}

Respond with ONLY a valid JSON object — no markdown, no code fences, no extra text:
{
  "summary": "2–3 sentence snapshot of the stock and its current situation",
  "macro_context": "how the macro backdrop specifically affects this name",
  "bull_case": "the strongest bull argument supported by the data",
  "bear_case": "the strongest bear argument supported by the data",
  "key_risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "sentiment": "bullish OR bearish OR neutral",
  "confidence_score": 0.0 to 1.0
}`;
}

// ── Workflow ──────────────────────────────────────────────────────────────────

export class DeepResearchWorkflow extends WorkflowEntrypoint<
  Env,
  DeepResearchParams
> {
  async run(
    event: WorkflowEvent<DeepResearchParams>,
    step: WorkflowStep
  ): Promise<{ reportId: string; symbol: string }> {
    const { reportId, symbol, noteContext } = event.payload;

    // ── Step 1: Fetch equity quote ─────────────────────────────────────────
    // If Yahoo Finance is flaky, this step retries up to 3× with exponential
    // back-off. The workflow does NOT restart from step 1 after step 2 starts.
    const marketData = await step.do(
      "fetch-market-data",
      { retries: { limit: 3, delay: "3 seconds", backoff: "exponential" } },
      async (): Promise<MarketSnapshot> => {
        const url =
          `https://query1.finance.yahoo.com/v7/finance/quote` +
          `?symbols=${encodeURIComponent(symbol)}` +
          `&fields=regularMarketPrice,regularMarketChangePercent,regularMarketChange,` +
          `marketCap,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,trailingPE,forwardPE,beta`;

        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) throw new Error(`Yahoo Finance returned HTTP ${res.status}`);

        const data = (await res.json()) as {
          quoteResponse: { result: Record<string, number | string>[] };
        };
        const q = data.quoteResponse?.result?.[0];
        if (!q) throw new Error(`No data returned for symbol "${symbol}"`);

        return {
          symbol: q.symbol as string,
          name: q.shortName as string | undefined,
          price: q.regularMarketPrice as number,
          changePercent: (q.regularMarketChangePercent as number) ?? 0,
          marketCap: q.marketCap as number | undefined,
          pe: q.trailingPE as number | undefined,
          forwardPE: q.forwardPE as number | undefined,
          beta: q.beta as number | undefined,
          weekHigh52: q.fiftyTwoWeekHigh as number | undefined,
          weekLow52: q.fiftyTwoWeekLow as number | undefined,
        };
      }
    );

    // ── Step 2: Fetch macro context ────────────────────────────────────────
    const macroData = await step.do(
      "fetch-macro-context",
      { retries: { limit: 3, delay: "3 seconds", backoff: "exponential" } },
      async (): Promise<MacroSnapshot> => {
        const url =
          `https://query1.finance.yahoo.com/v7/finance/quote` +
          `?symbols=%5ETNX,%5EIRX,%5EVIX,%5EGSPC` +
          `&fields=regularMarketPrice,regularMarketChangePercent`;

        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) throw new Error(`Macro fetch returned HTTP ${res.status}`);

        const data = (await res.json()) as {
          quoteResponse: {
            result: Array<{
              symbol: string;
              regularMarketPrice: number;
              regularMarketChangePercent: number;
            }>;
          };
        };

        const m: Record<string, number> = {};
        const pct: Record<string, number> = {};
        for (const r of data.quoteResponse?.result ?? []) {
          m[r.symbol] = r.regularMarketPrice;
          pct[r.symbol] = r.regularMarketChangePercent;
        }

        return {
          tenYrYield: m["^TNX"],
          threeMonthYield: m["^IRX"],
          vix: m["^VIX"],
          spxLevel: m["^GSPC"],
          spxChangePercent: pct["^GSPC"],
        };
      }
    );

    // ── Step 3: Structured LLM synthesis via Workers AI ───────────────────
    // Returns a typed JSON object — not a blob of text. Retries twice if the
    // model returns malformed JSON (rare with Llama 3.3 70B + clear prompting).
    const analysis = await step.do(
      "synthesize-report",
      { retries: { limit: 2, delay: "5 seconds", backoff: "linear" } },
      async (): Promise<StructuredAnalysis> => {
        const prompt = buildAnalysisPrompt(
          symbol,
          marketData,
          macroData,
          noteContext
        );

        const response = (await this.env.AI.run(
          "@hf/nousresearch/hermes-2-pro-mistral-7b",
          {
            messages: [
              {
                role: "system",
                content:
                  "You are a financial analyst. Respond with valid JSON only — " +
                  "no markdown fences, no preamble, no trailing text.",
              },
              { role: "user", content: prompt },
            ],
            max_tokens: 1024,
          }
        )) as { response: string };

        let raw = (response.response ?? "").trim();

        // Strip markdown code fences if the model wraps the JSON anyway
        const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenced) raw = fenced[1].trim();

        // Throws on bad JSON — triggers the step retry
        return JSON.parse(raw) as StructuredAnalysis;
      }
    );

    // ── Step 4: Persist completed report to KV (30-day TTL) ───────────────
    await step.do("persist-report", async () => {
      const report: ResearchReport = {
        reportId,
        symbol,
        generatedAt: new Date().toISOString(),
        marketSnapshot: marketData,
        macroSnapshot: macroData,
        ...analysis,
      };

      await this.env.REPORTS.put(
        `report:${reportId}`,
        JSON.stringify(report),
        { expirationTtl: 60 * 60 * 24 * 30 } // 30 days
      );
    });

    return { reportId, symbol };
  }
}
