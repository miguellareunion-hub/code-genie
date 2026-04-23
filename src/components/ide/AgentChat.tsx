import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Bot,
  Send,
  Sparkles,
  User2,
  Loader2,
  Settings as SettingsIcon,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/projects";
import { loadAISettings } from "@/lib/aiSettings";
import { parseAgentOutput, type AgentAction } from "@/lib/agentActions";

type Msg = {
  role: "user" | "assistant";
  content: string; // raw streamed content for assistant; plain text for user
};

interface Props {
  files: FileNode[];
  activeFile: FileNode | null;
  onOpenSettings?: () => void;
  onWriteFile: (path: string, content: string) => void;
  onRenameFile: (from: string, to: string) => void;
  onDeleteFile: (path: string) => void;
}

const SUGGESTIONS = [
  "Build a tic-tac-toe game",
  "Create a todo list app",
  "Make a landing page for a coffee shop",
  "Add a dark mode toggle",
];

export function AgentChat({
  files,
  activeFile,
  onOpenSettings,
  onWriteFile,
  onRenameFile,
  onDeleteFile,
}: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const context = `Project files (current):\n${
      files.length === 0
        ? "(empty project — no files yet)"
        : files.map((f) => `--- ${f.name} ---\n${f.content}`).join("\n\n")
    }\n\nCurrently open file: ${activeFile?.name ?? "(none)"}`;

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

      // Once streaming is complete, parse + apply actions to the project.
      const { actions } = parseAgentOutput(assistantSoFar);
      applyActions(actions);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        upsert(`⚠️ ${(err as Error).message}`);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const applyActions = (actions: AgentAction[]) => {
    for (const a of actions) {
      try {
        if (a.type === "write") onWriteFile(a.path, a.content);
        else if (a.type === "rename") onRenameFile(a.from, a.to);
        else if (a.type === "delete") onDeleteFile(a.path);
      } catch (e) {
        console.error("Failed to apply agent action", a, e);
      }
    }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> AI Agent
          <span className="ml-1 hidden items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary sm:inline-flex">
            <Wand2 className="h-2.5 w-2.5" /> autonomous
          </span>
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
                <Bot className="h-4 w-4 text-primary" /> Hi! I'm your autonomous coding agent.
              </p>
              Tell me what to build and I'll create / edit the files in your project
              automatically. I can also explain or debug existing code.
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
          <ChatMessage key={i} message={m} />
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
            placeholder="Ask the agent to build something…"
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

function ChatMessage({ message }: { message: Msg }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end gap-2 text-sm">
        <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground">
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
        <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <User2 className="h-3.5 w-3.5" />
        </div>
      </div>
    );
  }

  // Assistant — strip action tags out of the displayed text so the user sees a clean
  // explanation + a list of applied changes.
  const { text, actions } = parseAgentOutput(message.content || "");
  return (
    <div className="flex justify-start gap-2 text-sm">
      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <Bot className="h-3.5 w-3.5" />
      </div>
      <div className="max-w-[85%] space-y-2 rounded-lg bg-card px-3 py-2 text-foreground">
        <div className="prose prose-invert prose-sm max-w-none prose-pre:my-2 prose-pre:bg-[var(--terminal-bg)] prose-code:text-primary">
          <ReactMarkdown>{text || "…"}</ReactMarkdown>
        </div>
        {actions.length > 0 && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-[11px]">
            <div className="mb-1 flex items-center gap-1 font-medium text-primary">
              <Wand2 className="h-3 w-3" /> Applied {actions.length} change
              {actions.length > 1 ? "s" : ""}
            </div>
            <ul className="space-y-0.5 text-muted-foreground">
              {actions.map((a, idx) => (
                <li key={idx}>
                  {a.type === "write" && (
                    <>
                      📝 <code>{a.path}</code>
                    </>
                  )}
                  {a.type === "rename" && (
                    <>
                      ✏️ <code>{a.from}</code> → <code>{a.to}</code>
                    </>
                  )}
                  {a.type === "delete" && (
                    <>
                      🗑️ <code>{a.path}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
