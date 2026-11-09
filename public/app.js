/* UVoz — front-end: contas, canais, mensagens diretas, menções, salas de voz/vídeo e tela. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  };
  const svg = (inner, cls = '') => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    if (cls) s.setAttribute('class', cls);
    s.innerHTML = inner; // apenas conteúdo estático definido abaixo
    return s;
  };
  const ICONS = {
    speaker: '<path d="M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7"/>',
    micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/>',
    cam: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
    screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
  };

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------
  const state = {
    socket: null,
    token: null,
    me: null,
    socketId: null,
    channels: [],
    users: new Map(), // id -> { id, username, displayName, color, online, lastSeen }
    voice: new Map(), // socketId -> { socketId, userId, channelId, media }
    dms: new Map(), // dmId -> { id, userId, lastMessageAt }
    unread: new Map(), // 'c:geral' | 'd:12' -> { unread, mentions, lastReadId }
    view: null, // { type: 'channel'|'voice'|'dm', id }
    conv: new Map(), // key -> { list, hasMore, loading, loaded }
    divider: new Map(), // key -> lastReadId no momento em que a conversa foi aberta
    typing: new Map(), // key -> Map(userId -> timeout)
    call: null, // { channelId, session }
    speaking: new Set(), // socketIds falando
    focusedTile: null,
    detector: null,
    editingId: null,
    iceServers: [],
  };

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const keyOf = (scope) => `${scope.type === 'dm' ? 'd' : 'c'}:${scope.id}`;
  const viewScope = () => (state.view && state.view.type !== 'voice' ? { type: state.view.type, id: state.view.id } : null);
  const viewKey = () => (viewScope() ? keyOf(viewScope()) : null);
  const channelById = (id) => state.channels.find((c) => c.id === id);
  const userName = (id) => state.users.get(id)?.displayName || 'Alguém';
  const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // -------------------------------------------------------------------------
  // Utilidades de UI
  // -------------------------------------------------------------------------
  function toast(text, type = 'info') {
    const t = el('div', { class: `toast ${type}` }, text);
    $('#toasts').append(t);
    setTimeout(() => t.classList.add('out'), 3800);
    setTimeout(() => t.remove(), 4300);
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
  }

  function avatar(user, size = '') {
    return el('div', { class: `avatar ${size}`, style: `background:${user?.color || '#80848e'}` }, initials(user?.displayName || user?.name));
  }

  function avatarWithPresence(user, size = 'sm') {
    return el('div', { class: 'avatar-wrap' }, avatar(user, size), el('span', { class: `presence ${user?.online ? 'on' : 'off'}` }));
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const today = new Date();
    const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `Hoje às ${time}`;
    const y = new Date(today); y.setDate(today.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `Ontem às ${time}`;
    return `${d.toLocaleDateString('pt-BR')} ${time}`;
  }

  function fmtLastSeen(ts) {
    if (!ts) return 'offline';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'visto agora há pouco';
    if (diff < 3600_000) return `visto há ${Math.round(diff / 60_000)} min`;
    if (diff < 86400_000) return `visto há ${Math.round(diff / 3600_000)} h`;
    return `visto em ${new Date(ts).toLocaleDateString('pt-BR')}`;
  }

  const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
  const MENTION_RE = /@([a-z0-9._-]{2,32})/gi;
  const EVERYONE = new Set(['todos', 'everyone', 'here', 'aqui']);
  const usernameIndex = () => new Map([...state.users.values()].map((u) => [u.username.toLowerCase(), u]));

  /** Texto com links e menções destacadas (sem HTML do usuário). */
  function richText(text, isChannel) {
    const frag = document.createDocumentFragment();
    const users = usernameIndex();
    const pushMentions = (chunk) => {
      let last = 0;
      for (const m of chunk.matchAll(MENTION_RE)) {
        const before = m.index > 0 ? chunk[m.index - 1] : '';
        if (before && /[\w@]/.test(before)) continue;
        let name = m[1].toLowerCase();
        let tail = '';
        const trimmed = name.replace(/[.,;:!?-]+$/, '');
        if (trimmed !== name) { tail = m[1].slice(trimmed.length); name = trimmed; }
        const user = users.get(name);
        const everyone = isChannel && EVERYONE.has(name);
        if (!user && !everyone) continue;
        if (m.index > last) frag.append(chunk.slice(last, m.index));
        const isMe = user ? user.id === state.me.id : true;
        frag.append(el('span', {
          class: `mention ${isMe ? 'me' : ''}`,
          title: user ? `@${user.username}` : 'Todos do canal',
          onclick: user && user.id !== state.me.id ? () => openDm(user.id) : null,
        }, user ? `@${user.displayName}` : `@${name}`));
        if (tail) frag.append(tail);
        last = m.index + m[0].length;
      }
      if (last < chunk.length) frag.append(chunk.slice(last));
    };
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      if (m.index > last) pushMentions(text.slice(last, m.index));
      frag.append(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) pushMentions(text.slice(last));
    return frag;
  }

  const mentionsMe = (m) => m.author.id !== state.me.id && (m.mentions.includes(state.me.id) || m.mentionsEveryone);

  // -------------------------------------------------------------------------
  // Login / cadastro
  // -------------------------------------------------------------------------
  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('#auth-form').classList.toggle('register', mode === 'register');
    $('#auth-submit').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
    $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#login-error').textContent = '';
  }
  document.querySelectorAll('.auth-tabs button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));

  fetch('/api/config').then((r) => r.json()).then((cfg) => {
    if (!cfg.requiresAccessCode) $('#auth-code-wrap').remove();
  }).catch(() => {});

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth-submit');
    const body = {
      username: $('#auth-username').value.trim(),
      password: $('#auth-password').value,
    };
    if (authMode === 'register') {
      body.displayName = $('#auth-display').value.trim();
      body.accessCode = $('#auth-code')?.value || '';
    }
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      const res = await fetch(`/api/${authMode === 'login' ? 'login' : 'register'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível entrar.');
      storage.set('uvoz:token', data.token);
      $('#auth-password').value = '';
      connect(data.token);
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function showLogin(message) {
    $('#login').hidden = false;
    $('#app').hidden = true;
    if (message) $('#login-error').textContent = message;
    document.title = 'UVoz · Unicopag';
  }

  $('#logout').addEventListener('click', async () => {
    const token = state.token;
    leaveCall({ silent: true });
    storage.del('uvoz:token');
    state.socket && state.socket.disconnect();
    state.socket = null;
    state.token = null;
    fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    showLogin();
  });

  // -------------------------------------------------------------------------
  // Conexão em tempo real
  // -------------------------------------------------------------------------
  function connect(token) {
    if (state.socket) state.socket.disconnect();
    state.token = token;
    const socket = (state.socket = io({ auth: { token }, transports: ['websocket', 'polling'] }));

    socket.on('connect_error', (err) => {
      if (err.message === 'SESSAO_INVALIDA') {
        socket.disconnect();
        storage.del('uvoz:token');
        showLogin('Sua sessão expirou. Entre novamente.');
      } else if ($('#app').hidden) {
        $('#login-error').textContent = 'Não foi possível conectar ao servidor. Tentando novamente…';
      }
    });
    socket.on('fatal', ({ error }) => toast(error, 'error'));

    socket.on('init', onInit);
    socket.on('disconnect', (reason) => {
      if (state.call) {
        leaveCall({ silent: true });
        toast('Conexão perdida — você saiu da sala de voz.', 'error');
      }
      if (reason !== 'io client disconnect') $('#me-status').textContent = 'Reconectando…';
    });

    socket.on('presence', ({ userId, online, lastSeen }) => {
      const u = state.users.get(userId);
      if (!u) return;
      u.online = online;
      if (lastSeen) u.lastSeen = lastSeen;
      renderMembers(); renderDms(); renderHeader();
    });
    socket.on('user:new', (u) => { state.users.set(u.id, u); renderMembers(); });

    socket.on('channel:created', (c) => { if (!channelById(c.id)) state.channels.push(c); renderChannels(); });
    socket.on('channel:deleted', ({ channelId }) => {
      state.channels = state.channels.filter((c) => c.id !== channelId);
      state.conv.delete(`c:${channelId}`);
      state.unread.delete(`c:${channelId}`);
      if (state.call?.channelId === channelId) leaveCall({ silent: true });
      if (state.view?.id === channelId) openDefault();
      renderChannels();
    });

    socket.on('message:new', onMessageNew);
    socket.on('message:updated', onMessageUpdated);
    socket.on('message:deleted', onMessageDeleted);
    socket.on('read:updated', ({ scope, lastReadId }) => {
      const u = state.unread.get(scope);
      if (u && lastReadId >= (u.lastMessageId || 0)) state.unread.delete(scope);
      renderUnread();
    });
    socket.on('typing', onTyping);
    socket.on('dm:upsert', (dm) => {
      const prev = state.dms.get(dm.id);
      state.dms.set(dm.id, { ...prev, ...dm });
      renderDms();
    });

    socket.on('voice:state', (vs) => {
      if (vs.channelId) state.voice.set(vs.socketId, vs);
      else state.voice.delete(vs.socketId);
      renderVoiceChannels(); renderMembers();
      if (state.view?.type === 'voice') scheduleStageRender();
    });
    socket.on('voice:peer-joined', (vs) => {
      state.voice.set(vs.socketId, vs);
      if (state.call) state.call.session.ensurePeer(vs.socketId);
      playTone('join');
      scheduleStageRender();
    });
    socket.on('voice:peer-left', ({ socketId }) => {
      if (state.call) state.call.session.removePeer(socketId);
      state.detector && state.detector.untrack(socketId);
      playTone('leave');
      scheduleStageRender();
    });
    socket.on('signal', ({ from, data }) => { if (state.call) state.call.session.handleSignal(from, data); });
  }

  function onInit(data) {
    state.me = data.me;
    state.socketId = data.socketId;
    state.channels = data.channels;
    state.iceServers = data.iceServers;
    state.users = new Map(data.users.map((u) => [u.id, u]));
    state.voice = new Map(data.voice.map((v) => [v.socketId, v]));
    state.dms = new Map(data.dms.map((d) => [d.id, d]));
    state.unread = new Map(Object.entries(data.unread));
    state.conv.clear();
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#me-name').textContent = state.me.displayName;
    $('#me-status').textContent = `@${state.me.username}`;
    $('#me-avatar').replaceChildren(initials(state.me.displayName));
    $('#me-avatar').style.background = state.me.color;
    renderChannels(); renderDms(); renderMembers(); renderUnread();

    const saved = (() => { try { return JSON.parse(storage.get('uvoz:view') || 'null'); } catch { return null; } })();
    const target = state.view || saved;
    if (target && isValidView(target)) openView(target);
    else openDefault();
  }

  function isValidView(v) {
    if (v.type === 'dm') return state.dms.has(Number(v.id));
    const c = channelById(v.id);
    return !!c && ((v.type === 'voice') === (c.type === 'voice'));
  }

  function openDefault() {
    const first = state.channels.find((c) => c.type === 'text');
    if (first) openView({ type: 'channel', id: first.id });
  }

  // -------------------------------------------------------------------------
  // Barra lateral
  // -------------------------------------------------------------------------
  function renderChannels() { renderTextChannels(); renderVoiceChannels(); }

  function deleteButton(channel) {
    return el('button', {
      class: 'icon-btn small row-action', title: 'Excluir canal', 'aria-label': `Excluir ${channel.name}`,
      onclick: (e) => {
        e.stopPropagation();
        if (!confirm(`Excluir "${channel.name}"? O histórico será apagado para todos.`)) return;
        state.socket.emit('channel:delete', { channelId: channel.id }, (res) => res?.error && toast(res.error, 'error'));
      },
    }, svg(ICONS.trash));
  }

  function badge(key) {
    const u = state.unread.get(key);
    if (!u) return null;
    const isDm = key.startsWith('d:');
    const count = isDm ? u.unread : u.mentions;
    return count > 0 ? el('span', { class: 'badge', title: isDm ? 'Mensagens não lidas' : 'Menções' }, count > 99 ? '99+' : count) : null;
  }

  function renderTextChannels() {
    $('#text-channels').replaceChildren(...state.channels.filter((c) => c.type === 'text').map((c) => {
      const key = `c:${c.id}`;
      const active = state.view?.type === 'channel' && state.view.id === c.id;
      return el('li', {},
        el('div', {
          class: `channel ${active ? 'active' : ''} ${state.unread.get(key)?.unread ? 'unread' : ''}`,
          role: 'button', tabindex: 0, dataset: { key },
          onclick: () => openView({ type: 'channel', id: c.id }),
          onkeydown: (e) => e.key === 'Enter' && openView({ type: 'channel', id: c.id }),
        },
        el('span', { class: 'channel-icon' }, '#'),
        el('span', { class: 'channel-name' }, c.name),
        badge(key),
        deleteButton(c)));
    }));
  }

  const voiceMembers = (channelId) => [...state.voice.values()].filter((v) => v.channelId === channelId);

  function renderVoiceChannels() {
    $('#voice-channels').replaceChildren(...state.channels.filter((c) => c.type === 'voice').map((c) => {
      const members = voiceMembers(c.id);
      const active = state.view?.type === 'voice' && state.view.id === c.id;
      return el('li', {},
        el('div', {
          class: `channel ${active ? 'active' : ''} ${state.call?.channelId === c.id ? 'connected' : ''}`,
          role: 'button', tabindex: 0,
          onclick: () => openView({ type: 'voice', id: c.id }),
          ondblclick: () => joinCall(c.id),
          onkeydown: (e) => e.key === 'Enter' && openView({ type: 'voice', id: c.id }),
        },
        el('span', { class: 'channel-icon' }, svg(ICONS.speaker)),
        el('span', { class: 'channel-name' }, c.name),
        members.length ? el('span', { class: 'channel-count' }, members.length) : null,
        deleteButton(c)),
        members.length ? el('ul', { class: 'voice-members' }, members.map((v) => {
          const u = state.users.get(v.userId) || { displayName: '?' };
          return el('li', { class: `voice-member ${state.speaking.has(v.socketId) ? 'speaking' : ''}`, dataset: { sid: v.socketId } },
            avatar(u, 'xs'),
            el('span', { class: 'voice-member-name' }, u.displayName),
            el('span', { class: 'voice-member-icons' },
              v.media?.screen ? el('span', { class: 'badge-live', title: 'Compartilhando tela' }, 'AO VIVO') : null,
              v.media?.cam ? svg(ICONS.cam, 'mini') : null,
              !v.media?.mic ? svg(ICONS.micOff, 'mini danger') : null));
        })) : null);
    }));
  }

  function renderDms() {
    const list = [...state.dms.values()].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    $('#dm-list').replaceChildren(...list.map((d) => {
      const u = state.users.get(d.userId);
      if (!u) return null;
      const key = `d:${d.id}`;
      const active = state.view?.type === 'dm' && Number(state.view.id) === d.id;
      return el('li', {},
        el('div', {
          class: `channel dm ${active ? 'active' : ''} ${state.unread.get(key)?.unread ? 'unread' : ''}`,
          role: 'button', tabindex: 0, dataset: { key },
          onclick: () => openView({ type: 'dm', id: d.id }),
          onkeydown: (e) => e.key === 'Enter' && openView({ type: 'dm', id: d.id }),
        },
        avatarWithPresence(u, 'xs'),
        el('span', { class: 'channel-name' }, u.displayName),
        badge(key)));
    }).filter(Boolean));
    if (!list.length) $('#dm-list').append(el('li', { class: 'empty-hint muted' }, 'Clique em alguém na lista de membros para conversar.'));
  }

  function renderMembers() {
    const all = [...state.users.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
    const group = (title, users) => users.length ? [
      el('div', { class: 'section-title' }, el('span', {}, `${title} — ${users.length}`)),
      el('ul', { class: 'member-list-ul' }, users.map((u) => {
        const vs = [...state.voice.values()].find((v) => v.userId === u.id);
        const room = vs && channelById(vs.channelId);
        const isMe = u.id === state.me.id;
        return el('li', {
          class: `member ${u.online ? '' : 'offline'} ${isMe ? '' : 'clickable'}`,
          title: isMe ? '' : `Enviar mensagem para ${u.displayName}`,
          onclick: isMe ? null : () => openDm(u.id),
        },
        avatarWithPresence(u, 'sm'),
        el('div', { class: 'member-info' },
          el('span', {}, u.displayName, isMe ? el('small', { class: 'muted' }, ' (você)') : null),
          room ? el('small', { class: 'muted member-room' }, svg(ICONS.speaker, 'mini'), room.name)
            : el('small', { class: 'muted' }, `@${u.username}`)));
      })),
    ] : [];
    $('#member-list').replaceChildren(...group('Online', all.filter((u) => u.online)), ...group('Offline', all.filter((u) => !u.online)));
  }

  function renderUnread() {
    renderTextChannels();
    renderDms();
    let total = 0;
    for (const [key, u] of state.unread) total += key.startsWith('d:') ? u.unread : u.mentions;
    document.title = total ? `(${total}) UVoz · Unicopag` : 'UVoz · Unicopag';
  }

  $('#toggle-members').addEventListener('click', () => document.body.classList.toggle('hide-members'));
  $('#toggle-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // -------------------------------------------------------------------------
  // Navegação
  // -------------------------------------------------------------------------
  function openView(view) {
    view = { type: view.type, id: view.type === 'dm' ? Number(view.id) : view.id };
    const prevKey = viewKey();
    state.view = view;
    storage.set('uvoz:view', JSON.stringify(view));
    $('#sidebar').classList.remove('open');
    closeMentionPopup();
    state.editingId = null;
    const key = viewKey();
    if (prevKey && prevKey !== key) state.divider.delete(prevKey);

    if (view.type === 'voice') {
      $('#chat-view').hidden = true;
      $('#stage-view').hidden = false;
      renderStage();
    } else {
      $('#chat-view').hidden = false;
      $('#stage-view').hidden = true;
      const u = state.unread.get(key);
      if (u && u.unread && !state.divider.has(key)) state.divider.set(key, u.lastReadId || 0);
      $('#composer-input').placeholder = view.type === 'dm'
        ? `Mensagem para @${state.users.get(state.dms.get(view.id)?.userId)?.displayName || ''}`
        : `Conversar em #${channelById(view.id)?.name || ''}`;
      $('#composer-input').value = storage.get(`uvoz:draft:${key}`) || '';
      autoGrow();
      loadMessages();
      renderTyping();
      if (window.matchMedia('(min-width: 801px)').matches) setTimeout(() => $('#composer-input').focus(), 0);
    }
    renderHeader();
    renderChannels();
    renderDms();
  }

  function renderHeader() {
    const v = state.view;
    if (!v) return;
    const icon = $('#header-icon');
    const av = $('#header-avatar');
    av.hidden = true;
    icon.hidden = false;
    if (v.type === 'dm') {
      const u = state.users.get(state.dms.get(v.id)?.userId);
      icon.hidden = true;
      av.hidden = false;
      av.replaceChildren(avatarWithPresence(u, 'xs'));
      $('#header-title').textContent = u?.displayName || 'Mensagem direta';
      $('#header-topic').textContent = u ? `@${u.username} · ${u.online ? 'online' : fmtLastSeen(u.lastSeen)}` : '';
    } else {
      const c = channelById(v.id);
      icon.replaceChildren(v.type === 'voice' ? svg(ICONS.speaker) : '#');
      $('#header-title').textContent = c?.name || '';
      $('#header-topic').textContent = v.type === 'voice' ? 'Sala de voz e vídeo' : (c?.topic || '');
    }
  }

  async function openDm(userId) {
    const existing = [...state.dms.values()].find((d) => d.userId === userId);
    if (existing) return openView({ type: 'dm', id: existing.id });
    state.socket.emit('dm:open', { userId }, (res) => {
      if (res?.error) return toast(res.error, 'error');
      state.dms.set(res.dm.id, res.dm);
      openView({ type: 'dm', id: res.dm.id });
    });
  }

  // Nova DM: seletor de pessoas
  const dmDialog = $('#dm-dialog');
  function renderDmResults() {
    const q = normalize($('#dm-search').value);
    const list = [...state.users.values()]
      .filter((u) => u.id !== state.me.id && (!q || normalize(u.displayName).includes(q) || u.username.includes(q)))
      .sort((a, b) => (b.online - a.online) || a.displayName.localeCompare(b.displayName, 'pt-BR'))
      .slice(0, 30);
    $('#dm-results').replaceChildren(...list.map((u) => el('li', {},
      el('button', { type: 'button', class: 'dm-result', onclick: () => { dmDialog.close(); openDm(u.id); } },
        avatarWithPresence(u, 'sm'),
        el('span', { class: 'member-info' }, el('span', {}, u.displayName), el('small', { class: 'muted' }, `@${u.username}`))))));
    if (!list.length) $('#dm-results').append(el('li', { class: 'muted empty-hint' }, 'Ninguém encontrado.'));
  }
  $('#new-dm').addEventListener('click', () => {
    $('#dm-search').value = '';
    renderDmResults();
    dmDialog.showModal();
    $('#dm-search').focus();
  });
  $('#dm-search').addEventListener('input', renderDmResults);
  $('#dm-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#dm-results .dm-result')?.click(); }
  });

  // Criação de canais
  const createDialog = $('#create-dialog');
  let createType = 'text';
  document.querySelectorAll('[data-create]').forEach((btn) => btn.addEventListener('click', () => {
    createType = btn.dataset.create;
    $('#create-title').textContent = createType === 'text' ? 'Criar canal de texto' : 'Criar sala de voz e vídeo';
    $('#create-topic-wrap').hidden = createType !== 'text';
    $('#create-name').value = '';
    $('#create-topic').value = '';
    $('#create-name').placeholder = createType === 'text' ? 'novo-canal' : 'Nova sala';
    createDialog.showModal();
  }));
  createDialog.addEventListener('close', () => {
    if (createDialog.returnValue !== 'ok') return;
    const name = $('#create-name').value.trim();
    if (!name) return;
    state.socket.emit('channel:create', { name, type: createType, topic: $('#create-topic').value }, (res) => {
      if (res?.error) return toast(res.error, 'error');
      if (!channelById(res.channel.id)) state.channels.push(res.channel);
      openView({ type: res.channel.type === 'voice' ? 'voice' : 'channel', id: res.channel.id });
    });
  });

  // -------------------------------------------------------------------------
  // Mensagens
  // -------------------------------------------------------------------------
  const box = $('#messages');

  function loadMessages() {
    const scope = viewScope();
    const key = keyOf(scope);
    const conv = state.conv.get(key);
    if (conv?.loaded) { renderMessages({ toBottom: true }); markRead(); return; }
    box.replaceChildren(el('div', { class: 'messages-loading muted' }, 'Carregando mensagens…'));
    state.conv.set(key, { list: [], hasMore: false, loading: true, loaded: false });
    state.socket.emit('messages:get', { scope }, (res) => {
      if (res?.error) { state.conv.delete(key); return toast(res.error, 'error'); }
      state.conv.set(key, { list: res.messages, hasMore: res.hasMore, loading: false, loaded: true });
      if (viewKey() === key) { renderMessages({ toBottom: true }); markRead(); }
    });
  }

  function loadOlder() {
    const scope = viewScope();
    if (!scope) return;
    const key = keyOf(scope);
    const conv = state.conv.get(key);
    if (!conv || !conv.hasMore || conv.loading || !conv.list.length) return;
    conv.loading = true;
    state.socket.emit('messages:get', { scope, before: conv.list[0].id }, (res) => {
      conv.loading = false;
      if (res?.error) return;
      conv.list = [...res.messages, ...conv.list];
      conv.hasMore = res.hasMore;
      if (viewKey() !== key) return;
      const prevHeight = box.scrollHeight;
      const prevTop = box.scrollTop;
      renderMessages();
      box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    });
  }
  box.addEventListener('scroll', () => { if (box.scrollTop < 120) loadOlder(); });

  const isGrouped = (prev, m) => prev && prev.author.id === m.author.id && prev.author.name === m.author.name
    && m.ts - prev.ts < 5 * 60 * 1000;

  function messageActions(m) {
    if (m.author.id !== state.me.id) return null;
    return el('div', { class: 'msg-actions' },
      el('button', { class: 'icon-btn small', title: 'Editar', 'aria-label': 'Editar mensagem', onclick: () => startEdit(m.id) }, svg(ICONS.edit)),
      el('button', {
        class: 'icon-btn small danger', title: 'Apagar', 'aria-label': 'Apagar mensagem',
        onclick: () => {
          if (!confirm('Apagar esta mensagem?')) return;
          state.socket.emit('message:delete', { id: m.id }, (res) => res?.error && toast(res.error, 'error'));
        },
      }, svg(ICONS.trash)));
  }

  function messageBody(m) {
    const isChannel = m.scope.type === 'channel';
    if (state.editingId === m.id) {
      const ta = el('textarea', { class: 'edit-input', rows: 1, maxlength: 4000 });
      ta.value = m.text;
      const save = () => {
        const text = ta.value.trim();
        if (!text) return;
        if (text === m.text) { state.editingId = null; return renderMessages(); }
        state.socket.emit('message:edit', { id: m.id, text }, (res) => {
          if (res?.error) return toast(res.error, 'error');
          state.editingId = null;
          renderMessages();
        });
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
        if (e.key === 'Escape') { state.editingId = null; renderMessages(); }
      });
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.style.height = ta.scrollHeight + 'px'; }, 0);
      return el('div', { class: 'msg-edit' }, ta,
        el('small', { class: 'muted' }, 'Enter para salvar · Esc para cancelar'));
    }
    return el('div', { class: 'msg-text' }, richText(m.text, isChannel),
      m.editedTs ? el('small', { class: 'edited muted', title: fmtTime(m.editedTs) }, ' (editado)') : null);
  }

  function messageNode(m, grouped) {
    const cls = `msg ${grouped ? 'grouped' : ''} ${mentionsMe(m) ? 'mentioned' : ''}`;
    const author = state.users.get(m.author.id);
    const name = author?.displayName || m.author.name;
    const color = author?.color || m.author.color;
    if (grouped) {
      return el('div', { class: cls, dataset: { id: m.id } },
        el('span', { class: 'msg-hover-time' }, new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })),
        messageBody(m), messageActions(m));
    }
    return el('div', { class: cls, dataset: { id: m.id } },
      avatar({ displayName: name, color }),
      el('div', { class: 'msg-body' },
        el('div', { class: 'msg-head' },
          el('strong', {
            style: `color:${color}`,
            class: m.author.id && m.author.id !== state.me.id ? 'clickable' : '',
            onclick: m.author.id && m.author.id !== state.me.id ? () => openDm(m.author.id) : null,
          }, name),
          el('time', { class: 'muted', title: new Date(m.ts).toLocaleString('pt-BR') }, fmtTime(m.ts))),
        messageBody(m)),
      messageActions(m));
  }

  function welcomeNode() {
    const v = state.view;
    if (v.type === 'dm') {
      const u = state.users.get(state.dms.get(v.id)?.userId);
      return el('div', { class: 'messages-welcome' },
        avatar(u, 'xl'),
        el('h2', {}, u?.displayName || ''),
        el('p', { class: 'muted' }, `Este é o começo da sua conversa direta com @${u?.username || ''}.`));
    }
    const c = channelById(v.id);
    return el('div', { class: 'messages-welcome' },
      el('div', { class: 'welcome-icon' }, '#'),
      el('h2', {}, `Bem-vindo(a) a #${c?.name || ''}!`),
      el('p', { class: 'muted' }, c?.topic || 'Este é o começo do canal.'));
  }

  function renderMessages({ toBottom = false } = {}) {
    const key = viewKey();
    const conv = state.conv.get(key);
    if (!conv) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const nodes = [];
    if (conv.hasMore) nodes.push(el('div', { class: 'messages-loading muted' }, 'Role para cima para ver mensagens antigas…'));
    else nodes.push(welcomeNode());
    const dividerAfter = state.divider.get(key);
    let dividerPlaced = false;
    conv.list.forEach((m, i) => {
      let grouped = isGrouped(conv.list[i - 1], m);
      if (dividerAfter != null && !dividerPlaced && m.id > dividerAfter && m.author.id !== state.me.id) {
        nodes.push(el('div', { class: 'new-divider' }, el('span', {}, 'Novas mensagens')));
        dividerPlaced = true;
        grouped = false;
      }
      nodes.push(messageNode(m, grouped));
    });
    box.replaceChildren(...nodes);
    if (toBottom) {
      const div = box.querySelector('.new-divider');
      if (div && div.offsetTop > box.clientHeight / 2) box.scrollTop = div.offsetTop - 80;
      else box.scrollTop = box.scrollHeight;
    } else if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function markRead() {
    const scope = viewScope();
    if (!scope || document.hidden) return;
    const key = keyOf(scope);
    const conv = state.conv.get(key);
    const last = conv?.list[conv.list.length - 1];
    if (state.unread.has(key)) { state.unread.delete(key); renderUnread(); }
    if (last) state.socket.emit('read:mark', { scope, messageId: last.id });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) markRead(); });
  window.addEventListener('focus', markRead);

  function onMessageNew(m) {
    const key = keyOf(m.scope);
    const conv = state.conv.get(key);
    if (conv?.loaded && !conv.list.some((x) => x.id === m.id)) conv.list.push(m);
    if (m.author.id) clearTyping(key, m.author.id);
    if (m.scope.type === 'dm') {
      const dm = state.dms.get(m.scope.id);
      if (dm) dm.lastMessageAt = m.ts;
    }

    const viewing = viewKey() === key && !document.hidden;
    if (viewKey() === key && conv?.loaded && !state.editingId) {
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
      renderMessages();
      if (nearBottom || m.author.id === state.me.id) box.scrollTop = box.scrollHeight;
    }
    if (m.author.id === state.me.id) return;
    if (viewing) { markRead(); return; }

    const u = state.unread.get(key) || { unread: 0, mentions: 0, lastReadId: 0 };
    if (!state.unread.has(key) && conv?.list.length > 1) u.lastReadId = conv.list[conv.list.length - 2].id;
    u.unread += 1;
    if (m.scope.type === 'dm' || mentionsMe(m)) u.mentions += 1;
    u.lastMessageId = m.id;
    state.unread.set(key, u);
    if (viewKey() === key && !state.divider.has(key)) state.divider.set(key, u.lastReadId);
    renderUnread();
    if (m.scope.type === 'dm' || mentionsMe(m)) notify(m);
  }

  function onMessageUpdated(m) {
    const conv = state.conv.get(keyOf(m.scope));
    if (!conv) return;
    const idx = conv.list.findIndex((x) => x.id === m.id);
    if (idx === -1) return;
    conv.list[idx] = m;
    if (viewKey() === keyOf(m.scope) && state.editingId !== m.id) renderMessages();
  }

  function onMessageDeleted({ id, scope }) {
    const key = keyOf(scope);
    const conv = state.conv.get(key);
    if (!conv) return;
    conv.list = conv.list.filter((x) => x.id !== id);
    if (state.editingId === id) state.editingId = null;
    if (viewKey() === key && !state.editingId) renderMessages();
  }

  function startEdit(id) {
    state.editingId = id;
    renderMessages();
  }

  // Composer
  const input = $('#composer-input');
  let lastTypingSent = 0;
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }
  input.addEventListener('input', () => {
    autoGrow();
    const key = viewKey();
    if (key) storage.set(`uvoz:draft:${key}`, input.value);
    updateMentionPopup();
    if (Date.now() - lastTypingSent > 2500 && input.value.trim()) {
      lastTypingSent = Date.now();
      state.socket.emit('typing', { scope: viewScope() });
    }
  });
  input.addEventListener('click', updateMentionPopup);
  input.addEventListener('blur', () => setTimeout(closeMentionPopup, 150));
  input.addEventListener('keydown', (e) => {
    if (mentionState.open && handleMentionKey(e)) return;
    if (e.key === 'ArrowUp' && !input.value) {
      const conv = state.conv.get(viewKey());
      const mine = conv?.list.slice().reverse().find((m) => m.author.id === state.me.id);
      if (mine) { e.preventDefault(); startEdit(mine.id); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const scope = viewScope();
    if (!text || !scope) return;
    state.socket.emit('message:send', { scope, text }, (res) => {
      if (res?.error) {
        toast(res.error, 'error');
        if (!input.value) { input.value = text; autoGrow(); }
      }
    });
    input.value = '';
    storage.del(`uvoz:draft:${keyOf(scope)}`);
    autoGrow();
    closeMentionPopup();
    lastTypingSent = 0;
  });

  // ----- Autocompletar menções ----------------------------------------------
  const mentionState = { open: false, items: [], index: 0, start: 0 };
  const popup = $('#mention-popup');

  function closeMentionPopup() {
    mentionState.open = false;
    popup.hidden = true;
  }

  function updateMentionPopup() {
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret);
    const m = before.match(/(^|\s)@([\p{L}\p{N}._-]{0,32})$/u);
    if (!m) return closeMentionPopup();
    const q = normalize(m[2]);
    const items = [...state.users.values()]
      .filter((u) => u.id !== state.me.id && (!q || u.username.startsWith(q) || normalize(u.displayName).split(/\s+/).some((w) => w.startsWith(q)) || normalize(u.displayName).startsWith(q)))
      .sort((a, b) => (b.online - a.online) || a.displayName.localeCompare(b.displayName, 'pt-BR'))
      .slice(0, 8)
      .map((u) => ({ insert: u.username, user: u }));
    if (state.view?.type === 'channel' && (!q || 'todos'.startsWith(q) || 'everyone'.startsWith(q))) {
      items.push({ insert: 'todos', label: '@todos', hint: 'Notifica todos do canal' });
    }
    if (!items.length) return closeMentionPopup();
    mentionState.open = true;
    mentionState.items = items;
    mentionState.index = Math.min(mentionState.index, items.length - 1);
    mentionState.start = caret - m[2].length - 1;
    renderMentionPopup();
  }

  function renderMentionPopup() {
    popup.hidden = false;
    popup.replaceChildren(
      el('div', { class: 'mention-title' }, 'Mencionar'),
      ...mentionState.items.map((it, i) => el('div', {
        class: `mention-item ${i === mentionState.index ? 'active' : ''}`, role: 'option',
        onmousedown: (e) => { e.preventDefault(); applyMention(i); },
        onmousemove: () => { if (mentionState.index !== i) { mentionState.index = i; renderMentionPopup(); } },
      },
      it.user ? avatarWithPresence(it.user, 'xs') : el('span', { class: 'mention-at' }, svg(ICONS.at)),
      el('span', {}, it.user ? it.user.displayName : it.label),
      el('small', { class: 'muted' }, it.user ? `@${it.user.username}` : it.hint))));
  }

  function handleMentionKey(e) {
    if (e.key === 'ArrowDown') { mentionState.index = (mentionState.index + 1) % mentionState.items.length; renderMentionPopup(); }
    else if (e.key === 'ArrowUp') { mentionState.index = (mentionState.index - 1 + mentionState.items.length) % mentionState.items.length; renderMentionPopup(); }
    else if (e.key === 'Enter' || e.key === 'Tab') applyMention(mentionState.index);
    else if (e.key === 'Escape') closeMentionPopup();
    else return false;
    e.preventDefault();
    return true;
  }

  function applyMention(i) {
    const it = mentionState.items[i];
    if (!it) return;
    const caret = input.selectionStart;
    const text = `@${it.insert} `;
    input.value = input.value.slice(0, mentionState.start) + text + input.value.slice(caret);
    const pos = mentionState.start + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    closeMentionPopup();
    autoGrow();
  }

  // ----- Digitando… ----------------------------------------------------------
  function onTyping({ scope, userId }) {
    const key = keyOf(scope);
    if (!state.typing.has(key)) state.typing.set(key, new Map());
    const map = state.typing.get(key);
    clearTimeout(map.get(userId));
    map.set(userId, setTimeout(() => clearTyping(key, userId), 4000));
    renderTyping();
  }
  function clearTyping(key, userId) {
    const map = state.typing.get(key);
    if (!map || !map.has(userId)) return;
    clearTimeout(map.get(userId));
    map.delete(userId);
    renderTyping();
  }
  function renderTyping() {
    const names = [...(state.typing.get(viewKey())?.keys() || [])].map(userName);
    $('#typing').textContent = !names.length ? ''
      : names.length === 1 ? `${names[0]} está digitando…`
      : names.length <= 3 ? `${names.join(', ')} estão digitando…` : 'Várias pessoas estão digitando…';
  }

  // ----- Notificações --------------------------------------------------------
  document.addEventListener('pointerdown', function askOnce() {
    document.removeEventListener('pointerdown', askOnce);
    if ('Notification' in window && Notification.permission === 'default' && !$('#app').hidden) {
      Notification.requestPermission().catch(() => {});
    }
  });

  function notify(m) {
    playTone('notify');
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden && document.hasFocus()) return;
    const author = state.users.get(m.author.id)?.displayName || m.author.name;
    const where = m.scope.type === 'dm' ? 'mensagem direta' : `#${channelById(m.scope.id)?.name || ''}`;
    try {
      const n = new Notification(`${author} (${where})`, { body: m.text.slice(0, 180), tag: keyOf(m.scope) });
      n.onclick = () => { window.focus(); openView(m.scope); n.close(); };
    } catch { /* navegador sem suporte */ }
  }

  // -------------------------------------------------------------------------
  // Voz / vídeo / tela
  // -------------------------------------------------------------------------
  async function joinCall(channelId) {
    if (state.call?.channelId === channelId) return openView({ type: 'voice', id: channelId });
    if (!window.RTCPeerConnection || !navigator.mediaDevices) {
      return toast('Seu navegador não suporta chamadas. Use Chrome, Edge ou Firefox atualizados (via HTTPS).', 'error');
    }
    if (state.call) leaveCall({ silent: true });
    $('#stage-join').disabled = true;

    state.socket.emit('voice:join', { channelId }, async (res) => {
      $('#stage-join').disabled = false;
      if (res?.error) return toast(res.error, 'error');

      const session = new window.UVozRTC.VoiceSession({
        myId: state.socket.id,
        iceServers: res.iceServers || state.iceServers,
        sendSignal: (to, data) => state.socket.emit('signal', { to, data }),
        onChange: scheduleStageRender,
      });
      state.call = { channelId, session };
      state.detector ||= new window.UVozRTC.SpeakingDetector(onSpeakingChange);

      const micOk = await session.startMic();
      if (!micOk) toast('Microfone indisponível — você entrou apenas ouvindo.', 'error');
      if (state.call?.session !== session) return session.close(); // saiu enquanto pedia permissão

      for (const peer of res.peers) {
        state.voice.set(peer.socketId, peer);
        session.ensurePeer(peer.socketId);
      }
      publishMedia();
      playTone('join');
      $('#voice-panel').hidden = false;
      $('#voice-panel-room').textContent = channelById(channelId)?.name || '';
      $('#panel-mic').disabled = false;
      openView({ type: 'voice', id: channelId });
    });
  }

  function leaveCall({ silent = false } = {}) {
    if (!state.call) return;
    state.call.session.close();
    state.call = null;
    state.focusedTile = null;
    state.detector && state.detector.clear();
    state.speaking.clear();
    if (state.socket?.connected) state.socket.emit('voice:leave', {});
    if (!silent) playTone('leave');
    $('#voice-panel').hidden = true;
    $('#panel-mic').disabled = true;
    $('#panel-mic').classList.remove('off');
    $('#stage-grid').replaceChildren();
    tiles.clear();
    renderStage();
    renderVoiceChannels();
  }

  function publishMedia() {
    if (!state.call) return;
    const media = state.call.session.mediaState();
    state.socket.emit('voice:media', media);
    const mine = state.voice.get(state.socket.id);
    if (mine) mine.media = media;
    updateControls();
    scheduleStageRender();
  }

  function updateControls() {
    const s = state.call?.session;
    const media = s ? s.mediaState() : { mic: false, cam: false, screen: false };
    $('#ctl-mic').classList.toggle('off', !media.mic);
    $('#panel-mic').classList.toggle('off', !!s && !media.mic);
    $('#ctl-cam').classList.toggle('off', !media.cam);
    $('#ctl-screen').classList.toggle('on', media.screen);
    $('#ctl-screen').querySelector('span').textContent = media.screen ? 'Parar' : 'Tela';
  }

  async function toggleMic() {
    const s = state.call?.session;
    if (!s) return;
    if (!s.micTrack) {
      const ok = await s.startMic();
      if (!ok) return toast('Não foi possível acessar o microfone. Verifique as permissões do navegador.', 'error');
    } else {
      s.setMicEnabled(!s.micEnabled);
    }
    playTone(s.micEnabled ? 'unmute' : 'mute');
    publishMedia();
  }

  async function toggleCam() {
    const s = state.call?.session;
    if (!s) return;
    if (s.camTrack) s.stopCamera();
    else {
      try { await s.startCamera(); } catch { return toast('Não foi possível acessar a câmera. Verifique as permissões do navegador.', 'error'); }
    }
    publishMedia();
  }

  async function toggleScreen() {
    const s = state.call?.session;
    if (!s) return;
    if (s.screen) s.stopScreen();
    else {
      if (!navigator.mediaDevices.getDisplayMedia) return toast('Compartilhamento de tela não é suportado neste dispositivo.', 'error');
      try {
        await s.startScreen();
        state.focusedTile = 'me:screen';
      } catch (err) {
        if (err?.name !== 'NotAllowedError') toast('Não foi possível compartilhar a tela.', 'error');
        return;
      }
    }
    publishMedia();
  }

  $('#stage-join').addEventListener('click', () => joinCall(state.view.id));
  $('#ctl-mic').addEventListener('click', toggleMic);
  $('#panel-mic').addEventListener('click', toggleMic);
  $('#ctl-cam').addEventListener('click', toggleCam);
  $('#ctl-screen').addEventListener('click', toggleScreen);
  $('#ctl-leave').addEventListener('click', () => leaveCall());
  $('#voice-panel-leave').addEventListener('click', () => leaveCall());
  $('#voice-panel-room').addEventListener('click', () => state.call && openView({ type: 'voice', id: state.call.channelId }));
  document.addEventListener('keydown', (e) => {
    if (!state.call || !(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() === 'd') { e.preventDefault(); toggleMic(); }
    if (e.key.toLowerCase() === 'e') { e.preventDefault(); toggleCam(); }
  });
  window.addEventListener('beforeunload', () => state.call && state.call.session.close());

  function onSpeakingChange(socketId, speaking) {
    if (speaking) state.speaking.add(socketId); else state.speaking.delete(socketId);
    const tile = tiles.get(`${socketId === state.socket?.id ? 'me' : socketId}:cam`);
    if (tile) tile.root.classList.toggle('speaking', speaking);
    document.querySelectorAll(`.voice-member[data-sid="${CSS.escape(socketId)}"]`)
      .forEach((n) => n.classList.toggle('speaking', speaking));
  }

  // ----- Palco (grade de vídeos) ---------------------------------------------
  const tiles = new Map(); // key -> { root, video, audio, label, stream, audioStream }
  let renderQueued = false;
  function scheduleStageRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderStage(); renderVoiceChannels(); });
  }

  // Não usa track.muted: o Chrome pode manter a trilha "muted" mesmo recebendo quadros após renegociações.
  // A fonte de verdade é o estado publicado pelo participante (câmera/tela ligada) + trilha ativa.
  const liveVideo = (stream) => !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');

  function desiredTiles() {
    const out = [];
    const s = state.call.session;
    const me = state.me;
    out.push({ key: 'me:cam', user: me, kind: 'cam', stream: s.main, showVideo: !!s.camTrack, local: true, muted: !s.mediaState().mic });
    if (s.screen) out.push({ key: 'me:screen', user: me, kind: 'screen', stream: s.screen, showVideo: true, local: true });

    for (const [peerId, peer] of s.peers) {
      const vs = state.voice.get(peerId);
      if (!vs || vs.channelId !== state.call.channelId) continue;
      const user = state.users.get(vs.userId) || { displayName: '?', color: '#80848e' };
      const media = vs.media || {};
      const camStream = (media.cameraStreamId && peer.streams.get(media.cameraStreamId))
        || [...peer.streams.values()].find((st) => st.id !== media.screenStreamId) || null;
      out.push({
        key: `${peerId}:cam`, sid: peerId, user, kind: 'cam', stream: camStream, audioStream: camStream,
        showVideo: !!media.cam && liveVideo(camStream), muted: !media.mic,
        connecting: !['connected', 'completed', 'new'].includes(peer.pc.connectionState),
      });
      if (media.screen) {
        const scr = media.screenStreamId ? peer.streams.get(media.screenStreamId) : null;
        out.push({ key: `${peerId}:screen`, sid: peerId, user, kind: 'screen', stream: scr, audioStream: scr, showVideo: liveVideo(scr) });
      }
    }
    return out;
  }

  function buildTile(t) {
    const video = el('video', { autoplay: true, playsinline: true, muted: true });
    video.muted = true;
    const audio = t.local ? null : el('audio', { autoplay: true });
    const label = el('div', { class: 'tile-label' });
    const fsBtn = el('button', { class: 'icon-btn tile-btn', title: 'Tela cheia', 'aria-label': 'Tela cheia' }, svg(ICONS.expand));
    const root = el('div', { class: `tile ${t.kind}`, dataset: { key: t.key } },
      video, el('div', { class: 'tile-avatar' }, avatar(t.user, 'xl')), audio, label,
      el('div', { class: 'tile-actions' }, fsBtn));
    root.addEventListener('click', (e) => {
      if (e.target.closest('.tile-btn')) return;
      state.focusedTile = state.focusedTile === t.key ? null : t.key;
      renderStage();
    });
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else root.requestFullscreen?.().catch(() => {});
    });
    return { root, video, audio, label, stream: null, audioStream: null };
  }

  function renderStage() {
    if (state.view?.type !== 'voice') return;
    const channel = channelById(state.view.id);
    if (!channel) return;
    const inThisRoom = state.call?.channelId === channel.id;
    $('#stage-empty').hidden = inThisRoom;
    $('#stage').hidden = !inThisRoom;

    if (!inThisRoom) {
      const members = voiceMembers(channel.id).map((v) => userName(v.userId));
      $('#stage-empty-title').textContent = channel.name;
      $('#stage-empty-members').textContent = members.length
        ? `Na sala: ${[...new Set(members)].join(', ')}`
        : 'Ninguém por aqui ainda. Entre e chame o time!';
      $('#stage-join').textContent = state.call ? 'Trocar para esta sala' : 'Entrar na sala';
      return;
    }

    const wanted = desiredTiles();
    const wantedKeys = new Set(wanted.map((t) => t.key));
    for (const [key, tile] of tiles) if (!wantedKeys.has(key)) { tile.root.remove(); tiles.delete(key); }
    if (state.focusedTile && !wantedKeys.has(state.focusedTile)) state.focusedTile = null;
    if (!state.focusedTile) {
      const screen = wanted.find((t) => t.kind === 'screen' && !t.local);
      if (screen) state.focusedTile = screen.key;
    }

    const grid = $('#stage-grid');
    grid.classList.toggle('focus-mode', !!state.focusedTile);
    grid.dataset.count = String(Math.min(wanted.length, 9));

    for (const t of wanted) {
      let tile = tiles.get(t.key);
      if (!tile) { tile = buildTile(t); tiles.set(t.key, tile); }
      if (tile.stream !== t.stream) { tile.stream = t.stream; tile.video.srcObject = t.stream || null; }
      if (tile.audio && tile.audioStream !== t.audioStream) {
        tile.audioStream = t.audioStream;
        tile.audio.srcObject = t.audioStream || null;
        tile.audio.play?.().catch(() => {});
      }
      if (t.showVideo && tile.video.paused) tile.video.play().catch(() => {});
      tile.root.classList.toggle('has-video', !!t.showVideo);
      tile.root.classList.toggle('mirror', !!t.local && t.kind === 'cam');
      tile.root.classList.toggle('focused', state.focusedTile === t.key);
      tile.root.classList.toggle('connecting', !!t.connecting);
      const sid = t.local ? state.socket.id : t.sid;
      tile.root.classList.toggle('speaking', t.kind === 'cam' && state.speaking.has(sid));
      tile.label.replaceChildren(...[
        t.muted && t.kind === 'cam' ? svg(ICONS.micOff, 'mini danger') : null,
        t.kind === 'screen' ? svg(ICONS.screen, 'mini') : null,
        t.kind === 'screen' ? `Tela de ${t.local ? 'você' : t.user.displayName}` : (t.local ? `${t.user.displayName} (você)` : t.user.displayName),
        t.connecting ? el('small', { class: 'muted' }, ' · conectando…') : null,
      ].filter(Boolean));
      if (state.focusedTile === t.key) grid.prepend(tile.root);
      else if (tile.root.parentNode !== grid) grid.append(tile.root);

      if (t.kind === 'cam' && state.detector) {
        if (t.local) state.detector.track(state.socket.id, state.call.session.main);
        else if (t.audioStream) state.detector.track(sid, t.audioStream);
      }
    }
    if (!state.focusedTile) for (const t of wanted) grid.append(tiles.get(t.key).root);
    updateControls();
  }

  // -------------------------------------------------------------------------
  // Sons curtos gerados via WebAudio
  // -------------------------------------------------------------------------
  let toneCtx = null;
  function playTone(kind) {
    try {
      toneCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const notes = { join: [523, 784], leave: [784, 523], mute: [440], unmute: [660], notify: [880, 1175] }[kind] || [600];
      let t = toneCtx.currentTime;
      for (const f of notes) {
        const o = toneCtx.createOscillator();
        const g = toneCtx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.connect(g).connect(toneCtx.destination);
        o.start(t);
        o.stop(t + 0.15);
        t += 0.1;
      }
    } catch { /* sem áudio */ }
  }

  // -------------------------------------------------------------------------
  // Início
  // -------------------------------------------------------------------------
  setAuthMode('login');
  const savedToken = storage.get('uvoz:token');
  if (savedToken) connect(savedToken);
})();
