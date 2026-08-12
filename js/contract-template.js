// ============================================================
//  CONTRACT TEMPLATE — the printable contract document itself.
//  Pure: takes the client (c) + computed values (v) and returns the full
//  print-window HTML (with an embedded "Gerar .docx" button).
//  All the number/date-to-words prep (eurNum, valorPorExtenso, etc.) and the
//  "gather values from the open project + trigger the print window" logic
//  stay in admin-clients.js, next to the button that uses them.
//
//  Content model: each contract is built as an array of "blocks" (h1/h2/
//  paragraph/numbered-list/bullet-list/signature-line), shared by the HTML
//  renderer (blocksToHtml, below) AND the in-browser .docx generator
//  (DOCX_SCRIPT, embedded in the printed page) — so the two output formats
//  are always generated from the SAME source text and can't drift apart.
// ============================================================
import { escapeHtml } from './core.js';

export function contractFileName(c){
  const full = [c.firstName, c.lastName].map(s => (s || '').trim()).filter(Boolean).join(' ');
  return 'Contrato - ' + (full || 'Cliente');
}

const E = escapeHtml;
const TITLE = 'Contrato de Prestação de Serviços — Produção Audiovisual';

// ---- run/block helpers ----
// A "run" is one styled text fragment: { t, b:bold?, ph:red-placeholder? }.
const R = (t, opts = {}) => ({ t, b: !!opts.b, ph: !!opts.ph });
const RB = (val, opts = {}) => val ? R(String(val), opts) : R('____________', { ...opts, ph: true });
const euro = (val, opts = {}) => val ? R('€' + val, { ...opts, b: true }) : R('€____________', { ...opts, b: true, ph: true });

function partyBlocks(c){
  return [
    { k: 'p', party: true, runs: [
      R('CONTRATANTE: ', { b: true }),
      RB(c.firstName, { b: true }),
      R(' ', { b: true }),
      RB(c.lastName, { b: true }),
      R(','),
      c.nationality ? R(' ' + c.nationality, { b: true }) : R(' ____________', { b: true, ph: true }),
      R(', inscrita(o) no número de contribuinte (NIF): '),
      RB(c.nif, { b: true }),
      R(', Morada em: '),
      RB(c.address, { b: true }),
      R(' — '),
      RB(c.postalCode),
      R(', doravante denominada(o) CONTRATANTE.')
    ]},
    { k: 'p', party: true, runs: [
      R('CONTRATADA: ', { b: true }),
      R('Estephanie Barbosa da Silva Cerqueira', { b: true }),
      R(','),
      R(' Brasileira', { b: true }),
      R(', inscrita no número de contribuinte (NIF): '),
      R('317559567', { b: true }),
      R(', Morada em: '),
      R('Rua da Palmilheira 626 — Ermesinde', { b: true }),
      R(', doravante denominada(o) CONTRATADA.')
    ]},
    { k: 'p', runs: [ R('As partes acima identificadas celebram o presente contrato de prestação de serviços de produção audiovisual, nos termos das cláusulas e condições abaixo:') ] }
  ];
}

function closingBlocks(v){
  return [
    { k: 'p', spaceBefore: 16, runs: [ R('Por estarem justas e contratadas, as partes assinam o presente contrato.') ] },
    { k: 'p', center: true, runs: [ R('Porto — Portugal, '), RB(v.dataGeracao) ] }
  ];
}

function signBlocks(c){
  return [
    { k: 'line' },
    { k: 'p', center: true, runs: [ R('CONTRATANTE') ] },
    { k: 'p', center: true, runs: [ R('('), RB(c.firstName), R(' '), RB(c.lastName), R(')') ] },
    { k: 'line' },
    { k: 'p', center: true, runs: [ R('CONTRATADA') ] },
    { k: 'p', center: true, runs: [ R('(Estephanie Cerqueira)') ] }
  ];
}

