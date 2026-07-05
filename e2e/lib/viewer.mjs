// Viewer-selection helpers. The proof run may land on the "Pick the group"
// screen; these advance into the main app.
//
// Config v2 picker rules every helper must respect:
//   - The account's PRIMARY viewers arrive PRESELECTED (card class "selected"),
//     so building a specific group means DESELECTING preselected cards outside
//     the wanted set before selecting the wanted ones (a blind click toggles a
//     preselected card OFF).
//   - The "+ Add guest" card is also a button.viewer-card — exclude it (and
//     saved-group cards) from plain viewer-card iteration.
//   - Continuing with ANY non-primary member selected pops a confirmation modal
//     ("shared watch progress"); continueFromPicker confirms it when it appears
//     so every flow gets the same handling.

// Plain (selectable) viewer cards: not saved-group cards, not the add-guest card.
export function viewerCards(page) {
  return page.locator('button.viewer-card:not(.saved-group-card):not(.add-guest-card)');
}

// Click Continue, confirm the mixed-group modal if it appears, and wait for the
// network to settle. Shared by every helper that leaves the picker.
export async function continueFromPicker(page, label = 'picker') {
  const cont = page.getByRole('button', { name: /^Continue$/ }).first();
  await cont.click();

  // The confirmation modal appears synchronously with Continue when the group
  // has any non-primary member; a short wait is enough to detect it.
  const confirmModal = page.locator('.confirm-modal');
  const appeared = await confirmModal
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) {
    console.log(`[proof] ${label}: confirming the mixed-group (shared watch progress) modal`);
    await confirmModal.getByRole('button', { name: /^Confirm$/ }).click();
  }

  await page.waitForLoadState('networkidle');
}

// Make the picker selection EXACTLY the cards at the given indexes: deselect
// any preselected card outside the set, then select the wanted ones.
async function selectExactlyByIndex(page, wantedIndexes) {
  const cards = viewerCards(page);
  const count = await cards.count();
  const wanted = new Set(wantedIndexes);
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const selected = await card.evaluate((el) => el.classList.contains('selected'));
    if (selected !== wanted.has(index)) {
      await card.click();
    }
  }
}

// Make the picker selection EXACTLY the given viewer names. Fails (returns the
// missing names) if a wanted name has no card.
export async function selectExactViewersByName(page, names) {
  const cards = viewerCards(page);
  const count = await cards.count();
  const labels = [];
  for (let index = 0; index < count; index += 1) {
    const text = ((await cards.nth(index).locator('strong').first().textContent()) ?? '').trim();
    labels.push(text);
  }
  const wantedIndexes = [];
  const missing = [];
  for (const name of names) {
    const index = labels.indexOf(name);
    if (index === -1) {
      missing.push(name);
    } else {
      wantedIndexes.push(index);
    }
  }
  await selectExactlyByIndex(page, wantedIndexes);
  return { missing, labels };
}

// player-focus variant: form a single-viewer group from the FIRST viewer card
// (deselecting any other preselected primaries) and Continue.
export async function pickFirstViewerAndContinue(page) {
  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  if (await pickHeading.count().then((n) => n > 0)) {
    console.log('[proof] player-focus: selecting a viewer group');
    await selectExactlyByIndex(page, [0]);
    await continueFromPicker(page, 'player-focus');
  }
}

// Everyone variant shared by continue-watching, recommendations, ignore-shows
// and search: select EVERY plain viewer card (primaries are already selected)
// so the combined data set is as large as possible. Guests (tertiaries) are not
// plain cards, so no PIN prompt blocks Continue; the mixed-group confirmation
// (secondaries present) is handled by continueFromPicker.
export async function pickEveryoneGroupAndContinue(page, label) {
  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  if (await pickHeading.count().then((n) => n > 0)) {
    const cards = viewerCards(page);
    const count = await cards.count();
    console.log(`[proof] ${label}: selecting all ${count} viewer card(s)`);
    await selectExactlyByIndex(page, Array.from({ length: count }, (_, i) => i));
    await continueFromPicker(page, label);
  } else {
    console.log(`[proof] ${label}: already in main app (no viewer-selection screen)`);
  }
}
