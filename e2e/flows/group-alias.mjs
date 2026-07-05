// ── group-alias flow ───────────────────────────────────────────────────────
// Proves the managed-group create/reuse + alias path end-to-end against sbx.
//
// The sbx household account (auto-login) sees Alice + Bob as PRESELECTED
// primaries and Carol + Dave as secondaries — no guests, so no PIN prompts to
// fight. selectExactViewersByName handles the preselection (deselects anything
// outside Alice + Bob). This flow drives:
//   1. picker (viewer grid; "Saved groups" absent on first run) -> group-alias-picker.png
//   2. select Alice + Bob, Continue -> app renders               -> group-alias-created.png
//   3. "Change viewers" -> picker now lists a "Saved groups" card
//      showing the alias "Alice + Bob"                            -> group-alias-saved.png
//   4. select that saved group -> Continue -> app renders, NO
//      duplicate group created (same deterministic key)           -> group-alias-reused.png
//
// Run it with:
//   PROOF_FLOW=group-alias ./scripts/sbx.sh run --rm proof
//
// NOTE on auto-login: run.mjs logs in (auto-login household in sbx) BEFORE
// flows. We do NOT log out here — household is exactly the account we want. We
// never stub the login POST (see group-pin.mjs / lib/session.mjs). If a manual
// login were needed we'd patch GET /api/session to set
// portalAutoLoginEnabled=false and gate on the explicit token POST 200 — not
// needed for this flow.
import { continueFromPicker, selectExactViewersByName, viewerCards } from '../lib/viewer.mjs';

export const match = /group-alias|alias/i;

const MEMBER_A = 'Alice';
const MEMBER_B = 'Bob';
const EXPECTED_ALIAS = `${MEMBER_A} + ${MEMBER_B}`;

// Count the managed groups VISIBLE to the current account via the app's own API.
// Used to assert reuse (no duplicate) across a select-saved-group + Continue.
async function countGroups(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/groups', { credentials: 'same-origin' });
    if (!res.ok) return -1;
    const data = await res.json();
    return Array.isArray(data.groups) ? data.groups.length : -1;
  });
}

