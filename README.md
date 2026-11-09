# UVoz — o "Discord" da Unicopag

Plataforma de comunicação interna com:

- **Canais de texto**: histórico salvo, "fulano está digitando…", links clicáveis e marcação de não lidas.
- **Salas de voz e vídeo em grupo**: microfone, câmera e indicador de quem está falando.
- **Compartilhamento de tela** (com áudio do sistema/aba quando o navegador permite). A tela compartilhada ganha destaque automaticamente.
- **Presença**: quem está online e em qual sala, com ícones de câmera, microfone mudo e selo "AO VIVO".
- Criação e exclusão de canais e salas, modo foco e tela cheia por participante, atalhos `Ctrl+D` (microfone) e `Ctrl+E` (câmera), layout responsivo para celular.

## Como funciona

```
Navegador ──WebSocket (Socket.io)──► Servidor Node (chat, presença, sinalização)
    ▲                                      
    └──────── WebRTC P2P (áudio/vídeo/tela) ────────► Outros navegadores
```

- O servidor (`server.js`) só cuida de chat, presença e **sinalização** WebRTC. Áudio, vídeo e tela vão direto de um navegador para o outro (malha P2P), então o servidor é leve.
- Canais e mensagens ficam em `data/db.json`.
- A malha P2P funciona bem com **até ~8 pessoas por sala** (limite configurável em `MAX_PEERS_PER_ROOM`). Para salas maiores, veja "Próximos passos".

## Rodando localmente

Requer Node.js 18+.

```bash
npm install
```

```bash
ACCESS_CODE=unicopag123 npm start
```

Acesse http://localhost:3000, informe seu nome e o código de acesso. Para testar uma chamada, abra em duas janelas (ou dois navegadores).

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `ACCESS_CODE` | vazio | Código exigido para entrar. **Defina em produção.** |
| `MAX_PEERS_PER_ROOM` | `8` | Máximo de pessoas por sala de voz |
| `ICE_SERVERS` | STUN do Google | Lista JSON de servidores STUN/TURN |
| `TURN_SECRET` | vazio | Segredo do coturn (`static-auth-secret`); ativa credenciais TURN temporárias |
| `TURN_URLS` | vazio | URLs do TURN separadas por vírgula |
| `TURN_TTL_SECONDS` | `43200` | Validade das credenciais TURN (12 h) |
| `DATA_FILE` | `./data/db.json` | Onde salvar canais e mensagens |
| `MAX_MESSAGES_PER_CHANNEL` | `500` | Histórico mantido por canal |

Veja `.env.example`.

## Colocando em produção

1. **HTTPS é obrigatório.** Navegadores só liberam câmera, microfone e tela em `https://` (ou `localhost`). Use um proxy com certificado (Nginx + Let's Encrypt, Caddy, Cloudflare, etc.) e garanta que ele repasse WebSocket.
2. **Docker:**
   ```bash
   cp .env.example .env
   ```
   ```bash
   docker compose up -d --build
   ```
3. **Servidor TURN (recomendado).** Sem TURN, chamadas podem falhar em redes corporativas, 4G ou Wi-Fi com firewall.
   O script `deploy/coturn/install.sh` instala o [coturn](https://github.com/coturn/coturn) já protegido (não encaminha tráfego
   para a rede interna nem para a própria máquina). Libere no firewall `3478` (UDP e TCP) e `49160–49400` (UDP) e configure no `.env`:
   ```
   TURN_SECRET=o-mesmo-segredo-do-coturn
   TURN_URLS=turn:IP_DO_SERVIDOR:3478?transport=udp,turn:IP_DO_SERVIDOR:3478?transport=tcp
   ```
   O UVoz gera para cada pessoa uma credencial TURN que expira (padrão: 12 h), então nenhuma senha fixa vai para o navegador.
4. Rode **uma única instância** do servidor (o estado de presença fica em memória). Ele precisa de um processo Node contínuo com WebSocket — ou seja, VPS/Docker, Render, Railway, Fly.io etc. Hospedagens serverless (ex.: funções da Vercel) não servem para este servidor.

## Deploy na Laravel Forge (produção atual)

O UVoz está publicado em **https://uvoz.on-forge.com**, no servidor `ms-subscription` da organização UnicoPag:

| Item | Configuração |
|---|---|
| Site | `uvoz.on-forge.com` (tipo "other", deploy sem downtime, HTTPS automático) |
| Repositório | `matheusmacedo-create/uvoz`, branch `claude/quirky-mccarthy-8qfrk9` |
| Processo em segundo plano | `/usr/bin/node server.js --uvoz-server` em `/home/forge/uvoz.on-forge.com/current` (usuário `forge`) |
| Porta interna | `3077` em `127.0.0.1` (o Nginx faz o proxy, com WebSocket) |
| Dados | `/home/forge/uvoz.on-forge.com/storage/db.json` (fora dos releases) |
| `.env` | `PORT`, `HOST`, `ACCESS_CODE`, `MAX_PEERS_PER_ROOM`, `DATA_FILE`, `TURN_SECRET`, `TURN_URLS`, editados no painel do site |
| TURN | coturn (serviço `coturn`) em `137.184.48.168:3478` UDP/TCP, relay `49160–49400/udp`; config em `/etc/turnserver.conf` |
| Firewall | regras "TURN UVoz" (3478) e "TURN relay UVoz" (49160:49400) no painel da Forge |

O TURN usa o IP próprio da máquina (`137.184.48.168`), e não `uvoz.on-forge.com`, porque esse domínio passa pela
Cloudflare. O `TURN_SECRET` do `.env` precisa ser igual ao `static-auth-secret` do `/etc/turnserver.conf`; para trocar,
rode `deploy/coturn/install.sh` de novo (receita da Forge como root) com o segredo novo e atualize o `.env`.

O script de deploy roda `npm ci --omit=dev`, ativa o release e encerra o processo
`uvoz-server`; o supervisor da Forge sobe de novo já com o código novo.

Para publicar uma alteração: faça push na branch e clique em **Deploy Now** no site na Forge
(o deploy automático no push precisa que a Forge tenha permissão de webhook no repositório).

## Estrutura

```
server.js          Servidor: Express + Socket.io (chat, canais, presença, sinalização)
public/index.html  Interface
public/styles.css  Tema escuro estilo Discord
public/app.js      Lógica de interface: login, canais, chat, palco de vídeo
public/rtc.js      WebRTC: conexões P2P (perfect negotiation), mídia local, detector de fala
```

## Próximos passos sugeridos

- **Login corporativo** (Google Workspace / Microsoft 365) no lugar do código de acesso compartilhado.
- **Banco de dados** (PostgreSQL/Supabase) para mensagens, usuários e permissões por cargo.
- **SFU (LiveKit ou mediasoup)** para salas com dezenas de pessoas e gravação de reuniões.
- Upload de arquivos e imagens no chat, mensagens diretas, reações e menções.
- Seleção de microfone/câmera e supressão de ruído avançada.
- App desktop (Electron/Tauri) com atalho global de "apertar para falar".
