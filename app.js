// Gestor Pro Painel — app.js: telas e operações ligadas ao Supabase (multiempresa, com assinatura).
import { supabase, ctx, autenticar, recarregarConta } from './supa.js';

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const num = v => { const n = Number(String(v ?? '').trim().replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const dt = s => (s ? new Date(s).toLocaleString('pt-BR') : '—');
const dia = s => new Date(s).toLocaleDateString('sv-SE');
const hoje = () => dia(new Date());
const qtdFmt = n => String(r3(n)).replace('.', ',');
const EMP = () => ctx.empresa.empresa_id;
const ehAdmin = () => ['dono', 'admin'].includes(ctx.empresa?.papel);
const ehDono = () => ctx.empresa?.papel === 'dono';
const um = o => (Array.isArray(o) ? o[0] : o) || {};

const q = async p => { const { data, error } = await p; if (error) throw error; return data; };
function erro(e) {
  const t = String(e?.message || e || '');
  if (e?.code === '23503') return 'Este registro já foi usado em vendas/compras e não pode ser excluído.';
  if (e?.code === '42501' || /row-level security/i.test(t)) return 'Sem permissão para esta ação, ou a assinatura da empresa está inativa.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return 'Sem conexão com a internet. Tente novamente.';
  return t || 'Não foi possível concluir.';
}
function say(m, bad) {
  const t = $('#toast');
  t.textContent = m; t.className = bad ? 'err' : ''; t.hidden = false;
  clearTimeout(say.t); say.t = setTimeout(() => (t.hidden = true), 5000);
}
let busy = false;
async function lock(fn) {
  if (busy) throw new Error('Aguarde: operação em andamento.');
  busy = true;
  try { return await fn(); } finally { busy = false; }
}
const opts = (arr, f) => arr.map(f).join('');
const lista = (t, ordem = 'nome', asc = true) => q(supabase.from(t).select('*').order(ordem, { ascending: asc }).limit(1000));

/* ---------- conexão / sessão ---------- */
function statusConexao() {
  const s = $('#connectionStatus'), on = navigator.onLine;
  s.textContent = on ? 'Online' : 'Sem conexão'; s.className = 'status' + (on ? '' : ' off');
}
window.addEventListener('online', statusConexao);
window.addEventListener('offline', statusConexao);
statusConexao();
// Sistema online: remove Service Workers e caches de versões antigas.
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});

await autenticar();

/* ---------- configurações de cupom ---------- */
const lsKey = () => 'gp_print_' + EMP();
const lsLer = () => { try { return JSON.parse(localStorage.getItem(lsKey()) || '{}'); } catch (_) { return {}; } };
async function cfg() {
  const c = await q(supabase.from('configuracoes_empresa').select('*').eq('empresa_id', EMP()).maybeSingle());
  const l = lsLer();
  return { nome: c?.nome_exibicao || ctx.empresa.nome || 'Gestor Pro Painel', linha2: c?.linha2 || '', largura: c?.largura_cupom || 80, modo: l.modo || 'navegador', auto: l.auto || 'nao' };
}

/* ---------- cupom (58/80 mm, USB ESC/POS ou navegador) ---------- */
const sa = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
const fmt = n => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2).replace('.', ',');
function montarCupom(v, larg, c) {
  const W = larg === 58 ? 32 : 48, ln = '-'.repeat(W), L = [];
  const ctr = t => ' '.repeat(Math.max(0, Math.floor((W - t.length) / 2))) + t;
  const lr = (a, b) => { a = sa(a); b = sa(b); return a.slice(0, Math.max(0, W - b.length - 1)).padEnd(W - b.length) + b; };
  L.push(ctr(sa(c.nome).slice(0, W))); if (c.linha2) L.push(ctr(sa(c.linha2).slice(0, W)));
  L.push(ln, ctr('CUPOM NAO FISCAL'), sa(dt(v.data)).slice(0, W));
  if (v.id) L.push('Venda #' + v.id);
  L.push(ln);
  for (const i of v.itens) { L.push(sa(i.nome).slice(0, W)); L.push(lr(`  ${qtdFmt(i.quantidade)} x ${fmt(i.preco)}`, fmt(i.subtotal))); }
  L.push(ln, lr('Subtotal', fmt(v.subtotal)));
  if (v.desconto > 0) L.push(lr('Desconto', '-' + fmt(v.desconto)));
  L.push(lr('TOTAL', fmt(v.total)));
  for (const p of v.pagamentos) L.push(lr(p.forma, fmt(p.valor)));
  if (v.troco > 0) L.push(lr('Troco', fmt(v.troco)));
  if (v.cliente) L.push('Cliente: ' + sa(v.cliente).slice(0, W - 9));
  L.push(ln, ctr('Obrigado pela preferencia!'));
  return L;
}
const escpos = L => Uint8Array.from([0x1B, 0x40, ...new TextEncoder().encode(L.join('\n') + '\n\n\n\n'), 0x1D, 0x56, 0x42, 0x00]);
const iface = d => {
  for (const c of d.configurations) for (const i of c.interfaces) for (const a of i.alternates) {
    if (a.interfaceClass === 7) { const ep = a.endpoints.find(e => e.direction === 'out'); if (ep) return { c: c.configurationValue, n: i.interfaceNumber, e: ep.endpointNumber }; }
  }
};
async function usbDev(parear) {
  if (!navigator.usb) throw new Error('WebUSB indisponível (use Chrome/Edge).');
  let d = (await navigator.usb.getDevices()).find(x => iface(x));
  if (!d && parear) { d = await navigator.usb.requestDevice({ filters: [] }); if (!iface(d)) throw new Error('O dispositivo escolhido não é uma impressora USB.'); }
  if (!d) throw new Error('Nenhuma impressora USB conectada. Use Ajustes → Conectar impressora USB.');
  return d;
}
async function usbEnviar(bytes) {
  const d = await usbDev(false), f = iface(d);
  await d.open();
  try {
    if (d.configuration === null) await d.selectConfiguration(f.c);
    await d.claimInterface(f.n);
    for (let i = 0; i < bytes.length; i += 512) await d.transferOut(f.e, bytes.slice(i, i + 512));
    await d.releaseInterface(f.n);
  } finally { await d.close().catch(() => {}); }
}
function imprimirNavegador(L, larg) {
  let st = $('#pageSize'); if (!st) { st = document.createElement('style'); st.id = 'pageSize'; document.head.appendChild(st); }
  st.textContent = `@page{size:${larg}mm auto;margin:2mm}`;
  $('#cupomPrint').textContent = L.join('\n'); window.print();
}
async function imprimir(v) {
  const c = await cfg(), larg = Number(c.largura), L = montarCupom(v, larg, c);
  if (c.modo === 'usb') {
    try { await usbEnviar(escpos(L)); return; } catch (e) { say('USB indisponível (' + (e.message || e) + '). Usando a impressão do navegador.', true); }
  }
  imprimirNavegador(L, larg);
}
const vendaParaCupom = v => {
  const d = um(v.venda_detalhes), itens = (v.itens_venda || []).map(i => ({ nome: um(i.produtos).nome || 'Item', quantidade: i.quantidade, preco: i.preco_unitario, subtotal: i.subtotal }));
  const pg = (v.venda_pagamentos || []).length ? v.venda_pagamentos : [{ forma: v.forma_pagamento, valor: v.total }];
  return { id: v.id, data: v.created_at, itens, subtotal: r2(Number(v.total) + Number(v.desconto || 0)), desconto: Number(v.desconto || 0), total: Number(v.total), pagamentos: pg, troco: 0, cliente: um(d.clientes).nome || '' };
};

