#!/usr/bin/env bash
#
# Installed-artifact E2E for the dual OpenCode V1/V2 package.
#
# This script deliberately does not use the user's OpenCode service. Every
# host, fake provider, config file, database, cache, and state file is rooted
# below one temporary directory and every launched process receives env -i.
#
# Usage:
#   ./scripts/e2e/run-installed-e2e.sh
#   KEEP_E2E=1 ./scripts/e2e/run-installed-e2e.sh
#   SKIP_BUILD=1 ./scripts/e2e/run-installed-e2e.sh

set -euo pipefail

c_grn=$'\033[32m'
c_red=$'\033[31m'
c_ylw=$'\033[33m'
c_blu=$'\033[34m'
c_rst=$'\033[0m'
pass() { printf '%sPASS%s %s\n' "$c_grn" "$c_rst" "$*"; }
info() { printf '%s…%s %s\n' "$c_ylw" "$c_rst" "$*" >&2; }
step() { printf '%s==>%s %s\n' "$c_blu" "$c_rst" "$*" >&2; }
die() { printf '%sFAIL%s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/scripts/e2e"
APPROVED_E2E_ROOT="/tmp/opencode/acp-e2e"
E2E_BASE_INPUT="${E2E_ROOT:-$APPROVED_E2E_ROOT}"
KEEP_E2E="${KEEP_E2E:-0}"
START_SECONDS="$(date +%s)"

normalize_path() {
    realpath -m -- "$1"
}

directory_identity() {
    local candidate="$1"
    [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
    stat -Lc '%d:%i' -- "$candidate"
}

is_path_below_or_equal() {
    local parent="$1"
    local candidate="$2"
    [[ "$candidate" == "$parent" || "$candidate" == "$parent/"* ]]
}

validate_e2e_base() {
    local candidate
    candidate="$(normalize_path "$1")" || return 1
    if [[ -e "$1" && "$candidate" != "$1" ]]; then
        return 1
    fi
    [[ ! -L "$candidate" ]] || return 1
    is_path_below_or_equal "$APPROVED_E2E_ROOT" "$candidate" || return 1
    printf '%s\n' "$candidate"
}

validate_generated_root() {
    local base="$1"
    local candidate="$2"
    local normalized_base
    local normalized_candidate
    normalized_base="$(normalize_path "$base")" || return 1
    normalized_candidate="$(normalize_path "$candidate")" || return 1

    # A generated run directory must be a strict descendant of the validated
    # base. In particular, neither the base nor the approved root is a valid
    # deletion target, even when a caller supplied the approved root itself.
    [[ "$normalized_candidate" != "$normalized_base" ]] || return 1
    is_path_below_or_equal "$normalized_base" "$normalized_candidate" || return 1
    [[ "$normalized_candidate" != "$APPROVED_E2E_ROOT" ]] || return 1
    is_path_below_or_equal "$APPROVED_E2E_ROOT" "$normalized_candidate" || return 1
    [[ "$normalized_candidate" != "/" ]] || return 1
    [[ "$normalized_candidate" == "$candidate" ]] || return 1
    [[ ! -L "$candidate" ]] || return 1
    [[ "$(basename "$candidate")" == run-* ]] || return 1
    return 0
}

create_generated_root() {
    local base="$1"
    mkdir -p -- "$base"
    [[ ! -L "$base" ]] || return 1
    local generated
    generated="$(mktemp -d "$base/run-XXXXXXXXXX")" || return 1
    generated="$(normalize_path "$generated")" || return 1
    validate_generated_root "$base" "$generated" || return 1
    printf '%s\n' "$generated"
}

remove_generated_root() {
    local base="$1"
    local generated="$2"
    local expected_identity="${3:-}"
    [[ -n "$generated" && -n "$expected_identity" ]] || return 1
    if [[ ! -e "$generated" && ! -L "$generated" ]]; then
        return 0
    fi
    [[ -d "$generated" && ! -L "$generated" ]] || return 1
    validate_generated_root "$base" "$generated" || return 1
    [[ "$(directory_identity "$generated")" == "$expected_identity" ]] || return 1
    rm -rf -- "$generated"
}

guard_self_test() {
    local base="$APPROVED_E2E_ROOT"
    mkdir -p -- "$base"

    local traversal="$base/../acp-e2e-traversal"
    local sibling="${base}-sibling"
    local unsafe_parent="/tmp/opencode"
    local exact_root="$base"

    if validate_e2e_base "$traversal" >/dev/null 2>&1; then
        die "guard self-test accepted traversal base"
    fi
    if validate_e2e_base "$sibling" >/dev/null 2>&1; then
        die "guard self-test accepted sibling base"
    fi
    if validate_e2e_base "$unsafe_parent" >/dev/null 2>&1; then
        die "guard self-test accepted unsafe parent base"
    fi
    if validate_generated_root "$base" "$exact_root" >/dev/null 2>&1; then
        die "guard self-test accepted exact root deletion target"
    fi
    local symlink_base="$base/self-test-symlink-base"
    rm -f -- "$symlink_base"
    ln -s -- "$base" "$symlink_base"
    if validate_e2e_base "$symlink_base" >/dev/null 2>&1; then
        rm -f -- "$symlink_base"
        die "guard self-test accepted a symlinked base"
    fi
    rm -f -- "$symlink_base"

    local path_one_file path_two_file path_one path_two pid_one pid_two
    path_one_file="$(mktemp)"
    path_two_file="$(mktemp)"
    (create_generated_root "$base") >"$path_one_file" &
    pid_one=$!
    (create_generated_root "$base") >"$path_two_file" &
    pid_two=$!
    wait "$pid_one"
    wait "$pid_two"
    read -r path_one <"$path_one_file"
    read -r path_two <"$path_two_file"
    rm -f -- "$path_one_file" "$path_two_file"

    [[ -n "$path_one" && -n "$path_two" && "$path_one" != "$path_two" ]] || \
        die "guard self-test did not create two unique concurrent paths"
    validate_generated_root "$base" "$path_one" || die "guard self-test rejected first unique path"
    validate_generated_root "$base" "$path_two" || die "guard self-test rejected second unique path"
    local identity_one identity_two
    identity_one="$(directory_identity "$path_one")"
    identity_two="$(directory_identity "$path_two")"
    remove_generated_root "$base" "$path_one" "$identity_one" || die "guard self-test failed first cleanup"
    remove_generated_root "$base" "$path_two" "$identity_two" || die "guard self-test failed second cleanup"
    [[ ! -e "$path_one" && ! -e "$path_two" ]] || die "guard self-test left a generated path"

    local race_path race_identity race_moved race_replacement_identity
    race_path="$(create_generated_root "$base")"
    race_identity="$(directory_identity "$race_path")"
    race_moved="${race_path}-moved"
    mv -- "$race_path" "$race_moved"
    mkdir -- "$race_path"
    if remove_generated_root "$base" "$race_path" "$race_identity" >/dev/null 2>&1; then
        die "guard self-test accepted an inode replacement"
    fi
    race_replacement_identity="$(directory_identity "$race_path")"
    remove_generated_root "$base" "$race_path" "$race_replacement_identity" || \
        die "guard self-test failed replacement cleanup"
    local race_moved_identity
    race_moved_identity="$(directory_identity "$race_moved")"
    remove_generated_root "$base" "$race_moved" "$race_moved_identity" || \
        die "guard self-test failed moved cleanup"

    local file_path file_identity file_moved file_replacement_identity
    file_path="$(create_generated_root "$base")"
    file_identity="$(directory_identity "$file_path")"
    file_moved="${file_path}-file-moved"
    mv -- "$file_path" "$file_moved"
    : >"$file_path"
    if remove_generated_root "$base" "$file_path" "$file_identity" >/dev/null 2>&1; then
        die "guard self-test accepted a regular-file replacement"
    fi
    rm -f -- "$file_path"
    file_replacement_identity="$(directory_identity "$file_moved")"
    remove_generated_root "$base" "$file_moved" "$file_replacement_identity" || \
        die "guard self-test failed regular-file cleanup"

    local symlink_path symlink_target symlink_moved symlink_identity symlink_replacement_identity
    symlink_path="$(create_generated_root "$base")"
    symlink_identity="$(directory_identity "$symlink_path")"
    symlink_moved="${symlink_path}-symlink-moved"
    symlink_target="$(mktemp "$base/symlink-target-XXXXXX")"
    mv -- "$symlink_path" "$symlink_moved"
    ln -s -- "$symlink_target" "$symlink_path"
    if remove_generated_root "$base" "$symlink_path" "$symlink_identity" >/dev/null 2>&1; then
        die "guard self-test accepted a symlink-to-file replacement"
    fi
    rm -f -- "$symlink_path" "$symlink_target"
    symlink_replacement_identity="$(directory_identity "$symlink_moved")"
    remove_generated_root "$base" "$symlink_moved" "$symlink_replacement_identity" || \
        die "guard self-test failed symlink replacement cleanup"

    pass "installed E2E path guard self-test passed (traversal, sibling, parent, exact-root, symlink, file, identity, concurrency)"
}

if [[ "${E2E_GUARD_TEST:-0}" == "1" || "${1:-}" == "--self-test" ]]; then
    guard_self_test
    exit 0
fi

E2E_BASE="$(validate_e2e_base "$E2E_BASE_INPUT")" || \
    die "E2E_ROOT must remain below /tmp/opencode/acp-e2e after normalization (got $E2E_BASE_INPUT)"
HARNESS_ROOT="$(create_generated_root "$E2E_BASE")" || \
    die "unable to create a unique installed E2E run directory below $E2E_BASE"
HARNESS_ROOT_IDENTITY="$(directory_identity "$HARNESS_ROOT")" || \
    die "unable to record unique installed E2E run identity"
info "installed E2E run root: $HARNESS_ROOT"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
CURL_BIN="${CURL_BIN:-$(command -v curl || true)}"
TAR_BIN="${TAR_BIN:-$(command -v tar || true)}"

[[ -x "$NODE_BIN" ]] || die "node executable not found (set NODE_BIN)"
[[ -x "$NPM_BIN" ]] || die "npm executable not found (set NPM_BIN)"
[[ -x "$BUN_BIN" ]] || die "bun executable not found (set BUN_BIN)"
[[ -x "$CURL_BIN" ]] || die "curl executable not found (set CURL_BIN)"
[[ -x "$TAR_BIN" ]] || die "tar executable not found (set TAR_BIN)"

NODE_DIR="$(dirname "$NODE_BIN")"
[[ -d "$HARNESS_ROOT" ]] || die "unique installed E2E run root disappeared: $HARNESS_ROOT"
mkdir -p -- "$HARNESS_ROOT"/{artifacts,build,hosts,logs,scenarios}

OWNED_PIDS=()
V2_PID=""
FAKE_PID=""

forget_owned_pid() {
    local target="$1"
    local retained=()
    for pid in "${OWNED_PIDS[@]}"; do
        [[ "$pid" == "$target" ]] || retained+=("$pid")
    done
    OWNED_PIDS=("${retained[@]}")
}

stop_owned_pid() {
    local pid="${1:-}"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 0
    if ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid" 2>/dev/null || true
        forget_owned_pid "$pid"
        return 0
    fi
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" 2>/dev/null || true
            forget_owned_pid "$pid"
            return 0
        fi
        sleep 0.1
    done
    # Escalate only the exact PID owned by this harness. Never use pkill or a
    # process-group kill because the user's OpenCode service must be untouched.
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    forget_owned_pid "$pid"
}

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    local cleanup_pids=("${OWNED_PIDS[@]}")
    for ((index = ${#cleanup_pids[@]} - 1; index >= 0; index--)); do
        stop_owned_pid "${cleanup_pids[index]}"
    done
    V2_PID=""
    FAKE_PID=""
    if [[ "$status" -eq 0 && "$KEEP_E2E" != "1" ]]; then
        if remove_generated_root "$E2E_BASE" "$HARNESS_ROOT" "$HARNESS_ROOT_IDENTITY"; then
            info "diagnostics cleaned: $HARNESS_ROOT"
        else
            info "diagnostics retained (safe cleanup refused): $HARNESS_ROOT"
        fi
    else
        info "diagnostics retained: $HARNESS_ROOT"
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

free_port() {
    "$NODE_BIN" -e '
        const net = require("node:net")
        const server = net.createServer()
        server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            process.stdout.write(String(typeof address === "object" && address ? address.port : ""))
            server.close()
        })
    '
}

EXPECTED_V2_TARBALL_DIAGNOSTIC="configured plugin path must be a directory"

log_byte_offset() {
    local path="$1"
    [[ -f "$path" ]] || { printf '0\n'; return 0; }
    stat -c '%s' -- "$path"
}

capture_new_log_lines() {
    local source="$1"
    local start="$2"
    local destination="$3"
    mkdir -p -- "$(dirname "$destination")"
    if [[ ! -f "$source" ]]; then
        : >"$destination"
        return 0
    fi
    local current
    current="$(log_byte_offset "$source")"
    if [[ "$current" -lt "$start" ]]; then
        start=0
    fi
    tail -c +$((start + 1)) -- "$source" >"$destination"
}

redact_diagnostic_file() {
    local source="$1"
    local destination="$2"
    if [[ ! -f "$source" ]]; then
        printf 'diagnostic source was not produced: %s\n' "$(basename "$source")" >"$destination"
        return 0
    fi
    # Preserve useful status/error text but never print or retain obvious
    # credentials, auth headers, or configured file URLs in the fallback
    # diagnostic copy.
    sed -E \
        -e 's#((api[-_]?key|authorization|password|token|secret)[[:space:]]*:[[:space:]]*)"[^"]*"#\1"<redacted>"#gi' \
        -e 's#((api[-_]?key|authorization|password|token|secret)[[:space:]]*=[[:space:]]*)("[^"]*"|[^,[:space:]}]+)#\1<redacted>#gi' \
        -e 's#(api[-_]?key|authorization|password|token|secret)[[:space:]]*[:=][[:space:]]*[^,[:space:]}" ]+#\1=<redacted>#gi' \
        -e 's#file:///[^[:space:]" ]+#file://<redacted>#g' \
        -e 's#/(home|root|tmp|var|opt)/[^[:space:]" ]+#<path-redacted>#g' \
        "$source" >"$destination"
}

record_v2_activation_observation() {
    local observations_path="$1"
    local exact_status="$2"
    local diagnostic_matched="$3"
    local fallback_used="$4"
    "$NODE_BIN" --input-type=module -e '
        import {readFileSync, renameSync, writeFileSync} from "node:fs"
        const [file, status, matched, fallback] = process.argv.slice(1)
        let observations = {}
        try { observations = JSON.parse(readFileSync(file, "utf8")) } catch {}
        observations.activation = {
            exactStatus: Number(status),
            exactDiagnosticMatched: matched === "true",
            fallbackUsed: fallback === "true",
        }
        const temporary = `${file}.activation-${process.pid}`
        writeFileSync(temporary, `${JSON.stringify(observations, null, 2)}\n`)
        renameSync(temporary, file)
    ' "$observations_path" "$exact_status" "$diagnostic_matched" "$fallback_used"
}

write_npmrc() {
    local path="$1"
    mkdir -p "$(dirname "$path")"
    cat > "$path" <<'NPMRC'
registry=https://registry.npmjs.org/
fund=false
audit=false
update-notifier=false
NPMRC
}

build_env() {
    local build_home="$HARNESS_ROOT/build/home"
    mkdir -p "$build_home" "$HARNESS_ROOT/build/tmp" "$HARNESS_ROOT/build/npm-cache"
    env -i \
        HOME="$build_home" \
        TMPDIR="$HARNESS_ROOT/build/tmp" \
        NPM_CONFIG_USERCONFIG="$HARNESS_ROOT/build/npmrc" \
        NPM_CONFIG_CACHE="$HARNESS_ROOT/build/npm-cache" \
        NPM_CONFIG_FUND=false \
        NPM_CONFIG_AUDIT=false \
        PATH="$REPO_ROOT/node_modules/.bin:$NODE_DIR:/usr/bin:/bin" \
        LANG=C.UTF-8 \
        LC_ALL=C.UTF-8 \
        TZ=UTC \
        "$@"
}

pack_artifact() {
    local artifacts="$HARNESS_ROOT/artifacts"
    write_npmrc "$HARNESS_ROOT/build/npmrc"
    if [[ -z "${SKIP_BUILD:-}" ]]; then
        step "build ACP package"
        if ! (cd "$REPO_ROOT" && build_env "$NPM_BIN" run build) >"$HARNESS_ROOT/build/build.log" 2>&1; then
            tail -80 "$HARNESS_ROOT/build/build.log" >&2 || true
            die "npm run build failed; diagnostics: $HARNESS_ROOT/build/build.log"
        fi
        pass "ACP build complete"
    else
        info "SKIP_BUILD=1 — using existing dist/"
    fi
    [[ -f "$REPO_ROOT/dist/index.js" ]] || die "dist/index.js is missing; build ACP first"

    step "pack ACP tarball (ignore lifecycle scripts during pack)"
    if ! (cd "$REPO_ROOT" && build_env "$NPM_BIN" pack --ignore-scripts --pack-destination "$artifacts") >"$HARNESS_ROOT/build/pack.log" 2>&1; then
        tail -100 "$HARNESS_ROOT/build/pack.log" >&2 || true
        die "npm pack failed; diagnostics: $HARNESS_ROOT/build/pack.log"
    fi
    ACP_TGZ="$(find "$artifacts" -maxdepth 1 -type f -name 'opencode-acp-*.tgz' -print -quit)"
    [[ -n "$ACP_TGZ" && -f "$ACP_TGZ" ]] || die "npm pack produced no opencode-acp tarball"
    "$TAR_BIN" -xOf "$ACP_TGZ" package/package.json >"$HARNESS_ROOT/artifacts/package.json"
    ACP_VERSION=$("$NODE_BIN" -e 'const p=require(process.argv[1]); if(p.name!=="opencode-acp") process.exit(1); process.stdout.write(p.version)' "$HARNESS_ROOT/artifacts/package.json") || \
        die "packed manifest is not opencode-acp"
    ACP_TGZ_URL=$("$NODE_BIN" --input-type=module -e 'import {pathToFileURL} from "node:url"; process.stdout.write(pathToFileURL(process.argv[1]).href)' "$ACP_TGZ")
    pass "packed opencode-acp@$ACP_VERSION: $(basename "$ACP_TGZ")"
}

install_hosts() {
    V1_ROOT="$HARNESS_ROOT/hosts/v1"
    V2_ROOT="$HARNESS_ROOT/hosts/v2"
    V1_PREFIX="$V1_ROOT/host"
    V2_PREFIX="$V2_ROOT/host"
    V1_PLUGIN_ROOT="$V1_ROOT/acp-plugin"
    V2_PLUGIN_ROOT="$V2_ROOT/acp-plugin"
    V1_PLUGIN_DIR="$V1_PLUGIN_ROOT/node_modules/opencode-acp"
    V2_PLUGIN_DIR="$V2_PLUGIN_ROOT/node_modules/opencode-acp"
    V2_WRAPPER="$V2_ROOT/acp-wrapper"

    for root in "$V1_ROOT" "$V2_ROOT"; do
        mkdir -p "$root"/{home,config/opencode,data,cache,state,tmp,npm-cache,db,workspace,logs}
        write_npmrc "$root/npmrc"
    done

    npm_install_env() {
        local root="$1"
        local prefix="$2"
        shift 2
        env -i \
            HOME="$root/home" \
            XDG_CONFIG_HOME="$root/config" \
            XDG_DATA_HOME="$root/data" \
            XDG_CACHE_HOME="$root/cache" \
            XDG_STATE_HOME="$root/state" \
            TMPDIR="$root/tmp" \
            NPM_CONFIG_USERCONFIG="$root/npmrc" \
            NPM_CONFIG_CACHE="$root/npm-cache" \
            NPM_CONFIG_FUND=false \
            NPM_CONFIG_AUDIT=false \
            PATH="$NODE_DIR:/usr/bin:/bin" \
            LANG=C.UTF-8 \
            LC_ALL=C.UTF-8 \
            TZ=UTC \
            "$NPM_BIN" "$@" --prefix "$prefix"
    }

    step "install exact OpenCode V1 host privately"
    if ! npm_install_env "$V1_ROOT" "$V1_PREFIX" install --no-save opencode-ai@1.18.29 >"$V1_ROOT/host-install.log" 2>&1; then
        tail -100 "$V1_ROOT/host-install.log" >&2 || true
        die "private V1 host install failed"
    fi
    step "install exact OpenCode V2 host privately"
    if ! npm_install_env "$V2_ROOT" "$V2_PREFIX" install --no-save @opencode/cli@2.0.3 >"$V2_ROOT/host-install.log" 2>&1; then
        tail -100 "$V2_ROOT/host-install.log" >&2 || true
        die "private V2 host install failed"
    fi

    V1_BIN="$V1_PREFIX/node_modules/.bin/opencode"
    V2_BIN="$V2_PREFIX/node_modules/.bin/opencode"
    [[ -x "$V1_BIN" ]] || die "installed V1 opencode executable missing"
    [[ -x "$V2_BIN" ]] || die "installed V2 opencode executable missing"
    V1_VERSION=$(env -i HOME="$V1_ROOT/home" PATH="$V1_PREFIX/node_modules/.bin:$NODE_DIR:/usr/bin:/bin" LANG=C.UTF-8 LC_ALL=C.UTF-8 "$V1_BIN" --version)
    V2_VERSION_RAW=$(env -i HOME="$V2_ROOT/home" PATH="$V2_PREFIX/node_modules/.bin:$NODE_DIR:/usr/bin:/bin" LANG=C.UTF-8 LC_ALL=C.UTF-8 "$V2_BIN" --version)
    V2_VERSION="${V2_VERSION_RAW#opencode v}"
    [[ "$V1_VERSION" == "1.18.29" ]] || die "expected V1 1.18.29, got $V1_VERSION"
    [[ "$V2_VERSION" == "2.0.3" ]] || die "expected V2 2.0.3, got $V2_VERSION_RAW"
    pass "exact host versions: V1 $V1_VERSION, V2 $V2_VERSION"

    step "install packed artifact into private V1 plugin prefix"
    if ! npm_install_env "$V1_ROOT" "$V1_PLUGIN_ROOT" install --ignore-scripts --no-save "$ACP_TGZ" >"$V1_ROOT/plugin-install.log" 2>&1; then
        tail -100 "$V1_ROOT/plugin-install.log" >&2 || true
        die "private V1 ACP artifact install failed"
    fi
    step "install packed artifact into private V2 plugin prefix"
    if ! npm_install_env "$V2_ROOT" "$V2_PLUGIN_ROOT" install --ignore-scripts --no-save "$ACP_TGZ" >"$V2_ROOT/plugin-install.log" 2>&1; then
        tail -100 "$V2_ROOT/plugin-install.log" >&2 || true
        die "private V2 ACP artifact install failed"
    fi
    [[ -f "$V1_PLUGIN_DIR/package.json" ]] || die "V1 installed ACP package missing"
    [[ -f "$V2_PLUGIN_DIR/package.json" ]] || die "V2 installed ACP package missing"
    for plugin_dir in "$V1_PLUGIN_DIR" "$V2_PLUGIN_DIR"; do
        "$NODE_BIN" -e 'const p=require(process.argv[1]); if(p.name!=="opencode-acp" || p.version!==process.argv[2]) process.exit(1)' "$plugin_dir/package.json" "$ACP_VERSION" || \
            die "installed ACP package does not match the packed artifact: $plugin_dir"
    done
    "$NODE_BIN" "$SCRIPT_DIR/installed-config.mjs" wrapper "$V2_WRAPPER" "$V2_PLUGIN_DIR" "$V2_PLUGIN_ROOT"
    step "independently import all private ACP package entrypoints"
    env -i \
        HOME="$V1_ROOT/home" \
        PATH="$NODE_DIR:/usr/bin:/bin" \
        LANG=C.UTF-8 \
        LC_ALL=C.UTF-8 \
        TZ=UTC \
        "$NODE_BIN" "$SCRIPT_DIR/verify-installed-package.mjs" "$V1_PLUGIN_ROOT" "$V1_PLUGIN_DIR"
    env -i \
        HOME="$V2_ROOT/home" \
        PATH="$NODE_DIR:/usr/bin:/bin" \
        LANG=C.UTF-8 \
        LC_ALL=C.UTF-8 \
        TZ=UTC \
        "$NODE_BIN" "$SCRIPT_DIR/verify-installed-package.mjs" "$V2_PLUGIN_ROOT" "$V2_PLUGIN_DIR"
    V2_WRAPPER_URL=$("$NODE_BIN" --input-type=module -e 'import {pathToFileURL} from "node:url"; process.stdout.write(pathToFileURL(process.argv[1]).href)' "$V2_WRAPPER")
    pass "packed artifact installed privately for both hosts"
}

make_configs() {
    V1_CONFIG_DIR="$V1_ROOT/config/opencode"
    V1_CONFIG_FILE="$V1_CONFIG_DIR/opencode.json"
    V1_ACP_CONFIG="$V1_CONFIG_DIR/acp.jsonc"
    V1_STORAGE="$V1_ROOT/state/acp"
    V1_WORKSPACE="$V1_ROOT/workspace"
    V1_FAKE_PORT=$(free_port)
    mkdir -p "$V1_WORKSPACE" "$V1_STORAGE"
    "$NODE_BIN" "$SCRIPT_DIR/installed-config.mjs" v1 "$V1_CONFIG_FILE" "$V1_PLUGIN_DIR" "http://127.0.0.1:$V1_FAKE_PORT/v1"
    "$NODE_BIN" "$SCRIPT_DIR/installed-config.mjs" acp "$V1_ACP_CONFIG" "$V1_PLUGIN_DIR" "" allow "$V1_STORAGE" "$V1_WORKSPACE"

    V2_CONFIG_DIR="$V2_ROOT/config"
    V2_CONFIG_FILE="$V2_CONFIG_DIR/opencode.json"
    V2_ACP_CONFIG="$V2_CONFIG_DIR/acp.jsonc"
    V2_STORAGE="$V2_ROOT/state/acp"
    V2_WORKSPACE="$V2_ROOT/workspace"
    V2_FAKE_PORT=$(free_port)
    V2_SERVER_PORT=$(free_port)
    mkdir -p "$V2_WORKSPACE" "$V2_STORAGE"
    "$NODE_BIN" "$SCRIPT_DIR/installed-config.mjs" v2 "$V2_CONFIG_FILE" "$ACP_TGZ_URL" "http://127.0.0.1:$V2_FAKE_PORT/v1" allow "$V2_STORAGE" "$V2_WORKSPACE"
    "$NODE_BIN" "$SCRIPT_DIR/installed-config.mjs" acp "$V2_ACP_CONFIG" "$ACP_TGZ_URL" "" allow "$V2_STORAGE" "$V2_WORKSPACE"

}

start_fake() {
    local root="$1"
    local port="$2"
    local scenario="$3"
    local counter="$4"
    local observations="$5"
    local log="$6"
    mkdir -p "$(dirname "$counter")" "$(dirname "$observations")" "$(dirname "$log")"
    env -i \
        HOME="$root/home" \
        TMPDIR="$root/tmp" \
        PATH="$(dirname "$BUN_BIN"):$NODE_DIR:/usr/bin:/bin" \
        LANG=C.UTF-8 \
        LC_ALL=C.UTF-8 \
        TZ=UTC \
        PORT="$port" \
        SCENARIO="$scenario" \
        TURN_COUNTER="$counter" \
        OBSERVATIONS="$observations" \
        "$BUN_BIN" run "$SCRIPT_DIR/fake-llm-server.ts" >"$log" 2>&1 &
    FAKE_PID=$!
    OWNED_PIDS+=("$FAKE_PID")
    for _ in $(seq 1 80); do
        if env -i PATH="/usr/bin:/bin" LANG=C.UTF-8 LC_ALL=C.UTF-8 "$CURL_BIN" --noproxy '*' --max-time 2 -sf "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1; then
            pass "fake provider ready (pid $FAKE_PID, port $port)"
            return 0
        fi
        if ! kill -0 "$FAKE_PID" 2>/dev/null; then
            tail -100 "$log" >&2 || true
            die "fake provider exited before readiness"
        fi
        sleep 0.25
    done
    tail -100 "$log" >&2 || true
    die "fake provider did not become ready"
}

start_v2() {
    local log="$V2_ROOT/logs/server.log"
    (cd "$V2_WORKSPACE" && exec env -i "${v2_env[@]}" "$V2_BIN" serve --hostname 127.0.0.1 --port "$V2_SERVER_PORT") >>"$log" 2>&1 &
    V2_PID=$!
    OWNED_PIDS+=("$V2_PID")
    for _ in $(seq 1 120); do
        if env -i PATH="/usr/bin:/bin" LANG=C.UTF-8 LC_ALL=C.UTF-8 "$CURL_BIN" --noproxy '*' --max-time 2 -sf -u opencode:e2e-dummy "http://127.0.0.1:$V2_SERVER_PORT/api/health" >/dev/null 2>&1; then
            pass "V2 foreground server ready (pid $V2_PID, port $V2_SERVER_PORT)"
            return 0
        fi
        if ! kill -0 "$V2_PID" 2>/dev/null; then
            tail -120 "$log" >&2 || true
            die "V2 server exited before health readiness"
        fi
        sleep 0.25
    done
    tail -120 "$log" >&2 || true
    die "V2 server health did not become ready"
}

run_v2_stage() {
    local stage="$1"
    local observations="${E2E_ACTIVE_OBSERVATIONS:-$V2_ROOT/observations.json}"
    (cd "$REPO_ROOT" && env -i \
        "${v2_env[@]}" \
        E2E_ROOT="$HARNESS_ROOT" \
        E2E_SERVER_URL="http://127.0.0.1:$V2_SERVER_PORT" \
        E2E_WORKSPACE="$V2_WORKSPACE" \
        E2E_CONFIG_FILE="$V2_CONFIG_FILE" \
        E2E_PLUGIN_TGZ_URL="$ACP_TGZ_URL" \
        E2E_WRAPPER_DIR="$V2_WRAPPER" \
        E2E_OBSERVATIONS="$observations" \
        E2E_STATE_DIR="$V2_STORAGE" \
        "$NODE_BIN" --import tsx "$SCRIPT_DIR/installed-v2.ts" "$stage")
}

verify_v2_main_state() {
    local session_id
    local state_file
    session_id=$("$NODE_BIN" -e 'const p=require(process.argv[1]); process.stdout.write(p.id)' "$HARNESS_ROOT/v2/session.json")
    state_file="$V2_STORAGE/$session_id.json"
    (cd "$REPO_ROOT" && env -i \
        "${v2_env[@]}" \
        OBSERVATIONS="$V2_ROOT/observations.json" \
        "$NODE_BIN" --import tsx "$SCRIPT_DIR/verify.ts" "$state_file" "$SCRIPT_DIR/installed-scenarios/main.json" "$V2_STORAGE")
}

run_v1_turn() {
    local number="$1"
    local output="$V1_ROOT/logs/run-$number.jsonl"
    local message="Installed V1 ACP test turn $number with authentication and provider routing details."
    local args=(run --model fake/fake-model --format json --port 0 --dir "$V1_WORKSPACE")
    if [[ "$number" -gt 1 ]]; then
        args+=(--session "$V1_SESSION_ID")
    fi
    args+=("$message")
    (cd "$V1_WORKSPACE" && exec env -i "${v1_env[@]}" "$V1_BIN" "${args[@]}") >"$output" 2>&1 &
    local pid=$!
    OWNED_PIDS+=("$pid")
    for _ in $(seq 1 600); do
        if ! kill -0 "$pid" 2>/dev/null; then
            if ! wait "$pid"; then
                die "V1 run turn $number failed; payload log retained at $output"
            fi
            forget_owned_pid "$pid"
            return 0
        fi
        sleep 0.2
    done
    stop_owned_pid "$pid"
    die "V1 run turn $number exceeded bounded 120-second wait"
}

extract_v1_session() {
    "$NODE_BIN" --input-type=module -e '
        import {readFileSync} from "node:fs"
        const lines = readFileSync(process.argv[1], "utf8").split(/\n/)
        for (const line of lines) {
            try {
                const value = JSON.parse(line)
                if (typeof value.sessionID === "string") { process.stdout.write(value.sessionID); process.exit(0) }
            } catch {}
        }
        process.exit(1)
    ' "$V1_ROOT/logs/run-1.jsonl"
}

run_v1_checks() {
    step "run installed V1 one-shot compression smoke test"
    start_fake "$V1_ROOT" "$V1_FAKE_PORT" "$REPO_ROOT/scripts/e2e/scenarios/01-basic-compress.json" "$V1_ROOT/turn-counter" "$V1_ROOT/observations.json" "$V1_ROOT/logs/fake.log"
    for number in 1 2 3 4; do
        info "V1 one-shot turn $number"
        run_v1_turn "$number"
        if [[ "$number" -eq 1 ]]; then
            V1_SESSION_ID=$(extract_v1_session) || die "V1 run output did not expose a session ID"
        fi
    done
    [[ -n "$V1_SESSION_ID" ]] || die "V1 session ID is empty"
    grep -q "authentication systems" "$V1_ROOT/logs/run-1.jsonl" || die "V1 fake response was not observed"
    grep -q '"type":"tool_use"' "$V1_ROOT/logs/run-4.jsonl" || die "V1 scripted compression call was not observed"

    V1_STATE="$V1_STORAGE/$V1_SESSION_ID.json"
    env -i \
        "${v1_env[@]}" \
        E2E_STATE_FILE="$V1_STATE" \
        E2E_PLUGIN_ENTRY="$V1_PLUGIN_DIR/dist/index.js" \
        E2E_OBSERVATIONS="$V1_ROOT/observations.json" \
        E2E_RUN_OUTPUT="$V1_ROOT/logs/run-4.jsonl" \
        "$NODE_BIN" "$SCRIPT_DIR/installed-v1.ts"
    stop_owned_pid "$FAKE_PID"
    FAKE_PID=""
    pass "installed V1 1.18.29 smoke: default.server, fake response, one ACP block"
}

write_v2_route() {
    local base_url="$1"
    "$NODE_BIN" "$SCRIPT_DIR/installed-config.mjs" v2 "$V2_CONFIG_FILE" "$CURRENT_PLUGIN_TARGET" "$base_url" allow "$V2_STORAGE" "$V2_WORKSPACE"
}

run_v2_checks() {
    step "run installed V2 2.0.3 full API E2E"
    V2_OBSERVATIONS="$V2_ROOT/observations.json"
    V2_COUNTER="$V2_ROOT/turn-counter"
    start_fake "$V2_ROOT" "$V2_FAKE_PORT" "$SCRIPT_DIR/installed-scenarios/main.json" "$V2_COUNTER" "$V2_OBSERVATIONS" "$V2_ROOT/logs/fake.log"
    start_v2

    # OpenCode 2.0.3 treats a file:// tarball as an absolute configured plugin
    # path and rejects it before Arborist. Try the requested shape first and
    # retain the exact server diagnostic if the release exhibits that behavior.
    step "activate V2 configured packed plugin"
    local exact_server_log="$V2_ROOT/logs/server.log"
    local exact_opencode_log="$V2_ROOT/data/opencode/log/opencode.log"
    local exact_server_start exact_opencode_start
    exact_server_start="$(log_byte_offset "$exact_server_log")"
    exact_opencode_start="$(log_byte_offset "$exact_opencode_log")"
    : >"$V2_ROOT/logs/activation-exact.log"
    set +e
    run_v2_stage activate >"$V2_ROOT/logs/activation-exact.log" 2>&1
    local activation_status=$?
    set -e
    local fresh_server_log="$V2_ROOT/logs/activation-exact-server.log"
    local fresh_opencode_log="$V2_ROOT/logs/activation-exact-opencode.log"
    capture_new_log_lines "$exact_server_log" "$exact_server_start" "$fresh_server_log"
    capture_new_log_lines "$exact_opencode_log" "$exact_opencode_start" "$fresh_opencode_log"
    local gate_result gate_status
    set +e
    gate_result="$($NODE_BIN "$SCRIPT_DIR/check-v2-activation.mjs" \
        "$activation_status" "$HARNESS_ROOT/v2/activation.json" \
        "$fresh_server_log" "$fresh_opencode_log")"
    gate_status=$?
    set -e
    printf '%s\n' "$gate_result" >"$V2_ROOT/logs/activation-classification.json"
    local diagnostic_matched=false
    local fallback_allowed=false
    local diagnostic_source_index=-1
    if [[ -n "$gate_result" ]]; then
        diagnostic_matched="$($NODE_BIN -e 'process.stdout.write(JSON.parse(process.argv[1]).exactDiagnosticMatched ? "true" : "false")' "$gate_result")"
        fallback_allowed="$($NODE_BIN -e 'process.stdout.write(JSON.parse(process.argv[1]).accepted ? "true" : "false")' "$gate_result")"
        diagnostic_source_index="$($NODE_BIN -e 'process.stdout.write(String(JSON.parse(process.argv[1]).sourceIndex))' "$gate_result")"
    fi
    case "$diagnostic_source_index" in
        0) V2_DIAGNOSTIC_SOURCE="$fresh_server_log" ;;
        1) V2_DIAGNOSTIC_SOURCE="$fresh_opencode_log" ;;
        *) V2_DIAGNOSTIC_SOURCE="$V2_ROOT/logs/activation-exact.log" ;;
    esac
    if [[ "$activation_status" -eq 10 && "$gate_status" -eq 0 && "$fallback_allowed" == true ]]; then
        redact_diagnostic_file \
            "$V2_DIAGNOSTIC_SOURCE" \
            "$V2_ROOT/logs/plugin-resolution-error.log"
        [[ -s "$V2_ROOT/logs/plugin-resolution-error.log" ]] || \
            die "V2 exact plugin failure produced no retained redacted server diagnostic"
        "$NODE_BIN" -e '
            const fs = require("node:fs")
            const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
            if (value.active !== false) process.exit(1)
        ' "$HARNESS_ROOT/v2/activation.json" || {
            redact_diagnostic_file "$V2_ROOT/logs/activation-exact.log" "$V2_ROOT/logs/activation-exact-error.log"
            die "V2 exact plugin activation did not produce the expected inactive outcome"
        }
        record_v2_activation_observation "$V2_OBSERVATIONS" "$activation_status" true true
        info "V2 exact tarball activation failed only with the expected directory diagnostic; using verified local wrapper fallback"
        CURRENT_PLUGIN_TARGET="$V2_WRAPPER_URL"
        write_v2_route "http://127.0.0.1:$V2_FAKE_PORT/v1"
        run_v2_stage activate >"$V2_ROOT/logs/activation-wrapper.log" 2>&1 || die "V2 wrapper fallback activation failed"
    elif [[ "$activation_status" -ne 0 ]]; then
        redact_diagnostic_file "$V2_ROOT/logs/activation-exact.log" "$V2_ROOT/logs/activation-exact-error.log"
        redact_diagnostic_file "$V2_DIAGNOSTIC_SOURCE" "$V2_ROOT/logs/plugin-resolution-error.log"
        record_v2_activation_observation "$V2_OBSERVATIONS" "$activation_status" "$diagnostic_matched" false
        info "exact activation diagnostic (redacted): $V2_ROOT/logs/activation-exact-error.log"
        info "owned server diagnostic (redacted): $V2_ROOT/logs/plugin-resolution-error.log"
        die "V2 exact packed plugin activation failed without the sole allowed diagnostic"
    else
        record_v2_activation_observation "$V2_OBSERVATIONS" "$activation_status" "$diagnostic_matched" false
        if [[ "$diagnostic_matched" == true ]]; then
            redact_diagnostic_file "$V2_DIAGNOSTIC_SOURCE" "$V2_ROOT/logs/plugin-resolution-error.log"
            die "V2 exact packed plugin activated despite reporting the fallback diagnostic"
        fi
        CURRENT_PLUGIN_TARGET="$ACP_TGZ_URL"
        pass "V2 configured file URL activated directly"
    fi

    run_v2_stage main

    step "switch provider atomically to /bili/ and verify self-disable"
    write_v2_route "http://127.0.0.1:$V2_FAKE_PORT/bili/v1"
    run_v2_stage proxy-disabled

    step "restore provider route and verify ACP re-enable"
    write_v2_route "http://127.0.0.1:$V2_FAKE_PORT/v1"
    run_v2_stage reenabled
    verify_v2_main_state

    step "repeat catalog disable/re-enable to detect duplicate registrations"
    write_v2_route "http://127.0.0.1:$V2_FAKE_PORT/bili/v1"
    run_v2_stage toggle-disabled
    write_v2_route "http://127.0.0.1:$V2_FAKE_PORT/v1"
    run_v2_stage toggle-restored

    step "restart only the owned V2 server and verify persisted state"
    stop_owned_pid "$V2_PID"
    V2_PID=""
    start_v2
    run_v2_stage post-restart
    stop_owned_pid "$V2_PID"
    V2_PID=""
    stop_owned_pid "$FAKE_PID"
    FAKE_PID=""
    pass "V2 catalog transitions, commands, five tools, state restart, and cleanup checks passed"
}

