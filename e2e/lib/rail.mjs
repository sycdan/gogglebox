// Shared helper for reading an ENTIRE paginated rail's cards, not just the
// currently-rendered DOM page.
//
// The continue-watching (and recommendations) rail pages its cards client-side
// (RAIL_PAGE_SIZE = 3 in src/client/App.tsx): only the current page's cards
// exist in the DOM at any moment, with "‹"/"›" rail-arrow buttons to page
// through the rest. A flow that reads `.media-card` on a single page can find
// FEWER cards than the backend actually returned whenever more than a page's
// worth of cards share one rail — this is not a data bug, it's the rail
// legitimately paginating. Any assertion about the FULL set of cards on a rail
// (e.g. "does every seeded episode have its own card") must page through the
// whole rail via the arrows and accumulate, not just read the first page.
//
// `railLocator` is the rail's root Locator (e.g. `page.locator('.section-block').first()`).
// `extract(cardLocator, pageIndex)` maps one card Locator to whatever plain-data
// shape the caller wants (must not hold onto the Locator itself past its own
// render — the DOM node is gone once the rail pages again).
//
// Leaves the rail on whatever page it ends up on after walking to the last
// page; call goToRailPage(page, railLocator, 0) first if the caller needs to
// return to page 1.
export async function collectAllRailCards(page, railLocator, extract) {
  const results = [];

  // Small safety cap: a rail should never page more than this many times in any
  // real fixture; guards against an infinite loop if "Next" never disables.
  const MAX_PAGES = 50;

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const cards = railLocator.locator('.media-card');
    const count = await cards.count();
    for (let i = 0; i < count; i += 1) {
      results.push(await extract(cards.nth(i), pageIndex));
    }

    if (!(await goToNextRailPage(page, railLocator))) {
      break;
    }
  }

  return results;
}

// Click the rail's "›" Next arrow once, if present and enabled. Returns true if
// it clicked (i.e. there was another page to move to), false otherwise.
export async function goToNextRailPage(page, railLocator) {
  const nextButton = railLocator.locator('.rail-arrow[aria-label="Next"]');
  const hasNextButton = await nextButton.count();
  if (!hasNextButton) {
    return false;
  }
  const disabled = await nextButton.first().isDisabled();
  if (disabled) {
    return false;
  }
  await nextButton.first().click();
  // Let the page-slice re-render before the caller reads the next page's cards.
  await page.waitForTimeout(150);
  return true;
}

// Click the rail's "‹" Prev arrow repeatedly until it's back on page 1 (or
// disabled/absent). Used to reset rail position before a fresh full scan.
export async function goToFirstRailPage(page, railLocator) {
  const prevButton = railLocator.locator('.rail-arrow[aria-label="Previous"]');
  const MAX_PAGES = 50;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const hasPrevButton = await prevButton.count();
    if (!hasPrevButton) {
      return;
    }
    const disabled = await prevButton.first().isDisabled();
    if (disabled) {
      return;
    }
    await prevButton.first().click();
    await page.waitForTimeout(150);
  }
}

// Walk the rail from page 1, advancing `pageIndex` times, so a card found by
// collectAllRailCards at a given pageIndex can be re-located (as a live
// Locator) after the caller has since read metadata off other pages.
export async function goToRailPage(page, railLocator, pageIndex) {
  await goToFirstRailPage(page, railLocator);
  for (let i = 0; i < pageIndex; i += 1) {
    await goToNextRailPage(page, railLocator);
  }
}