/* ---------- navegação ---------- */
const PAGES = [
  ['vender', '🧾', 'Vender'], ['vendas', '📜', 'Histórico'], ['caixa', '🏧', 'Caixa'], ['produtos', '📦', 'Produtos'],
  ['estoque', '📊', 'Estoque'], ['clientes', '👥', 'Clientes'], ['fornecedores', '🚚', 'Fornecedores'], ['compras', '🛒', 'Compras'],
  ['despesas', '💸', 'Despesas'], ['receber', '💳', 'A receber'], ['relatorios', '📈', 'Relatórios'],
  ['equipe', '🧑‍🤝‍🧑', 'Equipe', 1], ['ajustes', '⚙️', 'Ajustes'], ['assinatura', '⭐', 'Assinatura', 1]
];
let page = 'vender', busca = '', editando = null, cart = [], cartC = [], pdvProds = [], relDia = hoje();
const temAcesso = () => ctx.empresa?.com_acesso !== false;

function desenharNav() {
  const nav = $('#nav'); nav.innerHTML = '';
  for (const [id, ico, nome, adm] of PAGES) {
    if (adm && !ehAdmin()) continue;
    if (!temAcesso() && id !== 'assinatura') continue;
    const b = document.createElement('button'); b.type = 'button'; b.dataset.page = id;
    b.className = id === page ? 'on' : ''; b.innerHTML = ico + '<span>' + esc(nome) + '</span>';
    nav.append(b);
  }
}
function desenharBanner() {
  const b = $('#banner'), e = ctx.empresa; let h = '';
  if (!temAcesso()) h = '<p class="bad"><strong>Acesso suspenso.</strong> O período de teste ou a assinatura terminou. ' + (ehAdmin() ? 'Abra a aba Assinatura para regularizar.' : 'Peça ao dono da empresa para regularizar a assinatura.') + '</p>';
  else if (e.assinatura_status === 'teste') h = `<p class="good">Teste grátis: ${e.dias_restantes_teste ?? 0} dia(s) restantes.${ehAdmin() ? ' Assine na aba Assinatura.' : ''}</p>`;
  else if (e.assinatura_status === 'inadimplente') h = '<p class="warn"><strong>Pagamento em atraso.</strong> Regularize para não perder o acesso.</p>';
  b.innerHTML = h; b.hidden = !h;
}
async function ir(p) {
  page = p; busca = ''; editando = null;
  if (p !== 'vender') cart = [];
  desenharNav(); await render(true);
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b) ir(b.dataset.page); });

/* ---------- telas ---------- */
const payOpts = '<option>Dinheiro</option><option>Pix</option><option>Cartão de débito</option><option>Cartão de crédito</option>';
const tipoTxt = t => (t === 'quilo' ? 'kg' : 'un');

