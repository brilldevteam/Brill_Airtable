/** Base icon colours (stored by key on each base). Gradients give the tiles a little depth. */
export const BASE_COLORS: Record<string, string> = {
  blue: "linear-gradient(135deg, #60a5fa, #2563eb)",
  teal: "linear-gradient(135deg, #34d399, #059669)",
  purple: "linear-gradient(135deg, #a78bfa, #7c3aed)",
  orange: "linear-gradient(135deg, #fdba74, #ea580c)",
  red: "linear-gradient(135deg, #fb7185, #e11d48)",
  cyan: "linear-gradient(135deg, #67e8f9, #0891b2)",
  gray: "linear-gradient(135deg, #a1a1aa, #52525b)",
};

/** A light wash of the base's colour, behind its table tabs. */
export const BASE_TINTS: Record<string, string> = {
  blue: "#eef4ff", teal: "#ecfdf5", purple: "#f5f3ff", orange: "#fff4ea", red: "#fff1f3", cyan: "#ecfeff", gray: "#f4f4f5",
};

/** Soft background + readable text pairs for select-option pills. */
export const CHOICE_COLORS: Record<string, { bg: string; fg: string }> = {
  blue: { bg: "#dbeafe", fg: "#1e40af" },
  cyan: { bg: "#cffafe", fg: "#155e75" },
  teal: { bg: "#ccfbf1", fg: "#115e59" },
  green: { bg: "#dcfce7", fg: "#166534" },
  yellow: { bg: "#fef3c7", fg: "#92400e" },
  orange: { bg: "#ffedd5", fg: "#9a3412" },
  red: { bg: "#ffe4e6", fg: "#9f1239" },
  pink: { bg: "#fce7f3", fg: "#9d174d" },
  purple: { bg: "#ede9fe", fg: "#5b21b6" },
  gray: { bg: "#f4f4f5", fg: "#3f3f46" },
};
