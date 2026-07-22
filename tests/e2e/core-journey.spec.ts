import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { todayInTimeZone } from "@qintopia/domain";

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
}

async function confirmCommand(page: Page, reason: string, expectedFactTexts: string[] = []) {
  const previewButton = page.getByTestId("create-command-preview");
  await expect(previewButton).toBeEnabled({ timeout: 15_000 });
  await previewButton.click();
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 15_000 });
  for (const text of expectedFactTexts) await expect(effect).toContainText(text);
  await page.getByTestId("reason-note").fill(reason);
  const confirmButton = page.getByTestId("confirm-command");
  await expect(confirmButton).toBeEnabled({ timeout: 15_000 });
  await confirmButton.click();
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("EXECUTED");
  await expect(receipt).toContainText("业务写入已提交");
  for (const text of expectedFactTexts) await expect(receipt).toContainText(text);
}

async function closeReceipt(page: Page) {
  await page.getByRole("button", { name: "完成" }).click();
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  if (/\/orders\/order_[^/?#]+$/.test(new URL(page.url()).pathname)) {
    await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 15_000 });
  }
}

async function selectRoomStatusRange(
  page: Page,
  unitCode: string,
  departureDate: string,
  arrivalDate = "2026-07-21"
): Promise<string> {
  await page.getByTestId("arrival-date").fill(arrivalDate);
  await page.getByTestId("departure-date").fill(departureDate);
  if ((page.viewportSize()?.width ?? 0) < 576) {
    const mobileCreate = page.getByRole("button", { name: "新建住宿或库存 Block", exact: true });
    await expect(mobileCreate).toBeVisible();
    await mobileCreate.click();
    await expect(page.getByRole("dialog", { name: "新建住宿或库存 Block" })).toBeVisible();
  }
  const unitSelect = page.getByTestId("room-status-unit-select");
  const unitId = `unit_room_${unitCode.toLowerCase()}`;
  await unitSelect.selectOption(unitId);
  await expect(unitSelect).toHaveValue(unitId);
  await page.getByLabel("入住日期", { exact: true }).fill(arrivalDate);
  await page.getByLabel("退房日期", { exact: true }).fill(departureDate);
  await page.getByRole("button", { name: "应用选区", exact: true }).click();
  return unitId;
}

async function chooseDatesAndUnit(
  page: Page,
  unitCode: string,
  departureDate: string,
  arrivalDate = "2026-07-21",
  action: "NORMAL" | "FREE" = "NORMAL"
) {
  await selectRoomStatusRange(page, unitCode, departureDate, arrivalDate);
  const actionName = action === "FREE" ? "创建免费入住" : "创建正常住宿订单";
  const actionButton = page.getByRole("button", { name: actionName, exact: true });
  await expect(actionButton).toBeEnabled();
  await actionButton.click();
  await expect(page.getByRole("heading", { name: "报价工作区", exact: true })).toBeVisible();
}

async function createOrder(page: Page, options: {
  unitCode: string;
  guest: string;
  nickname?: string;
  departureDate: string;
  arrivalDate?: string;
  transientMember?: boolean;
  memberIdentityCardNumber?: string;
  expectedCoverageNights?: number;
  expectedQuoteAmount?: string;
  freeStayReason?: string;
  bookingChannelCode?: "YOUMUDAO" | "CTRIP" | "MEITUAN" | "WECOM";
  channelOrderReference?: string;
}) {
  const memberIdentityCardNumber = options.memberIdentityCardNumber
    ?? (options.transientMember ? "DEMO-ID-310000199001010001" : undefined);
  await chooseDatesAndUnit(
    page,
    options.unitCode,
    options.departureDate,
    options.arrivalDate,
    memberIdentityCardNumber ? "NORMAL" : "FREE"
  );
  if (memberIdentityCardNumber) {
    await page.getByLabel("住宿类型").selectOption("TRANSIENT");
    await page.getByLabel("计价政策版本").selectOption("policy_qintopia_public_2026_rev561_v1");
    await page.getByTestId("member-search").fill(memberIdentityCardNumber);
    const contractSelect = page.getByLabel("会员合同");
    const memberOption = contractSelect.locator("option").filter({ hasText: memberIdentityCardNumber });
    await expect(memberOption).toHaveCount(1);
    const memberContractId = await memberOption.getAttribute("value");
    expect(memberContractId).toBeTruthy();
    await contractSelect.selectOption(memberContractId!);
  } else {
    await page.getByLabel("住宿类型").selectOption("FREE");
    await page.getByLabel("计价政策版本").selectOption("policy_free_v1");
  }
  await page.getByTestId("request-quote").click();
  const quoteResult = page.getByTestId("quote-result");
  await expect(quoteResult).toBeVisible();
  if (memberIdentityCardNumber) {
    await expect(quoteResult).toContainText("policy_qintopia_public_2026_rev561_v1");
  }
  if (options.expectedCoverageNights !== undefined) {
    await expect(quoteResult.getByRole("heading", { name: "coverageSet" }).locator("..")).toContainText(`${options.expectedCoverageNights} 晚`);
  }
  if (options.expectedQuoteAmount) {
    await expect(quoteResult.locator(".quote-amounts")).toContainText(options.expectedQuoteAmount);
  }
  await page.getByTestId("primary-guest-name").fill(options.guest);
  if (!memberIdentityCardNumber) {
    await page.getByTestId("free-stay-reason").fill(options.freeStayReason ?? `Automated FREE stay fixture: ${options.guest}`);
  }
  const bookingChannelCode = options.bookingChannelCode ?? "YOUMUDAO";
  const channelSelect = page.getByTestId("booking-channel-code");
  await expect(channelSelect).toHaveValue("");
  await expect(page.getByTestId("create-order")).toBeDisabled();
  await channelSelect.selectOption(bookingChannelCode);
  if (bookingChannelCode === "WECOM") {
    await expect(page.getByTestId("channel-order-reference")).toHaveCount(0);
  } else {
    await page.getByTestId("channel-order-reference").fill(options.channelOrderReference ?? `TEST-E2E-ORDER-${options.guest.replaceAll(" ", "-")}`);
  }
  const nickname = options.nickname ?? options.guest;
  await expect(page.getByTestId("create-order")).toBeDisabled();
  await page.getByTestId("primary-guest-nickname").fill(nickname);
  await page.getByTestId("create-order").click();
  const channelLabel = { YOUMUDAO: "游牧岛", CTRIP: "携程", MEITUAN: "美团", WECOM: "企业微信" }[bookingChannelCode];
  await confirmCommand(page, `Create ${options.guest}`, [nickname, channelLabel, bookingChannelCode === "WECOM" ? "不适用" : options.channelOrderReference ?? `TEST-E2E-ORDER-${options.guest.replaceAll(" ", "-")}`]);
}

