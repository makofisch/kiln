# Contributing to Kiln

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with:

- what you did, what you expected, and what happened;
- your Kiln version (Settings → About), Windows version and Blender version;
- the relevant lines of `%APPDATA%\Kiln\logs\core.log`, and the project's conversation log
  (`%APPDATA%\Kiln\logs\conversations\<project>.md`) if the copilot was involved.

Logs and conversations can contain your prompts, file paths and your Claude account's email address. Read them
and remove anything private before you post them.

## Setting up

Windows, Node.js 24 LTS, Git, and Blender 5.2 to try changes end to end:

```powershell
npm ci
npm run dev        # Electron with a hot-reloading UI; main and core restart on change
```

Point `KILN_DATA_DIR` and `KILN_PROJECTS_DIR` at a scratch folder so experiments don't touch your own projects.

## Before you open a pull request

- `npm run typecheck` passes, `npm test` passes, and `npm run build` succeeds. `npm run smoke` runs a dev core on
  throwaway data (no model calls; it needs Blender), and `blender -b --factory-startup --python scripts/test-zfight.py`
  checks the z-fighting check in headless Blender.
- You tried the change in the app. For UI and window changes, `npx electron . --smoke <dir>` writes screenshots
  of the real windows without calling the model.
- Changes to the `kiln` Python helpers keep working in Blender 5.2 headless (`blender -b`), and their
  descriptions in `src/core/prompts.ts` match what the code does: that text is what the copilot reads.
- Changes to the local API are written up in [docs/INTEGRATION.md](docs/INTEGRATION.md).
- Keep pull requests focused on one thing, and describe what changed and how you checked it.
- Never commit API keys, tokens, logins, logs, conversations or project files.

## Style

- TypeScript is strict (`tsconfig.json`); the code runs with Node's type stripping, so stick to erasable syntax
  (no enums, namespaces or parameter properties).
- Match the code around you: small functions, comments that say why, plain names.
- Python in `blender/` targets the Blender 5 API and NumPy only (Blender ships no SciPy or Pillow).

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
