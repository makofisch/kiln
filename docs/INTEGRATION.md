# Driving Kiln from another app

Kiln's core is a small local HTTP service. Its own windows use it, and any local app can too, without
loading Kiln's UI. A game editor can, for example, model through Kiln while it is running: each model the
editor's agents build is a Kiln project the user can watch live, and every change comes back to the editor
as Roblox parts. Kiln was first built alongside one such companion app, Shuriken Studio, which is why some
identifiers below (`embed=shuriken`, a `linked.app` of "shuriken") carry its name; any app can use the API.

## Finding Kiln

While Kiln runs it writes `%APPDATA%\Kiln\runtime.json`:

```json
{ "app": "kiln", "version": "0.6.0", "port": 51052, "token": "…", "pid": 464, "api": "http://127.0.0.1:51052/api/v1",
  "exe": "C:\\…\\Kiln.exe", "embed": "http://127.0.0.1:51052/auth?t=…&next=/?embed=app" }
```

Once Kiln has been installed and started it also writes `%APPDATA%\Kiln\install.json`
(`{ app, version, exe, background: "--background", updatedAt }`), so another app can start it when it
isn't running: `Kiln.exe --background` runs Kiln with only a tray icon (no window) until the user opens
it. Kiln is single-instance: starting it again while it runs opens a window (or, with `--background`,
does nothing), never a second Kiln.

Since 0.8: `runtime.json` is removed when Kiln quits (a file that is there means a Kiln that is
running). `npm run dist` writes `install.json` for the release it just made, and an older Kiln never
overwrites a newer entry, so other apps always start the newest release. When a newer Kiln is started
while an older one (0.8 or later) runs, the older one finishes any running build, quits, and the newer
one starts in its place: the port and token change, so read `runtime.json` again when a call fails.
(A Kiln older than 0.8 can't step aside by itself: the newer one asks the user whether to close it.)

## Docking Kiln's UI in another app

`embed` in `runtime.json` is Kiln's own UI for a hosting app (replace `app` with its name, e.g.
`embed=shuriken`). Load it in a view of your window; `/auth` sets Kiln's session cookie and redirects,
so load it again whenever the port or token in `runtime.json` changes. Embedded, Kiln shows no tab strip:
the project list, a back button from a project to the list, and Kiln's settings. The same running Kiln
serves every view (its own windows and any embedded ones); nothing starts twice.

