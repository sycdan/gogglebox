import { pickEveryonePartyAndContinue } from '../lib/viewer.mjs';

// Tonight's Nine recommendations flow. Proves the finite three-card surface:
// three large visible cards, center focus, sentiment leader, stable-neighbor
// dismissal replacement, and countdown cancellation on directional input.
export const match = /recommend|picks|tonights-nine-enabled/i;

export async function run(page, ctx) {
  const { fail, shoot, shootView, flowName } = ctx;

  await page.route('**/api/flags', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tonightsNine: true }),
    });
  });
  await page.reload({ waitUntil: 'networkidle' });

  console.log('[proof] recommendations: locating viewer-selection screen');
  await pickEveryonePartyAndContinue(page, 'recommendations');
  await clearIgnoredItems(page);

  const moviesBtn = page.locator('.toolbar .toggle-row button', { hasText: /^Movies$/ }).first();
  try {
    await moviesBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const selected = await moviesBtn.evaluate((el) => el.classList.contains('selected')).catch(() => false);
    if (!selected) {
      await moviesBtn.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(500);
    }
  } catch (error) {
    await shootView(page, `${flowName}-00-no-kind-toggle`);
    fail('recommendations: Movies toggle was not available before proving replacement behavior', error);
  }

  const availableRecommendationCount = await page.evaluate(async () => {
    const response = await fetch('/api/recommendations?kind=movie', { credentials: 'same-origin' });
    if (!response.ok) return 0;
    const data = await response.json();
    return Array.isArray(data.items) ? data.items.length : 0;
  });
  console.log(`[proof] recommendations: eligible movie recommendations = ${availableRecommendationCount}`);

  const tonightSection = page
    .locator('.section-block')
    .filter({ has: page.locator('.eyebrow', { hasText: /^Tonight's Nine$/ }) })
    .first();

  try {
    await tonightSection.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shoot(page, `${flowName}-01-no-tonights-nine`);
    fail('recommendations: "Tonight\'s Nine" section never appeared', error);
  }

  async function scrollTonightToTop() {
    await tonightSection.evaluate((el) => {
      const top = el.getBoundingClientRect().top + window.scrollY - 16;
      window.scrollTo(0, top);
    });
    await page.waitForTimeout(300);
  }

  await scrollTonightToTop();

  const cards = tonightSection.locator('.tonight-grid .tonight-card');
  try {
    await cards.first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shoot(page, `${flowName}-02-no-tonight-cards`);
    fail('recommendations: no Tonight\'s Nine cards rendered', error);
  }

  async function cardTitles() {
    return cards
      .locator('h3')
      .allInnerTexts()
      .then((arr) => arr.map((text) => text.trim()).filter(Boolean));
  }

  const initialCount = await cards.count();
  const initialTitles = await cardTitles();
  console.log(`[proof] recommendations: visible cards [${initialCount}] =`, JSON.stringify(initialTitles));
  if (initialCount !== 3) {
    await shootView(page, `${flowName}-03-wrong-card-count`);
    fail(`recommendations: expected exactly 3 visible Tonight's Nine cards, saw ${initialCount}`);
  }

  const focused = tonightSection.locator('.tonight-card.center.focused').first();
  const focusedTitle = ((await focused.locator('h3').first().innerText({ timeout: 10_000 })) ?? '').trim();
  if (!focusedTitle) {
    await shootView(page, `${flowName}-04-no-focused-title`);
    fail('recommendations: center focused card title was not readable');
  }
  await scrollTonightToTop();
  await shootView(page, `${flowName}-01-tonights-nine`);

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press('ArrowUp');
  const leader = tonightSection.locator('.leader-pill').first();
  try {
    await leader.waitFor({ state: 'visible', timeout: 5_000 });
  } catch (error) {
    await shootView(page, `${flowName}-05-no-leader`);
    fail('recommendations: pressing Up did not show a sentiment leader', error);
  }
  const leaderText = ((await leader.innerText()) ?? '').trim();
  if (!leaderText.includes(focusedTitle)) {
    await shootView(page, `${flowName}-06-wrong-leader`);
    fail(`recommendations: leader "${leaderText}" did not include focused title "${focusedTitle}"`);
  }

  const beforeDismiss = await cardTitles();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(2_200);
  const afterDismiss = await cardTitles();
  console.log('[proof] recommendations: before dismiss =', JSON.stringify(beforeDismiss));
  console.log('[proof] recommendations: after dismiss =', JSON.stringify(afterDismiss));
  const expectedAfterDismissCount = availableRecommendationCount > initialCount ? initialCount : Math.max(0, initialCount - 1);
  if (afterDismiss.length !== expectedAfterDismissCount) {
    await shootView(page, `${flowName}-07-dismiss-card-count`);
    fail(`recommendations: expected ${expectedAfterDismissCount} cards after dismissal, saw ${afterDismiss.length}`);
  }
  if (availableRecommendationCount > initialCount) {
    if (afterDismiss[0] !== beforeDismiss[0] || afterDismiss[2] !== beforeDismiss[2]) {
      await shootView(page, `${flowName}-08-neighbors-shifted`);
      fail('recommendations: dismissing focused card did not keep left/right neighbors stable');
    }
    if (afterDismiss[1] === beforeDismiss[1]) {
      await shootView(page, `${flowName}-09-center-not-replaced`);
      fail('recommendations: dismissing focused card did not inject a replacement into center');
    }
  } else if (afterDismiss[0] !== beforeDismiss[0] || afterDismiss[1] !== beforeDismiss[2]) {
    await shootView(page, `${flowName}-08-neighbors-shifted`);
    fail('recommendations: dismissing the focused card did not leave the visible neighbors in place');
  }
  await scrollTonightToTop();
  await shootView(page, `${flowName}-02-after-dismiss`);

  await page.keyboard.press('Enter');
  const countdown = tonightSection.locator('.countdown-pill').first();
  try {
    await countdown.waitFor({ state: 'visible', timeout: 5_000 });
  } catch (error) {
    await shootView(page, `${flowName}-10-no-countdown`);
    fail('recommendations: pressing Enter did not start a play countdown', error);
  }
  await page.keyboard.press('ArrowRight');
  const countdownStillVisible = await countdown.isVisible().catch(() => false);
  if (countdownStillVisible) {
    await shootView(page, `${flowName}-11-countdown-not-cancelled`);
    fail('recommendations: directional input did not cancel the countdown');
  }

  await scrollTonightToTop();
  await shootView(page, `${flowName}-03-countdown-cancelled`);
  console.log('[proof] recommendations: PASS — Tonight\'s Nine surface behaved as expected');
}

async function clearIgnoredItems(page) {
  const cleared = await page.evaluate(async () => {
    const response = await fetch('/api/ignored', { credentials: 'same-origin' });
    if (!response.ok) return -1;
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      if (item && typeof item.key === 'string') {
        await fetch(`/api/ignored/${encodeURIComponent(item.key)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
      }
    }
    return items.length;
  });
  if (cleared > 0) {
    console.log(`[proof] recommendations: cleared ${cleared} pre-existing ignored item(s)`);
  }
}