// Clauses 8, 10, 11 and 13 are worded identically in both contract types —
// shared so a future wording tweak only has to happen in one place.
const CLAUSE_8_CONFIDENCIALIDADE = [
  { k: 'h2', t: 'CLÁUSULA 8 – CONFIDENCIALIDADE' },
  { k: 'p', runs: [ R('Ambas as partes se comprometem a manter confidenciais todas as informações e dados trocados durante a vigência deste contrato, incluindo materiais audiovisuais e dados de clientes.') ] }
];
const CLAUSE_10_RGPD = [
  { k: 'h2', t: 'CLÁUSULA 10 – PROTEÇÃO DE DADOS (RGPD)' },
  { k: 'p', runs: [ R('A CONTRATADA declara que cumpre com as disposições do Regulamento Geral sobre a Proteção de Dados (RGPD), comprometendo-se a utilizar os dados pessoais compartilhados pela CONTRATANTE exclusivamente para os fins de execução do serviço.') ] }
];
const CLAUSE_11_CONDICOES = [
  { k: 'h2', t: 'CLÁUSULA 11 – CONDIÇÕES GERAIS' },
  { k: 'p', runs: [ R('1.º A CONTRATADA não poderá transferir ou delegar suas responsabilidades a terceiros que não façam parte de sua equipe, sem autorização expressa da CONTRATANTE.') ] },
  { k: 'p', runs: [ R('2.º O presente contrato não estabelece sociedade, associação, consórcio ou responsabilidade solidária entre as partes.') ] },
  { k: 'p', runs: [ R('3.º As informações fornecidas pela CONTRATANTE devem ser verdadeiras e completas para garantir a execução do serviço conforme planejado.') ] }
];
const CLAUSE_13_FORO = [
  { k: 'h2', t: 'CLÁUSULA 13 – FORO' },
  { k: 'p', runs: [ R('Fica eleito o foro da comarca do Porto para dirimir quaisquer controvérsias oriundas deste contrato, renunciando-se a qualquer outro, por mais privilegiado que seja.') ] }
];

