import { pickEveryonePartyAndContinue } from '../lib/viewer.mjs';

// Default production-safe flag state: Tonight's Nine is hidden, but the page
// still exposes the manual search path.
export const match = /tonight.*hidden|flags.*off/i;

export async function run(page, ctx) {
  const { fail, shootView, flowName } = ctx;

  console.log('[proof] tonights-nine-hidden: selecting viewers with default flags');
  await pickEveryonePartyAndContinue(page, 'tonights-nine-hidden');

  const tonightHeading = page.locator('.eyebrow', { hasText: /^Tonight's Nine$/ }).first();
  const visible = await tonightHeading.isVisible().catch(() => false);
  if (visible) {
    await shootView(page, `${flowName}-01-tonights-nine-visible`);
    fail('tonights-nine-hidden: Tonight\'s Nine was visible while the default flag was disabled');
  }

  const search = page.locator('input[type="search"]').first();
  try {
    await search.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shootView(page, `${flowName}-02-no-search`);
    fail('tonights-nine-hidden: manual search path was not visible', error);
  }

  await shootView(page, `${flowName}-01-hidden`);
  console.log('[proof] tonights-nine-hidden: PASS');
}