const VIEWS = {
  async produtos() {
    const [prods, cats] = await Promise.all([lista('produtos'), lista('categorias')]);
    const e = editando || {}, t = busca.trim().toLowerCase();
    const rows = prods.filter(p => !t || p.nome.toLowerCase().includes(t) || String(p.codigo || '').includes(t)).slice(0, 150);
    return `<h2>${editando ? 'Editar produto' : 'Cadastrar produto'}</h2>
      <form data-form="produto"><label>Nome</label><input name="nome" required value="${esc(e.nome)}">
      <div class="row"><div><label>Código de barras</label><input name="codigo" value="${esc(e.codigo)}"></div>
      <div><label>Categoria</label><select name="categoria"><option value="">Sem categoria</option>${opts(cats, c => `<option ${e.categoria === c.nome ? 'selected' : ''}>${esc(c.nome)}</option>`)}</select></div></div>
      <div class="row"><div><label>Preço de custo (R$)</label><input name="preco_custo" type="number" step="0.01" min="0" value="${e.preco_custo ?? 0}"></div>
      <div><label>Preço de venda (R$)</label><input name="preco_venda" type="number" step="0.01" min="0" required value="${e.preco_venda ?? ''}"></div></div>
      <div class="row"><div><label>Venda por</label><select name="tipo_venda"><option value="unidade" ${e.tipo_venda !== 'quilo' ? 'selected' : ''}>Unidade</option><option value="quilo" ${e.tipo_venda === 'quilo' ? 'selected' : ''}>Quilo (peso)</option></select></div>
      <div><label>Estoque mínimo</label><input name="estoque_minimo" type="number" step="0.001" min="0" value="${e.estoque_minimo ?? 0}"></div></div>
      ${editando ? '<p>O saldo de estoque só muda pela aba Estoque.</p>' : '<label>Estoque inicial</label><input name="estoque" type="number" step="0.001" min="0" value="0">'}
      <button>${editando ? 'Salvar alterações' : 'Salvar produto'}</button>${editando ? '<button type="button" class="sec" data-act="cancel">Cancelar</button>' : ''}</form>
      <h2>Categorias</h2><form data-form="categoria"><label>Nova categoria</label><input name="nome" required placeholder="Ex.: Mercearia"><button>Adicionar</button></form>
      ${cats.map(c => `<article class="item"><strong>${esc(c.nome)}</strong><button type="button" class="sec" data-act="rencat" data-id="${c.id}">Renomear</button>${ehAdmin() ? `<button type="button" class="danger" data-act="delcat" data-id="${c.id}">Excluir</button>` : ''}</article>`).join('')}
      <h2>Produtos cadastrados (${prods.length})</h2><input data-search placeholder="Pesquisar produto..." value="${esc(busca)}">` +
      (rows.map(p => `<article class="item"><strong>${esc(p.nome)}</strong> — ${money(p.preco_venda)}/${tipoTxt(p.tipo_venda)}
        <p>Estoque: ${qtdFmt(p.estoque)} ${tipoTxt(p.tipo_venda)} · Custo ${money(p.preco_custo)} ${p.categoria ? '· ' + esc(p.categoria) : ''} ${p.codigo ? '· ' + esc(p.codigo) : ''}</p>
        ${p.estoque_minimo > 0 && p.estoque <= p.estoque_minimo ? '<p class="warn">Estoque baixo</p>' : ''}
        <button type="button" data-act="edit" data-id="${p.id}">Editar</button>${ehAdmin() ? `<button type="button" class="danger" data-act="del" data-id="${p.id}">Excluir</button>` : ''}</article>`).join('') || '<p>Nenhum produto.</p>');
  },

  async estoque() {
    const prods = await lista('produtos');
    const baixo = prods.filter(p => p.estoque_minimo > 0 && p.estoque <= p.estoque_minimo);
    const hist = await q(supabase.from('movimentacoes_estoque').select('*, produtos(nome)').order('created_at', { ascending: false }).limit(40));
    return `<h2>Estoque</h2><form data-form="estoque"><label>Produto</label><select name="id" required>${opts(prods, p => `<option value="${p.id}">${esc(p.nome)} (${qtdFmt(p.estoque)})</option>`)}</select>
      <label>Operação</label><select name="tipo"><option value="entrada">Entrada</option><option value="saida">Saída / perda</option><option value="ajuste">Ajuste (novo saldo)</option></select>
      <label>Quantidade</label><input name="qtd" type="number" step="0.001" min="0" required><label>Motivo</label><input name="motivo"><button>Registrar</button></form>
      ${baixo.length ? `<p class="warn">Estoque baixo: ${baixo.map(p => esc(p.nome)).join(', ')}</p>` : ''}
      <h2>Movimentações recentes</h2>` +
      (hist.map(a => `<article class="item"><strong>${esc(um(a.produtos).nome || 'Produto removido')}</strong> — ${esc(a.tipo)} ${qtdFmt(a.quantidade)}<p>${dt(a.created_at)} · ${esc(a.observacao || '')}</p></article>`).join('') || '<p>Sem movimentações.</p>');
  },

  async clientes() { return crudView('clientes', 'Clientes'); },
  async fornecedores() { return crudView('fornecedores', 'Fornecedores'); },

  async compras() {
    const [prods, fors, hist] = await Promise.all([lista('produtos'), lista('fornecedores'),
      q(supabase.from('compras').select('*, fornecedores(nome)').order('created_at', { ascending: false }).limit(30))]);
    const total = r2(cartC.reduce((t, i) => t + i.quantidade * i.preco, 0));
    return `<h2>Compras</h2><form data-form="itemc"><label>Produto</label><select name="id" required>${opts(prods, p => `<option value="${p.id}">${esc(p.nome)}</option>`)}</select>
      <div class="row"><div><label>Quantidade</label><input name="qtd" type="number" step="0.001" min="0.001" required></div>
      <div><label>Custo unitário (R$)</label><input name="preco" type="number" step="0.01" min="0" required></div></div><button>Adicionar item</button></form>
      ${cartC.map((i, k) => `<article class="item"><strong>${esc(i.nome)}</strong> — ${qtdFmt(i.quantidade)} × ${money(i.preco)}<button type="button" class="danger" data-act="rmc" data-id="${k}">Remover</button></article>`).join('') || '<p>Nenhum item adicionado.</p>'}
      ${cartC.length ? `<p class="tot">Total: ${money(total)}</p>` : ''}
      <form data-form="compra"><label>Fornecedor (opcional)</label><select name="fornecedor"><option value="">Sem fornecedor</option>${opts(fors, f => `<option value="${f.id}">${esc(f.nome)}</option>`)}</select>
      <label><input type="checkbox" name="pago" checked> Compra já paga</label><label>Vencimento (se não paga)</label><input name="venc" type="date"><button ${cartC.length ? '' : 'disabled'}>Finalizar compra</button></form>
      <h2>Histórico</h2>` +
      (hist.map(c => `<article class="item"><strong>${esc(um(c.fornecedores).nome || 'Sem fornecedor')}</strong> — ${money(c.total)}<p>#${c.id} · ${dt(c.created_at)} · ${esc(c.status)}</p>
        ${c.status === 'concluida' && ehAdmin() ? `<button type="button" class="danger" data-act="cancelc" data-id="${c.id}">Cancelar compra</button>` : ''}</article>`).join('') || '<p>Nenhuma compra.</p>');
  },

  async vender() {
    const [prods, cli, cx] = await Promise.all([lista('produtos'), lista('clientes'), caixaAberto()]);
    pdvProds = prods;
    return `<h2>Vender</h2>${cx ? '' : '<p class="warn">Caixa fechado: abra o caixa na aba Caixa para vender.</p>'}
      <label>Buscar produto ou ler código de barras</label><input data-pdv autocomplete="off" placeholder="Nome ou código (Enter)">
      <label>Quantidade</label><input id="pdvQty" type="number" step="0.001" min="0.001" value="1"><div id="pdvResults"></div>
      <h2>Carrinho</h2><div id="cartBox"></div>
      <form data-form="venda" id="vendaForm"><label>Cliente</label><select name="cliente"><option value="">Consumidor final</option>${opts(cli, c => `<option value="${c.id}">${esc(c.nome)}</option>`)}</select>
      <label>Desconto (R$)</label><input name="desconto" type="number" step="0.01" min="0" value="0" data-calc>
      <div class="row"><div><label>Pix (R$)</label><input name="pix" type="number" step="0.01" min="0" value="0" data-calc></div>
      <div><label>Cartão débito (R$)</label><input name="debito" type="number" step="0.01" min="0" value="0" data-calc></div></div>
      <div class="row"><div><label>Cartão crédito (R$)</label><input name="credito" type="number" step="0.01" min="0" value="0" data-calc></div>
      <div><label>Fiado (R$)</label><input name="fiado" type="number" step="0.01" min="0" value="0" data-calc></div></div>
      <label>Vencimento do fiado</label><input name="venc" type="date">
      <label>Dinheiro recebido (R$) — vazio = valor exato</label><input name="recebido" type="number" step="0.01" min="0" data-calc>
      <p id="pdvResumo"></p><button ${cx ? '' : 'disabled'}>Finalizar venda</button></form>`;
  },

  async vendas() {
    const hist = await q(supabase.from('vendas').select('id,total,desconto,forma_pagamento,created_at,venda_detalhes(status,cliente_id,clientes(nome)),venda_pagamentos(forma,valor),itens_venda(quantidade,preco_unitario,subtotal,produtos(nome))').order('created_at', { ascending: false }).limit(40));
    return '<h2>Histórico de vendas</h2>' + (hist.map(v => { const d = um(v.venda_detalhes); return `<article class="item"><strong>#${v.id} — ${money(v.total)}</strong> (${esc(v.forma_pagamento || '')})
      <p>${dt(v.created_at)} · ${esc(um(d.clientes).nome || 'Consumidor final')} · ${esc(d.status || '')}</p>
      <button type="button" class="sec" data-act="cupom" data-id="${v.id}">Cupom</button>${d.status === 'concluida' ? `<button type="button" class="danger" data-act="cancelv" data-id="${v.id}">Cancelar</button>` : ''}</article>`; }).join('') || '<p>Nenhuma venda.</p>');
  },

  async caixa() {
    const cx = await caixaAberto();
    const hist = await q(supabase.from('caixa_sessoes').select('*').order('aberto_em', { ascending: false }).limit(10));
    let corpo;
    if (!cx) corpo = '<form data-form="abrircx"><label>Fundo inicial (R$)</label><input name="v" type="number" step="0.01" min="0" value="0"><button>Abrir caixa</button></form>';
    else {
      const [vs, mv] = await Promise.all([
        q(supabase.from('vendas').select('total,forma_pagamento,venda_detalhes(status),venda_pagamentos(forma,valor)').eq('user_id', ctx.user.id).gte('created_at', cx.aberto_em).limit(1000)),
        q(supabase.from('caixa_movimentos').select('*').eq('caixa_id', cx.id).order('created_at', { ascending: false }))]);
      let din = 0;
      for (const v of vs) {
        if (um(v.venda_detalhes).status !== 'concluida') continue;
        if (v.venda_pagamentos?.length) din += v.venda_pagamentos.filter(p => p.forma === 'Dinheiro').reduce((t, p) => t + Number(p.valor), 0);
        else if (v.forma_pagamento === 'Dinheiro') din += Number(v.total);
      }
      const sup = mv.filter(m => m.tipo === 'suprimento').reduce((t, m) => t + Number(m.valor), 0), san = mv.filter(m => m.tipo === 'sangria').reduce((t, m) => t + Number(m.valor), 0);
      corpo = `<div class="item"><p>Aberto em ${dt(cx.aberto_em)} · Fundo ${money(cx.fundo_inicial)}</p><p>Vendas em dinheiro: ${money(din)} · Entradas: ${money(sup)} · Retiradas: ${money(san)}</p>
        <p class="tot">Esperado em dinheiro: ${money(r2(Number(cx.fundo_inicial) + din + sup - san))}</p></div>
        <form data-form="movcx"><label>Tipo</label><select name="tipo"><option value="suprimento">Entrada de dinheiro</option><option value="sangria">Retirada (sangria)</option></select>
        <label>Valor (R$)</label><input name="v" type="number" step="0.01" min="0.01" required><label>Motivo</label><input name="motivo"><button>Registrar</button></form>
        <form data-form="fecharcx"><label>Valor contado na gaveta (R$)</label><input name="v" type="number" step="0.01" min="0" required><button class="danger">Fechar caixa</button></form>
        ${mv.map(m => `<article class="item"><strong>${m.tipo === 'sangria' ? 'Retirada' : 'Entrada'}: ${money(m.valor)}</strong><p>${dt(m.created_at)} ${esc(m.motivo || '')}</p></article>`).join('')}`;
    }
    return '<h2>Caixa</h2>' + corpo + '<h2>Últimos caixas</h2>' + (hist.map(s => `<article class="item"><strong>${dt(s.aberto_em)}</strong> — ${esc(s.status)}<p>Fundo ${money(s.fundo_inicial)}${s.esperado != null ? ' · Esperado ' + money(s.esperado) : ''}${s.valor_contado != null ? ' · Contado ' + money(s.valor_contado) + ' · Diferença ' + money(s.diferenca) : ''}</p></article>`).join('') || '<p>Nenhuma sessão.</p>');
  },

  async despesas() {
    const rows = await q(supabase.from('despesas').select('*').neq('status', 'cancelada').order('created_at', { ascending: false }).limit(60));
    return `<h2>Despesas</h2><form data-form="despesa"><label>Descrição</label><input name="descricao" required><label>Categoria</label><input name="categoria" value="Outros">
      <div class="row"><div><label>Valor (R$)</label><input name="valor" type="number" step="0.01" min="0.01" required></div><div><label>Vencimento</label><input name="venc" type="date" value="${hoje()}"></div></div>
      <label><input type="checkbox" name="paga" checked> Já paga</label><button>Registrar despesa</button></form>` +
      (rows.map(d => `<article class="item"><strong>${esc(d.descricao)}</strong> — ${money(d.valor)}<p>${esc(d.categoria)} · ${d.status === 'paga' ? 'Paga em ' + dt(d.pago_em) : 'Em aberto' + (d.vencimento ? ' · vence ' + esc(d.vencimento) : '')}</p>
        ${d.status === 'aberta' ? `<button type="button" data-act="pagar" data-id="${d.id}">Marcar como paga</button>` : ''}${ehAdmin() && !d.compra_id ? `<button type="button" class="danger" data-act="deldesp" data-id="${d.id}">Excluir</button>` : ''}</article>`).join('') || '<p>Nenhuma despesa.</p>');
  },

  async receber() {
    const rows = await q(supabase.from('contas_receber').select('*, clientes(nome)').eq('status', 'aberta').order('vencimento', { ascending: true, nullsFirst: false }).limit(200));
    const tot = rows.reduce((t, c) => t + Number(c.valor) - Number(c.valor_pago), 0);
    return `<h2>Contas a receber (fiado)</h2><p class="tot">Total em aberto: ${money(tot)}</p>` + (rows.map(c => {
      const saldo = r2(Number(c.valor) - Number(c.valor_pago)), atras = c.vencimento && c.vencimento < hoje();
      return `<article class="item"><strong>${esc(um(c.clientes).nome)}</strong> — saldo ${money(saldo)}<p>Venda #${c.venda_id ?? '—'} · total ${money(c.valor)} · pago ${money(c.valor_pago)} ${c.vencimento ? '· vence ' + esc(c.vencimento) : ''}</p>
        ${atras ? '<p class="bad">Vencida</p>' : ''}<div class="inline"><div><label>Valor recebido</label><input type="number" step="0.01" min="0.01" max="${saldo}" value="${saldo}" data-rec="${c.id}"></div><button type="button" data-act="receber" data-id="${c.id}">Receber</button></div></article>`;
    }).join('') || '<p>Nenhuma conta em aberto.</p>');
  },

  async relatorios() {
    const ym = relDia.slice(0, 7), ini = new Date(ym + '-01T00:00:00'), fim = new Date(ini); fim.setMonth(fim.getMonth() + 1);
    const [vs, ds] = await Promise.all([
      q(supabase.from('vendas').select('id,total,created_at,venda_detalhes(status,custo_total),venda_pagamentos(forma,valor),itens_venda(quantidade,produtos(nome))').gte('created_at', ini.toISOString()).lt('created_at', fim.toISOString()).limit(1000)),
      q(supabase.from('despesas').select('valor,pago_em').eq('status', 'paga').is('compra_id', null).gte('pago_em', ini.toISOString()).lt('pago_em', fim.toISOString()).limit(1000))]);
    const bloco = (titulo, pred) => {
      const r = { n: 0, canc: 0, receita: 0, cmv: 0, desp: 0, pg: {}, top: {} };
      for (const v of vs) {
        const d = um(v.venda_detalhes); if (!pred(dia(v.created_at))) continue;
        if (d.status === 'cancelada') { r.canc++; continue; }
        r.n++; r.receita += Number(v.total); r.cmv += Number(d.custo_total || 0);
        for (const p of v.venda_pagamentos || []) r.pg[p.forma] = (r.pg[p.forma] || 0) + Number(p.valor);
        for (const i of v.itens_venda || []) { const nm = um(i.produtos).nome || 'Item'; r.top[nm] = (r.top[nm] || 0) + Number(i.quantidade); }
      }
      r.desp = ds.filter(x => pred(dia(x.pago_em))).reduce((t, x) => t + Number(x.valor), 0);
      const top = Object.entries(r.top).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, qt]) => `${esc(n)} (${qtdFmt(qt)})`).join(', ');
      const pg = Object.entries(r.pg).map(([f, v]) => `${esc(f)} ${money(v)}`).join(' · ');
      return `<article class="item"><h3>${titulo}</h3><p>Vendas: ${r.n} · Cancelamentos: ${r.canc}</p><p>Receita: <strong>${money(r.receita)}</strong></p><p>Custo das mercadorias: ${money(r.cmv)}</p>
        <p>Lucro bruto: <strong>${money(r.receita - r.cmv)}</strong></p><p>Despesas pagas (exceto compras): ${money(r.desp)}</p><p>Lucro líquido: <strong>${money(r.receita - r.cmv - r.desp)}</strong></p>
        <p>${pg || 'Sem pagamentos'}</p><p>Mais vendidos: ${top || '—'}</p></article>`;
    };
    return `<h2>Relatórios</h2><label>Data de referência</label><input type="date" data-rel value="${relDia}" style="max-width:220px">` +
      bloco('Dia ' + relDia, d => d === relDia) + bloco('Mês ' + ym, d => d.slice(0, 7) === ym) + (vs.length >= 1000 ? '<p class="warn">Mostrando as primeiras 1000 vendas do mês.</p>' : '');
  },

  async equipe() {
    const m = await q(supabase.rpc('listar_membros'));
    return `<h2>Equipe</h2><p>Usuários desta empresa e convites pendentes. O limite depende do seu plano.</p>
      <form data-form="convite"><label>E-mail do convidado</label><input name="email" type="email" required><label>Papel</label><select name="papel"><option value="operador">Operador</option>${ehDono() ? '<option value="admin">Administrador</option>' : ''}</select><button>Gerar convite</button></form>
      <div id="conviteLink"></div><h2>Membros</h2>` +
      m.membros.map(x => `<article class="item"><strong>${esc(x.email)}</strong> — ${esc(x.papel)}${x.user_id === ctx.user.id ? ' (você)' : ''}
        ${ehDono() && x.user_id !== ctx.user.id ? `<div class="inline"><select data-papel="${x.user_id}"><option ${x.papel === 'operador' ? 'selected' : ''}>operador</option><option ${x.papel === 'admin' ? 'selected' : ''}>admin</option><option ${x.papel === 'dono' ? 'selected' : ''}>dono</option></select><button type="button" class="sec" data-act="papel" data-id="${x.user_id}">Alterar papel</button></div>` : ''}
        ${x.user_id !== ctx.user.id ? `<button type="button" class="danger" data-act="rmmembro" data-id="${x.user_id}">Remover</button>` : ''}</article>`).join('') +
      '<h2>Convites</h2>' + (m.convites.filter(c => c.situacao === 'pendente').map(c => `<article class="item"><strong>${esc(c.email)}</strong> — ${esc(c.papel)}<p>Expira em ${dt(c.expira_em)}</p><button type="button" class="danger" data-act="cancelconv" data-id="${c.id}">Cancelar convite</button></article>`).join('') || '<p>Nenhum convite pendente.</p>');
  },

  async ajustes() {
    const c = await cfg(), sel = (a, b) => (a === b ? 'selected' : '');
    return `<h2>Impressão e cupom</h2>${ehAdmin() ? `<form data-form="ajustes"><label>Nome no cupom</label><input name="nome" value="${esc(c.nome)}"><label>Linha 2 (endereço/CNPJ)</label><input name="linha2" value="${esc(c.linha2)}">
      <label>Papel</label><select name="largura"><option value="58" ${sel(String(c.largura), '58')}>58 mm</option><option value="80" ${sel(String(c.largura), '80')}>80 mm</option></select>` : '<form data-form="ajustes">'}
      <label>Forma de impressão (neste aparelho)</label><select name="modo"><option value="navegador" ${sel(c.modo, 'navegador')}>Janela de impressão do navegador</option><option value="usb" ${sel(c.modo, 'usb')}>USB direta (ESC/POS)</option></select>
      <label>Imprimir ao finalizar venda (neste aparelho)</label><select name="auto"><option value="nao" ${sel(c.auto, 'nao')}>Não</option><option value="sim" ${sel(c.auto, 'sim')}>Sim</option></select><button>Salvar ajustes</button></form>
      <article class="item"><p>Para USB direta: conecte a impressora, toque em conectar e escolha-a. Requer Chrome/Edge.</p><button type="button" data-act="usbpair">Conectar impressora USB</button><button type="button" class="sec" data-act="teste">Imprimir teste</button></article>
      ${ehAdmin() ? '<h2>Seus dados</h2><article class="item"><p>Os dados ficam seguros na nuvem. Se quiser uma cópia, exporte abaixo.</p><button type="button" data-act="exportar">Exportar dados (JSON)</button></article>' : ''}`;
  },

  async assinatura() {
    const [ass, planos, faturas] = await Promise.all([
      q(supabase.from('empresa_assinaturas').select('*').eq('empresa_id', EMP()).maybeSingle()),
      q(supabase.from('planos').select('*').eq('ativo', true).order('preco_centavos')),
      q(supabase.from('faturas').select('*').eq('empresa_id', EMP()).order('created_at', { ascending: false }).limit(12))]);
    const st = { teste: 'Período de teste', ativa: 'Ativa', inadimplente: 'Pagamento em atraso', cancelada: 'Cancelada', expirada: 'Expirada' }[ass?.status] || '—';
    const lim = p => p.limites?.max_usuarios ? `até ${p.limites.max_usuarios} usuários` : '';
    return `<h2>Assinatura</h2><article class="item"><p>Situação: <strong>${esc(st)}</strong></p>
      ${ass?.status === 'teste' ? `<p>Teste termina em ${dt(ass.teste_fim)}</p>` : ''}${ass?.periodo_atual_fim ? `<p>Pago até ${dt(ass.periodo_atual_fim)}</p>` : ''}</article>
      <h2>Escolha o plano</h2><form data-form="assinar"><label>CPF ou CNPJ do responsável pela cobrança</label><input name="documento" inputmode="numeric" required placeholder="Somente números">
      ${planos.map((p, k) => `<article class="item"><label><input type="radio" name="plano" value="${esc(p.codigo)}" ${k === 0 ? 'checked' : ''}> <strong>${esc(p.nome)}</strong> — ${money(p.preco_centavos / 100)}/${esc(p.intervalo === 'mensal' ? 'mês' : p.intervalo)}</label><p>${esc(lim(p))}</p></article>`).join('')}
      <button ${planos.length ? '' : 'disabled'}>Assinar e pagar</button></form><div id="assLink"></div>
      <p>Pagamento por Pix, boleto ou cartão, na página segura do Asaas. A liberação é automática após a confirmação.</p>
      <button type="button" class="sec" data-act="atualizarass">Já paguei: atualizar status</button>
      <h2>Faturas</h2>` + (faturas.map(f => `<article class="item"><strong>${money(f.valor_centavos / 100)}</strong> — ${esc(f.status)}<p>${f.vencimento ? 'Vence ' + esc(f.vencimento) : ''}</p>${f.link_pagamento && f.status !== 'paga' ? `<a class="btn" href="${esc(f.link_pagamento)}" target="_blank" rel="noopener">Pagar</a>` : ''}</article>`).join('') || '<p>Nenhuma fatura ainda.</p>');
  }
};

