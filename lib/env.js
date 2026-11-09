/**
 * Carrega um arquivo .env (se existir) sem sobrescrever variáveis já definidas.
 * Na Forge, o .env editado no painel fica na raiz do site e é ligado a cada release.
 */
const fs = require('fs');
const path = require('path');

function loadDotEnv(baseDir) {
  for (const file of [path.join(process.cwd(), '.env'), path.join(baseDir, '.env')]) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let value = m[2];
      const quoted = value.match(/^(['"])(.*?)\1/);
      value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
      process.env[m[1]] = value;
    }
    return file;
  }
  return null;
}

module.exports = { loadDotEnv };
