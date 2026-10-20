import { createHash } from 'node:crypto';
import { clerkClient, getAuth } from '@clerk/express';
import type { Request } from 'express';
import type { Pool, PoolClient } from 'pg';
import { pool, querySeries, transaction } from './db.ts';
import { profileInput, type Account, type MemberProfile, type ProfileInput, type Role, type PublicProfile } from '../src/accounts/contracts.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const realm = () => {
  if (!process.env.CLERK_PUBLISHABLE_KEY) throw new Error('Clerk is not configured');
  return createHash('sha256').update(process.env.CLERK_PUBLISHABLE_KEY).digest('hex');
};
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export function invitationRole(current: Role, invited: Role): Role {
  const authority = {contributor:0,editor:1,admin:2};
  // Invites may grant access, never silently demote an existing staff member.
  // Downgrades must use the explicit, last-admin-protected account controls.
  return authority[invited] >= authority[current] ? invited : current;
}
export function enforceAccount(account: Pick<Account,'role'|'status'|'emailVerified'>, roles?: readonly Role[]) {
  if (!account.emailVerified) throw new HttpError(403, 'Verify your email address before using a FALK account.');
  if (account.status !== 'active') throw new HttpError(403, 'This FALK account is suspended. Public browsing remains available.');
  if (roles && !roles.includes(account.role)) throw new HttpError(403, 'You do not have permission to perform this action.');
}
export async function audit(db: PoolClient, actor: string | null, target: string | null, action: string, reason: string, payload: object = {}) {
  await db.query('INSERT INTO falk_audit_event(actor_id,target_id,action,reason,payload) VALUES($1,$2,$3,$4,$5)', [actor,target,action,reason,payload]);
}
const accountSelect = `SELECT a.*,p.*,x.email,x.real_name FROM falk_account a
  JOIN falk_member_profile p ON p.account_id=a.id JOIN falk_account_private x ON x.account_id=a.id`;
function accountFrom(row: any): Account {
  return {
    id: row.id, username: row.username, role: row.role, status: row.status,
    createdAt: row.created_at.toISOString(), emailVerified: row.email_verified, onboarded: !!row.username,
    profile: {
      displayName: row.display_name, realName: row.real_name, showRealName: row.show_real_name,
      bio: row.bio, qualifications: row.qualifications, qualificationDetails: row.qualification_details,
      professionalAffiliations: row.professional_affiliations, website: row.website, imageUrl: row.image_url, brandTies: [],
    },
  };
}

