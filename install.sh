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
  command -v node >/dev/null || { echo "✖ cần Node 20+ để chạy validator"; exit 1; }

  mkdir -p "$P"/{docs,scripts,hooks} "$P"/.claude/{agents,commands,skills}

  # kernel — luôn ghi đè, đây là phần dùng chung
  cp -R "$SRC"/kernel/docs/*                  "$P"/docs/
  cp    "$SRC"/kernel/scripts/validate-tasks.mjs "$P"/scripts/
  cp    "$SRC"/agents/*.md                    "$P"/.claude/agents/
  cp    "$SRC"/hooks/pre-commit               "$P"/hooks/ && chmod +x "$P"/hooks/pre-commit
  # skill fsd-writer gọi ở Gate 1 — thiếu nó thì stage fsd_write gọi hụt
  cp -R "$SRC"/skills/*                       "$P"/.claude/skills/

  # adapter + command — của user, không đè
  keep "$SRC"/adapters/example/.mcp.json                   "$P"/.mcp.json
  keep "$SRC"/adapters/example/harness.config.json         "$P"/harness.config.json
  keep "$SRC"/adapters/ProjectRules.template.md            "$P"/docs/agents/ProjectRules.md
  keep "$SRC"/commands/start-task.md                       "$P"/.claude/commands/start-task.md
  cp   "$SRC"/commands/init-project-rules.md               "$P"/.claude/commands/

  # Pre-commit hook là TUỲ CHỌN — một chỗ cắm gate, không phải điều kiện chạy.
  # Validator vẫn gọi được tay hoặc từ CI. Cắm được thì cắm, không thì ghi lý do.
  # Đường dẫn hook hỏi git (tôn trọng core.hooksPath của husky/lefthook), không đoán ".git/".
  local h
  if h=$(cd "$P" && git rev-parse --path-format=absolute --git-path hooks/pre-commit 2>/dev/null) \
     && [ -n "$h" ]; then
    if [ -L "$h" ] || [ ! -e "$h" ]; then
      mkdir -p "$(dirname "$h")" && ln -sf "$P/hooks/pre-commit" "$h"
      [ -x "$h" ] || hook_skipped="symlink không chạy được: $h"
    else
      hook_skipped="project đã có pre-commit riêng — không đè"
    fi
  else
    hook_skipped="không nằm trong git repo"
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
  [ -e "$T/.claude/commands/init-project-rules.md" ] \
    || { echo "✖ self-test: thiếu lệnh /init-project-rules"; exit 1; }
  # Kernel/skill không được hardcode tên tool MCP: khoá harness vào đúng một
  # tracker, project dùng Jira/Linear là agent gọi hụt trong im lặng.
  if grep -rn 'mcp__[a-z]' "$T/docs" "$T/.claude/skills" "$T/.claude/agents" 2>/dev/null \
       | grep -v 'mcp__<server>__<tool>' | grep -q .; then
    echo "✖ self-test: còn tên tool MCP hardcode:"
    grep -rn 'mcp__[a-z]' "$T/docs" "$T/.claude/skills" "$T/.claude/agents" 2>/dev/null \
      | grep -v 'mcp__<server>__<tool>' | sed 's/^/    /'
    exit 1
  fi

  # kernel gọi skill nào thì skill đó phải được cài kèm
  for sk in $(grep -rho 'skill `[a-z0-9-]*`' "$SRC"/kernel/docs | sed 's/.*`\(.*\)`/\1/' | sort -u); do
    [ -f "$T/.claude/skills/$sk/SKILL.md" ] \
      || { echo "✖ self-test: kernel gọi skill '$sk' nhưng không cài kèm"; exit 1; }
  done
  grep -q 'CHƯA-ĐIỀN' "$T"/docs/agents/ProjectRules.md \
    || { echo "✖ self-test: ProjectRules không phải template rỗng"; exit 1; }
  grep -q '^## 7\.' "$T"/docs/agents/ProjectRules.md \
    || { echo "✖ self-test: template mất mục §7 (kernel trỏ chéo bằng số)"; exit 1; }
  python3 -c "import json,sys;json.load(open('$T/.mcp.json'))" \
    || { echo "✖ self-test: .mcp.json không phải JSON hợp lệ"; exit 1; }
  [ -e "$T/.git/hooks/pre-commit" ]          || { echo "✖ self-test: repo trống mà không cắm được hook"; exit 1; }
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

  # hook là tuỳ chọn: không phải git repo vẫn phải cài được, validator vẫn chạy
  NG=$(mktemp -d)/ng; mkdir -p "$NG"
  install_into "$NG" >/dev/null || { echo "✖ self-test: non-git repo đáng lẽ vẫn cài được"; exit 1; }
  ( cd "$NG" && node scripts/validate-tasks.mjs --quiet >/dev/null ) \
    || { echo "✖ self-test: validator không chạy được khi không có hook"; exit 1; }
  rm -rf "$(dirname "$NG")"

  rm -rf "$(dirname "$T")"
  echo "✅ install self-test passed"; exit 0
fi

[ $# -eq 1 ] || { echo "dùng: bash install.sh <project-root>"; exit 2; }
[ -d "$1" ] || { echo "✖ không có thư mục: $1"; exit 1; }
install_into "$(cd "$1" && pwd)"

echo
echo "✅ đã cài vào $1"
[ ${#kept[@]} -eq 0 ] || { echo; echo "giữ nguyên (đã có sẵn, không đè):"; printf '   %s\n' "${kept[@]}"; }

if [ -n "${hook_skipped:-}" ]; then
  cat <<GATE

ℹ️  pre-commit hook chưa cắm ($hook_skipped) — harness vẫn chạy bình thường.
    Gate chạy tay hoặc từ CI: node scripts/validate-tasks.mjs
    Muốn chặn ngay lúc commit thì chain vào hook sẵn có của bạn:
      "\$(git rev-parse --show-toplevel)"/hooks/pre-commit || exit 1
GATE
fi
cat <<'TODO'

còn 3 việc tay trước task đầu tiên:
  1. harness.config.json      → evidenceCommandPattern + evidenceSampleCommand (lệnh test thật),
                                tracker.urlPattern, acTrace.since = hôm nay
  2. .mcp.json                → khai MCP server thật (tracker / git host / design tool),
                                xoá dòng nào không dùng. Rồi gõ /mcp trong Claude Code để login.
  3. docs/agents/ProjectRules.md → mở Claude Code trong project, gõ /init-project-rules
                                (dò repo rồi điền §1 MCP · §2 guardrail · §3 nhánh · §7 lệnh;
                                 nó cập nhật luôn evidenceCommandPattern ở việc 1)
  rồi: node scripts/validate-tasks.mjs --self-check  +  claude mcp list
TODO
