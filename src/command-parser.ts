type ParsedCommand =
  | { type: "next" }
  | { type: "jump"; filePath: string }
  | { type: "status" }
  | { type: "exit" }
  | { type: "followup"; text: string };

const NEXT_RE = /^(next|下一個|continue|ok)$/i;
const JUMP_RE = /^jump\s+(.+)$/i;
const STATUS_RE = /^status$/i;
const EXIT_RE = /^(exit|quit|q)$/i;

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed) return { type: "followup", text: "" };

  if (NEXT_RE.test(trimmed)) return { type: "next" };

  const jumpMatch = JUMP_RE.exec(trimmed);
  if (jumpMatch) return { type: "jump", filePath: (jumpMatch[1] ?? "").trim() };

  if (STATUS_RE.test(trimmed)) return { type: "status" };
  if (EXIT_RE.test(trimmed)) return { type: "exit" };

  return { type: "followup", text: trimmed };
}
