// ============================================================
//  ADMIN: LEADS — prospective clients who showed interest but haven't
//  contracted yet. Kept in their own `leads` collection (no portal/magic-link
//  access, unlike `clients`) so the client list/production board/Financeiro
//  never have to filter them out. Two terminal actions per lead: convert into
//  a real client (prefills the "new client" form, then removes the lead) or
//  delete (they didn't contract).
// ============================================================
import {
  doc, addDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, escapeHtml, escapeAttr, msg, toast, show, askConfirm, setAdminHash
} from './core.js';
import { loadAdminEdit } from './admin-clients.js';

let currentLeads = [];

export async function loadLeads(){
  setAdminHash('leads');
  show('view-admin-leads');
  document.getElementById('leadAddMsg').className = 'form-msg';
  const listEl = document.getElementById('leadsList');
  listEl.innerHTML = '<span class="loading-dot"></span>';
  let snap;
  try{
    snap = await getDocs(collection(db, "leads"));
  }catch(err){
    listEl.innerHTML = '<div class="panel-empty">Não foi possível carregar os leads.</div>';
    return;
  }
  currentLeads = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  renderLeadsList();
}

function waLink(lead){
  let phone = (lead.phone || '').replace(/[^\d]/g, '');
  if(!phone) return '';
  if(phone.length === 9) phone = '351' + phone;
  const text = encodeURIComponent(
    `Oiee${lead.firstName ? ' ' + lead.firstName : ''}! Aqui é a Ester, tudo bem? Estou entrando em ` +
    `contato pois você demonstrou interesse em iniciar um projeto comigo. Vamos avançar?`
  );
  return `https://wa.me/${phone}?text=${text}`;
}
function mailLink(lead){
  if(!lead.email) return '';
  const subject = encodeURIComponent('Vamos retomar a conversa?');
  const body = encodeURIComponent(
    `Oi${lead.firstName ? ' ' + lead.firstName : ''}! Tudo bem?\n\n` +
    `Aqui é a Estephanie — tínhamos conversado sobre um possível trabalho e gostaria de saber ` +
    `se ainda tens interesse em avançar.\n\nFico à disposição!\n\nEstephanie Cerqueira`
  );
  return `mailto:${lead.email}?subject=${subject}&body=${body}`;
}

