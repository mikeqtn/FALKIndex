import type { Pool } from 'pg';
import type { ReviewAction } from '../src/accounts/contracts.ts';
import { pool } from './db.ts';
import { sendEmail } from './support.ts';

// Postmark sends from the verified falkindex.com domain. Replies reach the support inbox, which a person reads.
const FROM = 'FALK Index <notifications@falkindex.com>';
const REPLY_TO = 'support@falkindex.com';
const site = () => (process.env.PUBLIC_SITE_URL ?? 'https://falkindex.com').replace(/\/$/, '');

/** The email for one decision. Pure, so the wording is tested without Postmark. */
export function decisionEmail(d: { action: ReviewAction; username: string; subject: string; newWatch: boolean; note: string; record: string | null }) {
  const mine = `${site()}/account/contributions/`;
  const what = d.newWatch ? `your proposal for ${d.subject.replace(/^New watch: /, '')}` : `your correction to ${d.subject}`;
  const [subject, opening, next] = {
    request_info: [`A question about ${what}`, `An editor needs more information about ${what} before deciding.`,
      `Reply on My contributions: ${mine}`],
    approve: [d.newWatch ? `Your watch is live: ${d.subject.replace(/^New watch: /, '')}` : `Your correction was accepted`,
      d.newWatch ? `An editor accepted ${what}. It is now a FALK record.` : `An editor accepted ${what}.`,
      d.record ? `See it: ${site()}/records/${d.record}/` : `See the decision: ${mine}`],
    reject: [`Your submission was not accepted`, `An editor did not accept ${what}.`, `See the decision: ${mine}`],
  }[d.action];
  return {
    subject: `FALK Index: ${subject}`,
    text: `Hello @${d.username},\n\n${opening}\n\nThe editor's note:\n\n${d.note.split('\n').map(l => `> ${l}`).join('\n')}\n\n${next}\n\n`
      + `You get this email because you sent this to the FALK Index. Reply to it to reach FALK support.\n`,
  };
}

/**
 * Tell a member what an editor decided about their submission. Called after the decision is saved; it never throws,
 * so a mail outage cannot undo or fail a decision. Guests are never emailed: their address was typed into a form,
 * so it could belong to someone else.
 */
export async function notifyAuthor(submissionId: string, action: ReviewAction, note: string, record: string | null, db: Pick<Pool, 'query'> = pool) {
  try {
    const row = (await db.query(`SELECT a.username,x.email,s.watch_id,s.original_proposal,
        coalesce(s.original_proposal->>'proposedName',(SELECT (o.payload->>'name')||' '||(w.payload->>'model') FROM falk_watch w
          JOIN falk_organization o ON o.id=w.brand_id WHERE w.id=s.watch_id),s.watch_id,'a record') AS subject
      FROM falk_submission s JOIN falk_account a ON a.id=s.author_id JOIN falk_account_private x ON x.account_id=a.id
      WHERE s.id=$1 AND a.status='active' AND a.deleted_at IS NULL AND a.email_verified AND a.username IS NOT NULL`, [submissionId])).rows[0];
    if (!row) return false;
    const email = decisionEmail({ action, username: row.username, subject: row.subject, note, record,
      newWatch: row.original_proposal?.type === 'new_watch' });
    await sendEmail({ from: FROM, to: row.email, replyTo: REPLY_TO, ...email }, 'notify');
    return true;
  } catch {
    // sendEmail has logged the failure without the address or content.
    return false;
  }
}
