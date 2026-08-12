// ============================================================
//  ADMIN: CLIENT LIST + EDIT/CREATE A CLIENT + PROJECT EDITOR + CONTRACT
// ============================================================
// These four areas are kept in one module because they share one big cluster
// of mutable "currently being edited" state (currentClientData, currentProjectId,
// currentPaymentDates, currentWorkflow*, currentRecording*, etc.) — the project
// editor populates it from the client editor's loaded doc, renders/mutates it
// across many small helpers, and the save handler writes it back. Splitting
// that cluster across files would mean exporting getters/setters for a dozen
// interdependent variables for no real benefit.
import {
  doc, setDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, escapeHtml, escapeAttr, getISO, setISO, enhanceDateField, formatDatePt,
  addMonthsIso, packPriceNumber, PACKS, MONTHLY_BATCH_MONTHS, MONTHLY_MONTH_LABELS,
  clampRec, isMonthlyWorkflow, isPontualWorkflow, isCustomPontualWorkflow, monthlyRecCounts, workflowModel, workflowDoneSet,
  isProjectComplete, recordingSlots, projectPaymentDates, paymentStatus,
  projectSteps, genId, clientLink, msg, toast, show, askConfirm, CAL_SVG,
  openGoogleCalendarEvent, pad2, setAdminHash, ADMIN_EMAIL, getProjects
} from './core.js';
import { syncProjectIncome, deleteClientIncome, todayIso } from './admin-finance.js';
import { buildContractHtml, buildDailyContractHtml, contractFileName, monthlyBlocks, dailyBlocks, downloadContractDocx } from './contract-template.js';

// ============================================================
//  ADMIN: CLIENT LIST
// ============================================================
// Company name (if the client set one) leads, personal name trails — e.g.
// "Tasca do Luís — Zaíra Bosco" — used anywhere a client is titled as one line.
function clientDisplayName(data){
  const personal = `${data.firstName || ''} ${data.lastName || ''}`.trim();
  const company = (data.company || '').trim();
  if(company && personal) return `${company} — ${personal}`;
  return company || personal;
}

// Cached client rows for the current session (id + data) — fetched once per
// loadAdminList() call, then re-split/re-rendered locally after a
// deactivate/reactivate instead of re-hitting Firestore.
let currentClientRows = [];

function clientCard(docSnap){
  const data = docSnap.data();
  const card = document.createElement('div');
  card.className = 'client-card';
  const projects = getProjects(data);
  const nProjects = projects.length;
  const name = `${data.firstName || ''} ${data.lastName || ''}`.trim();
  const initials = ((data.firstName || '')[0] || '') + ((data.lastName || '')[0] || '');
  // Earliest unpaid, dated instalment across all of this client's projects
  // — same "days until due" badge language used on the board/debts views,
  // so a card's border/pay line matches what "A receber" would show.
  let earliestIso = null;
  projects.forEach(p => {
    const dates = projectPaymentDates(p);
    const paid = p.paymentsPaid || [];
    dates.forEach((iso, i) => {
      if(paid[i] || !iso) return;
      if(!earliestIso || iso < earliestIso) earliestIso = iso;
    });
  });
  const payInfo = earliestIso ? paymentStatus(earliestIso) : null;
  if(payInfo) card.dataset.urgency = payInfo.mod;
  card.innerHTML = `
    <div class="client-avatar">${data.iconDataUrl ? `<img src="${data.iconDataUrl}" alt="">` : escapeHtml(initials.toUpperCase() || '?')}</div>
    <div class="client-card-body">
      <div class="name">${escapeHtml(name || data.email || 'Cliente')}</div>
      <div class="email">${escapeHtml(data.email || '')}</div>
    </div>
    <div class="client-card-foot">
      <span class="status-pill ${nProjects ? 'accepted' : ''}">${nProjects} projeto${nProjects === 1 ? '' : 's'}</span>
      ${payInfo ? `<div class="board-card-pay ${payInfo.mod}">${escapeHtml(payInfo.text)}</div>` : ''}
    </div>
  `;
  card.addEventListener('click', () => loadAdminEdit(docSnap.id, data));
  return card;
}

// Alphabetical-by-display-name comparator, shared by all three client groups.
function byClientName(a, b){
  const da = a.data(), db_ = b.data();
  const na = (da.company || `${da.firstName || ''} ${da.lastName || ''}`.trim() || da.email || '').toLowerCase();
  const nb = (db_.company || `${db_.firstName || ''} ${db_.lastName || ''}`.trim() || db_.email || '').toLowerCase();
  return na.localeCompare(nb, 'pt');
}

// Fills one grid with an empty-state fallback (if given one), or the sorted
// client cards.
function fillClientGrid(listEl, rows, emptyText){
  listEl.innerHTML = '';
  if(rows.length === 0){
    if(emptyText) listEl.innerHTML = `<div class="panel-empty">${emptyText}</div>`;
    return;
  }
  rows.slice().sort(byClientName).forEach(docSnap => listEl.appendChild(clientCard(docSnap)));
}

// Re-renders all three client groups from the cached rows — called on load and
// again after a deactivate/reactivate so the moved card lands in its new spot.
// Deactivated clients always land in "Desativados" regardless of projects;
// among the rest, clients with an ongoing project go to "Ativos" and everyone
// else stays in the plain list.
function renderClientGrid(){
  const active = [], deactivated = [], rest = [];
  currentClientRows.forEach(docSnap => {
    const data = docSnap.data();
    if(data.deactivated) deactivated.push(docSnap);
    else if(getProjects(data).length > 0) active.push(docSnap);
    else rest.push(docSnap);
  });

  document.getElementById('activeClientsCount').textContent = active.length ? String(active.length) : '';
  document.getElementById('deactivatedClientsCount').textContent = deactivated.length ? String(deactivated.length) : '';

  fillClientGrid(document.getElementById('activeClientList'), active, 'Nenhum cliente com projeto em curso.');
  fillClientGrid(document.getElementById('deactivatedClientList'), deactivated, 'Nenhum cliente desativado.');

  const listEl = document.getElementById('clientList');
  if(currentClientRows.length === 0){
    listEl.innerHTML = '<div class="panel-empty">Nenhum cliente ainda — crie o primeiro acima.</div>';
    return;
  }
  fillClientGrid(listEl, rest, '');
}

export async function loadAdminList(){
  setAdminHash('clientes');
  const listEl = document.getElementById('clientList');
  listEl.innerHTML = '<span class="loading-dot"></span>';
  let snap;
  try{
    snap = await getDocs(collection(db, "clients"));
  }catch(err){
    listEl.innerHTML = '<div class="panel-empty">Não foi possível carregar os clientes.</div>';
    show('view-admin');
    return;
  }
  // Never show the admin's own account as a client (e.g. a leftover doc
  // from an earlier version keyed to the admin's uid).
  currentClientRows = snap.docs.filter(d => (d.data().email || '') !== ADMIN_EMAIL);
  renderClientGrid();
  show('view-admin');
}

document.getElementById('adminNewClientBtn').addEventListener('click', () => {
  // Pre-generate a random doc id so the personal link exists immediately.
  const newRef = doc(collection(db, "clients"));
  loadAdminEdit(newRef.id, null);
});

// ============================================================
//  ADMIN: EDIT / CREATE A CLIENT
// ============================================================
let currentEditId = null;
let currentIsNew = false;
let currentClientData = {};   // the loaded client doc, incl. its projects array
let currentPaymentDates = [];   // editable payment dates for the project being edited
let currentPaymentsPaid = [];   // paid flags for the project being edited
let currentPaymentAmounts = []; // editable € value per instalment
let currentPaymentNotes = [];   // per-instalment description (pontual/avulso packs only)
let currentProjectId = null;  // project being edited
let currentRecordingCount = 2;    // recordings for a linear (non-monthly) project (1–3)
let currentRecordingCounts = [2, 2, 2];  // recordings PER MONTH for a monthly project (each 1–3)
let currentWorkflowProgress = 0;  // completed steps in the sequential (linear) workflow
let currentWorkflowDone = new Set(); // completed step keys in the branched (monthly) workflow
let openWfGroup = null; // which single box (Comum or a month) is expanded in the branched stepper accordion
let openWfGroupSet = false; // whether openWfGroup has been chosen yet (default vs. explicitly closed-to-null)
let currentRecordingDates = [];   // ISO date per recording for the project being edited
let currentRecordingTimes = [];   // optional HH:MM start time per recording (aligned with dates)
let currentRecordingEndTimes = []; // optional HH:MM end time per recording (aligned with dates)

