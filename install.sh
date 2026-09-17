#!/usr/bin/env bash
# spec-harness installer — cài kernel + adapter + agent + gate vào một project.
#
#   bash install.sh <project-root>
#   bash install.sh --self-test     # cài thử vào repo tạm rồi kiểm, không đụng gì
#
# Chạy lại được: file bạn đã sửa (harness.config.json, ProjectRules.md,
# .claude/commands/start-task.md) KHÔNG bị đè — nâng kernel không mất adapter.
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
kept=()

# Copy chỉ khi đích chưa có. Đây là thứ giữ adapter sống qua lần cài lại.
keep() { # keep <src> <dst>
  if [ -e "$2" ]; then kept+=("$2"); else cp "$1" "$2"; fi
}

install_into() {
  local P=$1
  [ -d "$P/.git" ] || { echo "✖ $P không phải git repo (hook cần .git/hooks/)"; exit 1; }
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

  # gate: chỉ cắm khi chưa có hook khác — không nuốt hook sẵn có của project
  local h="$P/.git/hooks/pre-commit"
  if [ -L "$h" ] || [ ! -e "$h" ]; then
    ln -sf ../../hooks/pre-commit "$h"
  else
    kept+=("$h (hook sẵn có — tự chain: gọi hooks/pre-commit từ trong nó)")
  fi

  ( cd "$P" && node scripts/validate-tasks.mjs --self-check )
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
  rm -rf "$(dirname "$T")"
  echo "✅ install self-test passed"; exit 0
fi

[ $# -eq 1 ] || { echo "dùng: bash install.sh <project-root>"; exit 2; }
install_into "$(cd "$1" && pwd)"

echo
echo "✅ đã cài vào $1"
[ ${#kept[@]} -eq 0 ] || { echo; echo "giữ nguyên (đã có sẵn, không đè):"; printf '   %s\n' "${kept[@]}"; }
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
