import { customAlphabet } from "nanoid";

const generate = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export type IdPrefix = "prj" | "trk" | "job" | "exp" | "cmd";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${generate()}`;
}
