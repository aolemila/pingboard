# Pingboard

One board for the pull requests you are shepherding through CI. Pin the PRs you care about and each one tells you, in plain words, where it stands and what it needs next — instead of a browser tab per PR. The usual maintainer actions (update branch, run or retry CI, labels, approve, merge) are buttons on the board.

<img width="1668" height="1027" alt="Screenshot 2026-10-08 at 12 57 06 PM" src="https://github.com/user-attachments/assets/458d4cbf-d81b-4962-937f-36c99a792ed9" />

It is a static page that talks to the GitHub API from your browser: no server, no build step, no dependencies. It is tuned for [vllm-project/vllm](https://github.com/vllm-project/vllm) and works for any repository.

## The board

Each row is one pull request with a status and, where there is an obvious next step, a button for it.

| Status | Meaning | Button |
| --- | --- | --- |
| **CI not started** | no build on the latest commit | Run CI, or Update branch & run CI when the branch is behind |
| **CI running** | jobs in progress, with any failures so far | — |
| **N failures to look at** | failing jobs not seen failing anywhere else | — |
| **N failures, likely unrelated** | every failing job also fails on the base branch or on other pinned PRs | Retry failed jobs |
| **CI passed · needs review** | green, waiting on a review | — |
| **Ready to merge** | green and approved | Merge… |
| **Merge conflicts** | the author has to resolve them | — |

The chips above the list filter by CI state (number keys `1`–`7`, including **Review requested**) and, separately, by owner: **Mine** shows the PRs you authored, **Others'** the ones you are shepherding for someone else. The selection is remembered. A PR that requests your review directly says **your review requested** (requests to a team you are on are not detected).

A blue dot marks a PR that changed since you last selected it: its state, commits, CI or review decision, a new comment or review from someone other than you, or a new request for your review. Drag rows to reorder them or move them between groups, and drag the divider to resize the list. The sort menu orders each group by recently updated, recently pinned, newest PR or needs attention instead of by hand; Manual order brings your arrangement back.

Selecting a row opens the detail pane: the status with a one-line explanation, the failing and running jobs (each links to its Buildkite job), branch freshness, reviews, labels, and the latest comments — which is where the CI bot answers `/ci` commands.

**+ Add PRs** lists open pull requests in your default repository (yours, review requested, reviewed, involved, `ready`, all recent) and narrows as you type. Click to pin; pasting PR numbers or URLs works too. Type `@name` to see one author's PRs. To keep an eye on particular people, **Follow** them from a PR (or list them in Settings): their names are highlighted everywhere and Add PRs gets a **Following** list.

**Sync search** in a group's header keeps that group in step with a GitHub search such as `review-requested:@me` or `author:@me label:ready`. Every five minutes Pingboard pins new open PRs it finds into the group. A PR the search pinned is unpinned again once it stops matching while still open; PRs you pinned yourself or moved to another group stay put, and one you unpin is not pinned again. Searches without a `repo:`, `org:` or `user:` qualifier are scoped to your default repository. Clear the search to stop syncing.

Settings can also **unpin merged/closed PRs after a day** (off by default); **Clear merged / closed** does it at once.

Press `i` to open the selected PR's AI review report (see below).

## AI review reports

A review skill run by an agent (Claude Code, say) writes one Markdown report per PR and pushes it to a GitHub repository. Pingboard reads those reports and shows them next to the PR. List where they live in Settings, one source per line:

```
owner/repo = reports-owner/reports-repo@branch:reviews/pr-{number}-review.md
```

The left side is the repository whose PRs are reviewed; the right side is where the reports are, with an optional branch and a file name template. Every 10 minutes (or on **Refresh**) Pingboard lists that directory and maps file names back to PR numbers. A report is read when its PR is opened, and read again only when its blob SHA changes.

Reports start with front matter written by the skill:

```
---
pr: 123
repo: owner/repo
head_sha: <full SHA of the PR head that was reviewed>
verdict: needs-work        # block | needs-work | lgtm
reviewed_at: 2026-10-24T10:00:00Z
skill: pr-review
---
```

The detail pane's **AI review** panel shows the verdict, when it was reviewed, and §1 of the report as a summary. When `head_sha` is not the PR's current head it says **PR has new commits since this review** with both short SHAs, and the row's **AI** chip says *stale*. Reports without front matter still get a verdict from their "结论 (Verdict)" section.

File references in a report (`path:123`, `path:12-34`, and §9's "`path` line 123") link to that line: in the PR's diff when the report covers the head commit, otherwise in the file at the reviewed commit.

**View full report** (or `i`) renders the whole report through GitHub's `/markdown` endpoint, so tables, code and `#123` links look as they do on GitHub. The HTML is filtered with `DOMParser` before it is shown: no scripts, styles, event handlers or non-web links. Mermaid diagrams are drawn by Mermaid.js, loaded from jsDelivr (pinned version and SRI hash) only when a report has one; if it cannot load, the diagram stays as source. All of this uses REST quota, not the GraphQL quota the PR refresh uses.

## Related or unrelated failures

Pingboard does not read logs — Buildkite logs are not reachable from a static page. It sorts failing jobs using what GitHub already knows:

- **N/M on base** — the same job failed on N of the last M base-branch commits that ran CI.
- **also #123 #456** — the same job is failing on other PRs on your board.

A job with either kind of evidence is listed as "likely unrelated". Everything else is "to look at".

## Actions

Everything is done as you, with your token.

- **Comment** on a PR from the box at the bottom of the detail pane (`shift+c` focuses it, ⌘/Ctrl+Enter sends). Drafts are kept per PR across refreshes, PR switches and reloads; Undo or a failed send puts the text back.
- **Comments** (your own, and `/ci run`, `/ci retry`, `/ci cancel`) and **branch updates** wait three seconds behind an Undo bar before they are sent.
- **Update branch & run CI** merges the base branch in, waits for the new commit, then posts `/ci run`.
- **Approve** and **Merge** ask for confirmation. **Labels** apply immediately.

Keyboard shortcuts exist for all of it; press `?` for the list.

## A mock review skill

`.claude/skills/pr-review-mock` is a Claude Code skill that stands in for a real review skill. It fetches a PR with `gh`, writes a report in the format the AI review panel reads (front matter, summary, Mermaid diagram, issue list, verdict, English comments) and publishes it to the repository's `ai-reviews` branch. Files, line numbers, head SHA and CI come from the PR; the review text is a template, and the verdict is whatever you ask for. Ask Claude Code, in this folder, to review `owner/repo#N`.

## Token

Pingboard takes a **classic** personal access token with the `repo` scope (`public_repo` is enough for public repositories). It is sent only from your browser to `api.github.com`, and is kept in `sessionStorage` — or `localStorage` if you tick "Keep token after closing this tab". The board itself (pins, groups, preferences) lives in `localStorage` per GitHub login, so it belongs to one browser and one address. Settings has **Export board + settings** and **Import board + settings** buttons to back it up or move it. The backup never includes the GitHub token.

## Refresh and rate limits

Open PRs refresh every 60 seconds by default (configurable), background tabs five times slower, reading up to 10 PRs per GraphQL request. The base-branch baseline covers the last 30 commits and is re-read every 10 minutes. Group searches run every 5 minutes, one request each. Remaining API quota is shown in the top bar, and polling pauses if it runs low.

## Other repositories

`owner/repo#123` or a URL pins a PR from anywhere. The Settings button also lets you configure a repository's workflow directly in the browser: which checks count as CI, the gating pipeline, comment commands, quick labels, and merge method. Profiles are selectable from a dropdown and can be deleted; deleting a built-in profile override restores its built-in defaults. These overrides are cached in `localStorage` with the rest of that GitHub user's preferences, so they work on the published site and survive reloads. Built-in defaults live in `REPO_PROFILES` at the top of `app.js`; repositories without a saved or built-in profile start with every check treated as CI and no CI commands.

## GitLab merge requests

Settings → **GitLab** takes the instance URL (e.g. `https://gitlab.example.com`) and a personal access token with the `api` scope. The token is stored like the GitHub one, only in this browser, and is sent only to that GitLab instance. The instance must allow cross-origin requests from the board's address.

Paste a merge request URL or `group/project!123` into **+ Add PRs** to pin it. A merge request shows its state, the head pipeline's jobs as CI, conflicts, approvals, labels, the latest notes (inline ones say which line), and the AI review report if a source is configured for `gl:group/project`. **Your review requested** means you are one of its reviewers. The comment box posts a note on the merge request.

To pin merge requests automatically, give a group a **Sync search** starting with `gitlab:` followed by filters of GitLab's merge request list as `key=value`, e.g. `gitlab: reviewer_username=@me` or `gitlab: project=group/project author_username=someone`. `@me` is the token's user.

CI commands, branch updates, labels, approve and merge are not available for GitLab merge requests; do those on GitLab. Base-branch failure history is not read for GitLab, so only other pinned merge requests count as evidence that a failure is unrelated.

## Run it

Open `index.html`, or serve the folder:

```bash
python3 -m http.server 8080
```

The included workflow publishes the folder to GitHub Pages on every push to `main`.

## Tests

```bash
./tests/run
```

Runs the checks every pull request has to pass. It needs [Bun](https://bun.sh) and installs everything else itself.