// Identity verification comes from Clerk's server API, never a form/JWT custom role.
// Dev and production identities are partitioned, including the one-time admin grant.
export async function authenticatedAccount(req: Request, roles?: readonly Role[]) {
  const userId = getAuth(req).userId;
  if (!userId) throw new HttpError(401, 'Sign in to continue.');
  const identity = await clerkClient.users.getUser(userId);
  const primary = identity.emailAddresses.find(e => e.id === identity.primaryEmailAddressId);
  if (!primary || identity.banned || identity.locked) throw new HttpError(403, 'A verified, active email identity is required.');
  const verified = primary.verification?.status === 'verified';
  const email = normalizeEmail(primary.emailAddress);
  const account = await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`falk:roles:${realm()}`]);
    await db.query('INSERT INTO falk_account(realm,clerk_id,email_verified) VALUES($1,$2,$3) ON CONFLICT(clerk_id) DO UPDATE SET email_verified=EXCLUDED.email_verified', [realm(),userId,verified]);
    const row = (await db.query('SELECT * FROM falk_account WHERE clerk_id=$1 AND realm=$2 FOR UPDATE', [userId,realm()])).rows[0];
    if (!row) throw new HttpError(403, 'This identity belongs to a different authentication environment.');
    await db.query('INSERT INTO falk_account_private(account_id,email) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET email=EXCLUDED.email', [row.id,email]);
    await db.query('INSERT INTO falk_member_profile(account_id) VALUES($1) ON CONFLICT DO NOTHING', [row.id]);
    if (verified && row.status === 'active') {
      // All privileged role changes share this lock, including invitation acceptance.
      const invite = (await db.query(`SELECT * FROM falk_invitation WHERE realm=$1 AND email=$2 AND accepted_by IS NULL
        AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [realm(),email])).rows[0];
      if (invite) {
        // Revoking/suspending the inviter also stops an outstanding privileged invite.
        const inviter = (await db.query("SELECT 1 FROM falk_account WHERE id=$1 AND role='admin' AND status='active' AND realm=$2", [invite.created_by,realm()])).rowCount;
        if (inviter) {
          const grantedRole = invitationRole(row.role,invite.role);
          await db.query('UPDATE falk_account SET role=$2 WHERE id=$1', [row.id,grantedRole]);
          // Consume older invitations too, so a later request cannot replay an
          // older grant and undo the administrator's most recent choice.
          await db.query('UPDATE falk_invitation SET accepted_by=$3 WHERE realm=$1 AND email=$2 AND accepted_by IS NULL', [realm(),email,row.id]);
          await audit(db,invite.created_by,row.id,'invitation_accepted','Verified email matched an administrator invitation',{invitedRole:invite.role,role:grantedRole});
        }
      }
      const bootstrapEmail = process.env.FALK_BOOTSTRAP_ADMIN_EMAIL;
      if (bootstrapEmail && normalizeEmail(bootstrapEmail) === email) {
        const seeded = await db.query('INSERT INTO falk_bootstrap(realm,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING realm', [realm(),row.id]);
        if (seeded.rowCount) {
          await db.query("UPDATE falk_account SET role='admin' WHERE id=$1", [row.id]);
          await audit(db,null,row.id,'bootstrap_admin','One-time owner-configured verified administrator grant');
        }
      }
    }
    return accountFrom((await db.query(`${accountSelect} WHERE a.id=$1`, [row.id])).rows[0]);
  });
  enforceAccount(account,roles);
  account.profile.brandTies = (await pool.query('SELECT organization_id FROM falk_affiliation WHERE account_id=$1 AND ended_at IS NULL ORDER BY organization_id', [account.id])).rows.map(r => r.organization_id);
  return { account, email };
}

export async function saveProfile(actor: Account, input: ProfileInput) {
  const profile = profileInput.parse(input);
  const reserved = ['admin','administrator','falk','falkindex','moderator','support','account','system'];
  if (reserved.includes(profile.username)) throw new HttpError(400, 'That username is reserved.');
  const p: MemberProfile = profile;
  await transaction(async db => {
    const current = (await db.query('SELECT * FROM falk_account WHERE id=$1 FOR UPDATE', [actor.id])).rows[0];
    enforceAccount({role:current.role,status:current.status,emailVerified:current.email_verified});
    if (current.username && current.username !== profile.username) throw new HttpError(409, 'Your public username cannot be changed after it is registered.');
    const organizations = await db.query('SELECT id FROM falk_organization WHERE id=ANY($1)', [profile.brandTies]);
    if (organizations.rowCount !== new Set(profile.brandTies).size) throw new HttpError(400, 'Choose valid organizations for your disclosures.');
    await db.query('UPDATE falk_account SET username=$2 WHERE id=$1', [actor.id,profile.username]);
    await db.query('UPDATE falk_account_private SET real_name=$2 WHERE account_id=$1', [actor.id,p.realName]);
    await db.query(`UPDATE falk_member_profile SET display_name=$2,show_real_name=$3,bio=$4,qualifications=$5,
      qualification_details=$6,professional_affiliations=$7,website=$8,image_url=$9 WHERE account_id=$1`,
    [actor.id,p.displayName,p.showRealName,p.bio,[...new Set(p.qualifications)],p.qualificationDetails,p.professionalAffiliations,p.website,p.imageUrl]);
    await db.query('UPDATE falk_affiliation SET ended_at=now() WHERE account_id=$1 AND ended_at IS NULL AND NOT(organization_id=ANY($2))', [actor.id,p.brandTies]);
    for (const id of new Set(p.brandTies)) await db.query(`INSERT INTO falk_affiliation(account_id,organization_id)
      SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM falk_affiliation WHERE account_id=$1 AND organization_id=$2 AND ended_at IS NULL)`, [actor.id,id]);
    // Never put private names, emails, or authentication data into audit payloads.
    await audit(db,actor.id,actor.id,'profile_updated','Member updated profile and disclosure settings');
  });
}

export async function publicProfile(username: string, db: Pick<Pool,'query'> = pool): Promise<PublicProfile | null> {
  const row = (await db.query(`SELECT a.id,a.username,a.role,a.status,a.created_at,p.*,
    CASE WHEN p.show_real_name THEN x.real_name ELSE NULL END AS public_real_name
    FROM falk_account a JOIN falk_member_profile p ON p.account_id=a.id
    JOIN falk_account_private x ON x.account_id=a.id
    WHERE a.username=$1 AND a.realm=$2`, [username.toLowerCase(),realm()])).rows[0];
  if (!row) return null;
  const [ties, verifications, counts, contributions, actions] = await querySeries(db,[
    `SELECT o.id,o.payload->>'name' AS name FROM falk_affiliation f JOIN falk_organization o ON o.id=f.organization_id
      WHERE f.account_id=$1 AND f.ended_at IS NULL ORDER BY name`,
    `SELECT v.id,v.label,v.organization_id AS "organizationId",o.payload->>'name' AS "organizationName",
      v.evidence_url AS "evidenceUrl",v.verified_at AS "verifiedAt" FROM falk_professional_verification v
      LEFT JOIN falk_organization o ON o.id=v.organization_id WHERE v.account_id=$1 AND v.revoked_at IS NULL ORDER BY v.verified_at`,
    'SELECT status,count(*)::int AS count FROM falk_submission WHERE author_id=$1 GROUP BY status',
    `SELECT id,watch_id AS target,created_at AS "createdAt" FROM falk_revision WHERE actor_id=$1 AND kind<>'import' ORDER BY created_at DESC LIMIT 100`,
    `SELECT id,action,created_at AS "createdAt",payload->>'record' AS target FROM falk_audit_event
      WHERE actor_id=$1 AND public=true ORDER BY created_at DESC LIMIT 100`,
  ],[row.id]);
  const count = (status: string) => counts.rows.find(r => r.status === status)?.count ?? 0;
  return {
    username:row.username, displayName:row.display_name, realName:row.public_real_name,
    role:row.role,status:row.status, createdAt:row.created_at.toISOString(), bio:row.bio, qualifications:row.qualifications,
    qualificationDetails:row.qualification_details, professionalAffiliations:row.professional_affiliations,
    website:row.website,imageUrl:row.image_url,brandTies:ties.rows,verifications:verifications.rows,
    acceptedCount:count('approved'),pendingCount:count('pending')+count('needs_info'),rejectedCount:count('rejected'),
    contributions:contributions.rows.map(r => ({id:r.id,title:r.target,url:`/records/${r.target}/`,createdAt:r.createdAt.toISOString()})),
    editorialActions:actions.rows,
  };
}
