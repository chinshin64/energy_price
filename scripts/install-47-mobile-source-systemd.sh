#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-/opt/data-for-didi-mobile-source}"
MIGRATION_RUNNER="$ROOT/scripts/run-47-mobile-source-migration.sh"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-${ENV_FILE:-$ROOT/.env.mobile-source}}"
MIGRATION_ENV_FILE="${MIGRATION_ENV_FILE:-$ROOT/.env.mobile-source-migration}"
SERVICE_USER="${SERVICE_USER:-datafordidi-mobile}"
SERVICE_GROUP="${SERVICE_GROUP:-datafordidi-mobile}"
SERVICE_NAME="data-for-didi-mobile-source.service"
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
ENV_BIN="${ENV_BIN:-/usr/bin/env}"
BACKUP_BASE="${BACKUP_BASE:-/root/data-for-didi-mobile-source-backups}"
MODE="${1:---all}"
DATABASE_BACKUP_CONFIRMED="${DATABASE_BACKUP_CONFIRMED:-0}"
ROLLBACK_ROOT="${ROLLBACK_ROOT:-}"
EXPECTED_RUNTIME_HOST="127.0.0.1"
EXPECTED_RUNTIME_PORT="50081"
SMOKE_RUNTIME_PORT="${SMOKE_RUNTIME_PORT:-50082}"
HEALTH_URL="http://${EXPECTED_RUNTIME_HOST}:${EXPECTED_RUNTIME_PORT}/health"
SMOKE_HEALTH_URL="http://${EXPECTED_RUNTIME_HOST}:${SMOKE_RUNTIME_PORT}/health"
SMOKE_SERVICE_NAME="data-for-didi-mobile-source-candidate.service"
SMOKE_UNIT_FILE="/run/systemd/system/$SMOKE_SERVICE_NAME"

BACKUP_DIR=""
CANDIDATE_UNIT=""
SMOKE_UNIT=""
ROLLBACK_UNIT=""
HAD_UNIT=0
WAS_ACTIVE=0
CUTOVER_STARTED=0
CUTOVER_SUCCEEDED=0
CANDIDATE_MANIFEST=""

fail() {
  echo "$1" >&2
  exit 1
}

require_root() {
  [ "$(id -u)" -eq 0 ] || fail "Run as root on 47"
}

require_mode() {
  case "$MODE" in
    --preflight|--migrate|--cutover|--all) ;;
    *) fail "Usage: $0 [--preflight|--migrate|--cutover|--all]" ;;
  esac
}

file_mode() {
  stat -c '%a' "$1"
}

assert_protected_file() {
  local path="$1"
  local label="$2"
  [ -f "$path" ] || fail "Missing protected $label file"
  [ "$(file_mode "$path")" = "600" ] || fail "Protected $label file must have mode 600"
  [ "$(stat -c '%U:%G' "$path")" = "root:root" ] \
    || fail "Protected $label file must be owned by root:root"
}

create_service_identity() {
  if ! getent group "$SERVICE_GROUP" >/dev/null; then
    groupadd --system "$SERVICE_GROUP"
  fi
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --gid "$SERVICE_GROUP" --home-dir /nonexistent \
      --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
}

create_backup() {
  local timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  umask 077
  mkdir -p "$BACKUP_BASE"
  chmod 700 "$BACKUP_BASE"
  BACKUP_DIR="$(mktemp -d "$BACKUP_BASE/mobile-source-v4-$timestamp.XXXXXX")"
  chmod 700 "$BACKUP_DIR"

  if [ -f "$UNIT_FILE" ]; then
    install -o root -g root -m 600 "$UNIT_FILE" "$BACKUP_DIR/previous.service"
    HAD_UNIT=1
  fi
  install -o root -g root -m 600 \
    "$RUNTIME_ENV_FILE" "$BACKUP_DIR/runtime.env.backup"
  install -o root -g root -m 600 \
    "$MIGRATION_ENV_FILE" "$BACKUP_DIR/migration.env.backup"
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    WAS_ACTIVE=1
  fi
}

