// js/ciclos-core.js
// Regras dos ciclos de clientes da ESTER — funções puras, sem DOM nem Firestore.
// Usado pelo admin do portal (js/admin-ciclos.js) e pode ser copiado para o
// vercel-cron/ para os lembretes depois do vencimento usarem as mesmas regras.
//
// Datas são sempre strings 'AAAA-MM-DD' (hora local, meio-dia, para não haver
// surpresas com a mudança de hora).

export const CFG = {
  multaPct: 5,        // % de cada mensalidade paga com atraso (regra atual)
  diasUteisEntrega: 10,
  diasRevisao: 4,     // dias corridos depois da entrega
  diasAVencer: 7,     // janela do "a vencer em breve"
};

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export function P(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); }
export function F(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function hoje() { return F(new Date()); }
export function addDays(s, n) { const d = P(s); d.setDate(d.getDate() + n); return F(d); }
export function diff(a, b) { return Math.round((P(b) - P(a)) / DAY); }
const dim = (y, m) => new Date(y, m + 1, 0).getDate();

// Mesmo dia do mês, n meses depois. Dia 31 cai no último dia dos meses curtos,
// mas volta a 31 quando o mês tem 31 (calcula-se sempre a partir da âncora).
export function addMonthsAnchor(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1 + n, 1, 12);
  t.setDate(Math.min(d, dim(t.getFullYear(), t.getMonth())));
  return F(t);
}

// Feriados nacionais + São João (Porto)
const cacheFeriados = {};
function pascoa(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
    f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return F(new Date(y, mes - 1, dia, 12));
}
export function feriados(y) {
  if (cacheFeriados[y]) return cacheFeriados[y];
  const p = pascoa(y);
  const s = new Set(['01-01', '04-25', '05-01', '06-10', '06-24', '08-15', '10-05', '11-01', '12-01', '12-08', '12-25'].map((x) => `${y}-${x}`));
  s.add(addDays(p, -2)); s.add(p); s.add(addDays(p, 60));
  return (cacheFeriados[y] = s);
}
export function diaUtil(s) { const w = P(s).getDay(); return w !== 0 && w !== 6 && !feriados(P(s).getFullYear()).has(s); }
export function addUteis(s, n) { let c = s, k = 0; while (k < n) { c = addDays(c, 1); if (diaUtil(c)) k++; } return c; }

/**
 * plano = {
 *   inicio:  'AAAA-MM-DD'  data do 1.º pagamento (âncora de todos os vencimentos)
 *   meses:   3
 *   mensal:  290
 *   ciclos:  [{ pago, gravacao, entrega }]  — um por mês, campos opcionais
 * }
 */
export function calcularCiclos(plano, dataHoje = hoje(), cfg = CFG) {
  const out = [];
  for (let i = 0; i < plano.meses; i++) {
    const ini = addMonthsAnchor(plano.inicio, i);
    const fim = addDays(addMonthsAnchor(plano.inicio, i + 1), -1);
    const r = (plano.ciclos && plano.ciclos[i]) || {};
    const cy = { i, ini, fim, venc: ini, pago: r.pago || '', gravacao: r.gravacao || '', entrega: r.entrega || '' };

    if (cy.pago) {
      cy.atrasoDias = Math.max(0, diff(ini, cy.pago));
      cy.estado = cy.atrasoDias > 0 ? 'pago-atraso' : 'pago';
    } else {
      const d = diff(dataHoje, ini);
      if (d > 0) { cy.estado = d <= cfg.diasAVencer ? 'a-vencer' : 'futuro'; cy.faltam = d; }
      else if (d === 0) cy.estado = 'hoje';
      else { cy.estado = 'atraso'; cy.atrasoDias = -d; }
    }
    cy.multa = (cy.estado === 'atraso' || cy.estado === 'pago-atraso') ? plano.mensal * cfg.multaPct / 100 : 0;

    if (cy.gravacao) {
      cy.entregaAte = addUteis(cy.gravacao, cfg.diasUteisEntrega);
      cy.revisaoAte = addDays(cy.entrega || cy.entregaAte, cfg.diasRevisao);
      cy.estoura = cy.revisaoAte > cy.fim;
      cy.gravacaoAntesDoPagamento = !cy.pago || cy.gravacao < cy.pago;
    }
    out.push(cy);
  }
  return out;
}

