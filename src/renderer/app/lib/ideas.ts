import type { Suggestion } from '../../../shared/types.ts';

// Starter ideas for the start page and fresh projects. The label is the bubble; the prompt is what
// lands in the message box: a fuller brief the copilot can build well from.

const IDEAS: Suggestion[] = [
  { label: 'Arcade cabinet', prompt: 'Build a retro 80s arcade cabinet: an angled CRT screen showing a glowing pixel-art game, a control panel with a joystick and six colored buttons, a coin door with lit slots, side-art decals and a glowing marquee on top. About 1.8 m tall with realistic proportions.' },
  { label: 'Lighthouse islet', prompt: 'Model a lighthouse on a small rocky islet: a tapered tower with red and white stripes, a railed gallery, a glass lantern room with a glowing lamp, a keeper’s cottage and rough rocks with wet edges. Night mood with the beam lit.' },
  { label: 'Treasure chest', prompt: 'Make a pirate treasure chest with the lid half open: iron-banded wooden planks with worn edges, a heavy lock, and gold coins, gems and a small crown spilling out. Stylized but detailed.' },
  { label: 'Sci-fi cargo crate', prompt: 'Build a sci-fi cargo crate about 1.2 m wide: beveled armored panels, recessed handles, hazard stripes, stenciled labels, and cyan light strips glowing along the edges.' },
  { label: 'Mushroom cottage', prompt: 'Create a fairy-tale mushroom cottage: a big red cap roof with white spots, a round wooden door with iron hinges, little round windows with warm light, a crooked chimney, and small mushrooms and grass around the base.' },
  { label: 'Floating island', prompt: 'Model a floating island: a grassy top with a small tree and a ruined stone arch, a rocky underside tapering to a point with hanging roots, and a waterfall pouring off one edge.' },
  { label: 'Reading nook', prompt: 'Build a cozy reading nook: a deep armchair with a knitted blanket, a floor lamp giving warm light, a side table with a mug and a stack of books, a bookshelf and a round rug. Warm evening lighting.' },
  { label: 'Market stall', prompt: 'Make a medieval market stall: a timber frame with a striped cloth awning, a counter with baskets of fruit and vegetables, hanging herbs, stacked crates and a hand-painted sign.' },
  { label: 'Boat at a jetty', prompt: 'Model a wooden rowing boat moored at a small jetty: a plank hull with visible ribs, two oars, a rope tied to a post, and weathered jetty boards on posts over calm water.' },
  { label: 'Desk setup', prompt: 'Build a modern desk setup: a wooden desk, a curved monitor with a glowing screen, a mechanical keyboard, a mouse on a desk mat, a desk lamp, a potted plant and tidy cables. Soft evening light.' },
  { label: 'Stone well', prompt: 'Create an old stone well with a wooden roof: stacked irregular stones, a crank with rope and a bucket, moss in the gaps, and a grassy patch around it.' },
  { label: 'Campfire', prompt: 'Make a forest campfire scene at dusk: a ring of stones, crossed logs with glowing embers and flames, a log bench, a kettle on a tripod and a small tent behind.' },
  { label: 'Mars rover', prompt: 'Build a planetary rover: six wheels on rocker-bogie suspension, a boxy body with solar panels, a camera mast, an antenna dish, on dusty orange terrain with scattered rocks.' },
  { label: 'Treehouse', prompt: 'Model a treehouse in a big oak: a plank cabin with a slanted roof and a round window, a rope ladder, a small railed balcony, and lanterns hanging from the branches.' },
  { label: 'Ramen stand', prompt: 'Create a tiny Japanese ramen stand at night: a wooden counter with stools, noren curtains, glowing red paper lanterns, steaming bowls, menu boards and a small tiled roof.' },
  { label: 'Castle gatehouse', prompt: 'Build a castle gatehouse: two round stone towers with crenellations, a wooden portcullis, a drawbridge over a moat, hanging banners and torches beside the entrance.' },
  { label: 'Neon vending machine', prompt: 'Make a cyberpunk vending machine: glowing neon panels, a grid of colorful drinks behind glass, a scuffed metal body with stickers and graffiti, a small screen and a card slot.' },
  { label: 'Bonsai tree', prompt: 'Model a bonsai tree in a shallow ceramic pot: a twisting trunk with visible bark, layered foliage pads, moss and small stones on the soil, on a low wooden stand.' },
  { label: 'Vintage radio', prompt: 'Build a 1940s tabletop radio: a rounded wooden cabinet, a fabric speaker grille, a glowing tuning dial with numbers, brass knobs and small feet.' },
  { label: 'Pirate ship', prompt: 'Create a small pirate ship: a curved wooden hull, two masts with sails and rigging, a skull flag, cannons along the sides, a steering wheel on deck and a lantern at the stern.' },
  { label: 'Windmill', prompt: 'Model a Dutch windmill: a tapered brick tower, a thatched cap, four lattice sails, a wooden gallery around the middle, small windows and flower beds at the base.' },
  { label: 'Espresso machine', prompt: 'Build an espresso machine: a brushed steel body, a portafilter with a handle, pressure gauges, a steam wand, cups warming on top and a drip tray with a grille.' },
  { label: 'Fantasy sword', prompt: 'Make a fantasy longsword on a display stand: an engraved blade, a guard with curled quillons, a leather-wrapped grip and a gem pommel, resting on a carved wooden stand.' },
  { label: 'Rainy bus stop', prompt: 'Create a city bus stop at night in the rain: a glass shelter with a metal frame, a bench, a lit advertising panel, a route sign on a pole, a trash can and a wet reflective sidewalk.' },
  { label: 'Greenhouse', prompt: 'Build a Victorian greenhouse: a white iron frame with glass panes, a curved roof, rows of potted plants on wooden tables, hanging baskets and a watering can.' },
  { label: 'Robot buddy', prompt: 'Model a friendly little robot: a rounded body, a screen face with big eyes, stubby arms with claw hands, treads for feet, an antenna and panel details, in soft pastel colors.' },
  { label: 'Canyon rope bridge', prompt: 'Create a rope bridge across a small canyon: wooden planks and rope rails, posts anchored in rocks on both sides, red layered cliffs and a river far below.' },
  { label: 'Wizard’s desk', prompt: 'Build a wizard’s study desk: old books, a glowing crystal ball, potion bottles with colored liquids, candles, a quill and parchment, and a star map pinned above.' },
  { label: 'Food truck', prompt: 'Make a colorful food truck: a boxy van with a serving hatch and an awning, a menu board, string lights, a rooftop sign, and a couple of stools and a bin outside.' },
  { label: 'Snowy log cabin', prompt: 'Model a log cabin in the snow at dusk: stacked log walls, a snow-covered roof, a stone chimney, glowing windows, a woodpile and pine trees around.' },
  { label: 'Mech walker', prompt: 'Build a bipedal mech walker: an armored cockpit, reverse-jointed legs with hydraulic pistons, shoulder-mounted cannons, panel lines, warning decals and weathered paint.' },
  { label: 'Garden gazebo', prompt: 'Create a garden gazebo: an octagonal white wooden structure with a pointed roof, railings, climbing roses, a bench inside and a stone path leading up to it.' },
  { label: '50s diner booth', prompt: 'Make a 1950s diner booth: red vinyl seats with chrome trim, a checkered floor, a table with a jukebox selector and milkshakes, and a neon sign on the wall.' },
  { label: 'Crystal cave', prompt: 'Model a crystal cave: rough rock walls, clusters of glowing purple and blue crystals in many sizes, and a small still pool reflecting their light. Dark, moody lighting.' },
  { label: 'Blacksmith forge', prompt: 'Build a blacksmith’s forge: a stone hearth with glowing coals, leather bellows, an anvil on a tree stump, hammers and tongs on a rack, and a water barrel.' },
  { label: 'Toy train set', prompt: 'Create a wooden toy train set: a locomotive with a chimney, two carriages, round wheels and couplings, on a looping track with a small tunnel and a few toy trees.' },
  { label: 'Moon base', prompt: 'Build a small moon base: a domed habitat module, an airlock, solar arrays, an antenna mast, a landing pad with lights, on a cratered gray surface.' },
  { label: 'Old bookshop', prompt: 'Model a narrow old bookshop front: a painted wooden facade, a bay window full of books, a hanging sign, a door with a bell, and a bench and a bicycle outside.' },
  { label: 'Koi pond', prompt: 'Create a Japanese koi pond: an irregular stone edge, water lilies, a small arched red bridge, a stone lantern, bamboo, and a few koi under the surface.' },
  { label: 'Acoustic guitar', prompt: 'Model an acoustic guitar: a curved body with a round sound hole and rosette, a bridge, a neck with frets and inlays, a headstock with tuning pegs, and strings.' },
  { label: 'Hot air balloon', prompt: 'Build a hot air balloon: a striped envelope, ropes down to a wicker basket, a burner with a flame, sandbags on the sides, floating among a few soft clouds.' },
  { label: 'Skate park', prompt: 'Create a skate park corner: a half-pipe with metal coping and graffiti, a grind rail, a few cones and a skateboard, on cracked concrete.' },
  { label: 'Chess mid-game', prompt: 'Make a chess set mid-game: a wooden board with inlaid squares, classic Staunton pieces placed as in a real game, and a few captured pieces beside the board.' },
  { label: 'Forest shrine', prompt: 'Model a ruined forest shrine: mossy stone columns, a broken archway, a statue with an offering bowl, overgrown steps, vines and fallen leaves.' },
  { label: 'Research submarine', prompt: 'Create a yellow research submarine: a rounded hull with portholes, a conning tower, a propeller and fins, spotlights and a robotic arm, over a sandy sea floor with coral.' },
  { label: 'Game controller', prompt: 'Model a modern game controller: ergonomic grips, two thumbsticks, a d-pad, four face buttons, shoulder triggers and soft rubbery textures.' },
  { label: 'Clock tower', prompt: 'Build a gothic clock tower: a stone body with buttresses, a big clock face with roman numerals, a pointed spire, gargoyles, and a bell visible in an open belfry.' },
  { label: 'Street corner', prompt: 'Build a suburban street corner: a mailbox, a fire hydrant, a lamp post, a picket fence with bushes, and a sidewalk with a curb and a drain.' },
];

