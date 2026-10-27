import { z } from 'zod';
import { conditionSchema, LEAF_OPS, type Condition, type Leaf } from './flows.js';
import { nameSchema, normText, type Values } from './schema.js';

/*
 * Form layout (follow-up 2 of docs/decisions/lowcode-port.md, ported from exprsn-platform's form editor): sections
 * (title, help, collapsible) and wizard steps (ordered steps of sections, a review step at the end), and `visibleIf` /
 * `requiredIf` condition trees on fields, sections and steps.
 *
 * The condition model is the flows one (`apps/flows.ts`: `all`, `any`, `none` groups of `{field, op, value}` leaves
 * over `LEAF_OPS`), imported rather than forked; a form also still accepts its original one-leaf `visibleIf` exactly
 * as stored before. Flows compile their trees into workflow branch steps; a form evaluates them here, on every
 * submission, and `web/js/form-layout.js` mirrors this evaluator line by line for the console preview, the public form
 * page and the embed page. The server is authoritative: the browser only shows and hides.
 *
 * A definition without `layout` is one untitled section with every field (migrated on read, never rewritten), so a
 * flat form keeps working unchanged. A definition with a layout, a `requiredIf` or a tree condition is version 2.
 *
 * Evaluation runs in layout order (steps, their sections, their fields) over the answers kept so far, which are the
 * answers to the visible fields before it: a condition may only read a field that comes earlier on the form, so one
 * pass decides everything and a hidden field never influences another.
 */

const LEGACY_OPS = ['eq', 'ne', 'in', 'truthy', 'falsy'] as const;
/** The one-leaf `visibleIf` forms had before layouts (B-2205), accepted unchanged so stored forms still parse. */
const legacyCondition = z
  .object({
    field: nameSchema,
    op: z.enum(LEGACY_OPS),
    value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.union([z.string().max(200), z.number()])).max(50)]).optional()
  })
  .strict();
export const formConditionSchema: z.ZodType<Condition> = z.union([legacyCondition, conditionSchema]) as z.ZodType<Condition>;
export type FormCondition = Condition;

const partId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'lower-case letters, digits, - and _, starting with a letter');

export const formSectionSchema = z
  .object({
    id: partId,
    title: z.string().max(200).optional(),
    help: z.string().max(1000).optional(),
    /** Shown with a disclosure the visitor can close; `collapsed` starts it closed. */
    collapsible: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    fields: z.array(nameSchema).max(100),
    visibleIf: formConditionSchema.optional(),
    /** When it matches, every visible field of the section is required. */
    requiredIf: formConditionSchema.optional()
  })
  .strict();
export type FormSection = z.infer<typeof formSectionSchema>;

export const formStepSchema = z
  .object({
    id: partId,
    title: z.string().trim().min(1).max(200),
    help: z.string().max(1000).optional(),
    sections: z.array(partId).min(1).max(30),
    visibleIf: formConditionSchema.optional(),
    requiredIf: formConditionSchema.optional()
  })
  .strict();
export type FormStep = z.infer<typeof formStepSchema>;

export const formLayoutSchema = z
  .object({
    /** `sections`: one page of sections; `wizard`: ordered steps, each of one or more sections. */
    mode: z.enum(['sections', 'wizard']),
    sections: z.array(formSectionSchema).min(1).max(30),
    steps: z.array(formStepSchema).max(20).optional(),
    /** Wizard only: a last step that shows every answer before the submission. */
    review: z.boolean().optional()
  })
  .strict();
export type FormLayout = z.infer<typeof formLayoutSchema>;

export const formFieldSchema = z
  .object({
    field: nameSchema,
    /** Overrides the entity: a field the entity leaves optional can be required on this form. */
    required: z.boolean().optional(),
    label: z.string().max(200).optional(),
    help: z.string().max(500).optional(),
    visibleIf: formConditionSchema.optional(),
    /** Required only when this matches (and the field is shown). */
    requiredIf: formConditionSchema.optional()
  })
  .strict();
export type FormField = z.infer<typeof formFieldSchema>;

export const LAYOUT_LIMITS = { leavesPerCondition: 15, depth: 4, leavesPerForm: 300 } as const;
const NO_VALUE: string[] = ['exists', 'not_exists', 'truthy', 'falsy'];
const LIST_VALUE: string[] = ['in', 'not_in'];

