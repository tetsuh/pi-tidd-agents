#!/usr/bin/env bash
# CL-D33 Issue #41 template: aggregate-summary publication only; no Issue #40 source-reply authority.
# `gh` authentication is required before any POST. Verify exact repository/PR/OPEN lifecycle/full URL, unchanged public head, complete paginated comment evidence, and absence of the exact marker; Missing, malformed, incomplete, stale, duplicate, or conflicting evidence fails closed.
# Generation contract: read this packaged template, validate canonical metadata,
# create a fresh external directory with `mktemp -d "${TMPDIR:-/tmp}/..."`,
# render a UTF-8/LF visible summary ending in LF that names review state, full PR
# URL, and exact head, hash those visible bytes, append the one terminal marker
# plus LF, then hash the complete final `review-comment.md` bytes. Copy this
# template byte-for-byte and replace each exact ASCII placeholder below once in
# the copied `publish-review.sh`; review-comment bytes are never interpolated into shell source. Invoke only as `bash publish-review.sh`.
# Marker form includes visibleSha256=<sha256-of-canonical-visible-comment-bytes>; its digest is non-circular.
# Contract operation: gh pr comment <full-pr-url> --body-file <review-comment.md>.
# This is the sole permitted operation, never retried automatically. A stable comment URL and non-overwriting receipt outside the repository are reported.
# The generated script enforces the review-comment.md digest and binds the complete final `review-comment.md` bytes.
set -euo pipefail
umask 077

readonly REVIEW_REPOSITORY='__PI_REVIEW_REPOSITORY__'
readonly REVIEW_PR_NUMBER='__PI_REVIEW_PR_NUMBER__'
readonly REVIEW_HEAD='__PI_REVIEW_HEAD__'
readonly REVIEW_PR_URL='__PI_REVIEW_PR_URL__'
readonly REVIEW_BODY_SHA256='__PI_REVIEW_BODY_SHA256__'
readonly REVIEW_MARKER='__PI_REVIEW_MARKER__'

fail() {
  printf 'publication blocked: %s\n' "$1" >&2
  exit 1
}
warn_terminal() {
  printf 'publication stopped after the one permitted POST attempt; do not retry automatically: %s\n' "$1" >&2
  exit 1
}
warn_published() {
  printf 'publication succeeded but local receipt failed; do not retry automatically\ncomment_url: %s\nerror: %s\n' "$1" "$2" >&2
  exit 1
}

case "$REVIEW_REPOSITORY:$REVIEW_PR_NUMBER:$REVIEW_HEAD:$REVIEW_PR_URL:$REVIEW_BODY_SHA256:$REVIEW_MARKER" in
  *'__PI_REVIEW_'*) fail 'generated metadata placeholders remain';;
