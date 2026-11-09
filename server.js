/**
 * UVoz — servidor de comunicação interna da Unicopag.
 *
 * - Express serve o front-end estático (pasta /public).
 * - Socket.io cuida de: presença, canais de texto, mensagens e
 *   sinalização WebRTC (offer/answer/ICE) para as salas de voz/vídeo.
 * - Áudio, vídeo e tela trafegam P2P entre os navegadores (malha WebRTC);
 *   o servidor só repassa a sinalização.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// Configuração (variáveis de ambiente)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || ''; // vazio = sem código de acesso
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const MAX_MESSAGES_PER_CHANNEL = Number(process.env.MAX_MESSAGES_PER_CHANNEL) || 500;
const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS_PER_ROOM) || 8;

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

// ---------------------------------------------------------------------------
// Persistência simples em arquivo JSON (canais + histórico de mensagens)
// ---------------------------------------------------------------------------
const DEFAULT_DB = {
  channels: [
    { id: 'geral', name: 'geral', type: 'text', topic: 'Avisos e conversas gerais da Unicopag' },
    { id: 'comercial', name: 'comercial', type: 'text', topic: 'Time comercial' },
    { id: 'suporte', name: 'suporte', type: 'text', topic: 'Atendimento e suporte' },
    { id: 'sala-geral', name: 'Sala Geral', type: 'voice' },
    { id: 'reuniao', name: 'Reunião', type: 'voice' },
    { id: 'daily', name: 'Daily', type: 'voice' },
  ],
  messages: {},
};

function loadDb() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const db = JSON.parse(raw);
    if (!Array.isArray(db.channels)) db.channels = DEFAULT_DB.channels;
    if (!db.messages || typeof db.messages !== 'object') db.messages = {};
    return db;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

const db = loadDb();
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), (err) => {
      if (err) return console.error('[uvoz] erro ao salvar:', err.message);
      fs.rename(tmp, DATA_FILE, (err2) => err2 && console.error('[uvoz] erro ao salvar:', err2.message));
    });
  }, 1000);
}

// ---------------------------------------------------------------------------
// Estado em memória
// ---------------------------------------------------------------------------
/** socketId -> { id, name, color, voiceChannelId, media: {mic, cam, screen, ...} } */
const users = new Map();

const COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c'];

function publicUser(u) {
  return { id: u.id, name: u.name, color: u.color, voiceChannelId: u.voiceChannelId, media: u.media };
}

function voiceMembers(channelId) {
  return [...users.values()].filter((u) => u.voiceChannelId === channelId);
}

function sanitizeText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function slugify(name) {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'canal';
  let id = base;
  let i = 2;
  while (db.channels.some((c) => c.id === id)) id = `${base}-${i++}`;
  return id;
}

// ---------------------------------------------------------------------------
// HTTP + Socket.io
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok: true, online: users.size }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// Autenticação simples por código de acesso (opcional) + nome de exibição.
io.use((socket, next) => {
  const { name, code } = socket.handshake.auth || {};
  const cleanName = sanitizeText(name, 32);
  if (!cleanName) return next(new Error('NOME_OBRIGATORIO'));
  if (ACCESS_CODE && code !== ACCESS_CODE) return next(new Error('CODIGO_INVALIDO'));
  socket.data.name = cleanName;
  next();
});

