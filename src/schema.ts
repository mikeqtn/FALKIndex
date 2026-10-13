// Single type source for data/. Every object is .strict(): an unknown key (e.g. a "total") is a validation error.
import { z } from 'zod';

export const DIMENSIONS = ['MA', 'MM', 'EX', 'DH', 'CF', 'WE', 'PD'] as const;
const dimension = z.enum(DIMENSIONS);
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case slug');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const year = z.number().int().min(1700).max(2100);
const level = z.number().int().min(0).max(5);

export const Methodology = z.object({
  code: z.string(),
  published_on: date,
  notes: z.string().optional(),
  rules: z.array(z.object({ name: z.string(), meaning: z.string() }).strict()),
  dimensions: z.array(z.object({
    code: dimension,
    name: z.string(),
    question: z.string(),
    levels: z.record(z.string(), z.string()).refine(l => Object.keys(l).join() === '0,1,2,3,4,5', 'levels 0–5'),
  }).strict()).length(7),
  classifications: z.array(z.object({
    code: z.string().regex(/^[a-z_]+$/),
    name: z.string(),
    kind: z.enum(['archetype', 'descriptor']),
    definition: z.string(),
  }).strict()),
  confidence: z.object({ A: z.string(), B: z.string(), C: z.string(), D: z.string() }).strict(),
}).strict();

export const Organization = z.object({
  id: slug,
  name: z.string(),
  kind: z.enum(['brand', 'supplier', 'group', 'atelier', 'individual']),
  parent: slug.optional(),
  ownership: z.enum(['independent', 'group', 'unknown']).default('unknown'),
  scale: z.enum(['individual', 'small', 'medium', 'industrial', 'unknown']).default('unknown'),
  country: z.string().length(2).optional(),
  website: z.string().url().optional(),
  notes: z.string().optional(),
}).strict();

export const Source = z.object({
  id: slug,
  url: z.string().url(),
  archived_url: z.string().url().optional(),
  title: z.string().optional(),
  publisher: slug.optional(),
  source_type: z.enum(['manufacturer', 'workshop', 'supplier_disclosure', 'technical_interview', 'specialist_reference', 'press', 'other']),
  tier: z.enum(['primary', 'secondary']),
  published_on: date.optional(),
  notes: z.string().optional(),
}).strict();

const Claim = z.object({
  id: slug,
  statement: z.string(),
  excerpt: z.string().optional(),
  source: slug,
  dimensions: z.array(dimension).min(1),
  date_checked: date,
  editor: z.string(),
  status: z.enum(['active', 'disputed', 'superseded']).default('active'),
  superseded_by: slug.optional(),
}).strict();

const ProvenanceEntry = z.object({
  dimension,
  component: z.string(),
  performer: slug.optional(), // absent = unknown
  relationship: z.enum(['internal', 'in_group', 'external_specialist', 'contract', 'unknown']),
  valid_from: year.optional(),
  valid_to: year.optional(),
  note: z.string().optional(),
  claims: z.array(slug).default([]),
}).strict();

const Score = z.object({
  value: level.nullable(), // null = U, never 0
  rationale: z.string().optional(),
  evidence: z.array(z.object({
    claim: slug,
    stance: z.enum(['supports', 'contradicts', 'context']),
    note: z.string(),
  }).strict()).default([]),
}).strict();

const Profile = z.object({
  version: z.number().int().min(1),
  methodology: z.string(),
  confidence: z.enum(['A', 'B', 'C', 'D']),
  independent_watchmaker: z.boolean().default(false),
  status: z.enum(['draft', 'published', 'superseded']),
  is_seed: z.boolean().default(false),
  seed_label: z.string().optional(), // original free-text label from the handbook, kept for audit (F1)
  editor: z.string(),
  change_note: z.string().min(1),
  created_on: date,
  scores: z.object(Object.fromEntries(DIMENSIONS.map(d => [d, Score])) as Record<typeof DIMENSIONS[number], typeof Score>).strict(),
  classification: z.array(z.string()).min(1), // rank order: [0] is rank 1
}).strict();

export const Watch = z.object({
  id: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, 'brand/model slug'),
  brand: slug,
  model: z.string(),
  reference: z.string().optional(),
  generation: z.string().optional(),
  caliber: z.string().optional(),
  route_label: z.string().optional(),
  production_start: year.optional(),
  production_end: year.optional(),
  notes: z.string().optional(),
  provenance: z.array(ProvenanceEntry).default([]),
  claims: z.array(Claim).default([]),
  profiles: z.array(Profile).min(1),
}).strict();

export type Methodology = z.infer<typeof Methodology>;
export type Organization = z.infer<typeof Organization>;
export type Source = z.infer<typeof Source>;
export type Watch = z.infer<typeof Watch>;
