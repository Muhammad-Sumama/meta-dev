import { expect, test } from "@playwright/test";

test("landing page explains the product and its independence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("OpenSAM Studio");
  await expect(page.getByText("Rotoscoping, powered by AI.")).toBeVisible();
  await expect(page.getByText(/not affiliated with, endorsed by, or sponsored by Meta/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Start Creating/ }).first()).toBeVisible();
});

test("demo: AI command → tracking → effect preview → export", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try Demo" }).first().click();
  await page.waitForURL(/\/editor\/prj_/);
  await expect(page.getByText("Mock AI")).toBeVisible();

  // Natural-language command via suggestion.
  await page.getByRole("button", { name: "Track the red car" }).click();
  await expect(page.getByRole("button", { name: /Red car: AI tracked/ })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Show structured command")).toBeVisible();

  // Effect on the selected object.
  const input = page.getByLabel("What do you want to isolate?");
  await input.fill("Remove the background");
  await input.press("Enter");
  await expect(page.getByLabel("Effect preview")).toBeVisible();

  // Keyboard shortcuts + undo.
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("b");
  await expect(page.getByRole("radio", { name: "Brush tool (B)" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Current timecode")).toHaveText("00:00:00:01");
  await page.keyboard.press("Control+z");
  await expect(page.getByText(/^Undo:/)).toBeVisible();

  // Export a PNG sequence and download it.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("tab", { name: /PNG Sequence/ }).click();
  await page.getByRole("button", { name: /Export png sequence/i }).click();
  await expect(page.getByText("Export ready")).toBeVisible({ timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: /Download/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/png-sequence\.zip$/);
});

test("every button in the editor has an accessible name", async ({ page, request }) => {
  const res = await request.post("/api/projects/demo");
  const { project } = await res.json();
  await page.goto(`/editor/${project.id}`);
  await expect(page.getByRole("application")).toBeVisible();
  const unnamed = await page.locator("button").evaluateAll((els) =>
    els.filter((b) => !(b.getAttribute("aria-label") || b.textContent?.trim() || b.getAttribute("title"))).map((b) => b.outerHTML.slice(0, 120)),
  );
  expect(unnamed).toEqual([]);
});