/** The parts a definition needs here (`forms.ts` owns the full schema). */
export interface LayoutDefinition {
  version?: 1 | 2 | undefined;
  fields: FormField[];
  layout?: FormLayout | undefined;
}

// ---------- the evaluator (mirrored by web/js/form-layout.js) ----------

const isGroup = (c: Condition): c is { all: Condition[] } | { any: Condition[] } | { none: Condition[] } => 'all' in c || 'any' in c || 'none' in c;
const norm = (x: unknown): unknown => (typeof x === 'string' ? normText(x) : x);
const set = (v: unknown): boolean => v !== undefined && v !== null && v !== '';
const truthy = (v: unknown): boolean => v != null && v !== '' && v !== false && v !== 0;
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? NaN : Number(v));

function leafMet(l: Leaf, values: Values): boolean {
  const v = values[l.field];
  const want = l.value;
  switch (l.op) {
    case 'truthy':
      return truthy(v);
    case 'falsy':
      return !truthy(v);
    case 'exists':
      return set(v);
    case 'not_exists':
      return !set(v);
    case 'eq':
      return norm(v) === norm(want);
    case 'ne':
      return norm(v) !== norm(want);
    case 'in':
      return Array.isArray(want) && want.map(norm).includes(norm(v));
    case 'not_in':
      return Array.isArray(want) && !want.map(norm).includes(norm(v));
    case 'contains':
    case 'not_contains': {
      const w = norm(want);
      const has = Array.isArray(v) ? v.some((x) => norm(x) === w) : set(v) && set(want) && String(norm(v)).includes(String(w));
      return l.op === 'contains' ? has : !has;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = num(v);
      const b = num(want);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return l.op === 'gt' ? a > b : l.op === 'gte' ? a >= b : l.op === 'lt' ? a < b : a <= b;
    }
  }
}

/** Does a condition match the answers so far? No condition matches. */
export function conditionMatches(c: Condition | null | undefined, values: Values): boolean {
  if (!c) return true;
  if ('all' in c) return c.all.every((x) => conditionMatches(x, values));
  if ('any' in c) return c.any.some((x) => conditionMatches(x, values));
  if ('none' in c) return !c.none.some((x) => conditionMatches(x, values));
  return leafMet(c, values);
}

// ---------- the layout ----------

export const DEFAULT_SECTION = 'main';

/** The layout a definition is shown with: its own, or one untitled section with every field (a flat form). */
export function layoutOf(def: LayoutDefinition): { mode: 'sections' | 'wizard'; sections: FormSection[]; steps: FormStep[]; review: boolean } {
  if (!def.layout) return { mode: 'sections', sections: [{ id: DEFAULT_SECTION, fields: def.fields.map((f) => f.field) }], steps: [], review: false };
  return { mode: def.layout.mode, sections: def.layout.sections, steps: def.layout.mode === 'wizard' ? (def.layout.steps ?? []) : [], review: def.layout.mode === 'wizard' && !!def.layout.review };
}

/** The steps a layout runs through: its own in a wizard, else one implicit step of every section. */
function stepsOf(l: ReturnType<typeof layoutOf>): FormStep[] {
  return l.mode === 'wizard' ? l.steps : [{ id: '_page', title: 'Form', sections: l.sections.map((s) => s.id) }];
}

export interface PlannedField {
  field: string;
  step: string;
  section: string;
  visible: boolean;
  required: boolean;
}
export interface FormPlan {
  /** The answers a submission may write: visible fields only, in layout order. */
  values: Values;
  /** Input names not written: not on the form, or hidden by a condition. */
  dropped: string[];
  visible: string[];
  fields: PlannedField[];
  /** Visible steps in order (a sections form has one, `_page`). */
  steps: string[];
  /** Visible required fields without an answer. */
  missing: PlannedField[];
}

/**
 * One pass over the form in layout order: what is shown, what is required, and what a submission keeps. A step's
 * and a section's conditions read the answers before it; a field's read the answers before the field.
 */
