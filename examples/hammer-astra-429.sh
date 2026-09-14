#!/usr/bin/env bash
# Parallel gpt-6-astra coding agents through neo, to reproduce Neon AI Gateway 429s.
#
# Share (download, then run — the script asks before it spends quota):
#
#   curl -fsSL https://raw.githubusercontent.com/neon-solutions/neo/main/examples/hammer-astra-429.sh -o hammer-astra-429.sh
#   bash hammer-astra-429.sh
#
# What it does:
#   1. Checks / installs neo, ripgrep, gh, and Neon AI Gateway credentials
#   2. Lists open PRs on neondatabase/website, mcp-server-neon, neon-pkgs
#   3. Prefetches each PR's view + diff and inlines it so the first Astra call
#      is coding-sized (same shape as a parent agent with the PR already in context)
#   4. For each PR, starts 3 neo agents at the same instant:
#      security review, engineering review, DX review
#   5. Counts 429 retries and 429 fatalities from neo's stderr
#
# Default load: 3 PRs per repo x 3 reviews = 27 neo processes, all started together.
# That is the shape of "review the open PRs in parallel", not a toy ping.
#
#   bash hammer-astra-429.sh --dry-run
#   bash hammer-astra-429.sh --setup-only
#   bash hammer-astra-429.sh --per-repo 3
#   bash hammer-astra-429.sh --all
#   bash hammer-astra-429.sh --yes --copies 4
#   bash hammer-astra-429.sh --cwd ~/code --agents-md --skills
set -euo pipefail

MODEL="gpt-6-astra"
PER_REPO=3
PER_REPO_ALL=20
TIMEOUT=120
YES=0
DRY_RUN=0
SETUP_ONLY=0
ALL=0
KEEP_LOGS=1
COPIES=1
MAX_DIFF=65536
NEO_CWD=""
AGENTS_MD=0
SKILLS=0
PIDS_FILE=""

REPOS="neondatabase/website neondatabase/mcp-server-neon neondatabase/neon-pkgs"
REVIEWS="security engineering dx"

usage() {
  cat <<'EOF'
Usage: bash hammer-astra-429.sh [options]

Fan out neo coding agents on gpt-6-astra against open PRs and report 429s.

  --dry-run         List PRs and the job matrix. Do not call the model.
  --setup-only      Check neo / gh / rg / gateway credentials, then exit.
  --yes             Do not ask. Install neo if missing. Start the hammer.
  --per-repo N      Open PRs to take from each repo (default: 3). Newest first.
  --all             Take up to 20 open PRs per repo (60 PRs x 3 reviews = 180 agents).
  --timeout SEC     Kill each neo after SEC seconds (default: 120).
  --copies N        Repeat the whole PR x review matrix N times (default: 1).
  --max-diff-bytes N  Bytes of gh pr diff to inline in each first prompt (default: 65536).
  --cwd DIR         Working directory for every neo (default: empty temp dir).
  --agents-md       Pass --agents-md (needs AGENTS.md under --cwd). Matches a real coding agent.
  --skills          Pass --skills. Combine with --cwd that has Agent Skills.
  --model ID        Gateway model id (default: gpt-6-astra).
  --clean           Delete the log directory after printing the report.
  -h, --help        Show this help.

Missing tools get install instructions, then neo's own gateway wizard if credentials are missing:
  neo      curl -fsSL https://getneo.sh | bash     (macOS arm64 / Linux x86_64)
  rg       brew install ripgrep                    (neo's grep/glob)
  gh       brew install gh && gh auth login        (PR list + gh pr diff)
  neon     npm install -g neon && neon auth        (only if gateway creds are missing)
           then a TTY `neo models list` runs neo's Neon AI Gateway wizard

Exit 0 if any job saw a 429, 2 if the run finished with none, 1 on setup/abort errors.

Logs land under $TMPDIR/hammer-astra-429.* (stdout, stderr, report.txt per run).
EOF
}

log() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

ask_tty() {
  local prompt="$1" ans=""
  if [ -t 0 ]; then
    printf '%s' "$prompt" >&2
    IFS= read -r ans || true
  elif [ -r /dev/tty ]; then
    printf '%s' "$prompt" >/dev/tty
    IFS= read -r ans </dev/tty || true
  else
    die "non-interactive stdin; re-run with --yes or in a terminal"
  fi
  printf '%s' "$ans"
}

confirm() {
  local prompt="$1" ans
  if [ "$YES" -eq 1 ]; then
    return 0
  fi
  ans="$(ask_tty "$prompt")"
  case "$ans" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

have_gateway_config() {
  if [ -n "${NEON_AI_GATEWAY_TOKEN:-}" ] || [ -n "${NEON_AI_GATEWAY_BASE_URL:-}" ]; then
    if [ -z "${NEON_AI_GATEWAY_TOKEN:-}" ] || [ -z "${NEON_AI_GATEWAY_BASE_URL:-}" ]; then
      die "NEON_AI_GATEWAY_TOKEN and NEON_AI_GATEWAY_BASE_URL must both be set"
    fi
    return 0
  fi
  [ -f "${HOME}/.config/neo/providers/neon.json" ]
}

ensure_local_bin() {
  local dir="${HOME}/.local/bin"
  case ":${PATH}:" in
    *":${dir}:"*) ;;
    *) export PATH="${dir}:${PATH}" ;;
  esac
}

