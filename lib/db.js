/**
 * Conexão com o MySQL e migrações do esquema.
 * Compatível com MySQL 8 e MariaDB 10.6+.
 */
const mysql = require('mysql2/promise');

function createPool() {
  const url = process.env.DATABASE_URL;
  const base = url
    ? { uri: url }
    : {
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USERNAME || 'uvoz',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_DATABASE || 'uvoz',
      };
  return mysql.createPool({
    ...base,
    connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    waitForConnections: true,
    enableKeepAlive: true,
  });
}

// Cada migração roda uma única vez, em ordem. Nunca altere uma já publicada: crie outra.
const MIGRATIONS = [
  {
    id: 1,
    name: 'esquema inicial',
    sql: [
      `CREATE TABLE IF NOT EXISTS users (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(32) NOT NULL,
        display_name VARCHAR(40) NOT NULL,
        color VARCHAR(9) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        read_floor_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        created_at BIGINT UNSIGNED NOT NULL,
        last_seen_at BIGINT UNSIGNED NULL,
        UNIQUE KEY users_username_unique (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        expires_at BIGINT UNSIGNED NOT NULL,
        user_agent VARCHAR(255) NULL,
        KEY sessions_user_id (user_id),
        CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS channels (
        id VARCHAR(48) NOT NULL PRIMARY KEY,
        name VARCHAR(40) NOT NULL,
        type VARCHAR(8) NOT NULL,
        topic VARCHAR(120) NULL,
        position INT NOT NULL DEFAULT 0,
        created_by INT UNSIGNED NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        CONSTRAINT channels_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS dm_conversations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_low INT UNSIGNED NOT NULL,
        user_high INT UNSIGNED NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        last_message_at BIGINT UNSIGNED NULL,
        UNIQUE KEY dm_pair_unique (user_low, user_high),
        KEY dm_user_high (user_high),
        CONSTRAINT dm_low_fk FOREIGN KEY (user_low) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT dm_high_fk FOREIGN KEY (user_high) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS messages (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        channel_id VARCHAR(48) NULL,
        dm_id INT UNSIGNED NULL,
        author_id INT UNSIGNED NULL,
        author_name VARCHAR(40) NULL,
        author_color VARCHAR(9) NULL,
        body TEXT NOT NULL,
        mentions_everyone TINYINT(1) NOT NULL DEFAULT 0,
        created_at BIGINT UNSIGNED NOT NULL,
        edited_at BIGINT UNSIGNED NULL,
        KEY messages_channel (channel_id, id),
        KEY messages_dm (dm_id, id),
        KEY messages_author (author_id),
        CONSTRAINT messages_channel_fk FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE,
        CONSTRAINT messages_dm_fk FOREIGN KEY (dm_id) REFERENCES dm_conversations (id) ON DELETE CASCADE,
        CONSTRAINT messages_author_fk FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS message_mentions (
        message_id BIGINT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        PRIMARY KEY (message_id, user_id),
        KEY mentions_user (user_id, message_id),
        CONSTRAINT mentions_message_fk FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
        CONSTRAINT mentions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS read_states (
        user_id INT UNSIGNED NOT NULL,
        scope VARCHAR(64) NOT NULL,
        last_read_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, scope),
        CONSTRAINT read_states_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
];

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INT UNSIGNED NOT NULL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    applied_at BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [rows] = await pool.query('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    for (const statement of m.sql) await pool.query(statement);
    await pool.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, Date.now()]);
    console.log(`[uvoz] migração ${m.id} aplicada: ${m.name}`);
  }
}

module.exports = { createPool, migrate };
