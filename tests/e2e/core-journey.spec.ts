import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
}

async function confirmCommand(page: Page, reason: string) {
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await page.getByTestId("reason-note").fill(reason);
  await page.getByTestId("confirm-command").click();
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("EXECUTED");
  await expect(receipt).toContainText("业务写入已提交");
}

async function closeReceipt(page: Page) {
  await page.getByRole("button", { name: "完成" }).click();
  await expect(page.getByTestId("command-receipt")).toBeHidden();
}

async function chooseDatesAndUnit(page: Page, unitCode: string, departureDate: string, arrivalDate = "2026-07-21") {
  await page.getByTestId("arrival-date").fill(arrivalDate);
  await page.getByTestId("departure-date").fill(departureDate);
  await expect(page.getByTestId(`quote-unit-${unitCode}`)).toBeEnabled();
  await page.getByTestId(`quote-unit-${unitCode}`).click();
}

async function createOrder(page: Page, options: { unitCode: string; guest: string; departureDate: string; arrivalDate?: string; transientMember?: boolean }) {
  await chooseDatesAndUnit(page, options.unitCode, options.departureDate, options.arrivalDate);
  if (options.transientMember) {
    await page.getByLabel("住宿类型").selectOption("TRANSIENT");
    await page.getByLabel("会员合同").selectOption("member_demo_contract");
  } else {
    await page.getByLabel("住宿类型").selectOption("FREE");
  }
  await page.getByTestId("request-quote").click();
  await expect(page.getByTestId("quote-result")).toBeVisible();
  await page.getByTestId("primary-guest-name").fill(options.guest);
  await page.getByTestId("create-order").click();
  await confirmCommand(page, `Create ${options.guest}`);
}

async function openFactFormAndSubmit(page: Page, actionName: "收款" | "退款", amountMinor: string) {
  await page.getByRole("button", { name: actionName, exact: true }).click();
  await page.getByTestId("fact-amount-minor").fill(amountMinor);
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
}

async function assertNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
}

async function assertNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
}

test("desktop core operating journey", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only journey");
  await login(page);
  await assertNoSeriousA11yViolations(page);
  await createOrder(page, { unitCode: "101", guest: "E2E Member Guest", departureDate: "2026-07-24", transientMember: true });
  const quoteReceipt = page.getByTestId("command-receipt");
  await expect(quoteReceipt).toContainText("order_");
  await page.getByRole("link", { name: /查看订单/ }).click();
  await expect(page.getByRole("heading", { name: "E2E Member Guest" })).toBeVisible();
  await expect(page.getByTestId("order-amounts")).toContainText("¥120.00");

  await openFactFormAndSubmit(page, "收款", "6000");
  await confirmCommand(page, "First recorded collection");
  await closeReceipt(page);
  await openFactFormAndSubmit(page, "收款", "6000");
  await confirmCommand(page, "Second recorded collection");
  await closeReceipt(page);

  await page.getByTestId("reprice-order").click();
  await page.getByTestId("reprice-adjustment-minor").fill("-1000");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "One revision manual adjustment");
  await closeReceipt(page);
  await expect(page.getByTestId("order-amounts")).toContainText("¥110.00");
  await expect(page.getByRole("region", { name: "计价修订" }).getByRole("row")).toHaveCount(3);

  await page.getByRole("button", { name: "缩短", exact: true }).click();
  await page.getByTestId("new-departure-date").fill("2026-07-23");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Guest leaves one night early");
  await closeReceipt(page);
  await expect(page.getByTestId("order-amounts")).toContainText("¥0.00");
  await expect(page.getByRole("region", { name: "计价修订" }).getByRole("row")).toHaveCount(4);

  await openFactFormAndSubmit(page, "退款", "3000");
  await confirmCommand(page, "Partial refund references first collection");
  await closeReceipt(page);
  await expect(page.getByRole("region", { name: "收退款事实" })).toContainText("REFUND");

  await page.getByTestId("check-in").click();
  await confirmCommand(page, "Guest identity and room checked");
  await closeReceipt(page);
  await expect(page.getByText("CHECKED IN", { exact: true })).toBeVisible();
  await page.getByTestId("check-out").click();
  await confirmCommand(page, "Guest departed and stay fulfilled");
  await closeReceipt(page);
  await expect(page.getByText("CHECKED OUT", { exact: true })).toBeVisible();
  await expect(page.getByTestId("order-amounts")).toContainText("¥90.00");
  await assertNoSeriousA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("desktop-order.png"), fullPage: true });
});

