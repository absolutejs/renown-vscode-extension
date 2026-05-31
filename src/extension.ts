// Renown — VS Code extension (v0). Two jobs:
//   1. Status bar HUD — your live renown (score + level) from the configured renown server,
//      clickable to open your profile.
//   2. Activity heartbeats — while you actively edit a repo, after N minutes of activity it asks
//      the renown server to recompute your renown for that repo (server-side, from your real
//      GitHub commits — the same path the CLI's `renown ci-sync` uses). Editing is just the
//      *trigger*; the score is always GitHub-verified, never self-reported.
//
// Config: renown.endpoint (API base, e.g. https://renown.example.com/api), renown.login,
// renown.heartbeatMinutes, renown.statusRefreshSeconds.
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

let statusItem: vscode.StatusBarItem;
const timers: NodeJS.Timeout[] = [];
const activeMinutes = new Map<string, number>();   // workspace folder → accumulated active minutes
const lastEditAt = new Map<string, number>();       // workspace folder → last edit timestamp (ms)

const cfg = () => vscode.workspace.getConfiguration("renown");
// Once renown is hosted, set HOSTED_DEFAULT to the public API base (e.g. https://renown.app/api).
// Then `renown.endpoint` becomes OPTIONAL — users only set it to override (self-hosted / local
// dev). Empty for now: there's no hosted renown yet, so the endpoint must be configured (e.g.
// http://localhost:7777/api against a locally-run `bun run start` in renown/web). See the
// renown-hosted-endpoint project note.
const HOSTED_DEFAULT = "";
const endpoint = () => {
  const v = (cfg().get<string>("endpoint") || "").trim();
  return (v || HOSTED_DEFAULT).replace(/\/+$/, "");
};
const login = () => (cfg().get<string>("login") ?? "").trim();
const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1_000)}k` : n.toLocaleString("en-US"));

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "renown.openProfile";
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("renown.openProfile", openProfile),
    vscode.commands.registerCommand("renown.syncNow", () => syncActiveRepo(true)),
    vscode.commands.registerCommand("renown.setLogin", setLogin),
    vscode.commands.registerCommand("renown.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "renown")),
    vscode.workspace.onDidChangeTextDocument((e) => onEdit(e.document)),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("renown")) void refreshStatus(); }),
  );

  void refreshStatus();
  const statusEvery = Math.max(30, cfg().get<number>("statusRefreshSeconds") ?? 90) * 1000;
  timers.push(setInterval(() => void refreshStatus(), statusEvery));
  timers.push(setInterval(() => void tickHeartbeat(), 60_000));   // 1-min activity tick
  context.subscriptions.push({ dispose: () => { for (const t of timers) clearInterval(t); } });
}

export function deactivate() { for (const t of timers) clearInterval(t); }

function onEdit(doc: vscode.TextDocument) {
  if (doc.uri.scheme !== "file") return;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (folder) lastEditAt.set(folder.uri.fsPath, Date.now());
}

// Once a minute: any repo edited in the last minute counts as one active minute; once a repo
// crosses heartbeatMinutes of activity, refresh its renown and reset its counter.
async function tickHeartbeat() {
  if (!endpoint() || !login()) return;
  const threshold = Math.max(1, cfg().get<number>("heartbeatMinutes") ?? 5);
  const now = Date.now();
  for (const [folderPath, ts] of [...lastEditAt]) {
    if (now - ts > 60_000) continue;   // no edit in the last minute → idle this tick
    const mins = (activeMinutes.get(folderPath) ?? 0) + 1;
    if (mins >= threshold) {
      activeMinutes.delete(folderPath);
      await syncRepoAt(folderPath, false);
    } else {
      activeMinutes.set(folderPath, mins);
    }
  }
}

// owner/repo for a workspace folder's GitHub origin, or null.
async function repoOf(folderPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", folderPath, "config", "--get", "remote.origin.url"]);
    const m = stdout.trim().match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

async function syncRepoAt(folderPath: string, notify: boolean) {
  const base = endpoint(), who = login();
  if (!base || !who) return;
  const repo = await repoOf(folderPath);
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  await post("/verify", { login: who });                                   // global renown (base + attribution + pets + skills)
  if (repo) await post("/ci/repo-sync", { repo, logins: [who] });          // this repo's verified board entry
  if (notify) vscode.window.showInformationMessage(`Renown: synced ${repo ?? `@${who}`}.`);
  await refreshStatus();
}

async function syncActiveRepo(notify: boolean) {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showWarningMessage("Renown: open a folder/repo first."); return; }
  if (!endpoint()) { vscode.window.showWarningMessage("Renown: set renown.endpoint in Settings."); return; }
  if (!login()) { await setLogin(); if (!login()) return; }
  await syncRepoAt(folder.uri.fsPath, notify);
}

async function refreshStatus() {
  const base = endpoint(), who = login();
  // Always show a presence so the extension is discoverable even before it's configured.
  if (!base) {
    statusItem.text = "$(flame) Renown: set up";
    statusItem.tooltip = "Click to set your renown server endpoint (renown.endpoint)";
    statusItem.command = "renown.openSettings";
    statusItem.show();
    return;
  }
  if (!who) {
    statusItem.text = "$(account) Renown: set login";
    statusItem.tooltip = "Click to set your GitHub login";
    statusItem.command = "renown.setLogin";
    statusItem.show();
    return;
  }
  statusItem.command = "renown.openProfile";
  try {
    const r = await fetch(`${base}/profile/${encodeURIComponent(who)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const p = (await r.json()) as { score?: number; totalLevel?: number; error?: string };
    if (p.error) {
      statusItem.text = `$(flame) renown: @${who}?`;
      statusItem.tooltip = `${who} isn't on renown yet — link your account, then commit.`;
    } else {
      statusItem.text = `$(flame) ${fmt(p.score ?? 0)} renown`;
      statusItem.tooltip = `@${who} · total level ${p.totalLevel ?? 0}\nClick to open your renown profile`;
    }
  } catch {
    statusItem.text = "$(flame) renown $(warning)";
    statusItem.tooltip = `Couldn't reach the renown server (${base}).`;
  }
  statusItem.show();
}

function openProfile() {
  const who = login(), base = endpoint();
  if (!base) { void vscode.window.showWarningMessage("Renown: set renown.endpoint in Settings."); return; }
  if (!who) { void setLogin(); return; }
  const origin = base.replace(/\/api$/, "");
  void vscode.env.openExternal(vscode.Uri.parse(`${origin}/profile/${encodeURIComponent(who)}`));
}

async function setLogin() {
  const v = await vscode.window.showInputBox({ prompt: "Your GitHub login (for renown)", value: login(), placeHolder: "octocat" });
  if (v !== undefined) {
    await cfg().update("login", v.trim(), vscode.ConfigurationTarget.Global);
    void refreshStatus();
  }
}
