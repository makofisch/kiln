// The rigging and animation guide, handed to the copilot by mcp__kiln__animation_guide only when a model
// will move (so still models don't pay for it in every request).

export const ANIMATION_GUIDE = `Rigging and animation in Kiln (the model you build will move)

Build for motion from the start
- Plan the rig before modeling: which parts move (legs, tail, jaw, neck, arms, antennae, cables), where each pivot sits, what stays rigid. Face the model toward -Y (the front view), feet on z = 0, centred on the origin: that is Roblox's forward after export.
- Every part either moves rigidly with one joint (kiln.rig.bind: armour, mechanical legs, claws, teeth, props) or bends with several joints (kiln.rig.skin: flesh bodies, tails, necks, trunks). Nothing may hang loose: a cable, strand or dangling detail is bound to the part it hangs from, or becomes a short chain (kiln.tentacle(..., segments=3, rig=True)) that physics swings. kiln.rig.check lists meshes left unattached.
- Pivots sit exactly at the joints (hip, knee, ankle, shoulder, jaw hinge, tail base); segments overlap 10-20% at each joint so rotating never opens a gap; no mesh crosses a joint.
- Limbs: kiln.limb(name, points, radii, style, rig=True, parent_joint=...) makes the segments and joints and records the leg in one call; for a leg with a foot, give 4 points (hip, knee, ankle, toe). Hinge axes go across the limb: a leg that swings forward and back bends about the world X axis, a spider's sideways leg about Y. Limits in degrees, signed the way the limb is bent at rest (kiln.rig.check says if they're reversed).
- Keep it light for Roblox: under ~50 joints, at most 4 joint influences per vertex (skin() keeps to it), rotations only (no scale), joint names of letters, digits and underscores, parts under 20k triangles.
- In a Roblox project (see "Roblox target") don't skin at all: Roblox parts are rigid, so a skinned body arrives as stiff chunks. Build flesh from overlapping rounded pieces, one per joint (kiln.blob per segment, kiln.tentacle(..., segments=N, rig=True) for tails and necks), each kiln.rig.bind to its joint.
- Player characters and humanoid NPCs: kiln.rig.r15() builds Roblox's R15 rig (the standard avatar's joints, names and pivots) with placeholder parts; clips on it export as R15 animations.
- An old rig made of J_ empties: kiln.rig.upgrade() converts it (its timeline markers become clips). kiln.rig.remove(joint) deletes a joint, everything under it and its parts (to rebuild a tail or a limb).
- Run kiln.rig.check() once the rig is built and fix what it lists.
- Finish the rig before animating. A clip's keys are rotations from the rest pose, so moving a joint afterwards (kiln.rig.joint on an existing name) changes how every clip plays: Kiln says so when it happens; make generated clips again with kiln.anim.regenerate and look at hand-keyed ones.

Animate with the generators first (one call, under a second, physically grounded)
- kiln.anim.gait("Walk"), gait("Run", style="run"), gait("Trot", style="trot"), gait("Sneak", style="sneak"): any number of legs, feet planted with IK, heel-to-toe roll where there are feet, the body bobbing with its steps, arm swing and a chest twist for bipeds, head kept level, tails and cables swinging by physics. It records "speed" on the clip (units per second) so the game moves the model as fast as its feet travel. Tune with speed, cycle, duty, step_height, bob, lean, pattern ("walk", "trot", "pace", "gallop", "bound", "tripod", "wave").
- Unusual legs work in the same call. An odd number of legs (a three-legged walker) steps one leg at a time (pattern "sequence", picked by itself; also available for any count). Pointed feet (a spike, peg or hoof pointing down) are planted as points and don't roll. Build such a leg to move at the hip and knee only: make the joint above the spike kind="fixed" (or leave it out and let the spike be part of the shin). A hinged ankle on a pointed leg snaps round mid-step. If a first gait has problems, change cycle, duty or step_height and look again: don't hand-key a gait.
- Turning: gait("TurnLeft", speed=0, turn=90) steps round on the spot at 90 degrees a second (positive is the model's left), gait("WalkLeft", turn=40) walks a curve. The clip stays in place and records "turn" beside "speed": the game turns the model at that rate while it plays. Legs that touch each other at rest (R15's blocks) will pass through each other a little in a turn.
- kiln.anim.regenerate(name, style="run", speed=…) makes a generated clip again with some settings changed; everything you don't set is worked out afresh (a walk turned into a run gets a run's timing and step height).
- kiln.anim.idle(); attack("Bite", kind="bite") / kind "lunge", "sting" (the tail cocks back, then arcs over the body onto a target in front of the head, clear of the ground and itself), "slam" (front legs), "swipe" (a limb: chain="RightUpperArm"); hit(direction=...); death() (the body drops, legs splay, the tail folds to the ground). They carry events on the right frames: "Strike" and "Hit" (attacks), "Impact" (hit), "Dead" (death).
- kiln.anim.wave(clip, joints, amplitude, wavelength, frequency) layers a travelling wave (tail swish, slither, tentacles); kiln.anim.secondary(clip) adds physics follow-through to the chains a clip doesn't key (a hand-keyed tail or a biting jaw is left alone unless you name it in joints=[…]).
- Clips: kiln.anim.clip(name, length, loop, in_place), clips(), use(name), delete, rename, settings(name, loop=..., speed=...). Names the game looks for: Idle, Walk, Run, Attack (or Bite, Sting...), Hit, Death.

By hand when no generator fits
- kiln.anim.pose(clip, frame, {joint: (axis, degrees) or (x, y, z) degrees}) for key poses: rotations about world axes relative to rest; the axis is a vector or a name ("x", "-z", "right", "up", "forward"...). Keys in between are smoothed.
- kiln.anim.reach(clip, end_joint, {frame: (x, y, z)}, chain=2): IK for a claw that grabs a ledge or a foot pinned to a wall (hold a target still over several frames to pin it). Only the frames between the first and last target change, easing in and out over 3 frames; the rest of the clip keeps its motion.
- kiln.rig.ik(end, chain, pole=...) adds Blender IK with target empties you can key; kiln.anim.bake(clip) turns it into plain keys before you finish.
- kiln.anim.event(clip, "Hit", time=0.42) marks a moment for game code (damage, footstep sound, VFX).

Timing that reads as real
- Anticipation before every big action (a wind-up 2-3 times longer than the strike), a fast strike (4-6 frames at 30 fps), a short hold on impact, a slower recovery with a little overshoot and settle.
- Weight: heavy creatures move slower, sink into each step and take longer to stop; light ones are quick with little bob. Spread motion through the body: the hips lead, the chest follows, the head and tail lag (secondary() handles tails).
- Loops meet exactly (the last frame equals the first); the generators do it, check_motion confirms it.

Look at the motion, not just stills
- mcp__blender__render_motion: a clip as a filmstrip (labelled frames), an onion skin (frames overlaid, early blue to late orange: spacing and arcs), trails (the paths of feet, tail tip, head) and a graph (foot heights, when each foot is planted, the body's bob, events). A strip and a graph usually tell you enough.
- mcp__blender__check_motion: every frame checked for feet sliding while planted, parts dipping under the ground, parts passing through each other, joints past their limits, jerks and loop seams. Fix what it lists and check again. A snap you want (a strike) isn't a flaw: mark it with an event ("Strike", "Impact") and the check lets it be.
- Before finishing: each clip checked, the main clip showing (kiln.anim.use("Walk")) so the user sees it play in the viewer, and one line per clip in your reply (length, loop, speed). The user can scrub, blend and tweak clips in Kiln's Animate panel, and send them to Roblox Studio with Shuriken.`;