async function openFactFormAndSubmit(
  page: Page,
  actionName: "收款" | "退款",
  amountMinor: string,
  transactionReference: string,
  expectedInitialAmountMinor = ""
) {
  await page.getByRole("button", { name: actionName, exact: true }).click();
  const amountInput = page.getByTestId("fact-amount-minor");
  const continueButton = page.getByRole("button", { name: "继续生成 Preview" });
  await expect(amountInput).toHaveValue(expectedInitialAmountMinor);
  if (!expectedInitialAmountMinor) {
    await continueButton.click();
    await expect(amountInput).toBeFocused();
    expect(await amountInput.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);
  }
  await amountInput.fill(amountMinor);
  const transactionInput = page.getByTestId("transaction-reference");
  await continueButton.click();
  await expect(transactionInput).toBeFocused();
  expect(await transactionInput.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);
  await transactionInput.fill(transactionReference);
  await continueButton.click();
}

async function submitMemberRegistration(page: Page, options: {
  fullName: string;
  identityCardNumber: string;
  phone: string;
  wechat: string;
  validFrom: string;
  validUntil: string;
  sourceApplicationRecordId: string;
}) {
  await page.getByTestId("create-member").click();
  await page.getByTestId("member-full-name").fill(options.fullName);
  await page.getByTestId("member-identity-card").fill(options.identityCardNumber);
  await page.getByLabel("手机号").fill(options.phone);
  await page.getByLabel("微信号").fill(options.wechat);
  await page.getByLabel("初始合同开始日").fill(options.validFrom);
  await page.getByLabel("初始合同结束日").fill(options.validUntil);
  await page.getByTestId("member-source-record").fill(options.sourceApplicationRecordId);
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
}

async function assertNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .options({ resultTypes: ["violations"] })
    .analyze();
  expect(results.violations).toEqual([]);
}

async function assertNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
}

async function tabTo(page: Page, target: Locator, options: { reverse?: boolean; limit?: number } = {}) {
  await expect(target).toBeVisible({ timeout: 5_000 });
  const key = options.reverse ? "Shift+Tab" : "Tab";
  for (let index = 0; index < (options.limit ?? 60); index += 1) {
    if (await target.evaluate((element) => document.activeElement === element)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

async function assertShellDoesNotOverlap(page: Page, width: number) {
  const shell = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".workspace-header")?.getBoundingClientRect();
    return {
      sidebarBottom: sidebar?.bottom ?? -1,
      sidebarRight: sidebar?.right ?? -1,
      headerTop: header?.top ?? -1,
      headerLeft: header?.left ?? -1
    };
  });
  if (width <= 860) {
    expect(shell.headerTop, `workspace header top at ${width}px`).toBeGreaterThanOrEqual(shell.sidebarBottom - 1);
    expect(shell.headerTop, `workspace header top at ${width}px`).toBeLessThanOrEqual(shell.sidebarBottom + 1);
  } else {
    expect(shell.headerLeft, `workspace header left at ${width}px`).toBeGreaterThanOrEqual(shell.sidebarRight - 1);
    expect(shell.headerLeft, `workspace header left at ${width}px`).toBeLessThanOrEqual(shell.sidebarRight + 1);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function installConfirmResponseDrainProbe(page: Page) {
  await page.evaluate(() => {
    const testWindow = window as typeof window & { __confirmResponseDrained: number };
    testWindow.__confirmResponseDrained = 0;
    const originalJson = Response.prototype.json;
    Response.prototype.json = async function json() {
      const body = await originalJson.call(this);
      if (/\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(this.url).pathname)) {
        setTimeout(() => { testWindow.__confirmResponseDrained += 1; }, 0);
      }
      return body;
    };
  });
}

async function confirmResponseDrainCount(page: Page) {
  return page.evaluate(() => (window as typeof window & { __confirmResponseDrained: number }).__confirmResponseDrained);
}

async function deferNextConfirmResponse(page: Page, delivery: "ORIGINAL" | "SERVER_ERROR" = "ORIGINAL") {
  const fetched = deferred();
  const release = deferred();
  const fulfilled = deferred();
  const requestFinished = deferred();
  let interceptedUrl = "";
  let confirmationKey = "";
  page.on("requestfinished", (request) => {
    if (request.url() === interceptedUrl && request.headers()["idempotency-key"] === confirmationKey) requestFinished.resolve();
  });
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    interceptedUrl = route.request().url();
    confirmationKey = route.request().headers()["idempotency-key"] ?? "";
    const response = await route.fetch();
    fetched.resolve();
    await release.promise;
    if (delivery === "ORIGINAL") {
      await route.fulfill({ response });
    } else {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "REQUEST_FAILED", message: "Deferred response failed in transit", retryable: true })
      });
    }
    fulfilled.resolve();
  }, { times: 1 });
  return {
    fetched: fetched.promise,
    release: release.resolve,
    fulfilled: fulfilled.promise,
    requestFinished: requestFinished.promise,
    confirmationKey: () => confirmationKey
  };
}

async function deferNextQuoteResponse(page: Page) {
  const fetched = deferred();
  const release = deferred();
  const fulfilled = deferred();
  const requestFinished = deferred();
  let interceptedUrl = "";
  let idempotencyKey = "";
  page.on("requestfinished", (request) => {
    if (request.url() === interceptedUrl && request.headers()["idempotency-key"] === idempotencyKey) requestFinished.resolve();
  });
  await page.route("**/api/v1/quotes", async (route) => {
    interceptedUrl = route.request().url();
    idempotencyKey = route.request().headers()["idempotency-key"] ?? "";
    const response = await route.fetch();
    fetched.resolve();
    await release.promise;
    await route.fulfill({ response });
    fulfilled.resolve();
  }, { times: 1 });
  return {
    fetched: fetched.promise,
    release: release.resolve,
    fulfilled: fulfilled.promise,
    requestFinished: requestFinished.promise,
    idempotencyKey: () => idempotencyKey
  };
}

async function releaseQuoteAndFlushOldCallback(
  page: Page,
  delayed: Awaited<ReturnType<typeof deferNextQuoteResponse>>
) {
  delayed.release();
  await Promise.all([delayed.fulfilled, delayed.requestFinished]);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function forceNavigateAwayAndBackToTokens(page: Page) {
  await page.evaluate(() => {
    history.pushState({}, "", "/orders");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, "", "/tokens");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  await expect(page.getByRole("heading", { name: "Token 生命周期" })).toBeVisible();
  await expect(page.getByText("正在载入 Token", { exact: true })).toBeHidden();
}

async function releaseConfirmAndFlushOldCallback(
  page: Page,
  delayed: Awaited<ReturnType<typeof deferNextConfirmResponse>>,
  previousDrainCount: number
) {
  delayed.release();
  await Promise.all([delayed.fulfilled, delayed.requestFinished]);
  await page.waitForFunction((expected) => (
    (window as typeof window & { __confirmResponseDrained: number }).__confirmResponseDrained === expected
  ), previousDrainCount + 1);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  }));
}

