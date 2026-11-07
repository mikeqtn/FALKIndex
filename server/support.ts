import { z } from 'zod';
import { HttpError } from './accounts.ts';

const SUPPORT_TO = 'support@falkindex.com';
// Postmark sends only from a verified domain, so this must stay on falkindex.com. Replies go to the visitor (ReplyTo).
const SUPPORT_FROM = 'FALK Index <help-form@falkindex.com>';
const TOPICS = { account:'Account or sign-in', forum:'The forum', website:'Something on the site', other:'Something else' } as const;

export const supportInput = z.object({
  topic: z.enum(['account','forum','website','other']),
  message: z.string().trim().min(1).max(5000),
  email: z.email().max(254),
  _gotcha: z.string().max(0).optional().default(''),
}).strict();

const unavailable = () => new HttpError(503,'The help form is not working right now.');

/**
 * Forward a help-form message to the support inbox. It is not stored here, and nothing is ever sent to the address the
 * visitor typed, so the form cannot be used to email a stranger.
 */
export const sendSupportMessage = (input: z.infer<typeof supportInput>) => emailSupportInbox(
  `Help form: ${TOPICS[input.topic]}`,`From: ${input.email}\nTopic: ${TOPICS[input.topic]}\n\n${input.message}`,input.email);

/** Email the support inbox. Logs never include the content or an address. */
export const emailSupportInbox = (subject: string, text: string, replyTo?: string) =>
  sendEmail({ from:SUPPORT_FROM, to:SUPPORT_TO, subject, text, replyTo }, 'support');

/**
 * Send one plain-text email through Postmark. The site sends only to its own support inbox and to a member's own
 * verified account address (server/notify.ts), never to an address typed into a form. Throws a 503 on failure;
 * `scope` names the log events.
 */
export async function sendEmail(message: { from: string; to: string; subject: string; text: string; replyTo?: string }, scope: string) {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) { console.error(JSON.stringify({ event:`${scope}.not_configured` })); throw unavailable(); }
  let response: Response;
  try {
    response = await fetch('https://api.postmarkapp.com/email',{
      method:'POST',
      headers:{ 'Content-Type':'application/json', Accept:'application/json', 'X-Postmark-Server-Token':token },
      body:JSON.stringify({
        From:message.from, To:message.to, ...(message.replyTo ? { ReplyTo:message.replyTo } : {}),
        // A subject is one line; a member-written watch name must not add a header.
        Subject:message.subject.replace(/[\r\n]+/g,' '), TextBody:message.text,
        MessageStream:'outbound', TrackOpens:false, TrackLinks:'None',
      }),
      signal:AbortSignal.timeout(10000),
    });
  } catch (error: any) {
    console.error(JSON.stringify({ event:`${scope}.send_failed`, errorName:error?.name ?? 'Error' }));
    throw unavailable();
  }
  if (!response.ok) {
    const errorCode = await response.json().then(body => body?.ErrorCode).catch(() => undefined);
    console.error(JSON.stringify({ event:`${scope}.send_failed`, status:response.status, errorCode }));
    throw unavailable();
  }
}
