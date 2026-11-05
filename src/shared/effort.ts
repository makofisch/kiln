// Auto effort: how hard the copilot should think about one request, judged from the request itself.
// A question or a small edit doesn't need long deliberation; a detailed, researched, rigged and animated
// creature does. The signals are plain and listed in the result, so the choice can be read and overridden.
import type { BriefKind, Effort } from './types.ts';

export interface EffortInput {
  text: string;
  /** Images attached to the message. */
  images?: number;
  /** The scene has nothing in it yet. */
  sceneEmpty?: boolean;
  /** A brief from another app: what kind. */
  kind?: BriefKind | null;
  /** The brief's triangle budget (its `spec.tris`): the plainest sign of how big the job is. */
  tris?: number | null;
}

export interface EffortPick {
  effort: Effort;
  /** What decided it, e.g. "new build, detailed, named subject, rig and animation". */
  why: string;
}

const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// "model" and "design" are also nouns ("why is the model dark?"): they count as a request only with something to make.
const BUILD = /\b(build|create|generate|sculpt|construct|produce)\b|\b(model|design)\s+(me\s+|us\s+)?(a|an|some|another|the|this|\d+)\b|\bmak(e|ing)\s+(me\s+|us\s+)?(a|an|some|another|\d+)\b|\b(i|we)\s+(want|need|would like)\b|\bgive me\b/;
const REWORK = /\b(rework|rebuild|redo|remake|redesign|overhaul|start (over|again)|from scratch)\b/;
const ASK_FOR_MORE = /\b(max(imum)? (effort|quality|detail)|highest (effort|quality)|full effort|think (very |really )?hard|take your time|no shortcuts|go all (in|out)|best (you can|possible)|as (good|detailed|accurate) as (you can|possible))\b/;
const DETAIL = /\b(detailed|high[- ]detail|intricate|complex|elaborate|realistic|photoreal\w*|accurate(ly)?|faithful(ly)?|hero|showcase|cinematic|polished|production[- ](quality|ready)|aaa|ultra|stunning|frightening|terrifying|menacing|convincing|high[- ]quality|high[- ]fidelity)\b/;
const NAMED = /\b(from (the |a )?(\w+ )?(film|movie|game|show|series|book|anime|franchise)|in the style of|inspired by|based on|replica of|true to|just like|looks? like (the|a|an)\b)/;
const SUBJECT = /\b(creature|monster|enemy|boss|character|humanoid|person|animal|dragon|alien|beast|insect|spider|robot|mech|vehicle|car|truck|tank|ship|airship|spaceship|starship|aircraft|plane|helicopter|castle|cathedral|palace|temple|village|town|city|map|level|environment|landscape|world|diorama|interior|dungeon|maze|station|street|forest|island|skeleton|zombie|golem|griever)s?\b/;
const WORLD = /\b(village|town|city|map|level|environment|landscape|world|dungeon)s?\b/;
const MOTION = /\b(rig(ged|ging)?|animat\w+|clips?|walk(ing)? cycle|run cycle|gait|keyframes?|skinn?(ed|ing)|joints?)\b/;
const SIMPLE = /\b(simple|quick(ly)?|rough|block[- ]?out|placeholder|basic|minimal|low[- ]?poly|just (a|an|the)|tiny|small tweak|light on triangles|one rigid object|single (rigid )?(object|mesh|part))\b/;
// "Not rigged", "no animation": the opposite of a rig-and-animation job.
const NO_MOTION = /\b(not|no|un|without|never)[- ]?(a )?(rig(ged|ging)?|animat\w+|skinn?(ed|ing)|clips?|joints?)\b/g;
// A thing a person holds or walks past: one object, no moving parts.
const PROP = /\b(prop|pick-?up|power-?up|collectible|item|crate|barrel|bottle|jar|box|sign|lamp|bench|chair|table|coin|gem|key|potion|drink|food|fruit|tool|trophy|chest|rock|bush|tree|fence|door)s?\b|\b(a|the|drink|soda|tin|oil|paint|trash|spray|energy[- ]drink)\s+cans?\b/;
// The name of a work, said to be one: "(2014 film)", "from the movie", "the novel's".
const WORK = /\b(film|movie|novel|franchise|trilogy|comic|manga)\b/;
// Names that say nothing about the subject.
const PLAIN_NAMES = new Set(['Kiln', 'Roblox', 'Blender', 'Shuriken', 'Studio', 'Idle', 'Walk', 'Run', 'Jump', 'Attack', 'Lunge', 'Roar', 'Death', 'Hit', 'Strike', 'Action', 'Movement', 'Core', 'Rig', 'Body', 'Head', 'Left', 'Right', 'Front', 'Back', 'Top', 'Bottom']);

/** A proper name inside the request ("Maze Runner Griever", "the Eiffel Tower", "a Griever"): something with a look to match. */
function namesSomething(text: string): boolean {
  if (NAMED.test(text.toLowerCase())) return true;
  for (const sentence of text.split(/(?<=[.!?:;\n])\s+/)) {
    const words = sentence.split(/\s+/).slice(1); // a sentence's first word is capitalised anyway
    let run = 0;
    for (const w of words) {
      const core = w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
      const proper = /^[A-Z][a-z]{2,}$/.test(core) && !PLAIN_NAMES.has(core);
      run = proper ? run + 1 : 0;
      if (proper && (run >= 2 || core.length >= 6)) return true;
    }
  }
  return false;
}

