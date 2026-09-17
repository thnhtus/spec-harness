#!/usr/bin/env bash
# spec-harness installer — cài kernel + adapter + agent + gate vào một project.
#
# Từ bản clone:        bash install.sh <project-root>
# Không cần clone:     curl -fsSL <raw-url>/install.sh | bash -s -- <project-root>
#   (tự tải tarball về thư mục tạm rồi cài; repo phải public, hoặc đặt
#    SPEC_HARNESS_REF=<tag|branch> để ghim phiên bản)
#
#   bash install.sh --self-test     # cài thử vào repo tạm rồi kiểm, không đụng gì
#
# Chạy lại được: file bạn đã sửa (harness.config.json, ProjectRules.md,
# .claude/commands/start-task.md) KHÔNG bị đè — nâng kernel không mất adapter.
set -euo pipefail

REPO=${SPEC_HARNESS_REPO:-thnhtus/spec-harness}
REF=${SPEC_HARNESS_REF:-master}

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Chạy qua `curl | bash` thì $SRC là cwd ngẫu nhiên, không có kernel/ để copy.
# Tải tarball về tmp và cài từ đó — giống `specify init`, không để lại bản clone.
if [ ! -d "$SRC/kernel" ]; then
  command -v curl >/dev/null || { echo "✖ cần curl để tải khi không chạy từ bản clone"; exit 1; }
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  echo "→ tải $REPO@$REF …"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" \
    | tar xz -C "$tmp" 2>/dev/null \
    || curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/tags/$REF" | tar xz -C "$tmp" \
    || { echo "✖ không tải được $REPO@$REF (repo private? sai ref?) — clone rồi chạy install.sh trong đó"; exit 1; }
  SRC=$(echo "$tmp"/*/)
  [ -d "$SRC/kernel" ] || { echo "✖ tarball không có kernel/ — sai repo?"; exit 1; }
fi

kept=()

# Copy chỉ khi đích chưa có. Đây là thứ giữ adapter sống qua lần cài lại.
keep() { # keep <src> <dst>
  if [ -e "$2" ]; then kept+=("$2"); else cp "$1" "$2"; fi
}

install_into() {
  local P=$1
  # Hỏi git thay vì đoán ".git/": đúng cả với worktree, submodule, và
  # core.hooksPath (husky/lefthook trỏ hook đi chỗ khác — cắm vào .git/hooks
  # khi đó là cắm vào hư không, gate im lặng không chạy).
  git -C "$P" rev-parse --git-dir >/dev/null 2>&1 \
    || { echo "✖ $P không nằm trong git repo nào (gate cần git hook)"; exit 1; }
  command -v node >/dev/null || { echo "✖ cần Node 20+ để chạy validator"; exit 1; }

  mkdir -p "$P"/{docs,scripts,hooks} "$P"/.claude/{agents,commands}

  # kernel — luôn ghi đè, đây là phần dùng chung
  cp -R "$SRC"/kernel/docs/*                  "$P"/docs/
  cp    "$SRC"/kernel/scripts/validate-tasks.mjs "$P"/scripts/
  cp    "$SRC"/agents/*.md                    "$P"/.claude/agents/
  cp    "$SRC"/hooks/pre-commit               "$P"/hooks/ && chmod +x "$P"/hooks/pre-commit

  # adapter + command — của user, không đè
  keep "$SRC"/adapters/example/.mcp.json                   "$P"/.mcp.json
  keep "$SRC"/adapters/example/harness.config.json         "$P"/harness.config.json
  keep "$SRC"/adapters/example/docs/agents/ProjectRules.md "$P"/docs/agents/ProjectRules.md
  keep "$SRC"/commands/start-task.md                       "$P"/.claude/commands/start-task.md

  # gate — đường dẫn hook THẬT theo git (tôn trọng core.hooksPath), không đoán
  local h; h=$(cd "$P" && git rev-parse --path-format=absolute --git-path hooks/pre-commit)
  mkdir -p "$(dirname "$h")"
  if [ -L "$h" ] || [ ! -e "$h" ]; then
    ln -sf "$P/hooks/pre-commit" "$h"
  else
    gate_unarmed="$h"      # hook của user — không nuốt, nhưng phải báo TO (§dưới)
  fi

  ( cd "$P" && node scripts/validate-tasks.mjs --self-check )

  # Symlink treo = gate im lặng no-op, đúng thứ repo này tồn tại để chống.
  [ -n "${gate_unarmed:-}" ] || [ -x "$h" ] || gate_unarmed="$h (symlink hỏng)"
}

if [ "${1:-}" = "--self-test" ]; then
  T=$(mktemp -d)/p; mkdir -p "$T"; git -C "$T" init -q
  install_into "$T" >/dev/null
  # gate phải CHẶN task hỏng
  mkdir -p "$T"/docs/tasks/sprint-1/A-1-x
  sed 's/"currentStage": "bootstrap"/"currentStage": "implementation"/' \
    "$T"/docs/tasks/_templates/task.agent.json > "$T"/docs/tasks/sprint-1/A-1-x/task.agent.json
  ( cd "$T" && node scripts/validate-tasks.mjs --quiet >/dev/null 2>&1 ) \
    && { echo "✖ self-test: validator ĐÁNG LẼ phải fail task thiếu artifact"; exit 1; }
  [ -e "$T/.claude/agents/orchestrator.md" ] || { echo "✖ self-test: thiếu subagent"; exit 1; }
  [ -e "$T/.mcp.json" ] || { echo "✖ self-test: thiếu .mcp.json"; exit 1; }
  python3 -c "import json,sys;json.load(open('$T/.mcp.json'))" \
    || { echo "✖ self-test: .mcp.json không phải JSON hợp lệ"; exit 1; }
  [ -e "$T/.git/hooks/pre-commit" ]          || { echo "✖ self-test: gate chưa cắm"; exit 1; }
  # cài lại lần 2: adapter phải được giữ
  echo 'MARKER' >> "$T"/docs/agents/ProjectRules.md
  install_into "$T" >/dev/null
  grep -q MARKER "$T"/docs/agents/ProjectRules.md || { echo "✖ self-test: cài lại đè mất adapter"; exit 1; }

  # gate phải CHẶN commit thật — không chỉ "symlink có tồn tại"
  ( cd "$T" && git add -A >/dev/null 2>&1 \
      && git -c user.email=t@t -c user.name=t commit -m x >/dev/null 2>&1 ) \
    && { echo "✖ self-test: gate KHÔNG chặn commit task hỏng"; exit 1; }

  # core.hooksPath (husky/lefthook): cắm vào .git/hooks là cắm vào hư không
  H2=$(mktemp -d)/h; mkdir -p "$H2"; git -C "$H2" init -q
  mkdir -p "$H2/.husky"; git -C "$H2" config core.hooksPath .husky
  install_into "$H2" >/dev/null
  [ -e "$H2/.husky/pre-commit" ] || { echo "✖ self-test: bỏ qua core.hooksPath → gate no-op"; exit 1; }
  mkdir -p "$H2"/docs/tasks/sprint-1/A-1-x
  sed 's/"currentStage": "bootstrap"/"currentStage": "implementation"/' \
    "$H2"/docs/tasks/_templates/task.agent.json > "$H2"/docs/tasks/sprint-1/A-1-x/task.agent.json
  ( cd "$H2" && git add -A >/dev/null 2>&1 \
      && git -c user.email=t@t -c user.name=t commit -m x >/dev/null 2>&1 ) \
    && { echo "✖ self-test: core.hooksPath — gate không chặn"; exit 1; }
  rm -rf "$(dirname "$H2")"

  rm -rf "$(dirname "$T")"
  echo "✅ install self-test passed"; exit 0
fi

[ $# -eq 1 ] || { echo "dùng: bash install.sh <project-root>"; exit 2; }
[ -d "$1" ] || { echo "✖ không có thư mục: $1"; exit 1; }
install_into "$(cd "$1" && pwd)"

echo
echo "✅ đã cài vào $1"
[ ${#kept[@]} -eq 0 ] || { echo; echo "giữ nguyên (đã có sẵn, không đè):"; printf '   %s\n' "${kept[@]}"; }

# Gate chưa cắm được = harness chỉ còn là markdown. Đây là lỗi to nhất có thể
# xảy ra khi cài, nên nó phải chặn đường ra, không nằm lẫn trong danh sách.
if [ -n "${gate_unarmed:-}" ]; then
  cat <<GATE

⚠️  GATE CHƯA CẮM — $gate_unarmed
    Harness hiện chỉ là tài liệu: agent tự báo "xong" mà không ai chặn.
    Project đã có pre-commit riêng, nên installer KHÔNG đè. Tự chain 1 dòng:

      # thêm vào cuối hook sẵn có của bạn
      "\$(git rev-parse --show-toplevel)"/hooks/pre-commit || exit 1

    Kiểm lại: sửa currentStage của một task thành "implementation" rồi thử
    commit — phải bị chặn.
GATE
fi
cat <<'TODO'

còn 3 việc tay trước task đầu tiên:
  1. harness.config.json      → evidenceCommandPattern + evidenceSampleCommand (lệnh test thật),
                                tracker.urlPattern, acTrace.since = hôm nay
  2. .mcp.json                → khai MCP server thật (tracker / git host / design tool),
                                xoá dòng nào không dùng. Rồi gõ /mcp trong Claude Code để login.
  3. docs/agents/ProjectRules.md → thay sạch §1 MCP · §2 guardrail · §3 nhánh · §7 lệnh
                                (giữ nguyên số mục 1/2/3/7 — kernel trỏ chéo bằng số)
  rồi: node scripts/validate-tasks.mjs --self-check  +  claude mcp list
TODO
