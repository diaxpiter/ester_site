// ============================================================
//  ADMIN: CENTRAL — three tabs. "Copiar": one-tap copy for the data that gets
//  asked for mid-conversation (IBAN, MB Way, NIF) plus ready-made messages.
//  "Notas": iPhone-Notes-style notes, rendered by js/admin-notes.js.
//  "Timeline": each client's monthly cycles, rendered by js/admin-ciclos.js.
//
//  The Copiar values live in ONE Firestore doc (dashboard/central), so the
//  computer and the phone see the same data. Nothing here is client-facing —
//  `dashboard` is admin-only in firestore.rules, which is why the IBAN can
//  live in it at all. The old Atalhos/Pastas/Rotina tabs were turned into
//  starter notes (see admin-notes.js's seedNotes); their `links`/`checks`
//  fields stay in the doc, untouched, so nothing already typed is lost.
//  The ready messages live there too (`mensagens`: [{ title, text }]),
//  editable under "Editar dados e mensagens"; {iban}, {mbway}… in the text
//  are swapped for the fields above when a message is copied.
// ============================================================
import {
  doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, show, setAdminHash, toast, escapeHtml } from './core.js';
import { loadNotes } from './admin-notes.js';
import { loadCiclos } from './admin-ciclos.js';

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

// Starter messages — used until the first save writes a `mensagens` list.
const MENSAGENS_DEFAULT = [
  { title: 'Dados para transferência', text:
    'Dados para transferência:\n\nTitular: {titular}\nIBAN: {iban}\nMB Way: {mbway}' +
    '\n\nAssim que o pagamento entrar envio o recibo por email. Obrigada!' },
  { title: 'Assinatura de contactos', text:
    'ESTER · Produção Audiovisual\n{whats} · {email}\n{site} · {insta}' },
  { title: 'Lembrete de pagamento', text:
    'Olá! Passo só para lembrar do valor em aberto do último trabalho. ' +
    'Deixo os dados outra vez para ser mais fácil:\n\nIBAN: {iban}\nMB Way: {mbway}' +
    '\n\nQualquer coisa é só dizer. Obrigada!' }
];

let state = { dados: {}, mensagens: null }; // mensagens: null = never saved, use the defaults
let editing = false;
let loaded = false;