stop_children() {
  if [ -n "$PIDS_FILE" ] && [ -f "$PIDS_FILE" ]; then
    while IFS= read -r pid || [ -n "$pid" ]; do
      [ -z "$pid" ] && continue
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    done <"$PIDS_FILE"
  fi
}

trap 'stop_children; exit 130' INT TERM

install_neo() {
  log "Installing neo to ~/.local/bin via https://getneo.sh"
  curl -fsSL https://getneo.sh | bash
  ensure_local_bin
  have_cmd neo || die "neo installed but not on PATH. Open a new shell or: export PATH=\"\$HOME/.local/bin:\$PATH\""
}

write_prompt() {
  local dest="$1" repo="$2" number="$3" url="$4" lens="$5" lens_help="$6" context="$7"
  {
    cat <<EOF
You are one of several parallel neo coding agents reviewing GitHub pull requests at the same instant. Other agents are on the other lenses and other PRs. Do your lens only.

Repo: ${repo}
PR: ${number}
URL: ${url}
Lens: ${lens}
${lens_help}

The harness already inlined gh pr view JSON and a truncated gh pr diff below, so your first model call is a coding-sized payload (parent agent with the PR already in context). You may still use bash/gh for extra files. Do not clone. Do not write files. Do not look at other PRs.

Write a concrete review: findings first (file and line when you have them), then residual risks. Short.

----- fetched PR -----
EOF
    cat "$context"
  } >"$dest"
}

prefetch_pr() {
  local url="$1" dest="$2"
  {
    gh pr view "$url" --json title,body,author,files,additions,deletions
    printf '\n----- diff (first %s bytes) -----\n' "$MAX_DIFF"
    # head closes early on large diffs; gh then SIGPIPEs. Do not fail the run.
    gh pr diff "$url" | head -c "$MAX_DIFF" || true
    printf '\n'
  } >"$dest"
}

lens_help() {
  case "$1" in
    security)
      printf '%s' "Look for injection, secret leaks, authz holes, unsafe subprocesses, and anything a reviewer would block on."
      ;;
    engineering)
      printf '%s' "Look for correctness bugs, missing tests, swallowed errors, and broken existing behavior."
      ;;
    dx)
      printf '%s' "Look at the user-facing CLI/SDK/HTTP/UI: flags, copy, examples, and whether current usage still works."
      ;;
    *) die "unknown lens: $1" ;;
  esac
}

