# 09 — Adversarial Review: {taskName}

> Sinh bởi `adversary` (stage `adversarial_review`, **Gate 5**). Mặc định FAIL — PASS phải kiếm được bằng bằng chứng tự thu. Append-only, tiếng Việt.
> **Output ở đây phải là thứ role này TỰ chạy**, không chép từ `08-Test-Evidence.md`.

**Kết quả: PASS | FAIL | UNCERTAIN** · {ngày}

## Tầng tĩnh — tự chạy lại

| Lệnh (ProjectRules §7) | Kết quả `08` khai | Kết quả tự chạy | Khớp? |
| --- | --- | --- | --- |
| `<lệnh>` |  |  | ✔ / ✘ |

## Scope — diff vs danh sách Gate 3

```
# git diff --stat <base>...HEAD
```

| File trong diff | Có ở `03`? | Khai ở Plan Deviations `06`? | Finding |
| --- | --- | --- | --- |

## AC — test có thật sự assert không

| AC | Test khai ở `08` | Assert trạng thái sau hành động? | Đổi hằng số → test đỏ? | Kết luận |
| --- | --- | --- | --- | --- |
| AC-nn |  | yes / no | yes / no / chưa thử | đạt / không đạt |

## Finding

| # | Mức | Mô tả | Expected | Actual | Nguồn (file:line / log / ảnh) |
| --- | --- | --- | --- | --- | --- |
| F-01 | BLOCKING / NON-BLOCKING / UNCERTAIN |  |  |  |  |

## Đã soi những gì

> "Không tìm thấy" chỉ có giá trị khi nói rõ đã tìm ở đâu. Liệt kê đường đã đi.

- …

## Giới hạn của lượt kiểm này

> Cái gì **không** kiểm được (không có e2e, không có tài khoản, phụ thuộc hệ thống ngoài) — ghi thẳng, đừng để trống.

- …

## Gate 5 — checklist

- [ ] Mọi lệnh ProjectRules §7 xanh **khi tự chạy**, output thật dán ở trên
- [ ] Mọi AC của `02` có dòng ở `08` **và** test tương ứng thật sự assert được AC
- [ ] Diff nằm trong scope Gate 3, phần ngoài đã khai ở Plan Deviations
- [ ] Không có finding BLOCKING
- [ ] Không còn UNCERTAIN chưa được user trả lời

> FAIL → `status = blocked`, ghi finding vào đây + `.agent-memory/adversary.md`, báo to, re-route implementer.
> PASS → `status = reviewing`, dừng chờ user.
