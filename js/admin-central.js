// ============================================================
//  ADMIN: CENTRAL — two tabs. "Copiar": one-tap copy for the data that gets
//  asked for mid-conversation (IBAN, MB Way, NIF) plus ready-made messages.
//  "Notas": iPhone-Notes-style notes, rendered by js/admin-notes.js.
//
//  The Copiar values live in ONE Firestore doc (dashboard/central), so the
//  computer and the phone see the same data. Nothing here is client-facing —
//  `dashboard` is admin-only in firestore.rules, which is why the IBAN can
//  live in it at all. The old Atalhos/Pastas/Rotina tabs were turned into
//  starter notes (see admin-notes.js's seedNotes); their `links`/`checks`
//  fields stay in the doc, untouched, so nothing already typed is lost.
// ============================================================
import {
  doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, show, setAdminHash, toast, escapeHtml } from './core.js';
import { loadNotes } from './admin-notes.js';

export const CENTRAL_DOC = doc(db, "dashboard", "central");

const DADOS = [
  ['iban',    'IBAN',              ''],
  ['titular', 'Titular da conta',  ''],
  ['mbway',   'MB Way',            ''],
  ['nif',     'NIF',               ''],
  ['email',   'Email',             'contatoestephanie@gmail.com'],
  ['whats',   'WhatsApp',          '+351 913 198 057'],
  ['site',    'Site',              'esterprod.com'],
  ['insta',   'Instagram',         '@estephanie.e']
];

const BLOCOS = [
  ['Dados para transferência', d =>
    'Dados para transferência:\n\nTitular: ' + (d.titular || '—') +
    '\nIBAN: ' + (d.iban || '—') + '\nMB Way: ' + (d.mbway || '—') +
    '\n\nAssim que o pagamento entrar envio o recibo por email. Obrigada!'],
  ['Assinatura de contactos', d =>
    'ESTER · Produção Audiovisual\n' + (d.whats || '—') + ' · ' + (d.email || '—') +
    '\n' + (d.site || 'esterprod.com') + ' · ' + (d.insta || '@estephanie.e')],
  ['Lembrete de pagamento', d =>
    'Olá! Passo só para lembrar do valor em aberto do último trabalho. ' +
    'Deixo os dados outra vez para ser mais fácil:\n\nIBAN: ' + (d.iban || '—') +
    '\nMB Way: ' + (d.mbway || '—') + '\n\nQualquer coisa é só dizer. Obrigada!']
];

let state = { dados: {} };
let editing = false;
let loaded = false;

// ---------- Firestore ----------
async function persist(patch){
  Object.assign(state, patch);
  try{
    await setDoc(CENTRAL_DOC, { dados: state.dados }, { merge: true });
  }catch(err){
    toast('Não foi possível guardar — sem ligação?', true);
  }
}

// ---------- helpers ----------
const el = id => document.getElementById(id);
function dadoValue(key, fallback){
  const v = state.dados[key];
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}
function dadosMap(){
  const out = {};
  DADOS.forEach(([k, , fb]) => { out[k] = dadoValue(k, fb); });
  return out;
}
function copy(text){
  const fallback = () => {
    try{
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      toast(ok ? 'Copiado' : 'Não deu para copiar — selecione à mão', !ok);
    }catch(e){ toast('Não deu para copiar — selecione à mão', true); }
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(() => toast('Copiado'), fallback);
  } else fallback();
}
// ---------- render: dados + blocos ----------
function renderDados(){
  const host = el('centralDados');
  if(editing){
    host.className = 'central-edit';
    host.innerHTML = DADOS.map(([key, label, def]) => `
      <label class="central-edit-row">
        <span class="central-edit-label">${escapeHtml(label)}</span>
        <input type="text" data-dado="${key}" value="${escapeHtml(dadoValue(key, def))}">
      </label>`).join('');
    el('centralBlocos').innerHTML = '<p class="panel-empty">As mensagens montam-se sozinhas a partir destes campos.</p>';
    return;
  }
  host.className = '';
  host.innerHTML = DADOS.map(([key, label, def]) => {
    const val = dadoValue(key, def);
    return `<button type="button" class="central-row${val ? '' : ' is-empty'}" data-copy-dado="${key}">
        <span class="central-row-text">
          <span class="central-row-label">${escapeHtml(label)}</span>
          <span class="central-row-value">${escapeHtml(val || 'por preencher')}</span>
        </span>
        <span class="central-tag">copiar</span>
      </button>`;
  }).join('');
  el('centralBlocos').innerHTML = BLOCOS.map((b, i) => `
    <button type="button" class="central-row" data-copy-bloco="${i}">
      <span class="central-row-text">
        <span class="central-row-label">mensagem</span>
        <span class="central-row-value">${escapeHtml(b[0])}</span>
      </span>
      <span class="central-tag">copiar</span>
    </button>`).join('');
}

function renderAll(){
  renderDados();
  el('centralEditBtn').textContent = editing ? 'Concluir edição' : 'Editar dados';
  el('centralEditBtn').classList.toggle('is-editing', editing);
  document.querySelectorAll('#view-admin-central .central-hide-on-edit')
    .forEach(n => n.classList.toggle('hidden', editing));
}

// ---------- events (delegated once) ----------
function wire(){
  const root = el('view-admin-central');

  root.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-central-tab]');
    if(tab){
      showTab(tab.dataset.centralTab);
      window.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    const dado = e.target.closest('[data-copy-dado]');
    if(dado){
      const key = dado.dataset.copyDado;
      const def = (DADOS.find(d => d[0] === key) || [])[2] || '';
      const val = dadoValue(key, def);
      if(!val) toast('Ainda por preencher', true); else copy(val);
      return;
    }
    const bloco = e.target.closest('[data-copy-bloco]');
    if(bloco){ copy(BLOCOS[Number(bloco.dataset.copyBloco)][1](dadosMap())); return; }

    if(e.target.closest('#centralEditBtn')){
      editing = !editing;
      renderAll();
      if(!editing) toast('Guardado');
    }
  });

  // Data edits save on blur (one write per field, not per keystroke).
  root.addEventListener('change', (e) => {
    const dado = e.target.closest('[data-dado]');
    if(dado){
      state.dados[dado.dataset.dado] = dado.value.trim();
      persist({});
    }
  });
}

// "dados" (Copiar) or "notas". Notas keeps its own URL hash so a refresh
// mid-note comes back to the notes instead of Copiar.
function showTab(target){
  const root = el('view-admin-central');
  root.querySelectorAll('[data-central-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.centralTab === target));
  root.querySelectorAll('.central-panel').forEach(p => p.classList.toggle('hidden', p.dataset.centralPanel !== target));
  setAdminHash(target === 'notas' ? 'notas' : 'central');
  if(target === 'notas') loadNotes();
}

export async function loadCentral(tab = 'dados'){
  show('view-admin-central');
  if(!loaded){
    wire();
    loaded = true;
    try{
      const snap = await getDoc(CENTRAL_DOC);
      if(snap.exists()) state = { dados: (snap.data() || {}).dados || {} };
    }catch(err){
      toast('Não foi possível carregar a Central — a mostrar o que há.', true);
    }
  }
  editing = false;
  renderAll();
  showTab(tab);
}
