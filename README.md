# Kiln

Describe a 3D model and AI builds it in Blender while you watch. Exports GLB, FBX, OBJ, STL and .blend, and bakes models for Roblox.

[Download](https://shuriken.studio/apps/kiln) · [Setup guide](docs/SETUP.md)

## You need

- Windows 10 or 11, 64-bit
- Blender 5.2 LTS
- A Claude account signed in through Claude Code

A graphics card is recommended.

Usage is billed to, and limited by, the Claude account you sign in with, under that account's terms. TODO: copy (written separately).

## Install

1. Install [Blender 5.2 LTS](https://www.blender.org/download/).
2. Download the installer and run it. It isn't code-signed, so Windows may warn you: choose **More info → Run anyway** if you trust the release.
3. Sign in to Claude: TODO: copy (written separately).

The full walkthrough is in the [setup guide](docs/SETUP.md). Kiln also comes with [Shuriken Studio](https://shuriken.studio/apps/shuriken-studio).

## New in 0.9.0

<!-- Topics: deleting projects (start page, full project list, tab menu, Settings); no z-fighting in models; one Claude login, the same as Shuriken's; no automatic updates (download each version fresh). -->

TODO: copy (written separately).

## Build from source

Needs Node.js 24 or newer.

```powershell
npm ci
npm run dev
```

## License

[MIT](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Kiln is an independent project, not made or endorsed by the Blender Foundation, Roblox Corporation or Anthropic.
