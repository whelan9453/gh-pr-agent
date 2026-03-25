import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { TerminalRendererOptions } from "marked-terminal";
import { highlight, supportsLanguage } from "cli-highlight";

// Apply markedTerminal for headings, bold, lists, inline code, tables, etc.
const terminalOpts: TerminalRendererOptions = { reflowText: false, showSectionPrefix: false };
// markedTerminal returns the new extension object at runtime; @types is behind
// eslint-disable-next-line @typescript-eslint/no-explicit-any
marked.use(markedTerminal(terminalOpts) as any);

// Override code blocks with cli-highlight for better syntax highlighting.
// This must be applied after markedTerminal so it takes precedence.
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = lang && supportsLanguage(lang) ? lang : "plaintext";
      try {
        const highlighted = highlight(text, { language, ignoreIllegals: true });
        return "\n" + highlighted + "\n\n";
      } catch {
        return "\n" + text + "\n\n";
      }
    }
  }
});

/**
 * Render markdown to styled terminal output when connected to a TTY.
 * Falls back to plain markdown when piped or redirected.
 */
export function renderToTerminal(markdown: string): string {
  if (!process.stdout.isTTY) {
    return markdown;
  }
  return String(marked(markdown));
}
