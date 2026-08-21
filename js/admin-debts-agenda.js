// ============================================================
//  ADMIN: A RECEBER (outstanding payments)
// ============================================================
import { getDocs, collection } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, escapeHtml, getProjects, daysUntil, paymentStatus, projectPaymentDates,
  formatDatePt, money, setAdminHash, show, ADMIN_EMAIL, isPontualWorkflow
} from './core.js';

// Collect every dated instalment across all clients (soonest first), paid or
// not — the source of truth for "how much income is expected in month X",
// which needs paid + unpaid + overdue instalments alike. Each row carries a
// `paid` flag so consumers that only care about outstanding money can filter.
export async function fetchAllInstallments(){
  const snap = await getDocs(collection(db, "clients"));
  const rows = [];
  snap.docs.forEach(d => {
    const data = d.data();
    if((data.email || '') === ADMIN_EMAIL) return;
    const clientName = `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.email || 'Cliente';
    getProjects(data).forEach(p => {
      const dates = projectPaymentDates(p);
      const paid = p.paymentsPaid || [];
      const amounts = p.paymentAmounts || [];
      const notes = p.paymentNotes || [];
      dates.forEach((iso, i) => {
        if(!iso) return; // only dated instalments
        rows.push({
          clientName, firstName: data.firstName || '', phone: data.phone || '',
          project: p.name || 'Projeto', idx: i, count: dates.length, note: notes[i] || '',
          iso, amount: Number(amounts[i]) || 0, paid: !!paid[i], pontual: isPontualWorkflow(p)
        });
      });
    });
  });
  rows.sort((a, b) => (a.iso < b.iso ? -1 : 1)); // earliest / most overdue first
  return rows;
}
// Every unpaid, dated instalment (soonest first) — what's still owed, for the
// urgent list, WhatsApp reminders, and due-soon banner. Pontual/avulso jobs
// are excluded here (but not from fetchAllInstallments) — those clients are
// tracked for stats only, never chased with a "cobrança" reminder.
export async function fetchOutstanding(){
  const rows = await fetchAllInstallments();
  return rows.filter(r => !r.paid && !r.pontual);
}
// Late-payment fine: a single, one-time 5% of the original instalment amount (contract clause 2) —
// it does not accrue per day; it is either owed (once overdue) or not.
function lateFine(amount){
  return amount * 0.05;
}
// Pre-filled WhatsApp reminder link for one instalment (null if the client has no phone).
function waReminderHref(r){
  let phone = (r.phone || '').replace(/[^\d]/g, '');
  if(phone.length === 9) phone = '351' + phone; // assume PT if no country code
  if(!phone) return null;
  const parcela = r.note ? ` (${r.note})` : (r.count > 1 ? ` (parcela ${r.idx + 1}/${r.count})` : '');
  const valor = r.amount ? `, no valor de ${money.format(r.amount)}` : '';
  const daysLate = -daysUntil(r.iso);
  const overdue = daysLate > 0 && r.amount > 0;
  const fineNote = overdue
    ? `\n\nEste pagamento está em atraso há ${daysLate} dia${daysLate === 1 ? '' : 's'}. ` +
      `Conforme o contrato, incide uma multa única de 5% sobre o valor original, totalizando ` +
      `${money.format(lateFine(r.amount))} de multa — valor atualizado: ${money.format(r.amount + lateFine(r.amount))}.`
    : '';
  const text = encodeURIComponent(
    `Oieee! Tudo bem?\n\n` +
    `Esta é uma mensagem automática de lembrete sobre o vencimento do pagamento referente ao serviço prestado, ` +
    `com data limite em ${formatDatePt(r.iso)}${valor}${parcela}.${fineNote}\n\n` +
    `Esse formato está vinculado ao nosso site! Caso o pagamento já tenha sido efetuado, por favor, desconsidere esta mensagem.\n\n` +
    `Em caso de dúvidas ou necessidade de esclarecimentos, permaneço à disposição.\n\n` +
    `Atenciosamente,\n` +
    `Estephanie Cerqueira`
  );
  return `https://wa.me/${phone}?text=${text}`;
}

// Month-by-month view of ALL dated instalments, paid or not (not just the
// ≤5-day urgent ones below) — "quanto de receita vou ter naquele mês",
// with ‹ › to browse other months. Cached per loadDebts() call; the arrows
// just re-filter it, no extra Firestore reads.
const MONTH_NAMES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
let debtsMonthCursor = null; // { y, m } (m: 0–11); starts at the current month
let debtsAllRows = [];
function renderDebtsMonthSummary(){
  const { y, m } = debtsMonthCursor;
  document.getElementById('debtsMonthLabel').textContent = `${MONTH_NAMES_PT[m]} ${y}`;
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
  const monthRows = debtsAllRows.filter(r => r.iso.startsWith(prefix));
  const grid = document.getElementById('debtsMonthGrid');
  if(!monthRows.length){
    grid.innerHTML = '<p class="panel-empty">Nenhum pagamento agendado neste mês.</p>';
    return;
  }
  const paidRows = monthRows.filter(r => r.paid);
  const pendingRows = monthRows.filter(r => !r.paid);
  const overdueRows = pendingRows.filter(r => daysUntil(r.iso) < 0);
  const upcomingRows = pendingRows.filter(r => daysUntil(r.iso) >= 0);
  const paidTotal = paidRows.reduce((s, r) => s + r.amount, 0);
  const overdueTotal = overdueRows.reduce((s, r) => s + r.amount, 0);
  const upcomingTotal = upcomingRows.reduce((s, r) => s + r.amount, 0);
  const grandTotal = paidTotal + overdueTotal + upcomingTotal;
  const pago = n => `${n} pagamento${n === 1 ? '' : 's'}`;
  grid.innerHTML = `
    <div class="stat-card is-received">
      <div class="stat-num">${money.format(paidTotal)}</div>
      <div class="stat-label">Recebido</div>
      <div class="stat-sub">${pago(paidRows.length)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${money.format(upcomingTotal)}</div>
      <div class="stat-label">Para receber</div>
      <div class="stat-sub">${pago(upcomingRows.length)}</div>
    </div>
    <div class="stat-card ${overdueRows.length ? 'is-alert' : ''}">
      <div class="stat-num">${money.format(overdueTotal)}</div>
      <div class="stat-label">Em atraso</div>
      <div class="stat-sub">${pago(overdueRows.length)}</div>
    </div>
    <div class="stat-card is-total">
      <div class="stat-num">${money.format(grandTotal)}</div>
      <div class="stat-label">Total</div>
      <div class="stat-sub">${pago(monthRows.length)} no mês</div>
    </div>
  `;
}
document.getElementById('debtsMonthPrev').addEventListener('click', () => {
  if(!debtsMonthCursor) return;
  debtsMonthCursor.m--;
  if(debtsMonthCursor.m < 0){ debtsMonthCursor.m = 11; debtsMonthCursor.y--; }
  renderDebtsMonthSummary();
});
document.getElementById('debtsMonthNext').addEventListener('click', () => {
  if(!debtsMonthCursor) return;
  debtsMonthCursor.m++;
  if(debtsMonthCursor.m > 11){ debtsMonthCursor.m = 0; debtsMonthCursor.y++; }
  renderDebtsMonthSummary();
});

export async function loadDebts(){
  setAdminHash('a-receber');
  show('view-admin-debts');
  const listEl = document.getElementById('debtsList');
  const totalEl = document.getElementById('debtsTotal');
  totalEl.textContent = '';
  document.getElementById('debtsMonthGrid').innerHTML = '';
  listEl.innerHTML = '<p class="panel-empty"><span class="loading-dot"></span></p>';
  let allRows;
  try{ allRows = await fetchAllInstallments(); }
  catch(e){ listEl.innerHTML = '<p class="panel-empty">Não foi possível carregar.</p>'; return; }
  debtsAllRows = allRows; // month summary needs paid + unpaid together
  let rows = allRows.filter(r => !r.paid); // urgent list + reminders: only what's still owed
  checkDueSoon(rows);
  if(!debtsMonthCursor){
    const now = new Date();
    debtsMonthCursor = { y: now.getFullYear(), m: now.getMonth() };
  }
  renderDebtsMonthSummary();
  rows = rows.filter(r => daysUntil(r.iso) <= 5); // only imminent (≤5 days) or overdue

  const total = rows.reduce((s, r) => s + r.amount, 0);
  totalEl.innerHTML = `${rows.length} pagamento(s) a vencer em 5 dias ou em atraso · total <strong>${money.format(total)}</strong>`;
  if(rows.length === 0){ listEl.innerHTML = '<p class="panel-empty">Nada urgente — sem pagamentos a vencer nos próximos 5 dias.</p>'; return; }

  listEl.innerHTML = '';
  rows.forEach(r => {
    const s = paymentStatus(r.iso);
    const href = waReminderHref(r);
    const waBtn = href
      ? `<a class="btn btn-ghost debt-remind" href="${href}" target="_blank" rel="noopener">Lembrar</a>`
      : '<span class="fin-note">sem telefone</span>';
    const row = document.createElement('div');
    row.className = 'fin-ledger-row';
    row.innerHTML = `
      <span class="fin-date">${formatDatePt(r.iso)}</span>
      <span>
        <span class="fin-cli">${escapeHtml(r.clientName)}</span>
        <br><span class="fin-note">${escapeHtml(r.project)}${r.note ? ` · ${escapeHtml(r.note)}` : (r.count > 1 ? ` · pagamento ${r.idx + 1}/${r.count}` : '')}</span>
        <br><span class="pay-line ${s.mod}" style="margin:0;"><span class="days">${s.text}</span></span>
      </span>
      <span class="fin-amt">${r.amount ? money.format(r.amount) : '—'}</span>
      <span class="fin-actions">${waBtn}</span>
    `;
    listEl.appendChild(row);
  });
}

// Proactive nudge shown on Início and A receber (the only views where it's
// wired to render — see core.js's show()): instalments due within 3 days (or
// already overdue), each with its ready-to-send WhatsApp reminder. Accepts an
// already-fetched row set (both callers already have one) to avoid a second
// Firestore read; falls back to fetching its own if none is passed.
export async function checkDueSoon(rows){
  const banner = document.getElementById('dueSoonBanner');
  if(!banner) return;
  if(!rows){
    try{ rows = await fetchOutstanding(); }catch(e){ return; }
  }
  const soon = rows.filter(r => daysUntil(r.iso) <= 3); // overdue + due within 3 days
  if(soon.length === 0){ banner.classList.add('hidden'); return; }
  const items = soon.slice(0, 6).map(r => {
    const s = paymentStatus(r.iso);
    const href = waReminderHref(r);
    const btn = href
      ? `<a class="btn btn-ghost debt-remind" href="${href}" target="_blank" rel="noopener">Lembrar</a>`
      : '<span class="fin-note">sem telefone</span>';
    return `<li><span>${escapeHtml(r.clientName)} · ${escapeHtml(r.project)} · <span class="days ${s.mod}">${s.text}</span></span>${btn}</li>`;
  }).join('');
  const more = soon.length > 6 ? `<li class="db-more">+ ${soon.length - 6} em "A receber"</li>` : '';
  banner.innerHTML = `
    <h4>${soon.length} pagamento(s) a vencer em 3 dias ou em atraso</h4>
    <ul>${items}${more}</ul>
    <button class="db-dismiss" id="dueDismiss">Dispensar por agora</button>`;
  banner.classList.remove('hidden');
  document.getElementById('dueDismiss').addEventListener('click', () => banner.classList.add('hidden'));
}