count_pat() {
  local file="$1" pat="$2" n
  if [ ! -f "$file" ]; then
    printf '0'
    return 0
  fi
  n="$(grep -cE "$pat" "$file" 2>/dev/null || true)"
  printf '%s' "${n:-0}"
}

saw_pat() {
  local file="$1" pat="$2"
  [ -s "$file" ] && grep -qiE "$pat" "$file"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --dry-run) DRY_RUN=1 ;;
    --setup-only) SETUP_ONLY=1 ;;
    --yes | -y) YES=1 ;;
    --all) ALL=1 ;;
    --clean) KEEP_LOGS=0 ;;
    --copies)
      shift
      [ $# -ge 1 ] || die "--copies needs a number"
      COPIES="$1"
      ;;
    --max-diff-bytes)
      shift
      [ $# -ge 1 ] || die "--max-diff-bytes needs a number"
      MAX_DIFF="$1"
      ;;
    --cwd)
      shift
      [ $# -ge 1 ] || die "--cwd needs a directory"
      NEO_CWD="$1"
      ;;
    --agents-md) AGENTS_MD=1 ;;
    --skills) SKILLS=1 ;;
    --per-repo)
      shift
      [ $# -ge 1 ] || die "--per-repo needs a number"
      PER_REPO="$1"
      ;;
    --timeout)
      shift
      [ $# -ge 1 ] || die "--timeout needs seconds"
      TIMEOUT="$1"
      ;;
    --model)
      shift
      [ $# -ge 1 ] || die "--model needs an id"
      MODEL="$1"
      ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
  shift
done

case "$PER_REPO" in
  '' | *[!0-9]*) die "--per-repo must be a non-negative integer" ;;
esac
case "$TIMEOUT" in
  '' | *[!0-9]*) die "--timeout must be a positive integer" ;;
esac
[ "$TIMEOUT" -ge 1 ] || die "--timeout must be at least 1"
case "$COPIES" in
  '' | *[!0-9]*) die "--copies must be a positive integer" ;;
esac
[ "$COPIES" -ge 1 ] || die "--copies must be at least 1"
case "$MAX_DIFF" in
  '' | *[!0-9]*) die "--max-diff-bytes must be a positive integer" ;;
