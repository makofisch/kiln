"""
Z-fighting check tests, in a headless Blender (no Kiln core, no model calls):

  blender -b --factory-startup --python scripts/test-zfight.py

Builds small scenes that must and must not be reported, checks the fix, and times a ~300k triangle scene.
Exits with code 1 when a case fails.
"""

import os
import sys
import time

import bmesh
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "blender"))
import checks  # noqa: E402

FAILED = []


def clear():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)


def box(name, size, loc, coll=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    bpy.context.scene.collection.objects.link(ob)
    return ob


def plane(name, size, loc, rot=(0, 0, 0), cuts=0):
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=cuts + 1, y_segments=cuts + 1, size=0.5)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    ob.rotation_euler = rot
    bpy.context.scene.collection.objects.link(ob)
    return ob


def join(objs, name):
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    return objs[0]


def run(label, expect, units="studs", roblox=True, inside=None):
    checks.CONTEXT.update(units=units, roblox=roblox)
    bpy.context.view_layer.update()
    found, _ = checks.find_zfight()
    n = len(found)
    ok = (n > 0) == expect and (inside is None or any(f["inside"] for f in found) == inside)
    print(f"{'ok  ' if ok else 'FAIL'} {label}: {n} pair(s) {[checks.describe(f) for f in found[:3]]}")
    if not ok:
        FAILED.append(label)
    return found


# --- must be reported -------------------------------------------------------------------------------
clear()
box("Wall", (10, 1, 10), (0, 0, 5))
plane("Decal", (2, 2), (0, -0.5, 5), rot=(1.5708, 0, 0))  # its normal faces -Y, flush on the wall's front
run("decal flush on a wall (studs)", True)

clear()
box("Wall", (10, 1, 10), (0, 0, 5))
box("Plate", (2, 0.2, 2), (0, -0.5 + 0.1 - 0.005, 5))  # its front face 0.005 studs proud of the wall
f = run("plate 0.005 studs proud of a wall (studs)", True)
checks.CONTEXT.update(units="studs", roblox=True)
print("     fix:", checks.zfight(fix=True).replace("\n", " | "))
run("  ...after the fix", False)
pl = bpy.data.objects["Plate"]
print("     plate now", round(pl.dimensions.y, 4), "deep (was 0.2): its front was pushed out")
if pl.dimensions.y <= 0.2:
    FAILED.append("the plate fix did not extrude its front")

clear()
box("Ground", (40, 40, 1), (0, 0, -0.5))
plane("Road", (30, 4), (0, 0, 0.03))  # 0.03 studs above a 40-stud ground: a wide layer needs more
run("road 0.03 studs over the ground (wide layer)", True)

clear()
box("CrateA", (2, 2, 2), (0, 0, 1))
box("CrateB", (2, 2, 2), (1, 0.5, 1))  # overlapping, tops and bottoms coplanar
run("two crates intersecting with flush tops", True)

clear()
a = box("Body", (4, 4, 4), (0, 0, 2))
b = box("Badge", (1, 0.1, 1), (0, -2.0 + 0.05 - 0.004, 2))
join([a, b], "Joined")
found = run("badge joined into the body mesh, 0.004 studs proud", True, inside=True)
checks.CONTEXT.update(units="studs", roblox=True)
print("     fix:", checks.zfight(fix=True).replace("\n", " | "))
run("  ...after the fix", False)

clear()
w = box("Wall", (10, 1, 10), (3, 2, 5))
p = box("Plate", (2, 0.2, 2), (0, -0.5 + 0.1 - 0.006, 0))
p.parent = w  # in the wall's space, so it turns with it
w.rotation_euler = (0.31, 0.17, 0.52)  # no axis-aligned faces anywhere
run("rotated wall with a plate 0.006 studs proud", True)
checks.CONTEXT.update(units="studs", roblox=True)
print("     fix:", checks.zfight(fix=True).replace("\n", " | "))
run("  ...after the fix", False)

clear()
o = box("Rail", (1, 1, 1), (0, 0, 0.5))
arr = o.modifiers.new("Array", "ARRAY")
arr.count = 3
arr.relative_offset_displace = (0.5, 0, 0)  # copies overlap by half: their tops and bottoms are coplanar
run("array modifier with overlapping copies", True, inside=True)