test("mobile today fulfillment journey", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only journey");
  await login(page);
  await createOrder(page, { unitCode: "102", guest: "Mobile Guest", departureDate: "2026-07-22" });
  await closeReceipt(page);
  await page.getByRole("link", { name: "移动履约" }).click();
  await page.getByLabel("营业日期").fill("2026-07-21");
  await page.getByRole("tab", { name: /今日到店/ }).click();
  await expect(page.getByText("Mobile Guest", { exact: true })).toBeVisible();
  await page.getByRole("article").filter({ hasText: "Mobile Guest" }).getByRole("button", { name: "入住", exact: true }).click();
  await confirmCommand(page, "Mobile arrival verification");
  await closeReceipt(page);
  await page.getByRole("tab", { name: /在住/ }).click();
  await expect(page.getByText("Mobile Guest", { exact: true })).toBeVisible();
  await page.getByRole("article").filter({ hasText: "Mobile Guest" }).getByRole("button", { name: "退房", exact: true }).click();
  await confirmCommand(page, "Mobile departure verification");
  await closeReceipt(page);
  await assertNoSeriousA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("mobile-today.png"), fullPage: true });
});

test("desktop stay changes and exception commands remain operable through Web", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only command coverage");
  await login(page);

  await createOrder(page, { unitCode: "101", guest: "E2E Change Guest", arrivalDate: "2026-09-10", departureDate: "2026-09-12" });
  await page.getByRole("link", { name: /查看订单/ }).click();
  await page.getByRole("button", { name: "续住", exact: true }).click();
  await page.getByTestId("new-departure-date").fill("2026-09-13");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Extend the locked-policy stay");
  await closeReceipt(page);
  await page.getByRole("button", { name: "换房", exact: true }).click();
  await page.getByTestId("move-unit-id").selectOption({ label: "102 · Room 102 · ROOM" });
  await page.getByTestId("move-effective-date").fill("2026-09-11");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Move to an available room under the locked policy");
  await closeReceipt(page);
  await expect(page.locator(".order-unit").getByText("102 · Room 102", { exact: true })).toBeVisible();

  await page.goto("/");
  await createOrder(page, { unitCode: "101", guest: "E2E Cancel Guest", arrivalDate: "2026-09-15", departureDate: "2026-09-16" });
  await page.getByRole("link", { name: /查看订单/ }).click();
  await page.getByRole("button", { name: "取消订单" }).click();
  await confirmCommand(page, "Cancel and release inventory");
  await closeReceipt(page);
  await expect(page.locator(".order-title-row").getByText("CANCELLED", { exact: true })).toBeVisible();

  await page.goto("/");
  await createOrder(page, { unitCode: "102", guest: "E2E No Show Guest", arrivalDate: "2026-09-15", departureDate: "2026-09-16" });
  await page.getByRole("link", { name: /查看订单/ }).click();
  await page.getByRole("button", { name: "标记未到" }).click();
  await confirmCommand(page, "Mark no-show and release inventory");
  await closeReceipt(page);
  await expect(page.locator(".order-title-row").getByText("NO SHOW", { exact: true })).toBeVisible();
  await assertNoSeriousA11yViolations(page);
});

