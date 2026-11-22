const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Airtable-style ids: a 3-letter prefix + 14 random chars, e.g. "tbl8fK2...". */
export type IdPrefix = "usr" | "wsp" | "bse" | "tbl" | "fld" | "rec" | "viw" | "sel" | "ses" | "att" | "cmt" | "inv" | "shr" | "aut" | "run" | "dsh" | "ntf" | "wdg";

export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  let out = prefix;
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
