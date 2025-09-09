// smtpSend.js (ESM)
import nodemailer from "nodemailer";

export function makeTransport({
  host,
  port = 465,
  secure = true,
  authType = "password",
  email,
  password,
  accessToken,
}) {
  const auth =
    String(authType || "password").toLowerCase() === "xoauth2"
      ? { type: "OAuth2", user: email, accessToken }
      : { user: email, pass: password };

  return nodemailer.createTransport({
    host,
    port: Number(port),
    secure: !!secure,
    auth,
  });
}

export async function sendMail({
  transport,
  from,
  to,
  cc,
  bcc,
  subject,
  text,
  html,
  attachments = [],
  headers = {},
}) {
  const info = await transport.sendMail({
    from,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    attachments,
    headers,
  });
  return { ok: true, id: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

export async function replyMail({
  transport,
  replyFrom,
  replyTo,
  subject,
  text,
  html,
  attachments = [],
  orig = { messageId: null, references: [] },
}) {
  const subj = /^(re:\s)/i.test(subject || "") ? subject : `Re: ${subject || ""}`.trim();
  const refs = Array.isArray(orig.references) ? orig.references : [];
  const headers = {
    "In-Reply-To": orig.messageId || undefined,
    "References": [...refs, orig.messageId].filter(Boolean).join(" "),
  };

  const info = await transport.sendMail({
    from: replyFrom,
    to: replyTo,
    subject: subj,
    text,
    html,
    attachments,
    headers,
  });

  return { ok: true, id: info.messageId, accepted: info.accepted, rejected: info.rejected };
}
