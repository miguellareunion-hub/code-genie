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
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/projects";
import { loadAISettings } from "@/lib/aiSettings";
import { loadAgentsSettings } from "@/lib/agentSettings";
import { parseAgentOutput, type AgentAction } from "@/lib/agentActions";
import {
  clearRuntimeErrors,
  drainRuntimeErrors,
  type RuntimeError,
} from "@/lib/runtimeErrors";

type AgentRole = "builder" | "fixer" | "planner";

type PlanStep = { title: string; instruction: string };

/** Heuristic: should we run the planner before the builder? */
function shouldPlan(prompt: string, minChars: number): boolean {
  const t = prompt.trim();
  if (t.length > minChars) return true;
  // Multi-line bulleted/numbered prompts
  const lines = t.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length >= 4) return true;
  const bulletLines = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length;
  if (bulletLines >= 3) return true;
  return false;
}

/** Try to extract { steps: [...] } from a (possibly noisy) planner reply. */
function extractPlan(raw: string): PlanStep[] | null {
  // Strip markdown code fences if any
  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  // Find first { ... last }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const obj = JSON.parse(cleaned.slice(first, last + 1));
    if (!obj || !Array.isArray(obj.steps)) return null;
    const steps: PlanStep[] = obj.steps
      .map((s: unknown) => {
        if (typeof s === "string") return { title: s, instruction: s };
        if (s && typeof s === "object") {
          const o = s as Record<string, unknown>;
          const title = String(o.title ?? o.name ?? o.instruction ?? "");
          const instruction = String(o.instruction ?? o.description ?? o.title ?? "");
          if (!instruction) return null;
          return { title: title || instruction.slice(0, 40), instruction };
        }
        return null;
      })
      .filter((x: PlanStep | null): x is PlanStep => x !== null)
      .slice(0, 6);
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

type Msg = {
  role: "user" | "assistant";
  content: string;
  agentRole?: AgentRole;
};

interface Props {
  files: FileNode[];
  activeFile: FileNode | null;
  onOpenSettings?: () => void;
  onWriteFile: (path: string, content: string) => void;
  onRenameFile: (from: string, to: string) => void;
  onDeleteFile: (path: string) => void;
  /** Called after an agent applies file changes so the UI can show the preview. */
  onSwitchToPreview?: () => void;
  /** Callback used to read the *latest* file list synchronously between fix iterations. */
  getLatestFiles: () => FileNode[];
}

const SUGGESTIONS = [
  "Build a tic-tac-toe game",
  "Create a todo list app",
  "Make a landing page for a coffee shop",
  "Add a dark mode toggle",
];

/** Delay after applying files so the iframe runs and reports any errors. */
const RUNTIME_OBSERVE_MS = 1500;

export function AgentChat({
  files,
  activeFile,
  onOpenSettings,
  onWriteFile,
  onRenameFile,
  onDeleteFile,
  onSwitchToPreview,
  getLatestFiles,
}: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusLine, setStatusLine] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const buildContext = (currentFiles: FileNode[], openName?: string) =>
    `Project files (current):\n${
      currentFiles.length === 0
        ? "(empty project — no files yet)"
        : currentFiles.map((f) => `--- ${f.name} ---\n${f.content}`).join("\n\n")
    }\n\nCurrently open file: ${openName ?? "(none)"}`;

  /**
   * Streams a single agent turn. Returns the raw assistant text and the
   * applied actions list.
   */
  const runAgentTurn = async (
    role: AgentRole,
    apiMessages: Msg[],
    signal: AbortSignal,
    /** Optional explicit prompt override (used by custom agents). */
    explicitOverride?: string,
    /** Optional label shown in chat (e.g. custom agent name). */
    displayLabel?: string,
  ): Promise<{ text: string; actions: AgentAction[] } | null> => {
    let assistantSoFar = "";
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: displayLabel ? `*${displayLabel}*\n\n` : "",
        agentRole: role,
      },
    ]);
    if (displayLabel) assistantSoFar = `*${displayLabel}*\n\n`;

    const upsert = (chunk: string) => {
      assistantSoFar += chunk;
      setMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1 && m.role === "assistant"
            ? { ...m, content: assistantSoFar }
            : m,
        ),
      );
    };

    const settings = loadAISettings();
    const agentsSettings = loadAgentsSettings();
    const override =
      explicitOverride !== undefined
        ? explicitOverride.trim()
        : agentsSettings[role].systemPrompt.trim();
    const isLmStudio = settings.provider === "lmstudio";

    const builtInLmStudioPrompt =
      role === "fixer"
        ? "You are the FIXER agent inside Lovable IDE. Re-emit broken files in full using <lov-write path=\"...\">...</lov-write> tags. Use <lov-delete path=\"...\" /> to remove files. Keep filenames at root. Output COMPLETE files."
        : role === "planner"
          ? "You are the PLANNER agent inside Lovable IDE. Split a complex user request into 2-6 small ordered build steps. Output ONLY JSON: { \"steps\": [ { \"title\": \"...\", \"instruction\": \"...\" } ] }. Step 1 is the base structure (HTML+CSS+JS skeleton). Each next step adds ONE feature on top. No prose, no markdown fences, no extra keys."
          : "You are the BUILDER agent inside Lovable IDE. Generate browser-only projects (HTML/CSS/JS). Use <lov-write path=\"...\">FULL CONTENT</lov-write> to create or overwrite files, <lov-delete path=\"...\" /> to delete. Keep filenames at root. Always output COMPLETE files. When the <context> already lists files, ADD or PATCH only what the current step needs — do not recreate everything from scratch.";

    const lmStudioSystemPrompt = override.length > 0 ? override : builtInLmStudioPrompt;

    const lmStudioHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (isLmStudio && settings.lmstudioApiKey.trim()) {
      lmStudioHeaders["Authorization"] = `Bearer ${settings.lmstudioApiKey.trim()}`;
    }

    const resp = isLmStudio
      ? await fetch(`${settings.lmstudioBaseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: lmStudioHeaders,
          body: JSON.stringify({
            model: settings.lmstudioModel,
            stream: true,
            messages: [
              { role: "system", content: lmStudioSystemPrompt },
              ...apiMessages.map((m) => ({ role: m.role, content: m.content })),
            ],
          }),
          signal,
        })
      : await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role,
            messages: apiMessages.map((m) => ({ role: m.role, content: m.content })),
            provider: settings.provider,
            model:
              settings.provider === "openai" ? settings.openaiModel : settings.lovableModel,
            openaiApiKey: settings.provider === "openai" ? settings.openaiApiKey : undefined,
            systemPromptOverride: override.length > 0 ? override : undefined,
          }),
          signal,
        });

    if (!resp.ok || !resp.body) {
      let msg = "Failed to reach the AI agent.";
      try {
        const j = await resp.json();
        if (j?.error) msg = j.error;
      } catch {}
      upsert(`⚠️ ${msg}`);
      return null;
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

    const { actions } = parseAgentOutput(assistantSoFar);
    return { text: assistantSoFar, actions };
  };

  const applyActions = (actions: AgentAction[]) => {
    const failures: string[] = [];
    for (const a of actions) {
      try {
        if (a.type === "write") onWriteFile(a.path, a.content);
        else if (a.type === "rename") onRenameFile(a.from, a.to);
        else if (a.type === "delete") onDeleteFile(a.path);
      } catch (e) {
        console.error("Failed to apply agent action", a, e);
        const message = e instanceof Error ? e.message : "Unknown write error";
        failures.push(
          a.type === "write"
            ? `Impossible d'écrire ${a.path}: ${message}`
            : a.type === "rename"
              ? `Impossible de renommer ${a.from}: ${message}`
              : `Impossible de supprimer ${a.path}: ${message}`,
        );
      }
    }
    return failures;
  };

  /** Wait for the iframe to render and collect any runtime errors that occur. */
  const observeRuntime = async (sinceTs: number): Promise<RuntimeError[]> => {
    await new Promise((r) => setTimeout(r, RUNTIME_OBSERVE_MS));
    return drainRuntimeErrors(sinceTs);
  };

  /** Run a single builder + fixer cycle for one instruction (an entire prompt OR one plan step). */
  const runBuildCycle = async (
    instruction: string,
    priorMessages: Msg[],
    controller: AbortController,
    stepLabel?: string,
  ): Promise<boolean> => {
    const agentsSettings = loadAgentsSettings();
    if (!agentsSettings.builder.enabled) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "⚠️ Le Builder est désactivé. Active-le dans **Agents** pour générer du code.",
        },
      ]);
      return false;
    }

    clearRuntimeErrors();
    const prefix = stepLabel ? `${stepLabel}\n\n` : "";
    const builderUserMsg: Msg = {
      role: "user",
      content: `${prefix}${instruction}\n\n<context>\n${buildContext(getLatestFiles(), activeFile?.name)}\n</context>`,
    };
    const builderHistory: Msg[] = [...priorMessages, builderUserMsg];
    const builderResult = await runAgentTurn("builder", builderHistory, controller.signal);
    if (!builderResult) return false;
    const builderFailures = applyActions(builderResult.actions);
    if (builderFailures.length > 0) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ ${builderFailures.join("\n")}` },
      ]);
      return false;
    }
    if (builderResult.actions.length > 0) onSwitchToPreview?.();

    // ---- Custom builder agents: run as additional refinement passes ----
    let lastBuilderText = builderResult.text;
    const customBuilders = agentsSettings.customAgents.filter(
      (a) => a.enabled && a.role === "builder",
    );
    for (const ca of customBuilders) {
      if (controller.signal.aborted) break;
      setStatusLine(`Agent custom « ${ca.name} » en cours…`);
      const caUserMsg: Msg = {
        role: "user",
        content:
          `${prefix}${instruction}\n\n` +
          `<context>\n${buildContext(getLatestFiles(), activeFile?.name)}\n</context>\n\n` +
          `The Builder above produced the previous assistant message. Improve, refine or extend the project according to your role. Use <lov-write>/<lov-delete> to apply changes. If nothing needs to change, just briefly say so.`,
      };
      const caHistory: Msg[] = [
        ...priorMessages,
        builderUserMsg,
        { role: "assistant", content: lastBuilderText },
        caUserMsg,
      ];
      const caResult = await runAgentTurn(
        "builder",
        caHistory,
        controller.signal,
        ca.systemPrompt,
        `${ca.emoji} ${ca.name}`,
      );
      if (!caResult) break;
      const caFailures = applyActions(caResult.actions);
      if (caFailures.length > 0) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ ${caFailures.join("\n")}` },
        ]);
        break;
      }
      if (caResult.actions.length > 0) onSwitchToPreview?.();
      lastBuilderText = caResult.text;
    }

    // Fixer loop (skipped entirely if disabled or maxFixIterations === 0)
    if (!agentsSettings.fixer.enabled || agentsSettings.maxFixIterations <= 0) {
      return true;
    }

    let lastAssistantText = builderResult.text;
    for (let iter = 1; iter <= agentsSettings.maxFixIterations; iter++) {
      if (controller.signal.aborted) break;
      setStatusLine(`Running project & checking for errors (pass ${iter})…`);
      const checkpoint = Date.now() - 50;
      const errors = await observeRuntime(checkpoint);
      if (errors.length === 0) {
        setStatusLine("");
        break;
      }
      setStatusLine(
        `Fixer agent detected ${errors.length} runtime error${errors.length > 1 ? "s" : ""}. Repairing…`,
      );
      const errorBlock = errors.map((e) => `- ${e.msg}`).join("\n");
      const fixerUserMsg: Msg = {
        role: "user",
        content:
          `The previous code produced runtime errors when executed in the iframe preview.\n\n` +
          `Errors:\n${errorBlock}\n\n` +
          `<context>\n${buildContext(getLatestFiles())}\n</context>\n\n` +
          `Fix the bug(s). Re-emit ONLY the file(s) that need changes using <lov-write>.`,
      };
      const fixerHistory: Msg[] = [
        { role: "assistant", content: lastAssistantText },
        fixerUserMsg,
      ];
      const fixerResult = await runAgentTurn("fixer", fixerHistory, controller.signal);
      if (!fixerResult) break;
      const fixerFailures = applyActions(fixerResult.actions);
      if (fixerFailures.length > 0) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ ${fixerFailures.join("\n")}` },
        ]);
        break;
      }
      lastAssistantText = fixerResult.text;

      // ---- Custom fixer agents: extra repair passes ----
      const customFixers = agentsSettings.customAgents.filter(
        (a) => a.enabled && a.role === "fixer",
      );
      for (const ca of customFixers) {
        if (controller.signal.aborted) break;
        setStatusLine(`Agent custom « ${ca.name} » vérifie la correction…`);
        const caHistory: Msg[] = [
          { role: "assistant", content: lastAssistantText },
          {
            role: "user",
            content:
              `Errors that were observed:\n${errorBlock}\n\n` +
              `<context>\n${buildContext(getLatestFiles())}\n</context>\n\n` +
              `Review the fix above. If anything is still wrong or could be improved, re-emit corrected file(s) with <lov-write>. If the fix is good, just say so briefly.`,
          },
        ];
        const caResult = await runAgentTurn(
          "fixer",
          caHistory,
          controller.signal,
          ca.systemPrompt,
          `${ca.emoji} ${ca.name}`,
        );
        if (!caResult) break;
        const caFailures = applyActions(caResult.actions);
        if (caFailures.length > 0) break;
        if (caResult.actions.length > 0) onSwitchToPreview?.();
        lastAssistantText = caResult.text;
      }

      clearRuntimeErrors();
    }
    return true;
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const visibleUserMsg: Msg = { role: "user", content: trimmed };
    const baseHistory: Msg[] = [...messages, visibleUserMsg];
    setMessages(baseHistory);
    setInput("");
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const agentsSettings = loadAgentsSettings();
      // ---------- Optional planning phase for big prompts ----------
      let plan: PlanStep[] | null = null;
      if (
        agentsSettings.planner.enabled &&
        shouldPlan(trimmed, agentsSettings.plannerMinChars)
      ) {
        setStatusLine("Planner agent is breaking your request into steps…");
        const plannerHistory: Msg[] = [
          {
            role: "user",
            content: `User request:\n"""${trimmed}"""\n\nProject currently has these files:\n${
              files.length === 0 ? "(empty)" : files.map((f) => f.name).join(", ")
            }\n\nReturn the plan now as JSON only.`,
          },
        ];
        const plannerResult = await runAgentTurn("planner", plannerHistory, controller.signal);
        if (plannerResult) {
          plan = extractPlan(plannerResult.text);
        }
      }

      if (plan && plan.length > 1) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              `📋 **Plan en ${plan!.length} étapes :**\n\n` +
              plan!.map((s, i) => `${i + 1}. **${s.title}** — ${s.instruction}`).join("\n"),
          },
        ]);

        for (let i = 0; i < plan.length; i++) {
          if (controller.signal.aborted) break;
          const step = plan[i];
          setStatusLine(`Étape ${i + 1}/${plan.length} : ${step.title}…`);
          const ok = await runBuildCycle(
            step.instruction,
            messages,
            controller,
            `(Original user goal: ${trimmed})\n\nStep ${i + 1}/${plan.length} — ${step.title}`,
          );
          if (!ok) break;
        }
      } else {
        // Simple single-shot prompt
        setStatusLine("Builder agent is thinking…");
        await runBuildCycle(trimmed, messages, controller);
      }

      setStatusLine("");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ ${(err as Error).message}` },
        ]);
      }
    } finally {
      setLoading(false);
      setStatusLine("");
      abortRef.current = null;
    }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> AI Agent
          <span className="ml-1 hidden items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary sm:inline-flex">
            <Wand2 className="h-2.5 w-2.5" /> multi-agent
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
                <Bot className="h-4 w-4 text-primary" /> Hi! I'm your multi-agent coding system.
              </p>
              I'll <strong>build</strong> the project, <strong>run it</strong> in the preview,
              and a <strong>fixer agent</strong> will automatically repair any runtime errors.
              Customize each agent in the <strong>Agents</strong> menu (top bar).
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
        {loading && statusLine && (
          <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs text-primary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {statusLine}
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

  const { text, actions } = parseAgentOutput(message.content || "");
  const isFixer = message.agentRole === "fixer";
  return (
    <div className="flex justify-start gap-2 text-sm">
      <div
        className={cn(
          "mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          isFixer ? "bg-amber-500/15 text-amber-500" : "bg-primary/15 text-primary",
        )}
      >
        {isFixer ? <ShieldCheck className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div className="max-w-[85%] space-y-2 rounded-lg bg-card px-3 py-2 text-foreground">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {isFixer ? "Fixer agent" : "Builder agent"}
        </div>
        <div className="prose prose-invert prose-sm max-w-none prose-pre:my-2 prose-pre:bg-[var(--terminal-bg)] prose-code:text-primary">
          <ReactMarkdown>{text || "…"}</ReactMarkdown>
        </div>
        {actions.length > 0 && (
          <div
            className={cn(
              "rounded-md border p-2 text-[11px]",
              isFixer
                ? "border-amber-500/30 bg-amber-500/5"
                : "border-primary/30 bg-primary/5",
            )}
          >
            <div
              className={cn(
                "mb-1 flex items-center gap-1 font-medium",
                isFixer ? "text-amber-500" : "text-primary",
              )}
            >
              {isFixer ? <ShieldCheck className="h-3 w-3" /> : <Wand2 className="h-3 w-3" />}
              Applied {actions.length} change{actions.length > 1 ? "s" : ""}
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