esac
[ "$MAX_DIFF" -ge 1 ] || die "--max-diff-bytes must be at least 1"
if [ -n "$NEO_CWD" ]; then
  case "$NEO_CWD" in
    ~) NEO_CWD="$HOME" ;;
    ~/*) NEO_CWD="$HOME/${NEO_CWD#~/}" ;;
  esac
  [ -d "$NEO_CWD" ] || die "--cwd is not a directory: ${NEO_CWD}"
elif [ "$AGENTS_MD" -eq 1 ] || [ "$SKILLS" -eq 1 ]; then
  NEO_CWD="$PWD"
fi
if [ "$AGENTS_MD" -eq 1 ]; then
  if [ ! -f "${NEO_CWD}/AGENTS.md" ]; then
    die "--agents-md needs AGENTS.md in ${NEO_CWD}"
  fi
fi
if [ "$ALL" -eq 1 ]; then
  PER_REPO="$PER_REPO_ALL"
fi
[ "$PER_REPO" -ge 1 ] || die "--per-repo must be at least 1"

ensure_local_bin

log "=== setup ==="

if ! have_cmd curl; then
  die "curl is required (to install neo from https://getneo.sh if needed)"
fi

if ! have_cmd neo; then
  log "neo is not on PATH."
  log "  Install:  curl -fsSL https://getneo.sh | bash"
  log "  PATH:     export PATH=\"\$HOME/.local/bin:\$PATH\""
  log "  Platforms: macOS arm64, Linux x86_64. rg must be on PATH too."
  if [ "$YES" -eq 1 ] || confirm "Install neo now? [y/N] "; then
    install_neo
  else
    die "neo is required"
  fi
else
  log "neo: $(command -v neo)"
fi

if ! have_cmd rg; then
  log "ripgrep (rg) is not on PATH. neo uses it for grep/glob."
  log "  macOS:  brew install ripgrep"
  log "  Debian: sudo apt-get install ripgrep"
  die "rg is required"
fi
log "rg: $(command -v rg)"

if ! have_cmd gh; then
  log "GitHub CLI (gh) is not on PATH. This script lists PRs with it, and each neo agent runs gh pr view / gh pr diff."
  log "  macOS:  brew install gh"
  log "  then:   gh auth login"
  die "gh is required"
fi
log "gh: $(command -v gh)"

if ! gh auth status >/dev/null 2>&1; then
  log "gh is not logged in. Public PR fetches work unauthenticated until GitHub rate-limits you."
  log "  gh auth login"
  if [ "$DRY_RUN" -eq 0 ] && [ "$SETUP_ONLY" -eq 0 ]; then
    if ! confirm "Continue without gh auth? [y/N] "; then
      die "gh auth login, then re-run"
    fi
  fi
else
  log "gh: authenticated"
fi

if ! have_gateway_config; then
  log "No Neon AI Gateway credentials."
  log "  File: ~/.config/neo/providers/neon.json"
  log "  Or:   NEON_AI_GATEWAY_TOKEN and NEON_AI_GATEWAY_BASE_URL"
  log "neo's wizard needs the Neon CLI and a paid project in us-east-2 or eu-central-1 (AI Gateway public beta)."
  if ! have_cmd neon; then
    log "  Install Neon CLI:  npm install -g neon"
    log "  Sign in:           neon auth"
    die "install the Neon CLI, then re-run this script in a terminal so neo can mint credentials"
  fi
  log "neon: $(command -v neon)"
  log "Starting neo's gateway wizard via: neo models list"
  log "(pick Neon AI Gateway, org, then an existing project or create one)"
  neo models list
  have_gateway_config || die "wizard finished but credentials are still missing"
else
  log "gateway credentials: present"
fi

log "Listing models (confirms the credential and that ${MODEL} is served)..."
MODELS_FILE="$(mktemp "${TMPDIR:-/tmp}/hammer-astra-models.XXXXXX")"
if ! neo models list >"$MODELS_FILE"; then
  rm -f "$MODELS_FILE"
  die "neo models list failed. If this printed a 429, the gateway is already rate-limiting model listing."
fi
if ! awk -v id="$MODEL" '$1 == id { found=1 } END { exit found ? 0 : 1 }' "$MODELS_FILE"; then
  log "Models this credential can see:"
  cat "$MODELS_FILE" >&2
  rm -f "$MODELS_FILE"
  die "${MODEL} is not in /v1/models for this credential. Request it from the branch AI Gateway page in the Neon console, or pass --model with an id from the list above."
fi
rm -f "$MODELS_FILE"
log "model: ${MODEL} (in catalog)"

if [ "$SETUP_ONLY" -eq 1 ]; then
  log "setup ok"
  exit 0
fi

log "=== PRs ==="

PR_FILE="$(mktemp "${TMPDIR:-/tmp}/hammer-astra-prs.XXXXXX")"
PR_COUNT=0
for repo in $REPOS; do
  log "gh pr list --repo ${repo} --state open --limit ${PER_REPO}"
  if ! gh pr list --repo "$repo" --state open --limit "$PER_REPO" --json number,url \
    --jq '.[] | "\(.number)\t\(.url)"' >"${PR_FILE}.chunk"; then
    rm -f "$PR_FILE" "${PR_FILE}.chunk"
    die "gh pr list failed for ${repo}"
  fi
  chunk_n=0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    number="${line%%	*}"
    url="${line#*	}"
    printf '%s\t%s\t%s\n' "$repo" "$number" "$url" >>"$PR_FILE"
    chunk_n=$((chunk_n + 1))
    PR_COUNT=$((PR_COUNT + 1))
  done <"${PR_FILE}.chunk"
  log "  ${chunk_n} open PR(s)"
done
rm -f "${PR_FILE}.chunk"

if [ "$PR_COUNT" -eq 0 ]; then
  rm -f "$PR_FILE"
  die "no open PRs on ${REPOS}"
fi

REVIEW_N=0
for _lens in $REVIEWS; do
  REVIEW_N=$((REVIEW_N + 1))
done
UNIQUE_JOBS=$((PR_COUNT * REVIEW_N))
JOB_COUNT=$((UNIQUE_JOBS * COPIES))

log ""
log "PRs in this run:"
while IFS="$(printf '\t')" read -r repo number url; do
  log "  ${repo} #${number}  ${url}"
done <"$PR_FILE"

log ""
log "matrix:"
log "  model:               ${MODEL}"
log "  repos:               ${REPOS}"
log "  PRs:                 ${PR_COUNT}"
log "  reviews per PR:      ${REVIEW_N} (${REVIEWS})"
log "  copies of matrix:    ${COPIES}"
log "  parallel neo agents: ${JOB_COUNT}  (all started at once)"
log "  first-prompt diff:   ${MAX_DIFF} bytes inlined per PR (coding-sized first call)"
log "  neo cwd:             ${NEO_CWD:-empty temp dir}"
log "  --agents-md:         $( [ "$AGENTS_MD" -eq 1 ] && printf on || printf off )"
log "  --skills:            $( [ "$SKILLS" -eq 1 ] && printf on || printf off )"
log "  timeout per agent:   ${TIMEOUT}s"
log "  tools:               neo --readonly (bash/gh, no write/edit)"
log ""

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run: not calling ${MODEL}"
  log "each agent would run:"
  log "  neo --model ${MODEL} --readonly --prompt-file <lens prompt>"
  rm -f "$PR_FILE"
  exit 0
fi

if ! confirm "Start ${JOB_COUNT} parallel ${MODEL} neo agents? This spends AI Gateway quota and is expected to 429. [y/N] "; then
  rm -f "$PR_FILE"
  die "aborted"
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/hammer-astra-429.XXXXXX")"
JOBS_DIR="${WORKDIR}/jobs"
mkdir -p "$JOBS_DIR"
cp "$PR_FILE" "${WORKDIR}/prs.tsv"
rm -f "$PR_FILE"

log "logs: ${WORKDIR}"

CTX_DIR="${WORKDIR}/context"
mkdir -p "$CTX_DIR"
log "prefetching PR view + diff for first-call context..."
while IFS="$(printf '\t')" read -r repo number url; do
  repo_slug="${repo#*/}"
  ctx="${CTX_DIR}/${repo_slug}-${number}.txt"
  log "  gh pr view/diff ${repo} #${number}"
  prefetch_pr "$url" "$ctx"
