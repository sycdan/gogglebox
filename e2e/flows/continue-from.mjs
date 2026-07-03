import { pickEveryoneGroupAndContinue } from '../lib/viewer.mjs';
import { seedStaggeredShow } from '../lib/seed-inprogress.mjs';
import { makeJellyfin } from '../lib/jellyfin.mjs';

// continue-from flow: proves the "Continue from" viewer picker on a
// continue-watching SHOW card. The card defaults to the GROUP pick (earliest
// not-all-watched episode); the picker's per-viewer options let the group
// follow ONE viewer's own progress instead, persisted per group in
// /data/state.json (continueFrom) so it survives a reload.
//
// Seed (staggered): each viewer on a DIFFERENT consecutive episode of one
// series, e.g. Alice:S01E02, Bob:S01E03, Carol:S01E04, Dave:S02E01. Group pick
// = the earliest (Alice's S01E02); the AHEAD viewer (Dave) has a later resume
// point, so selecting Dave must move the card's .meta episode to HIS episode.
// Proof steps: BEFORE (group pick) -> select ahead viewer (AFTER) -> reload
// (PERSIST) -> revert to "Group pick" (REVERT).
export const match = /continue-from|from-picker|continue-source/i;

const rail = (page) => page.locator('.section-block').first();
const cards = (page) => rail(page).locator('.media-card');

// Find the rail card whose `.meta` line CONTAINS `needle` (case-insensitive).
// Show cards put the EPISODE name in <h3> and "SeriesName • SxxEyy" in `.meta`.
async function findCardByMeta(page, needle) {
  const n = await cards(page).count();
  const want = needle.toLowerCase();
  for (let i = 0; i < n; i += 1) {
    const card = cards(page).nth(i);
    const meta = (await card.locator('.meta').first().innerText().catch(() => '')).toLowerCase();
    if (meta.includes(want)) return card;
  }
  return null;
}

const cardMeta = async (card) =>
  (await card.locator('.meta').first().innerText().catch(() => '')).trim();
const codeOf = (meta) => (meta.match(/S\d{2}E\d{2}/) || [])[0] ?? null;

// Poll until the seeded series' card shows `expectedCode` in its .meta,
// re-resolving the card each attempt: the refetch after a picker change
// REMOUNTS the card (its React key includes the item id, which changes when
// the pick moves to another episode), so a held locator would go stale.
async function waitForCardCode(page, seriesName, expectedCode, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastMeta = '(card not found)';
  while (Date.now() < deadline) {
    const card = await findCardByMeta(page, seriesName);
    if (card) {
      lastMeta = await cardMeta(card);
      if (codeOf(lastMeta) === expectedCode) return { card, meta: lastMeta };
    }
    await page.waitForTimeout(400);
  }
  return { card: null, meta: lastMeta };
}

// The card's picker select; null when the card doesn't render one.
async function pickerSelect(card) {
  const select = card.locator('.continue-from select').first();
  return (await select.count()) > 0 ? select : null;
}

