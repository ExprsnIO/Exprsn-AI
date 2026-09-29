/** Classification labels, lowest to highest. Compared numerically; the order is fixed. */
export const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Label = (typeof LABELS)[number];

export const labelRank = (l: Label): number => LABELS.indexOf(l) + 1;

export const isLabel = (v: unknown): v is Label => typeof v === 'string' && (LABELS as readonly string[]).includes(v);

/** The highest of the given labels (high-water mark). */
export function highest(...labels: Label[]): Label {
  return labels.reduce<Label>((a, b) => (labelRank(b) > labelRank(a) ? b : a), 'public');
}

/** True when a principal cleared to `clearance` may read data labelled `label`. */
export const clears = (clearance: Label, label: Label): boolean => labelRank(clearance) >= labelRank(label);