// ============================================================
//  MONTHLY contract blocks (3-month recurring packs).
// ============================================================
export function monthlyBlocks(c, v){
  const main = [
    { k: 'h1', t: TITLE },
    ...partyBlocks(c),

    { k: 'h2', t: 'CLÁUSULA 1 – OBJETO DO CONTRATO' },
    { k: 'p', runs: [ R('Este contrato tem como objeto a prestação de serviços de produção audiovisual pela CONTRATADA, com o objetivo de criar, gravar e editar conteúdos audiovisuais. Os serviços descritos serão prestados mensalmente durante o período contratual:') ] },
    { k: 'p', runs: [ R('a) '), R('Detalhes da entrega', { b: true }), R(': Criação de '), RB(v.desc) ] },
    { k: 'p', runs: [ R('b) '), R('Gravações', { b: true }), R(': '), RB(v.grav) ] },

    { k: 'h2', t: 'CLÁUSULA 2 – OBRIGAÇÕES DA CONTRATADA' },
    { k: 'p', runs: [ R('A CONTRATADA compromete-se a:') ] },
    { k: 'ol', items: [
      [ R('Desenvolver roteiros, gravar e editar os conteúdos para a(o) CONTRATANTE.') ],
      [ R('Entregar o material editado em até 10 dias úteis após a gravação.') ],
      [ R('Compartilhar de forma antecipada os conteúdos que serão gravados, juntamente com roteiros.') ],
      [ R('Estar disponível para sanar dúvidas durante todo o trabalho.') ]
    ]},

    { k: 'h2', t: 'CLÁUSULA 3 – OBRIGAÇÕES DA CONTRATANTE' },
    { k: 'p', runs: [ R('A CONTRATANTE obriga-se a:') ] },
    { k: 'ol', items: [
      [ R('Garantir à CONTRATADA todas as informações necessárias antes da gravação (agenda de disponibilidade, modelos disponíveis, produtos e serviços que serão gravados).') ],
      [ R('Responder por possíveis danos causados por terceiros à integridade física da CONTRATADA e sua equipe.') ],
      [ R('Estar disponível para sanar dúvidas durante o processo de execução do trabalho.') ],
      [ R('Definir com a CONTRATADA, no início da prestação dos serviços, o planejamento/briefing na totalidade, garantindo que as alterações a posteriori não tenham desvio significativo.') ]
    ]},

    { k: 'h2', t: 'CLÁUSULA 4 – PAGAMENTO' },
    { k: 'p', runs: [ R('O serviço será prestado pelo período de 3 (três) meses.') ] },
    { k: 'p', runs: [
      R('1.º O valor total pelos serviços prestados é de '),
      euro(v.total),
      R(' ('),
      RB(v.totalExt, { b: true }),
      R('), a serem pagos em parcelas iguais de '),
      euro(v.parcela),
      R(' (', { b: true }),
      RB(v.parcelaExt, { b: true }),
      R(')', { b: true }),
      R(', tais parcelas sendo pagas:')
    ]},
    { k: 'p', indent: true, tight: true, runs: [ R('1.ª parcela a ser paga até o dia '), RB(v.data1), R(';') ] },
    { k: 'p', indent: true, tight: true, runs: [ R('2.ª parcela a ser paga até o dia '), RB(v.data2), R(';') ] },
    { k: 'p', indent: true, runs: [ R('3.ª parcela a ser paga até o dia '), RB(v.data3), R('.') ] },
    { k: 'p', runs: [ R('2.º Em caso de atraso no pagamento, será aplicada uma multa de 5% sobre o valor total imediatamente a partir do primeiro dia de inadimplência.') ] },
    { k: 'p', runs: [ R('3.º O pagamento será feito via transferência bancária ou MB Way. Dados bancários da contratada: IBAN PT50 0010 0000 6185 0400 0019 6 — ESTEPHANIE BARBOSA DA SILVA CERQUEIRA.') ] },

    { k: 'h2', t: 'CLÁUSULA 5 – REMARCAÇÃO E CANCELAMENTO' },
    { k: 'p', runs: [ R('1.º Em caso de necessidade de remarcação da gravação, a CONTRATANTE deverá notificar a CONTRATADA com, no mínimo, 3 dias de antecedência, para que as partes acordem uma nova data e horário.') ] },
    { k: 'p', runs: [ R('2.º O cancelamento sem possibilidade de remarcação não implicará devolução de valores pagos, desde que o período mensal correspondente já tenha sido iniciado ou que a agenda da CONTRATADA tenha sido reservada para a execução do serviço.') ] },

    { k: 'h2', t: 'CLÁUSULA 6 – PRAZO DE ENTREGA DOS MATERIAIS' },
    { k: 'p', runs: [ R('1.º A CONTRATADA compromete-se a entregar o conteúdo gravado dentro de um prazo de até 10 dias úteis após o dia da gravação.') ] },
    { k: 'p', runs: [ R('2.º Caso a CONTRATANTE solicite alterações nos materiais entregues, terá prazo de até 5 dias, a contar do recebimento do material, para sinalizar ou suscitar tais modificações. Decorrido esse prazo sem manifestação, o conteúdo será considerado aceito e aprovado.') ] },
    { k: 'p', runs: [ R('3.º Caso o material entregue tenha alterações a serem realizadas por manifestação feita pela CONTRATANTE após o prazo disposto no parágrafo 2.º, será cobrada taxa adicional de 20% do valor principal.') ] },

    { k: 'h2', t: 'CLÁUSULA 7 – PRAZO DE VIGÊNCIA E ROMPIMENTO DO CONTRATO' },
    { k: 'p', runs: [
      R('1.º O presente contrato entra em vigor na data de sua assinatura e permanecerá válido por 3 (três) meses, com término previsto para '),
      RB(v.fim),
      R(', condicionado também à conclusão e entrega dos materiais contratados. A prorrogação do prazo somente poderá ocorrer mediante acordo entre as partes, não sendo automática.')
    ]},
    { k: 'p', runs: [ R('2.º Em caso de rescisão antecipada e imotivada do presente contrato por qualquer uma das partes antes do término do seu prazo de vigência, a parte que der causa à rescisão deverá comunicar a outra por escrito com antecedência mínima de 5 (cinco) dias em relação à data de vencimento da mensalidade seguinte.') ] },
    { k: 'p', runs: [ R('3.º Caso a rescisão antecipada seja solicitada pela CONTRATANTE, esta ficará obrigada a pagar à CONTRATADA uma multa rescisória estipulada em 30% sobre o valor total das mensalidades vincendas, considerando o plano ativo à data da rescisão, a título de indenização pela quebra de contrato e reserva de agenda.') ] },
    { k: 'p', runs: [ R('4.º Mantêm-se devidos, em qualquer caso, os valores relativos a períodos mensais já iniciados.') ] },

    ...CLAUSE_8_CONFIDENCIALIDADE,

    { k: 'h2', t: 'CLÁUSULA 9 – USO DE IMAGENS E PORTFÓLIO' },
    { k: 'p', runs: [ R('A CONTRATANTE não se opõe ao uso das imagens capturadas pela CONTRATADA e sua equipe para fins comerciais e promocionais, incluindo a utilização como portfólio e divulgação em redes sociais.') ] },

    ...CLAUSE_10_RGPD,
    ...CLAUSE_11_CONDICOES,

    { k: 'h2', t: 'CLÁUSULA 12 – CASO FORTUITO E FORÇA MAIOR' },
    { k: 'p', runs: [ R('Os casos de fortuito e força maior eximem as partes de responsabilidades. A parte afetada deverá notificar a outra imediatamente sobre o ocorrido, informando o prazo estimado de inabilitação para o cumprimento das obrigações.') ] },
    { k: 'p', runs: [ R('1.º Em particular, a CONTRATADA não poderá ser responsabilizada pela não entrega do serviço contratado caso seja vítima de roubo, devendo comunicar o fato à CONTRATANTE o mais breve possível.') ] },

    ...CLAUSE_13_FORO,

    ...closingBlocks(v)
  ];
  return { main, sign: signBlocks(c) };
}