async function crudView(tabela, titulo) {
  const [rows, contas] = await Promise.all([lista(tabela), tabela === 'clientes' ? q(supabase.from('contas_receber').select('cliente_id,valor,valor_pago').eq('status', 'aberta').limit(1000)) : []]);
  const dev = {}; for (const c of contas) dev[c.cliente_id] = (dev[c.cliente_id] || 0) + Number(c.valor) - Number(c.valor_pago);
  const e = editando || {}, t = busca.trim().toLowerCase();
  return `<h2>${titulo}</h2><form data-form="crud"><label>Nome</label><input name="nome" required value="${esc(e.nome)}"><label>Telefone</label><input name="telefone" value="${esc(e.telefone)}">
    <button>${editando ? 'Salvar alterações' : 'Cadastrar'}</button>${editando ? '<button type="button" class="sec" data-act="cancel">Cancelar</button>' : ''}</form>
    <input data-search placeholder="Pesquisar..." value="${esc(busca)}" style="margin-top:14px">` +
    (rows.filter(r => !t || r.nome.toLowerCase().includes(t) || String(r.telefone || '').includes(t)).slice(0, 150).map(r => `<article class="item"><strong>${esc(r.nome)}</strong><p>${esc(r.telefone || '')}</p>
      ${dev[r.id] > 0 ? `<p class="warn">Fiado em aberto: ${money(dev[r.id])}</p>` : ''}<button type="button" data-act="edit" data-id="${r.id}">Editar</button>${ehAdmin() ? `<button type="button" class="danger" data-act="del" data-id="${r.id}">Excluir</button>` : ''}</article>`).join('') || '<p>Nenhum registro.</p>');
}

