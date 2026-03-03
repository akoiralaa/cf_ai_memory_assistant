# PROMPTS.md — AI Prompts Used During Development

This file documents the prompts used with Claude (claude-sonnet-4-6) to build this project, per the assignment requirements.

---

## 1. Architecture Planning

**Prompt:**
> I need help building an AI-powered application on Cloudflare for a job assignment. The requirements are:
> - LLM (recommend Llama 3.3 on Workers AI)
> - Workflow / coordination (Workflows, Workers or Durable Objects)
> - User input via chat or voice
> - Memory or state
>
> I want to build a Trading Research Agent — a chat agent where you can ask trading/market questions, it fetches real market data, and remembers your research notes across all sessions. Help me design the architecture and write all the code using the Cloudflare Agents SDK.

---

## 2. Backend Agent Implementation

**Prompt (used to guide server.ts):**
> Using the Cloudflare Agents SDK (@cloudflare/ai-chat, agents, workers-ai-provider, ai v6), write a TradingAgent class that extends AIChatAgent<Env>. It should:
> - Use Llama 3.3 70B FP8 Fast on Workers AI
> - Have an onStart() method that creates a research_notes SQLite table using the this.sql template tag
> - Implement onChatMessage() that calls streamText with convertToModelMessages(this.messages)
> - Include these tools using the `tool()` helper with inputSchema (ai v6):
>   1. getQuote(symbols[]) — fetch from Yahoo Finance v7 quote API, format cleanly
>   2. getYieldCurve() — fetch ^IRX, ^FVX, ^TNX, ^TYX from Yahoo Finance, show spreads
>   3. saveNote(title, content, tags?) — INSERT into research_notes via this.sql
>   4. listNotes(tag?) — SELECT from research_notes, optional tag filter
>   5. searchNotes(query) — LIKE search across title, content, tags
>   6. deleteNote(id) — DELETE by id
> - maxSteps: 5 for multi-step tool chaining
> - Return result.toUIMessageStreamResponse()

---

## 3. System Prompt for the Agent

**Prompt (refined into the system message in server.ts):**
> Write a system prompt for a financial markets AI assistant with deep expertise in: equities (technical + fundamental), fixed income (yield curves, duration, credit spreads), derivatives (options Greeks, vol surfaces, vol skew, common strategies), macro economics (central bank policy, inflation, FX carry, global flows), and quantitative strategies (factor investing, mean reversion, momentum, risk management). The agent should be instructed to use tools proactively, save analyses when useful, and reference saved research when relevant. It should be precise, use proper financial terminology, and be direct.

---

## 4. React Frontend

**Prompt (used to build client.tsx):**
> Write a React frontend for this trading research agent using:
> - useAgent({ agent: "TradingAgent" }) from "agents/react"
> - useAgentChat({ agent }) from "@cloudflare/ai-chat/react"
> Design a dark, terminal-inspired trading UI with:
> - A header with logo, status indicator, and clear button
> - Message bubbles (user = blue, agent = dark gray) with avatars
> - Tool call blocks that show pending state, then expand on click to show output
> - A typing indicator (animated green dots) during streaming
> - An empty state with 5 example conversation starters as clickable buttons
> - A textarea input (Enter to send, Shift+Enter for newline) with a Send button
> - CSS animations for the typing dots, custom dark scrollbars
> - All styling via inline styles (no Tailwind required)

---

## 5. Configuration Files

