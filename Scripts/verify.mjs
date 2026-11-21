// Gestor Pro Painel é um site estático. Este passo confere se os arquivos essenciais
// existem e têm sintaxe válida. É chamado por scripts/build.mjs (que gera a dist).
// Não altera nenhum arquivo.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const obrigatorios = [
  'index.html', 'app.js', 'supa.js', 'styles.css',
  'manifest.webmanifest', 'sw.js', 'admin.html', 'admin.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'netlify.toml'
];
const faltando = obrigatorios.filter(f => !existsSync(f));
if (faltando.length) {
  console.error('Arquivos ausentes:', faltando.join(', '));
  process.exit(1);
}

JSON.parse(readFileSync('manifest.webmanifest', 'utf8'));
for (const f of ['app.js', 'supa.js', 'sw.js', 'admin.js']) {
  execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
}

// Nome do sistema: GESTOR PRO PAINEL (apresentação, PWA e pacote)
const NOME = 'Gestor Pro Painel';
const man = JSON.parse(readFileSync('manifest.webmanifest', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const erros = [];
if (man.name !== NOME) erros.push('manifest.webmanifest: name deve ser "' + NOME + '"');
if (man.short_name !== NOME) erros.push('manifest.webmanifest: short_name deve ser "' + NOME + '"');
if (pkg.name !== 'gestor-pro-painel') erros.push('package.json: name deve ser "gestor-pro-painel"');
for (const f of ['index.html', 'admin.html']) {
  const t = readFileSync(f, 'utf8');
  if (!new RegExp('<title>[^<]*' + NOME).test(t)) erros.push(f + ': <title> sem "' + NOME + '"');
}
// Nenhuma ocorrência do nome antigo (sem "Painel") em nenhum arquivo de texto do projeto
const antigo = new RegExp('gestor[ _-]?pro(?![ _-]?painel)', 'i');
const ignorar = new Set(['dist', 'node_modules', '.git', 'icons']);
const texto = /\.(html|js|mjs|css|json|webmanifest|toml|txt|sql|md)$|^\.gitignore$/;
const varrer = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const c = d === '.' ? e.name : d + '/' + e.name;
    if (e.isDirectory()) { if (!ignorar.has(e.name)) varrer(c); }
    else if (texto.test(e.name) && antigo.test(readFileSync(c, 'utf8'))) erros.push(c + ': nome antigo encontrado');
  }
};
varrer('.');
if (erros.length) { console.error('Nome do sistema inconsistente:\n - ' + erros.join('\n - ')); process.exit(1); }
console.log('Gestor Pro Painel: arquivos conferidos. Origem OK.');