const caixaAberto = () => q(supabase.from('caixa_sessoes').select('*').eq('status', 'aberto').eq('user_id', ctx.user.id).maybeSingle());

/* ---------- PDV (carrinho dinâmico, sem recriar o formulário) ---------- */
const totalCarrinho = () => r2(cart.reduce((t, i) => t + r2(i.quantidade * i.preco), 0));
function renderCart() {
  const box = $('#cartBox'); if (!box) return;
  box.innerHTML = cart.map((i, k) => `<article class="item"><strong>${esc(i.nome)}</strong> — ${qtdFmt(i.quantidade)} × ${money(i.preco)} = ${money(r2(i.quantidade * i.preco))}
    <button type="button" class="danger" data-act="rm" data-id="${k}">Remover</button></article>`).join('') || '<p>Nenhum item adicionado.</p>';
  totais();
}
function lerPag() {
  const f = $('#vendaForm'); const v = n => r2(num(f?.elements[n]?.value || 0) || 0);
  return { desconto: v('desconto'), pix: v('pix'), debito: v('debito'), credito: v('credito'), fiado: v('fiado') };
}
function totais() {
  const el = $('#pdvResumo'); if (!el) return;
  const p = lerPag(), bruto = totalCarrinho(), total = r2(bruto - p.desconto), outros = r2(p.pix + p.debito + p.credito + p.fiado), din = r2(total - outros);
  const rec = $('#vendaForm').elements.recebido.value, recN = rec === '' ? din : r2(num(rec));
  el.innerHTML = `Subtotal ${money(bruto)} · Total <strong>${money(total)}</strong><br>Dinheiro a receber: <strong>${money(Math.max(din, 0))}</strong>` +
    (din < 0 ? ' <span class="bad">Pagamentos excedem o total</span>' : '') + (din > 0 && recN >= din ? ` · Troco ${money(r2(recN - din))}` : '');
}
function addCart(p) {
  if (!p) throw new Error('Produto não encontrado.');
  const qtd = r3(num($('#pdvQty')?.value || 1));
  if (!(qtd > 0)) throw new Error('Quantidade inválida.');
  if (p.tipo_venda === 'unidade' && qtd !== Math.trunc(qtd)) throw new Error('Produto por unidade: use quantidade inteira.');
  const linha = cart.find(i => i.produto_id === p.id), novo = r3((linha?.quantidade || 0) + qtd);
  if (novo > Number(p.estoque)) throw new Error('Estoque insuficiente: ' + qtdFmt(p.estoque) + ' disponível (' + p.nome + ').');
  if (linha) linha.quantidade = novo; else cart.push({ produto_id: p.id, nome: p.nome, quantidade: qtd, preco: Number(p.preco_venda) });
  renderCart();
}
const achar = t => { t = t.trim().toLowerCase(); return t ? pdvProds.filter(p => p.nome.toLowerCase().includes(t) || String(p.codigo || '') === t) : []; };

