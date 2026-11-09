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
    constructor(id, { polite, iceServers, sendSignal, onChange }) {
      this.id = id;
      this.polite = polite;
      this.sendSignal = sendSignal;
      this.onChange = onChange;
      this.makingOffer = false;
      this.ignoreOffer = false;
      this.streams = new Map(); // streamId -> MediaStream (remotas)
      this.senders = new Map(); // trackId -> RTCRtpSender (locais)

      const pc = (this.pc = new RTCPeerConnection({ iceServers }));

      pc.onnegotiationneeded = async () => {
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
        if (pc.connectionState === 'failed') {
          try { pc.restartIce(); } catch { /* navegador antigo */ }
        }
        this.onChange();
      };
    }

    async handleSignal({ description, candidate }) {
      const pc = this.pc;
      try {
        if (description) {
          const offerCollision =
            description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
          this.ignoreOffer = !this.polite && offerCollision;
          if (this.ignoreOffer) return;
          await pc.setRemoteDescription(description);
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            this.sendSignal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
          }
        } else if (candidate) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            if (!this.ignoreOffer) throw err;
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
      if (track.kind === 'video') tuneSender(sender, stream.__uvozKind === 'screen');
    }

    removeTrack(track) {
      const sender = this.senders.get(track.id);
      if (!sender) return;
      try { this.pc.removeTrack(sender); } catch { /* conexão já fechada */ }
      this.senders.delete(track.id);
    }

    replaceTrack(oldTrack, newTrack) {
      const sender = this.senders.get(oldTrack.id);
      if (!sender) return Promise.resolve();
      this.senders.delete(oldTrack.id);
      this.senders.set(newTrack.id, sender);
      return sender.replaceTrack(newTrack);
    }

    close() {
      try { this.pc.close(); } catch { /* ignore */ }
      this.streams.clear();
      this.senders.clear();
    }
  }

  // Limita o bitrate para que a malha aguente vários participantes.
  function tuneSender(sender, isScreen) {
    const apply = () => {
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) return false;
        params.encodings[0].maxBitrate = isScreen ? 2_500_000 : 900_000;
        if (isScreen) params.degradationPreference = 'maintain-resolution';
        sender.setParameters(params).catch(() => {});
        return true;
      } catch {
        return true;
      }
    };
    // Os encodings só existem depois da negociação; tenta algumas vezes.
    let tries = 0;
    const tick = () => { if (!apply() && ++tries < 20) setTimeout(tick, 500); };
    tick();
  }

  /**
   * Gerencia a mídia local e as conexões com todos os participantes da sala.
   */
  class VoiceSession {
    constructor({ myId, iceServers, sendSignal, onChange }) {
      this.myId = myId;
      this.iceServers = iceServers;
      this.sendSignalRaw = sendSignal;
      this.onChange = onChange;
      this.peers = new Map();
      this.main = new MediaStream();
      this.main.__uvozKind = 'main';
      this.screen = null;
      this.micTrack = null;
      this.camTrack = null;
      this.micEnabled = false;
    }

    async startMic() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        this.micTrack = stream.getAudioTracks()[0];
        this.main.addTrack(this.micTrack);
        this.micEnabled = true;
        for (const peer of this.peers.values()) peer.addTrack(this.micTrack, this.main);
        return true;
      } catch (err) {
        console.warn('[rtc] microfone indisponível', err);
        return false;
      }
    }

    setMicEnabled(enabled) {
      if (!this.micTrack) return false;
      this.micEnabled = enabled;
      this.micTrack.enabled = enabled;
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

    stopCamera() {
      if (!this.camTrack) return;
      for (const peer of this.peers.values()) peer.removeTrack(this.camTrack);
      this.main.removeTrack(this.camTrack);
      this.camTrack.stop();
      this.camTrack = null;
    }

    async startScreen() {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
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
      });
      this.peers.set(peerId, peer);
      for (const track of this.main.getTracks()) peer.addTrack(track, this.main);
      if (this.screen) for (const track of this.screen.getTracks()) peer.addTrack(track, this.screen);
      return peer;
    }

    removePeer(peerId) {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      peer.close();
      this.peers.delete(peerId);
    }

    handleSignal(from, data) {
      this.ensurePeer(from).handleSignal(data);
    }

    close() {
      for (const peer of this.peers.values()) peer.close();
      this.peers.clear();
      this.stopScreen();
      this.stopCamera();
      if (this.micTrack) this.micTrack.stop();
      this.micTrack = null;
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
      if (!this.entries.size) { clearInterval(this.timer); this.timer = null; }
    }

    clear() {
      for (const key of [...this.entries.keys()]) this.untrack(key);
    }
  }

  window.UVozRTC = { VoiceSession, SpeakingDetector };
})();
