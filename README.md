# Kiln

Describe a 3D model and AI builds it in Blender while you watch. Exports GLB, FBX, OBJ, STL and .blend, and bakes models for Roblox.

[Download](https://shuriken.studio/apps/kiln) · [Setup guide](docs/SETUP.md)

## You need

- Windows 10 or 11, 64-bit
- Blender 5.2 LTS
- A Claude account signed in through Claude Code

A graphics card is recommended.

Usage is billed to, and limited by, the Claude account you sign in with, under that account's terms. Kiln runs on this PC's Claude Code login, the same one Shuriken Studio uses by default, and Settings → Claude login shows its 5-hour and weekly usage. Models that Shuriken asks for run on Shuriken's login.

## Install

1. Install [Blender 5.2 LTS](https://www.blender.org/download/).
2. Download the installer and run it. It isn't code-signed, so Windows may warn you: choose **More info → Run anyway** if you trust the release.
3. Sign in to Claude. Kiln uses this PC's Claude Code login. With Shuriken Studio installed, sign in there (Settings → Claude login → **Sign in**). Otherwise [install Claude Code](https://code.claude.com/docs/en/setup), run `claude` in a terminal and follow the sign-in prompts.

The full walkthrough is in the [setup guide](docs/SETUP.md). Kiln also comes with [Shuriken Studio](https://shuriken.studio/apps/shuriken-studio).

## New in 0.9.0

- **Delete projects from anywhere:** a start page card, the full list under **All projects**, a tab's right-click menu, or Settings → Data & logs. Open and working projects can go too: the copilot stops first. Deleted projects move to `Documents\Kiln\.trash`.
- **No flickering surfaces:** Kiln checks for z-fighting after every change and before it hands a model over, and sends the copilot back to fix what's left.
- **No automatic updates:** download each new version and run its installer over the old one.

Full notes: [docs/RELEASE-0.9.0.md](docs/RELEASE-0.9.0.md).

## Build from source

Needs Node.js 24 or newer.

```powershell
npm ci
npm run dev
```

## License

[MIT](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Kiln is an independent project, not made or endorsed by the Blender Foundation, Roblox Corporation or Anthropic.
