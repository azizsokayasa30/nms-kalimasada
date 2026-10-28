#!/usr/bin/env bash
#
# Kalimasada NMS - deploy sekali jalan.
#
# Memasang semua komponen di satu server:
#   PostgreSQL -> Zabbix 7.0 (server, frontend, agent) -> Node.js -> Kalimasada NMS
#   (backend NestJS sebagai service systemd, frontend React lewat nginx).
#
# Pemakaian (sebagai root, Ubuntu 22.04/24.04 atau Debian 12):
#   curl -fsSL https://raw.githubusercontent.com/azizsokayasa30/nms-kalimasada/main/deploy.sh | bash
# atau dari hasil clone repo:
#   sudo bash deploy.sh
#
# Aman dijalankan ulang untuk update. Password dan secret yang dibuat disimpan
# di /root/NMS-KALIMASADA/secrets.env dan dipakai lagi pada run berikutnya.
#
# Tatanan folder bawaan (nama huruf besar, dipakai setiap instal baru dan ulang):
#   /root/NMS-KALIMASADA/                          kode (frontend, backend, deploy.sh)
#   /root/NMS-KALIMASADA/www/                      file frontend yang dilayani nginx
#   /root/NMS-KALIMASADA/secrets.env               secret deploy, tidak masuk git
#   /root/NMS-KALIMASADA/kalimasada-credentials.txt  ringkasan login, tidak masuk git
#
# Pengaturan lewat variabel lingkungan, contoh:
#   ADMIN_EMAIL=noc@contoh.id ADMIN_PASSWORD=RahasiaKuat123 bash deploy.sh

set -Eeuo pipefail
umask 022

