# Adversary — Mutation check (phụ lục §3.3.1)

> **Đọc khi và chỉ khi** nghi test giả: test xanh nhưng có thể không assert được AC ([`Adversary.md` §3.3](./Adversary.md)). Không nghi thì bỏ qua — đây là quy trình tuỳ chọn, tách ra để `adversary` không trả tiền đọc nó mỗi task.

§2 cấm role này sửa code, [`../Instructions.md` §1](../Instructions.md) cấm `git stash`/`restore`/`checkout --`. Nên phép thử "đổi hằng số xem test có đỏ không" **không** làm trên tree của implementer — làm ở một worktree detached, xong thì xoá:

```bash
BASE=$(git rev-parse HEAD)
git worktree add --detach /tmp/adv-$$ "$BASE"     # bản sao rời, tree của implementer không bị đụng
# sửa hằng số trong /tmp/adv-$$, chạy đúng lệnh test của AC đó
git worktree remove --force /tmp/adv-$$           # chỉ xoá worktree MÌNH vừa tạo
```

Ba điều kiện để an toàn: worktree do chính role này tạo, `--detach` (không chiếm nhánh), và `remove` đúng đường dẫn vừa tạo. Không đụng worktree nào khác.

> Code chưa commit thì `worktree add` không mang nó theo. Việc cần kiểm là **test có bắt được thay đổi hành vi không** — chạy được trên bản `HEAD` + copy tay đúng file đang xét là đủ. Không copy được (build state, env) → ghi vào "Giới hạn của lượt kiểm này", **đừng** khai là đã thử.