test("desktop logout distinguishes an unexecuted failure from a lost committed response", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only session failure coverage");
  await login(page);
  await page.route("**/api/v1/auth/logout", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "SERVICE_NOT_READY",
        message: "Logout service is temporarily unavailable",
        correlationId: "e2e-logout-failure",
        retryable: true
      })
    });
  }, { times: 1 });

  await page.getByRole("button", { name: "退出登录" }).click();
  const failure = page.getByTestId("logout-error");
  await expect(failure).toBeFocused();
  await expect(failure).toContainText("退出未完成，会话仍保持登录");
  await expect(page.getByTestId("retry-logout")).toBeVisible();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeHidden();

  await page.reload();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeHidden();
  await assertNoA11yViolations(page);

  await page.route("**/api/v1/auth/logout", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByTestId("logout-error")).toBeHidden();
});

test("desktop session bootstrap exposes a focused retryable service failure", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only session bootstrap coverage");
  await login(page);
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "SERVICE_NOT_READY",
        message: "Session lookup is temporarily unavailable",
        correlationId: "e2e-session-bootstrap",
        retryable: true
      })
    });
  });

  await page.reload();
  const failure = page.getByTestId("session-startup-error");
  await expect(failure).toBeFocused();
  await expect(failure).toContainText("无法确认登录状态");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeHidden();
  await assertNoA11yViolations(page);

  await page.unroute("**/api/v1/me");
  await page.getByTestId("session-startup-error-retry").click();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
});

test("desktop core operating journey", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only journey");
  await login(page);
  await assertNoA11yViolations(page);
  await createOrder(page, {
    unitCode: "101",
    guest: "E2E Member Guest",
    nickname: "风铃",
    departureDate: "2026-07-24",
    transientMember: true,
    expectedCoverageNights: 2,
    expectedQuoteAmount: "¥232.00",
    bookingChannelCode: "CTRIP",
    channelOrderReference: "TEST-E2E-CTRIP-001"
  });
  const quoteReceipt = page.getByTestId("command-receipt");
  await expect(quoteReceipt).toContainText("order_");
  await expect(quoteReceipt).toContainText("风铃");
  await page.getByRole("link", { name: /查看订单/ }).click();
  await expect(page).toHaveURL(/\/orders\/order_[^/?#]+$/, { timeout: 15_000 });
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "风铃" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("携程", { exact: true })).toBeVisible();
  await expect(page.getByText("TEST-E2E-CTRIP-001", { exact: true })).toBeVisible();
  await expect(page.getByTestId("order-amounts")).toContainText("¥232.00");
  const coverageRegion = page.getByRole("region", { name: "会员覆盖" });
  await expect(coverageRegion.getByRole("columnheader", { name: "Coverage ID" })).toBeVisible();
  await expect(coverageRegion.getByText("HELD", { exact: true })).toHaveCount(2);
  await expect(coverageRegion.getByText("CONSUMED", { exact: true })).toHaveCount(0);

  await openFactFormAndSubmit(page, "收款", "6000", "TEST-E2E-TXN-COLLECTION-001");
  await confirmCommand(page, "First recorded collection", ["TEST-E2E-TXN-COLLECTION-001"]);
  await closeReceipt(page);
  await openFactFormAndSubmit(page, "收款", "6000", "TEST-E2E-TXN-COLLECTION-002");
  await confirmCommand(page, "Second recorded collection", ["TEST-E2E-TXN-COLLECTION-002"]);
  await closeReceipt(page);

  await page.getByTestId("reprice-order").click();
  await page.getByTestId("reprice-target-yuan").fill("110");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("preview-policy-base-amount")).toHaveText("¥232.00");
  await expect(page.getByTestId("preview-target-contract-amount")).toHaveText("¥110.00");
  await expect(page.getByTestId("preview-manual-adjustment")).toHaveText("-¥122.00");
  await page.getByTestId("reason-note").fill("Set this revision final total to CNY 110");
  await page.getByTestId("confirm-command").click();
  const repriceReceipt = page.getByTestId("command-receipt");
  await expect(repriceReceipt).toContainText("EXECUTED");
  await expect(page.getByTestId("receipt-policy-base-amount")).toHaveText("¥232.00");
  await expect(page.getByTestId("receipt-target-contract-amount")).toHaveText("¥110.00");
  await expect(page.getByTestId("receipt-manual-adjustment")).toHaveText("-¥122.00");
  await closeReceipt(page);
  await expect(page.getByTestId("order-amounts")).toContainText("¥110.00");
  const revisionRegion = page.getByRole("region", { name: "计价修订" });
  await expect(revisionRegion.getByRole("row")).toHaveCount(3);
  const manualRevision = revisionRegion.getByRole("row").filter({ hasText: "#2" });
  await expect(manualRevision.locator("td").nth(3)).toHaveText("¥232.00");
  await expect(manualRevision.locator("td").nth(4)).toHaveText("-¥122.00");
  await expect(manualRevision.locator("td").nth(5)).toHaveText("¥110.00");

  await page.getByRole("button", { name: "缩短", exact: true }).click();
  await page.getByTestId("new-departure-date").fill("2026-07-23");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Guest leaves one night early");
  await closeReceipt(page);
  await expect(page.getByTestId("order-amounts")).toContainText("¥0.00");
  await expect(revisionRegion.getByRole("row")).toHaveCount(4);
  const shortenedRevision = revisionRegion.getByRole("row").filter({ hasText: "#3" });
  await expect(shortenedRevision.locator("td").nth(3)).toHaveText("¥0.00");
  await expect(shortenedRevision.locator("td").nth(4)).toHaveText("¥0.00");
  await expect(shortenedRevision.locator("td").nth(5)).toHaveText("¥0.00");

  await openFactFormAndSubmit(page, "退款", "3000", "TEST-E2E-TXN-REFUND-001", "6000");
  await confirmCommand(page, "Partial refund references first collection", ["TEST-E2E-TXN-REFUND-001"]);
  await closeReceipt(page);
  await expect(page.getByRole("region", { name: "收退款事实" })).toContainText("REFUND");
  await expect(page.getByRole("region", { name: "收退款事实" })).toContainText("TEST-E2E-TXN-COLLECTION-001");
  await expect(page.getByRole("region", { name: "收退款事实" })).toContainText("TEST-E2E-TXN-COLLECTION-002");
  await expect(page.getByRole("region", { name: "收退款事实" })).toContainText("TEST-E2E-TXN-REFUND-001");

  await page.getByTestId("check-in").click();
  await page.getByTestId("create-command-preview").click();
  const checkInEffect = page.getByTestId("command-effect");
  await expect(checkInEffect).toContainText("权益状态变化");
  await expect(checkInEffect).toContainText("HELD");
  await expect(checkInEffect).toContainText("CONSUMED");
  await expect(checkInEffect).toContainText("2 晚");
  await page.getByTestId("reason-note").fill("Guest identity and room checked");
  await page.getByTestId("confirm-command").click();
  const checkInReceipt = page.getByTestId("command-receipt");
  await expect(checkInReceipt).toContainText("EXECUTED");
  await expect(checkInReceipt.locator("dt").filter({ hasText: "事实引用" }).locator("xpath=following-sibling::dd[1]").locator("code")).toHaveCount(2);
  await closeReceipt(page);
  await expect(page.getByText("CHECKED IN", { exact: true })).toBeVisible();
  await expect(coverageRegion.getByText("HELD", { exact: true })).toHaveCount(0);
  await expect(coverageRegion.getByText("CONSUMED", { exact: true })).toHaveCount(2);
  await page.getByTestId("check-out").click();
  await page.getByTestId("create-command-preview").click();
  const checkOutEffect = page.getByTestId("command-effect");
  await expect(checkOutEffect).toContainText("CHECKED_IN");
  await expect(checkOutEffect).toContainText("CHECKED_OUT");
  await expect(checkOutEffect).not.toContainText("权益状态变化");
  await page.getByTestId("reason-note").fill("Guest departed and stay fulfilled");
  await page.getByTestId("confirm-command").click();
  const checkOutReceipt = page.getByTestId("command-receipt");
  await expect(checkOutReceipt).toContainText("EXECUTED");
  await expect(checkOutReceipt.locator("dt").filter({ hasText: "事实引用" }).locator("xpath=following-sibling::dd[1]")).toHaveText("-");
  await closeReceipt(page);
  await expect(page.getByText("CHECKED OUT", { exact: true })).toBeVisible();
  await expect(coverageRegion.getByText("CONSUMED", { exact: true })).toHaveCount(2);
  await expect(page.getByTestId("order-amounts")).toContainText("¥90.00");
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("desktop-order.png"), fullPage: true });
});

