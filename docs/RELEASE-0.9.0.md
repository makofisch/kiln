# Kiln 0.9.0

## Delete projects from anywhere

- A trash icon on each start page card, a full project list under **All projects** (filter, select several, delete), **Delete project…** in a tab's right-click menu, and Settings → Data & logs.
- Open, working and Shuriken-opened projects can be deleted too. A working copilot stops first, and every window showing the project goes back to its start page.
- Deleted projects move to `Documents\Kiln\.trash`, not the Windows Recycle Bin. If Shuriken Studio used the model, it makes a new one the next time it needs it.

## No z-fighting

- Kiln checks for overlapping surfaces that would flicker after every change, in `kiln.game_ready`, and once more when a turn that changed the scene ends. If anything is left, the copilot is sent back once, in the same turn, to fix it.
- The check now catches near-flush layers, not only exactly coplanar faces, and layers inside a single mesh. The safe gap depends on where the model will be shown: see "No z-fighting" in [INTEGRATION.md](INTEGRATION.md).
- Every delivery has a `zfight` check.

## Signing in to Claude

- Kiln runs on this PC's Claude Code login, the same one Shuriken Studio uses by default.
- A brief from another app can name the login its turn runs on (the `account` field); everything typed in Kiln runs on this PC's login.
- Settings → Claude login shows whether it's signed in, with **Check again**. Kiln has no sign-in of its own: sign in through Claude Code, or in Shuriken Studio.

## No automatic updates

Kiln no longer checks for or downloads updates. To get a newer version, download its installer and run it over the old one: your projects and settings stay.

## Also

- Kiln stays responsive with many projects: the project list is cached instead of read from disk on every request.