// ============================================================
//  DAILY / PONTUAL contract blocks ("Pacotes Diários" and "Trabalhos
//  Pontuais", incl. "Trabalho Personalizado"): a single visit (or a handful
//  of dated visits), not a fixed 3-month term. Based verbatim on
//  docs/Contrato - Tamires Gomes .pdf (her actual signed daily contract).
// ============================================================
export function dailyBlocks(c, v){
  const parcelas = v.parcelas || [];
  const parcelasCountText = parcelas.length === 1 ? '1 (uma) parcela única' : `${parcelas.length} parcelas`;
  const parcelaBlocks = parcelas.map((p, i) => ({
    k: 'p', indent: true, tight: true,
    runs: [
      R(`${i + 1}.ª parcela — €`),
      RB(p.amount),
      R(', a ser paga até '),
      RB(p.date),
      R(i === parcelas.length - 1 ? '.' : ';')
    ]
  }));

  const main = [
    { k: 'h1', t: TITLE },
    ...partyBlocks(c),

    { k: 'h2', t: 'CLÁUSULA 1 – OBJETO DO CONTRATO' },
    { k: 'p', runs: [ R('Este contrato tem como objeto a prestação de serviços de produção audiovisual pela CONTRATADA, com o objetivo de criar, gravar e editar conteúdos audiovisuais. Os serviços descritos serão prestados durante o período contratual:') ] },
    { k: 'p', runs: [ R('a) Detalhes da entrega:', { b: true }) ] },
    { k: 'ul', items: [
      [ R('reunião de briefing;') ],
      [ R('planeamento da gravação;') ],
      [ R('elaboração dos roteiros;') ],
      [ R('captação das imagens;') ],
      [ R('direção da gravação;') ],
      [ R('edição;') ],
      [ R('entrega do material final;') ],
      [ R('elaboração das legendas.') ]
    ]},
    { k: 'p', runs: [ R('A quantidade de conteúdos entregues dependerá do planeamento previamente aprovado entre as partes, do tempo efetivo disponível para gravação, da colaboração da CONTRATANTE durante a execução dos serviços e da viabilidade técnica do material captado, comprometendo-se a CONTRATADA a entregar todos os conteúdos cuja qualidade atenda aos seus padrões técnicos.') ] },
    { k: 'p', runs: [ R('b) Gravações:', { b: true }), R(' '), RB(v.grav) ] },

    { k: 'h2', t: 'CLÁUSULA 2 – OBRIGAÇÕES DA CONTRATADA' },
    { k: 'p', runs: [ R('A CONTRATADA compromete-se a:') ] },
    { k: 'ol', items: [
      [ R('Desenvolver roteiros, gravar e editar os conteúdos para o CONTRATANTE.') ],
      [ R('Entregar o material editado em até 10 dias úteis após a gravação.') ],
      [ R('Compartilhar de forma antecipada os conteúdos que serão gravados, juntamente com roteiros.') ],
      [ R('Estar disponível para sanar dúvidas durante todo o trabalho.') ]
    ]},

    { k: 'h2', t: 'CLÁUSULA 3 – OBRIGAÇÕES DA CONTRATANTE' },
    { k: 'p', runs: [ R('A CONTRATANTE obriga-se a:') ] },
    { k: 'ol', items: [
      [ R('Garantir à CONTRATADA todas as informações necessárias antes da gravação, como: agenda de disponibilidade, modelos disponíveis, produtos e serviços que serão gravados.') ],
      [ R('Garantir que o ambiente de gravação ofereça condições adequadas de segurança para a execução dos serviços.') ],
      [ R('Estar disponível para sanar dúvidas durante o processo de execução do trabalho.') ],
      [ R('Definir com a CONTRATADA, no início da prestação dos serviços, o planeamento/briefing na totalidade. Garantindo que as alterações a posteriori não tenham desvio significativo.') ]
    ]},

    { k: 'h2', t: 'CLÁUSULA 4 – PAGAMENTO' },
    { k: 'p', runs: [ R('O serviço será prestado no formato '), RB(v.formato), R('.') ] },
    { k: 'p', runs: [
      R('1.º O valor total dos serviços prestados é de '),
      euro(v.total),
      R(' ('),
      RB(v.totalExt, { b: true }),
      R(`), a serem pagos em ${parcelasCountText}:`)
    ]},
    ...parcelaBlocks,
    { k: 'p', runs: [ R('2.º Em caso de atraso no pagamento, incidirá multa de 10% sobre o valor em dívida, sem prejuízo da suspensão da prestação do serviço até à regularização.') ] },
    { k: 'p', runs: [ R('3.º O pagamento deverá ser feito via transferência bancária ou MB Way. Dados bancários da contratada: IBAN PT50 0010 0000 6185 0400 0019 6 — ESTEPHANIE BARBOSA DA SILVA CERQUEIRA.') ] },

    { k: 'h2', t: 'CLÁUSULA 5 – REMARCAÇÃO E CANCELAMENTO' },
    { k: 'p', runs: [ R('1.º Em caso de necessidade de remarcação da gravação, a CONTRATANTE deverá notificar a CONTRATADA com, no mínimo, 3 dias de antecedência, para que as partes acordem uma nova data e horário de acordo com a disponibilidade de ambas.') ] },
    { k: 'p', runs: [ R('2.º Os valores pagos correspondem à reserva da agenda, planeamento e disponibilidade da CONTRATADA, não sendo reembolsáveis em caso de cancelamento por iniciativa da CONTRATANTE.') ] },

    { k: 'h2', t: 'CLÁUSULA 6 – PRAZO DE ENTREGA DOS MATERIAIS' },
    { k: 'p', runs: [ R('1.º A CONTRATADA compromete-se a entregar o conteúdo gravado dentro de um prazo de até 10 dias úteis após o dia da gravação.') ] },
    { k: 'p', runs: [ R('2.º Caso a CONTRATANTE solicite alterações nos materiais entregues, terá prazo de até 5 dias, a contar do recebimento do material, para sinalizar ou suscitar tais modificações. Decorrido esse prazo sem manifestação, o conteúdo será considerado aceito e aprovado.') ] },
    { k: 'p', runs: [ R('3.º Estão incluídas até duas rondas de revisões do material entregue, limitadas a ajustes de edição que não impliquem alteração do briefing previamente aprovado, inclusão de novos conteúdos ou realização de nova gravação.') ] },

    { k: 'h2', t: 'CLÁUSULA 7 – PRAZO DE VIGÊNCIA E ROMPIMENTO DO CONTRATO' },
    { k: 'p', runs: [ R('1.º O presente contrato entra em vigor na data de sua assinatura e permanecerá válido até à conclusão e entrega dos materiais contratados. A prorrogação do prazo somente poderá ocorrer mediante acordo entre as partes, não sendo automática.') ] },

    ...CLAUSE_8_CONFIDENCIALIDADE,

    { k: 'h2', t: 'CLÁUSULA 9 – USO DE IMAGENS E PORTFÓLIO' },
    { k: 'p', runs: [ R('A CONTRATANTE autoriza a utilização das imagens produzidas para fins de portfólio e divulgação profissional da CONTRATADA, salvo manifestação expressa em sentido contrário antes da realização da gravação.') ] },

    ...CLAUSE_10_RGPD,
    ...CLAUSE_11_CONDICOES,

    { k: 'h2', t: 'CLÁUSULA 12 – CASO FORTUITO E FORÇA MAIOR' },
    { k: 'p', runs: [ R('Os casos de fortuito e força maior eximem as partes de responsabilidades. A parte afetada por força maior ou caso fortuito deverá notificar a outra imediatamente sobre o ocorrido, informando o prazo estimado de inabilitação para o cumprimento das obrigações previstas neste contrato.') ] },
    { k: 'p', runs: [ R('1.º Em particular, a CONTRATADA não poderá ser responsabilizada pela não entrega do serviço contratado caso seja vítima de roubo ou acidente, devendo comunicar o fato à CONTRATANTE o mais breve possível.') ] },

    ...CLAUSE_13_FORO,

    ...closingBlocks(v)
  ];
  return { main, sign: signBlocks(c) };
}

