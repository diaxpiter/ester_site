// ============================================================
//  ADMIN: CENTRAL — the day-to-day cheat sheet. Quick links, one-tap
//  copy for the data that gets asked for mid-conversation (IBAN, MB Way,
//  NIF), the drive's folder map, and the weekly/monthly money routine.
//
//  Everything editable lives in ONE Firestore doc (dashboard/central), so
//  the Ester and the admin phone see the same links and the same ticked
//  boxes. Nothing here is client-facing — `dashboard` is admin-only in
//  firestore.rules, which is why the IBAN can live in it at all.
// ============================================================
import {
  doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, show, setAdminHash, toast, escapeHtml } from './core.js';

const DOC = doc(db, "dashboard", "central");

// --- what the page offers. Adding a row here is all it takes to add a card. ---
const LINK_GROUPS = [
  { id: 'dia', title: 'Trabalho do dia', items: [
    ['drive',     'Drive da empresa',   'a raiz — 00_DOC, 01_CLIENTES, 02_FINANCEIRO', ''],
    ['clientes',  '01_CLIENTES',        'as pastas partilhadas com cada cliente', ''],
    ['templates', '03_TEMPLATES',       'orçamento, email, contrato', ''],
    ['gmail',     'Faturas no Gmail',   'pesquisa com os comprovativos do mês',
      'https://mail.google.com/mail/u/0/#search/fatura+OR+recibo+OR+invoice']
  ]},
  { id: 'dinheiro', title: 'Dinheiro', items: [
    ['folha',    'Folha financeira',    'entradas, saídas e painel do mês', ''],
    ['despesa',  'Lançar despesa',      'formulário com foto do talão', ''],
    ['precario', 'Tabela de preços',    'a fonte de verdade dos orçamentos', ''],
    ['banco',    'Conta da empresa',    'saldo real, para conferir ao fim do mês', ''],
    ['financas', 'Portal das Finanças', 'emitir recibo verde', 'https://www.portaldasfinancas.gov.pt/'],
    ['ss',       'Segurança Social Direta', 'declaração trimestral', 'https://app.seg-social.pt/sso/']
  ]},
  { id: 'cliente', title: 'Mostrar ao cliente', items: [
    ['site',  'esterprod.com',   'o site', 'https://esterprod.com'],
    ['insta', '@estephanie.e',   'Instagram', 'https://instagram.com/estephanie.e'],
    ['maps',  'Perfil no Google', 'a ficha da empresa no Maps', ''],
    ['port',  'Portfólio',        'o reel de apresentação', '']
  ]}
];

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

const SEMANAL = [
  'Lançar em Financeiro tudo o que entrou esta semana',
  'Lançar as despesas da semana e arrastar os talões para 02_SAIDAS',
  'Passar a Pago o que já entrou na conta',
  'Ver A receber: quem está em atraso leva mensagem hoje',
  'Emitir os recibos verdes dos pagamentos recebidos',
  'Enviar as faturas dos trabalhos entregues esta semana'
];
const MENSAL = [
  'Comparar o saldo real do banco com o total do mês no Painel',
  'Transferir os 30% (impostos e Segurança Social) e os 10% (reserva) para a poupança',
  'Fechar a pasta do mês em 01_ENTRADAS e 02_SAIDAS e abrir a do mês seguinte',
  'Rever as subscrições: cancelar o que não se usou este mês',
  'Rever a lista de desejos: aprovar, adiar ou descartar cada linha',
  'Olhar para o ano no Painel e ver que meses são fracos todos os anos'
];

let state = { links: {}, dados: {}, checks: {} };
let editing = false;
let loaded = false;

// ---------- Firestore ----------
async function persist(patch){
  Object.assign(state, patch);
  try{
    await setDoc(DOC, { links: state.links, dados: state.dados, checks: state.checks }, { merge: true });
  }catch(err){
    toast('Não foi possível guardar — sem ligação?', true);
  }
}

