// Renown — VS Code extension (v1). Three surfaces:
//   1. Status bar HUD — your live renown (score + this-week delta + level/pets in the tooltip),
//      clickable to open your profile.
//   2. Activity heartbeats — while you actively edit a repo, after N minutes of activity it asks
//      the renown server to recompute your renown for that repo (server-side, from your real
//      GitHub commits — the same path the CLI's `renown ci-sync` uses). Editing is just the
//      *trigger*; the score is always GitHub-verified, never self-reported. On sync it toasts the
//      actual "+X renown / +N pets" delta from /verify.
//   3. Sidebar panel — your badge, this week's recap, your pets (the /profile pets.svg roster),
//      this repo's /project board, and the achievements you unlocked this week (a webview of the
//      server-rendered surfaces).
//
// Identity comes from VS Code's built-in GitHub sign-in (renown.signIn) — a proven login, shown
// verified. renown.login is just an optional override (self-hosted / view-as).
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
const lastSyncAt = new Map<string, number>();       // workspace folder → last sync timestamp (ms)
let syncingRepo: string | null = null;              // non-null while a sync is in flight (drives the spinner)
let ghSession: vscode.AuthenticationSession | undefined;   // VS Code's GitHub session, when signed in

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
// The GitHub login VS Code has authenticated us as (empty when signed out).
const verifiedLogin = () => (ghSession?.account.label ?? "").trim();
// Effective login: an explicit renown.login override wins (self-hosted / impersonation for testing),
// otherwise the signed-in GitHub identity.
const login = () => (cfg().get<string>("login") ?? "").trim() || verifiedLogin();
// True when the effective login is the one GitHub authenticated us as — i.e. proven, not typed.
const isVerified = () => { const v = verifiedLogin(); return !!v && login().toLowerCase() === v.toLowerCase(); };
const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1_000)}k` : n.toLocaleString("en-US"));

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "renown.openProfile";
  panel = new RenownPanel();
  context.subscriptions.push(
    statusItem,
    vscode.window.registerWebviewViewProvider("renown.panel", panel),
    vscode.commands.registerCommand("renown.openProfile", openProfile),
    vscode.commands.registerCommand("renown.syncNow", () => syncActiveRepo("manual")),
    vscode.commands.registerCommand("renown.signIn", () => signIn(true)),
    vscode.commands.registerCommand("renown.setLogin", setLogin),
    vscode.commands.registerCommand("renown.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "renown")),
    vscode.commands.registerCommand("renown.refreshPanel", () => panel?.refresh()),
    vscode.commands.registerCommand("renown.previewPet", previewPet),
    vscode.workspace.onDidChangeTextDocument((e) => onEdit(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => onEdit(doc)),   // saving also counts as activity
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("renown")) { void refreshStatus(); panel?.refresh(); } }),
    vscode.window.onDidChangeActiveTextEditor(() => panel?.refresh()),   // board follows the active repo
    vscode.authentication.onDidChangeSessions((e) => { if (e.provider.id === "github") void adoptSession(); }),
  );

  void adoptSession();   // silently pick up an existing GitHub session, then render
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
// crosses heartbeatMinutes of activity, refresh its renown and reset its counter. A cooldown of
// one full window stops a repo from re-syncing back-to-back while you keep typing.
async function tickHeartbeat() {
  if (!endpoint() || !login() || syncingRepo !== null) return;
  const threshold = Math.max(1, cfg().get<number>("heartbeatMinutes") ?? 5);
  const cooldownMs = threshold * 60_000;
  const now = Date.now();
  for (const [folderPath, ts] of [...lastEditAt]) {
    if (now - ts > 60_000) continue;   // no edit in the last minute → idle this tick
    const mins = (activeMinutes.get(folderPath) ?? 0) + 1;
    if (mins >= threshold) {
      activeMinutes.delete(folderPath);
      if (now - (lastSyncAt.get(folderPath) ?? 0) < cooldownMs) continue;   // synced recently → hold off
      await syncRepoAt(folderPath, "heartbeat");
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

type SyncMode = "manual" | "heartbeat";

async function syncRepoAt(folderPath: string, mode: SyncMode) {
  const base = endpoint(), who = login();
  if (!base || !who) return;
  const repo = await repoOf(folderPath);
  lastSyncAt.set(folderPath, Date.now());
  showSyncing(repo);                                                       // subtle $(sync~spin) in the status bar
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  let delta = 0, newSeeds: string[] = [];
  try {
    const vr = await post("/verify", { login: who });                      // global renown (base + attribution + pets + skills)
    if (vr?.ok) {
      try {
        const j = (await vr.json()) as { attributionDelta?: number; newPetSeeds?: unknown[] };
        delta = Number(j.attributionDelta ?? 0);
        newSeeds = Array.isArray(j.newPetSeeds) ? j.newPetSeeds.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
      } catch { /* non-JSON / throttled */ }
    }
    if (repo) await post("/ci/repo-sync", { repo, logins: [who] });        // this repo's verified board entry
  } finally {
    syncingRepo = null;
  }
  await refreshStatus();
  panel?.refresh();
  // Headline the loot. New 1/1 pets get the celebration: a manual sync opens it (you asked); a
  // background heartbeat stays out of the way — it toasts with a "Show" button instead. Otherwise
  // just a quiet renown toast; a manual no-op still acknowledges the click.
  const newPets = newSeeds.length;
  const bits: string[] = [];
  if (delta > 0) bits.push(`+${fmt(delta)} renown`);
  if (newPets > 0) bits.push(`+${newPets} pet${newPets === 1 ? "" : "s"}`);
  if (newPets > 0) {
    const head = `Renown: ${bits.join(" · ")} — new pet${newPets === 1 ? "" : "s"} hatched!${repo ? ` on ${repo}` : ""} 🎉`;
    if (mode === "manual") { vscode.window.showInformationMessage(head); celebrateNewPets(newSeeds, repo); }
    else if (await vscode.window.showInformationMessage(head, "Show new pet") === "Show new pet") celebrateNewPets(newSeeds, repo);
  } else if (bits.length) {
    vscode.window.showInformationMessage(`Renown: ${bits.join(" · ")}${repo ? ` on ${repo}` : ""} 🎉`);
  } else if (mode === "manual") {
    vscode.window.showInformationMessage(`Renown: synced${repo ? ` ${repo}` : ""} — no new attribution since last sync.`);
  }
}

async function syncActiveRepo(mode: SyncMode) {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showWarningMessage("Renown: open a folder/repo first."); return; }
  if (!endpoint()) { vscode.window.showWarningMessage("Renown: set renown.endpoint in Settings."); return; }
  if (!login()) { await setLogin(); if (!login()) return; }
  await syncRepoAt(folder.uri.fsPath, mode);
}

// While a sync is in flight, show a spinner in the status bar (refreshStatus yields to it).
function showSyncing(repo: string | null) {
  syncingRepo = repo ?? "";
  const name = repo ? repo.split("/")[1] : "";
  statusItem.text = `$(sync~spin) renown${name ? ` · ${name}` : ""}`;
  statusItem.tooltip = `Syncing your renown${repo ? ` for ${repo}` : ""}…`;
  statusItem.show();
}

async function refreshStatus() {
  if (syncingRepo !== null) return;   // a sync is showing its spinner — don't overwrite it
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
    statusItem.text = "$(github) Renown: sign in";
    statusItem.tooltip = "Sign in with GitHub to see your renown";
    statusItem.command = "renown.signIn";
    statusItem.show();
    return;
  }
  statusItem.command = "renown.openProfile";
  try {
    // /recap gives score + total level + pets AND the 7-day delta in one call (richer than /profile).
    const r = await fetch(`${base}/recap/${encodeURIComponent(who)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const p = (await r.json()) as { error?: string; currentScore?: number; totalLevel?: number; petsCount?: number; attributionDelta?: number };
    if (p.error) {
      statusItem.text = `$(flame) renown: @${who}?`;
      statusItem.tooltip = `${who} isn't on renown yet — link your account, then commit.`;
    } else {
      const wk = Number(p.attributionDelta ?? 0);
      statusItem.text = `$(flame) ${fmt(p.currentScore ?? 0)} renown${wk > 0 ? ` $(arrow-up)${fmt(wk)}` : ""}`;
      const ident = isVerified() ? `@${who} $(verified-filled) signed in with GitHub` : `@${who} (set via renown.login)`;
      statusItem.tooltip = `${ident} · total level ${p.totalLevel ?? 0} · ${fmt(p.petsCount ?? 0)} pets${wk > 0 ? `\n+${fmt(wk)} renown this week` : ""}${heartbeatHint()}\nClick to open your renown profile`;
    }
  } catch {
    statusItem.text = "$(flame) renown $(warning)";
    statusItem.tooltip = `Couldn't reach the renown server (${base}).`;
  }
  statusItem.show();
}

