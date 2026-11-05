# Set up Kiln

From a fresh Windows PC to your first model, in about 15 minutes (most of it downloads). The same guide is at
https://shuriken.studio/apps/kiln/setup.

> Installed Shuriken Studio? Kiln came with it: open it from the Start menu and skip to signing in.

## You need

- A Windows 10 or 11 PC (64-bit) with about 2 GB free. A graphics card helps: renders and bakes run on it.
- A Claude Pro or Max plan.

## Steps

### 1. Install Blender 5.2

Download Blender 5.2 LTS from blender.org and install it with the default options. Kiln finds it in Program Files by itself.

You never need to open Blender: Kiln runs it in the background.

### 2. Install Kiln

Download the installer from https://shuriken.studio/apps/kiln (or this repository's Releases) and run it.

The installer isn't code-signed yet, so Windows may show **Windows protected your PC**: choose **More info**, then **Run anyway**.

Keep the suggested folder or pick another. The installer adds Kiln to the Start menu and the Desktop.

### 3. Sign in to Claude

<!-- Kiln 0.9: one Claude login, the same as Shuriken's (this PC's Claude Code login). Signing in happens in Claude Code itself (claude /login); Settings → Claude login shows whether it is signed in. -->

TODO: copy (written separately).

### 4. Make your first model

Describe what you want, for example: "A low-poly wooden treasure chest with iron bands, ready for Roblox."

The copilot builds it in the background and the viewer updates as it goes. Orbit with the mouse, click a part to point at it, and ask for changes in the chat. Every change is a version you can undo.

Press **R** in the viewer to see it lit the way a Roblox game lights it.

### 5. Download it

Use the viewer's **Download** button for GLB, FBX, OBJ, STL or a .blend file. For Roblox, ask the copilot to make it Roblox-ready: plain materials, a triangle budget and one baked texture.

## Optional

- **With Shuriken Studio.** When Kiln is running, Shuriken Studio finds it and sends it model briefs, and Kiln can send a model straight into Roblox Studio.

## If something goes wrong

**Windows says "Windows protected your PC"**

The installer isn't code-signed yet. Choose More info, then Run anyway.

**The chat says "Blender not found"**

Install Blender 5.2 in its default folder and restart Kiln. Installed somewhere else? Put its path in %APPDATA%\Kiln\kiln.config.json as { "blender": "D:/Apps/Blender/blender.exe" }.

**"Not signed in" or a limit reached**

TODO: copy (written separately).

**Where are my models?**

In Documents\Kiln, one folder per project. Settings, logs and what the copilot remembers are in %APPDATA%\Kiln.

**How do updates work?**

TODO: copy (written separately). Kiln no longer updates itself: download each new version fresh.

**How do I uninstall it?**

Windows Settings → Apps → Installed apps → Kiln → Uninstall. Your projects and settings stay.

Still stuck? Open an issue in this repository.