// ---------- helpers ----------
const el = id => document.getElementById(id);
function linkValue(key, fallback){
  const v = state.links[key];
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}
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
// ISO week, so the sexta-feira checklist clears itself every Monday.
function weekKey(){
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const n = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return d.getFullYear() + '-S' + String(n).padStart(2, '0');
}
function monthKey(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// ---------- render: atalhos ----------
function renderLinks(){
  LINK_GROUPS.forEach(group => {
    const host = el('centralLinks-' + group.id);
    if(!host) return;
    host.className = editing ? 'central-edit' : 'central-grid';
    host.innerHTML = group.items.map(([key, title, desc, def]) => {
      const url = linkValue(key, def);
      if(editing){
        return `<label class="central-edit-row">
            <span class="central-edit-label">${escapeHtml(title)}</span>
            <input type="url" inputmode="url" placeholder="https://..." data-link="${key}" value="${escapeHtml(url)}">
          </label>`;
      }
      const cls = 'central-card' + (url ? '' : ' is-empty');
      const tag = url ? '<span class="central-tag">abrir</span>' : '<span class="central-tag">+ link</span>';
      const open = url ? `href="${escapeHtml(url)}" target="_blank" rel="noopener"` : 'href="#" data-nolink="1"';
      return `<a class="${cls}" ${open}>
          <span class="central-card-text">
            <span class="central-card-title">${escapeHtml(title)}</span>
            <span class="central-card-desc">${escapeHtml(desc)}</span>
          </span>${tag}
        </a>`;
    }).join('');
  });
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

// ---------- render: rotina ----------
function renderChecklist(hostId, items, ns, scope){
  const prefix = ns + ':' + (scope === 'week' ? weekKey() : monthKey()) + ':';
  el(hostId).innerHTML = items.map((txt, i) => {
    const k = prefix + i;
    const on = state.checks[k] === true;
    return `<label class="central-task${on ? ' is-done' : ''}">
        <input type="checkbox" data-check="${k}"${on ? ' checked' : ''}>
        <span>${escapeHtml(txt)}</span>
      </label>`;
  }).join('');
}
function renderRotina(){
  renderChecklist('centralSemanal', SEMANAL, 'sem', 'week');
  renderChecklist('centralMensal', MENSAL, 'mes', 'month');
  el('centralWeekLabel').textContent = 'semana ' + weekKey();
  el('centralMonthLabel').textContent = 'mês ' + monthKey();
}

function renderAll(){
  renderLinks();
  renderDados();
  renderRotina();
  el('centralEditBtn').textContent = editing ? 'Concluir edição' : 'Editar links e dados';
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
      const target = tab.dataset.centralTab;
      root.querySelectorAll('[data-central-tab]').forEach(b => b.classList.toggle('is-active', b === tab));
      root.querySelectorAll('.central-panel').forEach(p => p.classList.toggle('hidden', p.dataset.centralPanel !== target));
      window.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    const nolink = e.target.closest('[data-nolink]');
    if(nolink){
      e.preventDefault();
      toast('Ainda sem link — toque em "Editar links e dados"');
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

  // Link/data edits save on blur (one write per field, not per keystroke).
  root.addEventListener('change', (e) => {
    const link = e.target.closest('[data-link]');
    if(link){
      state.links[link.dataset.link] = link.value.trim();
      persist({});
      return;
    }
    const dado = e.target.closest('[data-dado]');
    if(dado){
      state.dados[dado.dataset.dado] = dado.value.trim();
      persist({});
      return;
    }
    const check = e.target.closest('[data-check]');
    if(check){
      state.checks[check.dataset.check] = check.checked;
      check.closest('.central-task').classList.toggle('is-done', check.checked);
      persist({});
    }
  });
}

export async function loadCentral(){
  setAdminHash('central');
  show('view-admin-central');
  if(!loaded){
    wire();
    loaded = true;
    try{
      const snap = await getDoc(DOC);
      if(snap.exists()){
        const d = snap.data() || {};
        state = { links: d.links || {}, dados: d.dados || {}, checks: d.checks || {} };
      }
    }catch(err){
      toast('Não foi possível carregar a Central — a mostrar o que há.', true);
    }
  }
  editing = false;
  renderAll();
}