io.on('connection', (socket) => {
  const user = {
    id: socket.id,
    name: socket.data.name,
    color: COLORS[crypto.randomInt(COLORS.length)],
    voiceChannelId: null,
    media: { mic: false, cam: false, screen: false, cameraStreamId: null, screenStreamId: null },
  };
  users.set(socket.id, user);

  socket.emit('init', {
    me: publicUser(user),
    channels: db.channels,
    users: [...users.values()].map(publicUser),
    iceServers: ICE_SERVERS,
    maxPeersPerRoom: MAX_PEERS_PER_ROOM,
  });
  socket.broadcast.emit('user:online', publicUser(user));

  // ----- Canais ------------------------------------------------------------
  socket.on('channel:create', (payload, ack = () => {}) => {
    const name = sanitizeText(payload?.name, 40);
    const type = payload?.type === 'voice' ? 'voice' : 'text';
    if (!name) return ack({ error: 'Nome do canal obrigatório.' });
    if (db.channels.length >= 100) return ack({ error: 'Limite de canais atingido.' });
    const channel = { id: slugify(name), name: type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name, type };
    if (type === 'text') channel.topic = sanitizeText(payload?.topic, 120);
    db.channels.push(channel);
    scheduleSave();
    io.emit('channel:created', channel);
    ack({ channel });
  });

  socket.on('channel:delete', (payload, ack = () => {}) => {
    const idx = db.channels.findIndex((c) => c.id === payload?.channelId);
    if (idx === -1) return ack({ error: 'Canal não encontrado.' });
    const channel = db.channels[idx];
    if (channel.type === 'text' && db.channels.filter((c) => c.type === 'text').length === 1) {
      return ack({ error: 'É preciso manter ao menos um canal de texto.' });
    }
    // Remove todos da sala de voz antes de apagar.
    for (const member of voiceMembers(channel.id)) {
      const s = io.sockets.sockets.get(member.id);
      if (s) leaveVoice(s);
    }
    db.channels.splice(idx, 1);
    delete db.messages[channel.id];
    scheduleSave();
    io.emit('channel:deleted', { channelId: channel.id });
    ack({ ok: true });
  });

  // ----- Mensagens de texto -----------------------------------------------
  socket.on('messages:get', (payload, ack = () => {}) => {
    const channel = db.channels.find((c) => c.id === payload?.channelId && c.type === 'text');
    if (!channel) return ack({ error: 'Canal não encontrado.' });
    ack({ messages: db.messages[channel.id] || [] });
  });

  socket.on('message:send', (payload, ack = () => {}) => {
    const channel = db.channels.find((c) => c.id === payload?.channelId && c.type === 'text');
    if (!channel) return ack({ error: 'Canal não encontrado.' });
    const text = sanitizeText(payload?.text, 2000);
    if (!text) return ack({ error: 'Mensagem vazia.' });
    const message = {
      id: crypto.randomUUID(),
      channelId: channel.id,
      author: { name: user.name, color: user.color },
      text,
      ts: Date.now(),
    };
    const list = (db.messages[channel.id] ||= []);
    list.push(message);
    if (list.length > MAX_MESSAGES_PER_CHANNEL) list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
    scheduleSave();
    io.emit('message:new', message);
    ack({ message });
  });

  socket.on('typing', (payload) => {
    if (!db.channels.some((c) => c.id === payload?.channelId)) return;
    socket.broadcast.emit('typing', { channelId: payload.channelId, name: user.name });
  });

  // ----- Salas de voz / vídeo ---------------------------------------------
  socket.on('voice:join', (payload, ack = () => {}) => {
    const channel = db.channels.find((c) => c.id === payload?.channelId && c.type === 'voice');
    if (!channel) return ack({ error: 'Sala não encontrada.' });
    if (user.voiceChannelId === channel.id) {
      return ack({ peers: voiceMembers(channel.id).filter((u) => u.id !== socket.id).map(publicUser) });
    }
    const current = voiceMembers(channel.id);
    if (current.length >= MAX_PEERS_PER_ROOM) {
      return ack({ error: `Sala cheia (máx. ${MAX_PEERS_PER_ROOM} pessoas).` });
    }
    leaveVoice(socket);
    user.voiceChannelId = channel.id;
    user.media = { mic: false, cam: false, screen: false, cameraStreamId: null, screenStreamId: null };
    socket.join(`voice:${channel.id}`);
    ack({ peers: current.map(publicUser) });
    socket.to(`voice:${channel.id}`).emit('voice:peer-joined', publicUser(user));
    io.emit('user:update', publicUser(user));
  });

  socket.on('voice:leave', (_payload, ack = () => {}) => {
    leaveVoice(socket);
    ack({ ok: true });
  });

  socket.on('voice:media', (payload) => {
    if (!user.voiceChannelId) return;
    user.media = {
      mic: !!payload?.mic,
      cam: !!payload?.cam,
      screen: !!payload?.screen,
      cameraStreamId: sanitizeText(payload?.cameraStreamId, 100) || null,
      screenStreamId: sanitizeText(payload?.screenStreamId, 100) || null,
    };
    io.emit('user:update', publicUser(user));
  });

  // Repasse de sinalização WebRTC — apenas entre membros da mesma sala.
  socket.on('signal', (payload) => {
    const target = users.get(payload?.to);
    if (!target || !user.voiceChannelId || target.voiceChannelId !== user.voiceChannelId) return;
    io.to(target.id).emit('signal', { from: socket.id, data: payload.data });
  });

  socket.on('disconnect', () => {
    leaveVoice(socket);
    users.delete(socket.id);
    io.emit('user:offline', { id: socket.id });
  });
});

function leaveVoice(socket) {
  const user = users.get(socket.id);
  if (!user || !user.voiceChannelId) return;
  const channelId = user.voiceChannelId;
  socket.leave(`voice:${channelId}`);
  user.voiceChannelId = null;
  user.media = { mic: false, cam: false, screen: false, cameraStreamId: null, screenStreamId: null };
  socket.to(`voice:${channelId}`).emit('voice:peer-left', { id: socket.id });
  io.emit('user:update', publicUser(user));
}

server.listen(PORT, () => {
  console.log(`[uvoz] rodando em http://localhost:${PORT}`);
  if (!ACCESS_CODE) console.log('[uvoz] ATENÇÃO: ACCESS_CODE não definido — qualquer pessoa com o link pode entrar.');
});