// A few ideas for the time of year (by month, 0 = January).
const SEASONAL: Array<{ months: number[]; ideas: Suggestion[] }> = [
  {
    months: [8, 9],
    ideas: [
      { label: 'Jack-o’-lantern', prompt: 'Carve a jack-o’-lantern with a spooky grin, glowing from inside, next to smaller pumpkins, dripping candles and autumn leaves on a wooden porch step. Night mood.' },
      { label: 'Haunted house', prompt: 'Build a small haunted Victorian house: a crooked roof, broken shutters, a glowing attic window, a dead tree, a leaning picket fence and pale moonlight.' },
      { label: 'Witch’s cauldron', prompt: 'Make a witch’s cauldron bubbling with glowing green brew over a small fire, with a broom, potion bottles and an open spellbook nearby.' },
    ],
  },
  {
    months: [10],
    ideas: [
      { label: 'Harvest table', prompt: 'Build a rustic harvest table: a long wooden table with pumpkins, squash, bread, apples in a basket, candles and a linen runner, with autumn leaves around.' },
      { label: 'Autumn tree', prompt: 'Model an autumn maple tree with orange and red leaves, a swing hanging from a branch, and a carpet of fallen leaves around its roots.' },
    ],
  },
  {
    months: [11, 0],
    ideas: [
      { label: 'Snow globe', prompt: 'Make a snow globe: a glass dome on a carved wooden base, with a tiny village inside, snow-covered roofs, pine trees and drifting snowflakes.' },
      { label: 'Holiday fireplace', prompt: 'Build a cozy holiday fireplace: a brick hearth with a crackling fire, stockings on the mantel, a garland and a wreath, and a decorated tree beside it.' },
      { label: 'Gingerbread house', prompt: 'Create a gingerbread house: cookie walls with icing trim, a candy-studded roof, gumdrop path, lollipop trees and powdered-sugar snow.' },
    ],
  },
  {
    months: [2, 3, 4],
    ideas: [
      { label: 'Cherry blossom', prompt: 'Model a cherry blossom tree in full bloom on a small hill, with falling petals, a stone bench under it and a little lantern.' },
      { label: 'Flower cart', prompt: 'Build a wooden flower cart with big wheels, buckets of tulips and daisies, a striped umbrella and a chalkboard price sign.' },
    ],
  },
  {
    months: [5, 6, 7],
    ideas: [
      { label: 'Beach hut', prompt: 'Create a striped beach hut on stilts with a small deck, a deck chair, a surfboard leaning on the wall, and sand and dune grass around.' },
      { label: 'Ice cream cart', prompt: 'Make a vintage ice cream cart: a pastel cart with a parasol, tubs of colorful ice cream behind glass, cones in a holder and a hand bell.' },
    ],
  },
];

