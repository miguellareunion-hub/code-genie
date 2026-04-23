import { createFileRoute } from "@tanstack/react-router";

type AgentRole = "builder" | "fixer" | "planner";

type ChatBody = {
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  provider?: "lovable" | "openai";
  model?: string;
  openaiApiKey?: string;
  role?: AgentRole;
  /** Optional custom system prompt that overrides the default for this role. */
  systemPromptOverride?: string;
};

const BASE_RULES = `# Environment constraints
- This IDE preview ONLY runs browser code (HTML / CSS / vanilla JS in a sandboxed iframe).
- Do NOT generate Node.js servers, Express apps, npm install steps, backend runtimes, or SSH scripts unless the user explicitly says they will run code outside this IDE.
- Default to front-end projects that work immediately in index.html + style.css + script.js.
- Keep or create index.html as the project entry point.

# Action tags (the IDE parses these and applies them automatically)
To create or fully overwrite a file:
<lov-write path="index.html">
<!DOCTYPE html>
<html>...COMPLETE file content...</html>
</lov-write>

To rename a file:
<lov-rename from="old.js" to="new.js" />

To delete a file:
<lov-delete path="obsolete.css" />

# CRITICAL RULES
- Always output COMPLETE file contents inside <lov-write>.
- Never output partial diffs, placeholders, or 'rest of file'.
- Do NOT wrap file contents in markdown code fences inside <lov-write>.
- Use simple root-level filenames like index.html, style.css, script.js.
- Before action tags, briefly explain what you are changing.
- After all actions, briefly summarize the result.
- For pure questions without code edits, answer in markdown only.
- Be concise.

# When the project already has files
- The <context> block lists every existing file. You MUST work with that exact list.
- To replace a project entirely (e.g. user asks for a totally different app), DELETE every existing file you no longer need with <lov-delete path="..." /> and then <lov-write> the new files.
- Never leave behind unrelated leftover files from a previous app (for example, a starter script.js full of click counters when the user asked for a trading bot). Delete them.
- You may create as many new files as needed (e.g. app.js, ui.js, market.js). Filenames must stay at the project root (no folders).
- Every file the user references in HTML MUST be created with <lov-write> in the same response. If index.html includes <script src="app.js"></script>, you MUST also emit a <lov-write path="app.js"> block.`;

const BUILDER_PROMPT = `You are the BUILDER agent of an autonomous multi-agent system inside Lovable IDE.
Your job: design and write working client-side projects from the user's request.
${BASE_RULES}`;

const FIXER_PROMPT = `You are the FIXER agent of an autonomous multi-agent system inside Lovable IDE.
The BUILDER agent just wrote code that produced runtime errors in the browser preview.
Your job: read the runtime errors in the user's message, identify the bug(s), and emit corrected files using <lov-write> tags.

Hard requirements:
- Output corrected files only — re-emit each broken file in full with <lov-write>.
- Do NOT apologize, do NOT restate the user's prompt, do NOT add unrelated features.
- If the error is caused by a missing element, missing file, or typo, fix the actual root cause.
- After your fixes, briefly explain what was wrong (1–2 sentences).
${BASE_RULES}`;

const PLANNER_PROMPT = `You are the PLANNER agent of an autonomous multi-agent system inside Lovable IDE.
Your job: take a LONG or COMPLEX user request and split it into 2 to 6 SMALL, ORDERED, INDEPENDENT build steps that the BUILDER agent will execute one after the other.

Rules:
- Output ONLY valid JSON (no prose, no markdown fences). Schema:
  { "steps": [ { "title": "short title", "instruction": "concrete instruction for the builder, in the same language as the user prompt" } ] }
- Each step must be small enough to be implemented in a single response (one or a few files).
- Step 1 is ALWAYS the base structure (HTML skeleton + CSS + main JS file with empty hooks).
- Following steps add features INCREMENTALLY on top of the previous step. They must NOT recreate files from scratch — they patch / extend.
- Keep at most 6 steps. Merge tiny tasks together.
- Keep instructions short (1-3 sentences each). The builder already knows the global goal from step 1.
- Do NOT add deployment, testing, documentation, or "polish" steps.
- If the user request is already small/simple, output a single step.

Environment: browser-only (HTML/CSS/vanilla JS, no Node, no npm). Files at project root.`;

function getSystemPrompt(role: AgentRole): string {
  if (role === "fixer") return FIXER_PROMPT;
  if (role === "planner") return PLANNER_PROMPT;
  return BUILDER_PROMPT;
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        try {
          const body = (await request.json()) as ChatBody;
          const {
            messages,
            provider = "lovable",
            model,
            openaiApiKey,
            role = "builder",
            systemPromptOverride,
          } = body;

          let url: string;
          let apiKey: string | undefined;
          let chosenModel: string;

          if (provider === "openai") {
            url = "https://api.openai.com/v1/chat/completions";
            apiKey = openaiApiKey?.trim();
            chosenModel = model || "gpt-4o-mini";
            if (!apiKey) {
              return jsonError(
                "OpenAI API key is missing. Open Settings and paste your key.",
                400,
              );
            }
          } else {
            url = "https://ai.gateway.lovable.dev/v1/chat/completions";
            apiKey = process.env.LOVABLE_API_KEY;
            chosenModel = model || "google/gemini-3-flash-preview";
            if (!apiKey) {
              return jsonError("LOVABLE_API_KEY is not configured.", 500);
            }
          }

          const systemPrompt =
            systemPromptOverride && systemPromptOverride.trim().length > 0
              ? systemPromptOverride
              : getSystemPrompt(role);

          const upstream = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: chosenModel,
              stream: true,
              messages: [{ role: "system", content: systemPrompt }, ...messages],
            }),
          });

          if (!upstream.ok) {
            if (upstream.status === 429) {
              return jsonError("Rate limit exceeded. Please try again shortly.", 429);
            }
            if (upstream.status === 401) {
              return jsonError(
                provider === "openai"
                  ? "Invalid OpenAI API key. Check it in Settings."
                  : "Unauthorized to AI gateway.",
                401,
              );
            }
            if (upstream.status === 402) {
              return jsonError(
                "AI credits exhausted. Add credits in Settings → Workspace → Usage.",
                402,
              );
            }
            const text = await upstream.text();
            console.error("AI provider error", provider, upstream.status, text);
            return jsonError(`AI provider error (${upstream.status})`, 500);
          }

          return new Response(upstream.body, {
            headers: { "Content-Type": "text/event-stream" },
          });
        } catch (e) {
          console.error("/api/chat error", e);
          return jsonError(e instanceof Error ? e.message : "Unknown error", 500);
      },
    },
  },
});

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
