/**
 * UVoz — servidor de comunicação interna da Unicopag.
 *
 * - Express serve o front-end (pasta /public) e a API de contas (/api/*).
 * - MySQL guarda usuários, sessões, canais, mensagens, DMs, menções e leitura.
 * - Socket.io cuida de presença, mensagens em tempo real e sinalização WebRTC.
 * - Áudio, vídeo e tela trafegam P2P entre os navegadores (com TURN quando preciso).
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const { loadDotEnv } = require('./lib/env');
loadDotEnv(__dirname);

const { createPool, migrate } = require('./lib/db');
const { Store, scopeKey } = require('./lib/store');
const auth = require('./lib/auth');

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // em produção atrás do Nginx: 127.0.0.1
const ACCESS_CODE = process.env.ACCESS_CODE || ''; // exigido para criar conta (vazio = livre)
const LEGACY_DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS_PER_ROOM) || 8;
const MAX_MESSAGE_LENGTH = 4000;
const RESERVED_USERNAMES = new Set(['todos', 'everyone', 'here', 'aqui', 'admin', 'sistema', 'uvoz']);

function parseIceServers() {
  const fallback = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (!process.env.ICE_SERVERS) return fallback;
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (err) {
    console.warn('[uvoz] ICE_SERVERS inválido, usando STUN padrão:', err.message);
  }
  return fallback;
}
const ICE_SERVERS = parseIceServers();

// TURN com credenciais temporárias (coturn com use-auth-secret / static-auth-secret).
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS) || 12 * 3600;

function iceServersFor(id) {
  if (!TURN_SECRET || !TURN_URLS.length) return ICE_SERVERS;
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS}:${id}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [...ICE_SERVERS, { urls: TURN_URLS, username, credential }];
}

function sanitizeText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function slugify(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'canal';
}

// ---------------------------------------------------------------------------
// Infra
// ---------------------------------------------------------------------------
const pool = createPool();
const store = new Store(pool);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

/** socketId -> { socketId, userId, channelId, media } */
const voiceStates = new Map();
/** userId -> Set(socketId) */
const userSockets = new Map();

const isOnline = (userId) => (userSockets.get(userId)?.size || 0) > 0;
const emptyMedia = () => ({ mic: false, cam: false, screen: false, cameraStreamId: null, screenStreamId: null });

// ---------------------------------------------------------------------------
// API HTTP de contas
// ---------------------------------------------------------------------------
const loginByUser = new auth.RateLimiter(10, 15 * 60 * 1000);
const loginByIp = new auth.RateLimiter(50, 15 * 60 * 1000);
const registerByIp = new auth.RateLimiter(10, 60 * 60 * 1000);

const clientIp = (req) =>
  String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '').slice(0, 64);

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error('[uvoz] erro na API:', err);
  res.status(500).json({ error: 'Erro interno. Tente novamente.' });
});

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, online: userSockets.size, db: 'ok' });
}));

app.get('/api/config', (_req, res) => res.json({ requiresAccessCode: !!ACCESS_CODE }));