run_v2_nudge_growth() {
    step "run installed V2 nudge/growth/compress/refire cycle"
    V2_NUDGE_OBSERVATIONS="$V2_ROOT/nudge-observations.json"
    V2_NUDGE_COUNTER="$V2_ROOT/nudge-turn-counter"
    # This is intentionally a separate installed session/config from the main
    # matrix. It keeps preserveRecentMessages > 0 and the small growth floor
    # scoped to the mandatory nudge proof without weakening the existing tool
    # and permission scenarios.
    "$NODE_BIN" "$SCRIPT_DIR/installed-config.mjs" acp \
        "$V2_ACP_CONFIG" "$CURRENT_PLUGIN_TARGET" "" allow "$V2_STORAGE" "$V2_WORKSPACE" \
        "" 10 7500 5000
    rm -f -- "$V2_NUDGE_OBSERVATIONS" "$V2_NUDGE_COUNTER"
    start_fake \
        "$V2_ROOT" \
        "$V2_FAKE_PORT" \
        "$SCRIPT_DIR/installed-scenarios/nudge-growth.json" \
        "$V2_NUDGE_COUNTER" \
        "$V2_NUDGE_OBSERVATIONS" \
        "$V2_ROOT/logs/nudge-fake.log"
    start_v2
    E2E_ACTIVE_OBSERVATIONS="$V2_NUDGE_OBSERVATIONS"
    run_v2_stage nudge-growth
    unset E2E_ACTIVE_OBSERVATIONS
    stop_owned_pid "$FAKE_PID"
    FAKE_PID=""
    stop_owned_pid "$V2_PID"
    V2_PID=""
    pass "installed V2 nudge growth cycle preserved baselines and refired after two real compressions"
}