assert_node_runtime() {
  [ -x "$NODE_BIN" ] || fail "Controlled Node.js runtime is missing"
  [ -x "$ENV_BIN" ] || fail "The controlled environment launcher is missing"
  [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" = "22" ] \
    || fail "47 mobile source service requires a controlled Node.js 22 runtime"
}

assert_smoke_runtime_port() {
  case "$SMOKE_RUNTIME_PORT" in
    ''|*[!0-9]*) fail "SMOKE_RUNTIME_PORT must be an integer" ;;
  esac
  [ "$SMOKE_RUNTIME_PORT" -ge 50082 ] && [ "$SMOKE_RUNTIME_PORT" -le 50200 ] \
    || fail "SMOKE_RUNTIME_PORT must stay within the controlled 50082-50200 range"
  [ "$SMOKE_RUNTIME_PORT" != "$EXPECTED_RUNTIME_PORT" ] \
    || fail "SMOKE_RUNTIME_PORT must differ from the production runtime port"

  runuser -u "$SERVICE_USER" -- "$NODE_BIN" - \
    "$EXPECTED_RUNTIME_HOST" "$SMOKE_RUNTIME_PORT" <<'NODE'
const net = require('node:net');

const host = process.argv[2];
const port = Number(process.argv[3]);
const server = net.createServer();
server.once('error', error => {
    console.error(`Candidate smoke port is unavailable [${error.code || 'listen_failed'}]`);
    process.exit(1);
});
server.listen({ host, port, exclusive: true }, () => {
    server.close(error => {
        if (error) {
            console.error('Candidate smoke port probe could not close cleanly');
            process.exit(1);
        }
    });
});
NODE
}

assert_release() {
  local release_root="$1"
  local label="$2"
  local release_runner="$release_root/scripts/run-47-mobile-source-foreground.sh"
  local release_migration_runner="$release_root/scripts/run-47-mobile-source-migration.sh"
  local runtime_modules="$release_root/backend/mobile-source-runtime/node_modules"
  local target_version

  [ -x "$release_runner" ] || fail "$label runner is missing or not executable"
  [ -x "$release_migration_runner" ] \
    || fail "$label migration runner is missing or not executable"
  [ -r "$release_root/scripts/install-47-mobile-source-systemd.sh" ] \
    || fail "$label deployment controller is missing"
  [ -r "$release_root/backend/scripts/start-mobile-source-node.js" ] \
    || fail "$label source-node entrypoint is missing"
  [ -r "$runtime_modules/express/package.json" ] \
    || fail "$label minimal runtime dependencies are missing"
  [ -r "$release_root/backend/services/fuel-payload-policy.js" ] \
    || fail "$label fuel payload policy is missing"
  [ -r "$release_root/backend/services/mobile-source-migration-identity-policy.js" ] \
    || fail "$label migration identity policy is missing"
  [ -r "$release_root/backend/scripts/validate-mobile-source-deployment-env.js" ] \
    || fail "$label protected environment validator is missing"

  target_version="$(
    "$NODE_BIN" -e '
      const modulePath = process.argv[1];
      const migration = require(modulePath);
      process.stdout.write(String(migration.TARGET_SCHEMA_VERSION));
    ' "$release_root/backend/services/mobile-source-mysql-migrator.js"
  )"
  [ "$target_version" = "4" ] || fail "$label is not physical-schema-v4 compatible"

  runuser -u "$SERVICE_USER" -- test -x "$release_runner" \
    || fail "Service user cannot execute $label runner"
  runuser -u "$SERVICE_USER" -- test -r \
    "$release_root/backend/scripts/start-mobile-source-node.js" \
    || fail "Service user cannot read $label source-node entrypoint"
  runuser -u "$SERVICE_USER" -- test -r "$runtime_modules/express/package.json" \
    || fail "Service user cannot read $label runtime dependencies"
}

