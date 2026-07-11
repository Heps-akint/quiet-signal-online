import { expect, test, type Page } from "@playwright/test";
import { createRoomResponseSchema, FOCUS_TRANSITION_MS } from "@shared/protocol";

interface RenderedCard {
  value: number;
}

interface RenderedRoomState {
  phase: string;
  level: number;
  lives: number;
  pile: RenderedCard[];
  inviteLink: string | null;
  self: {
    hand: number[];
  };
  remote: {
    handCount: number;
  };
}

async function renderText(page: Page) {
  return page.evaluate<RenderedRoomState>(() => JSON.parse(window.render_game_to_text()) as RenderedRoomState);
}

async function expectRoomFitsViewport(page: Page) {
  const dimensions = await page.evaluate(() => ({
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth
  }));

  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.innerHeight + 1);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth + 1);
}

async function misplayLevel(hostPage: Page, guestPage: Page) {
  const hostState = await renderText(hostPage);
  const guestState = await renderText(guestPage);
  const hostCard = hostState.self.hand[0];
  const guestCard = guestState.self.hand[0];

  expect(hostCard).toBeDefined();
  expect(guestCard).toBeDefined();

  const higherCard = Math.max(hostCard ?? 0, guestCard ?? 0);
  const activePage = hostCard === higherCard ? hostPage : guestPage;

  await activePage.locator(".hand-card-active").click();

  return {
    guestCard,
    hostCard
  };
}

const focusDelayMs = FOCUS_TRANSITION_MS + 400;

test("host and guest can clear level 1 then trigger a level 2 misplay", async ({
  browser,
  page,
  request,
  baseURL
}) => {
  const createResponse = await request.post(`${baseURL}/api/rooms`, {
    data: {
      debugPreset: {
        seed: 123456,
        deals: {
          1: {
            host: [10],
            guest: [90]
          },
          2: {
            host: [40, 80],
            guest: [25, 60]
          }
        }
      }
    }
  });

  expect(createResponse.ok()).toBeTruthy();
  const room = createRoomResponseSchema.parse(await createResponse.json());

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();

  await page.goto(room.hostInviteUrl);
  await guestPage.goto(room.guestInviteUrl);

  await expect.poll(async () => (await renderText(page)).phase).toBe("between_levels");
  await expect.poll(async () => (await renderText(guestPage)).phase).toBe("between_levels");

  await page.getByRole("button", { name: "Ready" }).click();
  await guestPage.getByRole("button", { name: "Ready" }).click();

  await page.waitForTimeout(focusDelayMs);

  await page.getByRole("button", { name: /10/ }).click();
  await guestPage.getByRole("button", { name: /90/ }).click();

  await expect.poll(async () => (await renderText(page)).level).toBe(2);
  await expect.poll(async () => (await renderText(page)).phase).toBe("between_levels");

  await page.getByRole("button", { name: "Ready" }).click();
  await guestPage.getByRole("button", { name: "Ready" }).click();

  await page.waitForTimeout(focusDelayMs);

  await page.getByRole("button", { name: /40/ }).click();

  await expect.poll(async () => (await renderText(page)).lives).toBe(1);
  await expect.poll(async () => (await renderText(guestPage)).lives).toBe(1);
  await expect.poll(async () => (await renderText(page)).pile.map((card) => card.value)).toEqual([
    25,
    40
  ]);

  await guestContext.close();
});