// Words that look like a subject but are about textures or settings: "roughness maps", "world colour".
const NOT_A_SCENE = /\b(roughness|normal|texture|bump|height|uv|colou?r|metal(ness|lic)?|emissi(ve|on)|ao|occlusion|displacement|shadow|environment|hdri?|light)\s+maps?\b|\bworld\s+(colou?r|background|light(ing)?|strength|space|origin|ax[ie]s|coordinates?)\b|\bmaps?\s+(to|onto|into)\b/g;
const ASKS = /^(why|what|what's|whats|how(?! about)|is|are|was|were|does|do|did|which|where|when|who|should|has|have)\b/;

/** The effort a request deserves (see the top of the file). */
export function pickEffort(input: EffortInput): EffortPick {
  const text = input.text.trim();
  const t = text.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  const why: string[] = [];
  let score: number;

  // A question is answered, not built: one that opens with a question word stays a question even when it mentions building.
  const question = /\?\s*$/.test(text) && words < 40 && !REWORK.test(t) && (ASKS.test(t) || !BUILD.test(t));
  // "third-person camera" is not a person; "not rigged" is not a rig.
  // Nor is a style comparison a subject ("Monster style" is a brand, not a creature), nor the place a thing
  // is meant for ("for the town square") the thing itself.
  const subject = t
    .replace(NOT_A_SCENE, ' ')
    .replace(/\b(first|third)[- ]person\b/g, ' ')
    .replace(/\([^)]*\b(style|energy|vibes?|feel|look)\b[^)]*\)/g, ' ')
    .replace(/\b[\w'-]+(\s*\/\s*[\w'-]+)*[- ]style\b/g, ' ')
    .replace(/\b(for|in|on|at|of|across|around|inside|outside|above)\s+(the|a|an|its|their|our|your|this|that)\s+(?:[\w'-]+\s+){0,3}(village|town|city|map|level|environment|landscape|world|dungeon|street|forest|island|station|maze|castle|temple|arena|field)s?\b/g, ' ');
  const motionText = t.replace(NO_MOTION, ' ');
  const still = NO_MOTION.test(t);
  NO_MOTION.lastIndex = 0;
  const brief = !!input.kind;
  if (input.kind === 'new' || input.kind === 'rework') {
    // A build for another app's game starts where the user's own build does: the job decides the rest.
    score = 2;
    why.push(input.kind === 'new' ? 'new build for the game' : 'rework for the game');
  } else if (input.kind === 'animate') {
    score = 2;
    why.push('animation work');
  } else if (input.kind === 'fix') {
    score = 2;
    why.push('fix');
  } else if (question) {
    score = 0;
    why.push('a question');
  } else if (REWORK.test(t)) {
    score = 2;
    why.push('rework');
  } else if (input.sceneEmpty || BUILD.test(t)) {
    score = 2;
    why.push('new build');
  } else {
    score = 1;
    why.push('edit');
  }

  const add = (on: boolean, n: number, label: string) => {
    if (!on) return;
    score += n;
    why.push(label);
  };
  if (!question) {
    add(ASK_FOR_MORE.test(t), 2, 'asks for the best');
    add(DETAIL.test(t), 1, 'detailed');
    // A brief always carries names (the game, the model, style comparisons such as "Red Bull style"): they
    // count only when the text says the subject is a work to match ("(2014 film)", "from the movie").
    add(brief ? NAMED.test(t) || (WORK.test(t) && namesSomething(text)) : namesSomething(text), 1, 'named subject');
    // A fix or an animation works on the model that is already there: its subject adds nothing.
    add(SUBJECT.test(subject) && input.kind !== 'fix' && input.kind !== 'animate', 1, WORLD.test(subject) ? 'large scene' : 'complex subject');
    add(MOTION.test(motionText) && input.kind !== 'animate', 1, 'rig and animation');
    // A brief is long by nature (it carries the game's style): its length says nothing about the job.
    add(!brief && (words > 120 || (text.match(/^\s*([-*•]|\d+[.)])\s+/gm)?.length ?? 0) >= 4), 1, 'long request');
    add((input.images ?? 0) > 0 && score >= 2 && input.kind !== 'fix', 1, 'reference images');
    add(SIMPLE.test(t), -1, 'simple');
    // How big the job is caps how hard to think about it. A small still prop is a medium job however the
    // request is worded; a mid-size still model a high one. Asking for the best lifts the cap.
    if (!ASK_FOR_MORE.test(t) && !MOTION.test(motionText) && !WORLD.test(subject)) {
      const small = (input.tris ?? 0) > 0 && input.tris! <= 3000;
      const prop = PROP.test(subject) && (SIMPLE.test(t) || small || (still && !SUBJECT.test(subject)));
      if ((small || prop) && score > 1) {
        score = 1;
        why.push(small ? 'small prop (triangle budget)' : 'small still prop');
      } else if ((input.tris ?? 0) > 0 && input.tris! <= 10000 && score > 2) {
        score = 2;
        why.push('mid-size still model');
      }
    }
  }
  // Max takes more than one signal (a brief for the game plus one common noun used to reach it):
  // 0 low, 1 medium, 2 high, 3-4 xhigh, 5 and up max.
  const effort = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, score >= 5 ? 4 : Math.min(score, 3)))]!;
  return { effort, why: why.join(', ') };
}
