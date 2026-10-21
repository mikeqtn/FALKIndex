import { clerkClient } from '@clerk/express';
import { Router } from 'express';
import { z } from 'zod';
import { ROLES, type Role } from '../src/accounts/contracts.ts';
import { pool, transaction } from './db.ts';
import { authenticatedAccount, audit, enforceAccount, HttpError, normalizeEmail, realm } from './accounts.ts';

const reason = z.string().trim().min(10, 'Explain the reason in at least 10 characters').max(2000);
const uuid = z.uuid();
export const adminAccountQuery = z.object({
  search:z.string().max(100).default(''),
  role:z.preprocess(value => value === '' ? undefined : value,z.enum(ROLES).optional()),
  status:z.preprocess(value => value === '' ? undefined : value,z.enum(['active','suspended']).optional()),
  page:z.coerce.number().int().min(1).max(100000).default(1),
});
const selection = `SELECT a.id,a.username,a.role,a.status,a.email_verified AS "emailVerified",
  a.created_at AS "createdAt",p.display_name AS "displayName",x.email
  FROM falk_account a JOIN falk_member_profile p ON p.account_id=a.id
  JOIN falk_account_private x ON x.account_id=a.id`;
export function protectLastAdmin(current: {role:string;status:string}, next: {role:string;status:string}, activeAdmins: number) {
  if (current.role === 'admin' && current.status === 'active' &&
    (next.role !== 'admin' || next.status !== 'active') && activeAdmins <= 1) {
    throw new HttpError(409, 'You cannot remove or suspend the last active administrator.');
  }
}
const admin = Router();
admin.use(async (req,res,next) => {
  const { account } = await authenticatedAccount(req,['admin']);
  res.locals.account = account;
  next();
});
admin.get('/accounts', async (req,res) => {
  const query = adminAccountQuery.parse(req.query);
  // Search text is literal: % and _ must not act as wildcards.
  const values = [realm(),`%${query.search.replace(/[\\%_]/g,'\\$&')}%`,query.role ?? null,query.status ?? null];
  const where = `WHERE a.realm=$1 AND (coalesce(a.username,'') ILIKE $2 OR p.display_name ILIKE $2 OR x.email ILIKE $2)
    AND ($3::text IS NULL OR a.role=$3) AND ($4::text IS NULL OR a.status=$4)`;
  const [members, count] = await Promise.all([
    pool.query(`${selection} ${where} ORDER BY a.created_at DESC,a.id LIMIT 25 OFFSET $5`, [...values,(query.page-1)*25]),
    pool.query(`SELECT count(*)::int AS count FROM falk_account a
      JOIN falk_member_profile p ON p.account_id=a.id JOIN falk_account_private x ON x.account_id=a.id ${where}`, values),
  ]);
  res.json({accounts:members.rows,total:count.rows[0].count,page:query.page});
});
admin.get('/accounts/:id', async (req,res) => {
  const id = uuid.parse(req.params.id);
  const row = (await pool.query(`${selection} WHERE a.id=$1 AND a.realm=$2`, [id,realm()])).rows[0];
  if (!row) throw new HttpError(404,'Account not found.');
  const [verifications, events] = await Promise.all([
    pool.query(`SELECT id,label,organization_id AS "organizationId",evidence_url AS "evidenceUrl",verified_at AS "verifiedAt"
      FROM falk_professional_verification WHERE account_id=$1 AND revoked_at IS NULL ORDER BY verified_at`, [id]),
    pool.query('SELECT id,action,created_at AS "createdAt",reason FROM falk_audit_event WHERE target_id=$1 ORDER BY created_at DESC LIMIT 100', [id]),
  ]);
  res.json({account:row,verifications:verifications.rows,audit:events.rows});
});
admin.patch('/accounts/:id', async (req,res) => {
  const id = uuid.parse(req.params.id);
  const input = z.object({role:z.enum(ROLES).optional(),status:z.enum(['active','suspended']).optional(),reason}).strict()
    .refine(p => !!p.role || !!p.status,'Choose a role or status change').parse(req.body);
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`falk:roles:${realm()}`]);
    const actor = (await db.query('SELECT role,status,email_verified AS "emailVerified" FROM falk_account WHERE id=$1 FOR UPDATE', [res.locals.account.id])).rows[0];
    enforceAccount(actor,['admin']);
    const target = (await db.query('SELECT * FROM falk_account WHERE id=$1 AND realm=$2 FOR UPDATE', [id,realm()])).rows[0];
    if (!target) throw new HttpError(404,'Account not found.');
    const next = {role:input.role ?? target.role,status:input.status ?? target.status};
    const count = Number((await db.query("SELECT count(*) FROM falk_account WHERE realm=$1 AND role='admin' AND status='active'", [realm()])).rows[0].count);
    protectLastAdmin(target,next,count);
    await db.query('UPDATE falk_account SET role=$2,status=$3 WHERE id=$1', [id,next.role,next.status]);
    await audit(db,res.locals.account.id,id,'account_permissions_changed',input.reason,{before:{role:target.role,status:target.status},after:next});
  });
  // Local RBAC invalidates access immediately on every protected request;
  // suspension does not prevent anonymous reading or destroy contributions.
  res.json({ok:true});
});
admin.post('/invitations', async (req,res) => {
  const input = z.object({email:z.email().max(254),role:z.enum(ROLES),reason}).strict().parse(req.body);
  const email = normalizeEmail(input.email);
  const existing = await pool.query(`SELECT 1 FROM falk_account_private p JOIN falk_account a ON a.id=p.account_id
    WHERE p.email=$1 AND a.realm=$2`, [email,realm()]);
  if (existing.rowCount) throw new HttpError(409,'This person already has a FALK account. Change their role using the account controls.');
  await createInvitation(res.locals.account.id,{...input,email},`${req.get('origin')}/sign-up`);
  res.status(201).json({ok:true});
});
type InvitationProvider = Pick<typeof clerkClient.invitations,'createInvitation'|'revokeInvitation'>;
/**
 * The email can only go out once the inviter is confirmed inside the role lock, so it is sent
 * before the row is saved. If saving or committing then fails, the email has already gone with
 * no role behind it: revoke it, so its link stops working and the admin can simply invite again.
 */