test("rematch deals fresh opening hands in the same room", async ({
  browser,
  page,
  request,
  baseURL
}) => {
  const createResponse = await request.post(`${baseURL}/api/rooms`, {
    data: {}
  });

  expect(createResponse.ok()).toBeTruthy();
  const room = createRoomResponseSchema.parse(await createResponse.json());

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();

  await page.goto(room.hostInviteUrl);
  await guestPage.goto(room.guestInviteUrl);

  await expect.poll(async () => (await renderText(page)).phase).toBe("between_levels");
  await expect.poll(async () => (await renderText(guestPage)).phase).toBe("between_levels");

  await page.getByRole("button", { name: "Ready" }).click();
  await guestPage.getByRole("button", { name: "Ready" }).click();
  await page.waitForTimeout(focusDelayMs);

  const openingHands = await misplayLevel(page, guestPage);

  await expect.poll(async () => (await renderText(page)).level).toBe(2);
  await expect.poll(async () => (await renderText(page)).lives).toBe(1);
  await expect.poll(async () => (await renderText(guestPage)).lives).toBe(1);

  await page.getByRole("button", { name: "Ready" }).click();
  await guestPage.getByRole("button", { name: "Ready" }).click();
  await page.waitForTimeout(focusDelayMs);

  await misplayLevel(page, guestPage);

  await expect.poll(async () => (await renderText(page)).phase).toBe("lost");
  await expect.poll(async () => (await renderText(guestPage)).phase).toBe("lost");

  await page.getByRole("button", { name: "Rematch" }).click();
  await guestPage.getByRole("button", { name: "Rematch" }).click();

  await expect.poll(async () => (await renderText(page)).phase).toBe("between_levels");
  await expect.poll(async () => (await renderText(guestPage)).phase).toBe("between_levels");

  await page.getByRole("button", { name: "Ready" }).click();
  await guestPage.getByRole("button", { name: "Ready" }).click();
  await page.waitForTimeout(focusDelayMs);

  const rematchHostState = await renderText(page);
  const rematchGuestState = await renderText(guestPage);
  const rematchOpeningHands = {
    hostCard: rematchHostState.self.hand[0],
    guestCard: rematchGuestState.self.hand[0]
  };

  expect(rematchOpeningHands).not.toEqual(openingHands);

  await guestContext.close();
});

test("request overlays stay inside the viewport and clear of the hand", async ({
  browser,
  page,
  request,
  baseURL
}) => {
  const createResponse = await request.post(`${baseURL}/api/rooms`, {
    data: {
      debugPreset: {
        seed: 987654,
        deals: {
          1: {
            host: [10],
            guest: [90]
          }
        }
      }
    }
  });

  expect(createResponse.ok()).toBeTruthy();
  const room = createRoomResponseSchema.parse(await createResponse.json());
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();

  await page.goto(room.hostInviteUrl);
  await guestPage.goto(room.guestInviteUrl);
  await expect.poll(async () => (await renderText(page)).phase).toBe("between_levels");

  await page.getByRole("button", { name: "Ready" }).click();
  await guestPage.getByRole("button", { name: "Ready" }).click();
  await page.waitForTimeout(focusDelayMs);
  await page.getByRole("button", { name: "Throw star" }).click();

  await expect(page.locator(".request-sheet")).toBeVisible();
  await expect(page.locator(".event-banner")).toBeVisible();

  const layout = await page.evaluate(() => {
    const sheet = document.querySelector(".request-sheet")?.getBoundingClientRect();
    const banner = document.querySelector(".event-banner")?.getBoundingClientRect();
    const hand = document.querySelector(".hand-zone")?.getBoundingClientRect();

    if (!sheet || !banner || !hand) {
      throw new Error("Expected request layout was not rendered.");
    }

    return {
      bannerBottom: banner.bottom,
      bannerLeft: banner.left,
      bannerRight: banner.right,
      handTop: hand.top,
      sheetBottom: sheet.bottom,
      sheetLeft: sheet.left,
      sheetRight: sheet.right,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    };
  });

  expect(layout.sheetLeft).toBeGreaterThanOrEqual(0);
  expect(layout.sheetRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.sheetBottom).toBeLessThanOrEqual(layout.handTop);
  expect(layout.bannerLeft).toBeGreaterThanOrEqual(0);
  expect(layout.bannerRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.bannerBottom).toBeLessThanOrEqual(layout.viewportHeight);

  await guestContext.close();
});

