/* Comments: the detail pane has a comment box whose draft survives refreshes, PR switches
   and reloads; a comment waits behind the undo bar, Undo or a failed send puts the text
   back. File references in a report link to the line on GitHub.

   The GitHub API is mocked, so no token or network is needed.

   usage: bun comments.mjs --head <dir> [--base <dir>]   (--base is ignored) */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const ORIGIN = "https://pingboard.test";   // a secure context, so crypto.subtle (diff anchors) exists
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const LOGIN = "pingboard-tester";
const REPO = "acme/widgets";
const HEAD = { 1: "1".repeat(40), 2: "2".repeat(40) };
const SOURCE = `${REPO} = acme/reviews:reviews/pr-{number}-review.md`;
const REPORT = (number, sha) => `---
pr: ${number}
head_sha: ${sha}
verdict: needs-work
---

## 1. 总结

Summary.

## 7. 问题列表

1. **⚠️** \`src/app/fetch.py:42\`: retries forever. Range \`src/app/fetch.py:10-12\`. Not a path: \`x:1\`.

## 9. English review comments

- \`src/app/fetch.py\` line 42 (diff right side):
  > Please bound the retries.
`;

const at = process.argv.indexOf("--head");
if (at === -1) throw new Error("usage: bun comments.mjs --head <dir>");
const head = path.resolve(process.argv[at + 1]);

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