export function planForm(def: LayoutDefinition, input: Values): FormPlan {
  const l = layoutOf(def);
  const byName = new Map(def.fields.map((f) => [f.field, f]));
  const sections = new Map(l.sections.map((s) => [s.id, s]));
  const values: Values = {};
  const fields: PlannedField[] = [];
  const steps: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  for (const step of stepsOf(l)) {
    const stepShown = conditionMatches(step.visibleIf, values);
    const stepRequired = !!step.requiredIf && stepShown && conditionMatches(step.requiredIf, values);
    if (stepShown) steps.push(step.id);
    for (const sid of step.sections) {
      const sec = sections.get(sid);
      if (!sec) continue;
      const secShown = stepShown && conditionMatches(sec.visibleIf, values);
      const secRequired = !!sec.requiredIf && secShown && conditionMatches(sec.requiredIf, values);
      for (const name of sec.fields) {
        const ff = byName.get(name);
        if (!ff) continue;
        const visible = secShown && conditionMatches(ff.visibleIf, values);
        const required = visible && (!!ff.required || stepRequired || secRequired || (!!ff.requiredIf && conditionMatches(ff.requiredIf, values)));
        fields.push({ field: name, step: step.id, section: sec.id, visible, required });
        if (visible && has(name)) values[name] = input[name];
      }
    }
  }
  const visible = fields.filter((f) => f.visible).map((f) => f.field);
  const dropped = Object.keys(input).filter((k) => !Object.prototype.hasOwnProperty.call(values, k));
  const missing = fields.filter((f) => f.required && (values[f.field] == null || values[f.field] === ''));
  return { values, dropped, visible, fields, steps, missing };
}

/** The visible required fields of one step still without an answer: the wizard's per-step check. */
export function stepProblems(def: LayoutDefinition, input: Values, step: string): PlannedField[] {
  return planForm(def, input).missing.filter((f) => f.step === step);
}

// ---------- design checks ----------

function leavesOf(c: Condition): Leaf[] {
  if ('all' in c) return c.all.flatMap(leavesOf);
  if ('any' in c) return c.any.flatMap(leavesOf);
  if ('none' in c) return c.none.flatMap(leavesOf);
  return [c];
}
function depthOf(c: Condition): number {
  if (!isGroup(c)) return 0;
  const kids = 'all' in c ? c.all : 'any' in c ? c.any : c.none;
  return 1 + Math.max(0, ...kids.map(depthOf));
}
function hasEmptyGroup(c: Condition): boolean {
  if (!isGroup(c)) return false;
  const kids = 'all' in c ? c.all : 'any' in c ? c.any : c.none;
  return !kids.length || kids.some(hasEmptyGroup);
}

/** Is this condition more than the one-leaf `visibleIf` a version 1 form could hold? */
export const isTreeCondition = (c: Condition | undefined): boolean => !!c && (isGroup(c) || !(LEGACY_OPS as readonly string[]).includes(c.op));

