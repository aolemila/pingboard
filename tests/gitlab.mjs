/* GitLab merge requests: pinned by URL or "group/project!N", read over GitLab's REST API with
   their pipeline jobs, notes (inline ones say where) and approvals; commented on from the
   detail pane; pinned by a "gitlab:" group search; AI reports apply to them too. Each token
   goes only to its own host.

   The GitHub and GitLab APIs are mocked, so no token or network is needed.

   usage: bun gitlab.mjs --head <dir> [--base <dir>]   (--base is ignored) */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "http://pingboard.test";
const GITLAB = "https://gitlab.test";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const LOGIN = "pingboard-tester";
const GL_LOGIN = "gl-tester";
const PROJECT = "ai-infra/tpu-infer-loop";
const ENCODED = encodeURIComponent(PROJECT);
const REPO = `gl:${PROJECT}`;
const HEAD = { 7: "7".repeat(40), 8: "8".repeat(40) };
const SOURCE = `gitlab:${PROJECT} = acme/reviews:reviews/mr-{number}-review.md`;

const at = process.argv.indexOf("--head");
if (at === -1) throw new Error("usage: bun gitlab.mjs --head <dir>");
const head = path.resolve(process.argv[at + 1]);

const REPORT = `---
pr: 7
head_sha: ${HEAD[7]}
verdict: block
---

## 1. 总结

Adds four kernel skills.
`;

function mockMR(iid) {
  return {
    id: 1000 + iid, iid, title: `Kernel skills ${iid}`, state: "opened", draft: false,
    author: { username: "wuhuanzi" }, target_branch: "main", sha: HEAD[iid],
    has_conflicts: false, detailed_merge_status: "mergeable", updated_at: new Date().toISOString(),
    web_url: `${GITLAB}/${PROJECT}/-/merge_requests/${iid}`,
    reviewers: iid === 7 ? [{ username: GL_LOGIN }] : [], labels: [{ name: "kernel", color: "#ff0000" }],
    head_pipeline: iid === 7 ? { id: 3629, status: "failed", web_url: `${GITLAB}/${PROJECT}/-/pipelines/3629`, created_at: "2026-11-09T03:00:00Z" } : null,
    diverged_commits_count: 0, changes_count: "4", references: { full: `${PROJECT}!${iid}` }
  };
}

const NOTES = [
  { id: 3, body: "Please add a test", author: { username: "wuhuanzi" }, system: false, created_at: "2026-11-09T05:00:00Z", type: "DiffNote", position: { new_path: ".agents/skills/kernel-initial/SKILL.md", new_line: 12 } },
  { id: 2, body: "Overall fine", author: { username: "someone" }, system: false, created_at: "2026-11-09T04:00:00Z", type: null },
  { id: 1, body: `requested review from @${GL_LOGIN}`, author: { username: GL_LOGIN }, system: true, created_at: "2026-11-09T03:50:00Z" }
];

function mockGitLab(request, mock) {
  const url = new URL(request.url());
  mock.gitlabAuth.add(request.headers()["private-token"] || "");
  if (request.headers().authorization) mock.leaks.push(`GitHub token sent to GitLab: ${url.pathname}`);
  const p = url.pathname;
  if (p === "/api/v4/user") return { json: { username: GL_LOGIN } };
  if (p === "/api/v4/merge_requests") {
    mock.searches.push(url.search);
    return { json: [mockMR(7), mockMR(8)], headers: { "x-total": "2" } };
  }
  const mr = p.match(new RegExp(`^/api/v4/projects/${ENCODED.replace(/%/g, "%")}/merge_requests/(\\d+)(/.*)?$`));
  if (mr) {
    const [, iid, rest = ""] = mr;
    if (rest === "") return { json: mockMR(Number(iid)) };
    if (rest === "/notes" && request.method() === "POST") {
      mock.posted.push({ iid: Number(iid), body: JSON.parse(request.postData()).body });
      return { status: 201, json: { id: 99 } };
    }
    if (rest === "/notes") return { json: Number(iid) === 7 ? NOTES : [] };
    if (rest === "/approvals") return { json: { approved_by: [] } };
  }
  if (p === `/api/v4/projects/${ENCODED}/pipelines/3629/jobs`) {
    return { json: [
      { name: "lint", stage: "test", status: "success", web_url: `${GITLAB}/jobs/1`, created_at: "2026-11-09T03:00:00Z" },
      { name: "unit", stage: "test", status: "failed", allow_failure: false, web_url: `${GITLAB}/jobs/2`, created_at: "2026-11-09T03:00:00Z" },
      { name: "flaky", stage: "test", status: "failed", allow_failure: true, web_url: `${GITLAB}/jobs/3`, created_at: "2026-11-09T03:00:00Z" }
    ] };
  }
  return { status: 404, json: { message: "404 Not Found" } };
}

function mockGitHub(request, mock) {
  const url = new URL(request.url());
  if (request.headers()["private-token"]) mock.leaks.push(`GitLab token sent to GitHub: ${url.pathname}`);
  if (url.pathname === "/user") return { json: { login: LOGIN } };
  if (url.pathname === "/repos/acme/reviews/contents/reviews") {
    return { json: [{ type: "file", name: "mr-7-review.md", path: "reviews/mr-7-review.md", sha: "blob-7" }] };
  }
  if (url.pathname === "/repos/acme/reviews/git/blobs/blob-7") return { json: { content: Buffer.from(REPORT).toString("base64"), encoding: "base64" } };
  if (url.pathname !== "/graphql") return { json: [] };
  return { json: { data: { search: { issueCount: 0, nodes: [] }, repository: { object: null } } } };
}