// Wait for the app (viewer picker OR main rail) to settle after a fresh load,
// then advance past the group-selection screen with the everyone group.
async function enterEveryoneGroup(page, flowName) {
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Log out' }).first().waitFor({ state: 'visible', timeout: 20_000 });
  await pickEveryoneGroupAndContinue(page, flowName);
  await rail(page).waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

export async function run(page, ctx) {
  const { fail, shoot, flowName, outDir } = ctx;
  const jellyfinEnv = { url: process.env.JELLYFIN_URL, apiKey: process.env.JELLYFIN_API_KEY };

  // Clean slate so only our seeded series sits on the rail (deterministic read).
  try {
    const jf = makeJellyfin(jellyfinEnv.url, jellyfinEnv.apiKey);
    await jf.resetAllPlayedState(console.log);
  } catch (e) {
    console.warn('[proof] continue-from: reset failed: ' + (e?.message ?? e));
  }

  let seed = null;
  try {
    seed = await seedStaggeredShow(jellyfinEnv, {}, console.log);
  } catch (e) {
    console.warn('[proof] continue-from: seed failed: ' + (e?.message ?? e));
  }
  if (!seed) {
    fail('continue-from: could not seed the staggered show fixture (DATA GAP).');
  }

  // Group pick = the earliest staggered episode (viewer 0). Ahead viewer = the
  // last staggered viewer, whose own episode differs from the group pick.
  const groupCode = seed.anchor.code;
  const ahead = [...seed.perViewer].reverse().find((p) => p.code !== groupCode);
  if (!ahead) {
    fail('continue-from: staggered seed produced no viewer ahead of the anchor (DATA GAP).');
  }
  console.log(
    '[proof] continue-from: seeded "' + seed.seriesName + '" viewers at ' +
    seed.perViewer.map((p) => p.userName + ':' + p.code).join(', ') +
    ' | group pick=' + groupCode + ', ahead viewer=' + ahead.userName + ' (' + ahead.code + ').',
  );

  await enterEveryoneGroup(page, flowName);

  try {
    await cards(page).first().waitFor({ state: 'visible', timeout: 12_000 });
  } catch {
    await shoot(page, flowName + '-00-empty-rail');
    fail('continue-from: Continue-watching rail is EMPTY; cannot prove. Seed failed?');
  }

  let card = await findCardByMeta(page, seed.seriesName);
  if (!card) {
    await shoot(page, flowName + '-00-no-show-card');
    fail('continue-from: show card for series "' + seed.seriesName + '" not found on the rail.');
  }

  // A prior run may have left a continueFrom override in /data/state.json for
  // this group+series. Clear it through the UI (select "Group pick") so the
  // BEFORE state is deterministic.
  let select = await pickerSelect(card);
  if (!select) {
    await shoot(page, flowName + '-00-no-picker');
    fail('continue-from: card renders no .continue-from picker — feature not visible.');
  }
  const staleValue = await select.inputValue();
  if (staleValue !== '') {
    console.log('[proof] continue-from: clearing stale override (select value "' + staleValue + '") back to Group pick');
    await select.selectOption('');
    const cleared = await waitForCardCode(page, seed.seriesName, groupCode);
    if (!cleared.card) {
      await shoot(page, flowName + '-00-stale-not-cleared');
      fail('continue-from: card did not return to group pick ' + groupCode + ' after clearing stale override (meta="' + cleared.meta + '").');
    }
    card = cleared.card;
    select = await pickerSelect(card);
  }

  // ── BEFORE: group pick episode + picker options ──────────────────────────
  const beforeMeta = await cardMeta(card);
  const beforeCode = codeOf(beforeMeta);
  const beforeValue = await select.inputValue();
  const optionValues = await select.locator('option').evaluateAll((els) => els.map((el) => el.value));
  const optionLabels = await select.locator('option').allInnerTexts();
  console.log(
    '[proof] continue-from: BEFORE meta="' + beforeMeta + '" select value="' + beforeValue + '" options=' +
    JSON.stringify(optionLabels.map((label, i) => optionValues[i] + ' => ' + label.trim())),
  );

  if (beforeCode !== groupCode) {
    await shoot(page, flowName + '-00-wrong-anchor');
    fail('continue-from: BEFORE card shows ' + beforeCode + ', expected group pick ' + groupCode + '.');
  }
  if (beforeValue !== '') {
    fail('continue-from: BEFORE select value is "' + beforeValue + '", expected "" (Group pick).');
  }
  if (optionValues[0] !== '' || !/^Group pick/i.test((optionLabels[0] ?? '').trim())) {
    fail('continue-from: first option is not the Group pick default (got "' + (optionLabels[0] ?? '') + '").');
  }
  for (const p of seed.perViewer) {
    const idx = optionValues.indexOf(p.userId);
    if (idx < 0) {
      fail('continue-from: no picker option for viewer ' + p.userName + ' (' + p.userId + ').');
    }
    const label = (optionLabels[idx] ?? '').trim();
    if (!label.includes(p.userName) || !label.includes(p.code)) {
      fail('continue-from: option for ' + p.userName + ' reads "' + label + '", expected name + own resume point ' + p.code + '.');
    }
    console.log('[proof] continue-from: option OK — "' + label + '" (value=' + p.userId + ')');
  }
  console.log('[proof] continue-from: PASS — BEFORE state: group pick ' + groupCode + ' with per-viewer options for all ' + seed.perViewer.length + ' viewers.');

  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await shoot(page, flowName + '-01-before-group-pick');
  await card.screenshot({ path: `${outDir}/${flowName}-01-before-card-closeup.png` });
  console.log(`[proof] screenshot: ${outDir}/${flowName}-01-before-card-closeup.png`);

  // ── AFTER: select the ahead viewer, card follows THEIR episode ───────────
  console.log('[proof] continue-from: selecting ahead viewer ' + ahead.userName + ' — expecting card to move ' + groupCode + ' -> ' + ahead.code);
  await select.selectOption(ahead.userId);
  const after = await waitForCardCode(page, seed.seriesName, ahead.code);
  if (!after.card) {
    await shoot(page, flowName + '-02-no-viewer-episode');
    fail('continue-from: after selecting ' + ahead.userName + ', card never showed their episode ' + ahead.code + ' (meta="' + after.meta + '").');
  }
  card = after.card;
  select = await pickerSelect(card);
  const afterValue = select ? await select.inputValue() : '(no picker)';
  console.log('[proof] continue-from: AFTER meta="' + after.meta + '" select value="' + afterValue + '"');
  if (afterValue !== ahead.userId) {
    fail('continue-from: AFTER select value is "' + afterValue + '", expected ' + ahead.userName + ' (' + ahead.userId + ').');
  }
  console.log('[proof] continue-from: PASS — card follows ' + ahead.userName + '\'s own next episode ' + ahead.code + ' instead of the group pick.');

  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await shoot(page, flowName + '-02-after-viewer-pick');
  await card.screenshot({ path: `${outDir}/${flowName}-02-after-card-closeup.png` });
  console.log(`[proof] screenshot: ${outDir}/${flowName}-02-after-card-closeup.png`);

  // ── PERSIST: reload — the per-group override must survive ────────────────
  console.log('[proof] continue-from: reloading page to prove persistence (state.json continueFrom)');
  await page.reload({ waitUntil: 'networkidle' });
  await enterEveryoneGroup(page, flowName);
  const persisted = await waitForCardCode(page, seed.seriesName, ahead.code);
  if (!persisted.card) {
    await shoot(page, flowName + '-03-not-persisted');
    fail('continue-from: after reload, card no longer shows ' + ahead.userName + '\'s episode ' + ahead.code + ' (meta="' + persisted.meta + '") — override did not persist.');
  }
  card = persisted.card;
  select = await pickerSelect(card);
  const persistValue = select ? await select.inputValue() : '(no picker)';
  console.log('[proof] continue-from: PERSIST meta="' + persisted.meta + '" select value="' + persistValue + '"');
  if (persistValue !== ahead.userId) {
    fail('continue-from: after reload, select value is "' + persistValue + '", expected ' + ahead.userName + ' (' + ahead.userId + ').');
  }
  console.log('[proof] continue-from: PASS — selection persisted across reload (select=' + ahead.userName + ', episode ' + ahead.code + ').');

  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await shoot(page, flowName + '-03-persist-after-reload');
  await card.screenshot({ path: `${outDir}/${flowName}-03-persist-card-closeup.png` });
  console.log(`[proof] screenshot: ${outDir}/${flowName}-03-persist-card-closeup.png`);

  // ── REVERT: back to "Group pick" — card returns to the earlier episode ───
  console.log('[proof] continue-from: reverting to Group pick — expecting card to move ' + ahead.code + ' -> ' + groupCode);
  await select.selectOption('');
  const reverted = await waitForCardCode(page, seed.seriesName, groupCode);
  if (!reverted.card) {
    await shoot(page, flowName + '-04-not-reverted');
    fail('continue-from: after reverting to Group pick, card never returned to ' + groupCode + ' (meta="' + reverted.meta + '").');
  }
  card = reverted.card;
  select = await pickerSelect(card);
  const revertValue = select ? await select.inputValue() : '(no picker)';
  console.log('[proof] continue-from: REVERT meta="' + reverted.meta + '" select value="' + revertValue + '"');
  if (revertValue !== '') {
    fail('continue-from: after revert, select value is "' + revertValue + '", expected "" (Group pick).');
  }

  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await shoot(page, flowName + '-04-revert-group-pick');
  await card.screenshot({ path: `${outDir}/${flowName}-04-revert-card-closeup.png` });
  console.log(`[proof] screenshot: ${outDir}/${flowName}-04-revert-card-closeup.png`);

  console.log(
    '[proof] continue-from: ALL PASS — group pick ' + groupCode + ' -> ' + ahead.userName + '\'s ' + ahead.code +
    ' (select) -> persisted across reload -> reverted to ' + groupCode + '.',
  );
}
