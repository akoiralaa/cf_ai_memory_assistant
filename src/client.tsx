import React, { useState, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TextPart {
  type: "text";
  text: string;
}

interface ToolPart {
  type: "tool";
  toolName: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

type MessagePart = TextPart | ToolPart;

interface Message {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
}

// ─── Tool call labels ─────────────────────────────────────────────────────────

const TOOL_PENDING: Record<string, string> = {
  getQuote: "📡 Fetching market data…",
  getYieldCurve: "📈 Fetching yield curve…",
  saveNote: "💾 Saving research note…",
  listNotes: "📋 Loading research notes…",
  searchNotes: "🔍 Searching research…",
  deleteNote: "🗑 Deleting note…",
};

const TOOL_DONE: Record<string, string> = {
  getQuote: "📡 Market data",
  getYieldCurve: "📈 Yield curve",
  saveNote: "💾 Note saved",
  listNotes: "📋 Research notes",
  searchNotes: "🔍 Search results",
  deleteNote: "🗑 Note deleted",
};

function DisclaimerBanner() {
  return (
    <div
      style={{
        padding: "7px 20px",
        background: "#0c1a0e",
        borderBottom: "1px solid #14401e",
        fontSize: "11px",
        color: "#4b7a57",
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        textAlign: "center",
        letterSpacing: "0.01em",
      }}
    >
      ⚠ Educational use only · No backtesting · No deep research reports · No historical data · No trade execution · Live quotes via Yahoo Finance
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function ToolCallBlock({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const isDone = part.state === "output";
  const label = isDone
    ? TOOL_DONE[part.toolName] ?? part.toolName
    : TOOL_PENDING[part.toolName] ?? `${part.toolName}…`;
  const output =
    typeof part.output === "string"
      ? part.output
      : JSON.stringify(part.output, null, 2);

  return (
    <div
      style={{
        margin: "6px 0",
        border: `1px solid ${isDone ? "#1a3a2a" : "#2a2a1a"}`,
        borderRadius: "6px",
        overflow: "hidden",
        background: isDone ? "#0a1f14" : "#151508",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          padding: "7px 10px",
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: isDone ? "#4ade80" : "#a3a346",
          fontSize: "12px",
          fontFamily: "'SF Mono', 'Fira Code', monospace",
        }}
      >
        <span style={{ opacity: 0.7 }}>{isDone ? "▸" : "⟳"}</span>
        {label}
        {isDone && output && (
          <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: "11px" }}>
            {open ? "▲ hide" : "▼ show"}
          </span>
        )}
      </button>

      {isDone && open && output && (
        <pre
          style={{
            margin: 0,
            padding: "8px 12px",
            fontSize: "12px",
            color: "#a3e4a3",
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            borderTop: "1px solid #1a3a2a",
            background: "#050f09",
          }}
        >
          {output}
        </pre>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: isUser ? "row-reverse" : "row",
        gap: "10px",
        marginBottom: "20px",
        alignItems: "flex-start",
      }}
    >
      {/* Avatar */}
      <div
        style={{
          flexShrink: 0,
          width: "30px",
          height: "30px",
          borderRadius: "50%",
          background: isUser
            ? "linear-gradient(135deg, #1d4ed8, #4f46e5)"
            : "linear-gradient(135deg, #065f46, #047857)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "14px",
        }}
      >
        {isUser ? "👤" : "📊"}
      </div>

      {/* Bubble */}
      <div
        style={{
          maxWidth: "78%",
          padding: "10px 14px",
          borderRadius: isUser ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
          background: isUser ? "#1e3a5f" : "#111827",
          border: `1px solid ${isUser ? "#2d5a8e" : "#1f2937"}`,
          color: "#e5e7eb",
          fontSize: "14px",
          lineHeight: "1.6",
        }}
      >
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <div
                key={i}
                style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
              >
                {part.text}
              </div>
            );
          }
          if (part.type === "tool") {
            return <ToolCallBlock key={i} part={part as ToolPart} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div
      style={{
        display: "flex",
        gap: "10px",
        marginBottom: "20px",
        alignItems: "flex-start",
      }}
    >
      <div
        style={{
          width: "30px",
          height: "30px",
          borderRadius: "50%",
          background: "linear-gradient(135deg, #065f46, #047857)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "14px",
        }}
      >
        📊
      </div>
      <div
        style={{
          padding: "10px 14px",
          borderRadius: "4px 16px 16px 16px",
          background: "#111827",
          border: "1px solid #1f2937",
          display: "flex",
          gap: "4px",
          alignItems: "center",
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "#4ade80",
              animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  const starters = [
    "Explain the current yield curve and what it implies for recession risk",
    "What are the key Greeks I should watch when selling covered calls?",
    "Walk me through how vol skew affects put vs call pricing",
    "Get me a live quote on SPY, QQQ, and ^VIX",
    "What's the difference between delta hedging and gamma scalping?",
  ];

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "52px", marginBottom: "16px" }}>📊</div>
      <div
        style={{
          fontSize: "22px",
          fontWeight: 700,
          color: "#f9fafb",
          marginBottom: "8px",
        }}
      >
        Trading Research Agent
      </div>
      <div
        style={{
          fontSize: "14px",
          color: "#6b7280",
          marginBottom: "32px",
          maxWidth: "440px",
          lineHeight: "1.6",
        }}
      >
        Ask about markets, options, macro, or financial concepts. I can fetch
        live quotes and save research notes across sessions. I cannot run
        backtests, generate reports, or access historical data.
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: "520px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        {starters.map((s, i) => (
          <button
            key={i}
            onClick={() => {
              const textarea = document.querySelector(
                "textarea"
              ) as HTMLTextAreaElement;
              if (textarea) {
                textarea.value = s;
                textarea.dispatchEvent(
                  new Event("input", { bubbles: true })
                );
                // Also set React state via synthetic event
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype,
                  "value"
                )?.set;
                nativeInputValueSetter?.call(textarea, s);
                textarea.dispatchEvent(
                  new Event("input", { bubbles: true })
                );
                textarea.focus();
              }
            }}
            style={{
              padding: "10px 14px",
              background: "#111827",
              border: "1px solid #1f2937",
              borderRadius: "8px",
              color: "#9ca3af",
              fontSize: "13px",
              textAlign: "left",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLButtonElement).style.borderColor = "#374151";
              (e.target as HTMLButtonElement).style.color = "#d1d5db";
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLButtonElement).style.borderColor = "#1f2937";
              (e.target as HTMLButtonElement).style.color = "#9ca3af";
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function App() {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({ agent: "TradingAgent" });
  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent,
  });

  const isStreaming = status === "streaming";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    sendMessage({ text });
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#030712",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#e5e7eb",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 20px",
          borderBottom: "1px solid #111827",
          background: "#030712",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: "34px",
              height: "34px",
              borderRadius: "8px",
              background: "linear-gradient(135deg, #065f46, #047857)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "16px",
            }}
          >
            📊
          </div>
          <div>
            <div
              style={{ fontWeight: 700, fontSize: "15px", color: "#f9fafb" }}
            >
              Trading Research Agent
            </div>
            <div
              style={{
                fontSize: "11px",
                color: "#4b5563",
                fontFamily: "'SF Mono', monospace",
              }}
            >
              Hermes-2-Pro · Workers AI · Cloudflare Agents
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "#4ade80",
              boxShadow: "0 0 6px #4ade80",
            }}
          />
          <span style={{ fontSize: "12px", color: "#4b5563" }}>
            Memory active
          </span>
          {messages.length > 0 && (
            <button
              onClick={() => clearHistory()}
              style={{
                marginLeft: "8px",
                padding: "5px 10px",
                background: "none",
                border: "1px solid #1f2937",
                borderRadius: "6px",
                color: "#6b7280",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Disclaimer ── */}
      <DisclaimerBanner />

      {/* ── Messages ── */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px 20px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg as Message} />
            ))}
            {isStreaming && <TypingIndicator />}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Input ── */}
      <div
        style={{
          padding: "16px 20px",
          borderTop: "1px solid #111827",
          background: "#030712",
          flexShrink: 0,
        }}
      >
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about markets, options, macro, or save research…  (Enter to send, Shift+Enter for newline)"
            rows={1}
            style={{
              flex: 1,
              padding: "12px 16px",
              background: "#0d1117",
              border: "1px solid #1f2937",
              borderRadius: "10px",
              color: "#e5e7eb",
              fontSize: "14px",
              fontFamily: "inherit",
              resize: "none",
              outline: "none",
              lineHeight: "1.5",
              maxHeight: "180px",
              overflowY: "auto",
            }}
            onFocus={(e) => {
              e.target.style.borderColor = "#374151";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "#1f2937";
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || isStreaming}
            style={{
              padding: "12px 20px",
              background:
                input.trim() && !isStreaming ? "#065f46" : "#0d1117",
              color:
                input.trim() && !isStreaming ? "#4ade80" : "#374151",
              border: `1px solid ${input.trim() && !isStreaming ? "#047857" : "#1f2937"}`,
              borderRadius: "10px",
              cursor: input.trim() && !isStreaming ? "pointer" : "not-allowed",
              fontWeight: 600,
              fontSize: "14px",
              transition: "all 0.15s",
              flexShrink: 0,
            }}
          >
            {isStreaming ? "…" : "Send"}
          </button>
        </form>

        <div
          style={{
            marginTop: "8px",
            fontSize: "11px",
            color: "#1f2937",
            textAlign: "center",
            fontFamily: "'SF Mono', monospace",
          }}
        >
          Research notes persist across sessions · Powered by Cloudflare
          Workers AI
        </div>
      </div>

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #030712; }
        ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 2px; }
      `}</style>
    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