If the page has `window.kilnHost` (from the host's preload), Kiln adds the host's controls:

```ts
interface KilnHost {
  app: string;                                                   // "shuriken"
  useModel(kilnProjectId: string, name: string): Promise<{ ok: boolean; error?: string }>;  // "Use in Shuriken"
  dockState(): 'docked' | 'undocked';
  toggleDock(): void;                                            // move the view to its own window and back
}
```

While an embedded view or an API client is active, closing Kiln's last window keeps it running in the
tray.

Send `Authorization: Bearer <token>` on every request. The token changes each time Kiln starts, so read
the file again if a request returns 401. POST bodies must be `application/json`. Only `127.0.0.1`/`localhost`
Host headers are accepted.

## Endpoints (v1)

| Method | Path | What |
|---|---|---|
| GET | `/api/v1/app` | Version, settings, memory, Blender path, `login` (since 0.9, see "Claude login"), recent projects (each with `version` and `fingerprint` of its saved scene). Cheap: the project list is cached |
| GET | `/api/v1/projects?limit=&q=` | Every project, newest first (0.9): `{ total, matched, projects }`. `q` filters by title or id, `limit` defaults to 200 (at most 5000). From the cached list: no folder walk |
| GET | `/api/v1/login` | This PC's Claude login (0.9): `{ pc: { signedIn, email, plan, dir, checkedAt, usage }, last }`, see "Claude login" |
| POST | `/api/v1/login/check` | Ask Claude Code again who is signed in on this PC (no model call) → the same as `GET /api/v1/login` |
| GET | `/api/v1/helpers` | `{ version, text }`: the `kiln` helper library and craft rules as the copilot gets them (read this instead of probing signatures through `python`) |
| GET | `/api/v1/load` | `{ turns, open, gpu: { slots, busy, waiting, waitedMs } }`: copilot turns running, projects open, and the GPU gate (see "Many builds at once") |
| GET | `/api/v1/styles` · `/api/v1/styles/:id` | The games' style sheets (`{ styles: [{ id, title, materials, updatedAt }] }`) · one sheet, 404 until someone has saved it |
| POST | `/api/v1/styles/:id` `{ sheet }` | Save a style sheet yourself (see "A game's style sheet") → the cleaned sheet |
| GET | `/api/v1/storage` | `{ dir, projects: [{ id, title, updatedAt, open, working, linked, bytes, history, viewer, renders }] }`, biggest first |
| POST | `/api/v1/storage` `{ keep? }` | Free space in closed projects (undo steps beyond the last `keep`, default 3; old viewer files; older Roblox bakes; week-old trash) → `{ freed, projects }` |
| POST | `/api/v1/projects/:id/delete` `{ stop? }` | Move a project to `Documents\Kiln\.trash` (kept a week). Since 0.9 an open project is closed first: Kiln's windows showing it get a `deleted` event (`{ type: "deleted", projectId, title }`) and go back to their start page, and a project opened through the API closes like any other. While its copilot works it is a 409, unless `stop: true`: the turn is stopped, then the project deleted |
| POST | `/api/v1/projects` `{ text?, title?, units?, linked?, target?, lighting? }` | Create a project → meta (`id`). `title` names it at once; `units: "studs"` puts it in studs; `linked: { app, model, project }` says which app/model it belongs to (shown as a badge; its copilot session only starts if the user chats in it); `target` and `lighting`: see "Roblox target" |
| GET | `/api/v1/projects/:id/state` | Transcript, scene summary, Blender status, suggestions |
| GET | `/api/v1/projects/:id/events` | Server-sent events: messages, deltas, scene versions, suggestions… (Kiln's own windows use `ws://…/api/v1/ws?project=:id` instead) |
| POST | `/api/v1/projects/:id/chat` `{ text, images?, selected?, from?, kind?, effort?, mode?, spec?, style?, account? }` | Ask the copilot (returns immediately; poll `turns/:turnId`). From another app: a brief, see "Asking Kiln for a result". While a turn runs the message is never refused: `mode` says what happens to it. `account` (0.9): the Claude login the turn runs on, see "Claude login" |
| GET | `/api/v1/projects/:id/parts` | `{ models, fit }`: each top-level model (origin, size, triangles, materials, sockets) and how the declared socket pairings fit. Read only |
| POST | `/api/v1/projects/:id/stop` | Interrupt the copilot |
| POST | `/api/v1/projects/:id/python` `{ code, timeout_s?, undo_on_error? }` | Run Blender Python directly (no model, no usage) → output, errors, `changed`, `version`, scene totals, clash check. A change is saved as a new version and shown in Kiln's viewer. A script that fails part-way keeps what ran (and saves it) unless `undo_on_error: true`, which puts the scene back (`rolledBack: true`). `timeout_s` is clamped to 5–600. For inspection and an app's own plumbing: models, materials and clips of a Kiln project are built by asking the copilot |
| GET | `/api/v1/projects/:id/scene` | Scene summary (objects, dimensions, materials, bounds, world color, light count) |
| POST | `/api/v1/projects/:id/render` `{ views?, quality?, size?, focus?, isolate?, frames?, figure?, figure_height?, lighting? }` | Render views (`plan` = orthographic map) → `{ file, url, views, lighting, figure?, unknownFocus? }`; `isolate` hides everything but `focus`; names in `focus` that aren't in the scene come back in `unknownFocus`; beside a model too small for a person the figure is a labelled ruler (`figure` says which); `figure` stands a person of `figure_height` (default 1.8; 5.2 in studs projects) beside the subject. `quality: "pretty"` renders of a Roblox project are lit like the game (`lighting: "roblox"`); `lighting: "scene"` uses the scene's own lights |
| POST | `/api/v1/projects/:id/check` `{ fix? }` | Full z-fighting / floating / below-ground check (`zfight`, `zfight_pairs`, `zfight_rule`, see "No z-fighting"); `fix` moves z-fighting layers to the safe gap (a new version) and the reply lists what is left |
| POST | `/api/v1/projects/:id/undo` | Step back one version |
| POST | `/api/v1/projects/:id/import` `{ path }` | Replace the scene with a `.blend` file (a new version) |
| POST | `/api/v1/projects/:id/ext` `{ dir, module, func, args, timeout_s? }` | Run `func(**args)` from the Python module `dir/module.py` inside the project's Blender and return its dict (an app's own exporter can run this way); a scene change is saved |
| GET | `/api/v1/projects/:id/file` | `{ scene, version }`: the path of the project's current `.blend` |
| POST | `/api/v1/projects/:id/lock` `{ by, seconds }` | Another app is building this model: Kiln's own chat and undo on it wait (with a banner) until the lock expires or `seconds: 0` releases it; the app's own API calls go on |
| POST | `/api/v1/projects/:id/close` | Close the project (its Blender) if nobody watches or works in it → `{ closed }` |
| GET | `/api/v1/projects/:id/export/(glb\|fbx\|obj\|stl\|blend)` | Download the scene |
| POST | `/api/v1/projects/:id/target` `{ target, lighting? }` | Where the model ends up (`"roblox"` or `null`) and the game's lighting → meta with `roblox`, `lightingSummary`. Doesn't open the project |
| GET | `/api/v1/projects/:id/roblox` | `{ target, lighting, lightingSummary, check, export, current, version }`: what Roblox would lose (`check`), and the last baked export |
| POST | `/api/v1/projects/:id/roblox` `{ max_size?, density?, ao?, plain?, force? }` | Bake the Roblox export of the current scene → `{ ok, manifest, cached? }` (see "Roblox target" and "Maps") |

Opening a project over the API starts its Blender (from the warm pool). A project nobody watches closes
after five minutes without API calls; one open in a Kiln tab closes about 20 s after its tab goes.

## Claude login (0.9)

Kiln has one Claude login, and by default it is the same as Shuriken's. Kiln keeps no list of accounts, never
switches between logins, never moves a turn to another login at a usage limit, and has no sign-in of its own:
people sign in with Claude Code itself (`claude /login`).

Each turn runs on one login, chosen when the turn starts:

1. A chat call with a valid bearer token (another app, e.g. Shuriken) may send `account`:

   ```
   account: { kind: "pc" | "folder" | "api-key", dir?: string, apiKey?: string }
   ```

   - `{ kind: "pc" }`: this PC's own Claude Code login. Claude Code runs without `CLAUDE_CONFIG_DIR`, so it
     uses its default folder (`%USERPROFILE%\.claude`).
   - `{ kind: "folder", dir }`: the Claude Code config folder `dir` (an absolute path), as
     `CLAUDE_CONFIG_DIR`. A folder that doesn't exist, or (on Windows) has no `.credentials.json`, fails the
     turn at once with a message saying so, without starting Claude Code.
   - `{ kind: "api-key", apiKey }`: the turn runs with `ANTHROPIC_API_KEY = apiKey` (and no
     `CLAUDE_CONFIG_DIR`). The key is held in memory for that turn only: it is never written to disk, to
     `core.log`, to the conversation logs (`logs/conversations/*.jsonl` and `.md` record the turn's login by
     its label, "Shuriken's API key"), to the watchdog or to chat.json, and it never appears in a reply, a
     turn or an error message. When the turn ends Kiln drops the key and closes the session process that had
     it. Send it only over the local API with the bearer token; Kiln's own windows can't send `account`.
2. With no `account` field, and for every message typed in Kiln's own window, the turn runs on this PC's
   own Claude Code login (as `{ kind: "pc" }`).

A malformed `account` (an unknown `kind`, a relative or missing `dir`, a missing `apiKey`) is a 400 with a
plain `error`, which never repeats the key. With `mode: "interject"` a message joins the running turn and
keeps its login; a `queue`d message runs on the login its own `account` names when it starts.

The chat reply and `GET turns/:turnId` say which login a turn runs on and why, never the key:
`account: { kind, dir?, label, why }`, e.g.
`{ kind: "folder", dir: "…\\accounts\\acct_1", label: "Shuriken's login (acct_1)", why: "the brief asked for this login folder" }`
or `{ kind: "pc", label: "This PC's Claude login", why: "the brief named no login: this PC's own" }`.

A conversation moves with its login: Claude Code keeps sessions per config folder, so when a turn runs on
another folder than the one before, Kiln copies the session's transcript there first (or starts the
conversation afresh when it can't).

When Claude refuses the login (not signed in, a revoked token, an invalid key, no credits) or it reaches a
usage limit, the turn fails with a message that says which login and what to do; Kiln does not try another.

`login` in `GET /api/v1/app` (and `GET /api/v1/login`, and the `login` event to Kiln's windows):
`{ pc: { signedIn, email, plan, dir, checkedAt, usage }, last: { kind, dir?, label, why, at } | null }`.
`pc` is this PC's own login (`usage`: the 5-hour and weekly windows seen on turns that ran on it); `last` is
the login the latest turn started on.

## Example: a game editor on top of Kiln

One way to build an app's modeling on these endpoints (this is how the first companion app does it):

- A model is a Kiln project created with `title`, `units: "studs"` and `linked`; the app keeps the link
  (the Kiln project id) with its own project. If the Kiln project is gone, a new one is created and
  seeded from the app's own copy of the model's `.blend` with `import`.
- The app asks Kiln's copilot for models, materials, rigs and clips with briefs (see "Asking Kiln for a
  result") instead of sending its own Blender Python. After a change, it bakes the Roblox export
  (`POST roblox`) and converts the baked `.blend` into the game's parts with its own exporter.
- `render` (with a 5.2-stud figure), `check` and `undo` map one to one. Each step refreshes a `lock`; the
  run's end releases it. To keep the number of open models down, the longest-idle model is `close`d. If
  the app's own Blender changed a model while Kiln was away, the newer `.blend` is `import`ed first.
- Rigged models and their clips: see "Rigs and animation" below. The exporter reads them only through
  `kiln.rig.info()`, `kiln.anim.clips()` and `kiln.anim.sample()` (from the helpers in `blender/`) and owns
  the conversion to Roblox (axes, Motor6D/Bone rigs, KeyframeSequences).
- When Kiln isn't running, the same models can carry on in the app's own Blender from that `.blend`.

Units: Kiln projects are in meters, Z up; linked Roblox models are in studs (1 stud ≈ 0.28 m), Z up in
Blender, turned Y up by the Roblox export.

## Asking Kiln for a result (0.7.3)

Kiln's copilot knows how to build in Kiln; another app's assistant knows what its project needs. So the
other app sends a brief and reads the result, and never prescribes the method.

`POST /api/v1/projects/:id/chat` `{ text, from, kind?, effort?, images?, account? }` -> `{ ok, turnId, effort, effortWhy, mode, account }`

- `from`: who is asking (`"Shuriken"`). Kiln's chat shows "via ..." with the kind and effort, and the
  copilot is told: the goals and the constraints the game depends on are fixed; research, modeling
  approach, materials, rig and animation technique are its own call; a prescribed method that would give
  a worse result is replaced, and the reply says so.
- `kind`: `"new"` (a new build: the copilot researches first only when the subject is a specific existing
  thing whose exact look matters, such as a creature from a film; never for an everyday object, and names
  used as style comparisons, "Red Bull style", are not looked up),
  `"rework"`, `"fix"` (change only what is needed; attach screenshots from the game) or `"animate"`.
- `effort`: optional. Leave it out (or send `"auto"`) and Kiln sizes it to the job (since 0.8.4): a small
  still prop runs at `medium` (a `spec.tris` of 3,000 or less, or a prop described as simple, or as not
  rigged), an ordinary new build at `high` (also the cap for a still model with `spec.tris` up to
  10,000), a complex subject or a rigged, animated one at `xhigh`, and `max` takes three signals (detailed,
  a subject from a named work, a complex subject, rig and animation) or a brief that asks for the best
  (`src/shared/effort.ts`; the reply's `effortWhy` says what decided it). The length of a brief and the
  names in it (the game, style comparisons) no longer count. Or choose it yourself, `medium` to `max`.
  Nothing from another app runs at `low`. The user's own messages use the user's Effort setting.
  Send `spec.tris` on every brief: it is the clearest sign of the job's size.
- `text`: prose goals. What it is, what it is for in the game, how it is seen (distance, camera), the
  mood, and the must-haves the game code depends on: clip names, loops, markers, sizes. No joint angles,
  gait parameters, frame lists or texture values.
- `images`: `[{ name, dataUrl }]`, e.g. screenshots of the model in the game for a `fix`.
- `account` (0.9): `{ kind: "pc" | "folder" | "api-key", dir?, apiKey? }`, the Claude login this turn runs
  on (send the one your own runs use). Leave it out and the turn runs on this PC's own login. The reply's
  `account` says which login the turn got and why. See "Claude login".

### While a turn is running (0.8.2)

A chat POST to a project whose copilot is working is no longer a 409. `mode` chooses:

- `"interject"` (the default): the message joins the running turn. The copilot reads it at its next tool
  boundary (seconds; at most the length of the Blender script already running) and re-plans: nothing is
  restarted, nothing already right is thrown away. The reply's `turnId` is the running turn's id; the
  turn ends with one result that covers both messages. Use it to correct course or add a requirement.
  `kind`, `effort`, `spec` and `style` of an interjection are ignored (the turn keeps its own).
- `"queue"`: the message waits and starts as its own turn when the running one ends. The reply's `turnId`
  is the new turn's; its `state` is `"queued"` until it starts. Stop drops queued messages
  (`state: "stopped"`). Use it for follow-on work.
- `"replace"`: the running turn is stopped, then this message starts a new turn. Work since the last
  saved version is lost. Use it when the running build is aimed at the wrong thing entirely.

The reply is `{ ok, turnId, effort, effortWhy, mode, account }` with `mode` = what was applied: `"new"` when
nothing was running, else `"interject"`, `"queue"` or `"replace"`.

### Quick builds (0.8.4)

`quick: true` on a brief asks for a build in a couple of minutes: one build call, one fast look, one fix,
stop. No research, no reference images, no pretty renders, no plan, no polishing. Auto effort is capped at
`medium` for it (send `effort` yourself to choose otherwise, `low` included). Use it for simple props,
blocky or low-poly pieces and set dressing; send several at once and keep the best if you want a choice.
What makes a build long, so leave it out of a quick brief: `spec` fields beyond a rough `tris`, sockets
(each pairing is built, checked and test-assembled), must-have lists (each item gets verified), the words
"detailed", "accurate" or "hero", and a `kind: "new"` brief that names a work to match (research).

### Requirements as data (0.8.2)

`spec` on a brief states what the result must satisfy; the copilot is told, and each is checked when the
turn ends (`delivery.checks`: `[{ name, ok, detail }]`):

`{ tris?: number, tris_total?: number, size?: [x, y, z] (null = any; within 20%), height?: number (within 15%), ground?: true, sockets?: ["Name", …], parts?: ["Name", …] }`

`tris` is the budget of each top-level model (0.8.7; the whole result when it is one model): a set of ten
props with `tris: 4000` may use 4,000 each. `tris_total` caps all models together.
`ground` means every model's lowest point is at z = 0. `sockets` are names that must exist. When the scene
declares socket pairings, a `fit` check is added whether or not the brief asked. Since 0.9 every delivery also
has a `zfight` check (see "No z-fighting" below).

### No z-fighting (0.9)

<!-- TODO: copy (written separately): why the gap is what it is, and what the copilot does about it. -->

The contract:

- `zfight_rule` (in `POST check` and in `python`'s automatic check): `{ gap, per_width, cap, flush, units, roblox }`,
  the safe distance between two overlapping surfaces that face the same way, in the project's units. Roblox
  projects: `gap` 0.02 studs, plus `per_width` (0.4%) of the layer's width, at most `cap` 0.1 studs. Other
  projects: 2 mm, plus 0.2% of the width, at most 1 cm.
- Where it is checked: after every `python` / `run_python` change (scenes under 400k triangles), in
  `kiln.game_ready`, in `kiln.zfight(objs=None, fix=False)`, in `POST check`, and once more when a turn that
  changed the scene ends: if any pair is left, the copilot is sent back once, in the same turn, to fix it.
- `fix: true` (and `kiln.zfight(fix=True)`) pushes the smaller part's face out to the gap, sinks a part that is
  behind, deletes duplicate faces inside a mesh and lifts a loose part layered inside a mesh; what it could not
  fix is still listed.
- `zfight` entries: `{ a, b, inside, faces, sep, gap, kind: "flush" | "layer", where, normal, front }`
  (`inside`: two layers inside one mesh, `a` = `b`).
- Every delivery of a turn with a scene has `{ name: "zfight", ok, detail }` in `delivery.checks`.

Placing the model in the game (against the place's own parts) is the other app's job; inside the model is Kiln's.

### A game's style sheet (0.8.2)

`style: "<id>"` on a brief ties the project to a game's style sheet (the project keeps it for later
briefs). If the sheet exists the copilot follows it: palette, materials by name, bevel, texel density,
wear, triangle budgets. If it doesn't, the copilot of that first build proposes one when its look is
settled and saves it under the id; `GET /api/v1/styles/:id` returns it from then on, and every later
brief with the same `style` follows it. You can also write one yourself with `POST /api/v1/styles/:id`.

`{ id, title?, palette: ["#rrggbb"], materials: [{ name, color, roughness?, metallic?, roblox_material?, emission?, use? }], bevel?, texel_density?, budgets?: { hero, prop, dressing, … }, wear?, notes?, units?, from?, updatedAt }`

### Reading a turn

`GET /api/v1/projects/:id/turns/:turnId` -> `{ state, reply, clips, from, kind, effort, effortWhy, account, spec, style, progress, delivery }`.
`state` is `"queued"`, then `"running"` until the result's facts are in, then `"done"`, `"failed"` or
`"stopped"`. While running, `progress` =
`{ steps: { done, total } | null, current, tool, tools, lastRender, elapsedMs, etaMs, interjections }`:
the copilot's plan (null when it made none for a small job), the step and the tool call in progress, tool
calls finished, the newest render's URL, and a rough time left (elapsed per finished step; null until one
step is done). `delivery` =
`{ size: [x, y, z], units, objects, tris, joints, clips: [{ name, length, loop, in_place, speed, turn?, priority, markers: [{ name, time }] }], renders: [urls] }`:
plus, since 0.8.2, `models`, `fit` and `checks` (see "Models, sockets and fit").
Read sizes, ground speeds and marker times here (or from `anim`) instead of prescribing them. `turn`
(degrees per second, positive to the model's left) is on turning gaits ("TurnLeft", a curving walk):
the clip stays in place, and the game turns the model at that rate while it plays.

`python` and `clips` (`generate`, `regenerate`) stay available for inspection and for the user's own
Animate panel. An app that models, retextures or retunes a Kiln project through them bypasses the
copilot's research, craft rules and checks.

## Roblox target (0.7.3)

A project counts as built for Roblox when its `target` is `"roblox"`, or (with no `target`) when it is in
studs or linked to an app whose `linked.app` names Shuriken; `target: null` turns that off. Set it when creating the project, or with
`POST .../target`. `lighting` is the place's Lighting straight from Studio (Color3 as `[r, g, b]` 0–1):

`{ brightness, ambient, outdoorAmbient, clockTime, latitude, envDiffuse, envSpecular, exposure, atmosphere: { density, offset, haze, glare, color, decay } | null, bloom: { intensity, size, threshold } | null, colorCorrection: { brightness, contrast, saturation, tint } | null }`

Every field is optional (a new place's defaults fill in); send it again when the place's Lighting changes.

What a Roblox project changes in Kiln:

- The copilot follows its "Roblox target" rules: plain PBR only (no coat, sheen, subsurface, transmission
  or alpha), metalness 0 or 1, roughness floors, value contrast, glow as its own emissive material,
  budgets (materials, triangles per part, joints), rigid rigs (no skinning).
- Previews are honest: the viewer (the globe button, R) and the copilot's `pretty` renders are lit like the
  place (sun from `clockTime` and `latitude`, sky, flat ambient light, no ambient occlusion) and show
  materials as Roblox would. `blender/kiln_roblox.py` and `src/shared/roblox.ts` hold the same numbers.
- `check_scene` (and `GET .../roblox`) lists what Roblox would lose: `check.problems` and `check.notes`.

The export: `POST .../roblox` bakes a copy of the scene in a separate Blender (the project's own Blender
and scene are untouched) into `exports/roblox-v<version>/`:

- `roblox.blend`: every mesh final (modifiers applied, scale applied), one UV layer `RobloxUV`, and each
  material rebuilt as image textures into a Principled BSDF: Base Color, Roughness, Metallic, Normal
  (through a Normal Map node, OpenGL +Y) and Emission Color, where the material has them; constant
  roughness and metalness stay as values. The rig, its bindings and its clips are unchanged. Images are
  packed.
- One atlas per material, up to 1024 px, shared by every part that uses the material, with unique UVs
  and ambient occlusion multiplied into the colour. Procedural nodes are baked; a coat is folded into
  roughness. `<Material>.color.png`, `.normal.png`, `.roughness.png`, `.metalness.png`, `.emissive.png`.
- Material custom properties: `roblox_emissive_tint` (`"#rrggbb"`, with `Emission Strength` as the
  strength and the emissive image as the mask) and `roblox_transparency` (0–1, when the source material
  was see-through).
- `roblox.json`, also returned as `manifest` (version 2 since 0.8):
  `{ version, plain, blend, units, studs_per_unit, source_version, source_fingerprint, uv, ao, materials: [{ name, plain, color, roblox_material, size, maps, roughness, metallic, emissive_strength, emissive_tint, transparency, area, texels_per_unit, atlas_use, tris, objects }], objects, tris, meshes, roles, colliders, pieces, placements, mirrored_placements, markers, paths, models, fit, joints, clips, device, seconds }`.

An export of the current scene is reused (`cached: true`) unless `force` or a different `plain`.

**Plain colours are the default since 0.8.7.** `plain` is true unless the request sends `plain: false`:
one-colour materials arrive untextured (`plain: true`, `color: "#rrggbb"`, `maps: {}`, no image file, no
baked occlusion), a one-colour glowing material gets `roblox_material: "Neon"` (with `emissive_strength` and
`emissive_tint` as before), and a `kiln.flat` palette is split into one plain material per colour,
`<palette>_<hex>` (e.g. `Palette_e8c39e`; `_r<roughness>` added when one colour comes in two roughnesses).
Materials with an image or procedural nodes are still baked as below. `plain: false` bakes every material,
occlusion included, as before 0.8.7.
"Current" is judged by `source_fingerprint` (version numbers repeat after an Undo; `current` in
`GET .../roblox` says whether the last export matches the scene as it is now). A model takes about
10–30 s on a GPU; a 1,400-object map about 80 s. 409 while the copilot works.

Since 0.8 the export also:

- keeps shared meshes shared. `meshes` = `{ "<mesh name>": { objects: [names], tris } }`: the objects
  under one entry use the same mesh datablock in `roblox.blend` (their scale stays on the object;
  a mirrored copy gets its own mesh). Upload each mesh once and clone the part.
- leaves some materials untextured. With `plain` (the default since 0.8.7), a material with nothing plugged into its
  Principled inputs gets no atlas: `plain: true`, `color: "#rrggbb"`, `maps: {}`, `size: 0`, and
  `roughness` / `metallic` / `transparency` as numbers. A material with a `roblox_material` hint
  (`kiln.roblox.surface(material, "Asphalt")`, stored as the material's custom property
  `roblox_material`) is always plain: use that Enum.Material name tinted with `color`. Materials also
  carry `roblox_color` as a custom property.
- sizes each atlas from the measured UV fill, keeps every source UV layer during the bake (materials
  that name a UV map bake correctly), bakes procedural textures with each part's own Generated and
  Object coordinates, and keeps a painted emission strength in the emissive image.
- the check (`GET .../roblox`) adds `meshes` (unique count) and `layout` (counts of pieces,
  placements, markers, paths, roles, colliders), and reports parts over 2,048 studs or 20,000
  triangles and mirrored placements as problems.

## Content Roblox removes (0.8.3)

Roblox moderation removes images that point off the platform, and counts it against the uploader: QR
codes above all, also web addresses, social handles, other platforms' names and logos, phone numbers,
email addresses and real brand marks. In a Roblox project Kiln's copilot is told never to paint any of
these (a pay panel gets a contactless icon), lookalikes included.

As a second net, a true QR code (three finder patterns in the standard 1:1:3:1:1 ratio at three corners
of a square, dark on light or light on dark, at any rotation) is reported:

- `check.problems` (`GET .../roblox`, and the copilot's `check_scene`) names the source image and material;
- the manifest's `content_problems`: `[{ material, map, problem }]` for baked `color` and `emissive`
  atlases. Don't upload a map listed there.

It does not catch a painted lookalike whose corner marks aren't in that ratio (a decorative "code" on a
vending machine's pay panel, say), nor a code baked with modules under about 2 px. An uploading app can
add its own check that judges appearance instead (a square patch of dense, non-repeating black and white),
so the two nets cover different ground; the rule in the copilot's instructions comes first.

## Models, sockets and fit (0.8.2)

A model is a top-level object with everything parented under it. Variants of one thing (three torsos) and
the parts of a kit are separate models in one project, laid out side by side; each becomes its own model
in the game. `delivery.models`, `GET .../parts` and the manifest's `models` all carry, per model:

`{ name, objects: [mesh names], origin: [x, y, z], origin_at, min, max, size, ground_gap, tris, materials: [{ name, color, roblox_material }], sockets: [{ name, mates, position, facing, matrix }], rigged }`

- `origin` is the root object's world position (scene units, Blender axes); `origin_at` says what it
  coincides with: `"bottom_centre"`, `"centre"`, `"socket:<name>"` or `"elsewhere"`. Export each model
  about its origin.
- `ground_gap` is how far the model's lowest point is above z = 0 (negative: sunk into the ground).
- `objects` are the model's meshes in `roblox.blend` (group the manifest's `meshes` by them).
- `parts` are the pieces the game's code moves or finds by name (0.8.5): `[{ name, object, parent, objects, pivot }]` (`parent`, since 0.8.6: the named part it sits under, or null),
  from objects carrying the custom property `kiln_part` (set with `kiln.part(obj, "Door")`). `object` is
  the marked object, `objects` its meshes (its own and those parented under it), `pivot` its origin in the
  model's space. In `roblox.blend` the property is on the object and is found by walking up `parent`;
  the bake never merges or re-parents objects, so marked parts stay separate. A brief can require them:
  `spec.parts: ["Door", "Display"]` adds a `parts` check to the delivery.
- A socket is a named attachment frame on a part, made with `kiln.socket`. `position`, `facing` and the
  4x4 `matrix` are in the model's own space (relative to its origin). `facing` is the socket's +Y: the
  direction from the carrying part toward the carried part, on both parts, so two mating sockets have the
  same world frame once assembled (line the two Attachments up exactly). `mates` are the socket names it
  joins on other models.
- `fit` = `{ ok, summary, pairs: [{ parent, socket, child, mate, ok, gap, buried, problem }], unpaired }`:
  every declared pairing, checked by placing the child's socket on the parent's. `gap` is the open
  distance between the two surfaces at the joint (0 when they touch or overlap), `buried` the share of
  the child's joint end inside the parent. A pairing fails on a gap, on a socket that floats off its own
  part, or on a child swallowed by its parent.

Rigged models keep their attachment points in `kiln.rig.info().attachments` as before.

## Many builds at once (0.8.2)

Kiln starts every brief at once and does not queue turns. What it does limit is simultaneous GPU work:
a pretty render or a Roblox bake takes about 1 GB of video memory while it runs (and keeps about 50 MB
afterwards), so at most 3 run at the same moment across all projects (`KILN_GPU_SLOTS`); the others wait
their turn, usually seconds. Twelve at once froze an 8 GB card; eight just survived. `GET /api/v1/load`
shows the gate: `gpu.waiting` above 0 for long, or `waitedMs` climbing fast, means builds are queuing for
the GPU and more parallel builds will not finish sooner.

## Maps (0.8)

A map is a layout project (ground, road, one-off buildings) that places pieces built in their own
projects. The copilot uses `kiln.piece("<project id>")` to bring another project's model in and
`kiln.place` / `kiln.scatter` to place it; in Blender a placement is an empty instancing the collection
`Piece_<name>`, so a thousand trees cost one tree. The Roblox export does not bake placements: it lists
them, and the exporting app clones the piece's own export (it already has one, from the piece's project).

In the manifest (scene units, Blender axes, Z up; multiply lengths by `studs_per_unit`):

- `pieces`: `{ "<piece name>": { project, version, fingerprint, tris, placements, stale } }`. `version`
  and `fingerprint` are the piece project's when it was brought in (compare with the project's meta, or
  with the `source_fingerprint` of the export you uploaded); `stale` = that project has changed since.
- `placements`: `[{ name, piece, project, matrix, role? }]`. `matrix` is the 4x4 row-major world
  transform. Flat: a piece can't contain placed pieces. Non-uniform scale is allowed; mirroring is
  refused by `kiln.place`, and any mirrored placement that gets in another way is listed in
  `mirrored_placements` and reported by the check.
- `markers`: `[{ name, role, matrix }]` from `kiln.marker`: `spawn`, `start_grid`, `checkpoint`,
  `camera`, or any word the game uses. The marker's +Y is its facing.
- `paths`: `[{ name, role, points: [[x, y, z], …], width, closed }]`. Every `kiln.path` road carries its
  centre line (`role: "road_centerline"`); `kiln.track` adds hand-made lines.
- `roles`: `{ object: "drivable" | "ground" | "barrier" | "decor" }` from `kiln.role` (also the custom
  property `kiln_role` on the object in `roblox.blend`).
- `colliders`: `[{ name, stands_for }]`: meshes with role `collider` stay in `roblox.blend` (hidden
  from render, not baked, not in `meshes`) as simple collision shapes for the part named.

Queueing is the caller's: one brief starts one turn at once, each open project is one Blender, and
every Blender renders on the same GPU. Cap your parallel builds (6 is a sensible default).

## Rigs and animation (0.7)

A rig is one armature object `Rig` whose bones are the joints (names: letters, digits, underscore). Rigid
parts are bone-parented meshes (`kiln_segment`); flesh is skinned (an Armature modifier, at most 4
influences per vertex, `kiln_skinned`). A clip is one Blender Action on the rig, named after the clip,
with `action["kiln_clip"]` = JSON `{loop, in_place, priority, speed, fade, generator, resolved}` and its
events as pose markers. 30 fps. Models face -Y, up is +Z, the character's right is -X.

Python (inside Kiln's Blender, or any Blender with the Kiln helpers):

- `kiln.rig.info()` -> `{joints: [{name, parent, kind, axis, limits, pivot, tail, rest}], segments, skinned: [{mesh, joints}], legs, ik, attachments, forward}`
  (Blender world space, the project's units; `rest` is the 4x4 world rest matrix).
- `kiln.anim.clips()` -> `[{name, frames: [start, end], fps, length, loop, in_place, priority, speed, fade, markers: [{name, frame, time}], generator, params, resolved}]`.
  `speed` is the units per second the feet travel (move the model at this speed for in-place clips).
- `kiln.anim.sample(clip, fps=30)` -> `{joint: [[qw, qx, qy, qz, tx, ty, tz] per sample]}`: each joint's
  rotation relative to its parent and its rest pose, in world-aligned axes at its pivot, and its
  pivot's offset. With bone motion `G = pose.matrix · rest⁻¹`: rotation = rot(G_parent⁻¹ · G_joint),
  offset = (G_parent⁻¹ · G_joint)(head₀) − head₀. After the axis change this is a Roblox
  `Motor6D.Transform` (for `Bone.Transform`, express it in the bone's rest frame).

HTTP (bearer token):

- `GET /api/v1/projects/:id/anim` -> `{open: false}` for a closed project, else `{open: true, working, version, anim, clips, current, clipsUrl}`
  from memory: never opens a project and never calls Blender, so it's the one to poll (`GET .../scene`
  opens the project and rescans it in Blender).
- `GET /api/v1/projects/:id/clips` -> `kiln.anim.clips()`.
- `GET /api/v1/projects/:id/rig` -> `{info, clips, check}` (`check`: `{ok, issues: [...]}` from `kiln.rig.check()`).
- `POST /api/v1/projects/:id/clips/:name` with `{action}`:
  `"check"` (read only: the frame-by-frame report `{summary, issues, feet, ground, collisions, ...}`),
  `"generate"` + `generator` (`gait`, `idle`, `attack`, `hit`, `death`) + `params`, `"regenerate"` + `params`,
  `"settings"` + `settings` (`loop`, `in_place`, `priority`, `speed`, `fade`), `"rename"` + `to`, `"delete"`, `"use"`.
  Changes are new undoable versions; 409 while the copilot works.
- `POST /api/v1/projects/:id/chat` and `GET /api/v1/projects/:id/turns/:turnId`: see "Asking Kiln for a
  result" (`clips` in a turn: the clips added or changed during it).

Live events (project WebSocket or event stream): `{type: "turn", turn}` when a turn ends; `{type: "clips",
clips, url}` whenever the rig's clips change; each `scene` carries `summary.rig` (joints, clips with a
per-clip fingerprint `fp`, the clip showing) and `clips`, the URL of every clip sampled for the viewer
(the same data as `sample()`).

The Kiln UI calls `kilnHost.sendToStudio({kind: "model" | "animation", projectId, name, clip?})` when the
host provides it (Send to Studio in the Animate panel, "To Studio" in the chat header).