done <"${WORKDIR}/prs.tsv"

PIDS_FILE="${WORKDIR}/pids"
: >"$PIDS_FILE"

run_agent() {
  local id="$1" repo="$2" number="$3" url="$4" lens="$5" ctx="$6"
  local err="${JOBS_DIR}/${id}.err"
  local out="${JOBS_DIR}/${id}.out"
  local meta="${JOBS_DIR}/${id}.meta"
  local prompt="${JOBS_DIR}/${id}.prompt"
  local start end elapsed status killed pid waited bytes
  write_prompt "$prompt" "$repo" "$number" "$url" "$lens" "$(lens_help "$lens")" "$ctx"
  bytes="$(wc -c <"$prompt" | tr -d ' ')"
  start="$(date +%s)"
  killed=0
  extra=""
  if [ "$AGENTS_MD" -eq 1 ]; then
    extra="${extra} --agents-md"
  fi
  if [ "$SKILLS" -eq 1 ]; then
    extra="${extra} --skills"
  fi
  set +e
  if [ -n "$NEO_CWD" ]; then
    # shellcheck disable=SC2086
    (cd "$NEO_CWD" && neo --model "$MODEL" --readonly $extra --prompt-file "$prompt") >"$out" 2>"$err" &
  else
    # shellcheck disable=SC2086
    neo --model "$MODEL" --readonly $extra --prompt-file "$prompt" >"$out" 2>"$err" &
  fi
  pid=$!
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$TIMEOUT" ]; then
      kill "$pid" 2>/dev/null
      sleep 1
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      killed=1
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$killed" -eq 0 ]; then
    wait "$pid"
    status=$?
  else
    status=124
  fi
  set -e
  end="$(date +%s)"
  elapsed=$((end - start))
  {
    printf 'id=%s\n' "$id"
    printf 'repo=%s\n' "$repo"
    printf 'pr=%s\n' "$number"
    printf 'lens=%s\n' "$lens"
    printf 'url=%s\n' "$url"
    printf 'exit=%s\n' "$status"
    printf 'seconds=%s\n' "$elapsed"
    printf 'prompt_bytes=%s\n' "$bytes"
    printf 'retries=%s\n' "$(count_pat "$err" 'gateway 429, retrying')"
    printf 'mention_429=%s\n' "$(count_pat "$err" '429')"
  } >"$meta"
}

