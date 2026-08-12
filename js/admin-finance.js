// ============================================================
//  ADMIN: FINANCE (income ledger + Social Security prospection)
// ============================================================
import {
  getDocs, collection, doc, updateDoc, addDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, escapeHtml, formatDatePt, getISO, setISO, money, QUARTERS,
  SS_INCOME_FACTOR, SS_RATE, SS_ADJUST, msg, setAdminHash, show, ADMIN_EMAIL,
  askConfirm
} from './core.js';

// Keep the income ledger in sync with a project's paid instalments.
// Auto-created docs carry a deterministic sourceKey ("clientId:projectId:index"),
// so this is idempotent: paid instalment -> upsert; unpaid/removed -> delete.
// Manually-added income (no sourceKey) is never touched.
export async function syncProjectIncome(clientId, clientName, project){
  const prefix = `${clientId}:${project.id}:`;
  const snap = await getDocs(collection(db, "income"));
  const existing = {};
  snap.docs.forEach(d => {
    const k = d.data().sourceKey;
    if(typeof k === 'string' && k.startsWith(prefix)) existing[k] = d.id;
  });
  const dates = project.paymentDates || [];
  const paid = project.paymentsPaid || [];
  const amounts = project.paymentAmounts || [];
  const notes = project.paymentNotes || [];
  const n = dates.length;
  const ops = [];
  for(let i = 0; i < n; i++){
    const key = prefix + i;
    const amt = Number(amounts[i]) || 0;
    if(paid[i] && dates[i] && amt > 0){
      // Avulso/pontual rows each carry their own description (a distinct
      // one-off job) — use it instead of the generic "pagamento i/n" label.
      const note = notes[i] ? `${project.name} — ${notes[i]}` : (n > 1 ? `${project.name} — pagamento ${i + 1}/${n}` : project.name);
      const payload = { date: dates[i], amount: amt, clientId, clientName, note, sourceKey: key };
      if(existing[key]){ ops.push(updateDoc(doc(db, "income", existing[key]), payload)); delete existing[key]; }
      else { ops.push(addDoc(collection(db, "income"), { ...payload, receiptIssued: false, createdAt: serverTimestamp() })); }
    }
  }
  // Instalments no longer paid (or removed) -> drop their auto income.
  Object.values(existing).forEach(id => ops.push(deleteDoc(doc(db, "income", id))));
  await Promise.all(ops);
}
// Remove every auto-created income doc for a client (used on client deletion).
export async function deleteClientIncome(clientId){
  const snap = await getDocs(collection(db, "income"));
  const ops = [];
  snap.docs.forEach(d => {
    const k = d.data().sourceKey;
    if(typeof k === 'string' && k.startsWith(clientId + ':')) ops.push(deleteDoc(doc(db, "income", d.id)));
  });
  await Promise.all(ops);
}

let finYear = null;
let finAllEntries = [];
let finAllExpenses = [];

let finEditId = null; // id of the income entry being edited, or null when adding
let expEditId = null; // id of the expense entry being edited, or null when adding

const EXPENSE_CATEGORY_LABELS = {
  equipamento: 'Equipamento', software: 'Software', transporte: 'Transporte',
  seguros: 'Seguros', outro: 'Outro'
};

export async function loadFinance(){
  setAdminHash('financeiro');
  if(finYear === null) finYear = new Date().getFullYear();
  resetIncomeForm();
  resetExpenseForm();
  show('view-admin-finance');
  await populateFinClients();
  await reloadIncome();
  await reloadExpenses();
}

// Fill both the add-form client select and the filter client select.
async function populateFinClients(){
  let opts = '';
  try{
    const snap = await getDocs(collection(db, "clients"));
    snap.docs
      .filter(d => (d.data().email || '') !== ADMIN_EMAIL)
      .forEach(d => {
        const c = d.data();
        const name = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || 'Cliente';
        opts += `<option value="${d.id}">${escapeHtml(name)}</option>`;
      });
  }catch(err){ /* keep placeholders */ }
  document.getElementById('finClient').innerHTML = '<option value="">— Sem cliente —</option>' + opts;
  document.getElementById('finFilterClient').innerHTML = '<option value="">Todos os clientes</option>' + opts;
}