function mockGitHub(request, mock) {
  const url = new URL(request.url());
  if (url.pathname === "/user") return { json: { login: LOGIN } };
  const posted = url.pathname.match(/^\/repos\/acme\/widgets\/issues\/(\d+)\/comments$/);
  if (posted && request.method() === "POST") {
    if (mock.failNext) {
      mock.failNext = false;
      return { status: 422, json: { message: "Validation Failed" } };
    }
    mock.posted.push({ number: Number(posted[1]), body: JSON.parse(request.postData()).body });
    return { status: 201, json: { id: mock.posted.length } };
  }
  if (url.pathname === "/repos/acme/reviews/contents/reviews") {
    return { json: [1, 2].map((n) => ({ type: "file", name: `pr-${n}-review.md`, path: `reviews/pr-${n}-review.md`, sha: `blob-${n}` })) };
  }
  const blob = url.pathname.match(/\/git\/blobs\/blob-(\d)$/);
  // PR 1's report covers its head; PR 2's reviewed an older full commit.
  if (blob) return { json: { content: Buffer.from(REPORT(blob[1], blob[1] === "1" ? HEAD[1] : "a".repeat(40))).toString("base64"), encoding: "base64" } };
  if (url.pathname === "/markdown") {
    const { text } = JSON.parse(request.postData());
    const body = text.replace(/^---[\s\S]*?---\n/, "");
    const html = body.split("\n").map((line) => line
      .replace(/^## (.*)$/, "<h2>$1</h2>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")).join("\n");
    return { text: `<div>${html}</div>` };
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
const context = await browser.newContext();
const mock = { posted: [], failNext: false };
await context.route("**/*", (route) => route.abort());
await context.route("https://api.github.com/**", (route) => {
  const { json, text, status = 200 } = mockGitHub(route.request(), mock);
  return route.fulfill({ status, ...(text !== undefined ? { body: text, contentType: "text/html" } : { json }), headers: { "access-control-allow-origin": "*" } });
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
await page.evaluate(([login, repo, source]) => {
  localStorage.clear();
  localStorage.setItem("pingboard.githubToken", "test-token");
  localStorage.setItem(`pingboard.v3.${login}.prefs`, JSON.stringify({ reportSources: [source] }));
  localStorage.setItem(`pingboard.v3.${login}.board`, JSON.stringify({
    groups: [{ id: "g1", name: "Tracking", collapsed: false }],
    pins: [1, 2].map((number, i) => ({ key: `${repo}#${number}`, repo, number, group: "g1", addedAt: 1791470000000 + i }))
  }));
}, [LOGIN, REPO, SOURCE]);
const boot = async () => {
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => typeof state !== "undefined" && state.data.size === 2, null, { timeout: 15000 });
};
const select = async (number) => {
  await page.locator(".row", { hasText: `Widget change ${number}` }).click();
  await page.waitForFunction((n) => document.querySelector("#detail")?.textContent.includes(`Widget change ${n}`), number);
};
const box = () => page.locator("#detail .comment-input");
await boot();

console.log("\ndrafts");
await select(1);
await page.keyboard.press("Shift+C");
await page.waitForFunction(() => document.activeElement?.classList.contains("comment-input"));
check("shift+c focuses the comment box", true, true);
await page.keyboard.type("Looks good, one ");
await page.evaluate(() => refreshAll());   // the pane is rebuilt underneath the typing
await page.waitForTimeout(800);
await page.keyboard.type("question");
check("typing survives a refresh, focus and caret included", await box().inputValue(), "Looks good, one question");
await page.keyboard.press("Escape");
await select(2);
check("each PR has its own box", await box().inputValue(), "");
await select(1);
check("switching back keeps the draft", await box().inputValue(), "Looks good, one question");
await boot();
await select(1);
check("a reload keeps the draft", await box().inputValue(), "Looks good, one question");

console.log("\nsending");
await box().focus();
await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
check("⌘/Ctrl+Enter empties the box", await box().inputValue(), "");
const undoText = await page.locator(".undo-bar").innerText({ timeout: 2000 }).catch((error) => error.message.split("\n")[0]);
check("and shows the undo bar", undoText.includes("Comment “Looks good, one question” → "), true);
await page.keyboard.press("z");
await page.waitForTimeout(3500);
check("undo: nothing posted", mock.posted, []);
check("undo: the text is back", await box().inputValue(), "Looks good, one question");

mock.failNext = true;
await page.getByRole("button", { name: "Comment", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".toast.error"), null, { timeout: 8000 });
check("failed send: the error is shown", (await page.locator(".toast.error").first().innerText()).includes("Validation Failed"), true);
check("failed send: the text is back", await box().inputValue(), "Looks good, one question");

await box().fill("Multi\nline **comment**");
await page.getByRole("button", { name: "Comment", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".toast.ok"), null, { timeout: 8000 });
check("sent once, to the right PR, verbatim", mock.posted, [{ number: 1, body: "Multi\nline **comment**" }]);
check("the draft is cleared", await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}"), `pingboard.v3.${LOGIN}.drafts`), {});
await box().fill("   ");
await page.getByRole("button", { name: "Comment", exact: true }).click();
await page.waitForTimeout(300);
check("a blank comment is not sent", await page.locator(".undo-bar").count(), 0);

console.log("\nreport links");
const links = async (number) => {
  await select(number);
  await page.waitForFunction(() => !document.querySelector("#detail")?.textContent.includes("Reading the report"));
  await page.keyboard.press("i");
  await page.waitForFunction(() => document.querySelectorAll(".report-modal a.code-ref").length >= 3, null, { timeout: 10000 });
  const hrefs = await page.$$eval(".report-modal a.code-ref", (nodes) => nodes.map((node) => [node.textContent, node.getAttribute("href")]));
  await page.keyboard.press("Escape");
  return hrefs;
};
const anchor = createHash("sha256").update("src/app/fetch.py").digest("hex");
check("current report: lines open in the PR diff", await links(1), [
  ["src/app/fetch.py:42", `https://github.com/${REPO}/pull/1/files#diff-${anchor}R42`],
  ["src/app/fetch.py:10-12", `https://github.com/${REPO}/pull/1/files#diff-${anchor}R10-R12`],
  ["src/app/fetch.py", `https://github.com/${REPO}/pull/1/files#diff-${anchor}R42`]
]);
const old = `https://github.com/${REPO}/blob/${"a".repeat(40)}/src/app/fetch.py`;
check("stale report: lines open at the reviewed commit", await links(2), [
  ["src/app/fetch.py:42", `${old}#L42`],
  ["src/app/fetch.py:10-12", `${old}#L10-L12`],
  ["src/app/fetch.py", `${old}#L42`]
]);
check("no page errors", errors, []);

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nComments work.");
