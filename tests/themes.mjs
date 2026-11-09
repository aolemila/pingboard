/* Themes: the saved choice applies on load (and before sign-in), Settings previews
   a choice and Cancel puts the saved one back, and every theme defines every color.

   The GitHub API is mocked, so no token or network is needed.

   usage: bun themes.mjs --head <dir> [--base <dir>]   (--base is ignored) */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "http://pingboard.test";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const LOGIN = "pingboard-tester";
const TOKENS = ["--bg", "--panel", "--panel-soft", "--line", "--line-strong", "--text", "--muted", "--quiet", "--accent", "--accent-soft",
  "--good", "--bad", "--warn", "--todo", "--running", "--merged", "--follow", "--focus", "--on-accent"];

const at = process.argv.indexOf("--head");
if (at === -1) throw new Error("usage: bun themes.mjs --head <dir>");
const head = path.resolve(process.argv[at + 1]);

function mockGitHub(request) {
  const url = new URL(request.url());
  if (url.pathname === "/user") return { login: LOGIN };
  if (url.pathname !== "/graphql") return [];
  return { data: { search: { issueCount: 0, nodes: [] }, repository: { object: null, ref: null } } };
}

const failures = [];
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return console.log(`  ok   ${label}`);
  failures.push(label);
  console.log(`  FAIL ${label}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
}

const browser = await chromium.launch();

async function session(storage, colorScheme = "light") {
  const context = await browser.newContext({ colorScheme });
  await context.route("**/*", (route) => route.abort());
  await context.route("https://api.github.com/**", (route) => route.fulfill({ json: mockGitHub(route.request()), headers: { "access-control-allow-origin": "*" } }));
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
  await page.evaluate((entries) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  }, storage);
  await page.goto(`${ORIGIN}/`);
  return { context, page, errors };
}

const signedIn = (prefs) => ({ "pingboard.githubToken": "test-token", [`pingboard.v3.${LOGIN}.prefs`]: prefs });
// Signed in and the board shell is on the page (it renders on the next frame), so shortcuts have somewhere to open.
const waitForUser = (page) => page.waitForFunction(() => typeof state !== "undefined" && Boolean(state.user) && Boolean(document.querySelector("#modal")), null, { timeout: 15000 });
const themeOf = (page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);
const bodyBg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

console.log("\nsaved theme");
{
  const { context, page, errors } = await session(signedIn({ theme: "dark-dimmed" }));
  await waitForUser(page);
  check("applies the theme from the user's preferences", await themeOf(page), "dark-dimmed");
  check("remembers it for the sign-in screen", await page.evaluate(() => localStorage.getItem("pingboard.theme")), "dark-dimmed");
  check("no page errors", errors, []);
  await context.close();
}
{
  const { context, page } = await session(signedIn({ theme: "no-such-theme" }));
  await waitForUser(page);
  check("an unknown theme falls back to the system", await themeOf(page), null);
  await context.close();
}
{
  const { context, page } = await session({ "pingboard.theme": "light-high-contrast" });
  await page.waitForSelector("#token");
  check("the sign-in screen uses the last theme", await themeOf(page), "light-high-contrast");
  await context.close();
}
{
  const light = await session({}, "light");
  const dark = await session({}, "dark");
  await light.page.waitForSelector("#token");
  await dark.page.waitForSelector("#token");
  check("system theme follows the OS (light and dark differ)", (await bodyBg(light.page)) !== (await bodyBg(dark.page)), true);
  await light.context.close();
  await dark.context.close();
}

console.log("\nsettings");
{
  const { context, page, errors } = await session(signedIn({}));
  await waitForUser(page);
  const select = () => page.locator(".settings-modal select").filter({ has: page.locator('option[value="dark-dimmed"]') });
  await page.keyboard.press(",");
  await select().selectOption("dark-high-contrast");
  check("choosing a theme previews it at once", await themeOf(page), "dark-high-contrast");
  await page.keyboard.press("Escape");
  check("cancelling puts the saved theme back", await themeOf(page), null);
  await page.keyboard.press(",");
  await select().selectOption("light-tritanopia");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  check("saving keeps it", await themeOf(page), "light-tritanopia");
  check("and stores it in the preferences", await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).theme, `pingboard.v3.${LOGIN}.prefs`), "light-tritanopia");
  await page.reload();
  await waitForUser(page);
  check("and it survives a reload", await themeOf(page), "light-tritanopia");
  check("no page errors", errors, []);
  await context.close();
}

console.log("\nevery theme defines every color");
{
  const { context, page } = await session({});
  await page.waitForSelector("#token");
  const ids = await page.evaluate(() => THEMES.map((theme) => theme.id).filter((id) => id !== "system"));
  check("nine themes besides Sync with system", ids.length, 9);
  for (const id of ids) {
    const missing = await page.evaluate(([id, tokens]) => {
      document.documentElement.dataset.theme = id;
      const style = getComputedStyle(document.documentElement);
      return tokens.filter((token) => !style.getPropertyValue(token).trim());
    }, [id, TOKENS]);
    check(`${id}: all tokens set`, missing, []);
  }
  await context.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} theme check(s) failed.`);
  process.exit(1);
}
console.log("\nThemes work.");
