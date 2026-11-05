# Reference layout

A tiny map with known answers, for testing an importer of Kiln's Roblox manifest (version 2).

- `roblox.json`: the manifest, as `POST /api/v1/projects/:id/roblox` with `plain: true` returns it
  (`blend` and the map paths are file names here, not absolute paths).
- `roblox.blend`: the baked scene it describes (ground, two walls sharing one mesh, a shed, a collider).
- `expected.json`: the answers.
- `make_fixture.py`: rebuilds all three (`blender -b --factory-startup --python make_fixture.py -- .`).

## What is in it

Three pieces, each asymmetric so a wrong rotation or a swapped axis shows:

| Piece | Project | Shape (its own space) |
|---|---|---|
| Arrow | `fixture-arrow` | shaft along +X (3 long), a fin toward +Y, a post up +Z; origin at its tail |
| Pillar | `fixture-pillar` | 1 x 1 x 4 column with a step on its -Y side (its front) |
| Slab | `fixture-slab` | 4 x 2 x 0.5, origin at a corner |

Ten placements: plain, turned about Z, turned and uniformly scaled, non-uniformly scaled, tipped about X,
and one rotated about all three axes. One marker (`Spawn_A`, turned 90 degrees) and one path
(`Center_Line`, 4 points, width 8). `Wall_North` and `Wall_South` share a mesh. `Ground` is `drivable` and
left to Roblox's Asphalt; the walls are `barrier`; `Shed` is `decor` with `Shed_Collider` standing in for
it.

## How to use the answers

Everything is in scene units (studs here) and Blender axes: X right, Y back (models face -Y), Z up.
A matrix is 4x4 row-major: `world = matrix @ (x, y, z, 1)`.

For each placement, `expected.json` gives where four points of the piece land in the world: its origin
and the points one unit along its X, Y and Z (`origin`, `x1`, `y1`, `z1`). An importer converts axes its
own way; after importing, take the same four points of the piece's model in the game, convert their world
positions back to Kiln's axes, and compare. If the origin matches but `x1` doesn't, the rotation or the
scale is wrong; if `z1` of `Pillar_Tall` isn't 2.5 above its origin, non-uniform scale was lost.

A marker's `facing` is the world direction of its +Y.
