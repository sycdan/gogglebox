// Viewer-selection helpers. The proof run may land on the "Pick the group"
// screen; these advance into the main app. Two variants:
//   pickFirstViewerAndContinue  — simplest (player-focus): first viewer card.
//   pickEveryoneGroupAndContinue — prefer the "Everyone" preset chip so the
//     combined data set is as large as possible (continue-watching,
//     recommendations, ignore-shows, search). `label` is the flow name so the
//     emitted log lines match the original per-flow prefixes verbatim.

// player-focus variant: pick the first viewer card and Continue.
export async function pickFirstViewerAndContinue(page) {
  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  if (await pickHeading.count().then((n) => n > 0)) {
    console.log('[proof] player-focus: selecting a viewer group');
    await page.locator('button.viewer-card').first().click();
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
    const presetChips = page.locator('.preset-row .chip');
    const everyone = presetChips.filter({ hasText: /^Everyone$/ }).first();
    if (await everyone.count().then((n) => n > 0)) {
      console.log(`[proof] ${label}: selecting "Everyone" preset`);
      await everyone.click();
    } else if (await presetChips.count().then((n) => n > 0)) {
      console.log(`[proof] ${label}: "Everyone" preset not found; using first preset chip`);
      await presetChips.first().click();
    } else {
      console.warn(`[proof] ${label}: no .preset-row .chip presets found; selecting first viewer card`);
      await page.locator('button.viewer-card').first().click();
    }
    const cont = page.getByRole('button', { name: /^Continue$/ });
    await cont.first().click();
    await page.waitForLoadState('networkidle');
  } else {
    console.log(`[proof] ${label}: already in main app (no viewer-selection screen)`);
  }
}
