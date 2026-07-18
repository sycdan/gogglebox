import { pickEveryonePartyAndContinue } from '../lib/viewer.mjs';

// Proves the per-party Ignore feature against the current manual search path:
// an ignored search-result card disappears, the hero Ignored modal lists it,
// and Unignore makes the card available to search again.
export const match = /ignore/i;

export async function run(page, ctx) {
  const { fail, shoot, shootView, withRetry, flowName } = ctx;

  console.log('[proof] ignore-shows: locating viewer-selection screen');
  await pickEveryonePartyAndContinue(page, 'ignore-shows');
  await clearIgnoredItems(page);

  try {
    await page.locator('.toolbar').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shootView(page, `${flowName}-01-no-toolbar`);
    fail('ignore-shows: main app toolbar never appeared', error);
  }

  const showsBtn = page.locator('.toolbar .toggle-row button', { hasText: /^Shows$/ }).first();
  if (await showsBtn.count().then((n) => n > 0)) {
    const selected = await showsBtn.evaluate((el) => el.classList.contains('selected')).catch(() => false);
    if (!selected) {
      await showsBtn.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  const searchInput = page
    .locator('.toolbar .search-field input')
    .first()
    .or(page.locator('.toolbar input[type="search"]').first())
    .or(page.locator('input[placeholder*="Search"]').first());
  try {
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shootView(page, `${flowName}-02-no-search-input`);
    fail('ignore-shows: could not find the toolbar search input', error);
  }

  const resultsSection = page
    .locator('.section-block')
    .filter({ has: page.locator('h2', { hasText: /^Search results$/ }) })
    .first();
  const resultCards = () => resultsSection.locator('.media-card');
  async function resultTitles() {
    return resultCards()
      .locator('h3')
      .allInnerTexts()
      .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
      .catch(() => []);
  }

  const query = 'normal';
  console.log(`[proof] ignore-shows: searching for "${query}"`);
  await searchInput.click();
  await searchInput.fill(query);
  await page.waitForTimeout(1_300);

  try {
    await resultsSection.waitFor({ state: 'visible', timeout: 15_000 });
    await resultCards().first().waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    await shootView(page, `${flowName}-03-no-results`);
    fail(`ignore-shows: no Search results cards appeared for q="${query}"`, error);
  }

  const targetCard = resultCards()
    .filter({ has: page.locator('button', { hasText: /^Ignore$/ }) })
    .first();
  const targetTitle = await withRetry('ignore-shows: read target title', async () =>
    (await targetCard.locator('h3').first().innerText({ timeout: 10_000 })).trim(),
  ).catch(() => '');
  if (!targetTitle) {
    await shootView(page, `${flowName}-04-no-target-title`);
    fail('ignore-shows: could not read a target card title from Search results');
  }

  const before = await resultTitles();
  console.log(`[proof] ignore-shows: result titles before ignore [${before.length}] =`, JSON.stringify(before));
  console.log(`[proof] ignore-shows: ignoring "${targetTitle}"`);
  await shootView(page, `${flowName}-03-results-before-ignore`);

  await withRetry('ignore-shows: click Ignore', () =>
    targetCard.locator('button', { hasText: /^Ignore$/ }).first().click({ timeout: 10_000 }),
  );

  let removed = false;
  const removeDeadline = Date.now() + 20_000;
  while (Date.now() < removeDeadline) {
    await page.waitForTimeout(400);
    const current = await resultTitles();
    if (!current.includes(targetTitle)) {
      removed = true;
      break;
    }
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await shootView(page, `${flowName}-04-after-ignore`);
  if (!removed) {
    const current = await resultTitles();
    fail(`ignore-shows: "${targetTitle}" still present after Ignore; results=${JSON.stringify(current)}`);
  }
  console.log(`[proof] ignore-shows: PASS - "${targetTitle}" disappeared from Search results after Ignore`);

  const heroOpen = page.getByRole('button', { name: /^Ignored/ }).first();
  try {
    await heroOpen.waitFor({ state: 'visible', timeout: 10_000 });
    await heroOpen.click();
  } catch (error) {
    await shoot(page, `${flowName}-05-no-ignored-button`);
    fail('ignore-shows: hero "Ignored" button not found', error);
  }

  const ignoredModal = page
    .locator('.modal')
    .filter({ has: page.locator('h2', { hasText: /^Ignored$/ }) })
    .first();
  try {
    await ignoredModal.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shoot(page, `${flowName}-05-modal-did-not-open`);
    fail('ignore-shows: "Ignored" modal did not appear', error);
  }

  const ignoredRow = ignoredModal
    .locator('.episode-card')
    .filter({ has: page.locator('h3', { hasText: new RegExp(`^${escapeRegExp(targetTitle)}$`) }) })
    .filter({ has: page.locator('button', { hasText: /^Unignore$/ }) })
    .first();
  try {
    await ignoredRow.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shootView(page, `${flowName}-05-no-ignored-row`);
    const rows = await ignoredModal.locator('.episode-card h3').allInnerTexts().catch(() => []);
    fail(
      `ignore-shows: no ignored row for "${targetTitle}" with an Unignore control` +
        (rows.length ? ` (rows: ${JSON.stringify(rows)})` : ''),
      error,
    );
  }

  await shootView(page, `${flowName}-05-ignored-modal`);
  await ignoredRow.locator('button', { hasText: /^Unignore$/ }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  const closeBtn = ignoredModal.getByRole('button', { name: /^Close$/ }).first();
  if (await closeBtn.count().then((n) => n > 0)) {
    await closeBtn.click().catch(() => {});
  }

  let restored = false;
  const restoreDeadline = Date.now() + 20_000;
  while (Date.now() < restoreDeadline) {
    await page.waitForTimeout(400);
    const current = await resultTitles();
    if (current.includes(targetTitle)) {
      restored = true;
      break;
    }
  }
  await shootView(page, `${flowName}-06-after-unignore`);
  if (!restored) {
    const current = await resultTitles();
    fail(`ignore-shows: "${targetTitle}" did not return after Unignore; results=${JSON.stringify(current)}`);
  }
  console.log(`[proof] ignore-shows: PASS - "${targetTitle}" returned to Search results after Unignore`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    console.log(`[proof] ignore-shows: cleared ${cleared} pre-existing ignored item(s)`);
  }
}