function renderLeadsList(){
  const listEl = document.getElementById('leadsList');
  if(currentLeads.length === 0){
    listEl.innerHTML = '<p class="panel-empty">Nenhum lead em aberto.</p>';
    return;
  }
  listEl.innerHTML = currentLeads.map(lead => {
    const contactBits = [lead.phone, lead.email].filter(Boolean).join(' · ');
    const sub = [contactBits, lead.note].filter(Boolean).join(' — ');
    const wa = waLink(lead);
    const mail = mailLink(lead);
    return `
    <div class="project-row" style="align-items:flex-start;flex-wrap:wrap;">
      <div style="min-width:0;flex:1;">
        <div class="pr-name">${escapeHtml(lead.firstName || 'Lead')}</div>
        <div class="pr-sub">${escapeHtml(sub || 'Sem contacto registado')}</div>
        <div class="lead-next-row">
          <input type="checkbox" class="lead-next-check" data-lead-id="${escapeAttr(lead.id)}" ${lead.nextActionDone ? 'checked' : ''} title="Marcar como feita — deixa de aparecer no Início">
          <input type="text" class="lead-next-action${lead.nextActionDone ? ' is-done' : ''}" data-lead-id="${escapeAttr(lead.id)}" placeholder="Próxima ação…" value="${escapeAttr(lead.nextAction || '')}">
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
        ${wa ? `<a class="btn-mini" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        ${mail ? `<a class="btn-mini" href="${mail}">Email</a>` : ''}
        <button type="button" class="btn-mini" data-lead-convert="${escapeAttr(lead.id)}">Converter em cliente</button>
        <button type="button" class="btn-mini" data-lead-delete="${escapeAttr(lead.id)}" style="color:#f0917f;">Eliminar</button>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('leadAddBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('leadAddMsg');
  const firstName = document.getElementById('leadFirstName').value.trim();
  const phone = document.getElementById('leadPhone').value.trim();
  const email = document.getElementById('leadEmail').value.trim();
  const note = document.getElementById('leadNote').value.trim();
  const nextAction = document.getElementById('leadNextAction').value.trim();
  if(!firstName){ msg(msgEl, "Informe pelo menos o nome.", "error"); return; }
  if(!phone && !email){ msg(msgEl, "Informe um telefone ou email, para poder contactar depois.", "error"); return; }
  try{
    await addDoc(collection(db, "leads"), { firstName, phone, email, note, nextAction, createdAt: serverTimestamp() });
    document.getElementById('leadFirstName').value = '';
    document.getElementById('leadPhone').value = '';
    document.getElementById('leadEmail').value = '';
    document.getElementById('leadNote').value = '';
    document.getElementById('leadNextAction').value = '';
    msg(msgEl, "Lead adicionado.", "ok");
    toast('Lead adicionado ✓');
    loadLeads();
  }catch(err){
    msg(msgEl, "Não foi possível guardar. Tente novamente.", "error");
    toast('Não foi possível guardar', true);
  }
});

// Saves on blur (not per-keystroke) — a lightweight autosave, no extra button.
// Editing the text after it was marked done un-marks it — a fresh next action
// isn't done yet, and leaving it checked would silently hide it from Início.
document.getElementById('leadsList').addEventListener('blur', async (e) => {
  const input = e.target.closest ? e.target.closest('.lead-next-action') : null;
  if(!input) return;
  const id = input.dataset.leadId;
  const lead = currentLeads.find(l => l.id === id);
  const value = input.value.trim();
  if(!lead || lead.nextAction === value) return;
  lead.nextAction = value;
  const patch = { nextAction: value };
  if(lead.nextActionDone){
    lead.nextActionDone = false;
    patch.nextActionDone = false;
    input.classList.remove('is-done');
    const check = input.parentElement.querySelector('.lead-next-check');
    if(check) check.checked = false;
  }
  try{
    await updateDoc(doc(db, "leads", id), patch);
  }catch(err){
    toast('Não foi possível guardar a próxima ação', true);
  }
}, true);

// "Próxima ação" done checkbox — marks it complete (strikethrough).
document.getElementById('leadsList').addEventListener('change', async (e) => {
  const check = e.target.closest ? e.target.closest('.lead-next-check') : null;
  if(!check) return;
  const id = check.dataset.leadId;
  const lead = currentLeads.find(l => l.id === id);
  if(!lead) return;
  const done = check.checked;
  lead.nextActionDone = done;
  const input = check.parentElement.querySelector('.lead-next-action');
  if(input) input.classList.toggle('is-done', done);
  try{
    await updateDoc(doc(db, "leads", id), { nextActionDone: done });
  }catch(err){
    toast('Não foi possível guardar', true);
  }
});

document.getElementById('leadsList').addEventListener('click', async (e) => {
  const convertBtn = e.target.closest('[data-lead-convert]');
  if(convertBtn){
    const id = convertBtn.dataset.leadConvert;
    const lead = currentLeads.find(l => l.id === id);
    if(!lead) return;
    const ok = await askConfirm({
      title: 'Converter em cliente',
      message: `Criar um novo cliente a partir de "${lead.firstName || 'este lead'}"? O lead será removido desta lista — os dados abrem no formulário de novo cliente para você completar e salvar.`,
      confirmText: 'Converter'
    });
    if(!ok) return;
    try{
      await deleteDoc(doc(db, "leads", id));
    }catch(err){
      toast('Não foi possível remover o lead', true);
      return;
    }
    const newRef = doc(collection(db, "clients"));
    loadAdminEdit(newRef.id, null);
    document.getElementById('adminFirstName').value = lead.firstName || '';
    document.getElementById('adminPhone').value = lead.phone || '';
    document.getElementById('adminEmail').value = lead.email || '';
    document.getElementById('adminReferral').value = lead.note || '';
    toast('Lead convertido — complete e salve os dados do cliente.');
    return;
  }
  const delBtn = e.target.closest('[data-lead-delete]');
  if(delBtn){
    const id = delBtn.dataset.leadDelete;
    const lead = currentLeads.find(l => l.id === id);
    const ok = await askConfirm({
      title: 'Eliminar lead',
      message: `Eliminar "${lead ? (lead.firstName || 'este lead') : 'este lead'}"? Use quando o contacto não resultou em contrato.`,
      confirmText: 'Eliminar'
    });
    if(!ok) return;
    try{
      await deleteDoc(doc(db, "leads", id));
      toast('Lead eliminado.');
      loadLeads();
    }catch(err){
      toast('Não foi possível eliminar', true);
    }
  }
});
