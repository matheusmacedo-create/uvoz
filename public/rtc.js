/**
 * UVoz — camada WebRTC (malha P2P).
 *
 * Cada participante mantém uma RTCPeerConnection com cada outro participante
 * da sala. Usa o padrão "perfect negotiation" para lidar com renegociações
 * (ligar/desligar câmera, iniciar/parar compartilhamento de tela) sem colisões.
 *
 * Streams locais:
 *  - main:   microfone + câmera (id estável durante a sessão na sala)
 *  - screen: vídeo (+ áudio, quando o navegador permite) da tela compartilhada
 */
(function () {
  'use strict';

  class Peer {
    constructor(id, { polite, iceServers, sendSignal, onChange, onStuck, profile }) {
      this.id = id;
      this.profile = profile || (() => ({ cam: CAM_PROFILES[0], screen: SCREEN_PROFILES[0] }));
      this.tuned = new Map(); // RTCRtpSender -> { isScreen, track, busy, again }
      this.polite = polite;
      this.onStuck = onStuck || (() => {});
      this.createdAt = Date.now();
      this.sendSignal = sendSignal;
      this.onChange = onChange;
      this.makingOffer = false;
      this.ignoreOffer = false;
      this.streams = new Map(); // streamId -> MediaStream (remotas)
      this.senders = new Map(); // trackId -> RTCRtpSender (locais)
      this.pendingCandidates = []; // candidatos que chegaram antes da descrição remota
      this.lastNegotiation = Date.now();
      this.lastRestart = 0;
      this.disconnectedSince = 0;

      // Um único transporte para áudio, vídeo e tela: menos candidatos ICE e conexão mais rápida.
      const pc = (this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }));

      pc.onnegotiationneeded = async () => {
        this.lastNegotiation = Date.now();
        try {
          this.makingOffer = true;
          await pc.setLocalDescription();
          this.sendSignal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        } catch (err) {
          console.warn('[rtc] negotiationneeded', err);
        } finally {
          this.makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) this.sendSignal({ candidate: candidate.toJSON() });
      };

      pc.ontrack = ({ track, streams }) => {
        const stream = streams[0] || new MediaStream([track]);
        if (!this.streams.has(stream.id)) {
          this.streams.set(stream.id, stream);
          stream.addEventListener('removetrack', () => this.onChange());
          stream.addEventListener('addtrack', () => this.onChange());
        }
        track.addEventListener('unmute', () => this.onChange());
        track.addEventListener('mute', () => this.onChange());
        track.addEventListener('ended', () => this.onChange());
        this.onChange();
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') this.restartIce('failed');
        this.disconnectedSince = pc.connectionState === 'disconnected' ? (this.disconnectedSince || Date.now()) : 0;
        this.onChange();
      };

      // Vigia: se a conexão ficar parada (sem conectar) ou cair por alguns segundos, reinicia o ICE.
      this.watchdog = setInterval(() => {
        if (pc.signalingState === 'closed') return clearInterval(this.watchdog);
        const now = Date.now();
        const hasMedia = pc.getTransceivers().length > 0;
        const stuck = hasMedia && pc.signalingState === 'stable'
          && ['new', 'checking'].includes(pc.iceConnectionState) && now - this.lastNegotiation > 5000;
        const dropped = this.disconnectedSince && now - this.disconnectedSince > 5000;
        if (!stuck && !dropped) return;
        // Se já reiniciou o ICE e continua travada, recria a conexão do zero.
        if (this.lastRestart && now - this.lastRestart > 6000) {
          if (!this.polite) this.onStuck(this.id);
          return;
        }
        this.restartIce(stuck ? 'stuck' : 'disconnected');
      }, 2000);
    }

    restartIce(reason) {
      const now = Date.now();
      if (now - this.lastRestart < 8000) return;
      this.lastRestart = now;
      this.lastNegotiation = now;
      console.warn(`[rtc] reiniciando ICE com ${this.id} (${reason})`);
      try { this.pc.restartIce(); } catch { /* navegador antigo */ }
    }

    async flushCandidates() {
      const list = this.pendingCandidates.splice(0);
      for (const c of list) {
        try { await this.pc.addIceCandidate(c); } catch { /* candidato de uma oferta descartada */ }
      }
    }

    async handleSignal({ description, candidate }) {
      const pc = this.pc;
      try {
        if (description) {
          this.lastNegotiation = Date.now();
          const offerCollision =
            description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
          this.ignoreOffer = !this.polite && offerCollision;
          if (this.ignoreOffer) return;
          await pc.setRemoteDescription(description);
          await this.flushCandidates();
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            this.sendSignal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
          }
        } else if (candidate) {
          if (!pc.remoteDescription) {
            this.pendingCandidates.push(candidate);
            return;
          }
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            if (!this.ignoreOffer) console.warn('[rtc] candidato ignorado', err.message);
          }
        }
      } catch (err) {
        console.warn('[rtc] signal', err);
      }
    }

    addTrack(track, stream) {
      if (this.senders.has(track.id)) return;
      const sender = this.pc.addTrack(track, stream);
      this.senders.set(track.id, sender);
      if (track.kind === 'video') {
        this.tuned.set(sender, { isScreen: stream.__uvozKind === 'screen', track, busy: false, again: false, tries: 0 });
        this.tune(sender);
      }
    }

    /** Aplica o perfil atual (bitrate, resolução, fps) a um envio de vídeo. Seguro para chamar várias vezes. */
    tune(sender) {
      const info = this.tuned.get(sender);
      if (!info) return;
      if (info.busy) { info.again = true; return; } // setParameters em andamento: reaplica ao terminar
      let params;
      try { params = sender.getParameters(); } catch { return; }
      if (!params.encodings || !params.encodings.length) {
        // Os encodings só existem depois da negociação; tenta de novo lendo o perfil do momento.
        if (++info.tries < 20) setTimeout(() => this.tune(sender), 500);
        return;
      }
      const prof = this.profile()[info.isScreen ? 'screen' : 'cam'];
      const enc = params.encodings[0];
      let scale = 1;
      if (prof.maxHeight) {
        const h = info.track.getSettings?.().height || 0;
        if (h > prof.maxHeight) scale = h / prof.maxHeight;
      }
      const pref = info.isScreen ? 'maintain-resolution' : 'balanced';
      if (enc.maxBitrate === prof.maxBitrate && enc.maxFramerate === prof.maxFramerate
        && (enc.scaleResolutionDownBy || 1) === scale && params.degradationPreference === pref) return;
      enc.maxBitrate = prof.maxBitrate;
      enc.maxFramerate = prof.maxFramerate;
      enc.scaleResolutionDownBy = scale;
      params.degradationPreference = pref;
      info.busy = true;
      sender.setParameters(params).catch(() => {}).finally(() => {
        info.busy = false;
        if (info.again) { info.again = false; this.tune(sender); }
      });
    }

    retune() {
      for (const sender of this.tuned.keys()) this.tune(sender);
    }

    removeTrack(track) {
      const sender = this.senders.get(track.id);
      if (!sender) return;
      try { this.pc.removeTrack(sender); } catch { /* conexão já fechada */ }
      this.senders.delete(track.id);
      this.tuned.delete(sender);
    }

    replaceTrack(oldTrack, newTrack) {
      const sender = this.senders.get(oldTrack.id);
      if (!sender) return Promise.resolve();
      this.senders.delete(oldTrack.id);
      this.senders.set(newTrack.id, sender);
      return sender.replaceTrack(newTrack);
    }

    close() {
      clearInterval(this.watchdog);
      try { this.pc.close(); } catch { /* ignore */ }
      this.streams.clear();
      this.senders.clear();
      this.tuned.clear();
    }
  }

  // Numa malha P2P cada pessoa envia o vídeo uma vez para CADA participante, então a qualidade
  // por conexão precisa cair conforme a sala enche — senão o upload e a CPU de todos saturam.
  // Índice = perfil para "até N outras pessoas na sala".
  const CAM_PROFILES = [
    { upTo: 2, maxBitrate: 900_000, maxFramerate: 30, maxHeight: 720 },
    { upTo: 4, maxBitrate: 500_000, maxFramerate: 24, maxHeight: 480 },
    { upTo: Infinity, maxBitrate: 300_000, maxFramerate: 20, maxHeight: 360 },
  ];
  const SCREEN_PROFILES = [
    { upTo: 2, maxBitrate: 2_500_000, maxFramerate: 30, maxHeight: 1080 },
    { upTo: 4, maxBitrate: 1_500_000, maxFramerate: 15, maxHeight: 1080 },
    { upTo: Infinity, maxBitrate: 900_000, maxFramerate: 10, maxHeight: 1080 },
  ];
  const pickProfile = (list, peers) => list.find((p) => peers <= p.upTo);

  /**
   * Supressão de ruído com IA: GTCRN (rede neural leve, em WebAssembly) rodando num AudioWorklet,
   * precedido de um filtro passa-alta que tira ronco e zumbido da rede elétrica.
   * Recebe a faixa crua do microfone e devolve uma faixa já filtrada para enviar aos outros.
   */
  const NOISE_BASE = '/vendor/noise';
  let noiseLib = null; // Promise<{ GtcrnWorkletNode, wasmBinary }>

  function loadNoiseLib() {
    noiseLib ||= (async () => {
      const mod = await import(`${NOISE_BASE}/index.js`);
      const wasmBinary = await mod.loadGtcrn({ url: `${NOISE_BASE}/gtcrn.wasm` });
      return { GtcrnWorkletNode: mod.GtcrnWorkletNode, wasmBinary };
    })();
    noiseLib.catch(() => { noiseLib = null; }); // permite tentar de novo depois de uma falha de rede
    return noiseLib;
  }

  class NoiseSuppressor {
    static supported() {
      return !!(window.isSecureContext && window.AudioWorkletNode && window.WebAssembly);
    }

    async start(rawTrack) {
      const { GtcrnWorkletNode, wasmBinary } = await loadNoiseLib();
      // O GTCRN aceita 48 kHz (faz a conversão interna para 16 kHz).
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
      this.ctx = ctx;
      try {
        await ctx.audioWorklet.addModule(`${NOISE_BASE}/gtcrn/workletProcessor.js`);
        this.source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
        // Mistura para mono (o filtro só processa os canais que recebe) e corta abaixo de 90 Hz.
        this.highpass = new BiquadFilterNode(ctx, {
          type: 'highpass', frequency: 90, Q: 0.7,
          channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        });
        // wasmBinary é copiado para o worklet, então o mesmo buffer serve para várias instâncias.
        this.node = new GtcrnWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
        this.dest = ctx.createMediaStreamDestination();
        this.source.connect(this.highpass).connect(this.node).connect(this.dest);
        if (ctx.state === 'suspended') await ctx.resume();
        this.track = this.dest.stream.getAudioTracks()[0];
        return this.track;
      } catch (err) {
        this.stop();
        throw err;
      }
    }

    stop() {
      try { this.node && this.node.destroy(); } catch { /* ignore */ }
      try { this.source && this.source.disconnect(); } catch { /* ignore */ }
      if (this.track) this.track.stop();
      if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
      this.ctx = this.source = this.highpass = this.node = this.dest = this.track = null;
    }
  }

  /**
   * Gerencia a mídia local e as conexões com todos os participantes da sala.
   */
  class VoiceSession {
    constructor({ myId, iceServers, sendSignal, onChange, noiseSuppression = true }) {
      this.myId = myId;
      this.iceServers = iceServers;
      this.sendSignalRaw = sendSignal;
      this.onChange = onChange;
      this.peers = new Map();
      this.main = new MediaStream();
      this.main.__uvozKind = 'main';
      this.screen = null;
      this.rawMicTrack = null; // faixa crua do microfone
      this.micTrack = null;    // faixa enviada (filtrada pela IA ou a própria crua)
      this.noise = null;       // NoiseSuppressor ativo
      this.wantNoiseAI = noiseSuppression && NoiseSuppressor.supported();
      this.camTrack = null;
      this.micEnabled = false;
    }

    /** Pede o microfone ao navegador. Pode ser chamado antes de a sessão existir (em paralelo com a entrada). */
    static async captureMic(wantNoiseAI) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          autoGainControl: true,
          // Com a IA ligada, o filtro do navegador fica desligado para não processar o áudio duas vezes.
          noiseSuppression: !wantNoiseAI,
          channelCount: 1,
        },
        video: false,
      });
      return stream.getAudioTracks()[0];
    }

    /** Publica a faixa crua do microfone imediatamente (o filtro de ruído entra depois, por replaceTrack). */
    useMic(raw) {
      if (this.closed) { raw.stop(); return false; }
      if (this.rawMicTrack) { raw.stop(); return true; }
      this.rawMicTrack = raw;
      this.micTrack = raw;
      this.main.addTrack(raw);
      this.micEnabled = true;
      for (const peer of this.peers.values()) peer.addTrack(raw, this.main);
      return true;
    }

    async startMic() {
      try {
        return this.useMic(await VoiceSession.captureMic(this.wantNoiseAI));
      } catch (err) {
        console.warn('[rtc] microfone indisponível', err);
        return false;
      }
    }

    /** Monta a faixa que vai para os outros: filtrada pela IA quando possível, senão a crua. */
    async buildOutgoingTrack(raw) {
      if (!this.wantNoiseAI) return raw;
      const ns = new NoiseSuppressor();
      try {
        const track = await ns.start(raw);
        this.noise = ns;
        return track;
      } catch (err) {
        console.warn('[rtc] supressão de ruído indisponível, usando o filtro do navegador', err);
        this.wantNoiseAI = false;
        raw.applyConstraints({ noiseSuppression: true }).catch(() => {});
        return raw;
      }
    }

    get noiseAIActive() {
      return !!this.noise;
    }

    /** Liga/desliga a supressão de ruído com IA no meio da chamada, sem renegociar a conexão. */
    async setNoiseSuppression(on, { keepConstraints = false } = {}) {
      on = on && NoiseSuppressor.supported();
      this.wantNoiseAI = on;
      const raw = this.rawMicTrack;
      if (!raw || on === this.noiseAIActive) return this.noiseAIActive;

      const oldTrack = this.micTrack;
      const oldNoise = this.noise;
      this.noise = null;
      // keepConstraints: a faixa já foi capturada com o filtro do navegador no estado certo.
      if (!keepConstraints) await raw.applyConstraints({ noiseSuppression: !on }).catch(() => {});
      const newTrack = await this.buildOutgoingTrack(raw);
      if (this.rawMicTrack !== raw) { // a sessão foi encerrada enquanto montava
        if (this.noise) this.noise.stop();
        this.noise = null;
        return false;
      }
      newTrack.enabled = this.micEnabled;
      raw.enabled = this.micEnabled;
      await Promise.all([...this.peers.values()].map((p) => p.replaceTrack(oldTrack, newTrack).catch(() => {})));
      this.main.removeTrack(oldTrack);
      this.main.addTrack(newTrack);
      this.micTrack = newTrack;
      if (oldNoise) oldNoise.stop();
      this.onChange();
      return this.noiseAIActive;
    }

    setMicEnabled(enabled) {
      if (!this.micTrack) return false;
      this.micEnabled = enabled;
      this.micTrack.enabled = enabled;
      if (this.rawMicTrack) this.rawMicTrack.enabled = enabled;
      return true;
    }

    async startCamera() {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
        audio: false,
      });
      this.camTrack = stream.getVideoTracks()[0];
      this.camTrack.addEventListener('ended', () => { this.stopCamera(); this.onChange(); });
      this.main.addTrack(this.camTrack);
      for (const peer of this.peers.values()) peer.addTrack(this.camTrack, this.main);
    }

    /** Perfil de envio conforme o tamanho da sala (lido na hora por cada conexão). */
    currentProfile() {
      const n = this.peers.size;
      return { cam: pickProfile(CAM_PROFILES, n), screen: pickProfile(SCREEN_PROFILES, n) };
    }

    /** Reaplica o perfil em todas as conexões depois que alguém entra ou sai (agrupado para rajadas). */
    scheduleRetune() {
      clearTimeout(this.retuneTimer);
      this.retuneTimer = setTimeout(() => { for (const peer of this.peers.values()) peer.retune(); }, 300);
    }

    stopCamera() {
      if (!this.camTrack) return;
      for (const peer of this.peers.values()) peer.removeTrack(this.camTrack);
      this.main.removeTrack(this.camTrack);
      this.camTrack.stop();
      this.camTrack = null;
    }

    async startScreen() {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // Teto de 1080p: monitores 1440p/4K geravam um vídeo pesado demais para a malha.
        video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } },
        audio: true,
      });
      stream.__uvozKind = 'screen';
      const video = stream.getVideoTracks()[0];
      if (video && 'contentHint' in video) video.contentHint = 'detail';
      if (video) video.addEventListener('ended', () => { this.stopScreen(); this.onChange(); });
      this.screen = stream;
      for (const peer of this.peers.values()) {
        for (const track of stream.getTracks()) peer.addTrack(track, stream);
      }
    }

    stopScreen() {
      if (!this.screen) return;
      for (const track of this.screen.getTracks()) {
        for (const peer of this.peers.values()) peer.removeTrack(track);
        track.stop();
      }
      this.screen = null;
    }

    mediaState() {
      return {
        mic: !!this.micTrack && this.micEnabled,
        cam: !!this.camTrack,
        screen: !!this.screen,
        cameraStreamId: this.main.id,
        screenStreamId: this.screen ? this.screen.id : null,
      };
    }

    ensurePeer(peerId) {
      let peer = this.peers.get(peerId);
      if (peer) return peer;
      peer = new Peer(peerId, {
        polite: this.myId > peerId,
        iceServers: this.iceServers,
        sendSignal: (data) => this.sendSignalRaw(peerId, data),
        onChange: this.onChange,
        onStuck: (id) => this.resetPeer(id, true),
        profile: () => this.currentProfile(),
      });
      this.peers.set(peerId, peer);
      this.scheduleRetune();
      for (const track of this.main.getTracks()) peer.addTrack(track, this.main);
      if (this.screen) for (const track of this.screen.getTracks()) peer.addTrack(track, this.screen);
      return peer;
    }

    removePeer(peerId) {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      peer.close();
      this.peers.delete(peerId);
      this.scheduleRetune();
    }

    /** Fecha as conexões mas mantém microfone, câmera e tela (queda do servidor de sinalização). */
    dropPeers() {
      for (const peer of this.peers.values()) peer.close();
      this.peers.clear();
    }

    /** Depois de reconectar: novo id de socket e novas credenciais TURN para as próximas conexões. */
    reconnect({ myId, iceServers }) {
      this.dropPeers();
      this.myId = myId;
      if (iceServers) this.iceServers = iceServers;
    }

    /** Descarta e recria a conexão com um participante (o outro lado faz o mesmo ao receber "reset"). */
    resetPeer(peerId, notifyRemote) {
      const old = this.peers.get(peerId);
      if (old && Date.now() - old.createdAt < 4000) return; // acabou de ser recriada
      console.warn(`[rtc] recriando conexão com ${peerId}`);
      this.removePeer(peerId);
      if (notifyRemote) this.sendSignalRaw(peerId, { reset: true });
      this.ensurePeer(peerId);
      this.onChange();
    }

    handleSignal(from, data) {
      if (data && data.reset) return this.resetPeer(from, false);
      this.ensurePeer(from).handleSignal(data);
    }

    close() {
      this.closed = true;
      clearTimeout(this.retuneTimer);
      for (const peer of this.peers.values()) peer.close();
      this.peers.clear();
      this.stopScreen();
      this.stopCamera();
      if (this.noise) this.noise.stop();
      this.noise = null;
      if (this.micTrack) this.micTrack.stop();
      if (this.rawMicTrack) this.rawMicTrack.stop();
      this.micTrack = this.rawMicTrack = null;
    }
  }

  /**
   * Detecta quem está falando (para destacar o bloco/avatar).
   */
  class SpeakingDetector {
    constructor(onSpeakingChange) {
      this.onSpeakingChange = onSpeakingChange;
      this.entries = new Map(); // key -> { source, analyser, data, speaking, trackId, quietSince }
      this.ctx = null;
      this.timer = null;
    }

    track(key, stream) {
      const audioTrack = stream && stream.getAudioTracks().find((t) => t.readyState === 'live');
      const existing = this.entries.get(key);
      if (existing && audioTrack && existing.trackId === audioTrack.id) return;
      this.untrack(key);
      if (!audioTrack) return;
      try {
        this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        const source = this.ctx.createMediaStreamSource(new MediaStream([audioTrack]));
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        this.entries.set(key, {
          source, analyser, data: new Uint8Array(analyser.fftSize),
          speaking: false, trackId: audioTrack.id, track: audioTrack, quietSince: 0,
        });
        this.start();
      } catch (err) {
        console.warn('[rtc] detector de fala', err);
      }
    }

    untrack(key) {
      const entry = this.entries.get(key);
      if (!entry) return;
      try { entry.source.disconnect(); } catch { /* ignore */ }
      this.entries.delete(key);
      if (entry.speaking) this.onSpeakingChange(key, false);
    }

    start() {
      if (this.timer) return;
      this.timer = setInterval(() => this.poll(), 120);
    }

    poll() {
      const now = performance.now();
      for (const [key, e] of this.entries) {
        e.analyser.getByteTimeDomainData(e.data);
        let sum = 0;
        for (let i = 0; i < e.data.length; i++) {
          const v = (e.data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / e.data.length);
        const loud = rms > 0.02 && e.track.enabled;
        if (loud) {
          e.quietSince = 0;
          if (!e.speaking) { e.speaking = true; this.onSpeakingChange(key, true); }
        } else if (e.speaking) {
          e.quietSince ||= now;
          if (now - e.quietSince > 350) { e.speaking = false; this.onSpeakingChange(key, false); }
        }
      }
      if (!this.entries.size) {
        clearInterval(this.timer);
        this.timer = null;
        if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); // libera a thread de áudio
      }
    }

    clear() {
      for (const key of [...this.entries.keys()]) this.untrack(key);
    }
  }

  window.UVozRTC = { VoiceSession, SpeakingDetector, NoiseSuppressor, preloadNoise: () => { if (NoiseSuppressor.supported()) loadNoiseLib().catch(() => {}); } };
})();
