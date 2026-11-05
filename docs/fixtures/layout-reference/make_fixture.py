"""
Builds Kiln's reference layout: a tiny map with known answers, for anyone writing an importer of the
Roblox manifest (placements, markers, paths, roles, colliders, shared meshes).

  blender -b --factory-startup --python make_fixture.py -- <out dir>

Writes into <out dir>:
  roblox.json     the manifest exactly as POST /projects/:id/roblox returns it (plain: true)
  roblox.blend    the baked scene the manifest describes
  expected.json   the answers: where reference points of each placed piece, marker and path end up

Everything is in scene units (studs here) and Blender axes: X right, Y back (models face -Y), Z up.
A matrix is 4x4, row-major: world = matrix @ (x, y, z, 1).
"""
import json
import os
import shutil
import sys
import tempfile

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "..", "..", "blender")))
import kiln  # noqa: E402
import kiln_roblox  # noqa: E402

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1])
os.makedirs(out, exist_ok=True)
root = tempfile.mkdtemp(prefix="kiln-fixture-")

# Reference points of every piece, in the piece's own space: its origin, 1 unit along each axis.
POINTS = {"origin": (0, 0, 0), "x1": (1, 0, 0), "y1": (0, 1, 0), "z1": (0, 0, 1)}


def new_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene["kiln_units"] = "studs"


def box(name, lo, hi, color):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector(((lo[i] + hi[i]) / 2 + v.co[i] * (hi[i] - lo[i]) for i in range(3)))
    ob = kiln.mesh_object(name, bm)
    kiln.paint(ob, kiln.mat(name + "_Mat", color, roughness=0.7))
    return ob


def piece_project(pid, title, build):
    """A piece's own project: asymmetric on purpose, so a wrong rotation or a swapped axis shows."""
    new_scene()
    build()
    folder = os.path.join(root, pid)
    os.makedirs(folder)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(folder, "scene.blend"), copy=True, check_existing=False)
    with open(os.path.join(folder, "project.json"), "w", encoding="utf-8") as f:
        json.dump({"id": pid, "title": title, "units": "studs", "version": 1, "fingerprint": "fixture-" + pid}, f)


# An arrow lying along +X with a fin along +Y and a post along +Z: origin at its tail, on the ground.
piece_project("fixture-arrow", "Arrow", lambda: (box("Arrow_Shaft", (0, -0.25, 0), (3, 0.25, 0.5), "#d04020"), box("Arrow_Fin", (0, 0.25, 0), (0.5, 1.25, 0.5), "#d04020"), box("Arrow_Post", (0, -0.25, 0.5), (0.5, 0.25, 2), "#d04020")))
# A pillar 1 x 1 x 4 with a step on its -Y side (its front).
piece_project("fixture-pillar", "Pillar", lambda: (box("Pillar_Body", (-0.5, -0.5, 0), (0.5, 0.5, 4), "#3060c0"), box("Pillar_Step", (-0.5, -1.5, 0), (0.5, -0.5, 1), "#3060c0")))
# A slab 4 x 2 x 0.5, origin at one corner.
piece_project("fixture-slab", "Slab", lambda: box("Slab", (0, 0, 0), (4, 2, 0.5), "#40a050"))

# The layout project.
new_scene()
layout_dir = os.path.join(root, "fixture-layout")
os.makedirs(layout_dir)
kiln.PROJECT_DIR = layout_dir
ground = box("Ground", (-30, -20, -1), (30, 20, 0), "#55585c")
kiln.roblox.surface(ground.data.materials[0], "Asphalt")
kiln.role(ground, "drivable")
wall = box("Wall_North", (-30, 20, 0), (30, 21, 3), "#b0b0b0")
wall2 = wall.copy()  # a second object sharing the same mesh, mirrored to the south side by position only
wall2.name = "Wall_South"
wall2.location.y = -41
bpy.context.scene.collection.objects.link(wall2)
kiln.role([wall, wall2], "barrier")
shed = box("Shed", (20, 10, 0), (26, 16, 4), "#806040")
kiln.role(shed, "decor")
hull = box("Shed_Collider", (20, 10, 0), (26, 16, 4), "#ff00ff")
kiln.role(hull, "collider", stands_for="Shed")