// ---- blocks -> printable HTML ----
function runHtml(r){
  let s = E(r.t);
  if(r.ph) s = `<span class="ph">${s}</span>`;
  if(r.b) s = `<strong>${s}</strong>`;
  return s;
}
const runsHtml = runs => runs.map(runHtml).join('');

function blocksToHtml(blocks){
  return blocks.map(bl => {
    if(bl.k === 'h1') return `<h1>${E(bl.t)}</h1>`;
    if(bl.k === 'h2') return `<h2>${E(bl.t)}</h2>`;
    if(bl.k === 'line') return `<p class="line">_________________________________ </p>`;
    if(bl.k === 'ol') return `<ol type="I">${bl.items.map(it => `<li>${runsHtml(it)}</li>`).join('')}</ol>`;
    if(bl.k === 'ul') return `<ul>${bl.items.map(it => `<li>${runsHtml(it)}</li>`).join('')}</ul>`;
    if(bl.k === 'p'){
      const styles = [];
      if(bl.indent) styles.push('padding-left:22px');
      if(bl.tight) styles.push('margin-bottom:2px');
      if(bl.spaceBefore) styles.push(`margin-top:${bl.spaceBefore}px`);
      const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
      const clsAttr = bl.party ? ' class="party"' : (bl.center ? ' class="center"' : '');
      return `<p${clsAttr}${styleAttr}>${runsHtml(bl.runs)}</p>`;
    }
    return '';
  }).join('\n  ');
}