run_v2_permission_case() {
    local permission="$1"
    local root="$HARNESS_ROOT/permission-$permission"
    local config_dir="$root/config"
    local config_file="$config_dir/opencode.json"
    local acp_config="$config_dir/acp.jsonc"
    local storage="$root/state/acp"
    local workspace="$root/workspace"
    local fake_port
    local server_port
    local fake_pid=""
    local server_pid=""
    local fake_ready=0
    local server_ready=0
    local observations="$root/observations.json"
    local counter="$root/turn-counter"
    local server_log="$root/server.log"
    local permission_env=(
        "HOME=$root/home"
        "OPENCODE_TEST_HOME=$root/home"
        "XDG_CONFIG_HOME=$root/config"
        "XDG_DATA_HOME=$root/data"
        "XDG_CACHE_HOME=$root/cache"
        "XDG_STATE_HOME=$root/state"
        "TMPDIR=$root/tmp"
        "OPENCODE_CONFIG_DIR=$config_dir"
        "OPENCODE_DB=$root/db/opencode.db"
        "OPENCODE_CONFIG_PROJECT_DISABLE=1"
        "OPENCODE_DISABLE_PROJECT_CONFIG=1"
        "OPENCODE_DISABLE_MODELS_FETCH=1"
        "OPENCODE_DISABLE_FFF=1"
        "NPM_CONFIG_USERCONFIG=$root/npmrc"
        "NPM_CONFIG_CACHE=$root/npm-cache"
        "OPENCODE_PASSWORD=e2e-dummy"
        "PATH=$V2_PREFIX/node_modules/.bin:$REPO_ROOT/node_modules/.bin:$NODE_DIR:/usr/bin:/bin"
        "LANG=C.UTF-8"
        "LC_ALL=C.UTF-8"
        "TZ=UTC"
    )
    mkdir -p "$root"/{home,config,data,cache,state,tmp,db,workspace,logs} "$storage"
    write_npmrc "$root/npmrc"
    fake_port=$(free_port)
    server_port=$(free_port)
    "$NODE_BIN" "$SCRIPT_DIR/installed-config.mjs" v2 "$config_file" "$CURRENT_PLUGIN_TARGET" "http://127.0.0.1:$fake_port/v1" allow "$storage" "$workspace" "$permission"
    "$NODE_BIN" "$SCRIPT_DIR/installed-config.mjs" acp "$acp_config" "$CURRENT_PLUGIN_TARGET" "" "$permission" "$storage" "$workspace"

    env -i \
        HOME="$root/home" \
        TMPDIR="$root/tmp" \
        PATH="$(dirname "$BUN_BIN"):$NODE_DIR:/usr/bin:/bin" \
        LANG=C.UTF-8 \
        LC_ALL=C.UTF-8 \
        TZ=UTC \
        PORT="$fake_port" \
        SCENARIO="$SCRIPT_DIR/installed-scenarios/permission-$permission.json" \
        TURN_COUNTER="$counter" \
        OBSERVATIONS="$observations" \
        "$BUN_BIN" run "$SCRIPT_DIR/fake-llm-server.ts" >"$root/fake.log" 2>&1 &
    fake_pid=$!
    OWNED_PIDS+=("$fake_pid")
    for _ in $(seq 1 80); do
        if env -i PATH="/usr/bin:/bin" LANG=C.UTF-8 LC_ALL=C.UTF-8 "$CURL_BIN" --noproxy '*' --max-time 2 -sf "http://127.0.0.1:$fake_port/v1/models" >/dev/null 2>&1; then
            fake_ready=1
            break
        fi
        if ! kill -0 "$fake_pid" 2>/dev/null; then
            tail -100 "$root/fake.log" >&2 || true
            die "permission fake provider exited"
        fi
        sleep 0.25
    done
    [[ "$fake_ready" -eq 1 ]] || die "permission fake provider did not become ready"
    (cd "$workspace" && exec env -i "${permission_env[@]}" "$V2_BIN" serve --hostname 127.0.0.1 --port "$server_port") >"$server_log" 2>&1 &
    server_pid=$!
    OWNED_PIDS+=("$server_pid")
    for _ in $(seq 1 120); do
        if env -i PATH="/usr/bin:/bin" LANG=C.UTF-8 LC_ALL=C.UTF-8 "$CURL_BIN" --noproxy '*' --max-time 2 -sf -u opencode:e2e-dummy "http://127.0.0.1:$server_port/api/health" >/dev/null 2>&1; then
            server_ready=1
            break
        fi
        if ! kill -0 "$server_pid" 2>/dev/null; then
            tail -120 "$server_log" >&2 || true
            die "permission V2 server exited"
        fi
        sleep 0.25
    done
    [[ "$server_ready" -eq 1 ]] || die "permission V2 server health did not become ready"
    if ! (cd "$REPO_ROOT" && env -i \
        "${permission_env[@]}" \
        E2E_ROOT="$HARNESS_ROOT" \
        E2E_SERVER_URL="http://127.0.0.1:$server_port" \
        E2E_WORKSPACE="$workspace" \
        E2E_CONFIG_FILE="$config_file" \
        E2E_PLUGIN_TGZ_URL="$ACP_TGZ_URL" \
        E2E_WRAPPER_DIR="$V2_WRAPPER" \
        E2E_OBSERVATIONS="$observations" \
        E2E_STATE_DIR="$storage" \
        E2E_PERMISSION="$permission" \
        "$NODE_BIN" --import tsx "$SCRIPT_DIR/installed-v2.ts" permission); then
        tail -120 "$server_log" >&2 || true
        die "V2 permission case $permission failed"
    fi
    stop_owned_pid "$server_pid"
    stop_owned_pid "$fake_pid"
    pass "V2 permission case $permission passed"
}

