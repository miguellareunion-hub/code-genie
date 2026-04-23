import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Bot, Send, Sparkles, User2, Loader2, Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/projects";
import { loadAISettings } from "@/lib/aiSettings";

type Msg = { role: "user" | "assistant"; content: string };

interface Props {
  files: FileNode[];
  activeFile: FileNode | null;
  onOpenSettings?: () => void;
}

const SUGGESTIONS = [
  "Explain this file",
  "Add a dark mode toggle",
  "Fix any bugs in my code",
  "Make it look more modern",
];

export function AgentChat({ files, activeFile, onOpenSettings }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const context = `Project files (current):\n${files
      .map((f) => `--- ${f.name} ---\n${f.content}`)
      .join("\n\n")}\n\nCurrently open file: ${activeFile?.name ?? "(none)"}`;

    const userMsg: Msg = {
      role: "user",
      content: `${trimmed}\n\n<context>\n${context}\n</context>`,
    };
    const visibleUserMsg: Msg = { role: "user", content: trimmed };
    const next: Msg[] = [...messages, visibleUserMsg];
    setMessages(next);
    setInput("");
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantSoFar = "";
    const upsert = (chunk: string) => {
      assistantSoFar += chunk;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) =>
            i === prev.length - 1 ? { ...m, content: assistantSoFar } : m,
          );
        }
        return [...prev, { role: "assistant", content: assistantSoFar }];
      });
    };

    try {
      const apiMessages = [...messages, userMsg];
      const settings = loadAISettings();
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          provider: settings.provider,
          model:
            settings.provider === "openai" ? settings.openaiModel : settings.lovableModel,
          openaiApiKey: settings.provider === "openai" ? settings.openaiApiKey : undefined,
        }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        let msg = "Failed to reach the AI agent.";
        try {
          const j = await resp.json();
          if (j?.error) msg = j.error;
        } catch {}
        upsert(`⚠️ ${msg}`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") {
            done = true;
            break;
          }
          try {
            const parsed = JSON.parse(json);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) upsert(content);
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        upsert(`⚠️ ${(err as Error).message}`);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> AI Agent
        </span>
        <div className="flex items-center gap-2">
          {loading && (
            <button
              onClick={() => abortRef.current?.abort()}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Stop
            </button>
          )}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              title="AI settings"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <SettingsIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-auto p-3">
        {messages.length === 0 && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
              <p className="mb-2 flex items-center gap-2 text-foreground">
                <Bot className="h-4 w-4 text-primary" /> Hi! I'm your AI coding agent.
              </p>
              Ask me to explain, edit, or debug your code. I can see all files in this project.
            </div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={cn(
              "flex gap-2 text-sm",
              m.role === "user" ? "justify-end" : "justify-start",
            )}
          >
            {m.role === "assistant" && (
              <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Bot className="h-3.5 w-3.5" />
              </div>
            )}
            <div
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2",
                m.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-foreground",
              )}
            >
              {m.role === "assistant" ? (
                <div className="prose prose-invert prose-sm max-w-none prose-pre:my-2 prose-pre:bg-[var(--terminal-bg)] prose-code:text-primary">
                  <ReactMarkdown>{m.content || "…"}</ReactMarkdown>
                </div>
              ) : (
                <span className="whitespace-pre-wrap">{m.content}</span>
              )}
            </div>
            {m.role === "user" && (
              <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <User2 className="h-3.5 w-3.5" />
              </div>
            )}
          </div>
        ))}
        {loading && messages[messages.length - 1]?.role === "user" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-border bg-[var(--sidebar-bg)] p-2"
      >
        <div className="flex items-end gap-2 rounded-md border border-border bg-input p-2 focus-within:border-primary">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask the AI agent…"
            rows={1}
            className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-primary p-1.5 text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
