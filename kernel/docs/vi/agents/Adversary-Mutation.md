# Adversary — Mutation check (phụ lục của §3.3.1)

> Bản dịch của [`../../agents/Adversary-Mutation.md`](../../agents/Adversary-Mutation.md). Lệch nhau → bản tiếng Anh thắng.
> **Chỉ đọc khi** bạn nghi có test giả: xanh, nhưng có thể chẳng assert AC nào ([`Adversary.md` §3.3](./Adversary.md)). Không nghi ngờ thì bỏ qua — quy trình này là tuỳ chọn, tách riêng để `adversary` không phải trả tiền đọc nó ở mọi task.

§2 cấm role này sửa code, và [`../Instructions.md` §1](../Instructions.md) cấm `git stash` / `restore` / `checkout --`. Nên phép thử "đổi một hằng số xem test có đỏ không" **không** chạy trên cây của implementer — chạy trong một worktree detach rồi xoá đi:

```bash
BASE=$(git rev-parse HEAD)
git worktree add --detach /tmp/adv-$$ "$BASE"     # bản copy riêng; cây của implementer không bị đụng
# đổi hằng số bên trong /tmp/adv-$$, chạy đúng lệnh test của AC đó
git worktree remove --force /tmp/adv-$$           # chỉ xoá worktree vừa tạo
```

Ba điều kiện làm việc này an toàn: worktree do chính role này tạo, nó là `--detach` (không chiếm nhánh), và `remove` trỏ đúng path vừa tạo. Không đụng worktree nào khác.

> `worktree add` không mang theo code chưa commit. Thứ bạn cần xác lập là **test có bắt được thay đổi hành vi hay không** — chạy trên `HEAD` cộng chép tay đúng một file đang xét là đủ. Nếu không chép được (trạng thái build, env), ghi việc đó dưới mục "Limits of this review" và **đừng** nhận là đã thử.
