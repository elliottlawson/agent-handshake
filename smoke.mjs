import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("http://localhost:5199/agent-handshake/", { waitUntil: "networkidle" });

  const title = await page.title();
  const hasTitle = await page.locator("h1.title").textContent().catch(() => null);
  const cols = await page.locator(".column").count();
  const scenarioOptions = await page.locator(".scenario-select option").allTextContents();
  const budgetNote = await page.locator(".empty").textContent().catch(() => null);

  // select each scenario and check the dataset card renders
  const datasetCards = [];
  for (let i = 0; i < 4; i++) {
    await page.locator(".scenario-select").selectOption({ index: i });
    const info = await page.locator(".dataset-info").textContent();
    datasetCards.push(info ? info.split("\n")[0] : "<empty>");
  }

  console.log(JSON.stringify({ title, hasTitle, cols, scenarioOptions, budgetNote, datasetCards, errors }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error("SMOKE FAIL", e);
  process.exit(1);
});