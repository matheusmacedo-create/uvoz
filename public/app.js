/* UVoz — front-end principal (chat, canais, salas de voz/vídeo, tela). */
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
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    pin: '<path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/>',
  };

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------
  const state = {
    socket: null,
    me: null,
    channels: [],
    users: new Map(),
    iceServers: [],
    viewChannelId: null,
    lastTextChannelId: null,
    messages: new Map(),
    unread: new Set(),
    typing: new Map(), // channelId -> Map(name -> timeout)
    voice: null, // { channelId, session }
    speaking: new Set(), // chaves "userId" de quem está falando
    focusedTile: null,
    detector: null,
  };

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

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
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
  }

  function avatar(user, size = '') {
    return el('div', { class: `avatar ${size}`, style: `background:${user.color}` }, initials(user.name));
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

  const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
  function richText(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      frag.append(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  const channelById = (id) => state.channels.find((c) => c.id === id);
  const voiceMembers = (channelId) => [...state.users.values()].filter((u) => u.voiceChannelId === channelId);

  // -------------------------------------------------------------------------
  // Login / conexão
  // -------------------------------------------------------------------------
  const loginForm = $('#login-form');
  $('#login-name').value = storage.get('uvoz:name') || '';
  $('#login-code').value = storage.get('uvoz:code') || '';

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#login-name').value.trim();
    const code = $('#login-code').value;
    if (!name) return;
    connect(name, code);
  });

  if (storage.get('uvoz:name')) connect(storage.get('uvoz:name'), storage.get('uvoz:code') || '');

  function connect(name, code) {
    $('#login-error').textContent = '';
    const btn = loginForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Conectando…';

    if (state.socket) state.socket.disconnect();
    const socket = (state.socket = io({ auth: { name, code }, transports: ['websocket', 'polling'] }));

    socket.on('connect_error', (err) => {
      btn.disabled = false;
      btn.textContent = 'Entrar';
      const msg = {
        CODIGO_INVALIDO: 'Código de acesso inválido.',
        NOME_OBRIGATORIO: 'Informe seu nome.',
      }[err.message];
      if (msg) {
        socket.disconnect();
        storage.del('uvoz:code');
        showLogin();
        $('#login-error').textContent = msg;
      } else if ($('#app').hidden) {
        $('#login-error').textContent = 'Não foi possível conectar ao servidor. Tentando novamente…';
      }
    });

    socket.on('init', (data) => {
      btn.disabled = false;
      btn.textContent = 'Entrar';
      storage.set('uvoz:name', name);
      storage.set('uvoz:code', code);
      onInit(data);
    });

    socket.on('disconnect', (reason) => {
      if (state.voice) {
        leaveVoice({ silent: true });
        toast('Conexão perdida — você saiu da sala de voz.', 'error');
      }
      if (reason !== 'io client disconnect') $('#me-status').textContent = 'Reconectando…';
    });

    socket.on('user:online', (u) => { state.users.set(u.id, u); renderMembers(); renderVoiceChannels(); });
    socket.on('user:offline', ({ id }) => { state.users.delete(id); renderMembers(); renderVoiceChannels(); });
    socket.on('user:update', onUserUpdate);

    socket.on('channel:created', (c) => {
      if (!channelById(c.id)) state.channels.push(c);
      renderChannels();
    });
    socket.on('channel:deleted', ({ channelId }) => {
      state.channels = state.channels.filter((c) => c.id !== channelId);
      state.messages.delete(channelId);
      if (state.voice && state.voice.channelId === channelId) leaveVoice({ silent: true });
      if (state.viewChannelId === channelId) {
        const first = state.channels.find((c) => c.type === 'text');
        if (first) openChannel(first.id);
      }
      renderChannels();
    });

    socket.on('message:new', onMessage);
    socket.on('typing', onTyping);

    socket.on('voice:peer-joined', (u) => {
      state.users.set(u.id, u);
      if (state.voice) state.voice.session.ensurePeer(u.id);
      playTone('join');
      renderStage();
    });
    socket.on('voice:peer-left', ({ id }) => {
      if (state.voice) state.voice.session.removePeer(id);
      state.detector && state.detector.untrack(id);
      playTone('leave');
      renderStage();
    });
    socket.on('signal', ({ from, data }) => {
      if (state.voice) state.voice.session.handleSignal(from, data);
    });
  }

  function showLogin() {
    $('#login').hidden = false;
    $('#app').hidden = true;
  }

  function onInit(data) {
    state.me = data.me;
    state.channels = data.channels;
    state.iceServers = data.iceServers;
    state.users = new Map(data.users.map((u) => [u.id, u]));
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#me-name').textContent = state.me.name;
    $('#me-status').textContent = 'Online';
    $('#me-avatar').replaceChildren(initials(state.me.name));
    $('#me-avatar').style.background = state.me.color;
    state.messages.clear();
    renderChannels();
    renderMembers();
    const start = channelById(state.viewChannelId) ? state.viewChannelId
      : (channelById(storage.get('uvoz:channel')) ? storage.get('uvoz:channel') : state.channels.find((c) => c.type === 'text')?.id);
    if (start) openChannel(start);
  }

  function onUserUpdate(u) {
    const prev = state.users.get(u.id);
    state.users.set(u.id, u);
    if (u.id === state.me?.id) state.me = u;
    renderVoiceChannels();
    renderMembers();
    const relevant = state.viewChannelId && (u.voiceChannelId === state.viewChannelId || prev?.voiceChannelId === state.viewChannelId);
    if (relevant || (state.voice && (u.voiceChannelId === state.voice.channelId))) renderStage();
  }

  $('#logout').addEventListener('click', () => {
    leaveVoice({ silent: true });
    storage.del('uvoz:name');
    storage.del('uvoz:code');
    state.socket && state.socket.disconnect();
    state.socket = null;
    showLogin();
  });

  // -------------------------------------------------------------------------
  // Canais
  // -------------------------------------------------------------------------
  function renderChannels() {
    renderTextChannels();
    renderVoiceChannels();
  }

  function deleteButton(channel) {
    return el('button', {
      class: 'icon-btn small channel-delete', title: 'Excluir canal', 'aria-label': `Excluir ${channel.name}`,
      onclick: (e) => {
        e.stopPropagation();
        if (!confirm(`Excluir "${channel.name}"? O histórico será apagado.`)) return;
        state.socket.emit('channel:delete', { channelId: channel.id }, (res) => res?.error && toast(res.error, 'error'));
      },
    }, svg(ICONS.trash));
  }

  function renderTextChannels() {
    const list = $('#text-channels');
    list.replaceChildren(...state.channels.filter((c) => c.type === 'text').map((c) =>
      el('li', {},
        el('div', {
          class: `channel ${state.viewChannelId === c.id ? 'active' : ''} ${state.unread.has(c.id) ? 'unread' : ''}`,
          role: 'button', tabindex: 0,
          onclick: () => openChannel(c.id),
          onkeydown: (e) => e.key === 'Enter' && openChannel(c.id),
        },
        el('span', { class: 'channel-icon' }, '#'),
        el('span', { class: 'channel-name' }, c.name),
        deleteButton(c)))));
  }

  function renderVoiceChannels() {
    const list = $('#voice-channels');
    list.replaceChildren(...state.channels.filter((c) => c.type === 'voice').map((c) => {
      const members = voiceMembers(c.id);
      const inThis = state.voice?.channelId === c.id;
      return el('li', {},
        el('div', {
          class: `channel ${state.viewChannelId === c.id ? 'active' : ''} ${inThis ? 'connected' : ''}`,
          role: 'button', tabindex: 0,
          onclick: () => openChannel(c.id),
          ondblclick: () => joinVoice(c.id),
          onkeydown: (e) => e.key === 'Enter' && openChannel(c.id),
        },
        el('span', { class: 'channel-icon' }, svg(ICONS.speaker)),
        el('span', { class: 'channel-name' }, c.name),
        members.length ? el('span', { class: 'channel-count' }, members.length) : null,
        deleteButton(c)),
        members.length ? el('ul', { class: 'voice-members' }, members.map((u) =>
          el('li', { class: `voice-member ${state.speaking.has(u.id) ? 'speaking' : ''}`, dataset: { uid: u.id } },
            avatar(u, 'xs'),
            el('span', { class: 'voice-member-name' }, u.name),
            el('span', { class: 'voice-member-icons' },
              u.media?.screen ? el('span', { class: 'badge-live', title: 'Compartilhando tela' }, 'AO VIVO') : null,
              u.media?.cam ? svg(ICONS.cam, 'mini') : null,
              !u.media?.mic ? svg(ICONS.micOff, 'mini danger') : null)))) : null);
    }));
  }

  function openChannel(channelId) {
    const channel = channelById(channelId);
    if (!channel) return;
    state.viewChannelId = channelId;
    storage.set('uvoz:channel', channelId);
    $('#sidebar').classList.remove('open');
    $('#header-title').textContent = channel.name;
    if (channel.type === 'text') {
      state.lastTextChannelId = channelId;
      state.unread.delete(channelId);
      $('#header-icon').replaceChildren('#');
      $('#header-topic').textContent = channel.topic || '';
      $('#chat-view').hidden = false;
      $('#stage-view').hidden = true;
      $('#composer-input').placeholder = `Conversar em #${channel.name}`;
      loadMessages(channelId);
      renderTyping();
      setTimeout(() => $('#composer-input').focus(), 0);
    } else {
      $('#header-icon').replaceChildren(svg(ICONS.speaker));
      $('#header-topic').textContent = 'Sala de voz e vídeo';
      $('#chat-view').hidden = true;
      $('#stage-view').hidden = false;
      renderStage();
    }
    renderChannels();
  }

  // Criação de canais
  const dialog = $('#create-dialog');
  let createType = 'text';
  document.querySelectorAll('[data-create]').forEach((btn) => btn.addEventListener('click', () => {
    createType = btn.dataset.create;
    $('#create-title').textContent = createType === 'text' ? 'Criar canal de texto' : 'Criar sala de voz e vídeo';
    $('#create-topic-wrap').hidden = createType !== 'text';
    $('#create-name').value = '';
    $('#create-topic').value = '';
    $('#create-name').placeholder = createType === 'text' ? 'novo-canal' : 'Nova sala';
    dialog.showModal();
  }));
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'ok') return;
    const name = $('#create-name').value.trim();
    if (!name) return;
    state.socket.emit('channel:create', { name, type: createType, topic: $('#create-topic').value }, (res) => {
      if (res?.error) return toast(res.error, 'error');
      openChannel(res.channel.id);
    });
  });

  // -------------------------------------------------------------------------
  // Chat de texto
  // -------------------------------------------------------------------------
  function loadMessages(channelId) {
    if (state.messages.has(channelId)) return renderMessages();
    $('#messages').replaceChildren(el('div', { class: 'messages-loading muted' }, 'Carregando mensagens…'));
    state.socket.emit('messages:get', { channelId }, (res) => {
      if (res?.error) return toast(res.error, 'error');
      state.messages.set(channelId, res.messages);
      if (state.viewChannelId === channelId) renderMessages();
    });
  }

  function messageNode(m, grouped) {
    if (grouped) {
      return el('div', { class: 'msg grouped', dataset: { id: m.id } },
        el('span', { class: 'msg-hover-time' }, new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })),
        el('div', { class: 'msg-text' }, richText(m.text)));
    }
    return el('div', { class: 'msg', dataset: { id: m.id } },
      avatar(m.author),
      el('div', { class: 'msg-body' },
        el('div', { class: 'msg-head' },
          el('strong', { style: `color:${m.author.color}` }, m.author.name),
          el('time', { class: 'muted' }, fmtTime(m.ts))),
        el('div', { class: 'msg-text' }, richText(m.text))));
  }

  const isGrouped = (prev, m) => prev && prev.author.name === m.author.name && m.ts - prev.ts < 5 * 60 * 1000;

  function renderMessages() {
    const channel = channelById(state.viewChannelId);
    const list = state.messages.get(state.viewChannelId) || [];
    const box = $('#messages');
    const nodes = [el('div', { class: 'messages-welcome' },
      el('div', { class: 'welcome-icon' }, '#'),
      el('h2', {}, `Bem-vindo(a) a #${channel.name}!`),
      el('p', { class: 'muted' }, channel.topic || 'Este é o começo do canal.'))];
    list.forEach((m, i) => nodes.push(messageNode(m, isGrouped(list[i - 1], m))));
    box.replaceChildren(...nodes);
    box.scrollTop = box.scrollHeight;
  }

  function onMessage(m) {
    const list = state.messages.get(m.channelId);
    if (list) list.push(m);
    if (state.viewChannelId === m.channelId && list) {
      const box = $('#messages');
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      box.append(messageNode(m, isGrouped(list[list.length - 2], m)));
      if (nearBottom || m.author.name === state.me.name) box.scrollTop = box.scrollHeight;
      clearTyping(m.channelId, m.author.name);
    } else if (m.author.name !== state.me.name) {
      state.unread.add(m.channelId);
      renderTextChannels();
    }
  }

  const input = $('#composer-input');
  let lastTypingSent = 0;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    if (Date.now() - lastTypingSent > 2500 && input.value.trim()) {
      lastTypingSent = Date.now();
      state.socket.emit('typing', { channelId: state.viewChannelId });
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    state.socket.emit('message:send', { channelId: state.viewChannelId, text }, (res) => {
      if (res?.error) toast(res.error, 'error');
    });
    input.value = '';
    input.style.height = 'auto';
    lastTypingSent = 0;
  });

  function onTyping({ channelId, name }) {
    if (!state.typing.has(channelId)) state.typing.set(channelId, new Map());
    const map = state.typing.get(channelId);
    clearTimeout(map.get(name));
    map.set(name, setTimeout(() => clearTyping(channelId, name), 4000));
    renderTyping();
  }
  function clearTyping(channelId, name) {
    const map = state.typing.get(channelId);
    if (!map) return;
    clearTimeout(map.get(name));
    map.delete(name);
    renderTyping();
  }
  function renderTyping() {
    const names = [...(state.typing.get(state.viewChannelId)?.keys() || [])];
    $('#typing').textContent = !names.length ? ''
      : names.length === 1 ? `${names[0]} está digitando…`
      : names.length <= 3 ? `${names.join(', ')} estão digitando…` : 'Várias pessoas estão digitando…';
  }

  // -------------------------------------------------------------------------
  // Membros
  // -------------------------------------------------------------------------
  function renderMembers() {
    const all = [...state.users.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    $('#members-title').textContent = `Online — ${all.length}`;
    $('#member-list').replaceChildren(...all.map((u) => {
      const room = u.voiceChannelId && channelById(u.voiceChannelId);
      return el('li', { class: 'member' },
        el('div', { class: 'avatar-wrap' }, avatar(u, 'sm'), el('span', { class: 'presence' })),
        el('div', { class: 'member-info' },
          el('span', {}, u.name, u.id === state.me?.id ? el('small', { class: 'muted' }, ' (você)') : null),
          room ? el('small', { class: 'muted member-room' }, svg(ICONS.speaker, 'mini'), room.name) : null));
    }));
  }

  $('#toggle-members').addEventListener('click', () => {
    document.body.classList.toggle('hide-members');
  });
  $('#toggle-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // -------------------------------------------------------------------------
  // Voz / vídeo / tela
  // -------------------------------------------------------------------------
  async function joinVoice(channelId) {
    if (state.voice?.channelId === channelId) return openChannel(channelId);
    if (!window.RTCPeerConnection || !navigator.mediaDevices) {
      return toast('Seu navegador não suporta chamadas. Use Chrome, Edge ou Firefox atualizados (via HTTPS).', 'error');
    }
    if (state.voice) leaveVoice({ silent: true });
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
      state.voice = { channelId, session };
      state.detector ||= new window.UVozRTC.SpeakingDetector(onSpeakingChange);

      const micOk = await session.startMic();
      if (!micOk) toast('Microfone indisponível — você entrou apenas ouvindo.', 'error');
      if (state.voice?.session !== session) return session.close(); // saiu enquanto pedia permissão

      for (const peer of res.peers) {
        state.users.set(peer.id, { ...state.users.get(peer.id), ...peer });
        session.ensurePeer(peer.id);
      }
      publishMedia();
      playTone('join');
      $('#voice-panel').hidden = false;
      $('#voice-panel-room').textContent = channelById(channelId)?.name || '';
      $('#panel-mic').disabled = false;
      openChannel(channelId);
    });
  }

  function leaveVoice({ silent = false } = {}) {
    if (!state.voice) return;
    state.voice.session.close();
    state.voice = null;
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
    if (!state.voice) return;
    const media = state.voice.session.mediaState();
    state.socket.emit('voice:media', media);
    const me = state.users.get(state.socket.id);
    if (me) me.media = media;
    updateControls();
    scheduleStageRender();
  }

  function updateControls() {
    const s = state.voice?.session;
    const media = s ? s.mediaState() : { mic: false, cam: false, screen: false };
    $('#ctl-mic').classList.toggle('off', !media.mic);
    $('#panel-mic').classList.toggle('off', !!s && !media.mic);
    $('#ctl-cam').classList.toggle('off', !media.cam);
    $('#ctl-screen').classList.toggle('on', media.screen);
    $('#ctl-screen').querySelector('span').textContent = media.screen ? 'Parar' : 'Tela';
  }

  async function toggleMic() {
    const s = state.voice?.session;
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
    const s = state.voice?.session;
    if (!s) return;
    if (s.camTrack) {
      s.stopCamera();
    } else {
      try {
        await s.startCamera();
      } catch (err) {
        return toast('Não foi possível acessar a câmera. Verifique as permissões do navegador.', 'error');
      }
    }
    publishMedia();
  }

  async function toggleScreen() {
    const s = state.voice?.session;
    if (!s) return;
    if (s.screen) {
      s.stopScreen();
    } else {
      if (!navigator.mediaDevices.getDisplayMedia) {
        return toast('Compartilhamento de tela não é suportado neste dispositivo.', 'error');
      }
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

  $('#stage-join').addEventListener('click', () => joinVoice(state.viewChannelId));
  $('#ctl-mic').addEventListener('click', toggleMic);
  $('#panel-mic').addEventListener('click', toggleMic);
  $('#ctl-cam').addEventListener('click', toggleCam);
  $('#ctl-screen').addEventListener('click', toggleScreen);
  $('#ctl-leave').addEventListener('click', () => leaveVoice());
  $('#voice-panel-leave').addEventListener('click', () => leaveVoice());
  $('#voice-panel-room').addEventListener('click', () => state.voice && openChannel(state.voice.channelId));
  document.addEventListener('keydown', (e) => {
    if (!state.voice || !(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() === 'd') { e.preventDefault(); toggleMic(); }
    if (e.key.toLowerCase() === 'e') { e.preventDefault(); toggleCam(); }
  });
  window.addEventListener('beforeunload', () => state.voice && state.voice.session.close());

  function onSpeakingChange(key, speaking) {
    if (speaking) state.speaking.add(key); else state.speaking.delete(key);
    const tile = tiles.get(`${key === state.socket?.id ? 'me' : key}:cam`);
    if (tile) tile.root.classList.toggle('speaking', speaking);
    document.querySelectorAll(`.voice-member[data-uid="${CSS.escape(key)}"]`)
      .forEach((n) => n.classList.toggle('speaking', speaking));
  }

  // ----- Renderização do palco (grade de vídeos) ---------------------------
  const tiles = new Map(); // key -> { root, video, audio, label, stream }
  let renderQueued = false;
  function scheduleStageRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderStage(); renderVoiceChannels(); });
  }

  const liveVideo = (stream) => !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);

  function desiredTiles() {
    const out = [];
    const s = state.voice.session;
    const myId = state.socket.id;
    const me = state.users.get(myId) || state.me;
    out.push({ key: 'me:cam', user: me, kind: 'cam', stream: s.main, showVideo: !!s.camTrack, local: true, muted: !s.mediaState().mic });
    if (s.screen) out.push({ key: 'me:screen', user: me, kind: 'screen', stream: s.screen, showVideo: true, local: true });

    for (const [peerId, peer] of s.peers) {
      const user = state.users.get(peerId);
      if (!user || user.voiceChannelId !== state.voice.channelId) continue;
      const media = user.media || {};
      const camStream = (media.cameraStreamId && peer.streams.get(media.cameraStreamId))
        || [...peer.streams.values()].find((st) => st.id !== media.screenStreamId) || null;
      out.push({
        key: `${peerId}:cam`, user, kind: 'cam', stream: camStream, audioStream: camStream,
        showVideo: !!media.cam && liveVideo(camStream), muted: !media.mic,
        connecting: !['connected', 'completed'].includes(peer.pc.connectionState) && peer.pc.connectionState !== 'new',
      });
      if (media.screen) {
        const scr = media.screenStreamId ? peer.streams.get(media.screenStreamId) : null;
        out.push({ key: `${peerId}:screen`, user, kind: 'screen', stream: scr, audioStream: scr, showVideo: liveVideo(scr) });
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
      video,
      el('div', { class: 'tile-avatar' }, avatar(t.user, 'xl')),
      audio, label,
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
    const channel = channelById(state.viewChannelId);
    if (!channel || channel.type !== 'voice') return;
    const inThisRoom = state.voice?.channelId === channel.id;
    $('#stage-empty').hidden = inThisRoom;
    $('#stage').hidden = !inThisRoom;

    if (!inThisRoom) {
      const members = voiceMembers(channel.id);
      $('#stage-empty-title').textContent = channel.name;
      $('#stage-empty-members').textContent = members.length
        ? `Na sala: ${members.map((m) => m.name).join(', ')}`
        : 'Ninguém por aqui ainda. Entre e chame o time!';
      $('#stage-join').textContent = state.voice ? 'Trocar para esta sala' : 'Entrar na sala';
      return;
    }

    const wanted = desiredTiles();
    const wantedKeys = new Set(wanted.map((t) => t.key));
    for (const [key, tile] of tiles) {
      if (!wantedKeys.has(key)) { tile.root.remove(); tiles.delete(key); }
    }
    if (state.focusedTile && !wantedKeys.has(state.focusedTile)) state.focusedTile = null;
    // Foca automaticamente numa tela compartilhada quando surge.
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
      if (tile.stream !== t.stream) {
        tile.stream = t.stream;
        tile.video.srcObject = t.stream || null;
      }
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
      const userKey = t.local ? state.socket.id : t.key.split(':')[0];
      tile.root.classList.toggle('speaking', t.kind === 'cam' && state.speaking.has(userKey));
      tile.label.replaceChildren(...[
        t.muted && t.kind === 'cam' ? svg(ICONS.micOff, 'mini danger') : null,
        t.kind === 'screen' ? svg(ICONS.screen, 'mini') : null,
        t.kind === 'screen' ? `Tela de ${t.local ? 'você' : t.user.name}` : (t.local ? `${t.user.name} (você)` : t.user.name),
        t.connecting ? el('small', { class: 'muted' }, ' · conectando…') : null,
      ].filter(Boolean));
      // Ordem: foco primeiro.
      if (state.focusedTile === t.key) grid.prepend(tile.root);
      else if (tile.root.parentNode !== grid) grid.append(tile.root);

      // Detector de fala (áudio do microfone).
      if (t.kind === 'cam' && state.detector) {
        if (t.local) state.detector.track(state.socket.id, state.voice.session.main);
        else if (t.audioStream) state.detector.track(userKey, t.audioStream);
      }
    }
    // Reordena para manter a ordem estável quando não há foco.
    if (!state.focusedTile) for (const t of wanted) grid.append(tiles.get(t.key).root);
    updateControls();
  }

  // -------------------------------------------------------------------------
  // Sons curtos (entrar/sair/mutar) gerados via WebAudio
  // -------------------------------------------------------------------------
  let toneCtx = null;
  function playTone(kind) {
    try {
      toneCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const notes = { join: [523, 784], leave: [784, 523], mute: [440], unmute: [660] }[kind] || [600];
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
})();