export function resumoPlano(plano, dataHoje = hoje(), cfg = CFG) {
  const cs = calcularCiclos(plano, dataHoje, cfg);
  const fim = cs[cs.length - 1].fim;
  const atrasos = cs.filter((x) => x.estado === 'atraso');
  return {
    ciclos: cs,
    fim,
    atrasos,
    ativo: dataHoje <= fim || atrasos.length > 0,
    emDivida: atrasos.length * plano.mensal,
    multas: cs.reduce((s, x) => s + x.multa, 0),
    atual: cs.find((x) => x.ini <= dataHoje && dataHoje <= x.fim) || null,
  };
}

export function estadoTexto(cy) {
  const d = (n) => `${n} ${n === 1 ? 'dia' : 'dias'}`;
  const dm = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
  switch (cy.estado) {
    case 'pago': return `pago em ${dm(cy.pago)}`;
    case 'pago-atraso': return `pago com ${d(cy.atrasoDias)} de atraso`;
    case 'atraso': return `em atraso há ${d(cy.atrasoDias)}`;
    case 'hoje': return 'vence hoje';
    case 'a-vencer': return `vence em ${d(cy.faltam)}`;
    default: return `vence ${dm(cy.venc)}`;
  }
}

// Lista "Precisa de atenção". `planos` = [{ id, nome, ...plano }]
export function itensAtencao(planos, dataHoje = hoje(), cfg = CFG) {
  const itens = [];
  for (const p of planos) {
    const r = resumoPlano(p, dataHoje, cfg);
    if (!r.ativo) continue;
    for (const cy of r.ciclos) {
      const base = { id: p.id, nome: p.nome, mes: cy.i + 1 };
      if (cy.estado === 'atraso') itens.push({ ...base, tipo: 'atraso', prioridade: 0, dias: cy.atrasoDias, valor: p.mensal });
      else if (cy.estado === 'hoje') itens.push({ ...base, tipo: 'vence-hoje', prioridade: 1, valor: p.mensal });
      else if (cy.estado === 'a-vencer') itens.push({ ...base, tipo: 'a-vencer', prioridade: 2, dias: cy.faltam, valor: p.mensal });

      const corrente = cy.ini <= dataHoje && dataHoje <= cy.fim;
      if (corrente && cy.pago && !cy.gravacao) itens.push({ ...base, tipo: 'gravacao-por-marcar', prioridade: 3, ate: cy.fim });
      if (cy.gravacao && !cy.entrega && cy.gravacao <= dataHoje) {
        const f = diff(dataHoje, cy.entregaAte);
        if (f <= 3) itens.push({ ...base, tipo: f < 0 ? 'entrega-atrasada' : 'entrega-proxima', prioridade: f < 0 ? 0 : 2, ate: cy.entregaAte });
      }
      if (cy.estoura && cy.fim >= dataHoje) itens.push({ ...base, tipo: 'revisoes-passam-do-mes', prioridade: 3, ate: cy.revisaoAte });
    }
    const fr = diff(dataHoje, r.fim);
    if (!r.atrasos.length && fr >= 0 && fr <= 21) itens.push({ id: p.id, nome: p.nome, tipo: 'renovacao', prioridade: 4, ate: r.fim });
  }
  return itens.sort((a, b) => a.prioridade - b.prioridade);
}

// Dias depois do vencimento em que o cron deve mandar lembrete (regra 6 do guia).
export const LEMBRETES_POS_VENCIMENTO = [1, 3, 7];
export function lembreteDeHoje(cy) {
  return cy.estado === 'atraso' && LEMBRETES_POS_VENCIMENTO.includes(cy.atrasoDias) ? cy.atrasoDias : null;
}
