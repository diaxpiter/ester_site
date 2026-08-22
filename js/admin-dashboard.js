// ============================================================
//  ADMIN: DASHBOARD (owner's overview) — revenue trend, production
//  pipeline by stage, upcoming shoot capacity, leads/retention signals,
//  and a handful of CSV exports. Read-only: every number here is derived
//  from the same `clients`/`income`/`leads` collections the other admin
//  views already read — no new Firestore data is written.
// ============================================================
import { getDocs, collection } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, getProjects, money, formatDatePt, daysUntil, addDaysIso, setAdminHash,
  show, ADMIN_EMAIL, FLOW_STAGES, projectFlowStage, isProjectComplete,
  DAILY_RECORDING_CAPACITY, toast
} from './core.js';
import { fetchOutstanding } from './admin-debts-agenda.js';

// Cached from the last load, so the CSV export buttons don't re-fetch.
let dashClients = [], dashIncome = [];

export async function loadDashboard(){
  setAdminHash('painel');
  show('view-admin-dashboard');
  document.getElementById('dashRevenueGrid').innerHTML = '<div class="stat-card"><span class="loading-dot"></span></div>';
  document.getElementById('dashStagesList').innerHTML = '';
  document.getElementById('dashCapacitySummary').textContent = '';
  document.getElementById('dashCapacityList').innerHTML = '';
  document.getElementById('dashLeadsGrid').innerHTML = '';

  let clientsSnap, incomeSnap, leadsSnap, overdueRows;
  try{
    [clientsSnap, incomeSnap, leadsSnap, overdueRows] = await Promise.all([
      getDocs(collection(db, "clients")),
      getDocs(collection(db, "income")),
      getDocs(collection(db, "leads")),
      fetchOutstanding()
    ]);
  }catch(err){
    document.getElementById('dashRevenueGrid').innerHTML = '<p class="panel-empty">Não foi possível carregar o painel.</p>';
    return;
  }

  dashClients = clientsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => (c.email || '') !== ADMIN_EMAIL);
  dashIncome = incomeSnap.docs.map(d => d.data());
  const leads = leadsSnap.docs.map(d => d.data());

  renderRevenue(dashIncome, overdueRows);
  renderStages(dashClients);
  renderCapacity(dashClients);
  renderLeadsRetention(dashClients, leads);
}

