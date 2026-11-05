/* AI review reports: the board lists a report directory, maps file names back to PR
   numbers, reads each report once per blob SHA, takes the verdict and summary from it,
   says when the PR has moved on since the review, and shows the full report filtered.

   The GitHub API is mocked, so no token or network is needed.

   usage: bun reports.mjs --head <dir> [--base <dir>]   (--base is ignored) */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "http://pingboard.test";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const LOGIN = "pingboard-tester";
const REPO = "acme/widgets";
const HEAD = { 1: "1".repeat(40), 2: "2".repeat(40), 3: "3".repeat(40) };
const SOURCE = `${REPO} = acme/reviews@ai-reviews:reviews/pr-{number}-review.md`;

const at = process.argv.indexOf("--head");
if (at === -1) throw new Error("usage: bun reports.mjs --head <dir>");
const head = path.resolve(process.argv[at + 1]);

const REPORTS = {
  // Current: front matter names the PR's head commit.
  "blob-1": `---
pr: 1
repo: ${REPO}
head_sha: ${HEAD[1]}
verdict: needs-work        # block | needs-work | lgtm
reviewed_at: 2026-10-24T10:00:00Z
skill: pr-review-mock
---

# PR #1 Review

## 1. 总结

Adds a **retry** loop to the fetcher.

## 2. 背景与动机

Not part of the summary.

\`\`\`mermaid
graph TD
  A-->B
\`\`\`

<script>window.__pwned = true</script>
<a href="javascript:window.__pwned=true">bad link</a>
<img src="x" onerror="window.__pwned=true">
`,
  // Stale: reviewed an older commit.
  "blob-2": `---
pr: 2
head_sha: abcdef1234567
verdict: lgtm
---

## 1. Summary

Renames a helper.
`,
  // From before front matter: the verdict comes from its section, which also lists a legend.
  "blob-3": `# Review

## §1 总结

Old report.

## 8. 结论 (Verdict)

🔴 BLOCK — the cache key ignores the dtype.

Legend: 🔴 BLOCK · ⚠️ NEEDS WORK · ✅ LGTM
`
};

function mockPullRequest(number) {
  const now = new Date().toISOString();
  return {
    ref: { compare: { aheadBy: 1, behindBy: 0 } },
    pullRequest: {
      id: `PR_${number}`, number, title: `Widget change ${number}`, url: `https://github.com/${REPO}/pull/${number}`,
      state: "OPEN", isDraft: false, updatedAt: now, closedAt: null, author: { login: "someone" }, authorAssociation: "MEMBER",
      baseRefName: "main", headRefOid: HEAD[number], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
      viewerCanUpdateBranch: true, autoMergeRequest: null, additions: 1, deletions: 1, changedFiles: 1,
      labels: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, reviewRequests: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] },
      commits: { nodes: [{ commit: { oid: HEAD[number], committedDate: now, statusCheckRollup: null } }] }
    }
  };
}

function mockGitHub(request, calls) {
  const url = new URL(request.url());
  calls.push(`${request.method()} ${url.pathname}${url.search}`);
  if (url.pathname === "/user") return { json: { login: LOGIN } };
  if (url.pathname === "/repos/acme/reviews/contents/reviews") {
    return { json: [
      { type: "file", name: "pr-1-review.md", path: "reviews/pr-1-review.md", sha: "blob-1", html_url: "https://github.com/acme/reviews/blob/ai-reviews/reviews/pr-1-review.md" },
      { type: "file", name: "pr-2-review.md", path: "reviews/pr-2-review.md", sha: "blob-2", html_url: "https://github.com/acme/reviews/blob/ai-reviews/reviews/pr-2-review.md" },
      { type: "file", name: "pr-3-review.md", path: "reviews/pr-3-review.md", sha: "blob-3", html_url: null },
      { type: "file", name: "notes.md", path: "reviews/notes.md", sha: "blob-x" },
      { type: "dir", name: "pr-4-review.md", path: "reviews/pr-4-review.md", sha: "tree-4" }
    ] };
  }
  const blob = url.pathname.match(/^\/repos\/acme\/reviews\/git\/blobs\/(.+)$/);
  if (blob) return { json: { content: Buffer.from(REPORTS[blob[1]], "utf8").toString("base64"), encoding: "base64" } };
  if (url.pathname === "/markdown") {
    // Roughly what GitHub returns: raw HTML passes through, mermaid becomes a viewscreen section.
    const { text } = JSON.parse(request.postData());
    const html = text
      .replace(/```mermaid\n([\s\S]*?)```/, (_, src) => `<section data-type="mermaid"><div data-plain="${src}"><pre lang="mermaid">${src}</pre></div></section>`)
      .replace(/^## (.*)$/gm, '<h2 id="user-content-x" class="heading">$1</h2>');
    return { text: html };
  }
  if (url.pathname !== "/graphql") return { json: [] };
  const { query, variables = {} } = JSON.parse(request.postData() || "{}");
  if (query.includes("pullRequest(number:")) {
    const aliases = Object.keys(variables).filter((key) => /^number\d+$/.test(key)).map((key) => key.slice(6));
    return { json: { data: Object.fromEntries(aliases.map((i) => [`pr${i}`, mockPullRequest(variables[`number${i}`])])) } };
  }
  if (query.includes("history(first:")) return { json: { data: { repository: { ref: { target: { history: { nodes: [] } } } } } } };
  return { json: { data: { search: { issueCount: 0, nodes: [] }, repository: { object: null } } } };
}

const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(label);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`}`);
}