// World nationalities (Portuguese). Populated once into the admin dropdown.
const NATIONALITIES = [
  'Afegã','Alemã','Andorrana','Angolana','Antiguana','Argelina','Argentina','Armênia','Australiana','Austríaca',
  'Azerbaijana','Bahamense','Bangladesa','Barbadiana','Bareinita','Belga','Belizenha','Beninense','Bielorrussa','Birmanesa',
  'Boliviana','Bósnia','Botsuanesa','Brasileira','Britânica','Bruneana','Búlgara','Burquinesa','Burundinesa','Butanesa',
  'Cabo-verdiana','Camaronesa','Cambojana','Canadense','Cazaque','Chadiana','Chilena','Chinesa','Cingalesa','Cipriota',
  'Colombiana','Comorense','Congolesa','Norte-coreana','Sul-coreana','Costa-marfinense','Costarriquenha','Croata','Cubana','Dinamarquesa',
  'Djibutiana','Dominicana','Egípcia','Emiradense','Equatoriana','Eritreia','Escocesa','Eslovaca','Eslovena','Espanhola',
  'Estadunidense','Estoniana','Etíope','Fijiana','Filipina','Finlandesa','Francesa','Gabonesa','Galesa','Gambiana',
  'Ganesa','Georgiana','Granadina','Grega','Guatemalteca','Guianense','Guineense','Guineense-equatoriana','Haitiana','Holandesa',
  'Hondurenha','Húngara','Iemenita','Indiana','Indonésia','Inglesa','Iraniana','Iraquiana','Irlandesa','Islandesa',
  'Israelense','Italiana','Jamaicana','Japonesa','Jordaniana','Kuwaitiana','Laosiana','Lesota','Letã','Libanesa',
  'Liberiana','Líbia','Liechtensteinense','Lituana','Luxemburguesa','Macedônia','Malaia','Malauiana','Maldivana','Malinesa',
  'Maltesa','Marroquina','Mauriciana','Mauritana','Mexicana','Micronésia','Moçambicana','Moldava','Monegasca','Mongol',
  'Montenegrina','Namibiana','Nauruana','Nepalesa','Nicaraguense','Nigeriana','Nigerina','Norueguesa','Neozelandesa','Omani',
  'Palestina','Panamenha','Papuásia','Paquistanesa','Paraguaia','Peruana','Polonesa','Portuguesa','Queniana','Quirguiz',
  'Centro-africana','Tcheca','Romena','Ruandesa','Russa','Salomonense','Salvadorenha','Samoana','San-marinense','Santa-lucense',
  'São-tomense','Saudita','Senegalesa','Serra-leonesa','Sérvia','Seichelense','Singapurense','Síria','Somali','Sri-lankesa',
  'Suazi','Sudanesa','Sul-africana','Sul-sudanesa','Sueca','Suíça','Surinamesa','Tailandesa','Taiwanesa','Tadjique',
  'Tanzaniana','Timorense','Togolesa','Tonganesa','Trindadense','Tunisiana','Turca','Turcomena','Tuvaluana','Ucraniana',
  'Ugandense','Uruguaia','Uzbeque','Vanuatuense','Venezuelana','Vietnamita','Zambiana','Zimbabuana','Outra'
];
(function populateNationalities(){
  const sel = document.getElementById('adminNationality');
  if(!sel) return;
  // Most-used first, then the rest alphabetically (without duplicating the two).
  const top = ['Brasileira', 'Portuguesa'];
  const rest = NATIONALITIES.filter(n => !top.includes(n));
  const opt = n => `<option value="${n}">${n}</option>`;
  sel.innerHTML = '<option value="">Selecione…</option>' +
    top.map(opt).join('') +
    '<option value="" disabled>──────────</option>' +
    rest.map(opt).join('');
})();

export function loadAdminEdit(clientId, data){
  currentEditId = clientId;
  currentIsNew = (data === null);
  currentClientData = data ? { ...data } : {};
  currentClientData.projects = getProjects(currentClientData);

  document.getElementById('adminEditEyebrow').textContent = currentIsNew ? 'Admin · Novo cliente' : 'Admin';
  document.getElementById('adminEditName').textContent =
    currentIsNew ? 'Novo cliente' : clientDisplayName(currentClientData);

  document.getElementById('adminCompany').value = currentClientData.company || '';
  document.getElementById('adminFirstName').value = currentClientData.firstName || '';
  document.getElementById('adminLastName').value = currentClientData.lastName || '';
  document.getElementById('adminEmail').value = currentClientData.email || '';
  document.getElementById('adminAddress').value = currentClientData.address || '';
  document.getElementById('adminNationality').value = currentClientData.nationality || '';
  document.getElementById('adminCity').value = currentClientData.city || '';
  document.getElementById('adminPostalCode').value = currentClientData.postalCode || '';
  document.getElementById('adminNif').value = currentClientData.nif || '';
  document.getElementById('adminPhone').value = currentClientData.phone || '';
  document.getElementById('adminReferral').value = currentClientData.referral || '';
  document.getElementById('adminNiche').value = currentClientData.niche || '';
  setIconPreview(currentClientData.iconDataUrl || '');

  // clear any leftover validation highlights
  ['adminEmail','adminPostalCode','adminNif','adminPhone']
    .forEach(id => document.getElementById(id).classList.remove('invalid'));

  document.getElementById('magicLink').value = clientLink(clientId);

  // A brand-new client has nothing to delete/deactivate — or a testimonial — yet.
  document.getElementById('adminDeleteZone').classList.toggle('hidden', currentIsNew);
  document.getElementById('adminDeactivateBtn').textContent =
    currentClientData.deactivated ? 'Reativar cliente' : 'Desativar cliente';
  document.getElementById('adminTestimonialSection').classList.toggle('hidden', currentIsNew);
  const testi = currentClientData.testimonial;
  document.getElementById('adminTestimonialEmpty').classList.toggle('hidden', !!(testi && testi.text));
  document.getElementById('adminTestimonialText').classList.toggle('hidden', !(testi && testi.text));
  document.getElementById('adminTestimonialClear').classList.toggle('hidden', !(testi && testi.text));
  if(testi && testi.text){
    const when = testi.updatedAt ? ` — ${formatDatePt(String(testi.updatedAt).slice(0, 10))}` : '';
    document.getElementById('adminTestimonialText').textContent = `"${testi.text}"${when}`;
  }

  ['adminDetailsMsg','copyMsg','adminProjectsMsg','adminDeleteMsg'].forEach(id => {
    document.getElementById(id).className = 'form-msg';
  });

  renderProjectList();
  show('view-admin-edit');
}

// Client-edit projects list
function renderProjectList(){
  const el = document.getElementById('projectList');
  const addBtn = document.getElementById('adminAddProjectBtn');
  if(currentIsNew){
    el.innerHTML = '<p class="panel-empty">Salve os dados do cliente primeiro — depois pode adicionar projetos.</p>';
    addBtn.disabled = true;
    return;
  }
  addBtn.disabled = false;
  const projects = currentClientData.projects || [];
  if(projects.length === 0){
    el.innerHTML = '<p class="panel-empty">Nenhum projeto ainda — adicione o primeiro abaixo.</p>';
    return;
  }
  el.innerHTML = '';
  projects.forEach(p => {
    const pack = p.pack ? PACKS[p.pack] : null;
    const row = document.createElement('div');
    row.className = 'project-row';
    const doneBadge = isProjectComplete(p) ? '<span class="badge-done">✓ Concluído</span>' : '';
    row.innerHTML = `
      <div class="pr-info">
        <div class="pr-name">${escapeHtml(p.name || 'Projeto sem nome')}</div>
        <div class="pr-sub">${pack ? escapeHtml(pack.name) : 'Pacote por definir'}</div>
      </div>
      <div class="pr-actions">
        ${doneBadge}
        <span class="pr-go">Editar →</span>
      </div>
    `;
    row.addEventListener('click', () => openProject(p.id));
    el.appendChild(row);
  });
}

document.getElementById('adminBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  loadAdminList();
});

