import type { Plugin } from "@opencode-ai/plugin";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLI_APP_ID = "cli";

// Detect Claude CLI version dynamically at startup
async function getClaudeVersion(claudePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(claudePath, ["--version"], { timeout: 5_000 });
    // Output like "claude 2.1.80" or "2.1.80"
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  return "2.1.80"; // fallback
}

function buildUserAgent(version: string): string {
  return `claude-cli/${version} (external, cli)`;
}

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string | number;
    subscriptionType?: string;
  };
};

type OpenCodeAuth = Record<
  string,
  {
    type: string;
    key?: string;
    access?: string;
    refresh?: string;
    expires?: number;
    [k: string]: unknown;
  }
>;

function credentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

function authJsonPath(): string {
  if (platform() === "win32") {
    const appData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(appData, "opencode", "auth.json");
  }
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "opencode", "auth.json");
}

async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(p, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

async function readCredentialsFromKeychain(): Promise<ClaudeCredentials | undefined> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ]);
    return JSON.parse(stdout.trim()) as ClaudeCredentials;
  } catch {
    return undefined;
  }
}

async function readCredentials(): Promise<ClaudeCredentials | undefined> {
  if (platform() === "darwin") {
    const keychainCreds = await readCredentialsFromKeychain();
    if (keychainCreds) return keychainCreds;
  }
  return readJson<ClaudeCredentials>(credentialsPath());
}

async function findClaude(): Promise<string | undefined> {
  // Windows: check common paths
  if (platform() === "win32") {
    const commonPaths = [
      join(homedir(), ".claude", "local", "claude.exe"),
      join(homedir(), "AppData", "Local", "Programs", "claude-code", "claude.exe"),
    ];
    for (const p of commonPaths) {
      try {
        await readFile(p);
        return p;
      } catch {}
    }
    // Try PATH
    try {
      const { stdout } = await execFileAsync("where", ["claude"]);
      const first = stdout.trim().split("\n")[0];
      if (first) return first.trim();
    } catch {}
    return undefined;
  }

  // Unix: which
  try {
    const { stdout } = await execFileAsync("which", ["claude"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function refreshViaCli(claudePath: string): Promise<void> {
  try {
    await execFileAsync(
      claudePath,
      ["-p", ".", "--model", "claude-haiku-4-5-20250514"],
      { timeout: 60_000, env: { ...process.env, TERM: "dumb" } },
    );
  } catch {}
}

const REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

const plugin: Plugin = async () => {
  const claudePath = await findClaude();
  const creds = await readCredentials();

  if (!claudePath || !creds?.claudeAiOauth?.accessToken) {
    return {};
  }

  // Get version dynamically from installed Claude CLI
  const cliVersion = await getClaudeVersion(claudePath);
  const cliUserAgent = buildUserAgent(cliVersion);

  let cachedToken: string | undefined;
  let cachedExpiresAt: number | undefined;
  let syncPromise: Promise<void> | null = null;

  async function doSync(): Promise<void> {
    const creds = await readCredentials();
    let access = creds?.claudeAiOauth?.accessToken;
    let exp = creds?.claudeAiOauth?.expiresAt;

    if (!access) return;

    const remaining = exp ? Number(exp) - Date.now() : Infinity;

    if (remaining < 5 * 60 * 1000) {
      await refreshViaCli(claudePath!);
      const fresh = await readCredentials();
      if (fresh?.claudeAiOauth?.accessToken) {
        access = fresh.claudeAiOauth.accessToken;
        exp = fresh.claudeAiOauth.expiresAt;
      }
    }

    cachedToken = access;
    cachedExpiresAt = exp ? Number(exp) : undefined;

    try {
      const auth = (await readJson<OpenCodeAuth>(authJsonPath())) ?? {};
      const refreshToken = creds?.claudeAiOauth?.refreshToken;
      if (auth.anthropic?.access !== cachedToken) {
        auth.anthropic = {
          ...(auth.anthropic ?? {}),
          type: "oauth",
          access: cachedToken!,
          ...(refreshToken ? { refresh: refreshToken } : {}),
          ...(cachedExpiresAt ? { expires: cachedExpiresAt } : {}),
        };
        await writeFile(authJsonPath(), JSON.stringify(auth, null, 2), "utf-8");
      }
    } catch {}
  }

  function ensureSync(): Promise<void> {
    if (!syncPromise) {
      syncPromise = doSync().finally(() => {
        syncPromise = null;
      });
    }
    return syncPromise;
  }

  return {
    config: async (config: any): Promise<void> => {
      const providers = config.provider ?? {};
      if (!providers.anthropic) {
        providers.anthropic = { options: { apiKey: "cli-managed" } };
        config.provider = providers;
      }
    },

    "session.created": async (): Promise<void> => {
      try {
        await ensureSync();
      } catch {}
    },

    "chat.headers": async (input: any, output: any): Promise<void> => {
      try {
        if (input?.model?.providerID !== "anthropic") return;

        // Match official Claude CLI headers
        output.headers["user-agent"] = cliUserAgent;
        output.headers["x-app"] = CLI_APP_ID;

        const now = Date.now();

        if (cachedToken && cachedExpiresAt && cachedExpiresAt > now) {
          output.headers["x-api-key"] = cachedToken;
          if (cachedExpiresAt - now < REFRESH_THRESHOLD_MS && !syncPromise) {
            ensureSync();
          }
          return;
        }

        if (syncPromise) {
          await syncPromise;
          if (cachedToken) output.headers["x-api-key"] = cachedToken;
          return;
        }

        const creds = await readCredentials();
        const access = creds?.claudeAiOauth?.accessToken;
        const exp = creds?.claudeAiOauth?.expiresAt
          ? Number(creds.claudeAiOauth.expiresAt)
          : undefined;

        if (access && exp && exp > now) {
          cachedToken = access;
          cachedExpiresAt = exp;
          output.headers["x-api-key"] = access;
          return;
        }

        await ensureSync();
        if (cachedToken) output.headers["x-api-key"] = cachedToken;
      } catch {}
    },
  };
};

export default plugin;