log "starting ${JOB_COUNT} neo agents..."
JOB_IDS=""
copy=1
while [ "$copy" -le "$COPIES" ]; do
  while IFS="$(printf '\t')" read -r repo number url; do
    repo_slug="${repo#*/}"
    ctx="${CTX_DIR}/${repo_slug}-${number}.txt"
    for lens in $REVIEWS; do
      if [ "$COPIES" -gt 1 ]; then
        id="${repo_slug}-${number}-${lens}-c${copy}"
      else
        id="${repo_slug}-${number}-${lens}"
      fi
      JOB_IDS="${JOB_IDS} ${id}"
      log "  start ${id}"
      run_agent "$id" "$repo" "$number" "$url" "$lens" "$ctx" &
      echo $! >>"$PIDS_FILE"
    done
  done <"${WORKDIR}/prs.tsv"
  copy=$((copy + 1))
done

log "waiting (timeout ${TIMEOUT}s each)..."
alive=1
while [ "$alive" -eq 1 ]; do
  alive=0
  running=0
  while IFS= read -r pid || [ -n "$pid" ]; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      alive=1
      running=$((running + 1))
    fi
  done <"$PIDS_FILE"
  if [ "$alive" -eq 1 ]; then
    log "  still running: ${running}"
    sleep 5
  fi
done
while IFS= read -r pid || [ -n "$pid" ]; do
  [ -z "$pid" ] && continue
  wait "$pid" 2>/dev/null || true
done <"$PIDS_FILE"

REPORT="${WORKDIR}/report.txt"
{
  printf 'Astra 429 repro\n'
  printf 'time: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'model: %s\n' "$MODEL"
  printf 'parallel neo agents: %s\n' "$JOB_COUNT"
  printf 'PRs: %s\n' "$PR_COUNT"
  printf 'reviews per PR: %s (%s)\n' "$REVIEW_N" "$REVIEWS"
  printf 'copies: %s\n' "$COPIES"
  printf 'started together: yes\n'
  printf 'inlined_diff_bytes: %s\n' "$MAX_DIFF"
  printf 'timeout_s: %s\n' "$TIMEOUT"
  printf 'logs: %s\n' "$WORKDIR"
  printf '\n'
} >"$REPORT"

ok=0
fail=0
timed=0
jobs_with_429=0
jobs_fatal_429=0
retry_sum=0
mention_sum=0

