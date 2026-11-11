# UVoz — o "Discord" da Unicopag

Plataforma de comunicação interna com:

- **Contas**: cadastro com usuário e senha (exige o código de acesso da empresa), sessões de 30 dias e limite de tentativas de login.
- **Canais de texto**: histórico no banco com rolagem infinita, "fulano está digitando…", links clicáveis, editar/apagar as próprias mensagens.
- **Mensagens diretas (DM)**: conversa privada 1:1 — clique em alguém na lista de membros ou no **+** de "Mensagens diretas".
- **Menções**: `@usuario`, `@todos`/`@everyone` com autocompletar (setas + Enter/Tab), destaque da mensagem e contador vermelho de menções no canal.
- **Não lidas e notificações**: canal em negrito, divisor "Novas mensagens", total no título da aba e notificação do navegador para DMs e menções.
- **Salas de voz e vídeo em grupo**: microfone, câmera e indicador de quem está falando.
- **Supressão de ruído com IA**: remove ventilador, ar-condicionado, teclado, zumbido e barulho de fundo do seu
  microfone antes de enviar (botão **Ruído** ou `Ctrl+B`; ligada por padrão e lembrada pelo navegador).
- **Compartilhamento de tela** (com áudio do sistema/aba quando o navegador permite). A tela compartilhada ganha destaque automaticamente.
- **Presença**: membros online/offline ("visto há…"), em qual sala cada um está, ícones de câmera, microfone mudo e selo "AO VIVO".
- Criação e exclusão de canais e salas, modo foco e tela cheia por participante, atalhos `Ctrl+D` (microfone), `Ctrl+E` (câmera), `Ctrl+B` (supressão de ruído) e `↑` (editar sua última mensagem), layout responsivo para celular.

## Como funciona

```
Navegador ──HTTPS (/api: login/cadastro)──► Servidor Node ──► MySQL
          ──WebSocket (Socket.io)─────────►   (chat, DMs, menções, presença, sinalização)
    ▲
    └──────── WebRTC P2P (áudio/vídeo/tela, com TURN quando preciso) ────────► Outros navegadores
```