test("mobile today fulfillment journey", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only journey");
  await login(page);
  await createOrder(page, { unitCode: "102", guest: "Mobile Guest", departureDate: "2026-07-22", bookingChannelCode: "WECOM" });
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
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("mobile-today.png"), fullPage: true });
});

test("desktop stay changes and exception commands remain operable through Web", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only command coverage");
  await login(page);

  await createOrder(page, { unitCode: "101", guest: "E2E Change Guest", arrivalDate: "2026-09-10", departureDate: "2026-09-12", bookingChannelCode: "MEITUAN", channelOrderReference: "TEST-E2E-MEITUAN-001" });
  await page.getByRole("link", { name: /查看订单/ }).click();
  await page.getByRole("button", { name: "续住", exact: true }).click();
  await page.getByTestId("new-departure-date").fill("2026-09-13");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Extend the locked-policy stay");
  await closeReceipt(page);
  await page.getByRole("button", { name: "换房", exact: true }).click();
  await page.getByTestId("move-unit-id").selectOption("unit_room_102");
  await page.getByTestId("move-effective-date").fill("2026-09-11");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Move to an available room under the locked policy");
  await closeReceipt(page);
  await expect(page.locator(".order-unit")).toContainText("102 · 102 · 四人间（公卫）");

  await page.goto("/");
  await createOrder(page, { unitCode: "101", guest: "E2E Cancel Guest", arrivalDate: "2026-09-15", departureDate: "2026-09-16", bookingChannelCode: "YOUMUDAO", channelOrderReference: "TEST-E2E-YOUMUDAO-001" });
  await page.getByRole("link", { name: /查看订单/ }).click();
  await page.getByRole("button", { name: "取消订单" }).click();
  await confirmCommand(page, "Cancel and release inventory");
  await closeReceipt(page);
  await expect(page.locator(".order-title-row").getByText("CANCELLED", { exact: true })).toBeVisible();

  await page.goto("/");
  await createOrder(page, { unitCode: "102", guest: "E2E No Show Guest", arrivalDate: "2026-09-15", departureDate: "2026-09-16", bookingChannelCode: "WECOM" });
  await page.getByRole("link", { name: /查看订单/ }).click();
  await page.getByRole("button", { name: "标记未到" }).click();
  await confirmCommand(page, "Mark no-show and release inventory");
  await closeReceipt(page);
  await expect(page.locator(".order-title-row").getByText("NO SHOW", { exact: true })).toBeVisible();
  await assertNoA11yViolations(page);
});