// Live hint under the contract fields (admin), incl. computed 3-month end date.
function updateContractHint(){
  const hint = document.getElementById('adminContractHint');
  const pack = PACKS[document.getElementById('adminPack').value];
  const start = getISO(document.getElementById('adminContractStart'));
  if(!pack){ hint.textContent = ''; return; }
  if(pack.category === 'monthly'){
    hint.textContent = start
      ? `Contrato de ${MONTHLY_BATCH_MONTHS} meses — termina em ${formatDatePt(addMonthsIso(start, MONTHLY_BATCH_MONTHS))}.`
      : `Selecione a data de início para calcular o período de ${MONTHLY_BATCH_MONTHS} meses.`;
  } else {
    hint.textContent = start ? `Início em ${formatDatePt(start)}.` : '';
  }
}
// Avulso/pontual packs are payment-only: no contract date, resource links,
// or workflow checklist. "Trabalho Personalizado" (pontual-custom)
// is the one exception that also gets recording dates — see isCustomPontualWorkflow.
function updateProjectFormVisibility(){
  const packId = document.getElementById('adminPack').value;
  const pontual = isPontualWorkflow({ pack: packId });
  const customPontual = isCustomPontualWorkflow({ pack: packId });
  document.getElementById('adminContractStartField').classList.toggle('hidden', pontual);
  document.getElementById('linksSection').classList.toggle('hidden', pontual);
  document.getElementById('workflowSection').classList.toggle('hidden', pontual);
  document.getElementById('recDatesSection').classList.toggle('hidden', pontual && !customPontual);
}
document.getElementById('adminPack').addEventListener('change', () => {
  captureRecordingDates();   // keep typed dates when the slot layout changes
  const pack = PACKS[document.getElementById('adminPack').value];
  // Default a monthly pack to split (3), reset otherwise.
  document.getElementById('adminSplitPayments').checked = !!(pack && pack.category === 'monthly');
  currentPaymentAmounts = []; // let the new pack's price drive the suggested amounts
  autofillMonthlyDates();
  updateContractHint();
  updateProjectFormVisibility();
  renderPaymentList();
  renderRecordingCountControls();  // switch between single slider and per-month sliders
  renderStepper();          // switch between linear and branched (monthly) workflow
  renderRecordingDates();   // switch between flat and per-month recording dates
});
document.getElementById('adminContractStart').addEventListener('change', updateContractHint);

// How many payments the project currently has (also toggles the split row).
// Avulso/pontual packs are open-ended — the admin adds/removes rows freely,
// one per one-off service — instead of a count derived from the pack.
function paymentCount(){
  const pack = PACKS[document.getElementById('adminPack').value];
  const isMonthly = !!(pack && pack.category === 'monthly');
  document.getElementById('adminSplitRow').classList.toggle('hidden', !isMonthly);
  if(isPontualWorkflow({ pack: document.getElementById('adminPack').value })) return currentPaymentDates.length;
  const split = document.getElementById('adminSplitPayments').checked;
  return (isMonthly && split) ? MONTHLY_BATCH_MONTHS : 1;
}
// Convenience: fill any empty later dates from the 1st, one month apart (monthly only).
function autofillMonthlyDates(){
  const pack = PACKS[document.getElementById('adminPack').value];
  const isMonthly = !!(pack && pack.category === 'monthly');
  const n = (isMonthly && document.getElementById('adminSplitPayments').checked) ? MONTHLY_BATCH_MONTHS : 1;
  if(isMonthly && n > 1 && currentPaymentDates[0]){
    for(let k = 1; k < n; k++){ if(!currentPaymentDates[k]) currentPaymentDates[k] = addMonthsIso(currentPaymentDates[0], k); }
  }
}

// Renders an editable date + "Pago" toggle per payment. Each date is free-form.
// Avulso/pontual packs get an open-ended variant: a description field per row
// (each row is one one-off service, not an instalment of a single job) plus
// remove/add-row controls, since the count isn't fixed by the pack.
function renderPaymentList(){
  const el = document.getElementById('adminPaymentList');
  const packSel = document.getElementById('adminPack').value;
  const pontual = isPontualWorkflow({ pack: packSel });
  const customPontual = isCustomPontualWorkflow({ pack: packSel });
  const n = paymentCount();
  const title = customPontual
    ? 'Pagamentos deste trabalho personalizado — sem lembretes automáticos por email:'
    : pontual
    ? 'Pagamentos deste cliente — um por cada serviço avulso prestado:'
    : (n > 1
        ? `${n} pagamentos — defina cada data e marque os já pagos:`
        : 'Defina a data do pagamento e marque se já foi pago:');
  const packObj = PACKS[packSel];
  const price = packPriceNumber(packSel);
  // Monthly packs are priced PER MONTH, so each instalment is the full price
  // (e.g. 3× 495€). Avulso rows each default to the full pack price too (each
  // is an independent job, not a split of one price). Other packs charge the
  // total once (n = 1), so dividing is a no-op.
  const defAmt = pontual ? price
    : (packObj && packObj.category === 'monthly') ? price : (n > 0 ? price / n : 0);
  let html = `<div class="pay-admin-title">${title}</div>`;
  for(let i = 0; i < n; i++){
    const date = currentPaymentDates[i] || '';
    const paid = !!currentPaymentsPaid[i];
    const amt = (currentPaymentAmounts[i] != null && currentPaymentAmounts[i] !== '')
      ? currentPaymentAmounts[i]
      : (defAmt > 0 ? defAmt.toFixed(2) : '');
    const note = currentPaymentNotes[i] || '';
    html += `<div class="pay-admin-row${paid ? ' paid' : ''}${pontual ? ' is-pontual' : ''}">
      ${n > 1 ? `<span class="pay-admin-num">${i + 1}.</span>` : ''}
      <span class="date-field"><input type="text" class="pay-date-box date-inp" data-idx="${i}" data-iso="${date}" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" autocomplete="off"><button type="button" class="date-cal" aria-label="Abrir calendário">📅</button></span>
      <input type="number" class="pay-amt-box" data-idx="${i}" value="${amt}" min="0" step="0.01" placeholder="€" aria-label="Valor (€)">
      ${pontual ? `<input type="text" class="pay-note-box" data-idx="${i}" value="${escapeAttr(note)}" placeholder="Descrição do serviço" aria-label="Descrição do serviço">` : ''}
      <label class="pay-admin-paid"><input type="checkbox" class="pay-paid-box" data-idx="${i}"${paid ? ' checked' : ''}> Pago</label>
      ${pontual ? `<button type="button" class="pay-remove-btn" data-idx="${i}" aria-label="Remover este pagamento" title="Remover">✕</button>` : ''}
    </div>`;
  }
  if(pontual){
    html += `<button type="button" class="btn btn-ghost" id="adminAddPaymentBtn" style="margin-top:10px;">+ Adicionar pagamento</button>`;
  }
  el.innerHTML = html;
  // Display dates as dd/mm/aaaa and wire keyboard mask + calendar per row.
  el.querySelectorAll('.pay-date-box').forEach(inp => { setISO(inp, inp.dataset.iso); enhanceDateField(inp); });
  // Snapshot the amount + note inputs before any re-render, so typed values aren't lost.
  function captureRow(){
    el.querySelectorAll('.pay-amt-box').forEach(b => { currentPaymentAmounts[Number(b.dataset.idx)] = b.value; });
    el.querySelectorAll('.pay-note-box').forEach(b => { currentPaymentNotes[Number(b.dataset.idx)] = b.value; });
  }
  el.querySelectorAll('.pay-date-box').forEach(inp => {
    inp.addEventListener('change', () => {
      captureRow();
      const i = Number(inp.dataset.idx);
      currentPaymentDates[i] = getISO(inp);
      if(i === 0) autofillMonthlyDates(); // seed later instalments if still empty
      renderPaymentList();
    });
  });
  el.querySelectorAll('.pay-amt-box').forEach(inp => {
    inp.addEventListener('change', () => { currentPaymentAmounts[Number(inp.dataset.idx)] = inp.value; });
  });
  el.querySelectorAll('.pay-note-box').forEach(inp => {
    inp.addEventListener('change', () => { currentPaymentNotes[Number(inp.dataset.idx)] = inp.value; });
  });
  el.querySelectorAll('.pay-paid-box').forEach(box => {
    box.addEventListener('change', () => {
      captureRow();
      currentPaymentsPaid[Number(box.dataset.idx)] = box.checked;
      renderPaymentList();
    });
  });
  el.querySelectorAll('.pay-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      captureRow();
      const i = Number(btn.dataset.idx);
      currentPaymentDates.splice(i, 1);
      currentPaymentsPaid.splice(i, 1);
      currentPaymentAmounts.splice(i, 1);
      currentPaymentNotes.splice(i, 1);
      renderPaymentList();
    });
  });
  const addBtn = document.getElementById('adminAddPaymentBtn');
  if(addBtn){
    addBtn.addEventListener('click', () => {
      captureRow();
      currentPaymentDates.push('');
      currentPaymentsPaid.push(false);
      currentPaymentAmounts.push('');
      currentPaymentNotes.push('');
      renderPaymentList();
    });
  }
}
document.getElementById('adminSplitPayments').addEventListener('change', () => {
  autofillMonthlyDates();
  renderPaymentList();
});

