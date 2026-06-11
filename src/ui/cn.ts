/**
 * cn — tiny dependency-free class-name combiner.
 *
 * Accepts strings, falsy values (skipped), arrays (recursed), and objects
 * ({ "class": condition }). Deliberately avoids `clsx` + `tailwind-merge` so we
 * don't add packages that would re-trigger the native `electron-rebuild`
 * postinstall. Author conflict-free class lists (put conditional overrides last).
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[]
  | { [key: string]: boolean | null | undefined };

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string" || typeof input === "number") {
      out.push(String(input));
    } else if (Array.isArray(input)) {
      const inner = cn(...input);
      if (inner) out.push(inner);
    } else if (typeof input === "object") {
      for (const key in input) {
        if (input[key]) out.push(key);
      }
    }
  }
  return out.join(" ");
}

export default cn;