const browser = await chromium.launch();

async function session(prefs) {
  const context = await browser.newContext();
  const calls = [];
  await context.route("**/*", (route) => route.abort());   // fonts, and the Mermaid CDN
  await context.route("https://api.github.com/**", (route) => {
    const { json, text } = mockGitHub(route.request(), calls);
    return route.fulfill({ ...(text !== undefined ? { body: text, contentType: "text/html" } : { json }), headers: { "access-control-allow-origin": "*" } });
  });
  await context.route(`${ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/__blank") return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
    const file = path.join(head, pathname === "/" ? "index.html" : pathname);
    try {
      await route.fulfill({ contentType: MIME[path.extname(file)] || "application/octet-stream", body: await readFile(file) });
    } catch {
      await route.fulfill({ status: 404, body: "not found" });
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${ORIGIN}/__blank`);
  await page.evaluate(([login, prefs, repo]) => {
    localStorage.clear();
    localStorage.setItem("pingboard.githubToken", "test-token");
    localStorage.setItem(`pingboard.v3.${login}.prefs`, JSON.stringify(prefs));
    localStorage.setItem(`pingboard.v3.${login}.board`, JSON.stringify({
      groups: [{ id: "g1", name: "Tracking", collapsed: false }],
      pins: [1, 2, 3, 5].map((number, i) => ({ key: `${repo}#${number}`, repo, number, group: "g1", addedAt: 1791470000000 + i }))
    }));
  }, [LOGIN, prefs, REPO]);
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => typeof state !== "undefined" && Boolean(state.user), null, { timeout: 15000 });
  return { context, page, errors, calls };
}

const select = async (page, number) => {
  await page.locator(".row", { hasText: `Widget change ${number}` }).click();
  await page.waitForFunction((n) => {
    const text = document.querySelector("#detail")?.textContent || "";
    return text.includes(`Widget change ${n}`) && !/Reading the report|Looking for AI review/.test(text);
  }, number, { timeout: 10000 });
};
const aiPanel = (page) => page.evaluate(() => [...document.querySelectorAll("#detail .panel")].find((node) => node.querySelector("h3")?.textContent === "AI review")?.innerText ?? null);

console.log("\nparsing (in the page)");
{
  const { context, page } = await session({ reportSources: [SOURCE] });
  const parsed = await page.evaluate(() => {
    const source = parseReportSource("a/b = c/d@main:reviews/pr-{number}-review.md");
    return {
      line: source.line,
      matches: ["pr-12-review.md", "pr-x-review.md", "xpr-12-review.md"].map((name) => name.match(source.pattern)?.[1] ?? null),
      noBranch: parseReportSource("a/b = c/d:pr-{number}.md")?.ref,
      rejected: ["a/b", "a/b = c/d:reviews/", "a/b = c/d:{number}/x-{number}.md", "a/b = c/d:pr.md"].map((line) => parseReportSource(line))
    };
  });
  check("normalizes the source line", parsed.line, "a/b = c/d@main:reviews/pr-{number}-review.md");
  check("file names map back to PR numbers", parsed.matches, ["12", null, null]);
  check("the branch is optional", parsed.noBranch, "");
  check("malformed sources are rejected", parsed.rejected, [null, null, null, null]);
  await context.close();
}

