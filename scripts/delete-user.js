#!/usr/bin/env node
/**
 * Remove uma conta. As mensagens dela ficam como "Usuário removido",
 * a menos que se passe --apagar-mensagens.
 * Uso (na pasta do site): node scripts/delete-user.js <usuario> [--apagar-mensagens]
 */
const path = require('path');
const { loadDotEnv } = require('../lib/env');
loadDotEnv(path.join(__dirname, '..'));
const { createPool } = require('../lib/db');

(async () => {
  const args = process.argv.slice(2);
  const username = args.find((a) => !a.startsWith('--'));
  const purge = args.includes('--apagar-mensagens');
  if (!username) {
    console.error('Uso: node scripts/delete-user.js <usuario> [--apagar-mensagens]');
    process.exit(1);
  }
  const pool = createPool();
  const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [username.toLowerCase()]);
  if (!rows.length) { console.error(`Usuário "${username}" não encontrado.`); process.exit(1); }
  const id = rows[0].id;
  if (purge) {
    const [r] = await pool.query('DELETE FROM messages WHERE author_id = ?', [id]);
    console.log(`${r.affectedRows} mensagens apagadas.`);
  }
  await pool.query('DELETE FROM users WHERE id = ?', [id]); // sessões, DMs e leituras saem em cascata
  console.log(`Conta "${username}" removida. Reinicie o processo do UVoz para atualizar a lista de membros.`);
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
