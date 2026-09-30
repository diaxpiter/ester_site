// ============================================================
//  ADMIN: CENTRAL → TIMELINE — os ciclos mensais de cada cliente numa linha
//  do tempo: meses pagos / por pagar / em atraso, pagamentos, gravação,
//  prazo de entrega e revisões, mais a lista "Precisa de atenção".
//
//  As regras (vencimentos, dias úteis, estados) vivem em js/ciclos-core.js;
//  aqui só há DOM e Firestore. Os dados ficam num único doc
//  (dashboard/ciclos → { clientes: [...] }), admin-only em firestore.rules,
//  para o computador e o telemóvel verem o mesmo. Cada cliente:
//  { id, nome, mensal, meses, assinatura, pagamento1, notas,
//    ciclos: [{ pago, gravacao, entrega }] }  — datas 'AAAA-MM-DD'.
// ============================================================
import {
  doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, toast, escapeAttr } from './core.js';
import { CFG, P, F, hoje, addDays, diff, addMonthsAnchor, calcularCiclos, estadoTexto } from './ciclos-core.js';

export const CICLOS_DOC = doc(db, "dashboard", "ciclos");

const MES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const MESL = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const fmtEur = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });

const el = id => document.getElementById(id);
const esc = s => escapeAttr(s == null ? '' : String(s));
const eur = v => fmtEur.format(+v || 0);
const dias = n => `${n} ${n === 1 ? 'dia' : 'dias'}`;
const dm = s => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const dmy = s => `${dm(s)}/${s.slice(0, 4)}`;
const uid = () => Math.random().toString(36).slice(2, 10);
function firstOfMonth(s, off = 0){ const d = P(s); return F(new Date(d.getFullYear(), d.getMonth() + off, 1, 12)); }

let clientes = [];
const view = { janela: 3, inicio: firstOfMonth(hoje(), -1), encerrados: false };
let loaded = false;
let fichaId = null, editId = null;

// ---------- dados ----------
function norm(c){
  c.meses = Math.max(1, parseInt(c.meses, 10) || 3);
  c.mensal = +c.mensal || 0;
  c.ciclos = Array.isArray(c.ciclos) ? c.ciclos : [];
  while(c.ciclos.length < c.meses) c.ciclos.push({});
  c.ciclos.length = c.meses;
  c.ciclos = c.ciclos.map(x => x || {});
  return c;
}
const get = id => clientes.find(c => c.id === id);

async function save(){
  try{
    await setDoc(CICLOS_DOC, { clientes }, { merge: true });
  }catch(err){
    toast('Não foi possível guardar — sem ligação?', true);
  }
}

function ciclos(c){
  return calcularCiclos({ inicio: c.pagamento1, meses: c.meses, mensal: c.mensal, ciclos: c.ciclos }, hoje());
}
function resumo(c){
  const HOJE = hoje();
  const cs = ciclos(c), fim = cs[cs.length - 1].fim, atrasos = cs.filter(x => x.estado === 'atraso');
  return {
    cs, fim, atrasos,
    ativo: HOJE <= fim || atrasos.length > 0,
    divida: atrasos.length * c.mensal,
    teveAtraso: cs.some(x => x.estado === 'atraso' || x.estado === 'pago-atraso')
  };
}
const multa = (c, n = 1) => c.mensal * CFG.multaPct / 100 * n;

// ---------- resumo ----------
function renderResumo(){
  const HOJE = hoje(), ym = HOJE.slice(0, 7);
  let rec = 0, atr = 0, ca = 0, prox = 0, pn = 0, ativos = 0;
  clientes.forEach(c => {
    const r = resumo(c);
    if(r.ativo) ativos++;
    let a = false;
    r.cs.forEach(cy => {
      if(cy.pago && cy.pago.slice(0, 7) === ym) rec += c.mensal;
      if(cy.estado === 'atraso'){ atr += c.mensal; a = true; }
      if(cy.estado === 'hoje' || cy.estado === 'a-vencer'){ prox += c.mensal; pn++; }
    });
    if(a) ca++;
  });
  el('ccResumo').innerHTML =
    `<div class="cc-fig"><b>${ativos}</b><span>${ativos === 1 ? 'cliente ativa' : 'clientes ativas'}</span></div>` +
    `<div class="cc-fig"><b>${eur(rec)}</b><span>recebido em ${MESL[P(HOJE).getMonth()]}</span></div>` +
    `<div class="cc-fig${atr ? ' is-alerta' : ''}"><b>${eur(atr)}</b><span>${ca ? `em atraso, ${ca} ${ca === 1 ? 'cliente' : 'clientes'}` : 'nada em atraso'}</span></div>` +
    `<div class="cc-fig"><b>${eur(prox)}</b><span>a vencer nos próximos ${CFG.diasAVencer} dias${pn ? ` (${pn})` : ''}</span></div>`;
}

