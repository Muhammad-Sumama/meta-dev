import type { ColorName, TargetCategory } from "@/lib/schemas/command";

/** Vocabulary shared by the rule parser and model-output normalization. */

export const CATEGORY_NOUNS: Record<Exclude<TargetCategory, "any">, string[]> = {
  person: [
    "man", "men", "woman", "women", "person", "people", "guy", "guys", "girl", "boy", "kid", "kids", "child",
    "children", "lady", "gentleman", "player", "dancer", "runner", "jogger", "skater", "skateboarder", "surfer",
    "rider", "cyclist", "biker", "driver", "pedestrian", "baby", "teenager", "teen", "human", "someone",
    "somebody", "actor", "actress", "speaker", "singer", "presenter", "athlete", "walker", "face", "subject",
  ],
  animal: [
    "dog", "puppy", "cat", "kitten", "bird", "horse", "cow", "sheep", "deer", "bear", "fish", "duck", "animal",
    "pet", "lion", "tiger", "elephant", "monkey", "rabbit", "squirrel", "goat", "pig", "chicken", "fox", "wolf",
  ],
  vehicle: [
    "car", "truck", "bus", "van", "taxi", "cab", "bike", "bicycle", "motorcycle", "motorbike", "scooter",
    "vehicle", "boat", "ship", "plane", "airplane", "train", "tram", "suv", "jeep", "sedan", "tractor",
  ],
  object: [
    "ball", "bottle", "cup", "mug", "phone", "laptop", "bag", "backpack", "umbrella", "sign", "tree", "flower",
    "chair", "table", "box", "skateboard", "surfboard", "kite", "drone", "lamp", "guitar", "book", "product",
    "logo", "plate", "frisbee", "balloon", "can", "shoe", "watch", "camera", "toy", "object", "thing",
  ],
};

export const CLOTHING = [
  "shirt", "t-shirt", "tshirt", "jacket", "coat", "dress", "hat", "cap", "hoodie", "sweater", "pants", "jeans",
  "shorts", "skirt", "top", "suit", "uniform", "helmet", "scarf", "shoes", "jersey", "vest", "blouse", "beanie",
  "trousers", "leggings",
];

export const COLOR_SYNONYMS: Record<string, ColorName> = {
  red: "red", crimson: "red", maroon: "red", scarlet: "red", burgundy: "red",
  orange: "orange", amber: "orange",
  yellow: "yellow", gold: "yellow", golden: "yellow",
  green: "green", lime: "green", olive: "green", teal: "green",
  blue: "blue", navy: "blue", cyan: "blue", turquoise: "blue", azure: "blue",
  purple: "purple", violet: "purple", lavender: "purple", magenta: "purple",
  pink: "pink", rose: "pink",
  brown: "brown", tan: "brown", beige: "brown", khaki: "brown",
  black: "black",
  white: "white", cream: "white",
  gray: "gray", grey: "gray", silver: "gray",
};

/** Hex values used when a command names a background color. */
export const COLOR_HEX: Record<string, string> = {
  red: "#d32f2f", orange: "#f57c00", yellow: "#fbc02d", green: "#00b140", blue: "#1e63d6",
  purple: "#7b1fa2", pink: "#e91e63", brown: "#6d4c41", black: "#000000", white: "#ffffff", gray: "#808080",
};

const NOUN_INDEX = new Map<string, Exclude<TargetCategory, "any">>();
for (const [cat, nouns] of Object.entries(CATEGORY_NOUNS)) {
  for (const n of nouns) NOUN_INDEX.set(n, cat as Exclude<TargetCategory, "any">);
}

export function categoryOfNoun(noun: string | undefined): TargetCategory {
  if (!noun) return "any";
  const n = noun.toLowerCase().trim();
  const last = n.split(/\s+/).pop()!;
  return NOUN_INDEX.get(n) ?? NOUN_INDEX.get(last) ?? NOUN_INDEX.get(last.replace(/s$/, "")) ?? "object";
}

export function isKnownNoun(word: string): boolean {
  return NOUN_INDEX.has(word) || NOUN_INDEX.has(word.replace(/s$/, ""));
}

export function normalizeColor(word: string | undefined | null): ColorName | undefined {
  if (!word) return undefined;
  return COLOR_SYNONYMS[word.toLowerCase().trim()];
}