// The "current" month = the first month (1-based) not yet fully completed in the
// branched workflow (falls back to the last month). Drives which collapsible box
// opens by default, so earlier finished months stay tucked away.
function currentMonthIndex(){
  const model = workflowModel({ pack: document.getElementById('adminPack').value }, currentRecordingCounts);
  for(let m = 1; m <= MONTHLY_BATCH_MONTHS; m++){
    const steps = model.filter(s => s.group === 'Mês ' + m);
    if(steps.length && !steps.every(s => currentWorkflowDone.has(s.key))) return m;
  }
  return MONTHLY_BATCH_MONTHS;
}
// Branched (3-month) stepper: a "Comum" block + 3 independent month boxes, all
// collapsible. Any step can be toggled in any order (no sequential locking).
// Accordion: only ONE box (Comum or a single month) is expanded at a time —
// opening one collapses whichever was open, so the checklist for 3 months
// (7+ steps each) can't all pile up on screen simultaneously.
function renderBranchedStepper(el){
  const packId = document.getElementById('adminPack').value;
  const model = workflowModel({ pack: packId }, currentRecordingCounts);
  const groups = [];
  model.forEach(s => {
    let g = groups.find(x => x.name === s.group);
    if(!g){ g = { name: s.group, steps: [] }; groups.push(g); }
    g.steps.push(s);
  });
  const doneCount = model.filter(s => currentWorkflowDone.has(s.key)).length;
  const checks = steps => steps.map(s => {
    const on = currentWorkflowDone.has(s.key);
    return `<label class="wf-check${on ? ' on' : ''}"><input type="checkbox" data-key="${s.key}"${on ? ' checked' : ''}><span>${escapeHtml(s.label)}</span></label>`;
  }).join('');
  const common = groups.find(g => g.name === 'Comum');
  const months = groups.filter(g => g.name.indexOf('Mês') === 0);
  // Default the open box to the current (first not fully done) month, unless
  // the admin already picked one this session (incl. explicitly closing it all).
  if(!openWfGroupSet){ openWfGroup = 'Mês ' + currentMonthIndex(); openWfGroupSet = true; }
  const box = (g) => {
    const gd = g.steps.filter(s => currentWorkflowDone.has(s.key)).length;
    const open = g.name === openWfGroup;
    return `<details class="wf-month" data-group="${escapeAttr(g.name)}"${open ? ' open' : ''}>`
      + `<summary class="box-sum"><span>${escapeHtml(g.name)}</span><span class="box-count">${gd}/${g.steps.length}</span></summary>`
      + `<div class="box-body">${checks(g.steps)}</div>`
      + `</details>`;
  };
  let html = `<p class="wf-hint">Marque cada etapa concluída (em qualquer ordem). ${doneCount}/${model.length} concluídas.</p>`;
  if(common) html += `<div class="wf-common">${box(common)}</div>`;
  html += '<div class="wf-months">' + months.map(box).join('') + '</div>';
  if(doneCount >= model.length) html += '<div class="wf-done">✓ Projeto concluído — todas as etapas finalizadas.</div>';
  el.innerHTML = html;
  el.querySelectorAll('.wf-month > .box-sum').forEach(sum => {
    sum.addEventListener('click', (e) => {
      e.preventDefault(); // we drive open/close via openWfGroup + a full re-render, not the native toggle
      const group = sum.parentElement.dataset.group;
      openWfGroup = (openWfGroup === group) ? null : group;
      openWfGroupSet = true;
      renderBranchedStepper(el);
    });
  });
  el.querySelectorAll('.wf-check input').forEach(inp => {
    inp.addEventListener('change', () => {
      if(inp.checked) currentWorkflowDone.add(inp.dataset.key);
      else currentWorkflowDone.delete(inp.dataset.key);
      renderBranchedStepper(el);
    });
  });
}

// Sequential stepper. `currentWorkflowProgress` = number of completed steps
// (steps before it are done, that index is the current step, the rest are locked).
function renderStepper(){
  const el = document.getElementById('workflowStepper');
  const packId = document.getElementById('adminPack').value;
  // Avulso/pontual packs (one-off service clients): no production checklist,
  // just the payment tracking above — see isPontualWorkflow in core.js.
  if(isPontualWorkflow({ pack: packId })){
    el.innerHTML = '<p class="wf-hint">Trabalho avulso — sem fluxo de produção, só o acompanhamento do pagamento acima.</p>';
    return;
  }
  // Monthly (3-month) packs use the branched, toggle-any-order stepper.
  if(isMonthlyWorkflow({ pack: packId })){
    renderBranchedStepper(el);
    return;
  }
  const steps = projectSteps(currentRecordingCount);
  if(currentWorkflowProgress > steps.length) currentWorkflowProgress = steps.length;
  const stepsHtml = steps.map((label, i) => {
    let cls = 'step', mark = '';
    if(i < currentWorkflowProgress){ cls += ' done'; mark = '✓'; }
    else if(i === currentWorkflowProgress){ cls += ' current'; }
    else cls += ' locked';
    return `<div class="${cls}" data-idx="${i}">
      <div class="step-marker"><div class="step-dot">${mark}</div></div>
      <div class="step-label">${escapeHtml(label)}</div>
    </div>`;
  }).join('');
  const done = currentWorkflowProgress >= steps.length;
  el.innerHTML = stepsHtml + (done ? '<div class="wf-done">✓ Projeto concluído — todas as etapas finalizadas.</div>' : '');
  el.querySelectorAll('.step').forEach(s => {
    s.addEventListener('click', () => {
      const i = Number(s.dataset.idx);
      if(i === currentWorkflowProgress) currentWorkflowProgress = i + 1;   // complete the current step
      else if(i < currentWorkflowProgress) currentWorkflowProgress = i;    // revert to (uncomplete) this step
      else return;                                                         // future step is locked
      renderStepper();
    });
  });
}
// The current recording-count override to feed workflowModel/recordingSlots:
// a per-month array for monthly packs, a single number otherwise.
function currentRecOverride(){
  return isMonthlyWorkflow({ pack: document.getElementById('adminPack').value })
    ? currentRecordingCounts : currentRecordingCount;
}
// Recording-count control(s): a 1/2/3 segmented control per month for monthly
// packs, a single one otherwise. Replaces the old range sliders — for a 1–3
// discrete choice a slider forces a drag gesture just to see/set 3 possible
// values; tapping the number directly is faster and the current value reads
// at a glance across all 3 months without hunting for a thumb's position.
// Re-rendered on open + pack change.
function renderRecordingCountControls(){
  const el = document.getElementById('recCountControls');
  if(!el) return;
  const monthly = isMonthlyWorkflow({ pack: document.getElementById('adminPack').value });
  const seg = (val, m, label) => `<div class="rec-seg" role="group" aria-label="${escapeAttr(label)}">` +
    [1, 2, 3].map(n => `<button type="button" class="rec-seg-btn${n === val ? ' active' : ''}" data-m="${m}" data-v="${n}">${n}</button>`).join('') +
    '</div>';
  if(monthly){
    el.innerHTML = `<label style="margin-bottom:12px;">Número de gravações por mês (1 a 3):</label>
      <div class="rec-count-grid">` +
      MONTHLY_MONTH_LABELS.map((mo, i) => `
        <div class="rec-count-col">
          <span class="rec-count-mo">${mo}</span>
          ${seg(currentRecordingCounts[i], i, `Gravações em ${mo}`)}
        </div>`).join('') +
      '</div>';
  } else {
    el.innerHTML = `<label style="margin-bottom:12px;">Número de gravações (visitas):</label>
      <div class="rec-count-row">${seg(currentRecordingCount, 'flat', 'Número de gravações')}</div>`;
  }
  el.querySelectorAll('.rec-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if(btn.classList.contains('active')) return;
      captureRecordingDates();
      const v = clampRec(btn.dataset.v);
      if(btn.dataset.m === 'flat') currentRecordingCount = v;
      else currentRecordingCounts[Number(btn.dataset.m)] = v;
      renderRecordingCountControls();
      renderStepper();
      renderRecordingDates();
    });
  });
}

