// Gestor Pro Painel — supa.js: conexão com o Supabase e autenticação.
// A chave abaixo é a chave PÚBLICA (publishable); é seguro ficar no site.
// NUNCA coloque aqui a service_role nem a chave do Asaas.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export const SUPABASE_URL = 'https://nopxuyscsiqmtnnexttw.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_ldAxzoQ6fPDs1pgBqfgiLQ_DAoecerD';
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

export const ctx = { user: null, conta: null, empresa: null };

const $ = s => document.querySelector(s);
const msg = (t, err) => { const m = $('#loginMsg'); m.textContent = t || ''; m.className = err ? 'err' : ''; };
const traduz = e => {
  const t = String(e?.message || e || '');
  if (/Invalid login/i.test(t)) return 'E-mail ou senha incorretos.';
  if (/Email not confirmed/i.test(t)) return 'Confirme seu e-mail pelo link que enviamos e tente de novo.';
  if (/already registered/i.test(t)) return 'Este e-mail já tem cadastro. Use "Entrar".';
  if (/at least|weak|password/i.test(t) && !/Invalid login/i.test(t)) return 'Senha fraca: use pelo menos 8 caracteres.';
  if (/rate limit/i.test(t)) return 'Muitas tentativas. Aguarde um minuto.';
  if (/fetch|network/i.test(t)) return 'Sem conexão com a internet.';
  return t || 'Não foi possível concluir.';
};

const TOKEN_KEY = 'gp_convite';
const params = new URLSearchParams(location.search);
if (params.get('convite')) {
  try { localStorage.setItem(TOKEN_KEY, params.get('convite')); } catch (_) { /* sem storage */ }
  history.replaceState(null, '', location.pathname);
}

let resolver; let resolvido = false;
const pronto = new Promise(r => (resolver = r));
let recuperando = /type=recovery/.test(location.hash);

async function carregarConta() {
  const { data, error } = await supabase.rpc('minha_conta');
  if (error) throw error;
  return data;
}

function escolherEmpresa(conta) {
  const list = conta.empresas || [];
  return list.find(e => e.empresa_id === conta.empresa_atual) || list[0] || null;
}

export async function recarregarConta() {
  ctx.conta = await carregarConta();
  ctx.empresa = escolherEmpresa(ctx.conta);
  return ctx;
}

async function aposLogin(user) {
  let conta = await carregarConta();

  const token = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; } })();
  if (token) {
    const { error } = await supabase.rpc('aceitar_convite', { p_token: token });
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* ok */ }
    if (error) msg(traduz(error), true);
    else conta = await carregarConta();
  }

  if (!conta?.empresas?.length) {
    const nome = $('#loginEmpresa').value.trim();
    if (!nome) { msg('Informe o nome da empresa (campo abaixo) e clique em "Entrar".', true); return false; }
    const { error } = await supabase.rpc('cadastrar_empresa', { p_nome: nome });
    if (error) throw error;
    conta = await carregarConta();
  }

  let emp = escolherEmpresa(conta);
  if (emp && conta.empresa_atual !== emp.empresa_id) {
    await supabase.rpc('definir_empresa_atual', { p_empresa: emp.empresa_id });
  }
  Object.assign(ctx, { user, conta, empresa: emp });

  $('#empresaNome').textContent = emp?.nome || 'Gestão comercial online';
  const box = $('#userBox'); box.innerHTML = '';
  const s = document.createElement('span');
  s.textContent = user.email || '';
  box.append(s);
  if (conta.empresas.length > 1) {
    const sel = document.createElement('select');
    for (const e of conta.empresas) sel.add(new Option(e.nome, e.empresa_id, false, e.empresa_id === emp.empresa_id));
    sel.onchange = async () => { await supabase.rpc('definir_empresa_atual', { p_empresa: sel.value }); location.reload(); };
    box.append(sel);
  }
  const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Sair';
  b.onclick = async () => { await supabase.auth.signOut(); location.reload(); };
  box.append(b);

  $('#loginOverlay').hidden = true;
  document.body.classList.remove('locked');
  if (!resolvido) { resolvido = true; resolver(ctx); }
  return true;
}

async function entrar(criar) {
  const email = $('#loginEmail').value.trim(), senha = $('#loginSenha').value;
  if (!email || senha.length < 8) return msg('Informe o e-mail e uma senha de pelo menos 8 caracteres.', true);
  msg('Aguarde...');
  try {
    if (criar) {
      const { data, error } = await supabase.auth.signUp({ email, password: senha, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) return msg('Cadastro criado. Confirme o e-mail pelo link enviado e depois clique em "Entrar".');
      return void (await aposLogin(data.user));
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: senha });
    if (error) throw error;
    await aposLogin(data.user);
  } catch (e) { msg(traduz(e), true); }
}

async function recuperar() {
  const email = $('#loginEmail').value.trim();
  if (!email) return msg('Digite seu e-mail acima e clique de novo.', true);
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  msg(error ? traduz(error) : 'Enviamos um link para redefinir a senha no seu e-mail.', !!error);
}

function mostrarRecuperacao() {
  recuperando = true;
  $('#loginForm').hidden = true; $('#recForm').hidden = false; $('#loginOverlay').hidden = false;
}

async function salvarNovaSenha() {
  const senha = $('#recSenha').value, m = $('#recMsg');
  if (senha.length < 8) { m.textContent = 'Use pelo menos 8 caracteres.'; m.className = 'err'; return; }
  const { data, error } = await supabase.auth.updateUser({ password: senha });
  if (error) { m.textContent = traduz(error); m.className = 'err'; return; }
  history.replaceState(null, '', location.pathname);
  recuperando = false;
  $('#recForm').hidden = true; $('#loginForm').hidden = false;
  try { if (!(await aposLogin(data.user))) $('#loginOverlay').hidden = false; } catch (e) { msg(traduz(e), true); $('#loginOverlay').hidden = false; }
}

export function autenticar() {
  $('#btnEntrar').onclick = () => entrar(false);
  $('#btnCriar').onclick = () => entrar(true);
  $('#btnRecuperar').onclick = recuperar;
  $('#btnNovaSenha').onclick = salvarNovaSenha;
  $('#loginForm').addEventListener('submit', e => { e.preventDefault(); entrar(false); });
  $('#recForm').addEventListener('submit', e => { e.preventDefault(); salvarNovaSenha(); });
  supabase.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') mostrarRecuperacao(); });

  (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      if (recuperando) return mostrarRecuperacao();
      if (data.session) { if (!(await aposLogin(data.session.user))) $('#loginOverlay').hidden = false; }
      else $('#loginOverlay').hidden = false;
    } catch (e) { $('#loginOverlay').hidden = false; msg(traduz(e), true); }
  })();
  return pronto;
}