// ---------- linha do tempo ----------
let WS, WE, D;
const pos = s => diff(WS, s) / D * 100;
function seg(a, bEx){ const l = Math.max(0, pos(a)), r = Math.min(100, pos(bEx)); return r > l ? [l, r - l] : null; }
const inWin = s => s >= WS && s < WE;

function renderTL(){
  const HOJE = hoje();
  WS = view.inicio; WE = addMonthsAnchor(WS, view.janela); D = diff(WS, WE);
  const hd = 50 / D, tl = el('ccTl');
  tl.className = 'cc-tl' + (view.janela === 6 ? ' is-seis' : '');
  const ultimo = addDays(WE, -1);
  el('ccRange').textContent = `${MES[P(WS).getMonth()]} – ${MES[P(ultimo).getMonth()]} ${P(ultimo).getFullYear()}`;
  document.querySelectorAll('[data-cc-jan]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.ccJan === view.janela)));

  let grid = '', ruler = '';
  for(let k = 0; k < view.janela; k++){
    const ms = addMonthsAnchor(WS, k), md = P(ms);
    grid += `<div class="cc-gl" style="left:${pos(ms)}%"></div>`;
    ruler += `<div class="cc-gl" style="left:${pos(ms)}%"></div><div class="cc-mlab" style="left:${pos(ms)}%">${MES[md.getMonth()]} ${md.getFullYear()}</div>`;
    (view.janela === 3 ? [8, 15, 22] : [15]).forEach(dd => {
      const s = F(new Date(md.getFullYear(), md.getMonth(), dd, 12));
      ruler += `<div class="cc-tick" style="left:${pos(s)}%"></div><div class="cc-tlab" style="left:${pos(s)}%">${dd}</div>`;
    });
  }
  const nowIn = inWin(HOJE), nowX = pos(HOJE) + hd;
  const nowLine = nowIn ? `<div class="cc-now" style="left:${nowX}%"></div>` : '';
  if(nowIn) ruler += `<div class="cc-now" style="left:${nowX}%;top:auto;height:6px"></div><div class="cc-nowlab" style="left:${nowX}%">hoje ${dm(HOJE)}</div>`;

  let html = `<div class="cc-row is-ruler"><div class="cc-head">Clientes</div><div class="cc-lane">${ruler}</div></div>`;
  const lista = clientes.map(c => ({ c, r: resumo(c) }))
    .filter(x => view.encerrados || x.r.ativo)
    .sort((a, b) => (b.r.atrasos.length - a.r.atrasos.length) || a.c.nome.localeCompare(b.c.nome, 'pt'));

  if(!lista.length){
    html += `<div class="cc-vazio"><p>${clientes.length ? 'Nenhuma cliente ativa neste momento.' : 'Ainda não há clientes. Adicione a primeira para ver os ciclos.'}</p><button type="button" class="btn-mini" data-cc-acao="novo">+ Nova cliente</button></div>`;
    tl.innerHTML = html;
    return;
  }
  lista.forEach(({ c, r }) => {
    const dia = P(c.pagamento1).getDate();
    let lane = grid + nowLine;
    r.cs.forEach(cy => {
      const s = seg(cy.ini, addDays(cy.fim, 1));
      if(!s) return;
      const tip = `${c.nome}, mês ${cy.i + 1} de ${c.meses}: ${dm(cy.ini)} a ${dm(cy.fim)}, ${estadoTexto(cy)}`;
      lane += `<button type="button" class="cc-clip st-${cy.estado}" style="left:${s[0]}%;width:${s[1]}%" data-cc-ficha="${esc(c.id)}" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="cc-c1">Mês ${cy.i + 1} de ${c.meses}</span><span class="cc-c2">${estadoTexto(cy)}</span></button>`;
      const bEnd = cy.estado === 'atraso' ? addDays(HOJE, 1) : (cy.estado === 'pago-atraso' ? cy.pago : null);
      if(bEnd){
        const b = seg(cy.venc, bEnd);
        if(b) lane += `<div class="cc-blk${cy.estado === 'atraso' ? '' : ' is-soft'}" style="left:${b[0]}%;width:${b[1]}%"></div>`;
      }
      if(cy.pago){
        if(inWin(cy.pago)) lane += `<i class="cc-pay" style="left:${pos(cy.pago) + hd}%"></i>`;
        if(cy.estado === 'pago-atraso' && inWin(cy.venc)) lane += `<i class="cc-pay is-aberto" style="left:${pos(cy.venc) + hd}%"></i>`;
      }else if(inWin(cy.venc)){
        lane += `<i class="cc-pay ${cy.estado === 'atraso' ? 'is-falta' : 'is-aberto'}" style="left:${pos(cy.venc) + hd}%"></i>`;
      }
      if(cy.gravacao){
        const w = seg(addDays(cy.gravacao, 1), addDays(cy.entregaAte, 1));
        if(w) lane += `<div class="cc-prod is-work" style="left:${w[0]}%;width:${w[1]}%"></div>`;
        const rv = seg(addDays(cy.entrega || cy.entregaAte, 1), addDays(cy.revisaoAte, 1));
        if(rv) lane += `<div class="cc-prod ${cy.estoura ? 'is-over' : 'is-rev'}" style="left:${rv[0]}%;width:${rv[1]}%"></div>`;
        if(inWin(cy.gravacao)) lane += `<i class="cc-rec" style="left:${pos(cy.gravacao) + hd}%"></i>`;
        if(cy.entrega && inWin(cy.entrega)) lane += `<i class="cc-del" style="left:${pos(cy.entrega) + hd}%"></i>`;
      }
    });
    const n = r.atrasos.length;
    html += `<div class="cc-row"><button type="button" class="cc-head" data-cc-ficha="${esc(c.id)}"><span class="cc-nome">${esc(c.nome)}</span><span class="cc-sub">${eur(c.mensal)} por mês<br>vence dia ${dia}</span>${n ? `<span class="cc-pill">${n} ${n === 1 ? 'mês' : 'meses'} em atraso</span>` : ''}</button><div class="cc-lane">${lane}</div></div>`;
  });
  tl.innerHTML = html;
  // Traz o "hoje" para a vista quando a janela não o mostra de início (telemóvel).
  if(nowIn) requestAnimationFrame(() => {
    const sc = tl.parentNode, lane = tl.querySelector('.cc-row:not(.is-ruler) .cc-lane') || tl.querySelector('.cc-lane');
    const x = lane.offsetLeft + lane.offsetWidth * nowX / 100;
    if(x > sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth * 0.6;
  });
}

// ---------- precisa de atenção ----------
function renderAtencao(){
  const HOJE = hoje(), itens = [];
  clientes.forEach(c => {
    const r = resumo(c);
    if(!r.ativo) return;
    const nome = `<strong>${esc(c.nome)}</strong>`;
    r.cs.forEach(cy => {
      const m = `mês ${cy.i + 1}`;
      if(cy.estado === 'atraso') itens.push({ p: 0, t: 'late', id: c.id, h: `${nome}: ${m} venceu em ${dm(cy.venc)} e está em atraso há ${dias(cy.atrasoDias)} (${eur(c.mensal)}).` });
      else if(cy.estado === 'hoje') itens.push({ p: 1, t: 'pay', id: c.id, h: `${nome}: ${m} vence hoje (${eur(c.mensal)}).` });
      else if(cy.estado === 'a-vencer') itens.push({ p: 2, t: 'pay', id: c.id, h: `${nome}: ${m} vence em ${dm(cy.venc)}, daqui a ${dias(cy.faltam)} (${eur(c.mensal)}).` });
      const corrente = cy.ini <= HOJE && HOJE <= cy.fim;
      if(corrente && cy.pago && !cy.gravacao) itens.push({ p: 3, t: '', id: c.id, h: `${nome}: ${m} pago, gravação ainda por marcar. O mês termina em ${dm(cy.fim)}.` });
      if(cy.gravacao && cy.gravacaoAntesDoPagamento && cy.estado !== 'pago') itens.push({ p: 3, t: 'late', id: c.id, h: `${nome}: gravação do ${m} marcada antes do pagamento.` });
      if(cy.gravacao && !cy.entrega && cy.gravacao <= HOJE){
        const f = diff(HOJE, cy.entregaAte);
        if(f <= 3) itens.push({ p: f < 0 ? 0 : 2, t: f < 0 ? 'late' : '', id: c.id, h: `${nome}: entrega do ${m}${f < 0 ? ` passou do prazo (${dm(cy.entregaAte)}).` : ` até ${dm(cy.entregaAte)}.`}` });
      }
      if(cy.estoura && cy.fim >= HOJE) itens.push({ p: 3, t: '', id: c.id, h: `${nome}: as revisões do ${m} vão até ${dm(cy.revisaoAte)}, depois do fim do mês (${dm(cy.fim)}).` });
    });
    const fr = diff(HOJE, r.fim);
    if(!r.atrasos.length && fr >= 0 && fr <= 21) itens.push({ p: 4, t: '', id: c.id, h: `${nome}: contrato termina em ${dm(r.fim)}. Hora de falar da renovação.` });
  });
  itens.sort((a, b) => a.p - b.p);
  el('ccAtencao').innerHTML = itens.length
    ? `<ul class="cc-atencao">${itens.map(x => `<li class="t-${x.t}"><p>${x.h}</p><button type="button" class="cc-link" data-cc-ficha="${esc(x.id)}">Abrir ficha</button></li>`).join('')}</ul>`
    : `<p class="cc-ok">Tudo em dia. Nada vence nos próximos ${CFG.diasAVencer} dias.</p>`;
}

function render(){ renderResumo(); renderTL(); renderAtencao(); }

// ---------- ficha da cliente ----------
function abrirFicha(id){
  fichaId = id;
  renderFicha();
  const dlg = el('ccDlgFicha');
  if(!dlg.open) dlg.showModal();
}
function renderFicha(){
  const c = get(fichaId), dlg = el('ccDlgFicha');
  if(!c){ dlg.close(); return; }
  const r = resumo(c);
  let h = `<div class="cc-dlg-h"><h3 id="ccFichaNome">${esc(c.nome)}</h3><p>${eur(c.mensal)} por mês, ${c.meses} meses. ${c.assinatura ? `Assinado em ${dmy(c.assinatura)}. ` : ''}Primeiro pagamento em ${dmy(c.pagamento1)}, contrato até ${dmy(r.fim)}.</p>${c.notas ? `<p>${esc(c.notas)}</p>` : ''}</div><div class="cc-dlg-b">`;
  if(r.atrasos.length){
    const na = r.atrasos.length;
    h += `<div class="cc-divida"><strong>Em aberto: ${eur(r.divida + multa(c, na))}</strong>, sendo ${eur(r.divida)} de ${na} ${na === 1 ? 'mensalidade' : 'mensalidades'} e ${eur(multa(c, na))} de multa (${CFG.multaPct}% de cada mensalidade atrasada, ${eur(multa(c))} cada).</div>`;
  }else if(r.teveAtraso){
    const np = r.cs.filter(x => x.estado === 'pago-atraso').length;
    h += `<div class="cc-divida">${np} ${np === 1 ? 'mensalidade paga' : 'mensalidades pagas'} com atraso neste contrato. Multa devida: ${eur(multa(c, np))} (${eur(multa(c))} por mensalidade).</div>`;
  }
  r.cs.forEach(cy => {
    h += `<section class="cc-cy"><div class="cc-cy-h"><strong>Mês ${cy.i + 1}</strong><span class="cc-per">${dm(cy.ini)} a ${dm(cy.fim)}, vence ${dm(cy.venc)}</span><span class="cc-badge st-${cy.estado}">${estadoTexto(cy)}</span></div><div class="cc-cy-g">` +
      `<div class="field"><label>Pago em</label><span class="cc-inl"><input type="date" data-cc-i="${cy.i}" data-cc-f="pago" value="${cy.pago}" aria-label="Mês ${cy.i + 1}: pago em">${cy.pago ? '' : `<button type="button" class="btn-mini" data-cc-hoje="${cy.i}">Hoje</button>`}</span></div>` +
      `<div class="field"><label>Gravação</label><input type="date" data-cc-i="${cy.i}" data-cc-f="gravacao" value="${cy.gravacao}" aria-label="Mês ${cy.i + 1}: gravação"></div>` +
      `<div class="field"><label>Entrega feita em</label><input type="date" data-cc-i="${cy.i}" data-cc-f="entrega" value="${cy.entrega}" aria-label="Mês ${cy.i + 1}: entrega feita em"></div></div>`;
    if(cy.gravacao){
      h += `<p class="cc-calc">Entrega até ${dm(cy.entregaAte)} (${CFG.diasUteisEntrega} dias úteis). Revisões até ${dm(cy.revisaoAte)}.</p>`;
      if(cy.estoura) h += `<p class="cc-aviso">As revisões passam do fim do mês (${dm(cy.fim)}).</p>`;
      if(cy.gravacaoAntesDoPagamento && cy.estado !== 'pago') h += '<p class="cc-aviso">Gravação marcada antes do pagamento.</p>';
      if(cy.entrega && cy.entrega > cy.entregaAte) h += `<p class="cc-aviso">Entregue ${dias(diff(cy.entregaAte, cy.entrega))} depois do prazo.</p>`;
    }
    h += '</section>';
  });
  h += `</div><div class="cc-dlg-f"><button type="button" class="btn-mini cc-esq" data-cc-ficha-acao="editar">Editar contrato</button><button type="button" class="btn-mini" data-cc-ficha-acao="renovar">Renovar por mais 3 meses</button><button type="button" class="btn-mini is-primary" data-cc-ficha-acao="fechar">Fechar</button></div>`;
  el('ccFicha').innerHTML = h;
}

// ---------- formulário (nova cliente / editar contrato) ----------
function abrirForm(id){
  editId = id || null;
  const c = id ? get(id) : null;
  el('ccFormTit').textContent = c ? 'Editar contrato' : 'Nova cliente';
  el('ccFNome').value = c ? c.nome : '';
  el('ccFMensal').value = c ? c.mensal : '';
  el('ccFMeses').value = c ? c.meses : 3;
  el('ccFAss').value = c ? (c.assinatura || '') : '';
  el('ccFPag').value = c ? c.pagamento1 : hoje();
  el('ccFNotas').value = c ? (c.notas || '') : '';
  el('ccFRemover').hidden = !c;
  el('ccDlgForm').showModal();
  el('ccFNome').focus();
}

// ---------- copiar / importar ----------
function abrirDados(){
  el('ccDadosTxt').value = JSON.stringify(clientes, null, 2);
  el('ccDadosMsg').textContent = '';
  el('ccDlgDados').showModal();
}

// ---------- eventos (ligados uma vez) ----------
function wire(){
  const root = el('ccRoot');

  root.addEventListener('click', (e) => {
    const ficha = e.target.closest('[data-cc-ficha]');
    if(ficha){ abrirFicha(ficha.dataset.ccFicha); return; }
    if(e.target.closest('[data-cc-acao="novo"]')){ abrirForm(); return; }
    const jan = e.target.closest('[data-cc-jan]');
    if(jan){ view.janela = +jan.dataset.ccJan; renderTL(); return; }
    if(e.target.closest('#ccPrev')){ view.inicio = addMonthsAnchor(view.inicio, -1); renderTL(); return; }
    if(e.target.closest('#ccNext')){ view.inicio = addMonthsAnchor(view.inicio, 1); renderTL(); return; }
    if(e.target.closest('#ccHoje')){ view.inicio = firstOfMonth(hoje(), -1); renderTL(); return; }
    if(e.target.closest('#ccDados')) abrirDados();
  });
  el('ccEncerrados').addEventListener('change', (e) => { view.encerrados = e.target.checked; renderTL(); });

  // Ficha
  const dlgFicha = el('ccDlgFicha');
  dlgFicha.addEventListener('change', (e) => {
    const t = e.target;
    if(!t.dataset || !t.dataset.ccF) return;
    get(fichaId).ciclos[+t.dataset.ccI][t.dataset.ccF] = t.value;
    save(); render(); renderFicha();
  });
  dlgFicha.addEventListener('click', (e) => {
    if(e.target === dlgFicha){ dlgFicha.close(); return; }
    const b = e.target.closest('button');
    if(!b) return;
    const c = get(fichaId);
    if(b.dataset.ccHoje != null){ c.ciclos[+b.dataset.ccHoje].pago = hoje(); save(); render(); renderFicha(); }
    else if(b.dataset.ccFichaAcao === 'fechar') dlgFicha.close();
    else if(b.dataset.ccFichaAcao === 'renovar'){ c.meses += 3; norm(c); save(); render(); renderFicha(); }
    else if(b.dataset.ccFichaAcao === 'editar'){ dlgFicha.close(); abrirForm(c.id); }
  });

  // Formulário
  const dlgForm = el('ccDlgForm');
  el('ccForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = el('ccFNome').value.trim(), pag = el('ccFPag').value;
    if(!nome || !pag) return;
    const dados = {
      nome, mensal: +el('ccFMensal').value || 0, meses: parseInt(el('ccFMeses').value, 10) || 3,
      assinatura: el('ccFAss').value, pagamento1: pag, notas: el('ccFNotas').value.trim()
    };
    if(editId){
      const c = get(editId), old = c.pagamento1;
      Object.assign(c, dados);
      if(c.ciclos[0] && c.ciclos[0].pago === old) c.ciclos[0].pago = pag;
      norm(c);
    }else{
      clientes.push(norm({ id: uid(), ciclos: [{ pago: pag <= hoje() ? pag : '' }], ...dados }));
    }
    dlgForm.close();
    save(); render();
  });
  el('ccFCancelar').addEventListener('click', () => dlgForm.close());
  el('ccFRemover').addEventListener('click', () => {
    const c = get(editId);
    if(c && confirm(`Remover ${c.nome}? Isto apaga todos os registos desta cliente.`)){
      clientes = clientes.filter(x => x.id !== editId);
      dlgForm.close();
      save(); render();
    }
  });

  // Copiar / importar
  const dlgDados = el('ccDlgDados'), txt = el('ccDadosTxt'), msg = el('ccDadosMsg');
  el('ccDFechar').addEventListener('click', () => dlgDados.close());
  el('ccDCopiar').addEventListener('click', () => {
    txt.select();
    const fallback = () => {
      let ok = false;
      try{ ok = document.execCommand('copy'); }catch(e){ /* ignore */ }
      msg.textContent = ok ? 'Dados copiados.' : 'Selecione o texto e copie manualmente.';
    };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt.value).then(() => { msg.textContent = 'Dados copiados.'; }, fallback);
    }else fallback();
  });
  el('ccDImportar').addEventListener('click', () => {
    try{
      const arr = JSON.parse(txt.value);
      if(!Array.isArray(arr)) throw 0;
      arr.forEach(c => { if(!c || !c.nome || !c.pagamento1) throw 0; if(!c.id) c.id = uid(); });
      if(clientes.length && !confirm(`Substituir as ${clientes.length} clientes atuais pelas ${arr.length} importadas?`)) return;
      clientes = arr.map(norm);
      save(); render();
      msg.textContent = `Importadas ${arr.length} clientes.`;
    }catch(e){
      msg.textContent = 'Não foi possível importar: o texto precisa ser a lista copiada desta página.';
    }
  });
  el('ccDApagar').addEventListener('click', () => {
    if(confirm('Apagar todas as clientes da linha do tempo?')){
      clientes = [];
      save(); render();
      txt.value = '[]';
      msg.textContent = 'Tudo apagado.';
    }
  });
}

// Chamado pela Central sempre que a aba Timeline abre.
export async function loadCiclos(){
  if(!loaded){
    wire();
    loaded = true;
    try{
      const snap = await getDoc(CICLOS_DOC);
      const data = snap.exists() ? (snap.data() || {}) : {};
      clientes = Array.isArray(data.clientes) ? data.clientes.map(norm) : [];
    }catch(err){
      toast('Não foi possível carregar a linha do tempo.', true);
    }
  }
  render();
}