// ---------- recording dates (one date field per gravação) ----------
// Time dropdown options in 15-min steps (like Google Calendar). Empty = "sem hora".
function timeSelectOptions(selected, emptyLabel){
  let opts = `<option value="">${emptyLabel}</option>`;
  for(let h = 0; h < 24; h++){
    for(let m = 0; m < 60; m += 15){
      const v = pad2(h) + ':' + pad2(m);
      opts += `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`;
    }
  }
  return opts;
}
function captureRecordingDates(){
  document.querySelectorAll('#adminRecordingDates .rec-date-box').forEach(inp => {
    currentRecordingDates[Number(inp.dataset.idx)] = getISO(inp);
  });
  document.querySelectorAll('#adminRecordingDates .rec-time-start').forEach(sel => {
    currentRecordingTimes[Number(sel.dataset.idx)] = sel.value || '';
  });
  document.querySelectorAll('#adminRecordingDates .rec-time-end').forEach(sel => {
    currentRecordingEndTimes[Number(sel.dataset.idx)] = sel.value || '';
  });
}
function renderRecordingDates(){
  const el = document.getElementById('adminRecordingDates');
  if(!el) return;
  const packVal = document.getElementById('adminPack').value;
  const monthly = isMonthlyWorkflow({ pack: packVal });
  const customPontual = isCustomPontualWorkflow({ pack: packVal });
  const slots = recordingSlots({ pack: packVal, recordingDates: currentRecordingDates }, currentRecOverride());
  const rowHtml = s => {
    const iso = currentRecordingDates[s.idx] || '';
    const time = currentRecordingTimes[s.idx] || '';
    const endTime = currentRecordingEndTimes[s.idx] || '';
    return `<div class="rec-date-row">
      <span class="rec-date-num">${escapeHtml(s.label)}</span>
      <span class="date-field"><input type="text" class="rec-date-box date-inp" data-idx="${s.idx}" data-iso="${iso}" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" autocomplete="off"><button type="button" class="date-cal" aria-label="Abrir calendário">📅</button></span>
      <span class="rec-time-group">
        <select class="rec-time-box rec-time-start" data-idx="${s.idx}" aria-label="Hora de início">${timeSelectOptions(time, 'início')}</select>
        <span class="rec-time-sep">–</span>
        <select class="rec-time-box rec-time-end" data-idx="${s.idx}" aria-label="Hora de fim">${timeSelectOptions(endTime, 'fim')}</select>
      </span>
      <button type="button" class="cal-btn rec-cal-admin" data-idx="${s.idx}" data-label="${escapeAttr(s.label)}">${CAL_SVG}Adicionar ao meu calendário</button>
      ${customPontual ? `<button type="button" class="pay-remove-btn rec-remove-btn" data-idx="${s.idx}" aria-label="Remover esta gravação" title="Remover">✕</button>` : ''}
    </div>`;
  };
  if(monthly){
    // One collapsible box per month; open only the current month by default,
    // keeping the admin's manual expand/collapse across re-renders.
    const hadRender = el.children.length > 0;
    const prevOpen = new Set([...el.querySelectorAll('.rec-month[open]')].map(d => d.dataset.month));
    const curMonth = currentMonthIndex();
    let html = '';
    for(let m = 1; m <= MONTHLY_BATCH_MONTHS; m++){
      const monthSlots = slots.filter(s => s.month === m);
      if(!monthSlots.length) continue;
      const filled = monthSlots.filter(s => currentRecordingDates[s.idx]).length;
      const open = hadRender ? prevOpen.has(String(m)) : (m === curMonth);
      html += `<details class="rec-month" data-month="${m}"${open ? ' open' : ''}>`
        + `<summary class="box-sum"><span>Gravações — ${MONTHLY_MONTH_LABELS[m - 1]}</span><span class="box-count">${filled}/${monthSlots.length}</span></summary>`
        + `<div class="box-body">${monthSlots.map(rowHtml).join('')}</div>`
        + `</details>`;
    }
    el.innerHTML = html;
  } else if(customPontual){
    // Open-ended, like the pontual payment list: admin adds/removes rows freely.
    el.innerHTML = (slots.length ? slots.map(rowHtml).join('') : '<p class="panel-empty">Nenhuma gravação ainda — adicione a primeira abaixo.</p>')
      + `<button type="button" class="btn btn-ghost" id="adminAddRecordingBtn" style="margin-top:10px;">+ Adicionar gravação</button>`;
  } else {
    el.innerHTML = slots.map(rowHtml).join('');
  }
  el.querySelectorAll('.rec-date-box').forEach(inp => {
    setISO(inp, inp.dataset.iso);
    enhanceDateField(inp);
    inp.addEventListener('change', () => { currentRecordingDates[Number(inp.dataset.idx)] = getISO(inp); });
  });
  el.querySelectorAll('.rec-time-start').forEach(sel => {
    sel.addEventListener('change', () => { currentRecordingTimes[Number(sel.dataset.idx)] = sel.value || ''; });
  });
  el.querySelectorAll('.rec-time-end').forEach(sel => {
    sel.addEventListener('change', () => { currentRecordingEndTimes[Number(sel.dataset.idx)] = sel.value || ''; });
  });
  if(customPontual){
    el.querySelectorAll('.rec-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        captureRecordingDates();
        const i = Number(btn.dataset.idx);
        currentRecordingDates.splice(i, 1);
        currentRecordingTimes.splice(i, 1);
        currentRecordingEndTimes.splice(i, 1);
        renderRecordingDates();
      });
    });
    const addBtn = document.getElementById('adminAddRecordingBtn');
    if(addBtn){
      addBtn.addEventListener('click', () => {
        captureRecordingDates();
        currentRecordingDates.push('');
        currentRecordingTimes.push('');
        currentRecordingEndTimes.push('');
        renderRecordingDates();
      });
    }
  }
  // Admin: add this recording to the admin's own Google Calendar (reads the row live).
  el.querySelectorAll('.rec-cal-admin').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.rec-date-row');
      const iso = row ? getISO(row.querySelector('.rec-date-box')) : '';
      if(!iso){ toast('Defina a data desta gravação primeiro', true); return; }
      const startSel = row.querySelector('.rec-time-start');
      const endSel = row.querySelector('.rec-time-end');
      const name = document.getElementById('adminProjectName').value.trim();
      const label = btn.dataset.label || 'Gravação';
      openGoogleCalendarEvent({
        dateIso: iso,
        time: startSel ? startSel.value : '',
        endTime: endSel ? endSel.value : '',
        summary: label + (name ? ' — ' + name : ' — Ester'),
        description: 'Sessão de gravação' + (name ? ' do projeto ' + name : '') + ' com a Ester.'
      });
    });
  });
}

// ---------- field validators ----------
function isValidEmail(v){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function isValidPostalCode(v){
  // Portuguese postal code: 7 digits, with or without the hyphen (1234-567 or 1234567)
  return /^\d{4}-?\d{3}$/.test(v);
}
// Store postal codes consistently as 1234-567 (accepts 7 raw digits too).
function normalizePostal(v){
  const t = (v || '').trim();
  const digits = t.replace(/\D/g, '');
  return digits.length === 7 ? digits.slice(0, 4) + '-' + digits.slice(4) : t;
}
function isValidNif(v){
  // 9 digits + Portuguese check-digit
  if(!/^\d{9}$/.test(v)) return false;
  const d = v.split('').map(Number);
  let sum = 0;
  for(let i = 0; i < 8; i++) sum += d[i] * (9 - i);
  let check = 11 - (sum % 11);
  if(check >= 10) check = 0;
  return check === d[8];
}
function isValidPhone(v){
  // optional +351, then 9 digits; spaces/hyphens ignored
  return /^(\+351)?\d{9}$/.test(v.replace(/[\s-]/g, ''));
}

// ----- Client mobile icon: upload → downscale in-browser → store as a small
// data URL on the client doc (no Firebase Storage needed). The client portal
// uses it as the home-screen apple-touch-icon; empty ⇒ default icon. -----
function setIconPreview(url){
  const img = document.getElementById('adminIconPreview');
  if(url){ img.src = url; } else { img.removeAttribute('src'); }
}
document.getElementById('adminIconInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';                 // allow re-picking the same file later
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const S = 512;                    // square, retina-friendly, tiny once JPEG'd
      const c = document.createElement('canvas'); c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, S, S);   // brand background
      const r = Math.min(S / img.width, S / img.height);     // contain (never crops)
      const w = img.width * r, h = img.height * r;
      ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      const url = c.toDataURL('image/jpeg', 0.9);
      currentClientData.iconDataUrl = url;
      setIconPreview(url);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});
document.getElementById('adminIconClear').addEventListener('click', () => {
  currentClientData.iconDataUrl = '';
  setIconPreview('');
});