// ---------- Firestore ----------
async function persist(patch){
  Object.assign(state, patch);
  try{
    await setDoc(CENTRAL_DOC, { dados: state.dados, mensagens: mensagens() }, { merge: true });
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
function mensagens(){
  if(!Array.isArray(state.mensagens)) state.mensagens = MENSAGENS_DEFAULT.map(m => ({ ...m }));
  return state.mensagens;
}
// {iban} → the IBAN, etc. An empty field becomes "—"; unknown {names} stay as typed.
function fillMensagem(text){
  const d = dadosMap();
  return (text || '').replace(/\{(\w+)\}/g, (all, k) => (k in d) ? (d[k] || '—') : all);
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
// ---------- render: dados + mensagens ----------
function renderDados(){
  const host = el('centralDados');
  if(editing){
    host.className = 'central-edit';
    host.innerHTML = DADOS.map(([key, label, def]) => `
      <label class="central-edit-row">
        <span class="central-edit-label">${escapeHtml(label)}</span>
        <input type="text" data-dado="${key}" value="${escapeHtml(dadoValue(key, def))}">
      </label>`).join('');
    el('centralBlocos').innerHTML = `
      <p class="lede central-msg-hint">Escreva ${DADOS.map(([k]) => `<code>{${k}}</code>`).join(' ')} no texto e, ao copiar, entra o valor preenchido acima.</p>
      ${mensagens().map((m, i) => `
        <div class="central-msg-edit">
          <div class="central-msg-head">
            <input type="text" data-msg-title="${i}" value="${escapeHtml(m.title || '')}" placeholder="Título" aria-label="Título da mensagem">
            <button type="button" class="btn btn-ghost central-msg-del" data-msg-del="${i}">Apagar</button>
          </div>
          <textarea data-msg-text="${i}" rows="6" placeholder="Texto da mensagem" aria-label="Texto da mensagem">${escapeHtml(m.text || '')}</textarea>
        </div>`).join('')}
      <button type="button" class="btn btn-ghost" id="centralMsgAdd">+ Nova mensagem</button>`;
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
  const list = mensagens();
  el('centralBlocos').innerHTML = list.length ? list.map((m, i) => `
    <button type="button" class="central-row" data-copy-bloco="${i}">
      <span class="central-row-text">
        <span class="central-row-label">mensagem</span>
        <span class="central-row-value">${escapeHtml(m.title || 'Sem título')}</span>
        <span class="central-msg-preview">${escapeHtml(fillMensagem(m.text))}</span>
      </span>
      <span class="central-tag">copiar</span>
    </button>`).join('') : '<p class="panel-empty">Sem mensagens — crie uma em "Editar dados e mensagens".</p>';
}

function renderAll(){
  renderDados();
  el('centralEditBtn').textContent = editing ? 'Concluir edição' : 'Editar dados e mensagens';
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
    if(bloco){ copy(fillMensagem(mensagens()[Number(bloco.dataset.copyBloco)].text)); return; }

    if(e.target.closest('#centralMsgAdd')){
      mensagens().push({ title: 'Nova mensagem', text: '' });
      persist({});
      renderAll();
      const titles = el('centralBlocos').querySelectorAll('[data-msg-title]');
      titles[titles.length - 1].select();
      return;
    }
    const del = e.target.closest('[data-msg-del]');
    if(del){
      const i = Number(del.dataset.msgDel);
      if(!confirm(`Apagar a mensagem "${mensagens()[i].title || 'Sem título'}"?`)) return;
      mensagens().splice(i, 1);
      persist({});
      renderAll();
      return;
    }

    if(e.target.closest('#centralEditBtn')){
      editing = !editing;
      renderAll();
      if(!editing) toast('Guardado');
    }
  });

  // Edits save on blur (one write per field, not per keystroke).
  root.addEventListener('change', (e) => {
    const dado = e.target.closest('[data-dado]');
    if(dado){
      state.dados[dado.dataset.dado] = dado.value.trim();
      persist({});
      return;
    }
    const title = e.target.closest('[data-msg-title]');
    if(title){
      mensagens()[Number(title.dataset.msgTitle)].title = title.value.trim();
      persist({});
      return;
    }
    const text = e.target.closest('[data-msg-text]');
    if(text){
      mensagens()[Number(text.dataset.msgText)].text = text.value;
      persist({});
    }
  });
}

// "dados" (Copiar), "notas" or "timeline". Notas and Timeline keep their own
// URL hash so a refresh comes back to them instead of Copiar.
function showTab(target){
  const root = el('view-admin-central');
  root.querySelectorAll('[data-central-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.centralTab === target));
  root.querySelectorAll('.central-panel').forEach(p => p.classList.toggle('hidden', p.dataset.centralPanel !== target));
  setAdminHash(target === 'notas' || target === 'timeline' ? target : 'central');
  if(target === 'notas') loadNotes();
  if(target === 'timeline') loadCiclos();
}

export async function loadCentral(tab = 'dados'){
  show('view-admin-central');
  if(!loaded){
    wire();
    loaded = true;
    try{
      const snap = await getDoc(CENTRAL_DOC);
      const data = snap.exists() ? (snap.data() || {}) : {};
      state = { dados: data.dados || {}, mensagens: Array.isArray(data.mensagens) ? data.mensagens : null };
    }catch(err){
      toast('Não foi possível carregar a Central — a mostrar o que há.', true);
    }
  }
  editing = false;
  renderAll();
  showTab(tab);
}