// A compact line for the status tooltip: where the active repo sits in its heartbeat window, or
// when it last synced. Surfaces the otherwise-invisible activity tracker.
function heartbeatHint(): string {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) return "";
  const path = folder.uri.fsPath;
  const threshold = Math.max(1, cfg().get<number>("heartbeatMinutes") ?? 5);
  const mins = activeMinutes.get(path) ?? 0;
  if (mins > 0) return `\nactivity: ${mins}/${threshold} min → auto-sync`;
  const last = lastSyncAt.get(path);
  if (last) { const ago = Math.round((Date.now() - last) / 60_000); return `\nlast synced ${ago < 1 ? "just now" : `${ago}m ago`}`; }
  return "";
}

function openProfile() {
  const who = login(), base = endpoint();
  if (!base) { void vscode.window.showWarningMessage("Renown: set renown.endpoint in Settings."); return; }
  if (!who) { void setLogin(); return; }
  const origin = base.replace(/\/api$/, "");
  void vscode.env.openExternal(vscode.Uri.parse(`${origin}/profile/${encodeURIComponent(who)}`));
}

// Sign in through VS Code's built-in GitHub provider — the real OAuth flow, no client_id/secret
// of our own. We use the resulting identity's login as the (proven) renown login. `interactive`
// false is the silent startup adopt; true is the explicit command (may pop the auth UI).
async function signIn(interactive: boolean) {
  try {
    const session = await vscode.authentication.getSession("github", ["read:user"], interactive ? { createIfNone: true } : { createIfNone: false, silent: true });
    if (!session) { if (interactive) void vscode.window.showWarningMessage("Renown: GitHub sign-in was dismissed."); return; }
    ghSession = session;
    // Clear a stale manual override so the proven identity is what's used (an override only makes
    // sense when it differs from who you're signed in as — keep it then).
    const override = (cfg().get<string>("login") ?? "").trim();
    if (override && override.toLowerCase() === session.account.label.toLowerCase()) {
      await cfg().update("login", "", vscode.ConfigurationTarget.Global);
    }
    if (interactive) void vscode.window.showInformationMessage(`Renown: signed in as @${session.account.label}.`);
  } catch (e) {
    if (interactive) void vscode.window.showWarningMessage(`Renown: GitHub sign-in failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  void refreshStatus();
  panel?.refresh();
}

// Startup / session-change hook: adopt an existing GitHub session without prompting.
const adoptSession = () => signIn(false);

// Manual override — set an explicit renown.login (self-hosted, or to view as someone else). The
// primary path is GitHub sign-in; this is the escape hatch.
async function setLogin() {
  const pick = !ghSession
    ? await vscode.window.showQuickPick(["Sign in with GitHub", "Enter a login manually"], { placeHolder: "How do you want to set your renown identity?" })
    : "Enter a login manually";
  if (pick === undefined) return;
  if (pick === "Sign in with GitHub") { await signIn(true); return; }
  const v = await vscode.window.showInputBox({ prompt: "GitHub login to view as (overrides the signed-in identity)", value: (cfg().get<string>("login") ?? "").trim(), placeHolder: "octocat" });
  if (v !== undefined) {
    await cfg().update("login", v.trim(), vscode.ConfigurationTarget.Global);
    void refreshStatus();
    panel?.refresh();
  }
}

// --- New-pet celebration: when a sync mints new 1/1 pets, show the actual creatures -----------
let celebration: vscode.WebviewPanel | undefined;

function celebrateNewPets(seeds: string[], repo: string | null, preview = false) {
  const base = endpoint(), who = login();
  if (!base || !who || seeds.length === 0) return;
  const origin = base.replace(/\/api$/, ""), enc = encodeURIComponent(who);
  if (!celebration) {
    celebration = vscode.window.createWebviewPanel("renownNewPet", "🎉 New pet!", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: false, enableCommandUris: true });
    celebration.onDidDispose(() => { celebration = undefined; });
  }
  celebration.title = preview ? "🐾 Pet preview" : seeds.length > 1 ? `🎉 ${seeds.length} new pets!` : "🎉 New pet!";
  const cards = seeds.slice(0, 6)
    .map((s) => `<a href="${origin}/profile/${enc}" title="Open your profile"><img class="pet" src="${origin}/pet/${encodeURIComponent(s)}/card.svg" alt="${preview ? "pet" : "new pet"}"></a>`)
    .join("");
  const head = preview
    ? `<h1>This is what a hatch looks like 🐾</h1><p class="muted">A preview of your celebration. Commit verified work and a brand-new 1/1 pops up here automatically.</p>`
    : `<h1>You hatched ${seeds.length === 1 ? "a new pet" : `${seeds.length} new pets`}! 🎉</h1><p class="muted">Minted from your latest verified commits${repo ? ` on ${escHtml(repo)}` : ""}. Each is a 1/1 — procedurally generated from the commit, so no one else has it.</p>`;
  const body = `${head}
    <div class="pets">${cards}</div>
    <p style="margin-top:18px"><a class="btn" href="${origin}/profile/${enc}">See all your pets →</a></p>`;
  celebration.webview.html = celebrationShell(origin, body);
  celebration.reveal(vscode.ViewColumn.Beside, true);
}

// Opens the celebration with your existing signature pet — no new commit required. For demos,
// screenshots, and just confirming the surface works.
async function previewPet() {
  const base = endpoint(), who = login();
  if (!base) { void vscode.window.showWarningMessage("Renown: set renown.endpoint in Settings."); return; }
  if (!who) { await setLogin(); if (!login()) return; }
  try {
    const r = await fetch(`${base}/profile/${encodeURIComponent(login())}`, { signal: AbortSignal.timeout(8000) });
    const p = r.ok ? (await r.json()) as { rarestPetSeed?: string; avatarSeed?: string; showcaseSeeds?: unknown[] } : {};
    const seeds = [p.rarestPetSeed, p.avatarSeed, ...(Array.isArray(p.showcaseSeeds) ? p.showcaseSeeds : [])]
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    if (!seeds.length) { void vscode.window.showInformationMessage("Renown: no pets yet to preview — commit verified work to hatch your first."); return; }
    celebrateNewPets([seeds[0]], null, true);
  } catch { void vscode.window.showWarningMessage(`Renown: couldn't reach the renown server (${base}).`); }
}

function celebrationShell(origin: string, body: string): string {
  const imgSrc = `${origin ? origin + " " : ""}https: http: data:`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline';">
<style>
  body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: 28px 24px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .muted { opacity: .7; max-width: 440px; margin: 0 auto 22px; line-height: 1.45; }
  .pets { display: flex; flex-wrap: wrap; gap: 18px; justify-content: center; }
  .pet { width: 240px; max-width: 46vw; border-radius: 14px; display: block; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .btn { display: inline-block; padding: 7px 14px; border-radius: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
</style></head><body>${body}</body></html>`;
}

// --- Sidebar panel: weekly recap + this repo's board + recent achievements -----------------
let panel: RenownPanel | undefined;

class RenownPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: false, enableCommandUris: true };
    view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(); });
    void this.refresh();
  }
  async refresh() {
    if (this.view) this.view.webview.html = await renderPanel();
  }
}

async function activeRepo(): Promise<string | null> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder ? repoOf(folder.uri.fsPath) : null;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function panelShell(origin: string, body: string): string {
  // No scripts; allow images from the renown origin (the badge/board SVGs are served there).
  // command: links work via enableCommandUris on the webview.
  const imgSrc = `${origin ? origin + " " : ""}https: http: data:`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline';">
<style>
  body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 12px; }
  img { max-width: 100%; display: block; border-radius: 6px; margin: 2px 0; }
  .stat { margin: 10px 0; }
  .stat b { color: var(--vscode-charts-green, #86efac); }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .65; margin: 16px 0 6px; }
  .ach { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,.08)); }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .btn { display: inline-block; margin: 8px 0; padding: 5px 11px; border-radius: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .muted { opacity: .6; }
</style></head><body>${body}</body></html>`;
}

async function renderPanel(): Promise<string> {
  const base = endpoint(), who = login();
  if (!base) return panelShell("", `<p class="muted">Set <code>renown.endpoint</code> to your renown server and your weekly renown + this repo's board show up here.</p><a class="btn" href="command:renown.openSettings">Open settings</a>`);
  if (!who) return panelShell("", `<p class="muted">Sign in with GitHub to see your renown, pets, and this repo's board.</p><a class="btn" href="command:renown.signIn">Sign in with GitHub</a>`);
  const origin = base.replace(/\/api$/, "");
  const enc = encodeURIComponent(who);
  type PanelRecap = { error?: string; attributionDelta?: number; newAchievements?: { id: string; name: string }[] };
  let recap: PanelRecap | null = null;
  try { const r = await fetch(`${base}/recap/${enc}`, { signal: AbortSignal.timeout(8000) }); if (r.ok) recap = (await r.json()) as PanelRecap; } catch { /* offline → render what we can */ }
  const repo = await activeRepo();
  const achs = recap?.newAchievements ?? [];
  const wk = Number(recap?.attributionDelta ?? 0);
  const body = `
    <a href="${origin}/profile/${enc}"><img src="${origin}/profile/${enc}/badge.svg" alt="renown badge"></a>
    ${recap && !recap.error
      ? `<div class="stat">this week: <b>+${fmt(wk)}</b> renown · <b>${achs.length}</b> achievement${achs.length === 1 ? "" : "s"}</div>`
      : `<p class="muted">@${escHtml(who)} isn't on renown yet — link your account and commit.</p>`}
    <a class="btn" href="command:renown.syncNow">⟳ Sync this repo</a>
    ${recap && !recap.error
      ? `<h3>Your pets</h3><a href="${origin}/profile/${enc}" title="Open your profile"><img src="${origin}/profile/${enc}/pets.svg" alt="your pets"></a>`
      : ""}
    ${repo
      ? `<h3>${escHtml(repo)}</h3><a href="${origin}/project/${repo}"><img src="${origin}/project/${repo}/board.svg" alt="${escHtml(repo)} leaderboard"></a>`
      : `<p class="muted">Open a GitHub repo to see its leaderboard.</p>`}
    ${achs.length ? `<h3>Unlocked this week</h3>${achs.slice(0, 8).map((a) => `<div class="ach"><a href="${origin}/achievement/${encodeURIComponent(a.id)}">${escHtml(a.name)}</a></div>`).join("")}` : ""}
    <p style="margin-top:14px"><a href="${origin}/profile/${enc}">Open full profile →</a> &nbsp;·&nbsp; <a href="${origin}/recap/${enc}">your week →</a></p>`;
  return panelShell(origin, body);
}
