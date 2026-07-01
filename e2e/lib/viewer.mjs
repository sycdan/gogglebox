// Viewer-selection helpers. The proof run may land on the "Pick the group"
// screen; these advance into the main app. Two variants:
//   pickFirstViewerAndContinue  — simplest (player-focus): first viewer card.
//   pickEveryoneGroupAndContinue — select EVERY visible viewer card so the
//     combined data set is as large as possible (continue-watching,
//     recommendations, ignore-shows, search). Config v2 has no static group
//     presets, so "everyone" means selecting all viewer cards. `label` is the
//     flow name so the emitted log lines match the original per-flow prefixes
//     verbatim.

// player-focus variant: pick the first viewer card and Continue.
export async function pickFirstViewerAndContinue(page) {
  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  if (await pickHeading.count().then((n) => n > 0)) {
    console.log('[proof] player-focus: selecting a viewer group');
    await page.locator('button.viewer-card:not(.saved-group-card)').first().click();
    const cont = page.getByRole('button', { name: /^Continue$/ });
    await cont.click();
    await page.waitForLoadState('networkidle');
  }
}

// Everyone-preset variant shared by continue-watching, recommendations,
// ignore-shows and search.
export async function pickEveryoneGroupAndContinue(page, label) {
  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  if (await pickHeading.count().then((n) => n > 0)) {
    // Config v2: no preset chips — select EVERY visible viewer card to form the
    // largest group. The proof account's visible users are non-pin-gated in the
    // sandbox, so no PIN prompt blocks Continue.
    const cards = page.locator('button.viewer-card:not(.saved-group-card)');
    const count = await cards.count();
    console.log(`[proof] ${label}: selecting all ${count} viewer card(s)`);
    for (let index = 0; index < count; index += 1) {
      await cards.nth(index).click();
    }
    const cont = page.getByRole('button', { name: /^Continue$/ });
    await cont.first().click();
    await page.waitForLoadState('networkidle');
  } else {
    console.log(`[proof] ${label}: already in main app (no viewer-selection screen)`);
  }
}
