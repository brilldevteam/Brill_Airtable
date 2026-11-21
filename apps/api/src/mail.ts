/**
 * Outgoing email.
 *
 *  - "log" (default outside production): prints each email to the console and keeps the last
 *    50 in memory, readable at GET /api/dev/mail and on the /dev/mail page — no email account needed.
 *  - "resend": sends through Resend's HTTP API (RESEND_API_KEY, MAIL_FROM).
 *
 * Adding another provider (Postmark, SES, SMTP) means writing one more `send` function.
 */

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface SentEmail extends Email {
  id: number;
  sentAt: string;
}
export interface Mailer {
  send(email: Email): Promise<void>;
  /** Only the dev "log" mailer keeps an outbox. */
  outbox?: SentEmail[];
}

export function logMailer(opts: { quiet?: boolean } = {}): Mailer {
  const outbox: SentEmail[] = [];
  let n = 0;
  return {
    outbox,
    async send(email) {
      outbox.unshift({ ...email, id: ++n, sentAt: new Date().toISOString() });
      outbox.length = Math.min(outbox.length, 50);
      if (!opts.quiet) console.log(`\n✉  To: ${email.to}\n   Subject: ${email.subject}\n${email.text.replace(/^/gm, "   ")}\n`);
    },
  };
}

export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(email) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${(await res.text()).slice(0, 300)}`);
    },
  };
}

export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  const provider = env.MAIL_PROVIDER ?? (env.RESEND_API_KEY ? "resend" : "log");
  if (provider === "resend") {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error("MAIL_PROVIDER=resend needs RESEND_API_KEY and MAIL_FROM");
    console.log(`Email: sending through Resend as ${env.MAIL_FROM}`);
    return resendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  }
  if (provider !== "log") throw new Error(`Unknown MAIL_PROVIDER "${provider}"`);
  if (env.NODE_ENV === "production") console.warn("MAIL_PROVIDER is 'log' in production — emails are only printed, not sent.");
  return logMailer();
}

// ---------------- templates ----------------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function layout(heading: string, paragraphs: string[], button: { label: string; url: string }, footer: string): Pick<Email, "text" | "html"> {
  const text = [heading, "", ...paragraphs, "", `${button.label}: ${button.url}`, "", footer].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e4e4e7;border-radius:14px;overflow:hidden">
<tr><td style="height:6px;background:linear-gradient(90deg,#6366f1,#8b5cf6,#ec4899)"></td></tr>
<tr><td style="padding:28px 32px 8px"><div style="font-weight:700;font-size:15px;color:#4f46e5">Brill Tables</div>
<h1 style="font-size:21px;margin:18px 0 8px;letter-spacing:-0.01em">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.55;color:#3f3f46;margin:0 0 12px">${esc(p)}</p>`).join("")}
<p style="margin:22px 0 26px"><a href="${esc(button.url)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 20px;border-radius:9px">${esc(button.label)}</a></p>
<p style="font-size:12.5px;line-height:1.5;color:#71717a;margin:0 0 24px">${esc(footer)}<br>Or paste this link into your browser: <span style="word-break:break-all">${esc(button.url)}</span></p>
</td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}

export const emails = {
  changeEmail: (to: string, name: string, url: string): Email => ({
    to,
    subject: "Confirm your new email for Brill Tables",
    ...layout(`Confirm your new email`, [`Hi ${name}, please confirm that ${to} is the new email address for your Brill Tables account.`],
      { label: "Confirm new email", url }, "This link expires in 24 hours. Until you confirm, your account keeps its old email. If you didn't ask for this, ignore this email."),
  }),
  emailChangeNotice: (to: string, name: string, newEmail: string, appUrl = ""): Email => ({
    to,
    subject: "Your Brill Tables email is being changed",
    ...layout(`Email change requested`, [`Hi ${name}, someone signed in to your account asked to change its email to ${newEmail}. It only changes once that address is confirmed.`, "If this wasn't you, change your password now and sign out of other devices in Account settings."],
      { label: "Open Brill Tables", url: appUrl || "https://" }, "You're getting this because it's the current email on the account."),
  }),
  verify: (to: string, name: string, url: string): Email => ({
    to,
    subject: "Confirm your email for Brill Tables",
    ...layout(`Welcome, ${name}!`, ["Please confirm this is your email address. It keeps your account secure and lets you join teams that invite you."],
      { label: "Confirm email", url }, "This link expires in 24 hours. If you didn't create an account, you can ignore this email."),
  }),
  reset: (to: string, name: string, url: string): Email => ({
    to,
    subject: "Reset your Brill Tables password",
    ...layout(`Reset your password`, [`Hi ${name}, someone (hopefully you) asked to reset the password for this account.`],
      { label: "Choose a new password", url }, "This link expires in 1 hour and works once. If you didn't ask for this, ignore this email — your password won't change."),
  }),
  baseInvite: (to: string, inviter: string, base: string, role: string, url: string): Email => ({
    to,
    subject: `${inviter} shared “${base}” with you on Brill Tables`,
    ...layout(`Join “${base}”`, [`${inviter} invited you to the “${base}” base as ${role}. You'll see only this base.`],
      { label: "Open the base", url }, "This invite works only for this email address and expires in 14 days."),
  }),
  invite: (to: string, inviter: string, workspace: string, role: string, url: string): Email => ({
    to,
    subject: `${inviter} invited you to ${workspace} on Brill Tables`,
    ...layout(`Join ${workspace}`, [`${inviter} invited you to the “${workspace}” workspace as ${role}.`],
      { label: "Accept invite", url }, "This invite works only for this email address and expires in 14 days."),
  }),
};