test("desktop member profile, Feishu application references, zero balance, and entitlement facts use the shared protocol", async ({ page }, testInfo: TestInfo) => {
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

  const expiredLot = page.getByRole("row").filter({ hasText: "lot_e2e_expired_room_nights" });
  await expiredLot.getByRole("button", { name: /到期权益 lot lot_e2e_expired_room_nights/ }).click();
  await expect(page.getByLabel("到期核算日期")).toHaveValue(todayInTimeZone("Asia/Shanghai"));
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Expire the remaining room-night entitlement");
  await closeReceipt(page);
  await expect(expiredLot).toContainText("EXPIRED");
  await expect(page.getByRole("region", { name: "会员权益事实" })).toContainText("EXPIRE");

  const memberProfile = {
    fullName: "E2E Member Profile",
    identityCardNumber: "E2E-ID-310000199202020002",
    phone: "13900001111",
    wechat: "qintopia-e2e-member",
    validFrom: "2026-02-25",
    validUntil: "2029-12-31",
    sourceApplicationRecordId: "recE2EStayApplication001"
  };
  await submitMemberRegistration(page, memberProfile);
  await page.getByTestId("create-command-preview").click();
  const createMemberEffect = page.getByTestId("command-effect");
  await expect(createMemberEffect).toContainText("CREATE_MEMBER_WITH_INITIAL_CONTRACT");
  await expect(createMemberEffect).toContainText(memberProfile.fullName);
  await expect(createMemberEffect).toContainText(memberProfile.identityCardNumber);
  await expect(createMemberEffect).toContainText(memberProfile.phone);
  await expect(createMemberEffect).toContainText(memberProfile.wechat);
  await expect(createMemberEffect).toContainText("CREATE_LINK");
  await expect(createMemberEffect).toContainText("FEISHU_BASE");
  await expect(createMemberEffect).toContainText(memberProfile.sourceApplicationRecordId);
  await page.getByTestId("reason-note").fill("Register member and link the first Feishu stay application");
  await page.getByTestId("confirm-command").click();

  let memberReceipt = page.getByTestId("command-receipt");
  await expect(memberReceipt).toContainText("EXECUTED");
  await expect(memberReceipt.locator("code").filter({ hasText: /^receipt_/ })).toHaveCount(1);
  await expect(memberReceipt.locator("code").filter({ hasText: /^command_/ })).toHaveCount(1);
  const memberId = (await memberReceipt.locator("code").filter({ hasText: /^member_/ }).first().textContent())?.trim();
  const memberContractId = (await memberReceipt.locator("code").filter({ hasText: /^contract_/ }).first().textContent())?.trim();
  const firstExternalReferenceId = (await memberReceipt.locator("code").filter({ hasText: /^memberref_/ }).first().textContent())?.trim();
  expect(memberId).toMatch(/^member_/);
  expect(memberContractId).toMatch(/^contract_/);
  expect(firstExternalReferenceId).toMatch(/^memberref_/);
  await closeReceipt(page);

  const memberSearch = page.getByRole("search", { name: "按身份证号搜索会员" });
  await page.getByTestId("member-identity-search").fill(memberProfile.identityCardNumber.toLowerCase());
  await memberSearch.getByRole("button", { name: "搜索" }).click();
  await expect(page.getByText("正在载入会员权益", { exact: true })).toBeHidden();
  const memberSelect = page.getByRole("combobox", { name: "会员", exact: true });
  await expect(memberSelect).toHaveValue(memberId!);
  await expect(memberSelect.locator("option")).toHaveCount(1);
  await expect(page.getByText(memberProfile.fullName, { exact: true })).toBeVisible();
  await expect(page.getByText(memberProfile.identityCardNumber, { exact: true })).toBeVisible();
  await expect(page.getByText(memberProfile.phone, { exact: true })).toBeVisible();
  await expect(page.getByText(memberProfile.wechat, { exact: true })).toBeVisible();
  const balanceSummary = page.getByRole("region", { name: "会员权益汇总" });
  await expect(balanceSummary.locator("div").filter({ hasText: "可用 ROOM_NIGHT" }).getByText("0", { exact: true })).toBeVisible();
  await expect(balanceSummary.locator("div").filter({ hasText: "可用 BED_NIGHT" }).getByText("0", { exact: true })).toBeVisible();
  await expect(page.getByText(memberProfile.sourceApplicationRecordId, { exact: true })).toBeVisible();

  const secondApplicationRecordId = "recE2EStayApplication002";
  await submitMemberRegistration(page, { ...memberProfile, sourceApplicationRecordId: secondApplicationRecordId });
  await page.getByTestId("create-command-preview").click();
  const linkExistingEffect = page.getByTestId("command-effect");
  await expect(linkExistingEffect).toContainText("MATCH_EXISTING_MEMBER");
  await expect(linkExistingEffect).toContainText("USE_EXISTING_CONTRACT");
  await expect(linkExistingEffect).toContainText("CREATE_LINK");
  await expect(linkExistingEffect).toContainText(secondApplicationRecordId);
  await page.getByTestId("reason-note").fill("Link a repeated Feishu stay application to the same natural person");
  await page.getByTestId("confirm-command").click();
  memberReceipt = page.getByTestId("command-receipt");
  await expect(memberReceipt).toContainText("EXECUTED");
  await expect(memberReceipt.locator("code").filter({ hasText: memberId! }).first()).toHaveText(memberId!);
  await expect(memberReceipt.locator("code").filter({ hasText: memberContractId! }).first()).toHaveText(memberContractId!);
  const secondExternalReferenceId = (await memberReceipt.locator("code").filter({ hasText: /^memberref_/ }).first().textContent())?.trim();
  expect(secondExternalReferenceId).toMatch(/^memberref_/);
  expect(secondExternalReferenceId).not.toBe(firstExternalReferenceId);
  await closeReceipt(page);

  await expect(page.getByText(memberProfile.sourceApplicationRecordId, { exact: true })).toBeVisible();
  await expect(page.getByText(secondApplicationRecordId, { exact: true })).toBeVisible();
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("desktop-member-profile.png"), fullPage: true });

  await page.goto("/");
  await createOrder(page, {
    unitCode: "103",
    guest: memberProfile.fullName,
    arrivalDate: "2027-11-10",
    departureDate: "2027-11-11",
    memberIdentityCardNumber: memberProfile.identityCardNumber,
    expectedCoverageNights: 0,
    expectedQuoteAmount: "¥232.00",
    bookingChannelCode: "YOUMUDAO",
    channelOrderReference: "TEST-E2E-YOUMUDAO-ZERO-BALANCE-001"
  });
  await expect(page.getByTestId("command-receipt")).toContainText("order_");
  await page.getByRole("link", { name: /查看订单/ }).click();
  await expect(page.getByRole("heading", { name: memberProfile.fullName })).toBeVisible();
  await expect(page.getByTestId("order-amounts")).toContainText("¥232.00");
  await expect(page.getByText("没有会员覆盖", { exact: true })).toBeVisible();
  await expect(page.getByText(memberContractId!, { exact: true })).toBeVisible();
  await assertNoA11yViolations(page);
});

test("desktop quote command recovers the committed Quote after response loss", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only direct command recovery");
  await login(page);
  await chooseDatesAndUnit(page, "101", "2026-10-12", "2026-10-10");
  await page.getByLabel("住宿类型").selectOption("FREE");
  await page.getByLabel("计价政策版本").selectOption("policy_free_v1");
  let originalQuoteKey = "";
  let quotePostCount = 0;
  await page.route("**/api/v1/quotes", async (route) => {
    quotePostCount += 1;
    originalQuoteKey = route.request().headers()["idempotency-key"] ?? "";
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });

  await page.getByTestId("request-quote").click();
  let recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText("报价命令结果待恢复");
  await expect(recovery).toContainText(originalQuoteKey);
  expect(originalQuoteKey).toMatch(/^web-create-quote-/);
  expect(quotePostCount).toBe(1);

  await page.reload();
  recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText(originalQuoteKey);
  await page.getByRole("link", { name: "订单", exact: true }).click();
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "房态", exact: true }).click();
  recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText(originalQuoteKey);

  const recoveryRequest = page.waitForRequest((request) => (
    request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/command-results"
  ));
  await recovery.getByRole("button", { name: "查询命令结果" }).click();
  const recoveredUrl = new URL((await recoveryRequest).url());
  expect(recoveredUrl.searchParams.get("commandType")).toBe("CREATE_QUOTE");
  expect(recoveredUrl.searchParams.get("idempotencyKey")).toBe(originalQuoteKey);
  await expect(page.getByTestId("quote-recovery")).toBeHidden();
  await expect(page.getByText(/报价已恢复，但当前筛选条件已变化/)).toBeVisible();
  expect(quotePostCount).toBe(1);
  await assertNoA11yViolations(page);
});

