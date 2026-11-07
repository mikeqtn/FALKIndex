import { z } from 'zod';

// In the browser, Zod probes for `new Function` to speed up parsing; the script policy forbids eval, so the probe
// files a CSP violation report on every account page. Skip the probe there. The server keeps the faster path.
if (typeof window !== 'undefined') z.config({ jitless: true });

export const ROLES = ['contributor', 'editor', 'admin'] as const;
export type Role = typeof ROLES[number];
export const qualificationOptions = [
  ['collector', 'Watch collector'], ['dealer', 'Watch dealer'],
  ['watchmaker', 'Watchmaker'], ['brand_representative', 'Brand employee / representative'],
  ['journalist', 'Journalist / author'], ['content_creator', 'Blogger / content creator'],
  ['industry_professional', 'Industry professional'], ['enthusiast', 'Enthusiast'], ['other', 'Other'],
].map(([value, label]) => ({ value, label }));
const text = (max: number) => z.string().trim().max(max);
const httpUrl = z.union([z.literal(''), z.url().max(2000).refine(s => /^https?:\/\//i.test(s), 'Use an https:// or http:// URL')]);
export const profileInput = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,29}$/, 'Use 3–30 lowercase letters, numbers or underscores; begin with a letter'),
  displayName: text(100), realName: text(150), showRealName: z.boolean(),
  bio: text(2000), qualifications: z.array(z.enum(qualificationOptions.map(q => q.value))).max(9),
  qualificationDetails: text(1500), professionalAffiliations: text(1500),
  website: httpUrl, brandTies: z.array(z.string().max(100)).max(50),
}).strict();
export type ProfileInput = z.infer<typeof profileInput>;
/** The photo is never typed in: it is copied from the member's Clerk account on sign-in. */
export type MemberProfile = Omit<ProfileInput, 'username'> & { imageUrl: string };
/** Only Clerk-hosted photos are shown, so viewing a profile never contacts a member-chosen server. */
export const isClerkImage = (url: string) => /^https:\/\/img\.clerk\.com\//.test(url);
export interface Account {
  id: string; username: string | null; role: Role; status: 'active' | 'suspended';
  createdAt: string; emailVerified: boolean; onboarded: boolean; profile: MemberProfile;
}
export interface Verification {
  id: string; label: string; organizationId: string | null;
  organizationName?: string; evidenceUrl: string; verifiedAt: string;
}
export interface PublicProfile {
  username: string; displayName: string; realName: string | null; role: Role;
  status: 'active' | 'suspended';
  createdAt: string; bio: string; qualifications: string[]; qualificationDetails: string;
  professionalAffiliations: string; website: string; imageUrl: string;
  brandTies: { id: string; name: string }[]; verifications: Verification[];
  acceptedCount: number; pendingCount: number; rejectedCount: number;
  contributions: { id: string; title: string; url: string; createdAt: string }[];
  editorialActions: { id: string; action: string; createdAt: string; target: string | null }[];
}
export interface AdminMember {
  id: string; username: string | null; displayName: string; email: string;
  role: Role; status: 'active' | 'suspended'; emailVerified: boolean; createdAt: string;
}
export const REVIEW_STATUSES = ['pending', 'needs_info', 'approved', 'rejected', 'withdrawn'] as const;
export type ReviewStatus = typeof REVIEW_STATUSES[number];
export const REVIEW_ACTIONS = ['approve', 'reject', 'request_info'] as const;
export type ReviewAction = typeof REVIEW_ACTIONS[number];
export const reviewStatusLabels: Record<ReviewStatus, string> = {
  pending: 'Pending', needs_info: 'Information requested', approved: 'Accepted',
  rejected: 'Rejected', withdrawn: 'Withdrawn',
};
/** What a member sends to propose a new watch (DECISIONS.md Q16). Scores and the archetype are not asked for. */
export const SOURCE_TYPES = ['manufacturer', 'workshop', 'supplier_disclosure', 'technical_interview', 'specialist_reference', 'press', 'other'] as const;
export const DIMENSION_CODES = ['MA', 'MM', 'EX', 'DH', 'CF', 'WE', 'PD'] as const;
export const NEW_BRAND_KINDS = ['brand', 'atelier', 'individual'] as const;
const webUrl = z.url().max(2000).refine(s => /^https?:\/\//i.test(s), 'Use an https:// or http:// URL');
const year = z.number().int().min(1700).max(2100);
export const newWatchInput = z.object({
  // An existing organization by id, or a brand FALK does not list yet.
  brand: z.union([
    z.object({ id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/) }).strict(),
    z.object({
      name: text(120).min(1), kind: z.enum(NEW_BRAND_KINDS),
      country: z.union([z.literal(''), z.string().regex(/^[A-Z]{2}$/, 'Two-letter country code, e.g. CH')]).optional(),
      website: z.union([z.literal(''), webUrl]).optional(),
    }).strict(),
  ]),
  model: text(120).min(1),
  reference: text(120).optional(), generation: text(120).optional(), caliber: text(120).optional(),
  productionStart: year.optional(), productionEnd: year.optional(),
  notes: text(2000).optional(),
  claims: z.array(z.object({
    statement: text(1000).min(10, 'Write the fact in at least 10 characters'),
    excerpt: text(1000).optional(),
    url: webUrl, title: text(300).optional(),
    sourceType: z.enum(SOURCE_TYPES),
    dimensions: z.array(z.enum(DIMENSION_CODES)).min(1, 'Choose at least one dimension').max(7),
  }).strict()).min(1, 'Add at least one sourced fact').max(20),
  explanation: text(5000).min(10, 'Explain the addition in at least 10 characters'),
}).strict().refine(w => !w.productionStart || !w.productionEnd || w.productionStart <= w.productionEnd,
  { message: 'Production cannot end before it starts', path: ['productionEnd'] });
export type NewWatchInput = z.infer<typeof newWatchInput>;
export interface ReviewSummary {
  id: string; status: ReviewStatus; createdAt: string; targetKind: string;
  record: { id: string; name: string } | null; subject: string;
  submitter: { kind: 'guest' | 'member'; label: string };
  excerpt: string; evidenceCount: number;
}
/** Editor-only view. Guest contact details never leave the review API. */
export interface ReviewDetail extends ReviewSummary {
  explanation: string; evidence: string[]; submitterRole: string | null;
  contact: { name: string | null; email: string | null } | null;
  authorUsername: string | null; staleBase: boolean;
  conflicts: string[]; selfAuthored: boolean;
  /** Set for a new-watch proposal: what was sent, and the record id it will publish to. */
  proposal: { proposedId: string; input: NewWatchInput } | null;
  events: { id: string; action: ReviewAction; note: string; createdAt: string; actor: string }[];
}