test("the full room remains usable without scrolling at 320 by 568", async ({
  browser,
  page,
  request,
  baseURL
}) => {
  await page.setViewportSize({ height: 568, width: 320 });

  const createResponse = await request.post(`${baseURL}/api/rooms`, {
    data: {
      debugPreset: {
        seed: 246810,
        deals: {
          1: {
            host: [18],
            guest: [72]
          }
        }
      }
    }
  });

  expect(createResponse.ok()).toBeTruthy();
  const room = createRoomResponseSchema.parse(await createResponse.json());
  const guestContext = await browser.newContext({ viewport: { height: 568, width: 320 } });
  const guestPage = await guestContext.newPage();

  await page.goto(room.hostInviteUrl);
  await guestPage.goto(room.guestInviteUrl);
  await expect.poll(async () => (await renderText(page)).phase).toBe("between_levels");
  await expectRoomFitsViewport(page);

  await page.getByRole("button", { name: "Ready" }).click();
  await guestPage.getByRole("button", { name: "Ready" }).click();
  await page.waitForTimeout(focusDelayMs);
  await expect(page.getByRole("button", { name: /18/ })).toBeEnabled();
  await expectRoomFitsViewport(page);

  await page.getByRole("button", { name: "Throw star" }).click();
  await expect(page.locator(".request-sheet")).toBeVisible();
  await expectRoomFitsViewport(page);

  await guestContext.close();
});

test("landing fits one screen until how to play reveals the rules", async ({ page }) => {
  await page.setViewportSize({ height: 568, width: 320 });
  await page.goto("/");

  await expect(page.locator("#how-to-play")).toHaveCount(0);
  await expectRoomFitsViewport(page);
  const collapsedScale = await page.evaluate(() => {
    const hero = document.querySelector(".landing-hero");
    const headline = document.querySelector(".landing-copy h1");
    if (!hero || !headline) {
      throw new Error("Landing hero was not rendered.");
    }
    return {
      headlineFontSize: getComputedStyle(headline).fontSize,
      headlineHeight: headline.getBoundingClientRect().height,
      heroHeight: hero.getBoundingClientRect().height
    };
  });

  const howToPlay = page.getByRole("button", { name: "How to play" });
  await expect(howToPlay).toHaveAttribute("aria-expanded", "false");
  await howToPlay.click();

  await expect(page.locator("#how-to-play")).toBeVisible();
  await expect(howToPlay).toHaveAttribute("aria-expanded", "true");
  const expandedDimensions = await page.evaluate(() => {
    const hero = document.querySelector(".landing-hero");
    const headline = document.querySelector(".landing-copy h1");
    if (!hero || !headline) {
      throw new Error("Expanded landing hero was not rendered.");
    }
    return {
      headlineFontSize: getComputedStyle(headline).fontSize,
      headlineHeight: headline.getBoundingClientRect().height,
      heroHeight: hero.getBoundingClientRect().height,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight
    };
  });
  expect(expandedDimensions.scrollHeight).toBeGreaterThan(expandedDimensions.innerHeight);
  expect(expandedDimensions.heroHeight).toBe(collapsedScale.heroHeight);
  expect(expandedDimensions.headlineHeight).toBeCloseTo(collapsedScale.headlineHeight, 2);
  expect(expandedDimensions.headlineFontSize).toBe(collapsedScale.headlineFontSize);
});

test("wide landing keeps both actions inside the viewport", async ({ page }) => {
  await page.setViewportSize({ height: 990, width: 1920 });
  await page.goto("/");
  await expectRoomFitsViewport(page);

  const openRoom = page.getByRole("button", { name: "Open a room" });
  const howToPlay = page.getByRole("button", { name: "How to play" });
  await expect(openRoom).toBeVisible();
  await expect(howToPlay).toBeVisible();

  const actionBounds = await page.locator(".landing-actions").boundingBox();
  expect(actionBounds).not.toBeNull();
  expect((actionBounds?.y ?? 0) + (actionBounds?.height ?? 0)).toBeLessThanOrEqual(990);
});