esac
[[ "$REVIEW_REPOSITORY" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail 'malformed repository metadata'
[[ "$REVIEW_PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || fail 'malformed pull-request metadata'
[[ "$REVIEW_HEAD" =~ ^[0-9a-f]{40}$ ]] || fail 'malformed reviewed head metadata'
[[ "$REVIEW_BODY_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'malformed body digest metadata'
readonly MARKER_PREFIX="<!-- pi-tidd-agents:review-publication:v1 repo=$REVIEW_REPOSITORY pr=$REVIEW_PR_NUMBER head=$REVIEW_HEAD visibleSha256="
case "$REVIEW_MARKER" in
  "$MARKER_PREFIX"*' -->') ;;
  *) fail 'malformed publication marker metadata';;
esac
marker_digest="${REVIEW_MARKER#"$MARKER_PREFIX"}"
marker_digest="${marker_digest%' -->'}"
[[ "$marker_digest" =~ ^[0-9a-f]{64}$ ]] || fail 'malformed visible-body marker digest'
[[ "$REVIEW_PR_URL" == "https://github.com/$REVIEW_REPOSITORY/pull/$REVIEW_PR_NUMBER" ]] || fail 'malformed pull-request URL metadata'

readonly SCRIPT_SOURCE="${BASH_SOURCE[0]}"
readonly SCRIPT_DIR="$(cd -P -- "$(dirname "$SCRIPT_SOURCE")" && pwd)"
readonly COMMENT_FILE="$SCRIPT_DIR/review-comment.md"
readonly LOCK_DIR="$SCRIPT_DIR/.pi-review-publication-lock"
[[ -f "$COMMENT_FILE" && ! -L "$COMMENT_FILE" ]] || fail 'review-comment.md is missing or is a symlink'
command -v git >/dev/null 2>&1 || fail 'git is required to verify external artifact placement'
# Inherited Git-discovery variables are untrusted, as is inherited configuration. Use an empty environment
# and classify only Git's canonical outside-repository result as safe; every
# other probe error fails closed instead of becoming outside-repository evidence.
set +e
placement_probe="$(env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 HOME= XDG_CONFIG_HOME= \
  git -C "$SCRIPT_DIR" rev-parse --absolute-git-dir 2>&1)"
placement_status=$?
set -e
if [[ "$placement_status" == 0 ]]; then
  fail 'publication artifacts must remain outside every repository'
fi
case "$placement_probe" in
  "fatal: not a git repository (or any of the parent directories): .git") ;;
  *) fail 'cannot verify that publication artifacts are outside every repository';;
esac

hash_file() {
  local digest
  if command -v sha256sum >/dev/null 2>&1 && digest="$(sha256sum -- "$1" 2>/dev/null | awk '{print $1}')"; then
    printf '%s\n' "$digest"
    return
  fi
  if command -v shasum >/dev/null 2>&1 && digest="$(shasum -a 256 -- "$1" 2>/dev/null | awk '{print $1}')"; then
    printf '%s\n' "$digest"
    return
  fi
  fail 'neither sha256sum nor shasum -a 256 is available'
}

scratch="$(mktemp -d "$SCRIPT_DIR/.pi-review-publish.XXXXXX")" || fail 'cannot create external temporary evidence directory'
readonly POST_FILE="$scratch/review-comment.md"
readonly VISIBLE_FILE="$scratch/visible-comment.md"
lock_owned=0
post_attempted=0
cleanup() {
  rm -rf -- "$scratch"
  if [[ "$lock_owned" == 1 && "$post_attempted" == 0 ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM
cp "$COMMENT_FILE" "$POST_FILE" || fail 'cannot create private review-comment snapshot'
[[ -f "$POST_FILE" && ! -L "$POST_FILE" ]] || fail 'private review-comment snapshot is unsafe'

actual_body_sha256="$(hash_file "$POST_FILE")"
[[ "$actual_body_sha256" == "$REVIEW_BODY_SHA256" ]] || fail 'review-comment.md digest does not match the reviewed bytes'
command -v iconv >/dev/null 2>&1 || fail 'iconv is required to validate UTF-8 bytes'
iconv -f UTF-8 -t UTF-8 "$POST_FILE" >/dev/null 2>&1 || fail 'review-comment.md is not valid UTF-8'
LC_ALL=C grep -q $'\r' "$POST_FILE" && fail 'review-comment.md must use LF, not CR or CRLF'
last_byte="$(LC_ALL=C tail -c 1 "$POST_FILE" | od -An -t x1 | tr -d '[:space:]')"
[[ "$last_byte" == '0a' ]] || fail 'review-comment.md must end with one LF after the terminal marker'
if ! awk -v marker="$REVIEW_MARKER" 'BEGIN { found = 0; after = 0 } { if (after) exit 2; if ($0 == marker) { found++; after = 1; next } print } END { if (found != 1) exit 3 }' "$POST_FILE" >"$VISIBLE_FILE"; then
  fail 'review-comment.md must contain exactly one final deterministic marker line'
fi
visible_sha256="$(hash_file "$VISIBLE_FILE")"
[[ "$visible_sha256" == "$marker_digest" ]] || fail 'visible-body marker digest does not match canonical bytes'
grep -F -q -- "$REVIEW_MARKER" "$POST_FILE" || fail 'review-comment.md is missing its deterministic marker'

if ! mkdir "$LOCK_DIR"; then
  fail 'this generated publication artifact is already active or was already attempted'
fi
lock_owned=1

command -v gh >/dev/null 2>&1 || fail 'gh is not installed'
gh auth status >/dev/null 2>&1 || fail 'gh is not authenticated'

verify_pr_identity() {
  local phase="$1" identity actual_repo actual_number actual_state actual_head actual_url
  identity="$(gh api "repos/$REVIEW_REPOSITORY/pulls/$REVIEW_PR_NUMBER" --jq '[.base.repo.full_name, (.number|tostring), .state, .head.sha, .html_url] | @tsv' 2>"$scratch/identity-$phase.err")" || fail "pull-request identity lookup failed at $phase"
  [[ "$identity" == *$'\n'* ]] && fail "pull-request identity evidence has multiple records at $phase"
  IFS=$'\t' read -r actual_repo actual_number actual_state actual_head actual_url <<< "$identity"
  [[ -n "${actual_url:-}" && "$actual_repo" == "$REVIEW_REPOSITORY" && "$actual_number" == "$REVIEW_PR_NUMBER" && "$actual_state" == 'open' && "$actual_head" == "$REVIEW_HEAD" && "$actual_url" == "$REVIEW_PR_URL" ]] || fail "pull-request identity, lifecycle, or public head changed at $phase"
}
verify_pr_identity initial

# --paginate is mandatory: a matching marker on any later comment page blocks
# publication. The jq expression also rejects malformed page/item evidence.
if ! gh api --paginate "repos/$REVIEW_REPOSITORY/issues/$REVIEW_PR_NUMBER/comments?per_page=100" \
  --jq 'if type != "array" then error("comment page is not an array") else .[] | if (.body|type) != "string" then error("comment body is not a string") else .body end end' \
  >"$scratch/comments.txt" 2>"$scratch/comments.err"; then
  fail 'complete paginated comment evidence is unavailable or malformed'
fi
if grep -F -q -- "$REVIEW_MARKER" "$scratch/comments.txt"; then
  fail 'a comment already contains the deterministic publication marker'
fi

# Re-bracket the mutable target and the private body snapshot immediately before
# the sole provider mutation.
verify_pr_identity before-post
[[ "$(hash_file "$POST_FILE")" == "$REVIEW_BODY_SHA256" ]] || fail 'private review-comment snapshot changed before POST'

# This is the sole provider mutation. It uses only the validated private snapshot.
post_attempted=1
if ! post_result="$(gh pr comment "$REVIEW_PR_URL" --body-file "$POST_FILE" 2>"$scratch/post.err")"; then
  warn_terminal 'gh pr comment failed'
fi
post_result="${post_result%$'\n'}"
comment_id="${post_result#"$REVIEW_PR_URL#issuecomment-"}"
[[ "$post_result" == "$REVIEW_PR_URL#issuecomment-$comment_id" && "$comment_id" =~ ^[0-9]+$ ]] || warn_terminal 'gh pr comment returned ambiguous, malformed, or wrong-target output'

# Print the validated provider result before local receipt creation so a receipt
# failure never suppresses the successful comment URL.
printf 'publication succeeded\ncomment_url: %s\n' "$post_result"
receipt="$(mktemp "$SCRIPT_DIR/review-publication-receipt.XXXXXX")" || warn_published "$post_result" 'receipt creation failed'
if ! printf '%s\n' "{\"schemaVersion\":1,\"repository\":\"$REVIEW_REPOSITORY\",\"pr\":$REVIEW_PR_NUMBER,\"head\":\"$REVIEW_HEAD\",\"bodySha256\":\"$REVIEW_BODY_SHA256\",\"commentUrl\":\"$post_result\",\"retryAuthorized\":false}" >"$receipt"; then
  warn_published "$post_result" 'receipt writing failed'
fi
printf 'receipt: %s\n' "$receipt"
