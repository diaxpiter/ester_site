// ============================================================
//  ADMIN: CENTRAL → TIMELINE — os ciclos mensais de cada cliente numa linha
//  do tempo: meses pagos / por pagar / em atraso, pagamentos, gravação,
//  prazo de entrega e revisões, mais a lista "Precisa de atenção".
//
//  Lê os clientes reais (coleção `clients`) sempre que a aba abre: entra
//  cada cliente não desativado com pelo menos um projeto de pacote mensal.
//  Cada projeto mensal são 3 meses; renovações (novos projetos) seguem na
//  mesma linha. Por projeto:
//    paymentDates[i]  → vencimento do mês i (o mês acaba na véspera do seguinte)
//    paymentsPaid[i]  → pago ou não (a data real do pagamento não é guardada,
//                       por isso conta como pago no vencimento)
//    recordingDates   → gravações de cada mês (recordingSlots diz o mês)
//    deliveryDates    → entrega do mês = primeira entrega já feita entre a
//                       última gravação e o fim do mês
//  É só leitura: pagamentos, gravações e entregas registam-se no projeto
//  ("Abrir projeto" na ficha). As regras vivem em js/ciclos-core.js.
// ============================================================
import {
  getDocs, getDoc, doc, collection
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, toast, escapeAttr, ADMIN_EMAIL, MONTHLY_BATCH_MONTHS, getProjects,
  isMonthlyWorkflow, projectPaymentDates, projectDeliveryDates, recordingSlots,
  packPriceNumber, workflowDoneSet
} from './core.js';
import { loadAdminEdit, openProject } from './admin-clients.js';
import { CFG, P, F, hoje, addDays, diff, addMonthsAnchor, addUteis, calcularCiclos, estadoTexto } from './ciclos-core.js';

const MES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const MESL = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const fmtEur = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });

const el = id => document.getElementById(id);
const esc = s => escapeAttr(s == null ? '' : String(s));
const eur = v => fmtEur.format(+v || 0);
const dias = n => `${n} ${n === 1 ? 'dia' : 'dias'}`;
const dm = s => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const dmy = s => `${dm(s)}/${s.slice(0, 4)}`;
function firstOfMonth(s, off = 0){ const d = P(s); return F(new Date(d.getFullYear(), d.getMonth() + off, 1, 12)); }
// Sem data real de pagamento, "pago em <vencimento>" seria inventado.
const estadoTxt = cy => cy.estado === 'pago' ? 'pago' : estadoTexto(cy);

let linhas = [];   // [{ id, nome, dia, cs: [ciclo + { mensal, projeto, pid, n }], projetos }]
const view = { janela: 3, inicio: firstOfMonth(hoje(), -1), encerrados: false };
let wired = false;
let fichaId = null;

// ---------- clientes → ciclos ----------
function nomeCliente(data){
  const pessoal = `${data.firstName || ''} ${data.lastName || ''}`.trim();
  const empresa = (data.company || '').trim();
  return empresa || pessoal || data.email || 'Cliente';
}

// Um projeto mensal → os seus 3 ciclos, já com o valor e o projeto de cada um.
function ciclosDoProjeto(p){
  const HOJE = hoje();
  const venc = projectPaymentDates(p).filter(Boolean);
  const inicio = venc[0] || p.contractStart;
  if(!inicio) return [];
  const pagos = p.paymentsPaid || [];
  const valores = p.paymentAmounts || [];
  const unico = venc.length === 1; // pagamento único para os 3 meses
  const total = unico ? (Number(valores[0]) || packPriceNumber(p.pack) * MONTHLY_BATCH_MONTHS) : 0;
  const slots = recordingSlots(p);
  const recs = p.recordingDates || [];
  const entregas = projectDeliveryDates(p).filter(d => d && d <= HOJE).sort();
  const feito = workflowDoneSet(p);

  // 1.ª passagem só para saber onde começa cada mês.
  const base = calcularCiclos({ inicio, meses: MONTHLY_BATCH_MONTHS, mensal: 0, vencimentos: venc }, HOJE);
  const ciclos = base.map((b, i) => {
    const gravs = slots.filter(s => s.month === i + 1).map(s => recs[s.idx]).filter(Boolean).sort();
    const gravacao = gravs[gravs.length - 1] || '';
    let entrega = '';
    if(gravacao){
      entrega = entregas.find(d => d >= gravacao && d <= b.fim) || '';
      // Edição marcada como feita mas sem data de entrega: conta como entregue no prazo.
      if(!entrega && feito.has(`m${i + 1}-edit`)){
        const prazo = addUteis(gravacao, CFG.diasUteisEntrega);
        entrega = prazo <= HOJE ? prazo : HOJE;
      }
    }
    const pago = unico ? !!pagos[0] : !!pagos[i];
    return { pago: pago ? b.ini : '', gravacao, entrega, gravs };
  });
  const cs = calcularCiclos({ inicio, meses: MONTHLY_BATCH_MONTHS, mensal: 0, vencimentos: venc, ciclos }, HOJE);
  return cs.map((cy, i) => Object.assign(cy, {
    mensal: unico ? total / MONTHLY_BATCH_MONTHS : (Number(valores[i]) || packPriceNumber(p.pack)),
    gravs: ciclos[i].gravs,
    projeto: p.name || 'Projeto',
    pid: p.id,
    n: i + 1
  }));
}

