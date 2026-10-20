import { clerkClient } from '@clerk/express';
import { z } from 'zod';
import { pool, transaction } from '../server/db.ts';
import { audit, normalizeEmail, realm } from '../server/accounts.ts';

// Explicit owner tool. Use target-environment keys/database; never copy a dev
// Clerk ID or password into production. Normal verified sign-in performs the
// same one-time grant if the identity does not yet exist when this script runs.
try {
  const configured = process.env.FALK_BOOTSTRAP_ADMIN_EMAIL;
  if (!configured) throw new Error('Configure FALK_BOOTSTRAP_ADMIN_EMAIL privately before bootstrapping an administrator.');
  const email = normalizeEmail(z.email().parse(configured));
  const identities = await clerkClient.users.getUserList({emailAddress:[email],limit:2});
  const identity = identities.data.find(user => !user.banned && !user.locked && user.emailAddresses.some(address =>
    address.id === user.primaryEmailAddressId && normalizeEmail(address.emailAddress) === email && address.verification?.status === 'verified'));
  if (!identity) throw new Error('No active, verified matching identity exists in this environment. Complete registration and verification first.');
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`falk:roles:${realm()}`]);
    await db.query('INSERT INTO falk_account(realm,clerk_id,email_verified) VALUES($1,$2,true) ON CONFLICT(clerk_id) DO NOTHING', [realm(),identity.id]);
    const row = (await db.query("SELECT * FROM falk_account WHERE clerk_id=$1 AND realm=$2 AND status='active' FOR UPDATE", [identity.id,realm()])).rows[0];
    if (!row) throw new Error('The configured account is suspended or belongs to another environment.');
    await db.query('INSERT INTO falk_account_private(account_id,email) VALUES($1,$2) ON CONFLICT DO NOTHING', [row.id,email]);
    await db.query('INSERT INTO falk_member_profile(account_id) VALUES($1) ON CONFLICT DO NOTHING', [row.id]);
    const seed = await db.query('INSERT INTO falk_bootstrap(realm,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING realm', [realm(),row.id]);
    if (seed.rowCount) {
      await db.query("UPDATE falk_account SET role='admin',email_verified=true WHERE id=$1", [row.id]);
      await audit(db,null,row.id,'bootstrap_admin','One-time explicit owner-configured verified administrator grant');
      console.log('Initial administrator configured for this authentication environment.');
    } else console.log('Administrator bootstrap was already consumed; existing grants and revocations were left unchanged.');
  });
} finally { await pool.end(); }