async function reloadIncome(){
  try{
    const snap = await getDocs(collection(db, "income"));
    finAllEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }catch(err){
    finAllEntries = [];
  }
  renderFinance();
}

async function reloadExpenses(){
  try{
    const snap = await getDocs(collection(db, "expenses"));
    finAllExpenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }catch(err){
    finAllExpenses = [];
  }
  renderFinance();
}

function renderFinance(){
  document.getElementById('finYearLabel').textContent = finYear;
  renderLedger();
  renderExpenseLedger();
  renderSummary();
}

// Apply the filter bar (client, date range, receipt status) to the full set.
function getFilteredEntries(){
  const client = document.getElementById('finFilterClient').value;
  const from = getISO(document.getElementById('finFilterFrom'));
  const to = getISO(document.getElementById('finFilterTo'));
  const receipt = document.getElementById('finFilterReceipt').value;
  return finAllEntries
    .filter(e => {
      if(client && e.clientId !== client) return false;
      if(from && (!e.date || e.date < from)) return false;
      if(to && (!e.date || e.date > to)) return false;
      if(receipt === 'yes' && !e.receiptIssued) return false;
      if(receipt === 'no' && e.receiptIssued) return false;
      return true;
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

const FIN_PAGE_SIZE = 10;   // revenues shown per page (swipe sideways for more)
function buildLedgerRow(e){
  const row = document.createElement('div');
  row.className = 'fin-ledger-row';
  row.innerHTML = `
    <span class="fin-date">${formatDatePt(e.date)}</span>
    <span>
      <span class="fin-cli">${escapeHtml(e.clientName || 'Sem cliente')}</span>
      ${e.note ? `<br><span class="fin-note">${escapeHtml(e.note)}</span>` : ''}
      <br><span class="fin-receipt-tag ${e.receiptIssued ? 'yes' : ''}">${e.receiptIssued ? '✓ recibo emitido' : 'recibo pendente'}</span>
    </span>
    <span class="fin-amt">${money.format(Number(e.amount) || 0)}</span>
    <span class="fin-actions">
      <button type="button" class="fin-edit" title="Editar" aria-label="Editar receita">✎</button>
      <button type="button" class="fin-del" title="Remover" aria-label="Remover receita">✕</button>
    </span>
  `;
  row.querySelector('.fin-edit').addEventListener('click', () => startEditIncome(e));
  row.querySelector('.fin-del').addEventListener('click', () => deleteIncome(e.id));
  return row;
}
// Shared by the income and expense ledgers: up to FIN_PAGE_SIZE rows per
// page, extra pages sit side by side and scroll horizontally with dots.
function renderPagedRows(el, entries, buildRow, emptyMsg){
  el.innerHTML = '';
  if(entries.length === 0){
    el.innerHTML = `<p class="panel-empty">${emptyMsg}</p>`;
    return;
  }
  const pageCount = Math.ceil(entries.length / FIN_PAGE_SIZE);
  if(pageCount === 1){
    entries.forEach(e => el.appendChild(buildRow(e)));
    return;
  }
  const scroll = document.createElement('div');
  scroll.className = 'fin-scroll';
  for(let p = 0; p < pageCount; p++){
    const page = document.createElement('div');
    page.className = 'fin-page';
    entries.slice(p * FIN_PAGE_SIZE, (p + 1) * FIN_PAGE_SIZE).forEach(e => page.appendChild(buildRow(e)));
    scroll.appendChild(page);
  }
  el.appendChild(scroll);
  // Dots: show current page, tap to jump.
  const dots = document.createElement('div');
  dots.className = 'fin-dots';
  for(let p = 0; p < pageCount; p++){
    const d = document.createElement('button');
    d.type = 'button';
    if(p === 0) d.className = 'on';
    d.setAttribute('aria-label', `Página ${p + 1}`);
    d.addEventListener('click', () => scroll.scrollTo({ left: p * scroll.clientWidth, behavior: 'smooth' }));
    dots.appendChild(d);
  }
  el.appendChild(dots);
  scroll.addEventListener('scroll', () => {
    const active = Math.round(scroll.scrollLeft / scroll.clientWidth);
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === active));
  }, { passive: true });
}
function renderLedger(){
  const entries = getFilteredEntries();
  const sum = entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  document.getElementById('finFilterTotal').innerHTML =
    `${entries.length} receita(s) · total <strong>${money.format(sum)}</strong>`;
  renderPagedRows(document.getElementById('finLedger'), entries, buildLedgerRow, 'Nenhuma receita corresponde aos filtros.');
}

function buildExpenseRow(e){
  const row = document.createElement('div');
  row.className = 'fin-ledger-row';
  row.innerHTML = `
    <span class="fin-date">${formatDatePt(e.date)}</span>
    <span>
      <span class="fin-cli">${escapeHtml(EXPENSE_CATEGORY_LABELS[e.category] || 'Outro')}</span>
      ${e.note ? `<br><span class="fin-note">${escapeHtml(e.note)}</span>` : ''}
    </span>
    <span class="fin-amt neg">− ${money.format(Number(e.amount) || 0)}</span>
    <span class="fin-actions">
      <button type="button" class="fin-edit" title="Editar" aria-label="Editar despesa">✎</button>
      <button type="button" class="fin-del" title="Remover" aria-label="Remover despesa">✕</button>
    </span>
  `;
  row.querySelector('.fin-edit').addEventListener('click', () => startEditExpense(e));
  row.querySelector('.fin-del').addEventListener('click', () => deleteExpense(e.id));
  return row;
}
function getYearExpenses(){
  return finAllExpenses.filter(e => e.date && Number(e.date.slice(0, 4)) === finYear);
}
function renderExpenseLedger(){
  const entries = getYearExpenses().sort((a, b) => (a.date < b.date ? 1 : -1));
  renderPagedRows(document.getElementById('expLedger'), entries, buildExpenseRow, 'Nenhuma despesa registada neste ano.');
}

const MONTH_NAMES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
// Quarter qIndex (0=Jan–Mar … 3=Out–Dez) always ENDS on month (qIndex+1)*3.
function quarterEndMonth(qIndex){ return (qIndex + 1) * 3; }
// It's DECLARED the month right after it ends (Jan–Mar → declared in Abril).
function quarterDeclMonth(qYear, qIndex){
  let m = quarterEndMonth(qIndex) + 1, y = qYear;
  if(m > 12){ m -= 12; y++; }
  return { y, m };
}
// Its contribution is split across the 3 months that follow the declaration
// (declared in Abril → paid Maio/Junho/Julho).
function quarterPayMonths(qYear, qIndex){
  const months = [];
  for(let off = 2; off <= 4; off++){
    let m = quarterEndMonth(qIndex) + off, y = qYear;
    while(m > 12){ m -= 12; y++; }
    months.push({ y, m });
  }
  return months;
}
// Receipted income for one quarter of one specific year (the Social Security
// base — same rule as before: only income with "Recibo emitido" checked).
function quarterIncome(qYear, qIndex){
  const startM = qIndex * 3 + 1, endM = quarterEndMonth(qIndex);
  let total = 0;
  finAllEntries.forEach(e => {
    if(!e.receiptIssued || !e.date) return;
    const y = Number(e.date.slice(0, 4)), m = Number(e.date.slice(5, 7));
    if(y === qYear && m >= startM && m <= endM) total += Number(e.amount) || 0;
  });
  return total;
}
// Which quarter's contribution (if any) falls due in a given calendar month —
// the reverse of quarterPayMonths, since a Jan–Apr payment month is usually
// funded by the PREVIOUS year's Q3/Q4.
function quarterForPayMonth(payYear, payMonth){
  for(let qYear = payYear - 1; qYear <= payYear; qYear++){
    for(let qIndex = 0; qIndex < 4; qIndex++){
      if(quarterPayMonths(qYear, qIndex).some(pm => pm.y === payYear && pm.m === payMonth)){
        return { qYear, qIndex };
      }
    }
  }
  return null; // never happens in practice — every month maps to exactly one quarter
}

// Summary + Social Security are always computed for the selected year.
function renderSummary(){
  const entries = finAllEntries.filter(e => e.date && Number(e.date.slice(0, 4)) === finYear);
  // The Social Security base is ONLY income with a receipt issued at Finanças
  // (marked "Recibo emitido"). All income is still summed for the headline total.
  let total = 0, totalIssued = 0;
  entries.forEach(e => {
    const amt = Number(e.amount) || 0;
    total += amt;
    if(e.receiptIssued) totalIssued += amt;
  });
  document.getElementById('finTotal').innerHTML =
    `Receita total de ${finYear}: <strong>${money.format(total)}</strong>` +
    `<span class="fin-total-sub">Com recibo emitido (base da Segurança Social): <strong>${money.format(totalIssued)}</strong></span>`;

  // Profit = gross income (all, receipted or not) minus this year's expenses.
  // Kept separate from the Segurança Social base above, which is intentionally
  // receipted-income-only and unaffected by expenses.
  const totalExpenses = getYearExpenses().reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const profit = total - totalExpenses;
  document.getElementById('finProfitTotal').innerHTML =
    `Despesas de ${finYear}: <strong>${money.format(totalExpenses)}</strong>` +
    `<span class="fin-total-sub">Lucro de ${finYear}: <strong class="${profit < 0 ? 'neg' : ''}">${money.format(profit)}</strong></span>`;

  const grid = document.getElementById('finQuarters');
  const pastGrid = document.getElementById('finPastGrid');
  const pastDetails = document.getElementById('finPastMonths');
  grid.innerHTML = '';
  pastGrid.innerHTML = '';
  // Month-by-month (Jan → Dez) view of the SS contribution actually DUE that
  // month — not the quarter it was earned in. A Jan–Apr card is funded by the
  // previous year's Q3/Q4 income (quarterForPayMonth looks across the year
  // boundary), so finAllEntries (not the year-filtered `entries`) is queried.
  // Months already past (relative to today, not the browsed `finYear`) are
  // tucked into a collapsed "Meses anteriores" <details> — only the current
  // and upcoming months stay visible in the main grid by default.
  const now = new Date();
  const curYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let pastCount = 0;
  for(let m = 1; m <= 12; m++){
    const src = quarterForPayMonth(finYear, m);
    const income = src ? quarterIncome(src.qYear, src.qIndex) : 0;
    const ssMonth = income > 0 ? (((income * SS_INCOME_FACTOR) * SS_RATE) * SS_ADJUST) / 3 : 0;
    const card = document.createElement('div');
    card.className = 'q-card';
    let srcNote = 'Sem trimestre associado.';
    if(src){
      const decl = quarterDeclMonth(src.qYear, src.qIndex);
      const declYearNote = decl.y !== finYear ? ` ${decl.y}` : '';
      srcNote = `Refere-se ao trimestre ${QUARTERS[src.qIndex].months} de ${src.qYear} · declaração entregue em ${MONTH_NAMES_PT[decl.m - 1]}${declYearNote}`;
    }
    card.innerHTML = `
      <h4>${MONTH_NAMES_PT[m - 1]} ${finYear}</h4>
      <div class="q-line"><span>Receita do trimestre (c/ recibo)</span><strong>${money.format(income)}</strong></div>
      <div class="q-ss">Contribuição SS: <strong>${money.format(ssMonth)}</strong><br>${srcNote}</div>
    `;
    const ym = `${finYear}-${String(m).padStart(2, '0')}`;
    if(ym < curYm){ pastGrid.appendChild(card); pastCount++; }
    else grid.appendChild(card);
  }
  pastDetails.classList.toggle('hidden', pastCount === 0);
  document.getElementById('finPastSummary').textContent = `Meses anteriores (${pastCount})`;
}

// ---- add / edit form ----
// Exported: also used by admin-clients.js's contract generator (the contract's
// "data de geração" line) — a cross-file dependency inherited from the original
// single-script file, where function hoisting let it call this before its
// definition later in the same script.
export function todayIso(){
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function resetIncomeForm(){
  finEditId = null;
  setISO(document.getElementById('finDate'), todayIso());
  document.getElementById('finAmount').value = '';
  document.getElementById('finClient').value = '';
  document.getElementById('finNote').value = '';
  document.getElementById('finReceipt').checked = false;
  document.getElementById('finFormTitle').textContent = 'Registar receita';
  document.getElementById('finAddBtn').textContent = 'Adicionar receita';
  document.getElementById('finCancelEditBtn').classList.add('hidden');
  document.getElementById('finMsg').className = 'form-msg';
}
function startEditIncome(e){
  finEditId = e.id;
  setISO(document.getElementById('finDate'), e.date || '');
  document.getElementById('finAmount').value = (e.amount ?? '');
  document.getElementById('finClient').value = e.clientId || '';
  document.getElementById('finNote').value = e.note || '';
  document.getElementById('finReceipt').checked = !!e.receiptIssued;
  document.getElementById('finFormTitle').textContent = 'Editar receita';
  document.getElementById('finAddBtn').textContent = 'Guardar alterações';
  document.getElementById('finCancelEditBtn').classList.remove('hidden');
  document.getElementById('finMsg').className = 'form-msg';
  document.getElementById('finFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.getElementById('finCancelEditBtn').addEventListener('click', resetIncomeForm);

async function deleteIncome(id){
  const ok = await askConfirm({
    title: 'Eliminar receita',
    message: 'Esta ação não pode ser desfeita. Deseja eliminar esta receita?',
    confirmText: 'Deletar',
    cancelText: 'Cancelar'
  });
  if(!ok) return;
  try{
    await deleteDoc(doc(db, "income", id));
    if(finEditId === id) resetIncomeForm();
    await reloadIncome();
  }catch(err){ /* no-op */ }
}

function resetExpenseForm(){
  expEditId = null;
  setISO(document.getElementById('expDate'), todayIso());
  document.getElementById('expAmount').value = '';
  document.getElementById('expCategory').value = 'equipamento';
  document.getElementById('expNote').value = '';
  document.getElementById('expFormTitle').textContent = 'Registar despesa';
  document.getElementById('expAddBtn').textContent = 'Adicionar despesa';
  document.getElementById('expCancelEditBtn').classList.add('hidden');
  document.getElementById('expMsg').className = 'form-msg';
}
function startEditExpense(e){
  expEditId = e.id;
  setISO(document.getElementById('expDate'), e.date || '');
  document.getElementById('expAmount').value = (e.amount ?? '');
  document.getElementById('expCategory').value = e.category || 'outro';
  document.getElementById('expNote').value = e.note || '';
  document.getElementById('expFormTitle').textContent = 'Editar despesa';
  document.getElementById('expAddBtn').textContent = 'Guardar alterações';
  document.getElementById('expCancelEditBtn').classList.remove('hidden');
  document.getElementById('expMsg').className = 'form-msg';
  document.getElementById('expFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.getElementById('expCancelEditBtn').addEventListener('click', resetExpenseForm);

async function deleteExpense(id){
  const ok = await askConfirm({
    title: 'Eliminar despesa',
    message: 'Esta ação não pode ser desfeita. Deseja eliminar esta despesa?',
    confirmText: 'Deletar',
    cancelText: 'Cancelar'
  });
  if(!ok) return;
  try{
    await deleteDoc(doc(db, "expenses", id));
    if(expEditId === id) resetExpenseForm();
    await reloadExpenses();
  }catch(err){ /* no-op */ }
}

document.getElementById('expExportBtn').addEventListener('click', () => {
  const entries = getYearExpenses();
  if(entries.length === 0){ msg(document.getElementById('expMsg'), "Nada para exportar neste ano.", "error"); return; }
  const rows = [['Data', 'Categoria', 'Descrição', 'Valor (EUR)']];
  entries.forEach(e => rows.push([
    formatDatePt(e.date),
    EXPENSE_CATEGORY_LABELS[e.category] || 'Outro',
    (e.note || '').replace(/"/g, '""'),
    String(Number(e.amount) || 0).replace('.', ',')
  ]));
  const csv = String.fromCharCode(0xFEFF) + rows.map(r => r.map(c => `"${c}"`).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `despesas-ester-${finYear}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('expAddBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('expMsg');
  const date = getISO(document.getElementById('expDate'));
  const amount = parseFloat(document.getElementById('expAmount').value);
  const category = document.getElementById('expCategory').value;
  const note = document.getElementById('expNote').value.trim();
  if(!date || isNaN(amount) || amount <= 0){
    msg(msgEl, "Informe uma data e um valor válido.", "error");
    return;
  }
  const payload = { date, amount, category, note };
  try{
    if(expEditId){
      await updateDoc(doc(db, "expenses", expEditId), payload);
      resetExpenseForm();
      msg(msgEl, "Despesa atualizada.", "ok");
    } else {
      payload.createdAt = serverTimestamp();
      await addDoc(collection(db, "expenses"), payload);
      finYear = Number(date.slice(0, 4)); // reflect the new entry in the summary year
      resetExpenseForm();
      msg(msgEl, "Despesa adicionada.", "ok");
    }
    await reloadExpenses();
  }catch(err){
    msg(msgEl, "Não foi possível salvar. Tente novamente.", "error");
  }
});

// Filter controls re-render the ledger live.
['finFilterClient','finFilterFrom','finFilterTo','finFilterReceipt'].forEach(id => {
  document.getElementById(id).addEventListener('change', renderLedger);
});
// Export the currently-filtered ledger to CSV (semicolon-separated + BOM for
// Excel/Sheets in PT). Opens as a normal download, no backend involved.
document.getElementById('finExportBtn').addEventListener('click', () => {
  const entries = getFilteredEntries();
  if(entries.length === 0){ msg(document.getElementById('finMsg'), "Nada para exportar com os filtros atuais.", "error"); return; }
  const rows = [['Data', 'Cliente', 'Descrição', 'Valor (EUR)', 'Recibo']];
  entries.forEach(e => rows.push([
    formatDatePt(e.date),
    (e.clientName || '').replace(/"/g, '""'),
    (e.note || '').replace(/"/g, '""'),
    String(Number(e.amount) || 0).replace('.', ','),
    e.receiptIssued ? 'Emitido' : 'Pendente'
  ]));
  const csv = String.fromCharCode(0xFEFF) + rows.map(r => r.map(c => `"${c}"`).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `receitas-ester-${finYear}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('finClearFilters').addEventListener('click', () => {
  document.getElementById('finFilterClient').value = '';
  setISO(document.getElementById('finFilterFrom'), '');
  setISO(document.getElementById('finFilterTo'), '');
  document.getElementById('finFilterReceipt').value = '';
  renderLedger();
});

document.getElementById('finYearPrev').addEventListener('click', () => { finYear--; renderFinance(); });
document.getElementById('finYearNext').addEventListener('click', () => { finYear++; renderFinance(); });

document.getElementById('finAddBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('finMsg');
  const date = getISO(document.getElementById('finDate'));
  const amount = parseFloat(document.getElementById('finAmount').value);
  const clientSel = document.getElementById('finClient');
  const clientId = clientSel.value;
  const clientName = clientId ? clientSel.options[clientSel.selectedIndex].textContent.trim() : '';
  const note = document.getElementById('finNote').value.trim();
  const receiptIssued = document.getElementById('finReceipt').checked;
  if(!date || isNaN(amount) || amount <= 0){
    msg(msgEl, "Informe uma data e um valor válido.", "error");
    return;
  }
  const payload = { date, amount, clientId, clientName, note, receiptIssued };
  try{
    if(finEditId){
      await updateDoc(doc(db, "income", finEditId), payload);
      resetIncomeForm();
      msg(msgEl, "Receita atualizada.", "ok");
    } else {
      payload.createdAt = serverTimestamp();
      await addDoc(collection(db, "income"), payload);
      finYear = Number(date.slice(0, 4)); // reflect the new entry in the summary year
      resetIncomeForm();
      msg(msgEl, "Receita adicionada.", "ok");
    }
    await reloadIncome();
  }catch(err){
    msg(msgEl, "Não foi possível salvar. Tente novamente.", "error");
  }
});