printf '%-48s %-6s %6s %8s %s\n' "job" "exit" "sec" "retries" "429" >>"$REPORT"
printf '%-48s %-6s %6s %8s %s\n' "---" "----" "---" "-------" "---" >>"$REPORT"

for id in $JOB_IDS; do
  meta="${JOBS_DIR}/${id}.meta"
  err="${JOBS_DIR}/${id}.err"
  if [ ! -f "$meta" ]; then
    printf '%-48s %-6s %6s %8s %s\n' "$id" "miss" "-" "-" "no meta (process crashed before writing)" >>"$REPORT"
    fail=$((fail + 1))
    continue
  fi
  exit_code="$(awk -F= '$1=="exit" {print $2}' "$meta")"
  seconds="$(awk -F= '$1=="seconds" {print $2}' "$meta")"
  retries="$(awk -F= '$1=="retries" {print $2}' "$meta")"
  mentions="$(awk -F= '$1=="mention_429" {print $2}' "$meta")"
  retry_sum=$((retry_sum + retries))
  mention_sum=$((mention_sum + mentions))
  tag=""
  if saw_pat "$err" '429|Too Many Requests|rate[- ]?limit|REQUEST_LIMIT_EXCEEDED'; then
    jobs_with_429=$((jobs_with_429 + 1))
    tag="SAW_429"
  fi
  if [ "$exit_code" = "124" ]; then
    timed=$((timed + 1))
    tag="${tag:+$tag }TIMEOUT"
  elif [ "$exit_code" = "0" ]; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    if saw_pat "$err" '429|Too Many Requests|rate[- ]?limit|REQUEST_LIMIT_EXCEEDED'; then
      jobs_fatal_429=$((jobs_fatal_429 + 1))
      tag="${tag:+$tag }FATAL_429"
    fi
  fi
  [ -z "$tag" ] && tag="-"
  printf '%-48s %-6s %6s %8s %s\n' "$id" "$exit_code" "$seconds" "$retries" "$tag" >>"$REPORT"
done

{
  printf '\n'
  printf 'totals\n'
  printf '  ok:                    %s\n' "$ok"
  printf '  failed:                %s\n' "$fail"
  printf '  timed out:             %s\n' "$timed"
  printf '  neo 429 retries:       %s  (lines matching "gateway 429, retrying")\n' "$retry_sum"
  printf '  429 mentions in stderr:%s\n' "$mention_sum"
  printf '  jobs that saw a 429:   %s / %s\n' "$jobs_with_429" "$JOB_COUNT"
  printf '  jobs that died on 429: %s / %s\n' "$jobs_fatal_429" "$JOB_COUNT"
  printf '\n'
  if [ "$jobs_with_429" -gt 0 ]; then
    printf 'RESULT: 429 reproduced (%s of %s parallel %s agents).\n' "$jobs_with_429" "$JOB_COUNT" "$MODEL"
  else
    printf 'RESULT: no 429 in this run. Re-run with --copies 4, --all, or --cwd <repo> --agents-md --skills.\n'
  fi
} >>"$REPORT"

log ""
cat "$REPORT"

if [ "$jobs_with_429" -gt 0 ]; then
  log ""
  log "stderr excerpts (first 429-ish line per job):"
  for id in $JOB_IDS; do
    err="${JOBS_DIR}/${id}.err"
    if saw_pat "$err" '429|Too Many Requests|rate[- ]?limit|REQUEST_LIMIT_EXCEEDED'; then
      line="$(grep -iE '429|Too Many Requests|rate[- ]?limit' "$err" | head -n 1 || true)"
      log "  ${id}: ${line}"
    fi
  done
fi

log ""
log "full report: ${REPORT}"
if [ "$KEEP_LOGS" -eq 0 ]; then
  rm -rf "$WORKDIR"
  log "logs deleted (--clean)"
else
  log "job stderr: ${JOBS_DIR}/*.err"
fi

if [ "$jobs_with_429" -gt 0 ]; then
  exit 0
fi
exit 2