arrow, pillar, slab = kiln.piece("fixture-arrow"), kiln.piece("fixture-pillar"), kiln.piece("fixture-slab")
kiln.place(arrow, (0, 0, 0), name="Arrow_Plain")                                   # identity at the origin
kiln.place(arrow, (10, 0, 0), rotation=90, name="Arrow_Turn90")                    # turned 90 degrees to its left (about Z)
kiln.place(arrow, (-10, 5, 0), rotation=-45, name="Arrow_TurnMinus45")
kiln.place(arrow, (0, 10, 2), rotation=(0, 0, 180), scale=2.0, name="Arrow_Scaled2")  # lifted, turned round, twice the size
kiln.place(pillar, (5, -10, 0), name="Pillar_Plain")
kiln.place(pillar, (-5, -10, 0), rotation=30, scale=(1, 1, 2.5), name="Pillar_Tall")   # non-uniform: 2.5 times as tall
kiln.place(pillar, (15, -10, 0), rotation=(90, 0, 0), name="Pillar_OnItsBack")         # tipped 90 degrees about X
kiln.place(slab, (-20, -15, 0), name="Slab_Plain")
kiln.place(slab, (-20, 0, 0), rotation=(0, 0, 270), scale=(0.5, 2, 1), name="Slab_Stretched")  # non-uniform, turned
kiln.place(slab, (12, 12, 1), rotation=(10, 20, 30), scale=1.5, name="Slab_Tilted")    # rotation about all three axes
kiln.marker("Spawn_A", "spawn", (-25, -18, 0.5), rotation=90)
kiln.track("Center_Line", [(-25, -18, 0), (0, -18, 0), (25, -10, 0), (25, 10, 0)], width=8)
bpy.context.view_layer.update()

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(layout_dir, "scene.blend"), copy=True, check_existing=False)
layout = kiln.layout()
manifest = kiln_roblox.export(out, name="roblox", units="studs", source_version=1, plain=True, ao=False, log=lambda s: print("[fixture] " + s))
manifest["blend"] = "roblox.blend"
for m in manifest["materials"]:
    m["maps"] = {k: os.path.basename(v) for k, v in m["maps"].items()}
with open(os.path.join(out, "roblox.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=1)


def r(v):
    return [round(float(x), 4) for x in v]


expected = {
    "about": "World positions (scene units, Blender axes: Z up, models face -Y) of each placed piece's reference points: world = matrix @ point.",
    "units": "studs",
    "piece_points": POINTS,
    "placements": {},
    "markers": {},
    "paths": {},
    "shared_meshes": {k: v["objects"] for k, v in manifest["meshes"].items() if len(v["objects"]) > 1},
    "roles": manifest["roles"],
    "colliders": manifest["colliders"],
    "pieces": {k: v["project"] for k, v in manifest["pieces"].items()},
}
for p in manifest["placements"]:
    M = Matrix(p["matrix"])
    expected["placements"][p["name"]] = {"piece": p["piece"], "project": p["project"], **{k: r(M @ Vector(v)) for k, v in POINTS.items()}}
for m in manifest["markers"]:
    M = Matrix(m["matrix"])
    expected["markers"][m["name"]] = {"role": m["role"], "position": r(M.translation), "facing": r(M.to_3x3() @ Vector((0, 1, 0)))}
for p in manifest["paths"]:
    expected["paths"][p["name"]] = {"role": p["role"], "width": p["width"], "closed": p["closed"], "first": p["points"][0], "last": p["points"][-1], "points": len(p["points"])}
with open(os.path.join(out, "expected.json"), "w", encoding="utf-8") as f:
    json.dump(expected, f, indent=1)
shutil.rmtree(root, ignore_errors=True)
print("[fixture] wrote %s: %d placements, %d markers, %d paths" % (out, len(manifest["placements"]), len(manifest["markers"]), len(manifest["paths"])))