console.log("\nreport panel");
{
  const { context, page, errors, calls } = await session({ reportSources: [SOURCE] });
  await page.waitForFunction(() => state.reports.size && [...state.reports.values()].every((index) => index.at), null, { timeout: 10000 });
  check("lists the report directory on its branch", calls.filter((call) => call.includes("/contents/")), ["GET /repos/acme/reviews/contents/reviews?ref=ai-reviews"]);
  check("indexes only files that match the template", await page.evaluate(() => [...[...state.reports.values()][0].files.keys()].sort()), [1, 2, 3]);

  await select(page, 1);
  let text = await aiPanel(page);
  check("current report: verdict badge", text?.includes("⚠️ NEEDS WORK"), true);
  check("current report: covers the latest commit", text?.includes("Covers the latest commit (1111111)"), true);
  check("current report: §1 as the summary", text?.includes("Adds a retry loop to the fetcher.") && !text.includes("Not part of the summary"), true);
  check("current report: skill name", text?.includes("pr-review-mock"), true);
  check("row shows the verdict once read", await page.locator(".row", { hasText: "Widget change 1" }).locator(".ai-chip").innerText(), "AI NEEDS WORK");

  await select(page, 2);
  text = await aiPanel(page);
  check("stale report: says the PR moved on", text?.includes("PR has new commits since this review (abcdef1 → 2222222)"), true);
  check("stale report: row says stale", await page.locator(".row", { hasText: "Widget change 2" }).locator(".ai-chip").innerText(), "AI LGTM · stale");

  await select(page, 3);
  text = await aiPanel(page);
  check("old report: verdict from the 结论 section", text?.includes("🔴 BLOCK"), true);
  check("old report: no commit recorded", text?.includes("does not record which commit"), true);

  await select(page, 5);
  check("PR without a report", await aiPanel(page), "AI REVIEW\nNo AI review report for this PR yet.");

  console.log("\nfull report");
  await select(page, 1);
  await page.keyboard.press("i");
  await page.waitForSelector(".report-modal .report-body h2", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector(".report-modal")?.textContent.includes("shown as source"), null, { timeout: 10000 });
  const report = await page.evaluate(() => {
    const body = document.querySelector(".report-modal .report-body");
    return {
      headings: [...body.querySelectorAll("h2")].map((node) => node.textContent),
      headingAttrs: [...body.querySelector("h2").attributes].map((attr) => attr.name).sort(),
      scripts: body.querySelectorAll("script").length,
      badHref: body.querySelector("a")?.getAttribute("href") ?? null,
      onerror: body.querySelector("img")?.getAttribute("onerror") ?? null,
      mermaidSource: body.querySelector("pre.mermaid-src")?.textContent.trim() ?? null,
      pwned: Boolean(window.__pwned)
    };
  });
  check("i opens the report rendered by /markdown", report.headings, ["1. 总结", "2. 背景与动机"]);
  check("keeps only safe attributes", report.headingAttrs, ["id"]);
  check("drops scripts", report.scripts, 0);
  check("drops javascript: links", report.badHref, null);
  check("drops event handlers", report.onerror, null);
  check("Mermaid unreachable: diagram shown as source", report.mermaidSource, "graph TD\n  A-->B");
  check("nothing in the report ran", report.pwned, false);
  await page.keyboard.press("Escape");

  const blobReads = () => calls.filter((call) => call.includes("/git/blobs/")).length;
  const before = blobReads();
  await select(page, 2);
  await select(page, 1);
  await page.keyboard.press("i");
  await page.waitForSelector(".report-modal .report-body h2");
  check("reports are read once per blob SHA", blobReads() - before, 0);
  check("each blob read once in all", calls.filter((call) => call.includes("/git/blobs/")).sort(), ["GET /repos/acme/reviews/git/blobs/blob-1", "GET /repos/acme/reviews/git/blobs/blob-2", "GET /repos/acme/reviews/git/blobs/blob-3"]);
  check("no page errors", errors, []);
  await context.close();
}

console.log("\nsettings");
{
  const { context, page, errors } = await session({});
  await page.waitForTimeout(500);
  check("no sources: no AI review panel", await (async () => { await select(page, 1); return aiPanel(page); })(), null);
  await page.keyboard.press(",");
  const box = page.locator(".settings-modal textarea");
  await box.fill("not a source");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  check("a malformed source keeps Settings open", await page.locator(".settings-modal").count(), 1);
  await box.fill(`# comment\n${SOURCE}\n${SOURCE}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  check("saved, without comments or duplicates", await page.evaluate(() => state.prefs.reportSources), [SOURCE]);
  await select(page, 1);
  check("the new source is read at once", (await aiPanel(page))?.includes("⚠️ NEEDS WORK"), true);
  check("no page errors", errors, []);
  await context.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAI review reports work.");