/* ---------- formulários ---------- */
const FORMS = {
  async produto(f) {
    const nome = f.nome.trim(); if (!nome) throw new Error('Informe o nome.');
    const dados = { nome, codigo: f.codigo.trim() || null, categoria: f.categoria || null, tipo_venda: f.tipo_venda, preco_venda: r2(num(f.preco_venda)), preco_custo: r2(num(f.preco_custo || 0)), estoque_minimo: num(f.estoque_minimo || 0) };
    if (!(dados.preco_venda >= 0) || !(dados.preco_custo >= 0) || !(dados.estoque_minimo >= 0)) throw new Error('Confira os valores informados.');
    if (editando) { await q(supabase.from('produtos').update(dados).eq('id', editando.id)); editando = null; return 'Produto atualizado.'; }
    const ini = num(f.estoque || 0);
    if (!(ini >= 0)) throw new Error('Estoque inicial inválido.');
    if (dados.tipo_venda === 'unidade' && ini !== Math.trunc(ini)) throw new Error('Produto por unidade: estoque inteiro.');
    const novo = await q(supabase.from('produtos').insert({ ...dados, empresa_id: EMP(), estoque: 0 }).select('id').single());
    if (ini > 0) await q(supabase.rpc('movimentar_estoque', { p_produto_id: novo.id, p_tipo: 'entrada', p_quantidade: ini, p_observacao: 'Estoque inicial' }));
    return 'Produto cadastrado.';
  },
  async categoria(f) {
    const nome = f.nome.trim(); if (!nome) throw new Error('Informe o nome.');
    await q(supabase.from('categorias').insert({ empresa_id: EMP(), nome })); return 'Categoria adicionada.';
  },
  async estoque(f) {
    const qtd = num(f.qtd), id = Number(f.id); if (!(qtd >= 0) || (f.tipo !== 'ajuste' && !(qtd > 0))) throw new Error('Quantidade inválida.');
    if (f.tipo === 'ajuste') await q(supabase.rpc('ajustar_estoque', { p_produto_id: id, p_novo_estoque: qtd, p_observacao: f.motivo || 'Ajuste de inventário' }));
    else await q(supabase.rpc('movimentar_estoque', { p_produto_id: id, p_tipo: f.tipo, p_quantidade: qtd, p_observacao: f.motivo || null }));
    return 'Estoque atualizado.';
  },
  async crud(f) {
    const nome = f.nome.trim(); if (!nome) throw new Error('Informe o nome.');
    const d = { nome, telefone: f.telefone.trim() || null };
    if (editando) { await q(supabase.from(page).update(d).eq('id', editando.id)); editando = null; return 'Alterações salvas.'; }
    await q(supabase.from(page).insert({ ...d, empresa_id: EMP() })); return 'Cadastrado com sucesso.';
  },
  async itemc(f) {
    const p = (await q(supabase.from('produtos').select('id,nome,tipo_venda').eq('id', Number(f.id)).single())), qtd = r3(num(f.qtd)), preco = r2(num(f.preco));
    if (!(qtd > 0) || !(preco >= 0)) throw new Error('Quantidade ou custo inválido.');
    if (p.tipo_venda === 'unidade' && qtd !== Math.trunc(qtd)) throw new Error('Produto por unidade: use quantidade inteira.');
    cartC.push({ produto_id: p.id, nome: p.nome, quantidade: qtd, preco }); return 'Item adicionado.';
  },
  async compra(f) {
    if (!cartC.length) throw new Error('Adicione itens à compra.');
    const pago = f.pago === 'on';
    if (!pago && !f.venc) throw new Error('Informe o vencimento da compra não paga.');
    await q(supabase.rpc('registrar_compra', { p_fornecedor_id: f.fornecedor ? Number(f.fornecedor) : null, p_itens: cartC.map(i => ({ produto_id: i.produto_id, quantidade: i.quantidade, preco_unitario: i.preco })), p_pago: pago, p_vencimento: pago ? null : f.venc }));
    cartC = []; return 'Compra registrada e estoque atualizado.';
  },
  async venda(f) {
    if (!cart.length) throw new Error('Adicione produtos ao carrinho.');
    if (!(await caixaAberto())) throw new Error('Abra o caixa antes de vender.');
    const p = lerPag(), bruto = totalCarrinho(), total = r2(bruto - p.desconto), outros = r2(p.pix + p.debito + p.credito + p.fiado);
    if ([p.desconto, p.pix, p.debito, p.credito, p.fiado].some(x => x < 0)) throw new Error('Valores não podem ser negativos.');
    if (!(total > 0)) throw new Error('O total da venda deve ser maior que zero.');
    if (outros > total) throw new Error('Pix + cartões + fiado excedem o total da venda.');
    if (p.fiado > 0 && !f.cliente) throw new Error('Selecione o cliente para vender fiado.');
    if (p.fiado > 0 && !f.venc) throw new Error('Informe o vencimento do fiado.');
    const din = r2(total - outros), rec = f.recebido === '' ? din : r2(num(f.recebido));
    if (din > 0 && !(rec >= din)) throw new Error('Dinheiro recebido é menor que o valor em dinheiro.');
    const pagamentos = [['Dinheiro', din], ['Pix', p.pix], ['Cartão de débito', p.debito], ['Cartão de crédito', p.credito], ['Fiado', p.fiado]].filter(x => x[1] > 0).map(([forma, valor]) => ({ forma, valor }));
    const id = await q(supabase.rpc('finalizar_venda_v2', { p_itens: cart.map(i => ({ produto_id: i.produto_id, quantidade: i.quantidade })), p_pagamentos: pagamentos, p_cliente_id: f.cliente ? Number(f.cliente) : null, p_desconto: p.desconto, p_vencimento: p.fiado > 0 ? f.venc : null }));
    const troco = din > 0 ? r2(rec - din) : 0;
    const cupom = { id, data: new Date().toISOString(), itens: cart.map(i => ({ nome: i.nome, quantidade: i.quantidade, preco: i.preco, subtotal: r2(i.quantidade * i.preco) })), subtotal: bruto, desconto: p.desconto, total, pagamentos, troco, cliente: '' };
    cart = [];
    cfg().then(c => c.auto === 'sim' && imprimir(cupom)).catch(e => say(erro(e), true));
    return `Venda #${id} finalizada.` + (troco > 0 ? ' Troco: ' + money(troco) : '');
  },
  async abrircx(f) { await q(supabase.rpc('abrir_caixa', { p_fundo_inicial: r2(num(f.v || 0)) })); return 'Caixa aberto.'; },
  async movcx(f) { await q(supabase.rpc('registrar_movimento_caixa', { p_tipo: f.tipo, p_valor: r2(num(f.v)), p_motivo: f.motivo || null })); return 'Movimento registrado.'; },
  async fecharcx(f) {
    const contado = r2(num(f.v)); if (!(contado >= 0)) throw new Error('Informe o valor contado.');
    if (!confirm('Fechar o caixa agora?')) return '';
    const r = await q(supabase.rpc('fechar_caixa_v2'));
    const esperado = Number(r?.esperado ?? 0), dif = r2(contado - esperado);
    let aviso = '';
    try { await q(supabase.rpc('gravar_contagem_caixa', { p_valor_contado: contado })); }
    catch (e) { aviso = ' ATENÇÃO: o valor contado NÃO foi gravado (' + erro(e) + '). Anote: contado ' + money(contado) + '.'; }
    return `Caixa fechado. Esperado ${money(esperado)} · Contado ${money(contado)} · Diferença ${money(dif)}.` + aviso;
  },
  async despesa(f) {
    const valor = r2(num(f.valor)); if (!(valor > 0) || !f.descricao.trim()) throw new Error('Informe descrição e valor válidos.');
    const paga = f.paga === 'on';
    await q(supabase.from('despesas').insert({ empresa_id: EMP(), descricao: f.descricao.trim(), categoria: f.categoria.trim() || 'Outros', valor, vencimento: f.venc || null, status: paga ? 'paga' : 'aberta', pago_em: paga ? new Date().toISOString() : null }));
    return 'Despesa registrada.';
  },
  async convite(f) {
    const r = await q(supabase.rpc('criar_convite', { p_email: f.email, p_papel: f.papel }));
    const link = location.origin + location.pathname + '?convite=' + r.token;
    window.__convite = link; return 'Convite criado. Copie o link e envie ao convidado.';
  },
  async ajustes(f) {
    if (ehAdmin()) await q(supabase.rpc('salvar_configuracoes', { p_nome: f.nome, p_linha2: f.linha2, p_largura: Number(f.largura) }));
    localStorage.setItem(lsKey(), JSON.stringify({ modo: f.modo, auto: f.auto })); return 'Ajustes salvos.';
  },
  async assinar(f) {
    const { data, error } = await supabase.functions.invoke('asaas-assinar', { body: { documento: f.documento, plano_codigo: f.plano } });
    if (error) { let m = error.message; try { const j = await error.context.json(); m = j.erro || m; } catch (_) { /* usa a mensagem padrão */ } throw new Error(m); }
    if (data?.erro) throw new Error(data.erro);
    window.__assLink = data?.link || null;
    return data?.link ? 'Assinatura criada! Abra o link de pagamento abaixo.' : 'Assinatura criada. A fatura aparecerá em instantes na lista abaixo.';
  }
};

