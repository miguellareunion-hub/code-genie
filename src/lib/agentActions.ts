/**
 * Parses agent output into a list of file actions.
 *
 * Supported tag formats (the model is instructed to use them):
 *
 *   <lov-write path="index.html">
 *   ...file content...
 *   </lov-write>
 *
 *   <lov-rename from="old.js" to="new.js" />
 *
 *   <lov-delete path="old.css" />
 *
 * Anything outside these tags is treated as normal markdown chat text.
 */
export type AgentAction =
  | { type: "write"; path: string; content: string }
  | { type: "rename"; from: string; to: string }
  | { type: "delete"; path: string };

export type ParsedAgentOutput = {
  /** Markdown text with action blocks stripped out (for nice rendering). */
  text: string;
  actions: AgentAction[];
};

const WRITE_RE = /<lov-write\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/lov-write>/g;
const RENAME_RE = /<lov-rename\s+from=["']([^"']+)["']\s+to=["']([^"']+)["']\s*\/?>/g;
const DELETE_RE = /<lov-delete\s+path=["']([^"']+)["']\s*\/?>/g;

export function parseAgentOutput(raw: string): ParsedAgentOutput {
  const actions: AgentAction[] = [];
  let text = raw;

  text = text.replace(WRITE_RE, (_m, path: string, content: string) => {
    // Strip a single leading/trailing newline that the model usually adds
    // and an optional fenced code block wrapping.
    let body = content.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const fenced = body.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
    if (fenced) body = fenced[1];
    actions.push({ type: "write", path: path.trim(), content: body });
    return `\n📝 **Updated** \`${path.trim()}\`\n`;
  });

  text = text.replace(RENAME_RE, (_m, from: string, to: string) => {
    actions.push({ type: "rename", from: from.trim(), to: to.trim() });
    return `\n✏️ **Renamed** \`${from.trim()}\` → \`${to.trim()}\`\n`;
  });

  text = text.replace(DELETE_RE, (_m, path: string) => {
    actions.push({ type: "delete", path: path.trim() });
    return `\n🗑️ **Deleted** \`${path.trim()}\`\n`;
  });

  return { text: text.trim(), actions };
}