export async function run(page, ctx) {
  const { fail, shoot } = ctx;

  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  const changeViewersBtn = page.getByRole('button', { name: /change viewers/i }).first();

  // If run.mjs left us on the main app (a prior session had an active group),
  // go back to the picker first.
  if (await changeViewersBtn.count().then((n) => n > 0)) {
    await changeViewersBtn.click().catch(() => {});
  }

  // ── 1. Picker (viewer grid; Saved groups absent on first run) ──────────────
  try {
    await pickHeading.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, 'group-alias-picker-MISSING');
    fail('group-alias: "Pick the group" screen did not appear', error);
  }

  const cards = viewerCards(page);
  const names = (await cards.locator('strong').allTextContents()).map((s) => s.trim());
  console.log('[proof] group-alias: visible viewer cards =', JSON.stringify(names));
  if (!names.includes(MEMBER_A) || !names.includes(MEMBER_B)) {
    fail(`group-alias: picker must show ${MEMBER_A} and ${MEMBER_B} (saw [${names.join(', ')}])`);
  }
  await shoot(page, 'group-alias-picker');

  // ── 2. Select EXACTLY Alice + Bob -> Continue -> app renders ───────────────
  // Alice + Bob are the household primaries and arrive preselected; the helper
  // makes the selection exact either way (and would deselect any extras).
  const { missing } = await selectExactViewersByName(page, [MEMBER_A, MEMBER_B]);
  if (missing.length > 0) {
    fail(`group-alias: viewer card(s) missing for [${missing.join(', ')}]`);
  }

  await continueFromPicker(page, 'group-alias');
  try {
    await pickHeading.waitFor({ state: 'detached', timeout: 20_000 });
  } catch (error) {
    const err = await page.locator('.error').first().textContent().catch(() => null);
    await shoot(page, 'group-alias-created-STUCK');
    fail(`group-alias: Continue did not form the group${err ? ` (app error: ${err.trim()})` : ''}`, error);
  }
  const continueHeading = page.getByRole('heading', { name: /continue watching/i }).first();
  try {
    await Promise.all([
      continueHeading.waitFor({ state: 'visible', timeout: 20_000 }),
      changeViewersBtn.waitFor({ state: 'visible', timeout: 20_000 }),
    ]);
  } catch (error) {
    await shoot(page, 'group-alias-created-NO-HOME');
    fail('group-alias: group formed but the main app did not render', error);
  }
  // The active-group alias label renders near "Change viewers".
  const aliasLabel = page.locator('.group-alias', { hasText: EXPECTED_ALIAS });
  if (await aliasLabel.count().then((n) => n > 0)) {
    console.log(`[proof] group-alias: active-group alias label shows "${EXPECTED_ALIAS}"`);
  } else {
    console.log('[proof] group-alias: WARN — active-group alias label not found (non-fatal)');
  }
  await shoot(page, 'group-alias-created');

  const groupsAfterCreate = await countGroups(page);
  console.log(`[proof] group-alias: visible managed groups after create = ${groupsAfterCreate}`);

  // ── 3. Back to picker -> a "Saved groups" card shows the alias ─────────────
  await changeViewersBtn.click();
  try {
    await pickHeading.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, 'group-alias-saved-NO-PICKER');
    fail('group-alias: did not return to the picker after Change viewers', error);
  }

  const savedCard = page.locator('button.saved-group-card', { hasText: EXPECTED_ALIAS }).first();
  try {
    await savedCard.waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    await shoot(page, 'group-alias-saved-MISSING');
    fail(`group-alias: "Saved groups" did not list a card with alias "${EXPECTED_ALIAS}"`, error);
  }
  const savedText = (await savedCard.locator('strong').first().textContent().catch(() => '')) ?? '';
  console.log('[proof] group-alias: saved group card alias =', JSON.stringify(savedText.trim()));
  if (savedText.trim() !== EXPECTED_ALIAS) {
    fail(`group-alias: saved card alias should be "${EXPECTED_ALIAS}" (got "${savedText.trim()}")`);
  }
  await shoot(page, 'group-alias-saved');

  // ── 4. Select the saved group -> Continue -> NO duplicate group ────────────
  await savedCard.click();
  await continueFromPicker(page, 'group-alias');
  try {
    await pickHeading.waitFor({ state: 'detached', timeout: 20_000 });
  } catch (error) {
    const err = await page.locator('.error').first().textContent().catch(() => null);
    await shoot(page, 'group-alias-reused-STUCK');
    fail(`group-alias: selecting the saved group did not activate it${err ? ` (app error: ${err.trim()})` : ''}`, error);
  }
  try {
    await Promise.all([
      page.getByRole('heading', { name: /continue watching/i }).first().waitFor({ state: 'visible', timeout: 20_000 }),
      changeViewersBtn.waitFor({ state: 'visible', timeout: 20_000 }),
    ]);
  } catch (error) {
    await shoot(page, 'group-alias-reused-NO-HOME');
    fail('group-alias: saved group activated but the main app did not render', error);
  }

  const groupsAfterReuse = await countGroups(page);
  console.log(`[proof] group-alias: visible managed groups after reuse = ${groupsAfterReuse}`);
  await shoot(page, 'group-alias-reused');

  if (groupsAfterCreate >= 0 && groupsAfterReuse >= 0 && groupsAfterReuse !== groupsAfterCreate) {
    fail(
      `group-alias: reuse created a DUPLICATE group (before=${groupsAfterCreate} after=${groupsAfterReuse}); same key must reuse`,
    );
  }
  console.log('[proof] group-alias: PASS — create + alias + reuse (no duplicate)');
}