function renderContractPage(c, mainBlocks, signBlocks){
  return `<!doctype html><html lang="pt-PT"><head><meta charset="utf-8">
<title>${E(contractFileName(c))}</title>
<style>
  /* margin:0 leaves the browser no room to draw its URL/date/page-number
     header & footer; real page margins are recreated with body padding. */
  @page{ size:A4; margin:0; }
  *{ box-sizing:border-box; }
  body{ font-family:Arial,Helvetica,sans-serif; color:#111; font-size:12pt; line-height:1.5; margin:0; padding:18mm 20mm; }
  h1{ font-size:12pt; font-weight:bold; text-align:center; margin:0 0 18px; text-transform:uppercase; letter-spacing:0.02em; }
  h2{ font-size:12pt; font-weight:bold; margin:18px 0 6px; }
  p{ margin:0 0 9px; text-align:justify; }
  ul, ol{ margin:0 0 9px; padding-left:22px; }
  li{ margin-bottom:3px; text-align:justify; }
  .party{ margin-bottom:10px; }
  .ph{ color:#b00; }
  .center{ text-align:center; }
  .sign{ margin-top:46px; text-align:center; }
  .sign p{ text-align:center; }
  .sign .line{ margin-top:34px; }
  .toolbar{ text-align:center; margin:0 0 18px; }
  .toolbar button{ font:inherit; padding:8px 18px; border:1px solid #111; background:#111; color:#fff; border-radius:4px; cursor:pointer; }
  @media print{ .toolbar{ display:none; } }
</style></head>
<body onload="setTimeout(function(){window.print();},350)">
  <div class="toolbar"><button onclick="window.print()">Imprimir / Guardar como PDF</button></div>
  ${blocksToHtml(mainBlocks)}
  <div class="sign">
  ${blocksToHtml(signBlocks)}
  </div>
</body></html>`;
}