test("desktop delayed Quote callback after navigation preserves SENDING recovery without a duplicate Quote", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Quote lifecycle recovery");
  let quotePostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/quotes") quotePostCount += 1;
  });
  await login(page);
  await chooseDatesAndUnit(page, "102", "2026-10-15", "2026-10-13");
  await page.getByLabel("住宿类型").selectOption("FREE");
  await page.getByLabel("计价政策版本").selectOption("policy_free_v1");
  const delayed = await deferNextQuoteResponse(page);

  await page.getByTestId("request-quote").click();
  await delayed.fetched;
  const originalQuoteKey = delayed.idempotencyKey();
  expect(originalQuoteKey).toMatch(/^web-create-quote-/);
  await expect(page.getByTestId("quote-recovery")).toContainText(originalQuoteKey);

  await page.getByRole("link", { name: "订单", exact: true }).click();
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await releaseQuoteAndFlushOldCallback(page, delayed);
  expect(await page.evaluate((idempotencyKey) => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith("qintopia.quote-command-recovery.v1:")))
    .map((key) => JSON.parse(sessionStorage.getItem(key) ?? "null") as { state?: string; metadata?: { idempotencyKey?: string } })
    .some((record) => record.state === "SENDING" && record.metadata?.idempotencyKey === idempotencyKey), originalQuoteKey)).toBe(true);

  await page.getByRole("link", { name: "房态", exact: true }).click();
  const recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText(originalQuoteKey);
  await recovery.getByRole("button", { name: "查询命令结果" }).click();
  await expect(recovery).toBeHidden();
  expect(quotePostCount).toBe(1);
});

test("desktop delayed Quote callback cannot cross a same-page property scope switch", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Quote property scope isolation");
  const originalPropertyId = "prop_qintopia_demo";
  const secondaryPropertyId = "property_e2e_quote_scope";
  await page.route("**/api/v1/meta", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      properties: Array<{ id: string; code: string; name: string; timezone: string; currency: string }>;
    };
    body.properties.push({
      id: secondaryPropertyId,
      code: "E2E-SCOPE",
      name: "Quote Scope Fixture",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    });
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/v1/properties/${secondaryPropertyId}/room-status?*`, async (route) => {
    const url = new URL(route.request().url());
    const arrivalDate = url.searchParams.get("arrivalDate")!;
    const departureDate = url.searchParams.get("departureDate")!;
    const dates: string[] = [];
    for (let cursor = arrivalDate; cursor < departureDate;) {
      dates.push(cursor);
      const next = new Date(`${cursor}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next.toISOString().slice(0, 10);
    }
    const asOf = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        propertyId: secondaryPropertyId,
        businessDate: arrivalDate,
        range: { arrivalDate, departureDate },
        dates,
        asOf,
        freshUntil: new Date(Date.parse(asOf) + 5_000).toISOString(),
        revision: "0",
        accessLevel: "WRITE",
        projectionState: "READY",
        filterOptions: { roomTypeCodes: [], salesModes: [], statuses: [], capacities: [], unitKinds: [] },
        page: { index: 0, size: 200, totalRooms: 0, totalPages: 0 },
        operationalTasks: [],
        rooms: []
      })
    });
  });
  let quotePostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/quotes") quotePostCount += 1;
  });

  await login(page);
  await chooseDatesAndUnit(page, "103", "2026-10-18", "2026-10-16");
  await page.getByLabel("住宿类型").selectOption("FREE");
  await page.getByLabel("计价政策版本").selectOption("policy_free_v1");
  const delayed = await deferNextQuoteResponse(page);
  await page.getByTestId("request-quote").click();
  await delayed.fetched;
  const originalQuoteKey = delayed.idempotencyKey();
  expect(originalQuoteKey).toMatch(/^web-create-quote-/);

  await page.getByTestId("property-select").selectOption(secondaryPropertyId);
  await expect(page.getByTestId("property-select")).toHaveValue(secondaryPropertyId);
  await expect(page.getByText("当前页没有库存单元", { exact: true })).toBeVisible();
  await expect(page.getByTestId("quote-recovery")).toBeHidden();
  await releaseQuoteAndFlushOldCallback(page, delayed);
  await expect(page.getByText("本地报价恢复记录不可用", { exact: true })).toBeHidden();
  await expect(page.getByTestId("quote-result")).toBeHidden();
  expect(await page.evaluate((idempotencyKey) => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith("qintopia.quote-command-recovery.v1:")))
    .map((key) => JSON.parse(sessionStorage.getItem(key) ?? "null") as { state?: string; metadata?: { idempotencyKey?: string } })
    .some((record) => record.state === "SENDING" && record.metadata?.idempotencyKey === idempotencyKey), originalQuoteKey)).toBe(true);

  await page.getByTestId("property-select").selectOption(originalPropertyId);
  const recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText(originalQuoteKey);
  await recovery.getByRole("button", { name: "查询命令结果" }).click();
  await expect(recovery).toBeHidden();
  expect(quotePostCount).toBe(1);
});

test("desktop order command recovery survives close refresh and navigation without a duplicate Fact", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only order command recovery");
  await login(page);
  await createOrder(page, {
    unitCode: "104",
    guest: "E2E Recovery Guest",
    arrivalDate: "2028-02-01",
    departureDate: "2028-02-02",
    bookingChannelCode: "YOUMUDAO",
    channelOrderReference: "TEST-E2E-RECOVERY-ORDER-001"
  });
  await page.getByRole("link", { name: /查看订单/ }).click();
  await expect(page.getByRole("heading", { name: "E2E Recovery Guest" })).toBeVisible();
  const orderUrl = page.url();
  const transactionReference = "TEST-E2E-RECOVERY-COLLECTION-001";

  await openFactFormAndSubmit(page, "收款", "5800", transactionReference);
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toContainText(transactionReference);
  await page.getByTestId("reason-note").fill("Record collection while the Confirm response is lost");

  let originalConfirmationKey = "";
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    originalConfirmationKey = route.request().headers()["idempotency-key"] ?? "";
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByText("执行状态需要恢复查询", { exact: true })).toBeVisible();
  await expect(page.getByTestId("confirm-command")).toHaveCount(0);
  await expect(page.getByTestId("regenerate-command-preview")).toHaveCount(0);
  expect(originalConfirmationKey).toMatch(/^web-confirm-record_collection-/);
  await page.getByRole("button", { name: "取消", exact: true }).click();

  let recovery = page.getByTestId("order-command-recovery");
  await expect(recovery).toContainText("RECORD_COLLECTION");
  await expect(recovery).toContainText("UNKNOWN");
  await expect(recovery).toContainText(originalConfirmationKey);
  await expect(page.getByTestId("record-collection")).toBeDisabled();
  await expect(page.getByTestId("reprice-order")).toBeDisabled();
  const retainedBeforeReload = await page.evaluate(() => {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith("qintopia.command-recovery.v1:")));
    return keys.map((key) => sessionStorage.getItem(key) ?? "");
  });
  expect(retainedBeforeReload).toHaveLength(1);
  expect(retainedBeforeReload[0]).toContain(originalConfirmationKey);
  expect(retainedBeforeReload[0]).not.toContain(transactionReference);
  expect(retainedBeforeReload[0]).not.toContain("tokenSecret");

  await page.reload();
  await expect(page.getByRole("heading", { name: "E2E Recovery Guest" })).toBeVisible();
  recovery = page.getByTestId("order-command-recovery");
  await expect(recovery).toContainText(originalConfirmationKey);
  await expect(page.getByTestId("record-collection")).toBeDisabled();

  await page.getByRole("link", { name: "返回订单" }).click();
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await page.goto(orderUrl);
  await expect(page.getByRole("heading", { name: "E2E Recovery Guest" })).toBeVisible();
  recovery = page.getByTestId("order-command-recovery");
  await expect(recovery).toContainText(originalConfirmationKey);
  await recovery.getByTestId("order-command-recovery-open").click();

  const recoveryRequest = page.waitForRequest((request) => (
    request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/command-results"
  ));
  await page.getByRole("button", { name: "查询命令结果" }).click();
  const recoveryUrl = new URL((await recoveryRequest).url());
  expect(recoveryUrl.searchParams.get("commandType")).toBe("RECORD_COLLECTION");
  expect(recoveryUrl.searchParams.get("idempotencyKey")).toBe(originalConfirmationKey);
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toContainText("EXECUTED");
  await expect(receipt).toContainText(transactionReference);
  await expect(receipt.locator("code").filter({ hasText: /^command_/ })).toHaveCount(1);
  await closeReceipt(page);

  await expect(page.getByTestId("order-command-recovery")).toBeHidden();
  await expect(page.getByTestId("record-collection")).toBeEnabled();
  await expect(page.getByRole("region", { name: "收退款事实" }).getByText(transactionReference, { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    .filter((key) => key?.startsWith("qintopia.command-recovery.v1:")).length)).toBe(0);
  await assertNoA11yViolations(page);
});