REPO_URL=${REPO_URL:-https://github.com/azizsokayasa30/nms-kalimasada.git}
BRANCH=${BRANCH:-main}
INSTALL_DIR=${INSTALL_DIR:-/root/NMS-KALIMASADA}
WEB_ROOT=${WEB_ROOT:-/root/NMS-KALIMASADA/www}
SERVICE_NAME=${SERVICE_NAME:-kalimasada-api}
SERVICE_USER=${SERVICE_USER:-kalimasada}
APP_PORT=${APP_PORT:-3000}
HTTP_PORT=${HTTP_PORT:-80}
ZABBIX_WEB_PORT=${ZABBIX_WEB_PORT:-8080}
ZABBIX_VERSION=${ZABBIX_VERSION:-7.0}
NODE_MAJOR=${NODE_MAJOR:-22}
PUBLIC_HOST=${PUBLIC_HOST:-}
NMS_DOMAIN=${NMS_DOMAIN-nms.kalimasada-app.com}
ZABBIX_DOMAIN=${ZABBIX_DOMAIN-zabbix.kalimasada-app.com}
ENABLE_HTTPS=${ENABLE_HTTPS:-1}
LE_EMAIL=${LE_EMAIL:-}
ACME_ROOT=${ACME_ROOT:-/var/www/letsencrypt}
SECRETS_FILE=${SECRETS_FILE:-/root/NMS-KALIMASADA/secrets.env}
CREDENTIALS_FILE=${CREDENTIALS_FILE:-/root/NMS-KALIMASADA/kalimasada-credentials.txt}
RESET_ZABBIX_ADMIN=${RESET_ZABBIX_ADMIN:-0}

SECRET_KEYS=(
  ADMIN_EMAIL ADMIN_PASSWORD JWT_SECRET APP_ENCRYPTION_KEY ZABBIX_WEBHOOK_TOKEN
  ZABBIX_DB_PASSWORD APP_DB_PASSWORD ZABBIX_ADMIN_PASSWORD
)

SCRIPT_DIR=""
if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then
  SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi

STEP=0
ZBX_FRESH=0
ZBX_ADMIN_CHANGED=0
ZBX_ADMIN_MISMATCH=0
PG_PORT=5432

step() { STEP=$((STEP + 1)); printf '\n\033[1;34m[%d] %s\033[0m\n' "$STEP" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "Gagal di baris $LINENO: $BASH_COMMAND"' ERR

usage() {
  cat <<EOF
Kalimasada NMS - deploy sekali jalan (PostgreSQL, Zabbix ${ZABBIX_VERSION}, Node.js, nginx, NMS).

Pemakaian:  sudo bash deploy.sh

Variabel opsional (nilai bawaan dalam kurung):
  ADMIN_EMAIL          Email login awal NMS (admin@kalimasada.local)
  ADMIN_PASSWORD       Password login awal NMS (acak)
  ZABBIX_ADMIN_PASSWORD Password user Admin Zabbix (acak)
  PUBLIC_HOST          IP/domain server untuk CORS dan ringkasan (otomatis)
  NMS_DOMAIN           Domain dashboard NMS (nms.kalimasada-app.com, kosongkan untuk mematikan)
  ZABBIX_DOMAIN        Domain web Zabbix (zabbix.kalimasada-app.com, kosongkan untuk mematikan)
  ENABLE_HTTPS         Buat sertifikat Let's Encrypt untuk domain yang DNS-nya ke server ini (1)
  LE_EMAIL             Email pemberitahuan Let's Encrypt (kosong)
  HTTP_PORT            Port dashboard NMS (80)
  ZABBIX_WEB_PORT      Port web Zabbix (8080)
  APP_PORT             Port internal API (3000)
  INSTALL_DIR          Lokasi kode (/root/NMS-KALIMASADA)
  WEB_ROOT             Lokasi file frontend untuk nginx (/root/NMS-KALIMASADA/www)
  SERVICE_USER         User Linux yang menjalankan API (kalimasada)
  REPO_URL, BRANCH     Sumber kode bila script tidak dijalankan dari dalam repo
  RESET_ZABBIX_ADMIN=1 Paksa set ulang password Admin Zabbix yang sudah ada
EOF
}

gen_pass() {
  local p
  p=$(openssl rand -base64 32)
  p=${p//[^A-Za-z0-9]/}
  printf '%s' "${p:0:${1:-16}}"
}

read_kv() {
  local file=$1 key=$2 line
  [[ -r $file ]] || return 0
  line=$(grep -E "^${key}=" "$file" | tail -n1 || true)
  line=${line#*=}
  line=${line%$'\r'}
  if [[ $line =~ ^\"(.*)\"$ || $line =~ ^\'(.*)\'$ ]]; then line=${BASH_REMATCH[1]}; fi
  printf '%s' "$line"
}

wait_for() {
  local tries=$1 i
  shift
  for ((i = 0; i < tries; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

apt_install() {
  apt-get install -y -q \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

pg() { (cd / && runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -Atq -p "$PG_PORT" "$@"); }

zbx_psql() {
  PGPASSWORD=$ZABBIX_DB_PASSWORD psql -X -v ON_ERROR_STOP=1 -Atq \
    -h 127.0.0.1 -p "$PG_PORT" -U zabbix -d zabbix "$@"
}

app_psql() {
  PGPASSWORD=$APP_DB_PASSWORD psql -X -v ON_ERROR_STOP=1 -Atq \
    -h 127.0.0.1 -p "$PG_PORT" -U kalimasada -d kalimasada "$@"
}

zbx_api() {
  curl -fsS --max-time 10 -H 'Content-Type: application/json-rpc' \
    -d "$1" "http://127.0.0.1:${ZABBIX_WEB_PORT}/api_jsonrpc.php"
}

zbx_login_ok() {
  zbx_api "{\"jsonrpc\":\"2.0\",\"method\":\"user.login\",\"params\":{\"username\":\"Admin\",\"password\":\"$1\"},\"id\":1}" \
    2>/dev/null | grep -q '"result"'
}

set_conf() {
  local file=$1 key=$2 val=$3
  if grep -qE "^${key}=" "$file"; then
    sed -i -E "s|^${key}=.*|${key}=${val}|" "$file"
  elif grep -qE "^#[[:space:]]*${key}=" "$file"; then
    sed -i -E "0,/^#[[:space:]]*${key}=.*/s||${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
}

preflight() {
  [[ $EUID -eq 0 ]] || die "Jalankan sebagai root, misalnya: sudo bash deploy.sh"
  [[ -r /etc/os-release ]] || die "/etc/os-release tidak ditemukan."
  OS_ID=$(. /etc/os-release && echo "$ID")
  OS_VER=$(. /etc/os-release && echo "$VERSION_ID")
  case "${OS_ID}:${OS_VER}" in
    ubuntu:22.04) PHP_VER=8.1 ;;
    ubuntu:24.04) PHP_VER=8.3 ;;
    debian:12) PHP_VER=8.2 ;;
    *) die "OS ${OS_ID} ${OS_VER} belum didukung. Gunakan Ubuntu 22.04/24.04 atau Debian 12." ;;
  esac

  local p
  for p in APP_PORT HTTP_PORT ZABBIX_WEB_PORT; do
    [[ ${!p} =~ ^[0-9]+$ ]] || die "$p harus berupa angka."
  done
  [[ $HTTP_PORT != "$ZABBIX_WEB_PORT" ]] || die "HTTP_PORT dan ZABBIX_WEB_PORT tidak boleh sama."

  if [[ -z $PUBLIC_HOST ]]; then
    PUBLIC_HOST=$(hostname -I 2>/dev/null | awk '{print $1}')
    PUBLIC_HOST=${PUBLIC_HOST:-127.0.0.1}
  fi

  local mem
  mem=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
  if ((mem < 1800)); then
    warn "RAM hanya ${mem} MB. Disarankan minimal 2 GB agar build frontend dan Zabbix lancar."
  fi
  info "OS ${OS_ID} ${OS_VER}, PHP ${PHP_VER}, alamat server ${PUBLIC_HOST}"
}

install_base() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt_install ca-certificates curl gnupg git rsync openssl gzip \
    iputils-ping fping snmp libcap2-bin postgresql postgresql-contrib nginx \
    iproute2 wireguard-tools openvpn strongswan-starter strongswan-charon xl2tpd ppp

  if ! getcap /usr/bin/fping 2>/dev/null | grep -q cap_net_raw && [[ ! -u /usr/bin/fping ]]; then
    setcap cap_net_raw+ep /usr/bin/fping || warn "Gagal memberi izin ICMP ke fping; ping Zabbix bisa gagal."
  fi
}

load_secrets() {
  local legacy="" f k v
  for f in "$INSTALL_DIR/backend/.env" "${SCRIPT_DIR:+$SCRIPT_DIR/backend/.env}"; do
    if [[ -n $f && -r $f ]]; then legacy=$f; break; fi
  done

  for k in "${SECRET_KEYS[@]}"; do
    [[ -n ${!k:-} ]] && continue
    v=$(read_kv "$SECRETS_FILE" "$k")
    if [[ -z $v && -n $legacy ]]; then
      case $k in
        ZABBIX_ADMIN_PASSWORD) v=$(read_kv "$legacy" ZABBIX_PASSWORD) ;;
        ADMIN_EMAIL | ADMIN_PASSWORD | JWT_SECRET | APP_ENCRYPTION_KEY | ZABBIX_WEBHOOK_TOKEN) v=$(read_kv "$legacy" "$k") ;;
      esac
      if [[ $v == ganti-* || ($k == ZABBIX_ADMIN_PASSWORD && $v == zabbix) ]]; then v=""; fi
    fi
    printf -v "$k" '%s' "$v"
  done
  if [[ -n $legacy && ! -f $SECRETS_FILE ]]; then info "Memakai secret dari konfigurasi lama: $legacy"; fi

  : "${ADMIN_EMAIL:=admin@kalimasada.local}"
  [[ -n $ADMIN_PASSWORD ]] || ADMIN_PASSWORD=$(gen_pass 16)
  [[ -n $JWT_SECRET ]] || JWT_SECRET=$(openssl rand -hex 32)
  [[ -n $APP_ENCRYPTION_KEY ]] || APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
  [[ -n $ZABBIX_WEBHOOK_TOKEN ]] || ZABBIX_WEBHOOK_TOKEN=$(openssl rand -hex 24)
  [[ -n $ZABBIX_DB_PASSWORD ]] || ZABBIX_DB_PASSWORD=$(gen_pass 24)
  [[ -n $APP_DB_PASSWORD ]] || APP_DB_PASSWORD=$(gen_pass 24)
  [[ -n $ZABBIX_ADMIN_PASSWORD ]] || ZABBIX_ADMIN_PASSWORD=$(gen_pass 16)

  local bad=$'[[:space:]"\'\\\\`]'
  for k in "${SECRET_KEYS[@]}"; do
    [[ ! ${!k} =~ $bad ]] || die "$k tidak boleh mengandung spasi, tanda kutip, backslash, atau backtick."
  done
  for k in ZABBIX_DB_PASSWORD APP_DB_PASSWORD; do
    [[ ${!k} =~ ^[A-Za-z0-9]+$ ]] || die "$k hanya boleh berisi huruf dan angka."
  done
  [[ $ADMIN_EMAIL =~ ^[^@]+@[^@]+$ ]] || die "ADMIN_EMAIL tidak valid: $ADMIN_EMAIL"
  ((${#ADMIN_PASSWORD} >= 8)) || die "ADMIN_PASSWORD minimal 8 karakter."
}

save_secrets() {
  local dir
  dir=$(dirname "$SECRETS_FILE")
  install -d "$dir"
  if [[ $dir == "$INSTALL_DIR" || $dir == "$INSTALL_DIR/"* ]]; then
    chmod 755 "$dir"
  else
    chmod 700 "$dir"
  fi
  (
    umask 077
    {
      echo "# Dibuat oleh deploy.sh Kalimasada NMS. Jangan dibagikan."
      local k
      for k in "${SECRET_KEYS[@]}"; do printf '%s="%s"\n' "$k" "${!k}"; done
    } >"$SECRETS_FILE"
  )
  chown root:root "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
}

install_node() {
  local cur=0
  if command -v node >/dev/null; then cur=$(node -p 'process.versions.node.split(".")[0]'); fi
  if ((cur < 20)); then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    rm -f /tmp/nodesource_setup.sh
    apt_install nodejs
  fi
  info "Node $(node -v), npm $(npm -v)"
}

ensure_db() {
  local role=$1 pass=$2 db=$3
  if [[ $(pg -c "SELECT 1 FROM pg_roles WHERE rolname = '${role}'") == 1 ]]; then
    pg -c "ALTER ROLE \"${role}\" WITH LOGIN PASSWORD '${pass}'"
  else
    pg -c "CREATE ROLE \"${role}\" WITH LOGIN PASSWORD '${pass}'"
  fi
  if [[ $(pg -c "SELECT 1 FROM pg_database WHERE datname = '${db}'") != 1 ]]; then
    pg -c "CREATE DATABASE \"${db}\" OWNER \"${role}\" ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0"
    info "Database ${db} dibuat."
  fi
}

setup_postgres() {
  systemctl enable --now postgresql >/dev/null
  wait_for 30 runuser -u postgres -- pg_isready -q || die "PostgreSQL tidak menyala."
  PG_PORT=$(cd / && runuser -u postgres -- psql -XAtq -c 'SHOW port')
  ensure_db zabbix "$ZABBIX_DB_PASSWORD" zabbix
  ensure_db kalimasada "$APP_DB_PASSWORD" kalimasada
  info "PostgreSQL siap di port ${PG_PORT}."
}

install_zabbix() {
  local deb=/tmp/zabbix-release.deb
  if ! dpkg-query -W -f='${Version}' zabbix-release 2>/dev/null | grep -q "^1:${ZABBIX_VERSION}-"; then
    curl -fsSL -o "$deb" \
      "https://repo.zabbix.com/zabbix/${ZABBIX_VERSION}/${OS_ID}/pool/main/z/zabbix-release/zabbix-release_latest_${ZABBIX_VERSION}+${OS_ID}${OS_VER}_all.deb"
    dpkg -i "$deb"
    rm -f "$deb"
    apt-get update -q
  fi
  apt_install "php${PHP_VER}-fpm" "php${PHP_VER}-cli" "php${PHP_VER}-pgsql" \
    zabbix-server-pgsql zabbix-frontend-php zabbix-nginx-conf zabbix-sql-scripts zabbix-agent
}

configure_zabbix() {
  if [[ -z $(zbx_psql -c "SELECT to_regclass('public.dbversion')") ]]; then
    info "Mengimpor skema database Zabbix, butuh beberapa menit..."
    zcat /usr/share/zabbix-sql-scripts/postgresql/server.sql.gz | zbx_psql >/dev/null
    ZBX_FRESH=1
  fi

  local conf=/etc/zabbix/zabbix_server.conf
  set_conf "$conf" DBHost localhost
  set_conf "$conf" DBPort "$PG_PORT"
  set_conf "$conf" DBName zabbix
  set_conf "$conf" DBUser zabbix
  set_conf "$conf" DBPassword "$ZABBIX_DB_PASSWORD"
  set_conf "$conf" StartPingers 3
  set_conf "$conf" FpingLocation /usr/bin/fping
  if [[ -x /usr/bin/fping6 ]]; then set_conf "$conf" Fping6Location /usr/bin/fping6; fi
  set_conf "$conf" Timeout 4
  set_conf "$conf" CacheSize 64M
  set_conf "$conf" HistoryCacheSize 32M
  set_conf "$conf" TrendCacheSize 16M
  set_conf "$conf" ValueCacheSize 32M
  chmod 640 "$conf"
  chown root:zabbix "$conf"

  install -d /etc/zabbix/web
  cat >/etc/zabbix/web/zabbix.conf.php <<EOF
<?php
\$DB['TYPE']           = 'POSTGRESQL';
\$DB['SERVER']         = 'localhost';
\$DB['PORT']           = '${PG_PORT}';
\$DB['DATABASE']       = 'zabbix';
\$DB['USER']           = 'zabbix';
\$DB['PASSWORD']       = '${ZABBIX_DB_PASSWORD}';
\$DB['SCHEMA']         = '';
\$DB['ENCRYPTION']     = false;
\$DB['KEY_FILE']       = '';
\$DB['CERT_FILE']      = '';
\$DB['CA_FILE']        = '';
\$DB['VERIFY_HOST']    = false;
\$DB['CIPHER_LIST']    = '';
\$DB['DOUBLE_IEEE754'] = true;

\$ZBX_SERVER      = 'localhost';
\$ZBX_SERVER_PORT = '10051';
\$ZBX_SERVER_NAME = 'Kalimasada';

\$IMAGE_FORMAT_DEFAULT = IMAGE_FORMAT_PNG;
EOF
  chown root:www-data /etc/zabbix/web/zabbix.conf.php
  chmod 640 /etc/zabbix/web/zabbix.conf.php

  sed -i -E "0,/^[[:space:]]*#?[[:space:]]*listen[[:space:]]+[0-9]+;/s||        listen ${ZABBIX_WEB_PORT};|" /etc/zabbix/nginx.conf
  sed -i -E "0,/^[[:space:]]*#?[[:space:]]*server_name[[:space:]].*;/s||        server_name _;|" /etc/zabbix/nginx.conf
  ln -sfn /etc/zabbix/nginx.conf /etc/nginx/conf.d/zabbix.conf
  if ! grep -qs 'zabbix.sock' "/etc/php/${PHP_VER}/fpm/pool.d/"*.conf; then
    ln -sfn /etc/zabbix/php-fpm.conf "/etc/php/${PHP_VER}/fpm/pool.d/zabbix-php-fpm.conf"
  fi
  rm -f /etc/nginx/sites-enabled/default

  systemctl enable "php${PHP_VER}-fpm" zabbix-server zabbix-agent nginx >/dev/null 2>&1
  systemctl restart "php${PHP_VER}-fpm" zabbix-server zabbix-agent
  nginx -t -q
  systemctl reload-or-restart nginx

  sleep 3
  if ! systemctl is-active --quiet zabbix-server; then
    tail -n 30 /var/log/zabbix/zabbix_server.log >&2 || true
    die "zabbix-server gagal menyala, lihat log di atas."
  fi
  wait_for 45 zbx_api '{"jsonrpc":"2.0","method":"apiinfo.version","params":{},"id":1}' \
    || die "API Zabbix di port ${ZABBIX_WEB_PORT} tidak menjawab."
  info "Zabbix $(zbx_api '{"jsonrpc":"2.0","method":"apiinfo.version","params":{},"id":1}' | sed -E 's/.*"result":"([^"]+)".*/\1/') berjalan."
}

setup_zabbix_admin() {
  if zbx_login_ok "$ZABBIX_ADMIN_PASSWORD"; then
    info "Password Admin Zabbix sudah sesuai."
    return
  fi
  if [[ $ZBX_FRESH == 1 || $RESET_ZABBIX_ADMIN == 1 ]] || zbx_login_ok zabbix; then
    local hash
    hash=$(ZPW=$ZABBIX_ADMIN_PASSWORD "php${PHP_VER}" -r 'echo password_hash(getenv("ZPW"), PASSWORD_BCRYPT);')
    printf "UPDATE users SET passwd = :'hash', attempt_failed = 0 WHERE username = 'Admin';\n" \
      | zbx_psql -v hash="$hash" >/dev/null
    zbx_login_ok "$ZABBIX_ADMIN_PASSWORD" || die "Gagal memverifikasi password Admin Zabbix yang baru."
    ZBX_ADMIN_CHANGED=1
    info "Password default Admin Zabbix sudah diganti."
  else
    ZBX_ADMIN_MISMATCH=1
    warn "Password Admin Zabbix yang ada tidak diketahui, jadi tidak diubah."
    warn "Jalankan ulang dengan ZABBIX_ADMIN_PASSWORD=<password-sekarang>, atau RESET_ZABBIX_ADMIN=1 untuk menggantinya."
  fi
}

fetch_source() {
  local external=0
  if [[ -n $SCRIPT_DIR && -d $SCRIPT_DIR/backend && -d $SCRIPT_DIR/frontend \
    && $(realpath "$SCRIPT_DIR") != "$(realpath -m "$INSTALL_DIR")" ]]; then
    external=1
  fi

  if ((external)); then
    info "Menyalin kode dari ${SCRIPT_DIR} ke ${INSTALL_DIR}"
    mkdir -p "$INSTALL_DIR"
    rsync -a --delete \
      --exclude .git/ --exclude node_modules/ --exclude dist/ --exclude 'frontend-dist-backup-*/' \
      --exclude backend/.env --exclude backend/data/ --exclude backend/.data/ \
      "$SCRIPT_DIR/" "$INSTALL_DIR/"
  elif [[ -d $INSTALL_DIR/.git ]]; then
    info "Memperbarui kode dari ${REPO_URL} (${BRANCH})"
    git -c safe.directory="$INSTALL_DIR" -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -c safe.directory="$INSTALL_DIR" -C "$INSTALL_DIR" reset --hard FETCH_HEAD
  elif [[ -f $INSTALL_DIR/backend/package.json ]]; then
    info "Memakai kode yang sudah ada di ${INSTALL_DIR}"
  else
    if [[ -e $INSTALL_DIR && -n $(ls -A "$INSTALL_DIR") ]]; then
      die "${INSTALL_DIR} sudah berisi file tapi bukan repo git. Kosongkan atau pakai INSTALL_DIR lain."
    fi
    info "Mengunduh kode dari ${REPO_URL} (${BRANCH})"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
  [[ -f $INSTALL_DIR/backend/package.json && -f $INSTALL_DIR/frontend/package.json ]] \
    || die "Kode Kalimasada tidak lengkap di ${INSTALL_DIR}."
}

ensure_service_user() {
  [[ $SERVICE_USER == root ]] && return
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "/var/lib/${SERVICE_USER}" \
      --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
}

write_env() {
  local origin="http://${PUBLIC_HOST}"
  [[ $HTTP_PORT == 80 ]] || origin+=":${HTTP_PORT}"
  if [[ -n $NMS_DOMAIN ]]; then
    origin+=",https://${NMS_DOMAIN}"
    [[ $HTTP_PORT == 80 ]] && origin+=",http://${NMS_DOMAIN}" || origin+=",http://${NMS_DOMAIN}:${HTTP_PORT}"
  fi
  (
    umask 077
    cat >"$INSTALL_DIR/backend/.env" <<EOF
# Dikelola oleh deploy.sh: isi file ini ditulis ulang setiap deploy.
# Secret tersimpan di ${SECRETS_FILE}.
USE_EMBEDDED_POSTGRES=false
DATABASE_URL="postgresql://kalimasada:${APP_DB_PASSWORD}@127.0.0.1:${PG_PORT}/kalimasada"

JWT_SECRET="${JWT_SECRET}"
APP_ENCRYPTION_KEY="${APP_ENCRYPTION_KEY}"

ADMIN_EMAIL="${ADMIN_EMAIL}"
ADMIN_PASSWORD="${ADMIN_PASSWORD}"

PORT=${APP_PORT}
CORS_ORIGIN="${origin}"

ZABBIX_API_URL="http://127.0.0.1:${ZABBIX_WEB_PORT}/api_jsonrpc.php"
ZABBIX_USER=Admin
ZABBIX_PASSWORD="${ZABBIX_ADMIN_PASSWORD}"
ZABBIX_API_TOKEN=
ZABBIX_WEBHOOK_URL="http://127.0.0.1:${APP_PORT}/api/internal/zabbix/webhook"
ZABBIX_WEBHOOK_TOKEN="${ZABBIX_WEBHOOK_TOKEN}"

REDIS_URL=
EOF
  )
}

build_app() {
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  info "Build backend..."
  (cd "$INSTALL_DIR/backend" && npm ci --no-audit --no-fund --loglevel=error && npm run build)
  info "Build frontend..."
  (cd "$INSTALL_DIR/frontend" && npm ci --no-audit --no-fund --loglevel=error && npm run build)

  install -d "$WEB_ROOT"
  rsync -a --delete "$INSTALL_DIR/frontend/dist/" "$WEB_ROOT/"
  install -d "$INSTALL_DIR/backend/data"
  chown -R "${SERVICE_USER}:" "$INSTALL_DIR"
  chmod 600 "$INSTALL_DIR/backend/.env"
  [[ -f $SECRETS_FILE ]] && chown root:root "$SECRETS_FILE" && chmod 600 "$SECRETS_FILE"
  [[ -f $CREDENTIALS_FILE ]] && chown root:root "$CREDENTIALS_FILE" && chmod 600 "$CREDENTIALS_FILE"

  if [[ $(realpath -m "$INSTALL_DIR") == /root/* || $(realpath -m "$WEB_ROOT") == /root/* ]]; then
    chmod o+x /root
  fi
  chmod 755 "$INSTALL_DIR"
  [[ -d $WEB_ROOT ]] && chmod 755 "$WEB_ROOT"

  if [[ $SERVICE_USER != root ]] && ! runuser -u "$SERVICE_USER" -- test -r "$INSTALL_DIR/backend/dist/main.js"; then
    die "User ${SERVICE_USER} tidak bisa membaca ${INSTALL_DIR}. Pastikan direktori induk bisa ditelusuri."
  fi
  if id -u www-data >/dev/null 2>&1 && ! runuser -u www-data -- test -r "$WEB_ROOT/index.html"; then
    die "User www-data tidak bisa membaca ${WEB_ROOT}."
  fi
}

clear_stale_integration() {
  [[ $ZBX_ADMIN_CHANGED == 1 ]] || return 0
  if [[ -n $(app_psql -c "SELECT to_regclass('public.\"Setting\"')") ]]; then
    app_psql -c "DELETE FROM \"Setting\" WHERE key IN ('zabbix_user', 'zabbix_password_enc', 'zabbix_api_token_enc', 'zabbix_api_url')"
  fi
}

install_service() {
  local node_bin home
  node_bin=$(command -v node)
  home=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
  {
    cat <<EOF
[Unit]
Description=Kalimasada NMS API
After=network-online.target postgresql.service zabbix-server.service
Wants=network-online.target postgresql.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/backend
Environment=NODE_ENV=production
Environment=HOME=${home}
ExecStart=${node_bin} dist/main.js
Restart=on-failure
RestartSec=5
EOF
    if [[ $SERVICE_USER != root ]]; then
      cat <<EOF
User=${SERVICE_USER}
Group=$(id -gn "$SERVICE_USER")
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
NoNewPrivileges=true
EOF
    fi
    cat <<EOF

[Install]
WantedBy=multi-user.target
EOF
  } >"/etc/systemd/system/${SERVICE_NAME}.service"

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"
}

# Layanan root terpisah untuk interface, VLAN, IP, route, dan VPN. Kodenya disalin
# ke luar INSTALL_DIR agar user service tidak bisa mengubah program yang jalan sebagai root.
install_netd() {
  local node_bin dest=/usr/local/lib/kalimasada/netd
  node_bin=$(command -v node)
  install -d -m 755 /usr/local/lib/kalimasada
  rsync -a --delete "$INSTALL_DIR/backend/netd/" "$dest/"
  chown -R root:root "$dest"
  chmod -R go-w "$dest"
  install -d -m 700 /etc/kalimasada
  if [[ ! -f /etc/kalimasada/network.json ]]; then
    systemctl disable --now xl2tpd strongswan-starter >/dev/null 2>&1 || true
  fi

  cat >/etc/systemd/system/kalimasada-netd.service <<EOF
[Unit]
Description=Kalimasada NMS network (interface, VLAN, route, VPN)
After=network-online.target
Wants=network-online.target
Before=${SERVICE_NAME}.service

[Service]
Type=simple
ExecStart=${node_bin} ${dest}/main.js
Environment=NETD_GROUP=$(id -gn "$SERVICE_USER")
RuntimeDirectory=kalimasada-netd
RuntimeDirectoryMode=0755
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable kalimasada-netd >/dev/null 2>&1
  systemctl restart kalimasada-netd
}

has_cert() { [[ -n $1 && -s /etc/letsencrypt/live/$1/fullchain.pem ]]; }

nms_locations() {
  cat <<EOF
    root ${WEB_ROOT};
    index index.html;
    client_max_body_size 20m;

    location /api/ {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600s;
    }

    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
EOF
}

zabbix_locations() {
  cat <<EOF
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:${ZABBIX_WEB_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
EOF
}

acme_location() {
  cat <<EOF
    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_ROOT};
        default_type text/plain;
    }
EOF
}

# Domain yang sudah punya sertifikat dilayani lewat HTTPS dan port HTTP-nya dialihkan.
# Domain tanpa sertifikat tetap dilayani lewat HTTP biasa.
domain_server() {
  local domain=$1 kind=$2 v6_http="" v6_https=""
  if [[ -f /proc/net/if_inet6 ]]; then
    v6_http="    listen [::]:${HTTP_PORT};"
    v6_https="    listen [::]:443 ssl http2;"
  fi
  if has_cert "$domain"; then
    cat <<EOF

server {
    listen ${HTTP_PORT};
${v6_http}
    server_name ${domain};
$(acme_location)

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
${v6_https}
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:kalimasada_ssl:10m;
    ssl_session_timeout 1d;

$("${kind}_locations")
}
EOF
  else
    cat <<EOF

server {
    listen ${HTTP_PORT};
${v6_http}
    server_name ${domain};
$(acme_location)

$("${kind}_locations")
}
EOF
  fi
}

install_nginx_site() {
  local v6=""
  if [[ -f /proc/net/if_inet6 ]]; then v6="    listen [::]:${HTTP_PORT} default_server;"; fi
  install -d "$ACME_ROOT"
  {
    cat <<EOF
server {
    listen ${HTTP_PORT} default_server;
${v6}
    server_name _;
$(acme_location)

$(nms_locations)
}
EOF
    [[ -z $NMS_DOMAIN ]] || domain_server "$NMS_DOMAIN" nms
    [[ -z $ZABBIX_DOMAIN ]] || domain_server "$ZABBIX_DOMAIN" zabbix
  } >/etc/nginx/sites-available/kalimasada
  ln -sfn /etc/nginx/sites-available/kalimasada /etc/nginx/sites-enabled/kalimasada
  nginx -t -q
  systemctl reload-or-restart nginx

  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${HTTP_PORT}/tcp" >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow "${ZABBIX_WEB_PORT}/tcp" >/dev/null
    info "Firewall ufw: port ${HTTP_PORT}, 443, dan ${ZABBIX_WEB_PORT} dibuka."
  fi
}

points_here() {
  local ip
  ip=$(getent ahostsv4 "$1" 2>/dev/null | awk 'NR == 1 {print $1}')
  [[ -n $ip ]] && hostname -I 2>/dev/null | tr ' ' '\n' | grep -qxF "$ip"
}

setup_https() {
  [[ $ENABLE_HTTPS == 1 ]] || return 0
  local domain added=0 email_args=(--register-unsafely-without-email)
  [[ -z $LE_EMAIL ]] || email_args=(--email "$LE_EMAIL" --no-eff-email)
  for domain in "$NMS_DOMAIN" "$ZABBIX_DOMAIN"; do
    [[ -n $domain ]] || continue
    if has_cert "$domain"; then
      info "Sertifikat ${domain} sudah ada (diperpanjang otomatis oleh certbot)."
      continue
    fi
    if ((HTTP_PORT != 80)); then
      warn "HTTPS ${domain} dilewati: Let's Encrypt butuh HTTP_PORT=80."
      continue
    fi
    if ! points_here "$domain"; then
      warn "HTTPS ${domain} dilewati: DNS belum mengarah ke server ini. Jalankan ulang deploy.sh setelah DNS diubah."
      continue
    fi
    command -v certbot >/dev/null || apt_install certbot
    if certbot certonly --webroot -w "$ACME_ROOT" -d "$domain" --cert-name "$domain" \
      --non-interactive --agree-tos "${email_args[@]}" \
      --deploy-hook "systemctl reload nginx"; then
      info "Sertifikat ${domain} dibuat."
      added=1
    else
      warn "Gagal membuat sertifikat ${domain}; domain tetap dilayani lewat HTTP."
    fi
  done
  if ((added)); then install_nginx_site; fi
}

domain_url() { if has_cert "$1"; then printf 'https://%s' "$1"; else printf 'http://%s' "$1"; fi; }

api_up() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${HTTP_PORT}/api/health")
  [[ $code =~ ^[1-4] ]] || [[ $code == 503 ]]
}

check_health() {
  info "Menunggu API siap..."
  if wait_for 60 api_up; then
    info "Health: $(curl -s --max-time 10 "http://127.0.0.1:${HTTP_PORT}/api/health")"
  else
    warn "API belum menjawab. Cek log: journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
  fi
}

write_credentials() {
  APP_URL="http://${PUBLIC_HOST}"
  [[ $HTTP_PORT == 80 ]] || APP_URL+=":${HTTP_PORT}"
  ZBX_URL="http://${PUBLIC_HOST}:${ZABBIX_WEB_PORT}"
  [[ -z $NMS_DOMAIN ]] || APP_URL+=" atau $(domain_url "$NMS_DOMAIN")"
  [[ -z $ZABBIX_DOMAIN ]] || ZBX_URL+=" atau $(domain_url "$ZABBIX_DOMAIN")"
  (
    umask 077
    cat >"$CREDENTIALS_FILE" <<EOF
Kalimasada NMS - dibuat oleh deploy.sh pada $(date '+%F %T')

Dashboard NMS : ${APP_URL}
  Email       : ${ADMIN_EMAIL}
  Password    : ${ADMIN_PASSWORD}
  (Password awal. Bila akun ini sudah ada sebelumnya, password lamanya tetap berlaku.)

Zabbix        : ${ZBX_URL}
  User        : Admin
  Password    : ${ZABBIX_ADMIN_PASSWORD}

PostgreSQL 127.0.0.1:${PG_PORT}
  zabbix      : zabbix / ${ZABBIX_DB_PASSWORD}
  kalimasada  : kalimasada / ${APP_DB_PASSWORD}
EOF
  )
}

summary() {
  printf '\n\033[1;32mDeploy selesai.\033[0m\n\n'
  cat <<EOF
  Dashboard NMS : ${APP_URL}
    Email       : ${ADMIN_EMAIL}
    Password    : ${ADMIN_PASSWORD}

  Zabbix        : ${ZBX_URL}
    User        : Admin
    Password    : ${ZABBIX_ADMIN_PASSWORD}

  Semua kredensial tersimpan di ${CREDENTIALS_FILE} (hanya root).

  Perintah berguna:
    systemctl status ${SERVICE_NAME}
    journalctl -u ${SERVICE_NAME} -f
    sudo bash ${INSTALL_DIR}/deploy.sh      # update dan deploy ulang
EOF
  if [[ $ZBX_ADMIN_MISMATCH == 1 ]]; then
    warn "Password Admin Zabbix di atas belum cocok dengan Zabbix. Atur di menu Settings > Integrasi NMS atau jalankan ulang script."
  fi
}

main() {
  if [[ ${1:-} == -h || ${1:-} == --help ]]; then usage; exit 0; fi

  step "Pemeriksaan awal"
  preflight

  step "Paket dasar (PostgreSQL, nginx, fping, SNMP)"
  install_base
  load_secrets
  save_secrets

  step "Node.js"
  install_node

  step "Database PostgreSQL"
  setup_postgres

  step "Zabbix ${ZABBIX_VERSION}"
  install_zabbix
  configure_zabbix
  setup_zabbix_admin
  save_secrets

  step "Kode Kalimasada NMS"
  fetch_source
  ensure_service_user
  write_env

  step "Build aplikasi"
  build_app
  clear_stale_integration

  step "Service dan nginx"
  install_netd
  install_service
  install_nginx_site

  step "HTTPS domain"
  setup_https

  step "Pemeriksaan akhir"
  check_health
  write_credentials
  summary
}

main "$@"