pack_artifact
install_hosts
make_configs

# Arrays are intentionally built only after all profile paths are resolved.
v1_env=(
    "HOME=$V1_ROOT/home"
    "OPENCODE_TEST_HOME=$V1_ROOT/home"
    "XDG_CONFIG_HOME=$V1_ROOT/config"
    "XDG_DATA_HOME=$V1_ROOT/data"
    "XDG_CACHE_HOME=$V1_ROOT/cache"
    "XDG_STATE_HOME=$V1_ROOT/state"
    "TMPDIR=$V1_ROOT/tmp"
    "OPENCODE_CONFIG_DIR=$V1_CONFIG_DIR"
    "OPENCODE_DB=$V1_ROOT/db/opencode.db"
    "OPENCODE_CONFIG_PROJECT_DISABLE=1"
    "OPENCODE_DISABLE_PROJECT_CONFIG=1"
    "OPENCODE_DISABLE_MODELS_FETCH=1"
    "OPENCODE_DISABLE_FFF=1"
    "NPM_CONFIG_USERCONFIG=$V1_ROOT/npmrc"
    "NPM_CONFIG_CACHE=$V1_ROOT/npm-cache"
    "PATH=$V1_PREFIX/node_modules/.bin:$REPO_ROOT/node_modules/.bin:$NODE_DIR:/usr/bin:/bin"
    "LANG=C.UTF-8"
    "LC_ALL=C.UTF-8"
    "TZ=UTC"
)
v2_env=(
    "HOME=$V2_ROOT/home"
    "OPENCODE_TEST_HOME=$V2_ROOT/home"
    "XDG_CONFIG_HOME=$V2_ROOT/config"
    "XDG_DATA_HOME=$V2_ROOT/data"
    "XDG_CACHE_HOME=$V2_ROOT/cache"
    "XDG_STATE_HOME=$V2_ROOT/state"
    "TMPDIR=$V2_ROOT/tmp"
    "OPENCODE_CONFIG_DIR=$V2_CONFIG_DIR"
    "OPENCODE_DB=$V2_ROOT/db/opencode.db"
    "OPENCODE_CONFIG_PROJECT_DISABLE=1"
    "OPENCODE_DISABLE_PROJECT_CONFIG=1"
    "OPENCODE_DISABLE_MODELS_FETCH=1"
    "OPENCODE_DISABLE_FFF=1"
    "NPM_CONFIG_USERCONFIG=$V2_ROOT/npmrc"
    "NPM_CONFIG_CACHE=$V2_ROOT/npm-cache"
    "OPENCODE_PASSWORD=e2e-dummy"
    "PATH=$V2_PREFIX/node_modules/.bin:$REPO_ROOT/node_modules/.bin:$NODE_DIR:/usr/bin:/bin"
    "LANG=C.UTF-8"
    "LC_ALL=C.UTF-8"
    "TZ=UTC"
)

CURRENT_PLUGIN_TARGET="$ACP_TGZ_URL"
run_v1_checks
run_v2_checks
run_v2_nudge_growth
for permission in allow deny ask; do
    run_v2_permission_case "$permission"
done

elapsed=$(( $(date +%s) - START_SECONDS ))
pass "installed-artifact E2E complete in ${elapsed}s (V1 1.18.29, V2 2.0.3)"