export async function createInvitation(actorId: string, input: {email: string; role: Role; reason: string}, redirectUrl: string,
  provider: InvitationProvider = clerkClient.invitations, run: typeof transaction = transaction) {
  let sent: string | undefined;
  try {
    await run(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`falk:roles:${realm()}`]);
      const actor = (await db.query('SELECT role,status,email_verified AS "emailVerified" FROM falk_account WHERE id=$1 FOR UPDATE', [actorId])).rows[0];
      enforceAccount(actor,['admin']);
      sent = (await provider.createInvitation({emailAddress:input.email,redirectUrl,expiresInDays:7})).id;
      await db.query(`INSERT INTO falk_invitation(realm,email,role,created_by,provider_id,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+interval '7 days')`, [realm(),input.email,input.role,actorId,sent]);
      await audit(db,actorId,null,'invitation_created',input.reason,{role:input.role});
    });
  } catch (error) {
    if (sent) await provider.revokeInvitation(sent).catch(() => console.error('Could not revoke an unrecorded invitation',sent));
    throw error;
  }
}
const verificationInput = z.object({
  label:z.string().trim().min(3).max(150),organizationId:z.string().max(100).nullable(),
  evidenceUrl:z.url().max(2000).refine(s => /^https?:\/\//i.test(s),'Use an http(s) evidence URL'),reason,
}).strict();
admin.post('/accounts/:id/verifications', async (req,res) => {
  const id = uuid.parse(req.params.id);
  const input = verificationInput.parse(req.body);
  if (id === res.locals.account.id) throw new HttpError(403,'Another administrator must verify your professional credentials.');
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`falk:roles:${realm()}`]);
    const actor = (await db.query('SELECT role,status,email_verified AS "emailVerified" FROM falk_account WHERE id=$1', [res.locals.account.id])).rows[0];
    enforceAccount(actor,['admin']);
    if (!(await db.query('SELECT 1 FROM falk_account WHERE id=$1 AND realm=$2', [id,realm()])).rowCount) throw new HttpError(404,'Account not found.');
    if (input.organizationId && !(await db.query('SELECT 1 FROM falk_organization WHERE id=$1', [input.organizationId])).rowCount) throw new HttpError(400,'Organization not found.');
    await db.query(`INSERT INTO falk_professional_verification(account_id,label,organization_id,evidence_url,verified_by)
      VALUES($1,$2,$3,$4,$5)`, [id,input.label,input.organizationId,input.evidenceUrl,res.locals.account.id]);
    await audit(db,res.locals.account.id,id,'professional_verification_added',input.reason,{label:input.label});
  });
  res.status(201).json({ok:true});
});
admin.delete('/accounts/:id/verifications/:verificationId', async (req,res) => {
  const id = uuid.parse(req.params.id);
  const verificationId = uuid.parse(req.params.verificationId);
  const input = z.object({reason}).strict().parse(req.body);
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`falk:roles:${realm()}`]);
    const actor = (await db.query('SELECT role,status,email_verified AS "emailVerified" FROM falk_account WHERE id=$1', [res.locals.account.id])).rows[0];
    enforceAccount(actor,['admin']);
    const changed = await db.query(`UPDATE falk_professional_verification v SET revoked_at=now(),revocation_reason=$3
      FROM falk_account a WHERE v.id=$1 AND v.account_id=$2 AND v.revoked_at IS NULL AND a.id=v.account_id AND a.realm=$4 RETURNING v.id`,
    [verificationId,id,input.reason,realm()]);
    if (!changed.rowCount) throw new HttpError(404,'Verification not found.');
    await audit(db,res.locals.account.id,id,'professional_verification_revoked',input.reason,{verificationId});
  });
  res.json({ok:true});
});
export default admin;