const TWISTS = [
  'Style: low-poly with flat, harmonious colors.',
  'Style: a cozy stylized diorama on a round base.',
  'Style: photoreal, with weathered textured materials.',
  'Style: a night scene with warm practical lights.',
  'Style: clean and toy-like, with soft rounded shapes.',
  'Style: a miniature tabletop diorama with a shallow depth feel.',
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** A fresh set of starters: one for the season (when there is one) and the rest from the pool. */
export function starterIdeas(count = 5, avoid: string[] = []): Suggestion[] {
  const month = new Date().getMonth();
  const seasonal = SEASONAL.filter((s) => s.months.includes(month)).flatMap((s) => s.ideas);
  const skip = new Set(avoid);
  const pool = shuffle(IDEAS.filter((i) => !skip.has(i.label)));
  const season = shuffle(seasonal.filter((i) => !skip.has(i.label))).slice(0, 1);
  return shuffle([...season, ...pool.slice(0, count - season.length)]);
}

/** A random idea with a random style twist. */
export function surprise(): Suggestion {
  const all = [...IDEAS, ...SEASONAL.flatMap((s) => s.ideas)];
  const idea = all[Math.floor(Math.random() * all.length)]!;
  const twist = TWISTS[Math.floor(Math.random() * TWISTS.length)]!;
  return { label: idea.label, prompt: `${idea.prompt} ${twist}` };
}

/** After a reply that left no follow-ups. */
export const GENERIC: Suggestion[] = [
  { label: 'More detail', prompt: 'Add another pass of detail across the scene: secondary shapes, bevels, trims and small props that fit the style. Keep the overall layout, then check it with a render.' },
  { label: 'Better materials', prompt: 'Upgrade the materials: textured colors with variation, roughness maps and normal-mapped relief on the main surfaces, so nothing looks flat or plastic in the viewer.' },
  { label: 'Mood lighting', prompt: 'Set up mood lighting that suits the scene: a key light, a warm or cool accent light and a matching world color. Then show me a pretty render.' },
  { label: 'Ground & props', prompt: 'Give the scene a ground that suits it (grass, stone, sand or floor) with a textured material, and add a few small props around the base so it sits in a place.' },
  { label: 'Hero render', prompt: 'Show me a pretty render from a flattering low 3/4 hero angle.' },
];

/** For the object selected in the viewer. */
export function selectionIdeas(name: string): Suggestion[] {
  return [
    { label: 'More detail', prompt: `Add more detail to "${name}": bevel its edges and add secondary parts and surface details (panels, seams, trims) that fit its style, without changing its overall size.` },
    { label: 'Richer material', prompt: `Give "${name}" a more realistic material: color variation, roughness variation and subtle normal-mapped relief that suits what it is.` },
    { label: 'Variations', prompt: `Add two copies of "${name}" nearby with small variations in size, rotation and color, so the group looks natural. Keep them from intersecting anything.` },
    { label: 'Scale up 25%', prompt: `Make "${name}" about 25% bigger, keeping it resting where it is and not intersecting anything nearby.` },
    { label: 'Hide it', prompt: `Hide "${name}" for now (don't delete it).` },
  ];
}
