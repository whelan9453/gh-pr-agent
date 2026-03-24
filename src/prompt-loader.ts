import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function loadPrompt(promptFile?: string): Promise<string> {
  const candidate = promptFile
    ? path.resolve(promptFile)
    : path.resolve(__dirname, "..", "prompts", "review_prompt.md");
  return readFile(candidate, "utf8");
}
