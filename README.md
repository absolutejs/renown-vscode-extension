# Renown — VS Code

Earn [renown](https://github.com/absolutejs/renown) for real dev work, in your editor.

- **Status bar HUD** — your live renown (score + total level) from your renown server; click to open your profile.
- **Activity sync** — while you actively edit a repo, after a few minutes it asks the server to recompute your renown for that repo from your real GitHub commits (the same path as the `renown ci-sync` Action). Editing only *triggers* the refresh; the score is always GitHub-verified, never self-reported.

## Setup
1. `renown.endpoint` — your renown server's API base, e.g. `https://renown.example.com/api`.
2. `renown.login` — your GitHub login (or run **Renown: Set GitHub Login**).

Commands: **Renown: Open My Profile**, **Renown: Sync This Repo Now**, **Renown: Set GitHub Login**.

Unrelated to `@absolutejs/absolutejs-vscode-extension` — this is the renown product's own extension.
