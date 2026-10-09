import type { Label } from '../authz/labels.js';

/*
 * What a feature needs of DLP (1.6.0, B-7601), without the detectors: chat, uploads, agents and the OpenAI-compatible
 * API import this, so `guardrails/detectors.ts` (which reads the attachment checksums) never joins an import cycle.
 */
export const DLP_SCOPES = ['answer', 'agent', 'upload'] as const;
export type DlpScope = (typeof DLP_SCOPES)[number];
export const DLP_ACTIONS = ['label', 'redact', 'hold'] as const;
export type DlpAction = (typeof DLP_ACTIONS)[number];

export interface DlpInput {
  tenantId: string;
  text: string;
  scope: DlpScope;
  /** The content's label before inspection. */
  label: Label;
}

export interface DlpDetection {
  kind: string;
  span: [number, number];
  score: number;
  /** The rule that fired on it. */
  rule: string;
}

export interface DlpResult {
  /** The content's label after inspection: at least the input's. */
  label: Label;
  raised: boolean;
  /** The most severe action of the rules that fired, or null when none did. */
  action: DlpAction | null;
  /** The text to carry on with: redacted when the action is `redact`, else the input. */
  text: string;
  detections: DlpDetection[];
  rules: { id: string; name: string; action: DlpAction; raiseTo: Label; kinds: string[] }[];
}

export interface DlpInspector {
  inspect(input: DlpInput): Promise<DlpResult>;
}

export const noDlp: DlpInspector = { inspect: async (i) => ({ label: i.label, raised: false, action: null, text: i.text, detections: [], rules: [] }) };
