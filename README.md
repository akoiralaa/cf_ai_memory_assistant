# cf_ai_memory_assistant — Trading Research Agent

An AI-powered trading and financial markets research assistant built on Cloudflare's full agent stack. Ask questions about equities, options, macro, yield curves, and more — get live price quotes, and save research notes that persist across all sessions.

**Live demo:** https://cf-ai-memory-assistant.akoiralaa.workers.dev

> **Scope:** Educational use only · No backtesting · No historical data · No options chains · No trade execution · Live quotes via Yahoo Finance

## Architecture

| Cloudflare Primitive | Role |
|---|---|
| **Workers AI** (Hermes-2-Pro Mistral 7B) | LLM inference — conversational Q&A, note management, market data formatting |
| **Durable Objects** (`TradingAgent`) | Per-session stateful actor — owns WebSocket, chat history, research notes |
| **Durable Objects SQLite** | Low-latency persistent storage embedded in the DO |
| **Cloudflare Workflows** (`DeepResearchWorkflow`) | Durable multi-step orchestration with per-step retry semantics (architectural component) |
| **KV Namespace** (`REPORTS`) | Output store for workflow-generated research reports (30-day TTL) |
| **Workers** | Entry point — routes requests to agents or static assets |

## Why This Architecture

**Durable Objects = real-time, per-session actors.**
The `TradingAgent` DO holds the WebSocket open, streams chat responses to the browser, and maintains per-user isolated state (notes, chat history). Optimized for low latency and immediate response.

**Workflows = durable, resumable, long-running jobs.**
`DeepResearchWorkflow` demonstrates multi-step durable orchestration: each step is independently checkpointed with configurable retry semantics. If step 2 fails, the workflow retries from step 2, not step 1 — recovery semantics you cannot replicate with a plain `fetch` or tool call.

**Workers AI = compute at the edge.**
The agent calls `@hf/nousresearch/hermes-2-pro-mistral-7b` via the `AI` binding — no external API key, no egress to a third party, inference on Cloudflare's GPU fleet.

**Pre-fetch approach for market data.**
Rather than relying on LLM tool-calling (which proved unreliable across multiple tested configurations for this model/binding combination), market data is fetched server-side *before* the model is invoked. Ticker symbols are extracted from the user message via regex, Yahoo Finance's `v8/finance/chart` API is called in parallel for all symbols, and the results are injected into the system prompt as structured context. The model's role is formatting and analysis — not data retrieval. This is more robust and deterministic.

**KV = shared output store.**
The Workflow writes structured JSON reports to KV. The DO reads from the same KV binding. This decouples the orchestration layer from the interaction layer — reports are globally readable from any Worker, Workflow, or DO instance.

```
Browser (React + WebSocket)
    │
    ▼
Cloudflare Worker  ──  routeAgentRequest()
    │
    ▼
TradingAgent (Durable Object)           ← real-time, per-session
    ├── SQLite: chat history
    ├── SQLite: research_notes
    ├── Pre-fetch: getQuote()      → Yahoo Finance v8/chart (parallel)
    ├── Pre-fetch: getYieldCurve() → Yahoo Finance v8/chart (parallel)
    └── Note tools (via <tool_call> parsing):
        ├── saveNote / listNotes / searchNotes / deleteNote → SQLite

DeepResearchWorkflow (Cloudflare Workflow)  ← durable, resumable
    ├── Step 1: fetch-market-data   → Yahoo Finance   (retries 3×)
    ├── Step 2: fetch-macro-context → Yahoo Finance   (retries 3×)
    ├── Step 3: synthesize-report   → Workers AI LLM  (retries 2×)
    └── Step 4: persist-report      → KV
```

## Market Data — Pre-Fetch Pipeline

Instead of asking the LLM to call a tool, the server handles data retrieval deterministically:

1. **Ticker extraction** — regex `\b([A-Z]{1,5})\b` scans the user message for uppercase symbols, filtered against a stopword list
2. **Parallel fetch** — `Promise.all` calls `https://query2.finance.yahoo.com/v8/finance/chart/{symbol}` for each ticker (v8/chart endpoint requires no authentication, unlike the v7/quote batch endpoint which now requires a session crumb)
3. **Context injection** — formatted quote data is prepended to the system prompt before the model is called
4. **Model formats** — the LLM receives the live data as ground truth and presents it to the user

## Deep Research Workflow — Structured LLM Output

The workflow synthesis step (Step 3) demonstrates structured LLM output — treating model response as typed data rather than raw text:

```json
{
  "summary": "NVIDIA is trading at a premium to historical multiples...",
  "macro_context": "Elevated rates compress growth multiples; VIX at 18 suggests...",
  "bull_case": "Data center demand from AI training workloads remains...",
  "bear_case": "Forward P/E of 35x prices in continued hyperscaler capex...",
  "key_risks": ["China export restrictions", "AMD competitive pressure", "Capex cycle slowdown"],
  "sentiment": "bullish",
  "confidence_score": 0.71
}
```

## Features

- **Real-time quotes** — Live prices for any stock, ETF, index, or futures symbol (via Yahoo Finance)
- **Yield curve analysis** — 3M / 5Y / 10Y / 30Y Treasury yields + 10Y–3M and 30Y–10Y spreads
- **Persistent research notes** — Save analyses and trade ideas that survive across all sessions
- **Full-text note search** — Search saved research by keyword or tag
- **Educational Q&A** — Explain options Greeks, volatility surfaces, macro concepts, trading strategies
- **Streaming chat** — Real-time token-by-token responses via WebSocket

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works for development)
- Wrangler authenticated: `npx wrangler login`

## Local Development

```bash
npm install
npm run dev        # http://localhost:5173
```

The `@cloudflare/vite-plugin` runs the Worker locally via Miniflare. Workers AI calls go to Cloudflare's remote infrastructure (internet required). KV and Workflows are simulated locally.

## Deployment

```bash
# 1. Create the KV namespace (one-time)
npx wrangler kv namespace create REPORTS
# Copy the returned id and preview_id into wrangler.jsonc

# 2. Build and deploy
npm run deploy
```

## Example Conversations

```
You: Give me live quotes on AAPL, QQQ, COIN, PLTR

Agent: Here is the live market data:

AAPL  (Apple Inc.)  [CLOSED]
  Price: USD 263.75  ▼ 0.37%  (-0.97)
  52w: $169.21 – $288.62

QQQ  (Invesco QQQ Trust)  [CLOSED]
  Price: USD 601.58  ▼ 1.07%  (-6.51)
  52w: $402.39 – $637.01
```

```
You: What's the yield curve saying about recession risk?

Agent: ── US Treasury Yield Curve ──
         3-Month T-Bill:   5.312%
         5-Year Treasury:  4.187%
        10-Year Treasury:  4.421%
        30-Year Treasury:  4.598%

       ── Key Spreads ──
         10Y–3M: -89bps  (inverted — recessionary signal)
         30Y–10Y: 18bps  (normal)

       The 10Y–3M inversion of -89bps is a historically reliable
       leading indicator — the Fed's research shows this spread
       has preceded every recession since 1968...
```

```
You: Save a note — "QQQ breakdown watch" — QQQ rejected $630 resistance
     three times in Feb. Watch for break below $590 on volume.

Agent: ✓ Saved: "QQQ breakdown watch"

You: List my notes

Agent: ── Notes (1) ──
       [#1] QQQ breakdown watch
       QQQ rejected $630 resistance three times in Feb...
```

## Project Structure

```
cf_ai_memory_assistant/
├── src/
│   ├── server.ts    # Worker entry + TradingAgent (AIChatAgent / Durable Object)
│   ├── workflow.ts  # DeepResearchWorkflow (WorkflowEntrypoint) — 4 durable steps
│   └── client.tsx   # React chat frontend
├── index.html       # Vite entry point
├── wrangler.jsonc   # Config: DO, Workflows, KV, Workers AI, Assets
├── vite.config.ts
├── package.json
├── tsconfig.json
├── README.md
└── PROMPTS.md
```

## Key Dependencies

| Package | Role |
|---|---|
| `agents` | Cloudflare Agents SDK — `routeAgentRequest`, `useAgent` hook |
| `@cloudflare/ai-chat` | `AIChatAgent` class, `useAgentChat` React hook |
| `ai` (Vercel AI SDK v6) | `createUIMessageStream`, `createUIMessageStreamResponse` |
| `cloudflare:workers` | `WorkflowEntrypoint`, `WorkflowStep`, `WorkflowEvent` |
| `@cloudflare/vite-plugin` | Bundles Worker + frontend together |

## Notes

**Yahoo Finance API:** The v7/quote batch endpoint now requires a session crumb (introduced ~2024). The agent uses the `v8/finance/chart/{symbol}` endpoint instead, which requires no authentication and supports the same price/52w data fields.

**Memory persistence:** Research notes are stored in Durable Object SQLite, scoped per-session agent instance. Notes survive indefinitely across browser refreshes and reconnections as long as the same agent ID is used.