clear()
o = box("Dup", (2, 2, 2), (0, 0, 1))
bm = bmesh.new()
bm.from_mesh(o.data)
bm.faces.ensure_lookup_table()
top = [f for f in bm.faces if f.normal.z > 0.9][0]
bm.faces.new([bm.verts.new(v.co) for v in top.verts])  # the top face twice
bm.to_mesh(o.data)
bm.free()
run("duplicated face inside one mesh", True, inside=True)
checks.CONTEXT.update(units="studs", roblox=True)
print("     fix:", checks.zfight(fix=True).replace("\n", " | "))
run("  ...after the fix", False)

clear()
box("Wall", (4, 0.2, 3), (0, 0, 1.5))
box("Panel", (1, 0.02, 1), (0, -0.1 + 0.01 - 0.0015, 1.5))  # 1.5 mm proud in a Roblox project in metres
run("panel 1.5 mm proud (Roblox, metres)", True, units="m", roblox=True)

# --- must not be reported ---------------------------------------------------------------------------
clear()
box("Floor", (20, 20, 1), (0, 0, -0.5))
box("Crate", (2, 2, 2), (0, 0, 1))  # resting on it: opposite-facing contact
run("crate resting on the floor (contact)", False)

clear()
for i in range(4):
    plane(f"Tile{i}", (2, 2), (i * 2, 0, 0))  # side by side, edges touching
run("floor tiles edge to edge", False)

clear()
plane("Grid", (10, 10), (0, 0, 0), cuts=60)
run("one subdivided plane", False)

clear()
for i in range(6):
    box(f"Step{i}", (4, 1.0, 0.7), (0, i * 0.9, 0.35 + i * 0.7))
run("stairs", False)

clear()
box("Wall", (10, 1, 10), (0, 0, 5))
box("Plate", (2, 0.2, 2), (0, -0.5 + 0.1 - 0.05, 5))  # its front face 0.05 studs proud: enough
run("plate 0.05 studs proud (studs)", False)

clear()
box("Wall", (4, 0.2, 3), (0, 0, 1.5))
box("Panel", (1, 0.02, 1), (0, -0.1 + 0.01 - 0.004, 1.5))  # 4 mm proud, plain metres project: enough
run("panel 4 mm proud (metres, not Roblox)", False, units="m", roblox=False)

clear()
bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=2)
bpy.ops.mesh.primitive_cube_add(size=2, location=(5, 0, 1))
bpy.context.active_object.modifiers.new("Bevel", "BEVEL").segments = 3
run("a sphere and a bevelled box", False)

# --- time on a large scene --------------------------------------------------------------------------
clear()
plane("Terrain", (200, 200), (0, 0, 0), cuts=150)  # ~45k triangles
for i in range(60):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=1, location=((i % 10) * 6 - 30, (i // 10) * 6 - 15, 1.2))
for i in range(400):
    box(f"Crate{i}", (1, 1, 1), ((i % 20) * 3 - 30, (i // 20) * 3 + 20, 0.5))
box("Wall", (60, 1, 8), (0, -40, 4))
for i in range(30):
    box(f"Sign{i}", (1.5, 0.05, 1), (i * 2 - 30, -40.5 + 0.025 - 0.003, 4))  # 30 signs 0.003 proud
checks.CONTEXT.update(units="studs", roblox=True)
bpy.context.view_layer.update()
t0 = time.time()
r = checks.check_scene(max_tris=400000)
dt = time.time() - t0
print(f"big scene: {r['faces_checked']} triangles, {r['zfight_pairs']} pairs in {dt:.2f} s (z-fight part {r['zfight_ms']} ms), truncated={r['zfight_truncated']}")
if r["zfight_pairs"] != 30:
    FAILED.append(f"big scene: expected the 30 signs, got {r['zfight_pairs']}")
if dt > 3.0:
    FAILED.append(f"big scene took {dt:.1f} s")

print("\nFAILED: " + ", ".join(FAILED) if FAILED else "\nall z-fighting cases passed")
sys.exit(1 if FAILED else 0)
