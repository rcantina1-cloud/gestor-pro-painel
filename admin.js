// Gestor Pro Painel — painel do proprietário da plataforma. Usa só a chave pública; toda a segurança está nas funções admin_* do banco.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './supa.js';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'gp-admin-auth' } });
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dt = s => (s ? new Date(s).toLocaleDateString('pt-BR') : '—');
const money = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
let clientes = [], filtro = 'todos';

function situacao(c) {
  const agora = Date.now(), tf = c.teste_fim && new Date(c.teste_fim), pf = c.periodo_atual_fim && new Date(c.periodo_atual_fim);
  if ((c.ultima_acao_admin === 'bloquear' || /bloque|suspens|cancel/i.test(c.status || '')) && !(pf > agora)) return ['bloq', 'Bloqueado'];
  if (pf && pf > agora && c.status !== 'teste') return ['pago', 'Pago até ' + dt(pf)];
  if (c.status === 'teste' && tf && tf > agora) return ['teste', 'Em teste — ' + Math.max(0, Math.ceil((tf - agora) / 864e5)) + ' dia(s)'];
  if (Number(c.faturas_pendentes) > 0 || c.status === 'inadimplente') return ['pend', 'Pagamento pendente'];
  if (c.status === 'teste') return ['fim', 'Teste encerrado'];
  return ['bloq', 'Sem acesso (' + esc(c.status) + ')'];
}
const rpc = async (n, a) => { const { data, error } = await sb.rpc(n, a); if (error) throw new Error(error.message); return data; };

function desenhar() {
  const todos = clientes.map(c => ({ c, s: situacao(c) })), cont = k => todos.filter(x => x.s[0] === k).length;
  const C = [['todos', 'Todos', todos.length], ['teste', 'Em teste', cont('teste')], ['pago', 'Pagos', cont('pago')], ['pend', 'Pendentes', cont('pend')], ['bloq', 'Bloqueados', cont('bloq')], ['fim', 'Teste encerrado', cont('fim')]];
  $('#cards').innerHTML = C.map(([k, n, v]) => `<button type="button" class="${filtro === k ? '' : 'sec'}" data-f="${k}"><b>${v}</b>${n}</button>`).join('');
  const b = $('#busca').value.trim().toLowerCase();
  const vis = todos.filter(x => (filtro === 'todos' || x.s[0] === filtro) && (!b || ((x.c.nome ?? '') + ' ' + (x.c.email_dono ?? '')).toLowerCase().includes(b)));
  $('#lista').innerHTML = vis.map(({ c, s }) => `<article class="item" data-e="${esc(c.empresa_id)}"><strong>${esc(c.nome || 'Empresa ' + String(c.empresa_id).slice(0, 8))}</strong> <span class="tag t-${s[0]}">${s[1]}</span>
    <p>${esc(c.email_dono || 'e-mail não localizado')}</p>
    <p>Teste termina: ${dt(c.teste_fim)} · Pago até: ${dt(c.periodo_atual_fim)} · Último pagamento: ${dt(c.ultimo_pagamento)} · Faturas: ${c.faturas_pagas} paga(s), ${c.faturas_pendentes} pendente(s)</p>
    <div class="acts"><button type="button" data-a="liberar">Liberar 30 dias</button><button type="button" data-a="reativar" class="sec">Reativar</button><button type="button" data-a="bloquear" class="danger">Bloquear</button><button type="button" data-a="faturas" class="sec">Faturas</button></div><div class="fat"></div></article>`).join('') || '<p>Nenhum cliente neste filtro.</p>';
}
async function carregar() {
  $('#lista').innerHTML = '<p>Carregando...</p>';
  try { clientes = await rpc('admin_listar_clientes'); desenhar(); } catch (e) { $('#lista').innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
}
async function iniciar(user) {
  if (!(await rpc('admin_sou_admin').catch(() => false))) { await sb.auth.signOut(); throw new Error('Esta conta não é administradora da plataforma.'); }
  $('#login').hidden = true; $('#app').hidden = false; $('#quem').textContent = user.email; await carregar();
}
$('#f').addEventListener('submit', async e => {
  e.preventDefault(); const m = $('#msg'); m.textContent = ''; $('#go').disabled = true;
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#se').value });
    if (error) throw new Error(/Invalid login/i.test(error.message) ? 'E-mail ou senha incorretos.' : error.message);
    await iniciar(data.user);
  } catch (err) { m.className = 'err'; m.textContent = err.message; } finally { $('#go').disabled = false; }
});
$('#sair').onclick = async () => { await sb.auth.signOut(); location.reload(); };
$('#atualizar').onclick = carregar; $('#busca').oninput = desenhar;
$('#cards').onclick = e => { const b = e.target.closest('[data-f]'); if (b) { filtro = b.dataset.f; desenhar(); } };
$('#lista').onclick = async e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const art = b.closest('[data-e]'), emp = art.dataset.e, a = b.dataset.a, box = art.querySelector('.fat');
  try {
    if (a === 'faturas') {
      const f = await rpc('admin_listar_faturas', { p_empresa: emp });
      box.innerHTML = f.length ? f.map(x => `<p>${dt(x.created_at)} — <strong>${money(x.valor_centavos)}</strong> — ${esc(x.status)}${x.vencimento ? ' · vence ' + esc(x.vencimento) : ''}${x.link_pagamento && x.status !== 'paga' ? ` · <a href="${esc(x.link_pagamento)}" target="_blank" rel="noopener">link Asaas</a>` : ''}</p>`).join('') : '<p>Sem faturas.</p>';
      return;
    }
    const txt = { liberar: 'Liberar 30 dias de acesso', reativar: 'Reativar (30 dias)', bloquear: 'BLOQUEAR o acesso' }[a];
    if (!confirm(txt + ' para este cliente?')) return;
    const motivo = prompt('Motivo (opcional):') || null; b.disabled = true;
    await rpc('admin_definir_acesso', { p_empresa: emp, p_acao: a, p_dias: 30, p_motivo: motivo });
    await carregar();
  } catch (err) { alert(err.message); b.disabled = false; }
};
sb.auth.getSession().then(async ({ data }) => { if (data.session) { try { await iniciar(data.session.user); } catch (e) { $('#msg').textContent = e.message; } } });