export function buildContractHtml(c, v){
  const { main, sign } = monthlyBlocks(c, v);
  return renderContractPage(c, main, sign);
}

export function buildDailyContractHtml(c, v){
  const { main, sign } = dailyBlocks(c, v);
  return renderContractPage(c, main, sign);
}

// ============================================================
//  .docx GENERATION — a real, directly-callable function (not a string
//  embedded in the printed page): the admin page calls this straight from
//  its own "Gerar contrato (.docx)" button, no print-preview popup needed
//  (unlike the PDF path, which needs an actual page to print). Loads the
//  `docx` library from jsdelivr on demand — same self-host-free CDN pattern
//  already used for GSAP/Lenis on the landing page — and turns the SAME
//  blocks used for the HTML above into a real Word document client-side.
// ============================================================
let docxLoadPromise = null;
function loadDocxLib(){
  if(window.docx) return Promise.resolve();
  if(docxLoadPromise) return docxLoadPromise;
  docxLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/index.iife.min.js';
    s.onload = () => resolve();
    s.onerror = () => { docxLoadPromise = null; reject(new Error('docx-cdn-load-failed')); };
    document.head.appendChild(s);
  });
  return docxLoadPromise;
}

function roman(n){
  const vals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  return vals[n - 1] || String(n);
}

const docxTextRun = r => new window.docx.TextRun({ text: r.t, bold: !!r.b, color: r.ph ? 'BB0000' : undefined, font: 'Arial', size: 24 });

function docxParaFromRuns(runs, opts = {}){
  return new window.docx.Paragraph({
    alignment: opts.center ? window.docx.AlignmentType.CENTER : window.docx.AlignmentType.JUSTIFIED,
    indent: opts.indent ? { left: 330 } : undefined,
    spacing: { before: (opts.spaceBefore || 0) * 15, after: opts.tight ? 40 : 160 },
    children: runs.map(docxTextRun)
  });
}

function blocksToDocxChildren(blocks){
  const children = [];
  blocks.forEach(bl => {
    if(bl.k === 'h1'){
      children.push(new window.docx.Paragraph({
        alignment: window.docx.AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [ new window.docx.TextRun({ text: bl.t.toUpperCase(), bold: true, font: 'Arial', size: 24 }) ]
      }));
    } else if(bl.k === 'h2'){
      children.push(new window.docx.Paragraph({
        spacing: { before: 240, after: 80 },
        children: [ new window.docx.TextRun({ text: bl.t, bold: true, font: 'Arial', size: 24 }) ]
      }));
    } else if(bl.k === 'p'){
      children.push(docxParaFromRuns(bl.runs, bl));
    } else if(bl.k === 'ol'){
      bl.items.forEach((item, i) => children.push(docxParaFromRuns([{ t: roman(i + 1) + '. ' }, ...item], { indent: true })));
    } else if(bl.k === 'ul'){
      bl.items.forEach(item => children.push(docxParaFromRuns([{ t: '• ' }, ...item], { indent: true })));
    } else if(bl.k === 'line'){
      children.push(new window.docx.Paragraph({
        alignment: window.docx.AlignmentType.CENTER,
        spacing: { before: 500 },
        children: [ new window.docx.TextRun({ text: '_________________________________', font: 'Arial', size: 24 }) ]
      }));
    }
  });
  return children;
}

// c: client record (for the filename); blocksResult: the {main, sign} shape
// returned by monthlyBlocks()/dailyBlocks(). Throws if the CDN library fails
// to load (e.g. offline) — the caller shows its own error message.
export async function downloadContractDocx(c, blocksResult){
  await loadDocxLib();
  const doc = new window.docx.Document({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1020, bottom: 1020, left: 1134, right: 1134 }
        }
      },
      children: blocksToDocxChildren(blocksResult.main.concat(blocksResult.sign))
    }]
  });
  const blob = await window.docx.Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = contractFileName(c) + '.docx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