release_manifest() {
  local release_root="$1"
  "$NODE_BIN" - "$release_root" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
const files = [
    'backend/mobile-source-node.js',
    'backend/scripts/migrate-mobile-source-mysql.js',
    'backend/scripts/start-mobile-source-node.js',
    'backend/scripts/validate-mobile-source-deployment-env.js',
    'backend/services/fuel-payload-policy.js',
    'backend/services/mobile-source-auth.js',
    'backend/services/mobile-source-migration-identity-policy.js',
    'backend/services/mobile-source-mysql-migrator.js',
    'backend/services/mobile-source-node-service.js',
    'backend/services/mysql-mobile-source-store.js',
    'backend/mobile-source-runtime/package.json',
    'backend/mobile-source-runtime/package-lock.json',
    'scripts/run-47-mobile-source-foreground.sh',
    'scripts/run-47-mobile-source-migration.sh',
    'scripts/install-47-mobile-source-systemd.sh',
];
const hash = crypto.createHash('sha256');
for (const relative of files) {
    const absolute = path.join(root, relative);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error(`release manifest member is not a file: ${relative}`);
    hash.update(relative, 'utf8');
    hash.update('\0');
    hash.update(fs.readFileSync(absolute));
    hash.update('\0');
}
process.stdout.write(hash.digest('hex'));
NODE
}

assert_same_release_manifest() {
  local rollback_manifest
  [ -n "$ROLLBACK_ROOT" ] || return 0
  [ -n "$CANDIDATE_MANIFEST" ] || fail "Candidate release manifest was not computed"
  rollback_manifest="$(release_manifest "$ROLLBACK_ROOT")"
  [ "$rollback_manifest" = "$CANDIDATE_MANIFEST" ] \
    || fail "Rollback release must contain the same physical-schema-v4 release manifest as the candidate"
}

runtime_root_from_unit() {
  [ -f "$UNIT_FILE" ] || return 0
  awk -F= '
    $1 == "WorkingDirectory" {
      sub(/^[[:space:]]+/, "", $2);
      sub(/[[:space:]]+$/, "", $2);
      print $2;
      exit;
    }
  ' "$UNIT_FILE"
}

resolve_rollback_release() {
  local unit_root=""
  if [ -z "$ROLLBACK_ROOT" ]; then
    unit_root="$(runtime_root_from_unit)"
    if [ -n "$unit_root" ] && [ "$unit_root" != "$ROOT" ]; then
      ROLLBACK_ROOT="$unit_root"
    fi
  fi

  if [ "$WAS_ACTIVE" = "1" ]; then
    [ -n "$ROLLBACK_ROOT" ] \
      || fail "Active service requires an explicit physical-schema-v4-compatible ROLLBACK_ROOT"
    [ "$ROLLBACK_ROOT" != "$ROOT" ] \
      || fail "ROLLBACK_ROOT must be different from the candidate ROOT"
    assert_release "$ROLLBACK_ROOT" "Rollback release"
  elif [ -n "$ROLLBACK_ROOT" ]; then
    [ "$ROLLBACK_ROOT" != "$ROOT" ] \
      || fail "ROLLBACK_ROOT must be different from the candidate ROOT"
    assert_release "$ROLLBACK_ROOT" "Rollback release"
  fi
  assert_same_release_manifest
}

assert_environment_contract() {
  local runtime_modules="$ROOT/backend/mobile-source-runtime/node_modules"
  NODE_PATH="$runtime_modules" "$NODE_BIN" \
    "$ROOT/backend/scripts/validate-mobile-source-deployment-env.js" \
    "$RUNTIME_ENV_FILE" "$MIGRATION_ENV_FILE" \
    "$EXPECTED_RUNTIME_HOST" "$EXPECTED_RUNTIME_PORT"
}

write_unit() {
  local release_root="$1"
  local destination="$2"
  local release_runner="$release_root/scripts/run-47-mobile-source-foreground.sh"
  install -o root -g root -m 600 /dev/stdin "$destination" <<UNIT
[Unit]
Description=Data for Didi mobile OCR MySQL source node
After=network-online.target mysql.service mysqld.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$release_root
EnvironmentFile=$RUNTIME_ENV_FILE
ExecStart=$ENV_BIN ROOT=$release_root ENV_FILE=$RUNTIME_ENV_FILE NODE_BIN=$NODE_BIN MOBILE_SOURCE_HOST=$EXPECTED_RUNTIME_HOST MOBILE_SOURCE_PORT=$EXPECTED_RUNTIME_PORT MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false $release_runner
Restart=always
RestartSec=3
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
UNIT
}