app.post('/api/register', asyncRoute(async (req, res) => {
  const ip = clientIp(req);
  if (registerByIp.blocked(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco.' });
  registerByIp.hit(ip);

  const username = String(req.body?.username || '').trim().toLowerCase();
  const displayName = sanitizeText(req.body?.displayName, 40);
  const password = String(req.body?.password || '');
  const accessCode = String(req.body?.accessCode || '');

  if (ACCESS_CODE && accessCode !== ACCESS_CODE) return res.status(403).json({ error: 'Código de acesso inválido.' });
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Usuário deve ter 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou _.' });
  }
  if (RESERVED_USERNAMES.has(username)) return res.status(400).json({ error: 'Esse nome de usuário é reservado.' });
  if (!displayName) return res.status(400).json({ error: 'Informe seu nome.' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
  if (store.usernames.has(username)) return res.status(409).json({ error: 'Esse usuário já existe.' });

  let user;
  try {
    user = await store.createUser({ username, displayName, passwordHash: await auth.hashPassword(password) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esse usuário já existe.' });
    throw err;
  }
  const token = await auth.createSession(pool, user.id, req.headers['user-agent']);
  io.emit('user:new', { ...user, online: false, lastSeen: null });
  res.status(201).json({ token, user });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const ip = clientIp(req);
  const username = String(req.body?.username || '').trim().toLowerCase().slice(0, 32);
  const password = String(req.body?.password || '').slice(0, 200);
  const key = `u:${username}`;
  if (loginByIp.blocked(ip) || loginByUser.blocked(key)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  }
  const row = username ? await store.findUserForLogin(username) : null;
  const ok = row ? await auth.verifyPassword(password, row.password_hash) : await auth.verifyAgainstDummy(password);
  if (!ok) {
    loginByIp.hit(ip);
    loginByUser.hit(key);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  loginByUser.reset(key);
  const token = await auth.createSession(pool, row.id, req.headers['user-agent']);
  res.json({ token, user: store.publicUser(row) });
}));

app.post('/api/logout', asyncRoute(async (req, res) => {
  await auth.deleteSession(pool, bearer(req));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
io.use(async (socket, next) => {
  try {
    const userId = await auth.userIdFromToken(pool, socket.handshake.auth?.token);
    if (!userId || !store.users.has(userId)) return next(new Error('SESSAO_INVALIDA'));
    socket.data.userId = userId;
    next();
  } catch (err) {
    console.error('[uvoz] erro na autenticação do socket:', err);
    next(new Error('ERRO_SERVIDOR'));
  }
});

/** Resolve e autoriza um scope vindo do cliente. */
async function resolveScope(scope, userId) {
  if (scope?.type === 'channel') {
    const channel = await store.getChannel(scope.id);
    return channel && channel.type === 'text' ? { type: 'channel', id: channel.id } : null;
  }
  if (scope?.type === 'dm') {
    const dm = await store.getDm(scope.id);
    if (!dm || !store.dmMembers(dm).includes(userId)) return null;
    return { type: 'dm', id: dm.id, dm };
  }
  return null;
}

/** Envia um evento para quem pode ver o scope. */
function emitToScope(scope, event, payload) {
  if (scope.type === 'channel') return io.emit(event, payload);
  const [a, b] = store.dmMembers(scope.dm);
  io.to(`user:${a}`).to(`user:${b}`).emit(event, payload);
}

io.on('connection', async (socket) => {
  const userId = socket.data.userId;
  const me = store.users.get(userId);
  socket.join(`user:${userId}`);

  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  const firstSocket = userSockets.get(userId).size === 0;
  userSockets.get(userId).add(socket.id);
  if (firstSocket) socket.broadcast.emit('presence', { userId, online: true });

  // Registrado antes de qualquer await para não perder uma desconexão rápida.
  socket.on('disconnect', () => {
    leaveVoice(socket);
    const set = userSockets.get(userId);
    if (set) {
      set.delete(socket.id);
      if (!set.size) {
        userSockets.delete(userId);
        io.emit('presence', { userId, online: false, lastSeen: Date.now() });
        store.touchUser(userId).catch(() => {});
      }
    }
  });

  // Handler com tratamento de erro e resposta padrão.
  const on = (event, fn) => socket.on(event, async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const result = await fn(payload || {});
      reply(result ?? { ok: true });
    } catch (err) {
      console.error(`[uvoz] erro em ${event}:`, err);
      reply({ error: 'Erro interno. Tente novamente.' });
    }
  });

  try {
    const [channels, dms, unread, lastSeen] = await Promise.all([
      store.listChannels(), store.listDms(userId), store.unreadSummary(userId), store.lastSeen(),
    ]);
    socket.emit('init', {
      me,
      socketId: socket.id,
      channels,
      users: [...store.users.values()].map((u) => ({ ...u, online: isOnline(u.id), lastSeen: lastSeen.get(u.id) || null })),
      voice: [...voiceStates.values()],
      dms,
      unread,
      iceServers: iceServersFor(socket.id),
      maxPeersPerRoom: MAX_PEERS_PER_ROOM,
    });
  } catch (err) {
    console.error('[uvoz] erro ao iniciar sessão:', err);
    socket.emit('fatal', { error: 'Não foi possível carregar seus dados.' });
    socket.disconnect(true);
    return;
  }

  // ----- Canais ------------------------------------------------------------
  on('channel:create', async (p) => {
    const name = sanitizeText(p.name, 40);
    const type = p.type === 'voice' ? 'voice' : 'text';
    if (!name) return { error: 'Nome do canal obrigatório.' };
    if ((await store.countChannels()) >= 100) return { error: 'Limite de canais atingido.' };
    const base = slugify(name);
    let id = base;
    for (let i = 2; await store.channelIdExists(id); i++) id = `${base}-${i}`;
    const channel = await store.createChannel({
      id,
      name: type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name,
      type,
      topic: type === 'text' ? sanitizeText(p.topic, 120) : '',
      createdBy: userId,
    });
    io.emit('channel:created', channel);
    return { channel };
  });

  on('channel:delete', async (p) => {
    const channel = await store.getChannel(p.channelId);
    if (!channel) return { error: 'Canal não encontrado.' };
    if (channel.type === 'text' && (await store.countChannels('text')) <= 1) {
      return { error: 'É preciso manter ao menos um canal de texto.' };
    }
    for (const vs of [...voiceStates.values()]) {
      if (vs.channelId === channel.id) {
        const s = io.sockets.sockets.get(vs.socketId);
        if (s) leaveVoice(s);
      }
    }
    await store.deleteChannel(channel.id);
    io.emit('channel:deleted', { channelId: channel.id });
    return { ok: true };
  });

  // ----- Mensagens ---------------------------------------------------------
  on('messages:get', async (p) => {
    const scope = await resolveScope(p.scope, userId);
    if (!scope) return { error: 'Conversa não encontrada.' };
    return store.getMessages(scope, p.before);
  });

  on('message:send', async (p) => {
    const scope = await resolveScope(p.scope, userId);
    if (!scope) return { error: 'Conversa não encontrada.' };
    const text = sanitizeText(p.text, MAX_MESSAGE_LENGTH);
    if (!text) return { error: 'Mensagem vazia.' };
    const message = await store.createMessage(scope, userId, text);
    if (scope.type === 'dm') {
      for (const member of store.dmMembers(scope.dm)) {
        io.to(`user:${member}`).emit('dm:upsert', store.publicDm({ ...scope.dm, last_message_at: message.ts }, member));
      }
    }
    emitToScope(scope, 'message:new', message);
    return { message };
  });

  on('message:edit', async (p) => {
    const found = await store.getMessage(p.id);
    if (!found || found.row.author_id !== userId) return { error: 'Você só pode editar suas mensagens.' };
    const scope = await resolveScope(found.message.scope, userId);
    if (!scope) return { error: 'Conversa não encontrada.' };
    const text = sanitizeText(p.text, MAX_MESSAGE_LENGTH);
    if (!text) return { error: 'Mensagem vazia.' };
    const message = await store.editMessage(found.message.id, text, scope.type === 'channel');
    emitToScope(scope, 'message:updated', message);
    return { message };
  });

  on('message:delete', async (p) => {
    const found = await store.getMessage(p.id);
    if (!found || found.row.author_id !== userId) return { error: 'Você só pode apagar suas mensagens.' };
    const scope = await resolveScope(found.message.scope, userId);
    if (!scope) return { error: 'Conversa não encontrada.' };
    await store.deleteMessage(found.message.id);
    emitToScope(scope, 'message:deleted', { id: found.message.id, scope: found.message.scope });
    return { ok: true };
  });

  on('read:mark', async (p) => {
    const scope = await resolveScope(p.scope, userId);
    const messageId = Number(p.messageId) || 0;
    if (!scope || !messageId) return { ok: false };
    await store.markRead(userId, scope, messageId);
    socket.to(`user:${userId}`).emit('read:updated', { scope: scopeKey(scope), lastReadId: messageId });
    return { ok: true };
  });

  on('typing', async (p) => {
    const scope = await resolveScope(p.scope, userId);
    if (!scope) return { ok: false };
    const payload = { scope: { type: scope.type, id: scope.id }, userId };
    if (scope.type === 'channel') socket.broadcast.emit('typing', payload);
    else {
      const other = store.dmMembers(scope.dm).find((m) => m !== userId);
      if (other) io.to(`user:${other}`).emit('typing', payload);
    }
    return { ok: true };
  });

  // ----- Mensagens diretas -------------------------------------------------
  on('dm:open', async (p) => {
    const otherId = Number(p.userId);
    if (!store.users.has(otherId) || otherId === userId) return { error: 'Usuário não encontrado.' };
    const dm = await store.openDm(userId, otherId);
    io.to(`user:${userId}`).emit('dm:upsert', store.publicDm(dm, userId));
    return { dm: store.publicDm(dm, userId) };
  });

  // ----- Salas de voz / vídeo ---------------------------------------------
  on('voice:join', async (p) => {
    const channel = await store.getChannel(p.channelId);
    if (!channel || channel.type !== 'voice') return { error: 'Sala não encontrada.' };
    const current = [...voiceStates.values()].filter((v) => v.channelId === channel.id && v.socketId !== socket.id);
    const mine = voiceStates.get(socket.id);
    if (mine?.channelId === channel.id) return { peers: current, iceServers: iceServersFor(socket.id) };
    if (current.length >= MAX_PEERS_PER_ROOM) return { error: `Sala cheia (máx. ${MAX_PEERS_PER_ROOM} pessoas).` };
    leaveVoice(socket);
    const state = { socketId: socket.id, userId, channelId: channel.id, media: emptyMedia() };
    voiceStates.set(socket.id, state);
    socket.join(`voice:${channel.id}`);
    socket.to(`voice:${channel.id}`).emit('voice:peer-joined', state);
    io.emit('voice:state', state);
    return { peers: current, iceServers: iceServersFor(socket.id) };
  });

  on('voice:leave', async () => {
    leaveVoice(socket);
    return { ok: true };
  });

  socket.on('voice:media', (p) => {
    const state = voiceStates.get(socket.id);
    if (!state) return;
    state.media = {
      mic: !!p?.mic,
      cam: !!p?.cam,
      screen: !!p?.screen,
      cameraStreamId: sanitizeText(p?.cameraStreamId, 100) || null,
      screenStreamId: sanitizeText(p?.screenStreamId, 100) || null,
    };
    io.emit('voice:state', state);
  });

  // Repasse de sinalização WebRTC — apenas entre sockets na mesma sala.
  socket.on('signal', (p) => {
    const mine = voiceStates.get(socket.id);
    const target = voiceStates.get(p?.to);
    if (!mine || !target || mine.channelId !== target.channelId) return;
    io.to(target.socketId).emit('signal', { from: socket.id, data: p.data });
  });

});

function leaveVoice(socket) {
  const state = voiceStates.get(socket.id);
  if (!state) return;
  voiceStates.delete(socket.id);
  socket.leave(`voice:${state.channelId}`);
  socket.to(`voice:${state.channelId}`).emit('voice:peer-left', { socketId: socket.id });
  io.emit('voice:state', { socketId: socket.id, userId: state.userId, channelId: null });
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
async function main() {
  await migrate(pool);
  await store.loadUsers();
  await store.seedChannels(LEGACY_DATA_FILE);
  await auth.purgeExpiredSessions(pool);
  setInterval(() => auth.purgeExpiredSessions(pool).catch(() => {}), 6 * 3600 * 1000).unref();

  server.listen(PORT, HOST, () => {
    console.log(`[uvoz] rodando em http://${HOST}:${PORT}`);
    if (!ACCESS_CODE) console.log('[uvoz] ATENÇÃO: ACCESS_CODE não definido — qualquer pessoa pode criar conta.');
    console.log(`[uvoz] TURN ${TURN_SECRET && TURN_URLS.length ? 'ativo: ' + TURN_URLS.join(', ') : 'desativado (apenas STUN)'}`);
  });
}

main().catch((err) => {
  console.error('[uvoz] falha ao iniciar:', err);
  process.exit(1);
});