test("desktop member entitlement adjustment and expiration use the shared command protocol", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only member operations");
  await login(page);
  await page.getByRole("link", { name: "会员" }).click();
  await expect(page.getByRole("heading", { name: "会员权益" })).toBeVisible();

  const roomLot = page.getByRole("row").filter({ hasText: "lot_demo_room_nights" });
  await roomLot.getByRole("button", { name: "调整", exact: true }).click();
  await page.getByLabel(/调整数量/).fill("1");
  await page.getByLabel("调整原因").fill("E2E entitlement correction");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Approve one room-night entitlement adjustment");
  await closeReceipt(page);
  await expect(page.getByRole("region", { name: "会员权益事实" })).toContainText("ADJUST");

  await roomLot.getByRole("button", { name: /到期权益 lot lot_demo_room_nights/ }).click();
  await expect(page.getByLabel("到期核算日期")).toHaveValue("2030-01-01");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Expire the remaining room-night entitlement");
  await closeReceipt(page);
  await expect(roomLot).toContainText("EXPIRED");
  await expect(page.getByRole("region", { name: "会员权益事实" })).toContainText("EXPIRE");
  await assertNoSeriousA11yViolations(page);
});

test("desktop quote command recovers the committed Quote after response loss", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only direct command recovery");
  await login(page);
  await chooseDatesAndUnit(page, "101", "2026-10-12", "2026-10-10");
  await page.getByLabel("住宿类型").selectOption("FREE");
  await page.route("**/api/v1/quotes", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });

  await page.getByTestId("request-quote").click();
  const recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText("报价命令结果待恢复");
  await recovery.getByRole("button", { name: "查询命令结果" }).click();
  await expect(page.getByTestId("quote-result")).toBeVisible();
  await expect(page.locator(".quote-expiry")).toContainText("quote_");
  await expect(page.locator(".quote-expiry")).toContainText("receipt_");
  await assertNoSeriousA11yViolations(page);
});

test("desktop quote workbench never applies a response for stale filter inputs", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only stale quote response");
  await login(page);
  await chooseDatesAndUnit(page, "101", "2026-10-15", "2026-10-13");
  await page.getByLabel("住宿类型").selectOption("FREE");

  let releaseRequest!: () => void;
  let reportIntercepted!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const intercepted = new Promise<void>((resolve) => { reportIntercepted = resolve; });
  await page.route("**/api/v1/quotes", async (route) => {
    reportIntercepted();
    await requestGate;
    await route.continue();
  }, { times: 1 });

  await page.getByTestId("request-quote").click();
  await intercepted;
  await page.getByTestId("departure-date").fill("2026-10-16");
  releaseRequest();
  await expect(page.getByText(/筛选条件在请求期间发生变化/)).toBeVisible();
  await expect(page.getByTestId("quote-result")).toBeHidden();
  await expect(page.getByTestId("request-quote")).toBeEnabled();
});

