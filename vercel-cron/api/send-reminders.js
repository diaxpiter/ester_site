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
// Same palette/typography as the portal (css/portal.css): --black #0a0a0a,
// --off-white #f3f2ee, --gray #8c8c86, amber accent #f0a24b used elsewhere
// for payments/SS, italic serif wordmark standing in for the site's
// 'League Spartan italic' nav logo (email clients don't load Google Fonts,
// so a web-safe italic serif is the closest reliable equivalent). Table-based
// layout + inline styles throughout: the only structure that survives Gmail
// and Outlook both stripping <style> blocks / class-based CSS.
function reminderEmailHtml({ clientFirstName, projectName, parcelaNote, amount, iso, due }) {
  const greetingName = clientFirstName ? ` ${clientFirstName}` : "";
  return `
<!DOCTYPE html>
<html lang="pt">
<body style="margin:0;padding:0;background-color:#0a0a0a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background-color:#141414;border-radius:8px;overflow:hidden;border:1px solid #262626;">
        <tr>
          <td style="background-color:#0a0a0a;padding:28px 32px;text-align:center;border-bottom:2px solid #f0a24b;">
            <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:28px;color:#f3f2ee;letter-spacing:0.02em;">Ester</div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#8c8c86;margin-top:6px;">Produção Audiovisual</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;font-family:Arial,Helvetica,sans-serif;color:#f3f2ee;font-size:15px;line-height:1.6;">
            <p style="margin:0 0 16px;">Oi${greetingName}! Tudo bem? ✨</p>
            <p style="margin:0 0 16px;">Esta é uma mensagem automática de lembrete: o pagamento referente a
              <strong style="color:#f3f2ee;">${projectName}</strong>${parcelaNote}
              ${amount > 0 ? `no valor de <strong style="color:#f0a24b;">${money(amount)}</strong> ` : ""}${dueText(due)}
              (<strong style="color:#f3f2ee;">${formatDatePt(iso)}</strong>).</p>
            <p style="margin:0 0 16px;color:#8c8c86;">Caso o pagamento já tenha sido efetuado, por favor desconsidere esta mensagem.</p>
            <p style="margin:0;color:#8c8c86;">Qualquer dúvida ou necessidade de esclarecimento, estou à disposição.</p>
          </td>
        </tr>
        <tr>
          <td style="background-color:#0a0a0a;padding:24px 32px;border-top:1px solid #262626;">
            <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:17px;color:#f3f2ee;">Estephanie Cerqueira</div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8c8c86;margin-top:3px;">Fotografia &amp; Vídeo · Porto</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
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
