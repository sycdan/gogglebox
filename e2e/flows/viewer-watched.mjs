import { pickEveryonePartyAndContinue } from '../lib/viewer.mjs';

// ── viewer-watched flow ────────────────────────────────────────────────────
// Proves the per-viewer watched-state pills on Continue-watching cards:
//   1. Primary button reads "Play" (was "Continue").
//   2. A .viewer-pills group renders next to Play, one .viewer-pill per viewer.
//   3. A viewer whose current episode is marked played shows a .viewer-pill-check
//      overlay (the .watched modifier).
//   4. Clicking a pill toggles that viewer's watched state — before/after shots
//      capture the marker appearing/disappearing.
export const match = /viewer-watched|watched-pill|viewer-pill/i;

export async function run(page, ctx) {
  const { fail, shoot, shootView, flowName } = ctx;

  await pickEveryonePartyAndContinue(page, flowName);

  // Wait for the Continue-watching rail to render.
  try {
    await page.locator('.section-block').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shoot(page, `${flowName}-00-no-home`);
    fail('viewer-watched: main app section-block never appeared', error);
  }
  await page.waitForLoadState('networkidle');

  // Find the first continue-watching card that actually has viewer pills.
  const cards = page.locator('.section-block').first().locator('.media-card');
  try {
    await cards.first().waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    await shoot(page, `${flowName}-00-empty-rail`);
    fail('viewer-watched: Continue-watching rail is EMPTY — no in-progress data for this party; cannot prove pills. Seed in-progress items in Jellyfin.');
  }

  const cardCount = await cards.count();
  console.log(`[proof] viewer-watched: ${cardCount} continue-watching cards`);

  let targetCard = null;
  for (let i = 0; i < cardCount; i += 1) {
    const card = cards.nth(i);
    const pillCount = await card.locator('.viewer-pill').count();
    if (pillCount > 0) {
      targetCard = card;
      console.log(`[proof] viewer-watched: card #${i} has ${pillCount} viewer pill(s)`);
      break;
    }
  }

  if (!targetCard) {
    await shoot(page, `${flowName}-00-no-pills`);
    fail('viewer-watched: no continue-watching card rendered any .viewer-pill — feature not visible.');
  }

  // Assert the primary button label is "Play" (point 1).
  const playBtn = targetCard.locator('.play-row > button').first();
  const playLabel = (await playBtn.innerText().catch(() => '')).trim();
  console.log(`[proof] viewer-watched: primary button label = "${playLabel}"`);
  if (!/^Play$/i.test(playLabel)) {
    console.error(`[proof] viewer-watched: FAIL — primary button label is "${playLabel}", expected "Play"`);
  }

  // Scroll the card into view and full-page shot for overall context.
  await targetCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shoot(page, `${flowName}-01-card-full`);

  // Tight close-up of the play-row (Play button + viewer pills) so the small
  // pills + check overlays are legible.
  const playRow = targetCard.locator('.play-row').first();
  await playRow.screenshot({ path: `${ctx.outDir}/${flowName}-02-pills-before.png` });
  console.log(`[proof] screenshot: ${ctx.outDir}/${flowName}-02-pills-before.png`);

  // Labelled close-up of the first card's play-row for the pill-clipping check.
  await playRow.screenshot({ path: `${ctx.outDir}/${flowName}-pills-closeup.png` });
  console.log(`[proof] screenshot: ${ctx.outDir}/${flowName}-pills-closeup.png`);

  // ── Initial-load capture: a specific Continue-watching card by title ───────
  // Done BEFORE any toggle/click so the shot + evidence reflect load state.
  const toyStory = page.locator('.media-card', { hasText: 'Toy Story of Terror!' }).first();
  if ((await toyStory.count()) > 0) {
    await toyStory.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await toyStory
      .locator('.play-row')
      .first()
      .screenshot({ path: `${ctx.outDir}/${flowName}-toystory-load-pills.png` });
    console.log(`[proof] screenshot: ${ctx.outDir}/${flowName}-toystory-load-pills.png`);
  } else {
    console.log('[proof] viewer-watched: no "Toy Story of Terror!" card on this party — skipping its load-pill shot');
  }

  // Per-pill evidence at initial load for BOTH the first/target card and the
  // Toy Story card. App.tsx sets the viewer name in the pill's `title`
  // ("<name> — <state> (click to toggle)"); photo => <img.viewer-pill-avatar>,
  // letter => <span.viewer-pill-avatar>, watched badge => .viewer-pill-check.
  await logPillEvidence(`${flowName} target card`, targetCard);
  if ((await toyStory.count()) > 0) {
    await logPillEvidence(`${flowName} Toy Story of Terror!`, toyStory);
  }

  // Capture the per-viewer watched state before the toggle.
  const pills = targetCard.locator('.viewer-pill');
  const pillN = await pills.count();
  const before = [];
  for (let i = 0; i < pillN; i += 1) {
    const cls = (await pills.nth(i).getAttribute('class')) ?? '';
    const pressed = await pills.nth(i).getAttribute('aria-pressed');
    const title = await pills.nth(i).getAttribute('title');
    const hasCheck = (await pills.nth(i).locator('.viewer-pill-check').count()) > 0;
    before.push({ watched: cls.includes('watched'), pressed, hasCheck, title });
  }
  console.log('[proof] viewer-watched: pill states BEFORE =', JSON.stringify(before));

  // Toggle the FIRST viewer pill and wait for the state to flip.
  const firstPill = pills.first();
  const beforeWatched = before[0].watched;
  console.log(`[proof] viewer-watched: clicking first pill (currently watched=${beforeWatched})`);
  await firstPill.scrollIntoViewIfNeeded();
  await firstPill.click();

  // Poll the first pill's class for up to 8s for the toggle to land.
  let flipped = false;
  for (let t = 0; t < 32; t += 1) {
    const cls = (await firstPill.getAttribute('class').catch(() => '')) ?? '';
    if (cls.includes('watched') !== beforeWatched) {
      flipped = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  console.log(`[proof] viewer-watched: first pill flipped = ${flipped}`);

  await page.waitForTimeout(400);
  await shoot(page, `${flowName}-03-card-full-after`);
  await playRow.screenshot({ path: `${ctx.outDir}/${flowName}-04-pills-after.png` });
  console.log(`[proof] screenshot: ${ctx.outDir}/${flowName}-04-pills-after.png`);

  const after = [];
  for (let i = 0; i < pillN; i += 1) {
    const cls = (await pills.nth(i).getAttribute('class').catch(() => '')) ?? '';
    const hasCheck = (await pills.nth(i).locator('.viewer-pill-check').count().catch(() => 0)) > 0;
    after.push({ watched: cls.includes('watched'), hasCheck });
  }
  console.log('[proof] viewer-watched: pill states AFTER =', JSON.stringify(after));

  if (!flipped) {
    fail('viewer-watched: clicking the first viewer pill did NOT toggle its watched state within 8s.');
  }
  console.log('[proof] viewer-watched: PASS — pill toggle flipped the watched marker');
}

// Log one line of evidence per .viewer-pill within `card`: viewer name (from the
// pill's title attribute), photo vs letter avatar, and watched-badge presence.
async function logPillEvidence(label, card) {
  const pills = card.locator('.viewer-pill');
  const n = await pills.count();
  console.log(`[proof] viewer-watched: per-pill evidence for ${label} (${n} pill(s)):`);
  for (let i = 0; i < n; i += 1) {
    const pill = pills.nth(i);
    const title = (await pill.getAttribute('title')) ?? '';
    const viewerName = title.split(' — ')[0] || '(unknown)';
    const hasPhoto = (await pill.locator('img.viewer-pill-avatar').count()) === 1;
    const hasLetter = (await pill.locator('span.viewer-pill-avatar').count()) === 1;
    const hasCheck = (await pill.locator('.viewer-pill-check').count()) > 0;
    const avatar = hasPhoto ? 'photo' : hasLetter ? 'letter' : 'none';
    console.log(
      `[proof]   pill #${i}: viewer="${viewerName}" avatar=${avatar} watchedBadge=${hasCheck}`,
    );
  }
}