// ---------- Receita ----------
function ymOffset(offsetMonths){
  const d = new Date();
  d.setMonth(d.getMonth() + offsetMonths);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function sumByMonthPrefix(income, ym){
  return income.reduce((s, e) => (e.date && e.date.startsWith(ym)) ? s + (Number(e.amount) || 0) : s, 0);
}
function sumByYear(income, year){
  return income.reduce((s, e) => (e.date && Number(e.date.slice(0, 4)) === year) ? s + (Number(e.amount) || 0) : s, 0);
}
// "+18%" / "-4%" vs. the prior period; no prior data to compare against reads as "—" rather than a misleading spike.
function pctDelta(cur, prev){
  if(prev <= 0) return cur > 0 ? '+100%' : '—';
  const d = ((cur - prev) / prev) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(0) + '%';
}
function renderRevenue(income, overdueRows){
  const now = new Date();
  const thisMonth = sumByMonthPrefix(income, ymOffset(0));
  const lastMonth = sumByMonthPrefix(income, ymOffset(-1));
  const thisYear = sumByYear(income, now.getFullYear());
  const lastYear = sumByYear(income, now.getFullYear() - 1);
  const overdue = overdueRows.filter(r => daysUntil(r.iso) < 0);
  const overdueTotal = overdue.reduce((s, r) => s + r.amount, 0);

  document.getElementById('dashRevenueGrid').innerHTML = `
    <div class="stat-card">
      <div class="stat-num">${money.format(thisMonth)}</div>
      <div class="stat-label">Receita este mês</div>
      <div class="stat-sub">${pctDelta(thisMonth, lastMonth)} vs. mês anterior (${money.format(lastMonth)})</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${money.format(thisYear)}</div>
      <div class="stat-label">Receita este ano</div>
      <div class="stat-sub">${pctDelta(thisYear, lastYear)} vs. ano anterior (${money.format(lastYear)})</div>
    </div>
    <div class="stat-card ${overdue.length ? 'is-alert' : ''}">
      <div class="stat-num">${money.format(overdueTotal)}</div>
      <div class="stat-label">Em atraso</div>
      <div class="stat-sub">${overdue.length} pagamento${overdue.length === 1 ? '' : 's'}</div>
    </div>
  `;
}

// ---------- Projetos por etapa ----------
function renderStages(clients){
  const counts = FLOW_STAGES.map(() => 0);
  let untracked = 0;
  clients.forEach(c => {
    if(c.deactivated) return;
    getProjects(c).forEach(p => {
      const stage = projectFlowStage(p);
      if(stage < 0){ untracked++; return; } // pontual/avulso — payment-only, no production stages
      counts[stage]++;
    });
  });
  const el = document.getElementById('dashStagesList');
  if(counts.every(n => n === 0) && !untracked){
    el.innerHTML = '<p class="panel-empty">Nenhum projeto cadastrado.</p>';
    return;
  }
  const max = Math.max(1, ...counts);
  el.innerHTML = FLOW_STAGES.map((label, i) => `
    <div class="stage-row">
      <span class="stage-label">${label}</span>
      <span class="stage-bar"><span class="stage-bar-fill" style="width:${(counts[i] / max * 100).toFixed(0)}%;"></span></span>
      <span class="stage-count">${counts[i]}</span>
    </div>
  `).join('') + (untracked ? `<p class="stat-sub" style="margin-top:10px;">+ ${untracked} projeto(s) pontuais/avulsos (sem etapas de produção)</p>` : '');
}

// ---------- Capacidade — próximos 14 dias ----------
function renderCapacity(clients){
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const endIso = addDaysIso(todayIso, 13);
  const byDate = {};
  clients.forEach(c => {
    if(c.deactivated) return;
    getProjects(c).forEach(p => {
      (p.recordingDates || []).forEach(iso => {
        if(!iso || iso < todayIso || iso > endIso) return;
        byDate[iso] = (byDate[iso] || 0) + 1;
      });
    });
  });
  const totalSessions = Object.values(byDate).reduce((s, n) => s + n, 0);
  const overbooked = Object.entries(byDate)
    .filter(([, n]) => n > DAILY_RECORDING_CAPACITY)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

  document.getElementById('dashCapacitySummary').innerHTML =
    `${totalSessions} sessão(ões) agendada(s) nos próximos 14 dias` +
    (overbooked.length ? ` · <strong>${overbooked.length} dia(s) sobrelotado(s)</strong> (capacidade: ${DAILY_RECORDING_CAPACITY}/dia)` : '');

  const el = document.getElementById('dashCapacityList');
  if(!overbooked.length){
    el.innerHTML = totalSessions ? '' : '<p class="panel-empty">Nenhuma gravação agendada nos próximos 14 dias.</p>';
    return;
  }
  el.innerHTML = overbooked.map(([iso, n]) => `
    <div class="fin-ledger-row">
      <span class="fin-date">${formatDatePt(iso)}</span>
      <span><span class="fin-cli">Dia sobrelotado</span><br><span class="fin-note">${n} gravações agendadas</span></span>
      <span class="fin-amt">${n}</span>
      <span class="fin-actions"></span>
    </div>
  `).join('');
}

// ---------- Leads & retenção ----------
function renderLeadsRetention(clients, leads){
  const cutoffSec = (Date.now() - 30 * 86400000) / 1000;
  const newLeads30 = leads.filter(l => (l.createdAt?.seconds || 0) >= cutoffSec).length;
  const converted30 = leads.filter(l => l.converted && (l.convertedAt?.seconds || 0) >= cutoffSec).length;

  let completedWithProject = 0, completedWithTestimonial = 0;
  clients.forEach(c => {
    if(!getProjects(c).some(p => isProjectComplete(p))) return;
    completedWithProject++;
    if(c.testimonial && c.testimonial.text) completedWithTestimonial++;
  });
  const deactivatedCount = clients.filter(c => c.deactivated).length;

  document.getElementById('dashLeadsGrid').innerHTML = `
    <div class="stat-card">
      <div class="stat-num">${newLeads30}</div>
      <div class="stat-label">Novos leads (30 dias)</div>
      <div class="stat-sub">${converted30} convertido(s) em cliente no mesmo período</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${completedWithTestimonial}/${completedWithProject}</div>
      <div class="stat-label">Depoimentos coletados</div>
      <div class="stat-sub">entre clientes com pelo menos um projeto concluído</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${deactivatedCount}</div>
      <div class="stat-label">Clientes desativados</div>
      <div class="stat-sub">de ${clients.length} no total</div>
    </div>
  `;
}

// ---------- Relatórios (CSV) ----------
function downloadCsv(filename, rows){
  const csv = String.fromCharCode(0xFEFF) + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('dashExportRevenueBtn').addEventListener('click', () => {
  if(!dashIncome.length){ toast('Sem receitas para exportar', true); return; }
  const byMonth = {};
  dashIncome.forEach(e => {
    if(!e.date) return;
    const ym = e.date.slice(0, 7);
    byMonth[ym] = (byMonth[ym] || 0) + (Number(e.amount) || 0);
  });
  const rows = [['Mês', 'Receita (EUR)']];
  Object.keys(byMonth).sort().forEach(ym => rows.push([ym, String(byMonth[ym]).replace('.', ',')]));
  downloadCsv('resumo-mensal-ester.csv', rows);
});

document.getElementById('dashExportSourceBtn').addEventListener('click', () => {
  if(!dashClients.length){ toast('Sem clientes para exportar', true); return; }
  const byKey = {};
  dashClients.forEach(c => {
    const key = (c.referral || 'Não informado') + '|' + (c.niche || 'Não informado');
    byKey[key] = (byKey[key] || 0) + 1;
  });
  const rows = [['Origem', 'Nicho', 'Clientes']];
  Object.keys(byKey).sort().forEach(k => {
    const [ref, niche] = k.split('|');
    rows.push([ref, niche, byKey[k]]);
  });
  downloadCsv('clientes-por-origem-ester.csv', rows);
});

document.getElementById('dashExportPipelineBtn').addEventListener('click', () => {
  const rows = [['Cliente', 'Projeto', 'Etapa', 'Próximo pagamento em aberto']];
  dashClients.forEach(c => {
    if(c.deactivated) return;
    const name = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || 'Cliente';
    getProjects(c).forEach(p => {
      const stage = projectFlowStage(p);
      if(stage < 0 || isProjectComplete(p)) return; // only production still in progress
      const openDates = (p.paymentDates || []).filter((d, i) => d && !(p.paymentsPaid || [])[i]).sort();
      rows.push([name, p.name || 'Projeto', FLOW_STAGES[stage], openDates[0] ? formatDatePt(openDates[0]) : '—']);
    });
  });
  if(rows.length === 1){ toast('Nenhum projeto em produção para exportar', true); return; }
  downloadCsv('pipeline-projetos-ester.csv', rows);
});
