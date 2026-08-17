// ============================================================
//  Vercel Cron (free Hobby plan): automatic payment-reminder emails, 3 days
//  before due date. Triggered daily by vercel.json's cron entry — chosen over
//  a Firebase Cloud Function because that would require upgrading the
//  ester-website-ee664 project to the Blaze (pay-as-you-go) plan just for
//  Cloud Scheduler. Firestore itself is free to read/write from anywhere via
//  a service account, regardless of the Firebase Hosting/Functions plan — so
//  everything on the Firebase side stays exactly as-is on Spark (free).
//
//  Sends via Gmail SMTP (nodemailer) using the same account as ADMIN_EMAIL —
//  no custom domain to verify with a transactional email API, just an App
//  Password on an existing 2FA-enabled Google account.
//
//  Payment-date logic (getProjects / projectPaymentDates / daysUntil) is
//  ported from ../../js/core.js rather than imported: core.js initializes the
//  Firebase Web SDK and touches `document` at module scope, so it can't run
//  in a Node serverless function as-is. Keep the two in sync if the
//  pricing/pack model ever changes shape.
//
//  Required Vercel project environment variables (Settings -> Environment
//  Variables), all "Production" scope:
//    FIREBASE_SERVICE_ACCOUNT_JSON  - the full JSON key from Firebase Console
//                                     -> Project Settings -> Service accounts
//                                     -> Generate new private key (paste the
//                                     whole file contents as one value)
//    GMAIL_APP_PASSWORD             - Google Account -> Security -> App
//                                     passwords, generated for
//                                     contatoestephanie@gmail.com
//    CRON_SECRET                    - any random string; Vercel automatically
//                                     sends it back as a Bearer token when
//                                     the Cron Job (not a random visitor)
//                                     triggers this endpoint
// ============================================================
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const ADMIN_EMAIL = "contatoestephanie@gmail.com";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  });
}

// ---- ported from js/core.js (see file header note) ----
// Keep in sync with js/core.js PACK_GROUPS 'monthly' category — both the
// current 2026 ids and the legacy ones (existing clients' projects still
// carry the old id and must keep being split into 3 monthly instalments).
const MONTHLY_PACK_IDS = new Set([
  "monthly-pro-2026", "monthly-essencial-2026", "monthly-start-2026",
  "monthly-pro", "monthly-essential", "monthly-basic"
]);
// "Trabalhos Pontuais" packs (js/core.js PACK_GROUPS, category 'pontual') are
// never chased automatically — same design as admin-debts-agenda.js's
// fetchOutstanding(), which excludes isPontualWorkflow() projects from "A
// receber"/WhatsApp reminders. Keep this set in sync with that category.
const PONTUAL_PACK_IDS = new Set(["pontual-custom", "pontual-1h", "pontual-2h"]);
const MONTHLY_BATCH_MONTHS = 3;
const PACK_NAMES = {
  "monthly-pro-2026": "Plano Pro", "monthly-essencial-2026": "Plano Essencial", "monthly-start-2026": "Plano Start",
  "monthly-pro": "Pack Pro", "monthly-essential": "Pack Essential", "monthly-basic": "Pack Basic",
  "daily-pro": "Daily Pack Pro", "daily-basic": "Daily Pack Basic",
  "classes-start": "Start Plan", "classes-essential": "Essential Plan", "classes-pro": "Pro Plan"
};

function addMonthsIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, (m - 1) + n, d);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function projectPaymentDates(p) {
  if (Array.isArray(p.paymentDates)) return p.paymentDates;
  if (!p.paymentDue) return [];
  const isMonthly = p.pack && MONTHLY_PACK_IDS.has(p.pack);
  const split = p.splitPayments !== false;
  const n = (isMonthly && split) ? MONTHLY_BATCH_MONTHS : 1;
  return Array.from({ length: n }, (_, i) => addMonthsIso(p.paymentDue, i));
}
function getProjects(data) {
  if (Array.isArray(data.projects)) return data.projects;
  const hasLegacy = data.pack || data.contractStart || data.paymentDue ||
    data.driveLink || data.trelloLink || data.workflow ||
    (Array.isArray(data.paymentsPaid) && data.paymentsPaid.length);
  if (hasLegacy) {
    return [{
      id: "legacy",
      name: (data.pack && PACK_NAMES[data.pack]) ? PACK_NAMES[data.pack] : "Projeto",
      pack: data.pack || "",
      contractStart: data.contractStart || "",
      paymentDue: data.paymentDue || "",
      splitPayments: data.splitPayments !== false,
      paymentsPaid: data.paymentsPaid || []
    }];
  }
  return [];
}
function daysUntil(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}
function formatDatePt(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function money(v) {
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(Number(v) || 0);
}
// ---- end ported logic ----

// due: 0-3 (days remaining, from the 0–3 day send window above).
function dueText(due) {
  if (due === 0) return "vence hoje";
  if (due === 1) return "vence amanhã";
  return `vence em ${due} dias`;
}
// ---- shared email shell (docs/email-ester.html) ----------------------------
// This is the same visual system as docs/email-ester.html, the template Ester
// pastes into Gmail by hand for prospecting/proposals. Keep the two in sync:
// black hero band with the italic-serif ESTER wordmark, white body, black
// signature + footer. Palette from css/index.css: --black #0a0a0a,
// --off-white #f3f2ee, --gray #8c8c86, hairline #2b2b29, plus the portal's
// amber #f0a24b (css/portal.css) kept ONLY on the dark bands as the "this is
// about money" cue. Amber is never used on the white body: #f0a24b on #ffffff
// is ~2:1 contrast and fails WCAG AA, so the amount is bolded near-black there.
//
// Deliberately NOT carried over from the prospecting template: the services
// strip and the WhatsApp CTA button. Both are sales devices and read wrong on
// a payment reminder.
//
// Constraints that shaped this markup (same as the pasted template):
//  - <table> layout + inline styles only. Gmail and Outlook both strip <style>
//    blocks and class-based CSS.
//  - No web fonts. The site's DM Serif Display / League Spartan / Inter don't
//    load in mail clients, so Georgia italic + Arial/Helvetica stand in.
//  - width:100% everywhere, never a fixed px width. A fixed 600px block renders
//    as a narrow mobile-looking column in desktop Gmail.
//  - No media queries (stripped), so one set of values has to work from ~320px
//    to ~1200px. Anything added here must be re-checked at 320px.
//  - No images, so nothing depends on the recipient clicking "show images".
//
// The hidden preheader is what Gmail shows next to the subject in the inbox
// list. Without it the inbox preview reads "Videographer · PortoESTER..." —
// i.e. the hero text — which is useless. The trailing spacer characters push
// the hero text out of the snippet window.
function preheaderBlock(text) {
  const pad = "&#847;&zwnj;&nbsp;".repeat(40);
  return `<div style="display:none !important;font-size:1px;line-height:1px;color:#ffffff;opacity:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all;">${text}${pad}</div>`;
}

function esterEmailShell({ preheader, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="pt">
<body style="margin:0;padding:0;background-color:#e8e7e3;">
${preheaderBlock(preheader)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#e8e7e3;">
<tr>
<td align="center" style="padding:0;">

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:100%;min-width:100%;border-collapse:collapse;">

    <!-- HERO -->
    <tr>
      <td bgcolor="#0a0a0a" align="center" style="background-color:#0a0a0a;padding:44px 32px 38px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;line-height:1.4;letter-spacing:0.32em;text-transform:uppercase;color:#8c8c86;padding-bottom:20px;">Produção Audiovisual&nbsp;&middot;&nbsp;Porto</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:400;font-size:60px;line-height:1.05;letter-spacing:0.02em;color:#f3f2ee;">ESTER</div>
      </td>
    </tr>

    <!-- filete âmbar: sinaliza "assunto: pagamento" -->
    <tr>
      <td height="2" bgcolor="#f0a24b" style="background-color:#f0a24b;font-size:0;line-height:0;">&nbsp;</td>
    </tr>

    <!-- CORPO -->
    <tr>
      <td bgcolor="#ffffff" style="background-color:#ffffff;padding:42px 36px 38px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.75;color:#1f1f1e;">
${bodyHtml}
      </td>
    </tr>

    <!-- ASSINATURA -->
    <tr>
      <td bgcolor="#0a0a0a" style="background-color:#0a0a0a;padding:32px 36px 28px;">

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
          <tr>
            <td style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:24px;line-height:1.2;color:#f3f2ee;padding-bottom:5px;">Ester</td>
          </tr>
          <tr>
            <td style="font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#8c8c86;padding-bottom:20px;">Estephanie Cerqueira&nbsp;&middot;&nbsp;Videomaker &amp; Storymaker</td>
          </tr>
          <tr><td height="1" bgcolor="#2b2b29" style="background-color:#2b2b29;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td style="height:20px;font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
          <tr>
            <td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.75;color:#f3f2ee;padding-bottom:8px;word-break:break-word;"><span style="font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#6f6f6a;">WhatsApp</span>&nbsp;&nbsp;&nbsp;<a href="https://wa.me/351913198057" target="_blank" style="color:#f3f2ee;text-decoration:none;">+351 913 198 057</a></td>
          </tr>
          <tr>
            <td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.75;color:#f3f2ee;padding-bottom:8px;word-break:break-word;"><span style="font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#6f6f6a;">Email</span>&nbsp;&nbsp;&nbsp;<a href="mailto:${ADMIN_EMAIL}" style="color:#f3f2ee;text-decoration:none;">${ADMIN_EMAIL}</a></td>
          </tr>
          <tr>
            <td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.75;color:#f3f2ee;word-break:break-word;"><span style="font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#6f6f6a;">Portfólio</span>&nbsp;&nbsp;&nbsp;<a href="https://esterprod.com" target="_blank" style="color:#f3f2ee;text-decoration:none;">esterprod.com</a></td>
          </tr>
        </table>

      </td>
    </tr>

    <!-- RODAPÉ -->
    <tr>
      <td bgcolor="#0a0a0a" align="center" style="background-color:#0a0a0a;padding:0 36px 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
          <tr><td height="1" bgcolor="#2b2b29" style="background-color:#2b2b29;font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;line-height:1.8;letter-spacing:0.16em;text-transform:uppercase;color:#6f6f6a;padding-top:16px;">Mensagem automática&nbsp;&middot;&nbsp;Porto, Portugal</div>
      </td>
    </tr>

  </table>

</td>
</tr>
</table>
</body>
</html>`;
}

function reminderEmailHtml({ clientFirstName, projectName, parcelaNote, amount, iso, due }) {
  const greetingName = clientFirstName ? ` ${clientFirstName}` : "";
  const amountText = amount > 0 ? `no valor de <strong>${money(amount)}</strong> ` : "";

  // Inbox preview: the concrete facts, so the client can triage without opening.
  const preheader = amount > 0
    ? `${money(amount)} · ${dueText(due)} (${formatDatePt(iso)}).`
    : `Pagamento ${dueText(due)} (${formatDatePt(iso)}).`;

  const bodyHtml = `
        <p style="margin:0 0 18px;">Oi${greetingName}! Tudo bem? ✨</p>

        <p style="margin:0 0 22px;">Esta é uma mensagem automática de lembrete: o pagamento referente a <strong>${projectName}</strong>${parcelaNote} ${amountText}${dueText(due)}.</p>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 24px;">
          <tr>
            <td style="background-color:#f6f5f2;border-left:2px solid #0a0a0a;padding:16px 18px;font-family:Helvetica,Arial,sans-serif;word-break:break-word;">
              <div style="font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#8c8c86;padding-bottom:6px;">Vencimento</div>
              <div style="font-size:17px;line-height:1.4;color:#1f1f1e;"><strong>${formatDatePt(iso)}</strong>${amount > 0 ? `&nbsp;&nbsp;&middot;&nbsp;&nbsp;${money(amount)}` : ""}</div>
            </td>
          </tr>
        </table>

        <p style="margin:0 0 14px;color:#5a5a57;">Caso o pagamento já tenha sido efetuado, por favor desconsidere esta mensagem.</p>

        <p style="margin:0;color:#5a5a57;">Qualquer dúvida ou necessidade de esclarecimento, estou à disposição.</p>`;

  return esterEmailShell({ preheader, bodyHtml });
}

module.exports = async (req, res) => {
  // Reject anything that isn't Vercel's own Cron trigger (which echoes
  // CRON_SECRET back as a Bearer token) — otherwise this URL is public.
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const db = admin.firestore();
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: ADMIN_EMAIL, pass: process.env.GMAIL_APP_PASSWORD }
  });

  const clientsSnap = await db.collection("clients").get();
  let sent = 0, skipped = 0, failed = 0;

  for (const clientDoc of clientsSnap.docs) {
    const data = clientDoc.data();
    const clientEmail = data.email || "";
    if (!clientEmail || clientEmail === ADMIN_EMAIL) continue;
    const clientFirstName = data.firstName || "";

    for (const p of getProjects(data)) {
      if (PONTUAL_PACK_IDS.has(p.pack)) continue; // one-off/avulso work — never auto-reminded
      const dates = projectPaymentDates(p);
      const paid = p.paymentsPaid || [];
      const amounts = p.paymentAmounts || [];
      const projectId = p.id || "legacy";
      const projectName = p.name || "Projeto";

      for (let i = 0; i < dates.length; i++) {
        const iso = dates[i];
        if (!iso || paid[i]) continue;
        // 0–3 day window (not an exact "== 3" match): self-healing against a
        // missed cron run or data added after the 3-day mark already passed.
        // The emailRemindersSent dedup below still guarantees a single send.
        const due = daysUntil(iso);
        if (due < 0 || due > 3) continue;

        const reminderRef = db.collection("emailRemindersSent").doc(`${clientDoc.id}:${projectId}:${i}`);
        const already = await reminderRef.get();
        if (already.exists) { skipped++; continue; }

        const parcelaNote = dates.length > 1 ? ` (parcela ${i + 1}/${dates.length})` : "";
        try {
          await transporter.sendMail({
            from: `Estephanie Cerqueira <${ADMIN_EMAIL}>`,
            to: clientEmail,
            subject: `Lembrete: pagamento ${dueText(due)}`,
            html: reminderEmailHtml({ clientFirstName, projectName, parcelaNote, amount: Number(amounts[i]) || 0, iso, due }),
            // "High priority" headers — the closest a sender can get to Gmail's
            // yellow "Important" marker, which is NOT settable by the sender:
            // it's Gmail's own ML classification based on the recipient's past
            // behavior, with no header or API that forces it. These headers are
            // honored by Outlook/Apple Mail/Yahoo (red "!" priority flag) but
            // silently ignored by Gmail — harmless there, useful elsewhere.
            headers: { "Importance": "high", "X-Priority": "1", "X-MSMail-Priority": "High" }
          });
          await reminderRef.set({
            sentAt: new Date().toISOString(),
            clientId: clientDoc.id,
            projectId,
            idx: i,
            dueDate: iso
          });
          sent++;
        } catch (err) {
          failed++;
          console.error(`Falha ao enviar lembrete para ${clientEmail} (cliente ${clientDoc.id}, projeto ${projectId}, parcela ${i})`, err);
        }
      }
    }
  }

  console.log(`sendPaymentReminders: ${sent} enviado(s), ${skipped} já enviado(s) antes, ${failed} falhado(s).`);
  res.status(200).json({ sent, skipped, failed });
};