test("desktop Token lifecycle retains client secrets and uses Preview Confirm Receipt", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Token lifecycle");
  await login(page);
  await page.getByRole("link", { name: "Token" }).click();
  await expect(page.getByRole("heading", { name: "Token 生命周期" })).toBeVisible();

  await page.getByRole("button", { name: "签发 Token" }).click();
  await page.getByLabel("标签").fill("E2E external agent");
  await page.getByLabel("权限上限").selectOption("WRITE");
  const issueSecret = await page.getByLabel("一次性 Token secret").inputValue();
  expect(issueSecret).toMatch(/^qtp_[A-Za-z0-9_-]{43}$/);
  await page.getByLabel(/我已将一次性 secret 安全保存/).check();
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  const retainedIssueSecret = page.getByRole("region", { name: /尚未清除的一次性 secret/ });
  const issuePreviewIdempotencyKeys: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/command-previews") && request.method() === "POST") {
      issuePreviewIdempotencyKeys.push(request.headers()["idempotency-key"] ?? "");
    }
  });
  await page.route("**/api/v1/command-previews", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByTestId("create-command-preview").click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(retainedIssueSecret).toContainText("PREVIEW UNKNOWN");
  await expect(retainedIssueSecret.getByRole("button", { name: "清除本地 secret" })).toBeDisabled();
  await retainedIssueSecret.getByRole("button", { name: "重试 Preview" }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).not.toContainText(issueSecret);
  const previewId = (await retainedIssueSecret.locator(".retained-secret-meta dd code").filter({ hasText: /^preview_/ }).textContent())?.trim();
  expect(previewId).toMatch(/^preview_/);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(retainedIssueSecret).toContainText("PREVIEWED");
  await expect(retainedIssueSecret.getByLabel("一次性 Token secret")).toHaveValue(issueSecret);
  await expect(retainedIssueSecret.getByRole("button", { name: "清除本地 secret" })).toBeDisabled();
  await page.getByRole("link", { name: "订单" }).click();
  await page.getByRole("link", { name: "Token" }).click();
  await retainedIssueSecret.getByRole("button", { name: "重试 Preview" }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(retainedIssueSecret.locator(".retained-secret-meta dd code").filter({ hasText: /^preview_/ })).toHaveText(previewId!);
  expect(issuePreviewIdempotencyKeys.slice(0, 3)).toEqual([
    issuePreviewIdempotencyKeys[0],
    issuePreviewIdempotencyKeys[0],
    issuePreviewIdempotencyKeys[0]
  ]);
  await page.getByTestId("reason-note").fill("Issue a scoped external client credential");
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByText("执行状态需要恢复查询", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(retainedIssueSecret.getByLabel("一次性 Token secret")).toHaveValue(issueSecret);
  await expect(retainedIssueSecret).toContainText("UNKNOWN");
  await expect(retainedIssueSecret.getByRole("button", { name: "清除本地 secret" })).toBeDisabled();
  await page.getByRole("link", { name: "订单" }).click();
  await page.getByRole("link", { name: "Token" }).click();
  await expect(retainedIssueSecret.getByLabel("一次性 Token secret")).toHaveValue(issueSecret);
  await retainedIssueSecret.getByRole("button", { name: "恢复命令结果" }).click();
  await page.getByRole("button", { name: "查询命令结果" }).click();
  await expect(page.getByTestId("command-receipt")).toContainText("EXECUTED");
  await closeReceipt(page);
  await expect(retainedIssueSecret).toContainText("EXECUTED");

  let activeRow = page.getByRole("row").filter({ hasText: "E2E external agent" }).filter({ hasText: "ACTIVE" });
  await expect(activeRow).toHaveCount(1);
  const originalTokenId = (await activeRow.locator("code").first().textContent())?.trim();
  expect(originalTokenId).toMatch(/^token_/);
  await retainedIssueSecret.getByRole("button", { name: "清除本地 secret" }).click();

  await activeRow.getByRole("button", { name: "轮换", exact: true }).click();
  const rotationSecret = await page.getByLabel("一次性 Token secret").inputValue();
  expect(rotationSecret).toMatch(/^qtp_[A-Za-z0-9_-]{43}$/);
  expect(rotationSecret).not.toBe(issueSecret);
  await page.getByLabel(/我已将一次性 secret 安全保存/).check();
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).not.toContainText(rotationSecret);
  await page.getByTestId("reason-note").fill("Rotate the external client credential");
  await page.getByTestId("confirm-command").click();
  await expect(page.getByTestId("command-receipt")).toContainText("EXECUTED");
  await closeReceipt(page);

  const originalRow = page.getByRole("row").filter({ has: page.locator("th code", { hasText: originalTokenId! }) });
  await expect(originalRow).toContainText("ROTATED");
  activeRow = page.getByRole("row").filter({ hasText: "E2E external agent" }).filter({ hasText: "ACTIVE" });
  await expect(activeRow).toHaveCount(1);
  const replacementTokenId = (await activeRow.locator("code").first().textContent())?.trim();
  expect(replacementTokenId).toMatch(/^token_/);
  expect(replacementTokenId).not.toBe(originalTokenId);
  await expect(originalRow).toContainText(replacementTokenId!);
  await page.getByRole("region", { name: /尚未清除的一次性 secret/ }).getByRole("button", { name: "清除本地 secret" }).click();

  await activeRow.getByRole("button", { name: `撤销 Token ${replacementTokenId}` }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await page.getByTestId("reason-note").fill("Revoke the rotated external client credential");
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByText("执行状态需要恢复查询", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const pendingRevoke = page.getByRole("region", { name: "待处理 Token 命令" });
  await expect(pendingRevoke).toContainText("UNKNOWN");
  await pendingRevoke.getByRole("button", { name: "恢复命令结果" }).click();
  await page.getByRole("button", { name: "查询命令结果" }).click();
  await expect(page.getByTestId("command-receipt")).toContainText("EXECUTED");
  await closeReceipt(page);
  await expect(page.getByRole("row").filter({ has: page.locator("th code", { hasText: replacementTokenId! }) })).toContainText("REVOKED");
  await assertNoSeriousA11yViolations(page);
  await page.screenshot({ path: testInfo.outputPath("token-lifecycle.png"), fullPage: true });
});

test("keyboard focus reaches the operational workspace", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard assertion");
  await page.goto("/");
  await expect(page.getByTestId("login-username")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("login-password")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("login-submit")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  expect(focused).not.toBe("BODY");
});

test("mobile shell stays contiguous without page overflow", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "single-browser responsive assertion");
  await login(page);

  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: "今日履约" })).toBeVisible();
    await assertNoPageOverflow(page);

    const shell = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
      const header = document.querySelector<HTMLElement>(".workspace-header")?.getBoundingClientRect();
      return { sidebarBottom: sidebar?.bottom ?? -1, headerTop: header?.top ?? -1 };
    });
    expect(shell.headerTop, `workspace header at ${width}px`).toBeGreaterThanOrEqual(shell.sidebarBottom - 1);
    expect(shell.headerTop, `workspace header at ${width}px`).toBeLessThanOrEqual(shell.sidebarBottom + 1);

    await page.goto("/tokens");
    await expect(page.getByRole("heading", { name: "Token 生命周期" })).toBeVisible();
    await assertNoPageOverflow(page);
  }
});

