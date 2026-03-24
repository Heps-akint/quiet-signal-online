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
}

async function renderText(page: Page) {
  return page.evaluate<RenderedRoomState>(() => JSON.parse(window.render_game_to_text()) as RenderedRoomState);
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