write_smoke_unit() {
  local release_root="$1"
  local destination="$2"
  local release_runner="$release_root/scripts/run-47-mobile-source-foreground.sh"
  install -o root -g root -m 600 /dev/stdin "$destination" <<UNIT
[Unit]
Description=Pre-cutover validation for the Data for Didi mobile source
After=network-online.target mysql.service mysqld.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$release_root
EnvironmentFile=$RUNTIME_ENV_FILE
ExecStart=$ENV_BIN ROOT=$release_root ENV_FILE=$RUNTIME_ENV_FILE NODE_BIN=$NODE_BIN MOBILE_SOURCE_HOST=$EXPECTED_RUNTIME_HOST MOBILE_SOURCE_PORT=$SMOKE_RUNTIME_PORT MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false $release_runner
Restart=no
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UNIT
}

assert_unit_release_root() {
  local unit_path="$1"
  local release_root="$2"
  local runtime_port="$3"
  local release_runner="$release_root/scripts/run-47-mobile-source-foreground.sh"
  local expected_exec

  expected_exec="ExecStart=$ENV_BIN ROOT=$release_root ENV_FILE=$RUNTIME_ENV_FILE NODE_BIN=$NODE_BIN MOBILE_SOURCE_HOST=$EXPECTED_RUNTIME_HOST MOBILE_SOURCE_PORT=$runtime_port MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false $release_runner"
  grep -Fqx "WorkingDirectory=$release_root" "$unit_path" \
    || fail "Generated unit WorkingDirectory does not match its release root"
  grep -Fqx "EnvironmentFile=$RUNTIME_ENV_FILE" "$unit_path" \
    || fail "Generated unit EnvironmentFile does not match the protected runtime environment"
  grep -Fqx "$expected_exec" "$unit_path" \
    || fail "Generated unit ExecStart does not bind ROOT, ENV_FILE and runner correctly"
}

verify_unit_file() {
  local unit_path="$1"
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "$unit_path" >/dev/null
  fi
}

preflight() {
  require_root
  require_mode
  assert_node_runtime
  assert_protected_file "$RUNTIME_ENV_FILE" "runtime environment"
  assert_protected_file "$MIGRATION_ENV_FILE" "migration environment"
  create_service_identity
  create_backup
  assert_smoke_runtime_port
  assert_release "$ROOT" "Candidate release"
  CANDIDATE_MANIFEST="$(release_manifest "$ROOT")"
  resolve_rollback_release
  assert_environment_contract

  CANDIDATE_UNIT="$BACKUP_DIR/candidate.service"
  write_unit "$ROOT" "$CANDIDATE_UNIT"
  assert_unit_release_root "$CANDIDATE_UNIT" "$ROOT" "$EXPECTED_RUNTIME_PORT"
  verify_unit_file "$CANDIDATE_UNIT"
  SMOKE_UNIT="$BACKUP_DIR/candidate-smoke.service"
  write_smoke_unit "$ROOT" "$SMOKE_UNIT"
  assert_unit_release_root "$SMOKE_UNIT" "$ROOT" "$SMOKE_RUNTIME_PORT"
  verify_unit_file "$SMOKE_UNIT"
  if [ -n "$ROLLBACK_ROOT" ]; then
    ROLLBACK_UNIT="$BACKUP_DIR/rollback.service"
    write_unit "$ROLLBACK_ROOT" "$ROLLBACK_UNIT"
    assert_unit_release_root \
      "$ROLLBACK_UNIT" "$ROLLBACK_ROOT" "$EXPECTED_RUNTIME_PORT"
    verify_unit_file "$ROLLBACK_UNIT"
  fi

  ROOT="$ROOT" \
  NODE_BIN="$NODE_BIN" \
  ENV_FILE="$MIGRATION_ENV_FILE" \
  RUNTIME_ENV_FILE="$RUNTIME_ENV_FILE" \
  "$MIGRATION_RUNNER" --dry-run
}

require_database_backup() {
  [ "$DATABASE_BACKUP_CONFIRMED" = "1" ] \
    || fail "Set DATABASE_BACKUP_CONFIRMED=1 only after a recoverable database backup is verified"
}

