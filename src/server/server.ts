import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerApiRoutes } from "./routes.js";
import { createDefaultUiServerService } from "./service.js";
import type { CreateUiServerOptions, StartUiServerOptions } from "./types.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function createUiApp(options: CreateUiServerOptions): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  registerApiRoutes(app, options.service);

  const staticDir = options.staticDir ?? resolveUiBuildDir();
  if (!existsSync(join(staticDir, "index.html"))) {
    throw new Error(`Built UI assets not found at ${staticDir}. Run npm run build first.`);
  }

  app.use(express.static(staticDir));
  app.get("*", (_req, res) => {
    res.sendFile(join(staticDir, "index.html"));
  });

  return app;
}

export async function startUiServer(options: StartUiServerOptions): Promise<string> {
  const service = createDefaultUiServerService(options.config);
  const app = createUiApp({ service });
  const port = await listen(app);
  const url = new URL(`http://127.0.0.1:${port}/`);
  if (options.initialPrUrl) {
    url.searchParams.set("prUrl", options.initialPrUrl);
  }
  openBrowser(url.toString());
  return url.toString();
}

function resolveUiBuildDir(): string {
  const candidates = [
    join(MODULE_DIR, "..", "..", "ui"),
    join(MODULE_DIR, "..", "..", "dist", "ui"),
    join(MODULE_DIR, "..", "..", "..", "dist", "ui")
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html")) && existsSync(join(candidate, "assets"))) {
      return candidate;
    }
  }
  return candidates[0] ?? join(MODULE_DIR, "..", "..", "dist", "ui");
}

function listen(app: Express): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine UI server port."));
        return;
      }
      resolve(address.port);
    });
    server.on("error", reject);
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { bin: "open", args: [url] }
    : process.platform === "win32"
      ? { bin: "cmd", args: ["/c", "start", "", url] }
      : { bin: "xdg-open", args: [url] };

  execFile(command.bin, command.args, (error) => {
    if (error) {
      process.stderr.write(`Open ${url} manually.\n`);
    }
  });
}