async function carregar(){
  const snap = await getDocs(collection(db, 'clients'));
  const out = [];
  snap.docs.forEach(d => {
    const data = d.data();
    if((data.email || '') === ADMIN_EMAIL || data.deactivated) return;
    const projetos = getProjects(data).filter(isMonthlyWorkflow);
    const cs = projetos.flatMap(ciclosDoProjeto).sort((a, b) => (a.ini < b.ini ? -1 : a.ini > b.ini ? 1 : 0));
    if(!cs.length) return;
    out.push({ id: d.id, nome: nomeCliente(data), cs, projetos });
  });
  linhas = out;
}

function resumo(c){
  const HOJE = hoje();
  const cs = c.cs, fim = cs.reduce((m, x) => (x.fim > m ? x.fim : m), cs[0].fim);
  const atrasos = cs.filter(x => x.estado === 'atraso');
  const atual = cs.find(x => x.ini <= HOJE && HOJE <= x.fim) || cs.find(x => x.ini > HOJE) || cs[cs.length - 1];
  return {
    cs, fim, atrasos, atual,
    ativo: HOJE <= fim || atrasos.length > 0,
    divida: atrasos.reduce((s, x) => s + x.mensal, 0)
  };
}
const multa = v => v * CFG.multaPct / 100;

// ---------- resumo ----------
function renderResumo(){
  const HOJE = hoje(), ym = HOJE.slice(0, 7);
  let rec = 0, atr = 0, ca = 0, prox = 0, pn = 0, ativos = 0;
  linhas.forEach(c => {
    const r = resumo(c);
    if(r.ativo) ativos++;
    let a = false;
    r.cs.forEach(cy => {
      if(cy.pago && cy.pago.slice(0, 7) === ym) rec += cy.mensal;
      if(cy.estado === 'atraso'){ atr += cy.mensal; a = true; }
      if(cy.estado === 'hoje' || cy.estado === 'a-vencer'){ prox += cy.mensal; pn++; }
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
  const lista = linhas.map(c => ({ c, r: resumo(c) }))
    .filter(x => view.encerrados || x.r.ativo)
    .sort((a, b) => (b.r.atrasos.length - a.r.atrasos.length) || a.c.nome.localeCompare(b.c.nome, 'pt'));

  if(!lista.length){
    html += `<div class="cc-vazio"><p>${linhas.length ? 'Nenhuma cliente com plano mensal a decorrer. Marque "Mostrar encerrados" para ver as anteriores.' : 'Nenhuma cliente com pacote mensal. Os planos mensais criados nos projetos aparecem aqui.'}</p></div>`;
    tl.innerHTML = html;
    return;
  }
  lista.forEach(({ c, r }) => {
    let lane = grid + nowLine;
    r.cs.forEach(cy => {
      const s = seg(cy.ini, addDays(cy.fim, 1));
      if(!s) return;
      const tip = `${c.nome} · ${cy.projeto}, mês ${cy.n} de ${MONTHLY_BATCH_MONTHS}: ${dm(cy.ini)} a ${dm(cy.fim)}, ${estadoTxt(cy)}`;
      lane += `<button type="button" class="cc-clip st-${cy.estado}" style="left:${s[0]}%;width:${s[1]}%" data-cc-ficha="${esc(c.id)}" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="cc-c1">Mês ${cy.n} de ${MONTHLY_BATCH_MONTHS}</span><span class="cc-c2">${estadoTxt(cy)}</span></button>`;
      if(cy.estado === 'atraso'){
        const b = seg(cy.venc, addDays(HOJE, 1));
        if(b) lane += `<div class="cc-blk" style="left:${b[0]}%;width:${b[1]}%"></div>`;
      }
      if(inWin(cy.venc)) lane += `<i class="cc-pay${cy.pago ? '' : cy.estado === 'atraso' ? ' is-falta' : ' is-aberto'}" style="left:${pos(cy.venc) + hd}%"></i>`;
      if(cy.gravacao){
        const w = seg(addDays(cy.gravacao, 1), addDays(cy.entregaAte, 1));
        if(w) lane += `<div class="cc-prod is-work" style="left:${w[0]}%;width:${w[1]}%"></div>`;
        const rv = seg(addDays(cy.entrega || cy.entregaAte, 1), addDays(cy.revisaoAte, 1));
        if(rv) lane += `<div class="cc-prod ${cy.estoura ? 'is-over' : 'is-rev'}" style="left:${rv[0]}%;width:${rv[1]}%"></div>`;
        cy.gravs.forEach(g => { if(inWin(g)) lane += `<i class="cc-rec" style="left:${pos(g) + hd}%"></i>`; });
        if(cy.entrega && inWin(cy.entrega)) lane += `<i class="cc-del" style="left:${pos(cy.entrega) + hd}%"></i>`;
      }
    });
    const n = r.atrasos.length, at = r.atual;
    html += `<div class="cc-row"><button type="button" class="cc-head" data-cc-ficha="${esc(c.id)}"><span class="cc-nome">${esc(c.nome)}</span><span class="cc-sub">${eur(at.mensal)} por mês<br>vence dia ${P(at.venc).getDate()}</span>${n ? `<span class="cc-pill">${n} ${n === 1 ? 'mês' : 'meses'} em atraso</span>` : ''}</button><div class="cc-lane">${lane}</div></div>`;
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
  linhas.forEach(c => {
    const r = resumo(c);
    if(!r.ativo) return;
    const nome = `<strong>${esc(c.nome)}</strong>`;
    r.cs.forEach(cy => {
      const m = `mês ${cy.n}`;
      if(cy.estado === 'atraso') itens.push({ p: 0, t: 'late', id: c.id, h: `${nome}: ${m} venceu em ${dm(cy.venc)} e está em atraso há ${dias(cy.atrasoDias)} (${eur(cy.mensal)}).` });
      else if(cy.estado === 'hoje') itens.push({ p: 1, t: 'pay', id: c.id, h: `${nome}: ${m} vence hoje (${eur(cy.mensal)}).` });
      else if(cy.estado === 'a-vencer') itens.push({ p: 2, t: 'pay', id: c.id, h: `${nome}: ${m} vence em ${dm(cy.venc)}, daqui a ${dias(cy.faltam)} (${eur(cy.mensal)}).` });
      const corrente = cy.ini <= HOJE && HOJE <= cy.fim;
      if(corrente && cy.pago && !cy.gravacao) itens.push({ p: 3, t: '', id: c.id, h: `${nome}: ${m} pago, gravação ainda por marcar. O mês termina em ${dm(cy.fim)}.` });
      if(cy.gravacao && !cy.pago && cy.gravs[0] < HOJE) itens.push({ p: 3, t: 'late', id: c.id, h: `${nome}: gravação do ${m} feita antes do pagamento.` });
      if(cy.gravacao && !cy.entrega && cy.gravacao <= HOJE){
        const f = diff(HOJE, cy.entregaAte);
        if(f <= 3) itens.push({ p: f < 0 ? 0 : 2, t: f < 0 ? 'late' : '', id: c.id, h: `${nome}: entrega do ${m}${f < 0 ? ` passou do prazo (${dm(cy.entregaAte)}).` : ` até ${dm(cy.entregaAte)}.`}` });
      }
      if(cy.estoura && cy.fim >= HOJE) itens.push({ p: 3, t: '', id: c.id, h: `${nome}: as revisões do ${m} vão até ${dm(cy.revisaoAte)}, depois do fim do mês (${dm(cy.fim)}).` });
    });
    const fr = diff(HOJE, r.fim);
    if(!r.atrasos.length && fr >= 0 && fr <= 21) itens.push({ p: 4, t: '', id: c.id, h: `${nome}: plano termina em ${dm(r.fim)}. Hora de falar da renovação.` });
  });
  itens.sort((a, b) => a.p - b.p);
  el('ccAtencao').innerHTML = itens.length
    ? `<ul class="cc-atencao">${itens.map(x => `<li class="t-${x.t}"><p>${x.h}</p><button type="button" class="cc-link" data-cc-ficha="${esc(x.id)}">Abrir ficha</button></li>`).join('')}</ul>`
    : `<p class="cc-ok">Tudo em dia. Nada vence nos próximos ${CFG.diasAVencer} dias.</p>`;
}

function render(){ renderResumo(); renderTL(); renderAtencao(); }

// ---------- ficha da cliente (só leitura) ----------
function abrirFicha(id){
  fichaId = id;
  const c = linhas.find(x => x.id === id), dlg = el('ccDlgFicha');
  if(!c) return;
  const r = resumo(c);
  let h = `<div class="cc-dlg-h"><h3 id="ccFichaNome">${esc(c.nome)}</h3><p>Plano mensal até ${dmy(r.fim)}. Pagamentos, gravações e entregas registam-se no projeto.</p></div><div class="cc-dlg-b">`;
  if(r.atrasos.length){
    const na = r.atrasos.length, mt = r.atrasos.reduce((s, x) => s + multa(x.mensal), 0);
    h += `<div class="cc-divida"><strong>Em aberto: ${eur(r.divida + mt)}</strong>, sendo ${eur(r.divida)} de ${na} ${na === 1 ? 'mensalidade' : 'mensalidades'} e ${eur(mt)} de multa (${CFG.multaPct}% de cada mensalidade atrasada).</div>`;
  }
  c.projetos.forEach(p => {
    const cs = r.cs.filter(x => x.pid === p.id);
    if(!cs.length) return;
    h += `<div class="cc-proj-h"><strong>${esc(p.name || 'Projeto')}</strong><button type="button" class="btn-mini" data-cc-projeto="${esc(p.id)}">Abrir projeto</button></div>`;
    cs.forEach(cy => {
      h += `<section class="cc-cy"><div class="cc-cy-h"><strong>Mês ${cy.n}</strong><span class="cc-per">${dm(cy.ini)} a ${dm(cy.fim)}, vence ${dm(cy.venc)} · ${eur(cy.mensal)}</span><span class="cc-badge st-${cy.estado}">${estadoTxt(cy)}</span></div>`;
      const linha = [];
      linha.push(cy.gravs.length ? `Gravação ${cy.gravs.map(dm).join(', ')}` : 'Gravação por marcar');
      if(cy.gravacao) linha.push(cy.entrega ? `entregue ${dm(cy.entrega)}` : `entrega até ${dm(cy.entregaAte)} (${CFG.diasUteisEntrega} dias úteis)`, `revisões até ${dm(cy.revisaoAte)}`);
      h += `<p class="cc-calc">${linha.join(' · ')}.</p>`;
      if(cy.estoura) h += `<p class="cc-aviso">As revisões passam do fim do mês (${dm(cy.fim)}).</p>`;
      if(cy.entrega && cy.entrega > cy.entregaAte) h += `<p class="cc-aviso">Entregue ${dias(diff(cy.entregaAte, cy.entrega))} depois do prazo.</p>`;
      h += '</section>';
    });
  });
  h += `</div><div class="cc-dlg-f"><button type="button" class="btn-mini is-primary" data-cc-ficha-acao="fechar">Fechar</button></div>`;
  el('ccFicha').innerHTML = h;
  if(!dlg.open) dlg.showModal();
}

async function abrirProjeto(clientId, projectId){
  el('ccDlgFicha').close();
  try{
    const snap = await getDoc(doc(db, 'clients', clientId));
    if(!snap.exists()){ toast('Este cliente já não existe.', true); return; }
    loadAdminEdit(clientId, snap.data());
    openProject(projectId);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }catch(err){
    toast('Não foi possível abrir o projeto.', true);
  }
}

// ---------- eventos (ligados uma vez) ----------
function wire(){
  el('ccRoot').addEventListener('click', (e) => {
    const ficha = e.target.closest('[data-cc-ficha]');
    if(ficha){ abrirFicha(ficha.dataset.ccFicha); return; }
    const jan = e.target.closest('[data-cc-jan]');
    if(jan){ view.janela = +jan.dataset.ccJan; renderTL(); return; }
    if(e.target.closest('#ccPrev')){ view.inicio = addMonthsAnchor(view.inicio, -1); renderTL(); return; }
    if(e.target.closest('#ccNext')){ view.inicio = addMonthsAnchor(view.inicio, 1); renderTL(); return; }
    if(e.target.closest('#ccHoje')){ view.inicio = firstOfMonth(hoje(), -1); renderTL(); }
  });
  el('ccEncerrados').addEventListener('change', (e) => { view.encerrados = e.target.checked; renderTL(); });

  const dlg = el('ccDlgFicha');
  dlg.addEventListener('click', (e) => {
    if(e.target === dlg){ dlg.close(); return; }
    const proj = e.target.closest('[data-cc-projeto]');
    if(proj){ abrirProjeto(fichaId, proj.dataset.ccProjeto); return; }
    if(e.target.closest('[data-cc-ficha-acao="fechar"]')) dlg.close();
  });
}

// Chamado pela Central sempre que a aba Timeline abre — relê os clientes,
// para refletir o que acabou de ser editado nos projetos.
export async function loadCiclos(){
  if(!wired){ wire(); wired = true; }
  try{
    await carregar();
  }catch(err){
    toast('Não foi possível carregar os clientes.', true);
  }
  render();
}
