#!/usr/bin/env node
/**
 * Redefine a senha de um usuário e encerra as sessões dele.
 * Uso (na pasta do site): node scripts/reset-password.js <usuario> <nova-senha>
 * Na Forge: aba "Commands" do site, com o diretório "current".
 */
const path = require('path');
const { loadDotEnv } = require('../lib/env');
loadDotEnv(path.join(__dirname, '..'));
const { createPool } = require('../lib/db');
const { hashPassword } = require('../lib/auth');

(async () => {
  const [username, password] = process.argv.slice(2);
  if (!username || !password || password.length < 8) {
    console.error('Uso: node scripts/reset-password.js <usuario> <nova-senha (mín. 8 caracteres)>');
    process.exit(1);
  }
  const pool = createPool();
  const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [username.toLowerCase()]);
  if (!rows.length) { console.error(`Usuário "${username}" não encontrado.`); process.exit(1); }
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), rows[0].id]);
  await pool.query('DELETE FROM sessions WHERE user_id = ?', [rows[0].id]);
  console.log(`Senha de "${username}" redefinida. Sessões antigas encerradas.`);
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