test("desktop quote workbench never applies a response for stale filter inputs", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only stale quote response");
  await login(page);
  await chooseDatesAndUnit(page, "101", "2026-10-15", "2026-10-13");
  await page.getByLabel("住宿类型").selectOption("FREE");
  await page.getByLabel("计价政策版本").selectOption("policy_free_v1");

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
  const committedResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/v1/quotes"
    && response.status() === 200);
  releaseRequest();
  await committedResponse;
  const recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText("报价命令处理中或响应待确认");
  await expect(page.getByTestId("quote-result")).toBeHidden();
  await expect(page.getByTestId("request-quote")).toHaveCount(0);
  await recovery.getByRole("button", { name: "查询命令结果" }).click();
  await expect(recovery).toBeHidden();
  await expect(page.getByText(/当前筛选条件已变化/)).toBeVisible();
  await expect(page.getByTestId("quote-result")).toBeHidden();
});

test("desktop Token lifecycle retains client secrets and uses Preview Confirm Receipt", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Token lifecycle");
  await login(page);
  await page.getByRole("link", { name: "Token", exact: true }).click();
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
  await page.getByRole("link", { name: "订单", exact: true }).click();
  await page.getByRole("link", { name: "Token", exact: true }).click();
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
  await page.getByRole("link", { name: "订单", exact: true }).click();
  await page.getByRole("link", { name: "Token", exact: true }).click();
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
  await assertNoA11yViolations(page);
  await page.screenshot({ path: testInfo.outputPath("token-lifecycle.png"), fullPage: true });
});

test("desktop expired Token Preview rotates preview metadata without changing the retained secret", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Token Preview expiry recovery");
  await page.clock.install();
  await login(page);
  await page.getByRole("link", { name: "Token", exact: true }).click();
  await page.getByRole("button", { name: "签发 Token" }).click();
  await page.getByLabel("标签").fill("E2E expired preview agent");
  const secret = await page.getByLabel("一次性 Token secret").inputValue();
  await page.getByLabel(/我已将一次性 secret 安全保存/).check();
  await page.getByRole("button", { name: "继续生成 Preview" }).click();

  const previewKeys: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/command-previews") {
      previewKeys.push(request.headers()["idempotency-key"] ?? "");
    }
  });
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await page.clock.fastForward(601_000);
  await expect(page.getByTestId("regenerate-command-preview")).toBeVisible();

  await page.clock.setSystemTime(Date.now());
  await page.getByTestId("regenerate-command-preview").click();
  await expect.poll(() => previewKeys.length).toBe(2);
  expect(previewKeys[0]).toMatch(/^web-preview-issue_token-/);
  expect(previewKeys[1]).toMatch(/^web-preview-issue_token-/);
  expect(previewKeys[1]).not.toBe(previewKeys[0]);
  await expect(page.getByRole("region", { name: /尚未清除的一次性 secret/ }).getByLabel("一次性 Token secret")).toHaveValue(secret);
  await expect(page.getByTestId("confirm-command")).toBeVisible();
});

