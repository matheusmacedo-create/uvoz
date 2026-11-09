#!/bin/bash
# Instala e configura o coturn (servidor TURN) para o UVoz.
# Rodar como root (ex.: receita da Forge com usuário "root").
#
# Variáveis obrigatórias:
#   TURN_SECRET   segredo compartilhado com o UVoz (mesmo valor do TURN_SECRET no .env do site)
#   TURN_IP       IP público da máquina, presente na interface de rede (sem NAT)
# Opcionais:
#   EXTRA_DENY_IPS  IPs adicionais da própria máquina (ex.: IP reservado) separados por espaço
set -euo pipefail
: "${TURN_SECRET:?defina TURN_SECRET}"
: "${TURN_IP:?defina TURN_IP}"

export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends coturn || { apt-get update -q && apt-get install -y --no-install-recommends coturn; }

{
cat <<CONF
# Gerado por deploy/coturn/install.sh (UVoz)
listening-ip=${TURN_IP}
relay-ip=${TURN_IP}
listening-port=3478
min-port=49160
max-port=49400

# Credenciais temporárias geradas pelo servidor do UVoz (HMAC com o segredo)
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=uvoz
fingerprint

no-tls
no-dtls
no-cli
no-multicast-peers
no-software-attribute
stale-nonce=600

# Limites para não pesar no servidor
user-quota=12
total-quota=200
max-bps=3000000

# Segurança: o TURN NÃO pode encaminhar tráfego para a rede interna nem para
# a própria máquina (MySQL, Redis e as APIs de produção rodam aqui).
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=${TURN_IP}
CONF
for ip in ${EXTRA_DENY_IPS:-}; do echo "denied-peer-ip=${ip}"; done
cat <<CONF

syslog
simple-log
CONF
} > /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
chgrp turnserver /etc/turnserver.conf 2>/dev/null || true

[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable coturn
systemctl restart coturn
sleep 2
systemctl is-active coturn
ss -lnptu | grep 3478