const view = $('#view');
view.addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target, fn = FORMS[form.dataset.form]; if (!fn) return;
  const btn = form.querySelector('button:not([type=button])'); if (btn) btn.disabled = true;
  try {
    const m = await lock(() => fn(Object.fromEntries(new FormData(form))));
    await render(); if (m) say(m);
    if (form.dataset.form === 'convite' && window.__convite) mostrarLink('#conviteLink', window.__convite, 'Link do convite (válido por 7 dias)');
    if (form.dataset.form === 'assinar' && window.__assLink) mostrarLink('#assLink', window.__assLink, 'Pagar assinatura', true);
  } catch (err) { say(erro(err), true); if (btn) btn.disabled = false; }
});
function mostrarLink(sel, url, rotulo, abrir) {
  const el = $(sel); if (!el) return;
  el.innerHTML = abrir ? `<a class="btn" target="_blank" rel="noopener" href="${esc(url)}">${esc(rotulo)}</a>` : `<p class="good"><strong>${esc(rotulo)}</strong><br><input readonly value="${esc(url)}"></p>`;
  const i = el.querySelector('input'); if (i) i.addEventListener('focus', () => i.select());
}

view.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id, act = b.dataset.act;
  try {
    let m = '', refresh = true;
    if (act === 'cancel') editando = null;
    else if (act === 'edit') editando = (await q(supabase.from(page).select('*').eq('id', Number(id)).single()));
    else if (act === 'rm') { cart.splice(Number(id), 1); renderCart(); refresh = false; }
    else if (act === 'rmc') cartC.splice(Number(id), 1);
    else if (act === 'add') { addCart(pdvProds.find(p => String(p.id) === id)); refresh = false; $('[data-pdv]')?.focus(); }
    else if (act === 'del') {
      if (!confirm('Deseja excluir este registro?')) return;
      await lock(() => q(supabase.from(page).delete().eq('id', Number(id)))); m = 'Registro excluído.';
    } else if (act === 'rencat') {
      const nome = (prompt('Novo nome da categoria:') || '').trim(); if (!nome) return;
      const cat = await q(supabase.from('categorias').select('*').eq('id', Number(id)).single());
      await lock(async () => { await q(supabase.from('categorias').update({ nome }).eq('id', cat.id)); await q(supabase.from('produtos').update({ categoria: nome }).eq('categoria', cat.nome)); });
      m = 'Categoria renomeada.';
    } else if (act === 'delcat') { if (!confirm('Excluir esta categoria?')) return; await lock(() => q(supabase.from('categorias').delete().eq('id', Number(id)))); m = 'Categoria excluída.'; }
    else if (act === 'cancelv') { if (!confirm('Cancelar esta venda e devolver os itens ao estoque?')) return; await lock(() => q(supabase.rpc('cancelar_venda', { p_venda_id: Number(id) }))); m = 'Venda cancelada.'; }
    else if (act === 'cancelc') { if (!confirm('Cancelar esta compra e retirar os itens do estoque?')) return; await lock(() => q(supabase.rpc('cancelar_compra', { p_compra_id: Number(id) }))); m = 'Compra cancelada.'; }
    else if (act === 'cupom') {
      const v = await q(supabase.from('vendas').select('id,total,desconto,forma_pagamento,created_at,venda_detalhes(status,clientes(nome)),venda_pagamentos(forma,valor),itens_venda(quantidade,preco_unitario,subtotal,produtos(nome))').eq('id', Number(id)).single());
      await imprimir(vendaParaCupom(v)); m = 'Cupom enviado.'; refresh = false;
    } else if (act === 'pagar') { await lock(() => q(supabase.from('despesas').update({ status: 'paga', pago_em: new Date().toISOString() }).eq('id', Number(id)))); m = 'Despesa marcada como paga.'; }
    else if (act === 'deldesp') { if (!confirm('Excluir esta despesa?')) return; await lock(() => q(supabase.from('despesas').delete().eq('id', Number(id)))); m = 'Despesa excluída.'; }
    else if (act === 'receber') {
      const v = r2(num(view.querySelector(`[data-rec="${id}"]`)?.value));
      if (!(v > 0)) throw new Error('Informe um valor válido.');
      await lock(() => q(supabase.rpc('receber_pagamento', { p_conta_id: Number(id), p_valor: v }))); m = 'Recebimento registrado.';
    } else if (act === 'papel') { const novo = view.querySelector(`[data-papel="${id}"]`).value; await lock(() => q(supabase.rpc('alterar_papel_membro', { p_user_id: id, p_papel: novo }))); m = 'Papel alterado.'; }
    else if (act === 'rmmembro') { if (!confirm('Remover este usuário da empresa?')) return; await lock(() => q(supabase.rpc('remover_membro', { p_user_id: id }))); m = 'Usuário removido.'; }
    else if (act === 'cancelconv') { await lock(() => q(supabase.rpc('cancelar_convite', { p_convite_id: id }))); m = 'Convite cancelado.'; }
    else if (act === 'usbpair') { const d = await usbDev(true); m = 'Impressora conectada: ' + (d.productName || 'USB'); refresh = false; }
    else if (act === 'teste') { await imprimir({ data: new Date().toISOString(), itens: [{ nome: 'Item de teste', quantidade: 1, preco: 1, subtotal: 1 }], subtotal: 1, desconto: 0, total: 1, pagamentos: [{ forma: 'Dinheiro', valor: 1 }], troco: 0 }); m = 'Teste enviado.'; refresh = false; }
    else if (act === 'exportar') { await exportar(); m = 'Arquivo gerado.'; refresh = false; }
    else if (act === 'atualizarass') { await recarregarConta(); desenharBanner(); desenharNav(); m = temAcesso() ? 'Status atualizado.' : 'Pagamento ainda não confirmado. Tente de novo em instantes.'; }
    if (refresh) await render();
    if (m) say(m);
  } catch (err) { say(erro(err), true); }
});