**Prompt:**
> Write the following config files for a Cloudflare Agents project:
> - wrangler.jsonc: name "cf-ai-memory-assistant", main "src/server.ts", compatibility_date "2025-11-01", nodejs_compat flag, AI binding with remote: true, Durable Objects binding for TradingAgent class, SQLite migration with new_sqlite_classes, assets config with run_worker_first for /agents/*
> - package.json: with dependencies agents, @cloudflare/ai-chat, ai, react, react-dom, workers-ai-provider, zod; devDependencies @cloudflare/vite-plugin, @cloudflare/workers-types, vite, wrangler, typescript, @vitejs/plugin-react, @types/react, @types/react-dom; scripts for dev (vite dev), build (vite build), deploy (vite build && wrangler deploy)
> - vite.config.ts: uses @cloudflare/vite-plugin and @vitejs/plugin-react
> - tsconfig.json: bundler module resolution, jsx react-jsx, strict mode, @cloudflare/workers-types

---

## 6. README Documentation

**Prompt:**
> Write a README.md for this project that includes:
> - Project description and what makes it useful
> - Architecture table showing LLM, coordination, memory, and chat components
> - ASCII diagram of the request flow from browser through Worker to Durable Object to tools
> - Features list
> - Prerequisites (Node.js, Cloudflare account, wrangler login)
> - Local development and deployment instructions
> - 3 example conversations showing market data fetching, yield curve analysis, and memory recall
> - Project structure tree
> - Key dependencies table with roles
> - Notes about Yahoo Finance API and memory persistence

---

## 7. Debugging Tool-Calling Failures (Iterative)

**Problem:** After switching from Llama 3.3 70B to Hermes-2-Pro Mistral 7B, the `getQuote` tool call was visually firing in the UI but the execute function was never running. The model's response was showing HTML span placeholders like `<span title="Live price here">insert live AAPL price here</span>`.

**Root cause investigation prompts:**

> The tool call is showing in the UI but the execute function never runs. I'm using streamText with workers-ai-provider. The model is @hf/nousresearch/hermes-2-pro-mistral-7b. Help me understand why.

> workers-ai-provider's doStream implementation parses SSE chunks looking for chunk.tool_calls arrays, but Hermes-2-Pro streams raw <tool_call> XML text instead. Can we bypass workers-ai-provider and call env.AI.run() directly?

> Even calling env.AI.run() directly with the tools parameter, tool_calls in the response is always empty. The model outputs HTML span placeholders. How can we parse the <tool_call> XML from the text response directly?

**Resolution:** Bypassed `workers-ai-provider` and `streamText` entirely. Implemented a manual tool dispatch loop: call `env.AI.run()` without the `tools` parameter, parse `<tool_call>{"name":"...","arguments":{...}}</tool_call>` XML from the text response, execute the matched tool, and loop up to 5 times.

---

## 8. Scope Reduction — Disclaimer and UI Cleanup

**Prompt:**
> The deep research workflow (runDeepResearch, getReport, listReports) is unreliable — the execute functions don't fire and the model returns fake placeholder report IDs. Can we add a disclaimer saying the app cannot run backtests or retrieve deep research reports, and is instead an LLM for understanding financial concepts with live quotes? Remove those tools from the chat interface.

**Result:**
- Added `DisclaimerBanner` component to `client.tsx` showing scope limitations
- Removed `runDeepResearch`, `getReport`, `listReports` from the agent's tool set
- Updated system prompt with explicit LIMITATIONS section
- Updated conversation starters to remove deep research examples

---

## 9. Pre-Fetch Architecture for Market Data

**Problem:** After all tool-calling approaches failed (workers-ai-provider streaming, generateText non-streaming, direct binding with tools parameter, text-based XML parsing), live quotes were still not working reliably. Passing the `tools` parameter to `env.AI.run()` caused Workers AI to return a `ReadableStream` instead of a plain `{ response: string }` object, resulting in blank responses.

**Prompt:**
> Tool calling is fundamentally unreliable with this model/binding combination. Instead of asking the model to call getQuote, can we pre-fetch the market data server-side before calling the model at all? Extract ticker symbols from the user message using regex, call Yahoo Finance in parallel, inject the results into the system prompt, and let the model just format the response.

**Result:** Replaced the entire tool-calling loop with a pre-fetch pipeline:
1. Regex extracts uppercase ticker symbols from user message (filtered against a stopword list)
2. `Promise.all` fetches all tickers in parallel
3. Formatted data injected as a `--- Live Market Data ---` block in the system prompt
4. Model receives pre-fetched data as ground truth and presents it to the user
5. Note operations (save/list/search/delete) still use `<tool_call>` XML parsing since those require model intent detection

---

## 10. Yahoo Finance API Authentication Fix

**Problem:** Yahoo Finance's `v7/finance/quote` batch endpoint now requires a session crumb (introduced ~2024). The worker was getting 401/403 errors, and the model was reporting "authentication issues" to the user.

**Prompt:**
> The Yahoo Finance v7/quote API is returning auth errors. What's a reliable alternative endpoint that doesn't require a crumb/cookie?

**Result:** Switched to `https://query2.finance.yahoo.com/v8/finance/chart/{symbol}` — the chart API used by Yahoo Finance's own charting widgets. This endpoint:
- Requires no authentication
- Returns `meta.regularMarketPrice`, `meta.chartPreviousClose`, `meta.fiftyTwoWeekHigh/Low`, `meta.marketState`
- Accepts one symbol per request — parallelized with `Promise.all`
- Works from Cloudflare Workers (Cloudflare's egress IP range is not blocked)
