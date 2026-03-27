/**
 * Dev-only: starts the express API server on a fixed port (3001) so that
 * `vite dev` can proxy /api/* requests to it during development.
 *
 * Usage: npm run dev:server
 */
import { config as loadDotenv } from "dotenv";
import { join } from "node:path";

loadDotenv({ path: join(process.cwd(), ".env") });

import { createServer } from "node:http";
import express from "express";
import { createDefaultUiServerService, registerApiRoutes } from "./ui-server.js";
import type { ModelPreset } from "./types.js";

const PORT = 3001;
const token = process.env.GITHUB_TOKEN?.trim();
const model = (process.env.MODEL_PRESET ?? "haiku") as ModelPreset;

if (!token) {
  process.stderr.write("GITHUB_TOKEN is not set in .env\n");
  process.exit(1);
}

const service = createDefaultUiServerService(token, model);
const app = express();
app.use(express.json({ limit: "1mb" }));
registerApiRoutes(app, service);

createServer(app).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`API server listening on http://127.0.0.1:${PORT}\n`);
});
