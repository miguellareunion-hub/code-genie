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
- The IDE preview runs in a sandboxed iframe (HTML/CSS/JS) OR in the local Node Runner if the user enabled it.
- Default to a browser-only project (index.html + style.css + script.js) UNLESS the user explicitly asks for Node/Express/server code.
- If you DO write a Node project (because the user asked for one), it must be runnable with \`node server.js\` or \`npm run dev\`. Always include a \`package.json\` with the right \`scripts\` and \`dependencies\`.

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

# CRITICAL RULES — output format
- Always output COMPLETE file contents inside <lov-write>. Never partial diffs, placeholders, or 'rest of file'.
- Do NOT wrap file contents in markdown code fences inside <lov-write>.
- Use simple filenames at project root or under a single subfolder (e.g. lib/foo.js). No deep nesting unless needed.
- Before action tags, briefly explain what you are changing. After actions, briefly summarize the result.
- For pure questions without code edits, answer in markdown only. Be concise.

# CRITICAL RULES — code correctness (read carefully, this is what breaks projects)
1. **Imports must match exports.** If \`engine.js\` writes \`import { binance } from './binance.js'\`, then \`binance.js\` MUST contain \`export const binance = ...\` (or \`export function binance\`, or \`export { binance }\`). Default exports (\`export default X\`) need \`import X from './...'\` — NOT \`import { X } from './...'\`. Mixing the two is the #1 cause of "does not provide an export named X" errors.
2. **Every imported file must exist.** If a file imports \`./lib/foo.js\`, you MUST also emit \`<lov-write path="lib/foo.js">\` in the same response. Same for \`<script src="app.js">\` in HTML — \`app.js\` must be written.
3. **One module style per project.** If you put \`"type": "module"\` in package.json, every \`.js\` file must use \`import/export\`, NOT \`require\`/\`module.exports\`. Pick one and stay consistent.
4. **Node entry point clarity.** For Node projects, the file mentioned in \`package.json\` "main" or in \`scripts.start\` MUST exist (e.g. if \`"start": "node server.js"\`, write \`server.js\`).
5. **Env vars and secrets.** For API keys, read from \`process.env.XXX\` and put a placeholder \`.env.example\` file. Never hardcode secrets.

# When the project already has files (MODIFICATION mode)
- The <context> block lists every existing file. You MUST work with that exact list.
- **DEFAULT BEHAVIOR**: when files already exist, the user is asking for an INCREMENTAL CHANGE. Re-emit ONLY the file(s) that need to change. NEVER re-emit unchanged files.
- **Forbidden**: rewriting the entire project just because the user reported a small bug ("je ne peux pas activer le bot", "le bouton ne marche pas", etc.). These are TARGETED FIXES — touch 1-3 files MAX.
- **Forbidden**: deleting files the user did not explicitly ask to delete.
- To replace a project entirely, the user must say so explicitly ("recommence à zéro", "nouveau projet", "from scratch"). Only then may you DELETE every existing file with <lov-delete> and re-emit a fresh set.
- Never leave behind unrelated leftover files from a previous app.
- Every file referenced (HTML <script>, JS imports, CSS @import) MUST exist after your changes — either already in <context> or written in this response.`;

const BUILDER_PROMPT = `You are the BUILDER agent of an autonomous multi-agent system inside Lovable IDE.
Your job: design and write working client-side projects from the user's request.
${BASE_RULES}`;

const FIXER_PROMPT = `You are the FIXER agent of an autonomous multi-agent system inside Lovable IDE.
The BUILDER agent just wrote code that produced errors — either at validation time (static check), in the browser preview, or in the Node runner.

Your job: read the error messages in the user's message, identify the ROOT cause, and emit corrected files using <lov-write> tags.

# Common error patterns and how to fix them
- "does not provide an export named 'X'" → the importing file expects \`export const X\` or \`export function X\` in the target file. Either add the named export, or change the import to default style.
- "Cannot find module './X'" / "ERR_MODULE_NOT_FOUND" → the imported file was never written. Create it, or fix the import path.
- "X is not defined" / ReferenceError → either an undeclared variable, a missing import, or a typo. Re-check spelling.
- "Cannot read properties of null/undefined" → guard with optional chaining (\`?.\`) or check the value exists before using it.
- "EADDRINUSE" → another process is using the port. Either change the port in the code or warn the user.
- "Unexpected token" / SyntaxError → real syntax error in the emitted file. Re-write the file with correct syntax.

# Hard requirements
- Output corrected files only — re-emit each broken file in full with <lov-write>.
- Fix the ACTUAL root cause, not symptoms. Don't catch errors silently to hide them.
- Do NOT apologize, do NOT restate the user's prompt, do NOT add unrelated features.
- If you change \`a.js\`'s exports, also re-check every file that imports from \`a.js\` and re-emit them too if needed.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = (createFileRoute as any)("/api/chat")({
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
        }
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