migrate_before_cutover() {
  if [ "$MODE" = "--migrate" ] && [ "$WAS_ACTIVE" = "1" ]; then
    fail "--migrate refuses an active v2/v3/v4 service; use --all for an indivisible migration and cutover"
  fi
  require_database_backup
  ROOT="$ROOT" \
  NODE_BIN="$NODE_BIN" \
  ENV_FILE="$MIGRATION_ENV_FILE" \
  RUNTIME_ENV_FILE="$RUNTIME_ENV_FILE" \
  "$MIGRATION_RUNNER" --apply
  ROOT="$ROOT" \
  NODE_BIN="$NODE_BIN" \
  ENV_FILE="$MIGRATION_ENV_FILE" \
  RUNTIME_ENV_FILE="$RUNTIME_ENV_FILE" \
  "$MIGRATION_RUNNER" --validate-only
}

validate_before_cutover() {
  ROOT="$ROOT" \
  NODE_BIN="$NODE_BIN" \
  ENV_FILE="$MIGRATION_ENV_FILE" \
  RUNTIME_ENV_FILE="$RUNTIME_ENV_FILE" \
  "$MIGRATION_RUNNER" --validate-only
}

wait_for_health() {
  local url="${1:-$HEALTH_URL}"
  local attempt
  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cleanup_smoke_service() {
  systemctl stop "$SMOKE_SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$SMOKE_UNIT_FILE"
  systemctl daemon-reload >/dev/null 2>&1 || true
}

smoke_candidate_before_cutover() {
  install -o root -g root -m 644 "$SMOKE_UNIT" "$SMOKE_UNIT_FILE"
  systemctl daemon-reload
  systemctl start "$SMOKE_SERVICE_NAME"
  wait_for_health "$SMOKE_HEALTH_URL"
  cleanup_smoke_service
}

rollback_cutover() {
  local original_status="$1"
  trap - ERR
  set +e
  echo "Cutover failed; restoring the prevalidated feature-disabled service" >&2
  cleanup_smoke_service
  systemctl stop "$SERVICE_NAME" >/dev/null 2>&1

  if [ -n "$ROLLBACK_UNIT" ] && [ -f "$ROLLBACK_UNIT" ]; then
    install -o root -g root -m 644 "$ROLLBACK_UNIT" "$UNIT_FILE"
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
    systemctl start "$SERVICE_NAME"
    if wait_for_health; then
      echo "Rollback service is active with fuel-quote-v1 disabled" >&2
    else
      echo "Rollback service failed its local health check; manual recovery is required" >&2
    fi
  else
    if [ "$HAD_UNIT" = "1" ]; then
      install -o root -g root -m 644 "$BACKUP_DIR/previous.service" "$UNIT_FILE"
    else
      rm -f "$UNIT_FILE"
      systemctl disable "$SERVICE_NAME" >/dev/null 2>&1
    fi
    systemctl daemon-reload
    echo "No physical-schema-v4-compatible rollback release was active; the candidate remains stopped" >&2
  fi
  exit "$original_status"
}

handle_error() {
  local status=$?
  if [ "$CUTOVER_STARTED" = "1" ] && [ "$CUTOVER_SUCCEEDED" != "1" ]; then
    rollback_cutover "$status"
  fi
  exit "$status"
}

cutover() {
  validate_before_cutover
  smoke_candidate_before_cutover
  CUTOVER_STARTED=1
  install -o root -g root -m 644 "$CANDIDATE_UNIT" "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"
  wait_for_health
  CUTOVER_SUCCEEDED=1
  echo "47 mobile source physical v4 service cutover passed with fuel-quote-v1 disabled"
}

main() {
  trap handle_error ERR
  preflight
  case "$MODE" in
    --preflight)
      echo "Preflight passed; no migration or service cutover was performed"
      ;;
    --migrate)
      migrate_before_cutover
      echo "Migration and validation passed; the service was not stopped or replaced"
      ;;
    --cutover)
      cutover
      ;;
    --all)
      migrate_before_cutover
      # From this point schema metadata is v4. Any subsequent failure must
      # complete the indivisible release by starting the same-manifest v4 fallback.
      CUTOVER_STARTED=1
      cutover
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