const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(label);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`}`);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const mock = { posted: [], searches: [], leaks: [], gitlabAuth: new Set() };
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "private-token,authorization,content-type", "access-control-expose-headers": "x-total" };
await context.route("**/*", (route) => route.abort());
await context.route("https://api.github.com/**", (route) => {
  const { json, status = 200 } = mockGitHub(route.request(), mock);
  return route.fulfill({ status, json, headers: cors });
});
await context.route(`${GITLAB}/**`, (route) => {
  const { json, status = 200, headers = {} } = mockGitLab(route.request(), mock);
  return route.fulfill({ status, json, headers: { ...cors, ...headers } });
});
await context.route(`${ORIGIN}/**`, async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/__blank") return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
  try {
    await route.fulfill({ contentType: MIME[path.extname(pathname)] || "text/html", body: await readFile(path.join(head, pathname === "/" ? "index.html" : pathname)) });
  } catch {
    await route.fulfill({ status: 404, body: "not found" });
  }
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(`${ORIGIN}/__blank`);
await page.evaluate(([login, repo, source, gitlab]) => {
  localStorage.clear();
  localStorage.setItem("pingboard.githubToken", "gh-test-token");
  localStorage.setItem("pingboard.gitlabToken", "glpat-test-token");
  localStorage.setItem(`pingboard.v3.${login}.prefs`, JSON.stringify({ reportSources: [source], gitlabUrl: gitlab }));
  localStorage.setItem(`pingboard.v3.${login}.board`, JSON.stringify({
    groups: [{ id: "g1", name: "Tracking", collapsed: false }, { id: "g2", name: "GitLab reviews", collapsed: false }],
    pins: [{ key: `${repo}#7`, repo, number: 7, group: "g1", addedAt: 1791470000000 }]
  }));
}, [LOGIN, REPO, SOURCE, GITLAB]);
const boot = async () => {
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => typeof state !== "undefined" && state.gitlabUser && state.data.get("gl:ai-infra/tpu-infer-loop#7")?.reviewRequested, null, { timeout: 15000 });
};
const detail = () => page.locator("#detail").innerText();

console.log("\nreferences");
await boot();
check("MR URL and group/project!N parse as GitLab refs", await page.evaluate(() => parseRefs(`https://gitlab.test/ai-infra/tpu-infer-loop/-/merge_requests/7 a/b/c!3 owner/repo#5`)), [
  { repo: REPO, number: 7 }, { repo: "gl:a/b/c", number: 3 }, { repo: "owner/repo", number: 5 }
]);
check("shown as group/project!N", await page.locator(".row .num").first().innerText(), `${PROJECT}!7`);

console.log("\nmerge request");
await page.locator(".row", { hasText: "Kernel skills 7" }).click();
await page.waitForFunction(() => document.querySelector("#detail")?.textContent.includes("BLOCK"), null, { timeout: 10000 });
let text = await detail();
check("pipeline failure to look at", text.includes("1 failure to look at"), true);
check("failed job listed, allowed failure not", text.includes("test / unit") && !text.includes("test / flaky"), true);
check("your review requested", text.includes("Your review is requested"), true);
check("human notes shown, system notes hidden", text.includes("Overall fine") && !text.includes("requested review from"), true);
check("inline note says where it is", text.includes(".agents/skills/kernel-initial/SKILL.md:12 · Please add a test"), true);
check("label read", text.includes("kernel"), true);
check("opens on GitLab", text.includes("Open on GitLab ↗"), true);
check("no CI, approve or merge buttons", await page.locator("#detail button", { hasText: /^(Run CI|Approve|Merge…)$/ }).count(), 0);
check("says to approve and merge on GitLab", text.includes("Approve and merge on GitLab."), true);
check("AI report applies to the MR", text.includes("🔴 BLOCK") && text.includes("Covers the latest commit"), true);

console.log("\ncomment");
const box = page.locator("#detail .comment-input");
await box.fill("Looks good to me");
await box.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
await page.waitForTimeout(3800);
check("posted as a note on the MR", mock.posted, [{ iid: 7, body: "Looks good to me" }]);

console.log("\nsearch");
await page.evaluate(() => {
  const group = state.board.groups.find((item) => item.id === "g2");
  Object.assign(group, { query: "gitlab: reviewer_username=@me", dismissed: [] });
  persistBoard();
  syncGroup("g2");
});
await page.waitForFunction(() => state.board.pins.some((pin) => pin.key === "gl:ai-infra/tpu-infer-loop#8"), null, { timeout: 10000 });
check("@me becomes the token's user", new URLSearchParams(mock.searches[0]).get("reviewer_username"), GL_LOGIN);
check("search pins the new MR into its group", await page.evaluate(() => state.board.pins.filter((pin) => pin.group === "g2").map((pin) => pin.key)), [`${REPO}#8`]);

console.log("\nreload");
await boot();
check("GitLab pins survive a reload", await page.evaluate(() => state.board.pins.map((pin) => pin.key)), [`${REPO}#7`, `${REPO}#8`]);
check("GitLab token unchanged", await page.evaluate(() => state.gitlabToken), "glpat-test-token");

console.log("\ntokens");
check("GitLab sees only the GitLab token", [...mock.gitlabAuth], ["glpat-test-token"]);
check("no token went to the other host", mock.leaks, []);
check("no page errors", errors, []);

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nGitLab merge requests work.");
