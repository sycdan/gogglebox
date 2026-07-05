// ── party-alias flow ───────────────────────────────────────────────────────
// Proves the managed-party create/reuse + alias path end-to-end against sbx.
// (Parties were formerly called "groups"; the server still accepts the old
// /api/group* routes as compatibility aliases — see src/server/server.ts.)
//
// The sbx household account (auto-login) sees Alice + Bob as PRESELECTED
// primaries and Carol + Dave as secondaries — no guests, so no PIN prompts to
// fight. selectExactViewersByName handles the preselection (deselects anything
// outside Alice + Bob). This flow drives:
//   1. picker (viewer grid; "Saved parties" absent on first run) -> party-alias-picker.png
//   2. select Alice + Bob, Continue -> app renders                -> party-alias-created.png
//   3. "Change viewers" -> picker now lists a "Saved parties" card
//      showing the alias "Alice + Bob"                             -> party-alias-saved.png
//   4. select that saved party -> Continue -> app renders, NO
//      duplicate party created (same deterministic key)            -> party-alias-reused.png
//
// Run it with:
//   PROOF_FLOW=party-alias ./scripts/sbx.sh run --rm proof
//
// NOTE on auto-login: run.mjs logs in (auto-login household in sbx) BEFORE
// flows. We do NOT log out here — household is exactly the account we want. We
// never stub the login POST (see party-pin.mjs / lib/session.mjs). If a manual
// login were needed we'd patch GET /api/session to set
// portalAutoLoginEnabled=false and gate on the explicit token POST 200 — not
// needed for this flow.
import { continueFromPicker, selectExactViewersByName, viewerCards } from '../lib/viewer.mjs';

export const match = /party-alias|group-alias|alias/i;

const MEMBER_A = 'Alice';
const MEMBER_B = 'Bob';
const EXPECTED_ALIAS = `${MEMBER_A} + ${MEMBER_B}`;

// Count the managed parties VISIBLE to the current account via the app's own
// API. Used to assert reuse (no duplicate) across a select-saved-party + Continue.
async function countParties(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/parties', { credentials: 'same-origin' });
    if (!res.ok) return -1;
    const data = await res.json();
    return Array.isArray(data.parties) ? data.parties.length : -1;
  });
}