/** Every problem with a definition's layout and conditions; empty when it is sound. */
export function layoutProblems(def: LayoutDefinition): string[] {
  const out: string[] = [];
  const onForm = new Set(def.fields.map((f) => f.field));
  const l = layoutOf(def);
  let total = 0;
  const checkCondition = (c: Condition | undefined, where: string, earlier: Set<string>) => {
    if (!c) return;
    const ls = leavesOf(c);
    total += ls.length;
    if (ls.length > LAYOUT_LIMITS.leavesPerCondition) out.push(`${where}: at most ${LAYOUT_LIMITS.leavesPerCondition} comparisons (it has ${ls.length}).`);
    if (depthOf(c) > LAYOUT_LIMITS.depth) out.push(`${where}: groups nest at most ${LAYOUT_LIMITS.depth} deep.`);
    if (hasEmptyGroup(c)) out.push(`${where}: a group needs at least one comparison.`);
    for (const x of ls) {
      if (!onForm.has(x.field)) out.push(`${where} depends on ${x.field}, which is not on the form.`);
      else if (!earlier.has(x.field)) out.push(`${where} depends on ${x.field}, which must come earlier on the form.`);
      if (!(LEAF_OPS as readonly string[]).includes(x.op)) out.push(`${where}: ${x.op} is not a test.`);
      if (NO_VALUE.includes(x.op)) {
        if (x.value !== undefined) out.push(`${where}: ${x.field} ${x.op} takes no value.`);
      } else if (LIST_VALUE.includes(x.op)) {
        if (!Array.isArray(x.value) || !x.value.length) out.push(`${where}: ${x.field} ${x.op} takes a list of values.`);
      } else if (x.value === undefined || Array.isArray(x.value)) out.push(`${where}: ${x.field} ${x.op} takes one value.`);
    }
  };

  if (def.layout) {
    const ids = new Set<string>();
    const placed = new Map<string, string>();
    for (const s of l.sections) {
      if (ids.has(s.id)) out.push(`Section ${s.id} is on the form twice.`);
      ids.add(s.id);
      for (const f of s.fields) {
        if (!onForm.has(f)) out.push(`Section ${s.id} lists ${f}, which is not a field of the form.`);
        else if (placed.has(f)) out.push(`${f} is in sections ${placed.get(f)} and ${s.id}; a field belongs to one section.`);
        else placed.set(f, s.id);
      }
      if (s.collapsed && !s.collapsible) out.push(`Section ${s.id} starts collapsed but is not collapsible.`);
    }
    for (const f of def.fields) if (!placed.has(f.field)) out.push(`${f.field} is on the form but in no section.`);
    if (def.layout.mode === 'wizard') {
      if (!l.steps.length) out.push('A wizard needs at least one step.');
      const stepIds = new Set<string>();
      const inStep = new Map<string, string>();
      for (const st of l.steps) {
        if (stepIds.has(st.id)) out.push(`Step ${st.id} is on the form twice.`);
        stepIds.add(st.id);
        for (const sid of st.sections) {
          if (!ids.has(sid)) out.push(`Step ${st.id} lists section ${sid}, which does not exist.`);
          else if (inStep.has(sid)) out.push(`Section ${sid} is in steps ${inStep.get(sid)} and ${st.id}; a section belongs to one step.`);
          else inStep.set(sid, st.id);
        }
      }
      for (const s of l.sections) if (!inStep.has(s.id)) out.push(`Section ${s.id} is in no step.`);
    } else {
      if (def.layout.steps?.length) out.push('Steps need the wizard mode.');
      if (def.layout.review) out.push('A review step needs the wizard mode.');
    }
  }

  // Conditions read only what comes before them, in layout order.
  const byName = new Map(def.fields.map((f) => [f.field, f]));
  const sections = new Map(l.sections.map((s) => [s.id, s]));
  const earlier = new Set<string>();
  for (const st of stepsOf(l)) {
    checkCondition(st.visibleIf, `Step ${st.id} (visible if)`, new Set(earlier));
    checkCondition(st.requiredIf, `Step ${st.id} (required if)`, new Set(earlier));
    for (const sid of st.sections) {
      const sec = sections.get(sid);
      if (!sec) continue;
      checkCondition(sec.visibleIf, `Section ${sid} (visible if)`, new Set(earlier));
      checkCondition(sec.requiredIf, `Section ${sid} (required if)`, new Set(earlier));
      for (const name of sec.fields) {
        const ff = byName.get(name);
        if (!ff) continue;
        checkCondition(ff.visibleIf, name, new Set(earlier));
        checkCondition(ff.requiredIf, `${name} (required if)`, new Set(earlier));
        earlier.add(name);
      }
    }
  }
  if (total > LAYOUT_LIMITS.leavesPerForm) out.push(`A form has at most ${LAYOUT_LIMITS.leavesPerForm} comparisons in all (it has ${total}).`);
  return [...new Set(out)];
}

/**
 * The definition as stored: fields reordered into layout order (so the flat list reads as the form does, for the
 * workflow approval form and older clients), and version 2 when it uses anything a version 1 form could not hold.
 * A plain flat form is returned unchanged.
 */
export function normalizeDefinition<T extends LayoutDefinition>(def: T): T {
  const uses2 =
    !!def.layout ||
    def.fields.some((f) => f.requiredIf || isTreeCondition(f.visibleIf));
  if (!uses2) return def;
  let fields = def.fields;
  if (def.layout) {
    const l = layoutOf(def);
    const sec = new Map(l.sections.map((s) => [s.id, s]));
    const order = (l.mode === 'wizard' ? l.steps.flatMap((st) => st.sections) : l.sections.map((s) => s.id)).flatMap((sid) => sec.get(sid)?.fields ?? []);
    const rank = new Map(order.map((n, i) => [n, i]));
    fields = [...def.fields].sort((a, b) => (rank.get(a.field) ?? 1e6) - (rank.get(b.field) ?? 1e6));
  }
  return { ...def, version: 2, fields };
}