test("desktop Token lifecycle ignores deferred callbacks from unmounted command attempts", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Token callback ordering");
  let tokenListRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/tokens") tokenListRequests += 1;
  });

  await login(page);
  await installConfirmResponseDrainProbe(page);
  await page.getByRole("link", { name: "Token", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Token 生命周期" })).toBeVisible();

  await page.getByRole("button", { name: "签发 Token" }).click();
  await page.getByLabel("标签").fill("E2E deferred callback agent");
  await page.getByLabel(/我已将一次性 secret 安全保存/).check();
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await page.getByTestId("reason-note").fill("Issue while the original Confirm response is deferred");

  const delayedIssue = await deferNextConfirmResponse(page);
  await page.getByTestId("confirm-command").click();
  await delayedIssue.fetched;
  await forceNavigateAwayAndBackToTokens(page);

  const retained = page.getByRole("region", { name: /尚未清除的一次性 secret/ });
  await expect(retained).toContainText("CONFIRMING");
  await retained.getByRole("button", { name: "恢复命令结果" }).click();
  const issueRequestBaseline = tokenListRequests;
  const issueRecoveryRequest = page.waitForRequest((request) => (
    request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/command-results"
  ));
  const issueRefresh = page.waitForResponse((response) => (
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/tokens"
  ));
  await page.getByRole("button", { name: "查询命令结果" }).click();
  expect(new URL((await issueRecoveryRequest).url()).searchParams.get("idempotencyKey")).toBe(delayedIssue.confirmationKey());
  await expect(page.getByTestId("command-receipt")).toContainText("EXECUTED");
  await issueRefresh;
  expect(tokenListRequests).toBe(issueRequestBaseline + 1);
  await closeReceipt(page);
  await expect(retained).toContainText("EXECUTED");

  const tokenRows = page.getByRole("row").filter({ hasText: "E2E deferred callback agent" });
  await expect(tokenRows).toHaveCount(1);
  await expect(tokenRows).toContainText("ACTIVE");
  const issuedTokenId = (await tokenRows.locator("th code").textContent())?.trim();
  expect(issuedTokenId).toMatch(/^token_/);

  const requestsBeforeOldIssueResponse = tokenListRequests;
  const issueDrainCount = await confirmResponseDrainCount(page);
  await releaseConfirmAndFlushOldCallback(page, delayedIssue, issueDrainCount);
  await expect(retained).toContainText("EXECUTED");
  await expect(tokenRows).toHaveCount(1);
  expect(tokenListRequests).toBe(requestsBeforeOldIssueResponse);

  await retained.getByRole("button", { name: "清除本地 secret" }).click();
  await tokenRows.getByRole("button", { name: `撤销 Token ${issuedTokenId}` }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await page.getByTestId("reason-note").fill("Revoke while the original Confirm response is deferred");

  const delayedRevoke = await deferNextConfirmResponse(page, "SERVER_ERROR");
  await page.getByTestId("confirm-command").click();
  await delayedRevoke.fetched;
  await forceNavigateAwayAndBackToTokens(page);

  const pending = page.getByRole("region", { name: "待处理 Token 命令" });
  await expect(pending).toContainText("CONFIRMING");
  await pending.getByRole("button", { name: "恢复命令结果" }).click();
  const revokeRequestBaseline = tokenListRequests;
  const revokeRecoveryRequest = page.waitForRequest((request) => (
    request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/command-results"
  ));
  const revokeRefresh = page.waitForResponse((response) => (
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/tokens"
  ));
  await page.getByRole("button", { name: "查询命令结果" }).click();
  expect(new URL((await revokeRecoveryRequest).url()).searchParams.get("idempotencyKey")).toBe(delayedRevoke.confirmationKey());
  await expect(page.getByTestId("command-receipt")).toContainText("EXECUTED");
  await revokeRefresh;
  expect(tokenListRequests).toBe(revokeRequestBaseline + 1);
  await closeReceipt(page);
  await expect(pending).toContainText("EXECUTED");
  await expect(tokenRows).toHaveCount(1);
  await expect(tokenRows).toContainText("REVOKED");

  const requestsBeforeOldRevokeResponse = tokenListRequests;
  const revokeDrainCount = await confirmResponseDrainCount(page);
  await releaseConfirmAndFlushOldCallback(page, delayedRevoke, revokeDrainCount);
  await expect(pending).toContainText("EXECUTED");
  await expect(tokenRows).toHaveCount(1);
  await expect(tokenRows).toContainText("REVOKED");
  expect(tokenListRequests).toBe(requestsBeforeOldRevokeResponse);
});

test("keyboard-only navigation reaches a business Preview and cancels without confirmation", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard assertion");
  await page.goto("/");
  await expect(page.getByTestId("login-username")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("login-password")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("login-submit")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();

  const ordersLink = page.getByRole("link", { name: "订单", exact: true });
  await tabTo(page, ordersLink);
  await expect(ordersLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();

  const inventoryLink = page.getByRole("link", { name: "房态", exact: true });
  await tabTo(page, inventoryLink, { reverse: true });
  await expect(inventoryLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();

  const firstCell = page.getByRole("gridcell").first();
  await tabTo(page, firstCell);
  const availableCell = page.getByRole("gridcell", { name: /服务端标记可售/ }).first();
  await expect(availableCell).toBeVisible({ timeout: 5_000 });
  const currentPosition = await firstCell.evaluate((element) => ({
    row: Number(element.getAttribute("aria-rowindex")),
    column: Number(element.getAttribute("aria-colindex"))
  }));
  const targetPosition = await availableCell.evaluate((element) => ({
    row: Number(element.getAttribute("aria-rowindex")),
    column: Number(element.getAttribute("aria-colindex"))
  }));
  const rowKey = targetPosition.row >= currentPosition.row ? "ArrowDown" : "ArrowUp";
  const columnKey = targetPosition.column >= currentPosition.column ? "ArrowRight" : "ArrowLeft";
  for (let index = 0; index < Math.abs(targetPosition.row - currentPosition.row); index += 1) await page.keyboard.press(rowKey);
  for (let index = 0; index < Math.abs(targetPosition.column - currentPosition.column); index += 1) await page.keyboard.press(columnKey);
  await expect(availableCell).toBeFocused();
  await page.keyboard.press("Space");
  const maintenanceButton = page.getByRole("button", { name: "放置维修锁房", exact: true });
  await tabTo(page, maintenanceButton, { limit: 120 });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /^维修锁房 ·/ })).toBeVisible();
  const maintenanceReason = page.getByLabel("维修原因");
  await tabTo(page, maintenanceReason);
  await page.keyboard.type("Keyboard-only maintenance preview");
  const continueButton = page.getByRole("button", { name: "继续生成 Preview" });
  await tabTo(page, continueButton);
  await page.keyboard.press("Enter");

  const createPreview = page.getByTestId("create-command-preview");
  await tabTo(page, createPreview);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await assertNoA11yViolations(page);
  const cancelPreview = page.getByRole("button", { name: "取消", exact: true });
  await tabTo(page, cancelPreview);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-effect")).toBeHidden();
});

test("responsive shell and 200 percent zoom stay contiguous without page overflow", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "single-browser responsive assertion");
  await login(page);

  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: "今日履约" })).toBeVisible();
    await assertNoPageOverflow(page);
    await assertShellDoesNotOverlap(page, width);

    await page.goto("/tokens");
    await expect(page.getByRole("heading", { name: "Token 生命周期" })).toBeVisible();
    await assertNoPageOverflow(page);
    await assertShellDoesNotOverlap(page, width);
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
    screenWidth: 1440,
    screenHeight: 1800
  });
  await page.goto("/today");
  expect(await page.evaluate(() => ({ width: window.innerWidth, pixelRatio: window.devicePixelRatio }))).toEqual({ width: 720, pixelRatio: 2 });
  await assertNoPageOverflow(page);
  await assertShellDoesNotOverlap(page, 720);
  await assertNoA11yViolations(page);
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
  await expect(page.getByTestId("arrival-date")).toHaveValue("2026-07-21");
  await expect(page.getByTestId("departure-date")).toHaveValue("2026-08-04");

  await page.getByRole("link", { name: "移动履约" }).click();
  await expect(page.getByLabel("营业日期")).toHaveValue("2026-07-21");
});

test("maintenance lock can be listed and released", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop maintenance journey");
  await login(page);
  const unitId = await selectRoomStatusRange(page, "102", "2026-08-11", "2026-08-10");
  await page.getByRole("button", { name: "放置维修锁房", exact: true }).click();
  await page.getByLabel("维修原因").fill("E2E air conditioner service");
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await confirmCommand(page, "Maintenance window approved");
  await closeReceipt(page);

  const roomRow = page.locator(`[data-room-status-row="${unitId}"]`);
  const maintenanceInterval = roomRow.getByRole("button", { name: /Maintenance lock，维修锁房/ }).first();
  await expect(maintenanceInterval).toBeVisible();
  await maintenanceInterval.click();
  const sourceSection = page.locator("section.room-status-context-section").filter({
    has: page.getByRole("heading", { name: "来源事实", exact: true })
  });
  await expect(sourceSection.getByText("E2E air conditioner service", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "释放维修锁房", exact: true }).click();
  await confirmCommand(page, "Maintenance work completed");
  await closeReceipt(page);

  await selectRoomStatusRange(page, "102", "2026-08-11", "2026-08-10");
  await expect(page.getByRole("button", { name: "创建正常住宿订单", exact: true })).toBeEnabled();
  await assertNoA11yViolations(page);
});