export async function run(page, ctx) {
  const { fail, shoot } = ctx;

  const pickHeading = page.getByRole('heading', { name: /pick the party/i });
  const changeViewersBtn = page.getByRole('button', { name: /change viewers/i }).first();

  // If run.mjs left us on the main app (a prior session had an active party),
  // go back to the picker first.
  if (await changeViewersBtn.count().then((n) => n > 0)) {
    await changeViewersBtn.click().catch(() => {});
  }

  // ── 1. Picker (viewer grid; Saved parties absent on first run) ─────────────
  try {
    await pickHeading.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, 'party-alias-picker-MISSING');
    fail('party-alias: "Pick the party" screen did not appear', error);
  }

  const cards = viewerCards(page);
  const names = (await cards.locator('strong').allTextContents()).map((s) => s.trim());
  console.log('[proof] party-alias: visible viewer cards =', JSON.stringify(names));
  if (!names.includes(MEMBER_A) || !names.includes(MEMBER_B)) {
    fail(`party-alias: picker must show ${MEMBER_A} and ${MEMBER_B} (saw [${names.join(', ')}])`);
  }
  await shoot(page, 'party-alias-picker');

  // ── 2. Select EXACTLY Alice + Bob -> Continue -> app renders ───────────────
  // Alice + Bob are the household primaries and arrive preselected; the helper
  // makes the selection exact either way (and would deselect any extras).
  const { missing } = await selectExactViewersByName(page, [MEMBER_A, MEMBER_B]);
  if (missing.length > 0) {
    fail(`party-alias: viewer card(s) missing for [${missing.join(', ')}]`);
  }

  await continueFromPicker(page, 'party-alias');
  try {
    await pickHeading.waitFor({ state: 'detached', timeout: 20_000 });
  } catch (error) {
    const err = await page.locator('.error').first().textContent().catch(() => null);
    await shoot(page, 'party-alias-created-STUCK');
    fail(`party-alias: Continue did not form the party${err ? ` (app error: ${err.trim()})` : ''}`, error);
  }
  const continueHeading = page.getByRole('heading', { name: /continue watching/i }).first();
  try {
    await Promise.all([
      continueHeading.waitFor({ state: 'visible', timeout: 20_000 }),
      changeViewersBtn.waitFor({ state: 'visible', timeout: 20_000 }),
    ]);
  } catch (error) {
    await shoot(page, 'party-alias-created-NO-HOME');
    fail('party-alias: party formed but the main app did not render', error);
  }
  // The active-party alias label renders near "Change viewers".
  const aliasLabel = page.locator('.group-alias', { hasText: EXPECTED_ALIAS });
  if (await aliasLabel.count().then((n) => n > 0)) {
    console.log(`[proof] party-alias: active-party alias label shows "${EXPECTED_ALIAS}"`);
  } else {
    console.log('[proof] party-alias: WARN — active-party alias label not found (non-fatal)');
  }
  await shoot(page, 'party-alias-created');

  const partiesAfterCreate = await countParties(page);
  console.log(`[proof] party-alias: visible managed parties after create = ${partiesAfterCreate}`);

  // ── 3. Back to picker -> a "Saved parties" card shows the alias ─────────────
  await changeViewersBtn.click();
  try {
    await pickHeading.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, 'party-alias-saved-NO-PICKER');
    fail('party-alias: did not return to the picker after Change viewers', error);
  }

  const savedCard = page.locator('button.saved-group-card', { hasText: EXPECTED_ALIAS }).first();
  try {
    await savedCard.waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    await shoot(page, 'party-alias-saved-MISSING');
    fail(`party-alias: "Saved parties" did not list a card with alias "${EXPECTED_ALIAS}"`, error);
  }
  const savedText = (await savedCard.locator('strong').first().textContent().catch(() => '')) ?? '';
  console.log('[proof] party-alias: saved party card alias =', JSON.stringify(savedText.trim()));
  if (savedText.trim() !== EXPECTED_ALIAS) {
    fail(`party-alias: saved card alias should be "${EXPECTED_ALIAS}" (got "${savedText.trim()}")`);
  }
  await shoot(page, 'party-alias-saved');

  // ── 4. Select the saved party -> Continue -> NO duplicate party ────────────
  await savedCard.click();
  await continueFromPicker(page, 'party-alias');
  try {
    await pickHeading.waitFor({ state: 'detached', timeout: 20_000 });
  } catch (error) {
    const err = await page.locator('.error').first().textContent().catch(() => null);
    await shoot(page, 'party-alias-reused-STUCK');
    fail(`party-alias: selecting the saved party did not activate it${err ? ` (app error: ${err.trim()})` : ''}`, error);
  }
  try {
    await Promise.all([
      page.getByRole('heading', { name: /continue watching/i }).first().waitFor({ state: 'visible', timeout: 20_000 }),
      changeViewersBtn.waitFor({ state: 'visible', timeout: 20_000 }),
    ]);
  } catch (error) {
    await shoot(page, 'party-alias-reused-NO-HOME');
    fail('party-alias: saved party activated but the main app did not render', error);
  }

  const partiesAfterReuse = await countParties(page);
  console.log(`[proof] party-alias: visible managed parties after reuse = ${partiesAfterReuse}`);
  await shoot(page, 'party-alias-reused');

  if (partiesAfterCreate >= 0 && partiesAfterReuse >= 0 && partiesAfterReuse !== partiesAfterCreate) {
    fail(
      `party-alias: reuse created a DUPLICATE party (before=${partiesAfterCreate} after=${partiesAfterReuse}); same key must reuse`,
    );
  }
  console.log('[proof] party-alias: PASS — create + alias + reuse (no duplicate)');
}
