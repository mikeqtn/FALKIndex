import { z } from 'zod';

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
  website: httpUrl, imageUrl: httpUrl, brandTies: z.array(z.string().max(100)).max(50),
}).strict();
export type ProfileInput = z.infer<typeof profileInput>;
export type MemberProfile = Omit<ProfileInput, 'username'>;
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
  events: { id: string; action: ReviewAction; note: string; createdAt: string; actor: string }[];
}