test("property timezone controls default operating dates across local midnight", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "single-browser timezone assertion");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
  await page.clock.install({ time: new Date("2026-07-20T16:30:00.000Z") });
  await login(page);

  const browserLocalDate = await page.evaluate(() => {
    const values = new Map(new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
  });
  expect(browserLocalDate).toBe("2026-07-20");
  await expect(page.getByTestId("arrival-date")).toHaveValue("2026-07-22");
  await expect(page.getByTestId("departure-date")).toHaveValue("2026-07-23");

  await page.getByRole("link", { name: "移动履约" }).click();
  await expect(page.getByLabel("营业日期")).toHaveValue("2026-07-21");
});

test("maintenance lock can be listed and released", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop maintenance journey");
  await login(page);
  await page.getByTestId("arrival-date").fill("2026-08-10");
  await page.getByTestId("departure-date").fill("2026-08-11");
  await expect(page.getByTestId("quote-unit-102")).toBeEnabled();

  await page.getByRole("button", { name: "维修锁房 102" }).click();
  await page.getByLabel("维修原因").fill("E2E air conditioner service");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Maintenance window approved");
  await closeReceipt(page);

  const locks = page.getByTestId("maintenance-locks");
  const lockRow = locks.getByRole("row").filter({ hasText: "E2E air conditioner service" });
  await expect(lockRow).toBeVisible();
  await expect(page.getByTestId("quote-unit-102")).toBeDisabled();
  await lockRow.getByRole("button", { name: "释放维修锁 102" }).click();
  await confirmCommand(page, "Maintenance work completed");
  await closeReceipt(page);

  await expect(locks).not.toContainText("E2E air conditioner service");
  await expect(page.getByTestId("quote-unit-102")).toBeEnabled();
  await assertNoSeriousA11yViolations(page);
});