view.addEventListener('change', e => { if (e.target.matches('[data-rel]') && e.target.value) { relDia = e.target.value; render(); } });
view.addEventListener('input', async e => {
  const t = e.target;
  if (t.matches('[data-search]')) { busca = t.value; await render(); const s = $('[data-search]'); if (s) { s.focus(); s.setSelectionRange(busca.length, busca.length); } }
  else if (t.matches('[data-pdv]')) $('#pdvResults').innerHTML = achar(t.value).slice(0, 8).map(p => `<article class="item"><strong>${esc(p.nome)}</strong> — ${money(p.preco_venda)} · estoque ${qtdFmt(p.estoque)}<button type="button" data-act="add" data-id="${p.id}">Adicionar</button></article>`).join('');
  else if (t.matches('[data-calc]')) totais();
});
view.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches('[data-pdv]')) return;
  e.preventDefault();
  try {
    const t = e.target.value.trim(), r = achar(t), p = (t && pdvProds.find(x => String(x.codigo || '') === t)) || (r.length === 1 ? r[0] : null);
    if (!p) throw new Error(r.length ? 'Vários produtos encontrados: escolha na lista.' : 'Produto não encontrado.');
    addCart(p); e.target.value = ''; $('#pdvResults').innerHTML = '';
  } catch (err) { say(erro(err), true); }
});

async function exportar() {
  const out = { app: 'gestor-pro-painel', empresa: ctx.empresa.nome, exportadoEm: new Date().toISOString(), tabelas: {} };
  for (const t of ['produtos', 'categorias', 'clientes', 'fornecedores', 'vendas', 'venda_detalhes', 'venda_pagamentos', 'itens_venda', 'compras', 'itens_compra', 'despesas', 'contas_receber', 'movimentacoes_estoque', 'caixa_sessoes', 'caixa_movimentos', 'configuracoes_empresa', 'empresa_assinaturas', 'faturas', 'planos']) { out.tabelas[t] = await q(supabase.from(t).select('*').limit(10000)); if (out.tabelas[t].length >= 10000) (out.avisos ||= []).push('Tabela ' + t + ' atingiu o limite de 10000 linhas; exportação possivelmente incompleta.'); }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = 'gestor-pro-painel-dados-' + hoje() + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function render(carregando) {
  if (carregando) view.innerHTML = '<p>Carregando...</p>';
  try {
    if (!temAcesso() && page !== 'assinatura') page = 'assinatura';
    if (!temAcesso() && !ehAdmin()) { view.innerHTML = '<h2>Acesso suspenso</h2><p>Peça ao dono da empresa para regularizar a assinatura.</p>'; return; }
    view.innerHTML = await VIEWS[page]();
    if (page === 'vender') renderCart();
  } catch (err) { view.innerHTML = '<p class="warn">' + esc(erro(err)) + '</p>'; }
}

desenharBanner();
await ir(temAcesso() ? 'vender' : 'assinatura');