- O servidor (`server.js`) cuida de contas, chat, presença e **sinalização** WebRTC. Áudio, vídeo e tela vão direto de um navegador para o outro (malha P2P), então o servidor é leve.
- Usuários, sessões, canais, mensagens, DMs, menções e o estado de leitura ficam no **MySQL**. As tabelas são criadas e atualizadas automaticamente na inicialização (`lib/db.js`, tabela `schema_migrations`).
- Se existir o `db.json` da versão antiga, os canais e mensagens dele são importados uma única vez (o arquivo vira `db.json.migrado`).
- As conexões de vídeo se recuperam sozinhas: reiniciam o ICE se travarem ou caírem e, se ainda assim não conectarem, são recriadas.
- **Supressão de ruído:** o áudio do microfone passa por um filtro passa-alta (corta abaixo de 90 Hz) e pelo
  [GTCRN](https://github.com/Xiaobin-Rong/gtcrn), uma rede neural leve que roda no próprio navegador em WebAssembly
  (AudioWorklet, via [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor),
  servido em `/vendor/noise`). Nada de áudio passa pelo servidor. Com a IA ligada, o filtro de ruído do navegador é
  desligado para não processar o som duas vezes; cancelamento de eco e ganho automático continuam ativos. Se o
  navegador não suportar AudioWorklet/WebAssembly, o UVoz volta sozinho para o filtro padrão do navegador.
  Em testes com ruído de ventilador, zumbido de 60 Hz e teclado, o ruído caiu cerca de 50 dB sem perda de volume
  na voz; a latência adicionada é de ~30 ms.
- **Desempenho:**
  - *Carregamento:* o `index.html` é sempre revalidado e aponta para `app.js`, `rtc.js` e `styles.css` com
    `?v=<hash do conteúdo>`; com o hash certo eles saem com cache de 1 ano (o hash muda a cada deploy, então não é
    preciso limpar cache). O cliente Socket.io é o minificado, em `/vendor/socket.io`. Quem já tem sessão vê a casca
    do app na hora, e as mensagens da conversa aberta chegam junto do estado inicial (sem ida e volta extra).
  - *Chat:* só a mensagem nova/alterada entra no DOM (a lista não é refeita); o envio aparece na hora e é confirmado
    depois; conversas ficam em cache (inclusive após queda de conexão), são adiantadas ao passar o mouse e as longas
    são aparadas ao sair.
  - *Servidor:* canais, DMs, último acesso e ponto de leitura ficam em memória; a contagem de não lidas usa uma
    consulta indexada por conversa e é pulada quando não há nada novo.
  - *Chamadas:* a qualidade do vídeo enviado se adapta ao tamanho da sala (até 2 outras pessoas: 720p/900 kbps;
    até 4: 480p/500 kbps; mais: 360p/300 kbps; tela limitada a 1080p), o microfone é pedido em paralelo com a
    entrada e o filtro de ruído entra em seguida. Se a conexão com o servidor cair (rede ou deploy), a chamada
    volta sozinha para a mesma sala mantendo microfone, câmera e tela.
- A malha P2P funciona bem com **até ~8 pessoas por sala** (limite configurável em `MAX_PEERS_PER_ROOM`). Para salas maiores, veja "Próximos passos".

## Rodando localmente

Requer Node.js 18+ e MySQL 8+ (ou MariaDB 10.6+) com um banco vazio:

```sql
CREATE DATABASE uvoz CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

```bash
npm install
```

```bash
cp .env.example .env
```

Ajuste o `.env` (banco e `ACCESS_CODE`) e rode:

```bash
npm start
```

Acesse http://localhost:3000, clique em **Criar conta** e use o código de acesso. Para testar DMs e chamadas, crie duas contas em janelas anônimas diferentes.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `0.0.0.0` | Interface de escuta (`127.0.0.1` atrás do Nginx) |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | Servidor MySQL |
| `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD` | `uvoz` / `uvoz` / vazio | Banco e credenciais (ou `DATABASE_URL`) |
| `ACCESS_CODE` | vazio | Código exigido para **criar conta**. **Defina em produção.** |
| `SESSION_TTL_DAYS` | `30` | Validade do login |
| `MAX_PEERS_PER_ROOM` | `8` | Máximo de pessoas por sala de voz |
| `ICE_SERVERS` | STUN do Google | Lista JSON de servidores STUN/TURN |
| `TURN_SECRET` | vazio | Segredo do coturn (`static-auth-secret`); ativa credenciais TURN temporárias |
| `TURN_URLS` | vazio | URLs do TURN separadas por vírgula |
| `TURN_TTL_SECONDS` | `43200` | Validade das credenciais TURN (12 h) |
| `DATA_FILE` | `./data/db.json` | Arquivo da versão antiga, importado uma única vez se existir |

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
| Banco | MySQL do próprio servidor: banco `uvoz`, usuário `uvoz` (só com acesso a esse banco) |
| `.env` | `PORT`, `HOST`, `DB_*`, `ACCESS_CODE`, `MAX_PEERS_PER_ROOM`, `DATA_FILE`, `TURN_SECRET`, `TURN_URLS`, editados no painel do site |
| TURN | coturn (serviço `coturn`) em `137.184.48.168:3478` UDP/TCP, relay `49160–49400/udp`; config em `/etc/turnserver.conf` |
| Firewall | regras "TURN UVoz" (3478) e "TURN relay UVoz" (49160:49400) no painel da Forge |

O TURN usa o IP próprio da máquina (`137.184.48.168`), e não `uvoz.on-forge.com`, porque esse domínio passa pela
Cloudflare. O `TURN_SECRET` do `.env` precisa ser igual ao `static-auth-secret` do `/etc/turnserver.conf`; para trocar,
rode `deploy/coturn/install.sh` de novo (receita da Forge como root) com o segredo novo e atualize o `.env`.

O script de deploy roda `npm ci --omit=dev`, ativa o release e encerra o processo com
`pkill -u forge -f "uvoz-serve[r]"`; o supervisor da Forge sobe de novo já com o código novo
(o `[r]` impede que o padrão case com o próprio script de deploy). As tabelas novas, quando houver,
são criadas automaticamente quando o processo sobe.

Para publicar uma alteração: faça push na branch e clique em **Deploy Now** no site na Forge
(o deploy automático no push precisa que a Forge tenha permissão de webhook no repositório).

### Backup dos bancos

Todos os bancos MySQL do `ms-subscription` (não só o do UVoz) são copiados todo dia para o Cloudflare R2
pelo script `deploy/backup/mysql-backup-r2.sh`. O backup nativo da Forge exige o plano Business, então ele roda
como tarefa agendada comum:

| Item | Configuração |
|---|---|
| Script | `/usr/local/bin/mysql-backup-r2` (cópia de `deploy/backup/mysql-backup-r2.sh`) |
| Configuração | `/etc/mysql-backup-r2.env` (só root): bucket, endpoint e chaves do R2, `R2_PREFIX=ms-subscription`, `RETENTION_DAYS=14`, `HEARTBEAT_URL` |
| Agendamento | tarefa "Backup MySQL -> R2" no servidor, como `root`, `0 6 * * *` (03:00 de Brasília) |
| Destino | `<bucket>/ms-subscription/AAAA-MM-DD_HHMM/<banco>.sql.gz` + `_usuarios-e-permissoes.sql.gz` |
| Retenção | 14 dias, só apagada depois que o backup do dia foi enviado e conferido |
| Alerta | heartbeat "Backup MySQL -> R2 (ms-subscription)" no site do UVoz: a Forge avisa por e-mail se o backup não terminar até 07:00 UTC |
| Log | `/var/log/mysql-backup-r2.log` (rotação mensal) e "View output" da tarefa na Forge |

Bancos novos entram sozinhos (o script lista todos os bancos do MySQL a cada execução). Para rodar na hora,
use uma receita da Forge como `root` com `mysql-backup-r2`.

Para restaurar um banco (receita como `root`; troque a pasta e o banco):

```bash
set -a; . /etc/mysql-backup-r2.env; set +a
```

```bash
AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
  aws --endpoint-url "$R2_ENDPOINT" s3 cp "s3://$R2_BUCKET/ms-subscription/2026-11-10_1208/uvoz.sql.gz" /tmp/
```

```bash
zcat /tmp/uvoz.sql.gz | mysql
```

O dump traz `CREATE DATABASE IF NOT EXISTS` e recria as tabelas daquele banco; para restaurar com outro nome sem
mexer no original, troque o nome com ``sed 's/`uvoz`/`uvoz_restaurado`/g'`` antes do `mysql`.

### Administração

Rode na aba **Commands** do site na Forge (diretório `current`):

```bash
node scripts/reset-password.js usuario NovaSenha123
```

```bash
node scripts/delete-user.js usuario
```

`reset-password` troca a senha e encerra as sessões da pessoa. `delete-user` remove a conta (as mensagens ficam
como "Usuário removido"; acrescente `--apagar-mensagens` para apagá-las) — reinicie o processo `uvoz` depois.

## App para Windows e app instalável

**Instalar pelo navegador (PWA):** no Chrome ou Edge, abra o UVoz e clique no ícone de instalar na barra de
endereço (ou menu → "Instalar UVoz"). Ele ganha ícone, janela própria e contador de não lidas no ícone. No celular:
menu → "Adicionar à tela inicial". Não precisa de instalador nem de atualização.

**App para Windows (Electron, pasta `desktop/`):** é uma janela que carrega o UVoz publicado — por isso toda
melhoria do site chega sem reinstalar — e acrescenta:

- ícone na bandeja (fechar a janela mantém o app aberto; "Sair" no menu da bandeja encerra);
- opção "Iniciar com o Windows" no menu da bandeja;
- atalho global `Ctrl+Shift+M` para ligar/desligar o microfone, mesmo com a janela minimizada;
- selo vermelho no ícone da barra de tarefas e piscar quando chegam não lidas;
- seletor próprio de tela/janela para compartilhar, com opção de enviar o som do computador;
- links externos abrem no navegador padrão; só o endereço do UVoz pode usar microfone, câmera e tela.

O instalador é gerado pelo GitHub Actions (workflow **App Windows (instalador)**): a cada mudança em `desktop/`, ou
em Actions → Run workflow, o `UVoz-Setup-<versão>.exe` fica em **Artifacts** da execução. Criar uma tag
`desktop-v1.0.0` anexa o instalador a uma Release. Para apontar o app para outro endereço, defina `UVOZ_URL`.

Sem certificado de assinatura de código, o Windows mostra o aviso do SmartScreen na instalação
("Mais informações" → "Executar assim mesmo"). O app não se atualiza sozinho: só é preciso reinstalar quando o
próprio invólucro (`desktop/`) mudar.

Para rodar em desenvolvimento:

```bash
cd desktop && npm install && npm start
```

## Estrutura

```
server.js          Servidor: Express (API de contas) + Socket.io (chat, DMs, menções, presença, sinalização)
lib/db.js          Conexão MySQL e migrações do esquema
lib/auth.js        Senhas (scrypt), sessões e limite de tentativas
lib/store.js       Consultas: usuários, canais, mensagens, DMs, menções, não lidas
lib/env.js         Leitura do .env
scripts/           Administração (redefinir senha, remover conta)
deploy/coturn/     Instalação do servidor TURN
deploy/backup/     Backup diário dos bancos MySQL para o R2
public/index.html  Interface
public/styles.css  Tema escuro estilo Discord
public/app.js      Interface: login, canais, DMs, menções, chat, palco de vídeo
public/manifest.webmanifest, public/icons/   App instalável (PWA)
desktop/           App para Windows (Electron): janela, bandeja, atalho global, seletor de tela
public/rtc.js      WebRTC: conexões P2P (perfect negotiation), recuperação automática, supressão de ruído, detector de fala
```

## Próximos passos sugeridos

- **Login corporativo** (Google Workspace / Microsoft 365) no lugar do código de acesso compartilhado.
- **Permissões por cargo** (quem pode criar/apagar canais, moderar mensagens).
- **SFU (LiveKit ou mediasoup)** para salas com dezenas de pessoas e gravação de reuniões.
- Upload de arquivos e imagens no chat, reações e respostas em thread.
- Chamada de voz/vídeo direto de uma DM.
- Seleção de microfone/câmera.
- App desktop (Electron/Tauri) com atalho global de "apertar para falar".
