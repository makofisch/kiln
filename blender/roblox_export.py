"""
Kiln's Roblox export, run in its own Blender on a COPY of a project's scene (it rewrites the meshes and
materials, see kiln_roblox.export):

  blender -b <copy of scene.blend> --python roblox_export.py -- <options.json>

options.json: {"out": "<dir>", "name": "roblox", "units": "studs", "max_size": 1024, "ao": true, ...}.
Prints progress lines and, last, one line "@@KILN {json}" with {"ok": true, "manifest": {...}} or
{"ok": false, "error": "..."}.
"""

import json
import os
import sys
import traceback

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    try:
        args = sys.argv[sys.argv.index("--") + 1:]
        with open(args[0], encoding="utf-8") as f:
            req = json.load(f)
        import kiln  # noqa: F401  (the rig and clip helpers)
        import kiln_roblox
        manifest = kiln_roblox.export(
            req["out"], name=req.get("name", "roblox"), max_size=int(req.get("max_size", 1024)), density=req.get("density"),
            ao=req.get("ao", True), ao_strength=float(req.get("ao_strength", 0.8)), ao_samples=int(req.get("ao_samples", 48)),
            units=req.get("units", "studs"), source_version=req.get("source_version"), plain=req.get("plain") is not False, log=lambda s: print("[roblox] %s" % s, flush=True))
        reply = {"ok": True, "manifest": manifest}
    except Exception as e:  # noqa: BLE001
        reply = {"ok": False, "error": "%s: %s" % (type(e).__name__, e), "trace": traceback.format_exc()[-1500:]}
    print("@@KILN " + json.dumps(reply), flush=True)


main()
