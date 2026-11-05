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

Kiln uses this PC's Claude Code login, the same one Shuriken Studio uses by default. It has no sign-in of its own and never sees your password.

- **Have Shuriken Studio?** Sign in there: Settings → Claude login → This PC's Claude login → **Sign in**.
- **Otherwise** install Claude Code (https://code.claude.com/docs/en/setup), open a terminal, run `claude` and follow the sign-in prompts.

Then click the Kiln logo (or press **Ctrl+,**) and open **Claude login**: it shows your email and plan. If it still says Not signed in, press **Check again**.

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

Install Blender 5.2 in its default folder: Kiln finds it within a few seconds, with no restart. Installed somewhere else? Put its path in %APPDATA%\Kiln\kiln.config.json as { "blender": "D:/Apps/Blender/blender.exe" }.

**"Not signed in" or a limit reached**

Kiln logo → Claude login shows whether this PC's Claude Code login is signed in, and its 5-hour and weekly usage. Not signed in? Sign in as in step 3, then press Check again. At a limit, the copilot stops and says so: wait for the reset.

**How do I delete a project?**

Press the trash icon on its card on the start page, or use All projects, a tab's right-click menu, or Settings → Data & logs. It moves to Documents\Kiln\.trash.

**Where are my models?**

In Documents\Kiln, one folder per project. Settings, logs and what the copilot remembers are in %APPDATA%\Kiln.

**How do updates work?**

Kiln doesn't update itself. Download the newest installer from https://shuriken.studio/apps/kiln (or this repository's Releases) and run it over the one you have: your projects and settings stay.

**How do I uninstall it?**

Windows Settings → Apps → Installed apps → Kiln → Uninstall. Your projects and settings stay.

Still stuck? Open an issue in this repository.
