#!/usr/bin/env python3
"""Write a MOCK review report for a PR from the data fetch_pr_data.py saved.

The facts (files, line numbers, head SHA, CI, discussion) are real; the review text is
template prose, not an actual review. The structure matches what the board expects:
front matter, Part A §1–6 (with a Mermaid diagram), Part B §7–8, §9 English comments.

usage: mock_report.py <pr-data.json> [--verdict block|needs-work|lgtm] [--out DIR]
Writes DIR/pr-<number>-review.md (default DIR: outputs) and prints the path."""
import argparse
import datetime
import json
import os
import re
from collections import OrderedDict

VERDICTS = {
    "block": "🔴 BLOCK",
    "needs-work": "⚠️ NEEDS WORK",
    "lgtm": "✅ LGTM",
}


def added_lines(diff):
    """[(path, new-file line number, text)] for every added line in a unified diff."""
    out, path, line = [], None, 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            path = raw[6:] if raw.startswith("+++ b/") else None
        elif raw.startswith("@@"):
            match = re.search(r"\+(\d+)", raw)
            line = int(match.group(1)) if match else 0
        elif path is None:
            continue
        elif raw.startswith("+"):
            out.append((path, line, raw[1:]))
            line += 1
        elif not raw.startswith("-"):
            line += 1
    return out


def module_of(path):
    return path.split("/")[0] if "/" in path else "(root)"


def mermaid_id(text):
    return re.sub(r"\W", "_", text) or "root"


def ci_summary(rollup):
    if not rollup:
        return "最新 Commit 上没有 CI 记录。", []
    failed = [c.get("name") or c.get("context") for c in rollup
              if (c.get("conclusion") or c.get("state") or "").upper() in ("FAILURE", "ERROR")]
    pending = [c for c in rollup if (c.get("status") or "").upper() not in ("", "COMPLETED") or (c.get("state") or "").upper() == "PENDING"]
    if pending:
        return f"CI 仍在运行（{len(pending)} 个 Job 未完成）。", failed
    if failed:
        return f"CI 有 {len(failed)} 个失败 Job：{', '.join(failed)}。CI 红了不等于 PR 有问题，需先与 main 对比。", failed
    return f"CI 全部通过（{len(rollup)} 个 Check）。", failed


def build(data, verdict):
    files = data.get("files") or []
    added = added_lines(data.get("diff") or "")
    modules = OrderedDict()
    for item in files:
        modules.setdefault(module_of(item["path"]), []).append(item)
    ci_text, failed = ci_summary(data.get("statusCheckRollup"))
    head = data["headRefOid"]
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    title = data["title"]
    body = (data.get("body") or "").strip()
    comments = data.get("comments") or []
    reviews = data.get("reviews") or []

    # Comment targets: the first added non-blank lines, spread over different files.
    targets, seen = [], set()
    for path, line, text in added:
        if text.strip() and path not in seen:
            targets.append((path, line, text.strip()))
            seen.add(path)
    for path, line, text in added:
        if len(targets) >= 3:
            break
        if text.strip() and (path, line, text.strip()) not in targets:
            targets.append((path, line, text.strip()))
    targets = targets[:5]

    out = []
    w = out.append
    w("---")
    w(f"pr: {data['number']}")
    w(f"repo: {data['repo']}")
    w(f"head_sha: {head}")
    w(f"verdict: {verdict}        # block | needs-work | lgtm")
    w(f"reviewed_at: {now}")
    w("skill: pr-review-mock")
    w("---")
    w("")
    w(f"# PR #{data['number']} Review：{title}")
    w("")
    w(f"> ⚠️ 这是 **mock** 报告：文件、行号、CI 和讨论来自真实 PR 数据，评审意见是模板生成的占位文本。")
    w(f"> Head `{head[:7]}` · 作者 @{(data.get('author') or {}).get('login', 'ghost')} · "
      f"+{data.get('additions', 0)} −{data.get('deletions', 0)}，{data.get('changedFiles', len(files))} 个文件")
    w("")
    w("# Part A：PR 详细总结")
    w("")
    w("## 1. 总结")
    w("")
    w(f"该 PR「{title}」修改了 {len(files)} 个文件，涉及 {len(modules)} 个模块（{', '.join(modules)}），"
      f"新增 {data.get('additions', 0)} 行、删除 {data.get('deletions', 0)} 行。{ci_text}")
    w("")
    w("## 2. 背景与动机")
    w("")
    w(f"PR 描述：{body.splitlines()[0][:300]}" if body else "PR 描述为空：只能从 Diff 推断动机（mock 判断）。")
    w("")
    w("## 3. 代码修改分析")
    w("")
    w("| 模块 | 文件 | 改动 |")
    w("| --- | --- | --- |")
    for module, items in modules.items():
        for item in items:
            w(f"| {module} | `{item['path']}` | +{item.get('additions', 0)} −{item.get('deletions', 0)} |")
    w("")
    w("```mermaid")
    w("flowchart LR")
    w(f'  PR["#{data["number"]}"]')
    for module, items in modules.items():
        mid = mermaid_id(module)
        w(f'  PR --> {mid}["{module}"]')
        for i, item in enumerate(items[:4]):
            w(f'  {mid} --> {mid}_{i}["{os.path.basename(item["path"])}"]')
    w("```")
    w("")
    w("## 4. 技术原理")
    w("")
    w("（mock）真实 Skill 会在这里回答「计算上到底改了什么、影响哪些场景、为什么这样改」。")
    w("")
    w("## 5. 讨论亮点")
    w("")
    if comments or reviews:
        for item in (comments + reviews)[-5:]:
            who = (item.get("author") or {}).get("login", "ghost")
            text = (item.get("body") or "").strip().replace("\n", " ")[:160] or "(无正文)"
            w(f"- @{who}：{text}")
    else:
        w("- 暂无讨论。")
    w("")
    w("## 6. 风险")
    w("")
    w("| 风险 | 等级 | 说明 |")
    w("| --- | --- | --- |")
    w(f"| CI | {'高' if failed else '低'} | {ci_text} |")
    w(f"| 改动面 | {'中' if len(files) > 3 else '低'} | {len(files)} 个文件 |")
    w("")
    w("# Part B：Review 意见")
    w("")
    w("## 7. 问题列表")
    w("")
    severity = {"block": "🔴 阻塞", "needs-work": "⚠️ 建议修改", "lgtm": "💡 可选"}[verdict]
    if targets:
        for i, (path, line, text) in enumerate(targets, 1):
            level = severity if i == 1 else "💡 可选"
            w(f"{i}. **{level} · 正确性** `{path}:{line}`：`{text[:80]}` —— mock 意见：请确认这一行的边界情况有测试覆盖。")
    else:
        w("1. Diff 中没有新增代码行，无行级意见。")
    w("")
    w("## 8. 结论 (Verdict)")
    w("")
    w(f"**{VERDICTS[verdict]}**（mock：结论由 `--verdict` 参数指定，不是真实判断）")
    w("")
    w("## 9. English review comments")
    w("")
    for path, line, text in targets:
        w(f"- `{path}` line {line}:")
        w(f"  > Could you add a test that covers this change (`{text[:60]}`)? (mock comment)")
    if not targets:
        w("- No line-level comments.")
    w("")
    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("data")
    parser.add_argument("--verdict", choices=sorted(VERDICTS), default="needs-work")
    parser.add_argument("--out", default="outputs")
    args = parser.parse_args()
    with open(args.data, encoding="utf-8") as fh:
        data = json.load(fh)
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"pr-{data['number']}-review.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(build(data, args.verdict))
    print(path)


if __name__ == "__main__":
    main()
