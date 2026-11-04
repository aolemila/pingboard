---
name: pr-review-mock
description: Write a MOCK AI review report for a GitHub PR (real files, lines, head SHA and CI; template review text) and publish it to the repo's ai-reviews branch so Pingboard's AI review panel shows it. Use when asked to "review PR owner/repo#N" for the review-board demo.
---

# pr-review-mock

A stand-in for a real review skill. The report has the structure Pingboard reads
(front matter, Part A §1–6 with a Mermaid diagram, Part B §7–8, §9 English comments),
but the review opinions are placeholders. Nothing here judges the code.

## Inputs

- `owner/repo` and PR number.
- Optional verdict: `block`, `needs-work` (default) or `lgtm`. The verdict is whatever
  is asked for; say so when reporting back.

## Steps

Run from the pingboard checkout. `outputs/` is git-ignored.

1. Fetch the PR (metadata, diff, discussion, reviews, CI):

   ```bash
   python3 .claude/skills/pr-review-mock/scripts/fetch_pr_data.py <owner/repo> <number>
   ```

2. Write the report:

   ```bash
   python3 .claude/skills/pr-review-mock/scripts/mock_report.py outputs/pr-data/<owner>_<repo>-pr-<number>.json --verdict <verdict>
   ```

   It writes `outputs/pr-<number>-review.md`. `head_sha` is the PR head at fetch time,
   which is how the board tells a stale report from a current one.

3. Publish it. This uploads the file to GitHub, so first apply any outbound-data
   check the user's environment requires (for example an enterprise DLP tool) to the
   report file, and stop if it blocks or cannot run. Then:

   ```bash
   python3 .claude/skills/pr-review-mock/scripts/publish_report.py outputs/pr-<number>-review.md --repo <owner/repo>
   ```

   The report goes to `reviews/pr-<number>-review.md` on the `ai-reviews` branch of the
   PR's own repository (created as an orphan branch the first time).

4. Tell the user the verdict used, the head SHA covered, and the file URL.

## Board setup

In Pingboard's Settings, under **AI review reports**, one line per repository:

```
owner/repo = owner/repo@ai-reviews:reviews/pr-{number}-review.md
```

The board re-lists the directory every 10 minutes; **Refresh** re-reads it at once.