document.getElementById('adminSaveDetailsBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('adminDetailsMsg');
  const details = {
    company: document.getElementById('adminCompany').value.trim(),
    firstName: document.getElementById('adminFirstName').value.trim(),
    lastName: document.getElementById('adminLastName').value.trim(),
    email: document.getElementById('adminEmail').value.trim(),
    nationality: document.getElementById('adminNationality').value,
    address: document.getElementById('adminAddress').value.trim(),
    city: document.getElementById('adminCity').value.trim(),
    postalCode: normalizePostal(document.getElementById('adminPostalCode').value),
    nif: document.getElementById('adminNif').value.trim(),
    phone: document.getElementById('adminPhone').value.trim(),
    referral: document.getElementById('adminReferral').value.trim(),
    niche: document.getElementById('adminNiche').value.trim(),
    iconDataUrl: currentClientData.iconDataUrl || ''
  };

  // Validate: first name required; the rest are format-checked when present.
  ['adminEmail','adminPostalCode','adminNif','adminPhone']
    .forEach(id => document.getElementById(id).classList.remove('invalid'));
  const problems = [];
  if(!details.firstName){
    msg(msgEl, "Informe pelo menos o nome.", "error");
    return;
  }
  if(details.email && !isValidEmail(details.email)) problems.push(['adminEmail', 'um email válido']);
  if(details.postalCode && !isValidPostalCode(details.postalCode)) problems.push(['adminPostalCode', 'um código postal válido (1234-567 ou 1234567)']);
  if(!details.nif) problems.push(['adminNif', 'o NIF (obrigatório)']);
  else if(!isValidNif(details.nif)) problems.push(['adminNif', 'um NIF válido de 9 dígitos']);
  if(details.phone && !isValidPhone(details.phone)) problems.push(['adminPhone', 'um telefone válido (9 dígitos, +351 opcional)']);
  if(problems.length){
    problems.forEach(([id]) => document.getElementById(id).classList.add('invalid'));
    msg(msgEl, `Por favor, informe ${problems.map(p => p[1]).join(', ')}.`, "error");
    return;
  }

  try{
    if(currentIsNew){
      await setDoc(doc(db, "clients", currentEditId), {
        ...details,
        projects: [],
        createdAt: serverTimestamp()
      });
      currentIsNew = false;
      Object.assign(currentClientData, details, { projects: [] });
      document.getElementById('adminEditEyebrow').textContent = 'Admin';
      document.getElementById('adminDeleteZone').classList.remove('hidden');
      renderProjectList(); // now enabled — client space exists
      msg(msgEl, "Cliente criado. Copie o link pessoal e adicione os projetos.", "ok");
    } else {
      await setDoc(doc(db, "clients", currentEditId), details, { merge: true });
      Object.assign(currentClientData, details);
      msg(msgEl, "Salvo.", "ok");
    }
    document.getElementById('adminEditName').textContent = clientDisplayName(details) || 'Cliente';
    toast('Dados guardados ✓');
  }catch(err){
    msg(msgEl, "Não foi possível salvar. Tente novamente.", "error");
    toast('Não foi possível guardar', true);
  }
});

document.getElementById('copyLinkBtn').addEventListener('click', async () => {
  const link = document.getElementById('magicLink').value;
  const msgEl = document.getElementById('copyMsg');
  try{
    await navigator.clipboard.writeText(link);
    msg(msgEl, "Link copiado para a área de transferência.", "ok");
  }catch(err){
    // Fallback: select the field so the user can copy manually.
    document.getElementById('magicLink').select();
    msg(msgEl, "Pressione Ctrl/Cmd+C para copiar o link selecionado.", "ok");
  }
});

document.getElementById('adminTestimonialClear').addEventListener('click', async () => {
  const ok = await askConfirm({
    title: 'Remover depoimento',
    message: 'Tem certeza que deseja remover este depoimento?',
    confirmText: 'Remover'
  });
  if(!ok) return;
  try{
    await updateDoc(doc(db, 'clients', currentEditId), { testimonial: null });
    currentClientData.testimonial = null;
    document.getElementById('adminTestimonialEmpty').classList.remove('hidden');
    document.getElementById('adminTestimonialText').classList.add('hidden');
    document.getElementById('adminTestimonialClear').classList.add('hidden');
    toast('Depoimento removido.');
  }catch(err){
    toast('Erro ao remover depoimento.', true);
  }
});

// ============================================================
//  ADMIN: PROJECT EDITOR (a project inside a client)
// ============================================================
export function openProject(projectId){
  const p = (currentClientData.projects || []).find(x => x.id === projectId)
    || { id: projectId, name: '', pack: '', contractStart: '', splitPayments: true, paymentDates: [], paymentsPaid: [], driveLink: '', deliveryDate: '', workflow: {} };
  currentProjectId = projectId;
  currentPaymentDates = projectPaymentDates(p).slice();
  currentPaymentsPaid = Array.isArray(p.paymentsPaid) ? p.paymentsPaid.slice() : [];
  currentPaymentAmounts = Array.isArray(p.paymentAmounts) ? p.paymentAmounts.slice() : [];
  currentPaymentNotes = Array.isArray(p.paymentNotes) ? p.paymentNotes.slice() : [];

  document.getElementById('projectTitle').textContent = p.name || 'Projeto';
  document.getElementById('adminProjectName').value = p.name || '';
  document.getElementById('adminPack').value = p.pack || '';
  setISO(document.getElementById('adminContractStart'), p.contractStart || '');
  document.getElementById('adminSplitPayments').checked = p.splitPayments !== false;
  document.getElementById('adminDriveLink').value = p.driveLink || '';
  setISO(document.getElementById('adminDeliveryDate'), p.deliveryDate || '');
  currentRecordingCount = clampRec(p.recordingCount || 2);
  currentRecordingCounts = Array.isArray(p.recordingCounts)
    ? monthlyRecCounts(p)
    : [currentRecordingCount, currentRecordingCount, currentRecordingCount];
  currentWorkflowProgress = p.workflowProgress || 0;
  currentWorkflowDone = workflowDoneSet(p);
  openWfGroup = null; openWfGroupSet = false; // re-derive the default open box for this project's own progress
  currentRecordingDates = Array.isArray(p.recordingDates) ? p.recordingDates.slice() : [];
  currentRecordingTimes = Array.isArray(p.recordingTimes) ? p.recordingTimes.slice() : [];
  currentRecordingEndTimes = Array.isArray(p.recordingEndTimes) ? p.recordingEndTimes.slice() : [];
  updateContractHint();
  updateProjectFormVisibility();
  renderPaymentList();
  renderRecordingCountControls();
  renderStepper();
  renderRecordingDates();

  ['adminProjectMsg','adminDeleteProjectMsg'].forEach(id => { document.getElementById(id).className = 'form-msg'; });
  show('view-admin-project');
}

document.getElementById('adminAddProjectBtn').addEventListener('click', () => {
  if(currentIsNew) return;
  openProject(genId()); // fresh id; only persisted to the array on save
});

document.getElementById('projectBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  renderProjectList();
  show('view-admin-edit');
});

document.getElementById('adminSaveProjectBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('adminProjectMsg');
  captureRecordingDates();
  const project = {
    id: currentProjectId,
    name: document.getElementById('adminProjectName').value.trim() || 'Projeto sem nome',
    pack: document.getElementById('adminPack').value,
    contractStart: getISO(document.getElementById('adminContractStart')),
    splitPayments: document.getElementById('adminSplitPayments').checked,
    paymentDates: Array.from(document.querySelectorAll('#adminPaymentList .pay-date-box')).map(b => getISO(b)),
    paymentsPaid: Array.from(document.querySelectorAll('#adminPaymentList .pay-paid-box')).map(b => b.checked),
    paymentAmounts: Array.from(document.querySelectorAll('#adminPaymentList .pay-amt-box')).map(b => Number(b.value) || 0),
    paymentNotes: Array.from(document.querySelectorAll('#adminPaymentList .pay-note-box')).map(b => b.value.trim()),
    driveLink: document.getElementById('adminDriveLink').value.trim(),
    deliveryDate: getISO(document.getElementById('adminDeliveryDate')),
    recordingCount: currentRecordingCount
  };
  const packVal = project.pack;
  const monthly = isMonthlyWorkflow({ pack: packVal });
  const recOverride = monthly ? currentRecordingCounts : currentRecordingCount;
  const slotLen = recordingSlots({ pack: packVal, recordingDates: currentRecordingDates }, recOverride).length;
  project.recordingDates    = currentRecordingDates.slice(0, slotLen).map(d => d || '');
  project.recordingTimes    = currentRecordingTimes.slice(0, slotLen).map(t => t || '');
  project.recordingEndTimes = currentRecordingEndTimes.slice(0, slotLen).map(t => t || '');
  // Branched (monthly) packs persist a set of completed step keys + the per-month
  // recording counts; linear packs keep the integer progress count.
  if(monthly){
    project.recordingCounts = currentRecordingCounts.map(clampRec);
    const validKeys = new Set(workflowModel({ pack: packVal }, project.recordingCounts).map(s => s.key));
    project.workflowDone = Array.from(currentWorkflowDone).filter(k => validKeys.has(k));
  } else {
    project.workflowProgress = currentWorkflowProgress;
  }
  const list = currentClientData.projects || (currentClientData.projects = []);
  const idx = list.findIndex(x => x.id === currentProjectId);
  if(idx >= 0) list[idx] = project; else list.push(project);
  try{
    await updateDoc(doc(db, "clients", currentEditId), { projects: list });
    document.getElementById('projectTitle').textContent = project.name;
    // Keep the income ledger in sync with the paid instalments (best-effort).
    const clientName = `${currentClientData.firstName || ''} ${currentClientData.lastName || ''}`.trim();
    try{ await syncProjectIncome(currentEditId, clientName, project); }catch(e){ /* non-fatal */ }
    msg(msgEl, "Projeto guardado. As receitas dos pagamentos marcados como pagos foram sincronizadas no Financeiro.", "ok");
    toast('Projeto guardado ✓');
  }catch(err){
    msg(msgEl, "Não foi possível salvar. Tente novamente.", "error");
    toast('Não foi possível guardar', true);
  }
});

