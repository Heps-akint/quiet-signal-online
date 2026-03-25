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

async function misplayLevel(hostPage: Page, guestPage: Page) {
  const hostState = await renderText(hostPage);
  const guestState = await renderText(guestPage);
  const hostCard = hostState.self.hand[0];
  const guestCard = guestState.self.hand[0];

  expect(hostCard).toBeDefined();
  expect(guestCard).toBeDefined();

  const higherCard = Math.max(hostCard ?? 0, guestCard ?? 0);
  const activePage = hostCard === higherCard ? hostPage : guestPage;

  await activePage.getByRole("button", { name: new RegExp(String(higherCard)) }).click();

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


