#!/usr/bin/env bash
# Backup de todos os bancos MySQL do servidor para um bucket S3 compatível (Cloudflare R2).
#
# Uso (como root):  mysql-backup-r2            (lê /etc/mysql-backup-r2.env)
#
# Variáveis do arquivo de configuração:
#   R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   (obrigatórias)
#   R2_PREFIX        pasta dentro do bucket (padrão: hostname)
#   RETENTION_DAYS   dias de backups mantidos (padrão: 14)
#   HEARTBEAT_URL    opcional; recebe um GET quando o backup termina sem erro
#   LOG_FILE         padrão: /var/log/mysql-backup-r2.log (a saída também vai para a tela)
#
# Cada execução gera <prefixo>/<AAAA-MM-DD_HHMM>/<banco>.sql.gz. Pastas mais antigas que a
# retenção só são apagadas quando a execução atual terminou e foi conferida no bucket.
set -euo pipefail

CONF=${CONF:-/etc/mysql-backup-r2.env}
# shellcheck disable=SC1090
. "$CONF"
: "${R2_BUCKET:?}" "${R2_ENDPOINT:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
PREFIX=${R2_PREFIX:-$(hostname)}
PREFIX=${PREFIX%/}
RETENTION_DAYS=${RETENTION_DAYS:-14}
LOG_FILE=${LOG_FILE:-/var/log/mysql-backup-r2.log}
[ -n "$LOG_FILE" ] && exec > >(tee -a "$LOG_FILE") 2>&1

export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY
export AWS_DEFAULT_REGION=auto AWS_PAGER=""
# O R2 não aceita os checksums CRC que a AWS CLI recente envia por padrão.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
s3() { aws --endpoint-url "$R2_ENDPOINT" s3 "$@"; }

log() { echo "[$(date -u '+%F %T')] $*"; }

STAMP=$(date -u +%Y-%m-%d_%H%M)
DEST="s3://$R2_BUCKET/$PREFIX/$STAMP"
WORK=$(mktemp -d /var/tmp/mysql-backup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

dbs=$(mysql -NBe "SELECT schema_name FROM information_schema.schemata
  WHERE schema_name NOT IN ('mysql','sys','information_schema','performance_schema') ORDER BY 1")

failed=()
for db in $dbs; do
  if mysqldump --single-transaction --quick --routines --triggers --events \
       --set-gtid-purged=OFF --databases "$db" | gzip -9 > "$WORK/$db.sql.gz"; then
    log "dump ok: $db ($(du -h "$WORK/$db.sql.gz" | cut -f1))"
  else
    log "ERRO no dump: $db"; failed+=("$db"); rm -f "$WORK/$db.sql.gz"
  fi
done

# Usuários e permissões (para recriar o servidor do zero).
if { echo "SET SESSION print_identified_with_as_hex=ON;"
     mysql -NBe "SELECT CONCAT('SHOW CREATE USER ', QUOTE(user), '@', QUOTE(host), ';',
                             'SHOW GRANTS FOR ', QUOTE(user), '@', QUOTE(host), ';')
               FROM mysql.user WHERE user NOT LIKE 'mysql.%'"; } \
   | mysql -NB | sed 's/$/;/' | gzip -9 > "$WORK/_usuarios-e-permissoes.sql.gz"; then
  log "dump ok: usuários e permissões"
else
  log "ERRO ao exportar usuários"; failed+=("_usuarios")
fi

s3 cp "$WORK/" "$DEST/" --recursive --only-show-errors
local_count=$(find "$WORK" -name '*.sql.gz' | wc -l)
remote_count=$(s3 ls "$DEST/" | grep -c '\.sql\.gz$' || true)
if [ "$local_count" -ne "$remote_count" ]; then
  log "ERRO: $local_count arquivos gerados, $remote_count no bucket"; exit 1
fi
log "enviado: $remote_count arquivos para $DEST/"

if [ ${#failed[@]} -gt 0 ]; then
  log "ERRO: falharam ${failed[*]} (retenção não aplicada)"; exit 1
fi

cutoff=$(date -u -d "-$RETENTION_DAYS days" +%Y-%m-%d)
s3 ls "s3://$R2_BUCKET/$PREFIX/" | awk '$1=="PRE"{print $2}' | tr -d / | while read -r dir; do
  if [[ $dir =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_ ]] && [[ ${dir:0:10} < $cutoff ]]; then
    s3 rm "s3://$R2_BUCKET/$PREFIX/$dir/" --recursive --only-show-errors
    log "removido backup antigo: $dir"
  fi
done

[ -n "${HEARTBEAT_URL:-}" ] && curl -fsS -m 20 "$HEARTBEAT_URL" > /dev/null || true
log "backup concluído"