// ============================================================
//  CONTRACT GENERATOR — fills the base contract for the project's pack
//  (monthly, daily, or pontual/avulso — see generateMonthlyContract /
//  generateDailyContract below) and opens a print-ready page (browser
//  "Guardar como PDF").
// ============================================================
// Plan text per monthly pack (from docs/Info_template_contrato.md). The 2026
// ids are the current offering (new contracts); the plain ids are LEGACY —
// kept verbatim so regenerating a contract for a client signed before the
// 2026-07-22 price update still reflects what they actually agreed to.
const CONTRACT_PLANS = {
  'monthly-pro-2026': {
    desc: 'até 12 vídeos estratégicos roteirizados de até 1 min + pack de 15 fotos + organização visual + legendas + 2 vídeos trend de até 20s',
    grav: '2 (duas) diárias de gravação no mês'
  },
  'monthly-essencial-2026': {
    desc: 'até 8 vídeos estratégicos roteirizados de até 1 min + pack de 10 fotos + organização visual + 1 vídeo trend de até 20s',
    grav: '1 (uma) diária de gravação no mês'
  },
  'monthly-start-2026': {
    desc: 'até 6 vídeos estratégicos roteirizados de até 1 min + pack de 5 fotos',
    grav: '1 (uma) visita no mês de até 6 horas de gravação'
  },
  'monthly-pro': {
    desc: '12 vídeos roteirizados de até 1 min + pack de 15 fotos + criação de legendas para post + organização visual + trends curtas de até 20s',
    grav: '2 (duas) visitas no mês de até 5 horas de gravação (cada)'
  },
  'monthly-essential': {
    desc: '8 vídeos roteirizados de até 1 min + pack de 10 fotos + criação de legendas para post + organização visual',
    grav: '1 (uma) visita no mês de até 5 horas de gravação'
  },
  'monthly-basic': {
    desc: '6 vídeos roteirizados de até 1 min + pack de 5 fotos',
    grav: '1 (uma) visita no mês de até 4 horas de gravação'
  }
};
// "Gravações" text for the daily/pontual contract (js/contract-template.js
// buildDailyContractHtml), from docs/Packs.md. Fixed-hour packs get a fixed
// sentence; "Trabalho Personalizado" (open-ended recording dates) computes
// its own via customGravText() below, from however many dates are set.
const DAILY_CONTRACT_PLANS = {
  'daily-pro': { grav: '02 (duas) diárias de gravação, com duração de até 4 (quatro) horas cada.' },
  'daily-basic': { grav: '01 (uma) diária de gravação, com duração de até 4 (quatro) horas.' }
};
const PONTUAL_COUNT_WORDS = { 2: 'duas', 3: 'três', 4: 'quatro', 5: 'cinco', 6: 'seis' };
function customGravText(packId){
  if(packId === 'pontual-1h') return '01 (uma) visita pontual, com duração de até 1 (uma) hora de gravação.';
  if(packId === 'pontual-2h') return '01 (uma) visita pontual, com duração de até 2 (duas) horas de gravação.';
  if(packId === 'pontual-custom'){
    const n = recordingSlots({ pack: packId, recordingDates: currentRecordingDates }).length;
    if(!n) return '';
    if(n === 1) return '01 (uma) visita pontual, conforme a data definida no planeamento.';
    const word = PONTUAL_COUNT_WORDS[n] || String(n);
    return `${String(n).padStart(2, '0')} (${word}) visitas pontuais, conforme as datas definidas no planeamento.`;
  }
  return '';
}
const eurNum = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Integer 0–999999 in Portuguese words.
function intPorExtenso(num){
  num = Math.floor(num);
  if(num === 0) return 'zero';
  const u = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
  const especiais = ['dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezasseis', 'dezassete', 'dezoito', 'dezanove'];
  const dezenas = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const centenas = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  function ate99(n){
    if(n < 10) return u[n];
    if(n < 20) return especiais[n - 10];
    const d = Math.floor(n / 10), r = n % 10;
    return dezenas[d] + (r ? ' e ' + u[r] : '');
  }
  function ate999(n){
    if(n === 100) return 'cem';
    const c = Math.floor(n / 100), r = n % 100;
    return (c ? centenas[c] : '') + (c && r ? ' e ' : '') + (r ? ate99(r) : '');
  }
  const milhar = Math.floor(num / 1000), resto = num % 1000;
  let s = '';
  if(milhar > 0) s += (milhar === 1 ? 'mil' : ate999(milhar) + ' mil');
  if(resto > 0){
    if(milhar > 0) s += (resto < 100 || resto % 100 === 0 ? ' e ' : ' ');
    s += ate999(resto);
  }
  return s;
}
// Euro amount in words, e.g. 1485 → "mil quatrocentos e oitenta e cinco euros".
function valorPorExtenso(n){
  n = Math.round((Number(n) || 0) * 100) / 100;
  const inteiro = Math.floor(n);
  const cent = Math.round((n - inteiro) * 100);
  let s = intPorExtenso(inteiro) + ' ' + (inteiro === 1 ? 'euro' : 'euros');
  if(cent > 0) s += ' e ' + intPorExtenso(cent) + ' ' + (cent === 1 ? 'cêntimo' : 'cêntimos');
  return s;
}
// Last business day (Mon–Fri) of the 3rd contract month, as dd/mm/aaaa.
function lastBusinessDayPt(startIso){
  if(!startIso) return '';
  const [y, m] = startIso.split('-').map(Number);
  const d = new Date(y, (m - 1) + 3, 0);            // last day of the 3rd month (start month + 2)
  while(d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return formatDatePt(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
}
// Opens the generated HTML as a real blob: URL (not about:blank via
// document.write) — the page loads as a normal navigation, so onload fires
// reliably and auto-print works. Shared by both contract generators below.
function openContractWindow(html, c, msgEl, missing){
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if(!w){ URL.revokeObjectURL(url); msg(msgEl, 'Permita pop-ups para gerar o contrato.', 'error'); return; }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  if(missing.length){
    msg(msgEl, 'Contrato gerado com campos em falta (a vermelho): ' + missing.join(', ') + '. Preenche e guarda, depois gera de novo.', 'error');
  } else {
    msg(msgEl, 'Contrato gerado. Na janela nova, usa “Guardar como PDF”. Sugestão de nome: ' + contractFileName(c) + '.pdf', 'ok');
  }
}

// Pure: gathers the project-editor form state into the {c, v, missing} shape
// both the PDF and the .docx generators need — shared so the two output
// paths can never compute different values from the same on-screen form.
function computeMonthlyContractV(packId){
  const c = currentClientData;
  const amounts = Array.from(document.querySelectorAll('#adminPaymentList .pay-amt-box')).map(b => Number(b.value) || 0);
  const dates = Array.from(document.querySelectorAll('#adminPaymentList .pay-date-box')).map(b => getISO(b));
  const startIso = getISO(document.getElementById('adminContractStart'));
  const total = amounts.reduce((s, a) => s + a, 0);
  const parcela = amounts.find(a => a > 0) || 0;
  const plan = CONTRACT_PLANS[packId];

  // Flag anything still empty so the admin knows what to fill in.
  const missing = [];
  if(!c.firstName) missing.push('Nome');
  if(!c.lastName) missing.push('Sobrenome');
  if(!c.nationality) missing.push('Nacionalidade');
  if(!c.nif) missing.push('NIF');
  if(!c.address) missing.push('Endereço');
  if(!c.postalCode) missing.push('Código Postal');
  if(!startIso) missing.push('Início do contrato');
  if(total <= 0) missing.push('Valores das parcelas');
  if(dates.filter(Boolean).length < 3) missing.push('Datas dos 3 pagamentos');

  const v = {
    desc: plan.desc, grav: plan.grav,
    total: total > 0 ? eurNum.format(total) : '', totalExt: total > 0 ? valorPorExtenso(total) : '',
    parcela: parcela > 0 ? eurNum.format(parcela) : '', parcelaExt: parcela > 0 ? valorPorExtenso(parcela) : '',
    data1: dates[0] ? formatDatePt(dates[0]) : '', data2: dates[1] ? formatDatePt(dates[1]) : '', data3: dates[2] ? formatDatePt(dates[2]) : '',
    fim: lastBusinessDayPt(startIso),
    dataGeracao: formatDatePt(todayIso())
  };
  return { c, v, missing };
}

function generateMonthlyContract(msgEl, packId){
  const { c, v, missing } = computeMonthlyContractV(packId);
  openContractWindow(buildContractHtml(c, v), c, msgEl, missing);
}

// "Pacotes Diários" and "Trabalhos Pontuais" (incl. "Trabalho Personalizado"):
// a single job, not a fixed 3-month term — payments are whatever open-ended
// list is on the payment editor (1 row for daily packs, N for pontual ones).
function computeDailyContractV(packId){
  const c = currentClientData;
  const packObj = PACKS[packId];
  const amounts = Array.from(document.querySelectorAll('#adminPaymentList .pay-amt-box')).map(b => Number(b.value) || 0);
  const dates = Array.from(document.querySelectorAll('#adminPaymentList .pay-date-box')).map(b => getISO(b));
  const total = amounts.reduce((s, a) => s + a, 0);
  const parcelas = (amounts.length ? amounts : ['']).map((amt, i) => ({
    amount: amt > 0 ? eurNum.format(amt) : '',
    date: dates[i] ? formatDatePt(dates[i]) : ''
  }));
  const plan = DAILY_CONTRACT_PLANS[packId];
  const grav = plan ? plan.grav : customGravText(packId);

  const missing = [];
  if(!c.firstName) missing.push('Nome');
  if(!c.lastName) missing.push('Sobrenome');
  if(!c.nationality) missing.push('Nacionalidade');
  if(!c.nif) missing.push('NIF');
  if(!c.address) missing.push('Endereço');
  if(!c.postalCode) missing.push('Código Postal');
  if(total <= 0) missing.push('Valor(es) do(s) pagamento(s)');
  if(!parcelas.length || parcelas.some(p => !p.date)) missing.push('Data(s) do(s) pagamento(s)');
  if(!grav) missing.push('Datas/gravações (adicione-as na secção acima antes de gerar)');

  const v = {
    formato: packObj.category === 'daily' ? 'diário' : 'pontual',
    grav,
    total: total > 0 ? eurNum.format(total) : '', totalExt: total > 0 ? valorPorExtenso(total) : '',
    parcelas,
    dataGeracao: formatDatePt(todayIso())
  };
  return { c, v, missing };
}

function generateDailyContract(msgEl, packId){
  const { c, v, missing } = computeDailyContractV(packId);
  openContractWindow(buildDailyContractHtml(c, v), c, msgEl, missing);
}

// Shared by both .docx generators below: downloads the file directly (no
// print-preview popup needed for this path, unlike PDF), with a brief
// disabled/"A gerar..." state on the button while the CDN library loads.
async function runDocxDownload(btn, msgEl, c, blocksResult, missing){
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'A gerar...';
  try{
    await downloadContractDocx(c, blocksResult);
    if(missing.length){
      msg(msgEl, 'Contrato .docx gerado com campos em falta (a vermelho): ' + missing.join(', ') + '. Preenche e guarda, depois gera de novo.', 'error');
    } else {
      msg(msgEl, 'Contrato .docx gerado: ' + contractFileName(c) + '.docx', 'ok');
    }
  } catch(err){
    msg(msgEl, 'Não foi possível gerar o .docx (verifica a ligação à internet) — usa o botão de PDF como alternativa.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

function generateMonthlyContractDocx(btn, msgEl, packId){
  const { c, v, missing } = computeMonthlyContractV(packId);
  return runDocxDownload(btn, msgEl, c, monthlyBlocks(c, v), missing);
}

function generateDailyContractDocx(btn, msgEl, packId){
  const { c, v, missing } = computeDailyContractV(packId);
  return runDocxDownload(btn, msgEl, c, dailyBlocks(c, v), missing);
}

document.getElementById('adminGenContractBtn').addEventListener('click', () => {
  const msgEl = document.getElementById('adminContractMsg');
  const packId = document.getElementById('adminPack').value;
  const packObj = PACKS[packId];
  if(isMonthlyWorkflow({ pack: packId }) && CONTRACT_PLANS[packId]){
    generateMonthlyContract(msgEl, packId);
  } else if(packObj && (packObj.category === 'daily' || packObj.category === 'pontual')){
    generateDailyContract(msgEl, packId);
  } else {
    msg(msgEl, 'O contrato-base está disponível para pacotes mensais, diários ou trabalhos pontuais. Seleciona um desses pacotes.', 'error');
  }
});

document.getElementById('adminGenContractDocxBtn').addEventListener('click', (e) => {
  const msgEl = document.getElementById('adminContractMsg');
  const packId = document.getElementById('adminPack').value;
  const packObj = PACKS[packId];
  if(isMonthlyWorkflow({ pack: packId }) && CONTRACT_PLANS[packId]){
    generateMonthlyContractDocx(e.currentTarget, msgEl, packId);
  } else if(packObj && (packObj.category === 'daily' || packObj.category === 'pontual')){
    generateDailyContractDocx(e.currentTarget, msgEl, packId);
  } else {
    msg(msgEl, 'O contrato-base está disponível para pacotes mensais, diários ou trabalhos pontuais. Seleciona um desses pacotes.', 'error');
  }
});

document.getElementById('adminDeleteProjectBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('adminDeleteProjectMsg');
  const name = document.getElementById('adminProjectName').value.trim() || 'este projeto';
  const ok = await askConfirm({
    title: 'Remover projeto',
    message: `Remover "${name}"? Esta ação não pode ser desfeita.`,
    confirmText: 'Deletar',
    cancelText: 'Cancelar'
  });
  if(!ok) return;
  const list = (currentClientData.projects || []).filter(x => x.id !== currentProjectId);
  try{
    await updateDoc(doc(db, "clients", currentEditId), { projects: list });
    currentClientData.projects = list;
    // Drop any auto income tied to this now-removed project.
    try{ await syncProjectIncome(currentEditId, '', { id: currentProjectId, paymentDates: [], paymentsPaid: [], paymentAmounts: [] }); }catch(e){ /* non-fatal */ }
    renderProjectList();
    show('view-admin-edit');
  }catch(err){
    msg(msgEl, "Não foi possível remover. Tente novamente.", "error");
  }
});

document.getElementById('adminDeactivateBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('adminDeleteMsg');
  if(currentIsNew) return;
  const name = document.getElementById('adminEditName').textContent || 'este cliente';
  const nextState = !currentClientData.deactivated;
  const ok = await askConfirm({
    title: nextState ? 'Desativar cliente' : 'Reativar cliente',
    message: nextState
      ? `Mover ${name} para "Clientes Desativados"? O cliente continua a ter acesso ao seu link pessoal.`
      : `Reativar ${name}? Volta a aparecer na lista de clientes.`,
    confirmText: nextState ? 'Desativar' : 'Reativar',
    cancelText: 'Cancelar'
  });
  if(!ok) return;
  try{
    await updateDoc(doc(db, "clients", currentEditId), { deactivated: nextState });
    currentClientData.deactivated = nextState;
    document.getElementById('adminDeactivateBtn').textContent = nextState ? 'Reativar cliente' : 'Desativar cliente';
    toast(nextState ? 'Cliente desativado ✓' : 'Cliente reativado ✓');
  }catch(err){
    msg(msgEl, "Não foi possível atualizar. Tente novamente.", "error");
  }
});

document.getElementById('adminDeleteBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('adminDeleteMsg');
  if(currentIsNew) return;
  const name = document.getElementById('adminEditName').textContent || 'este cliente';
  const ok = await askConfirm({
    title: 'Excluir cliente',
    message: `Excluir ${name}? Isso não pode ser desfeito e o link pessoal dele deixará de funcionar.`,
    confirmText: 'Deletar',
    cancelText: 'Cancelar'
  });
  if(!ok) return;
  try{
    try{ await deleteClientIncome(currentEditId); }catch(e){ /* non-fatal */ }
    await deleteDoc(doc(db, "clients", currentEditId));
    loadAdminList();
  }catch(err){
    msg(msgEl, "Não foi possível excluir. Tente novamente.", "error");
  }
});
