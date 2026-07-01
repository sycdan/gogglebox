import { pickFirstViewerAndContinue } from '../lib/viewer.mjs';

// Proves the current iframe-backed player modal is keyboard-safe:
// opening the player focuses the dialog (not the Play button), locks page scroll,
// renders the Jellyfin iframe, Space does not re-trigger the opener, and Escape
// closes the modal.
export const match = /player-focus|focus/i;

export async function run(page, ctx) {
  const { fail, shootView, flowName } = ctx;

  console.log('[proof] player-focus: locating main app');
  await pickFirstViewerAndContinue(page);

  try {
    await page.locator('.media-card').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shootView(page, `${flowName}-03-no-library`);
    fail('player-focus: no media cards appeared (library empty?)', error);
  }

  const playButton = page
    .locator('.media-card button', { hasText: /^Play$/ })
    .first()
    .or(page.locator('.media-card button', { hasText: /^Resume$/ }).first());

  try {
    await playButton.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await shootView(page, `${flowName}-03-no-play-button`);
    fail('player-focus: found no Play/Resume button to open the modal', error);
  }

  await playButton.scrollIntoViewIfNeeded();
  await shootView(page, `${flowName}-03-before-open`);

  const before = await playButton.evaluate((el) => {
    el.focus();
    const active = document.activeElement;
    return {
      tag: active?.tagName ?? null,
      text: (active?.textContent ?? '').trim().slice(0, 40),
    };
  });
  console.log('[proof] player-focus: activeElement BEFORE open =', JSON.stringify(before));

  await playButton.click();

  const dialog = page.locator('div.modal.player-modal[role="dialog"]');
  try {
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    await dialog.locator('iframe.player-frame').waitFor({ state: 'attached', timeout: 15_000 });
  } catch (error) {
    const dbg = await page.evaluate(() => ({
      playerDialogs: document.querySelectorAll('div.modal.player-modal[role="dialog"]').length,
      modals: document.querySelectorAll('.modal').length,
      iframes: document.querySelectorAll('iframe.player-frame').length,
      errorText: (document.querySelector('.error')?.textContent ?? '').trim().slice(0, 200),
      bodyHead: (document.body?.innerText ?? '').slice(0, 300),
    }));
    console.log('[proof] player-focus: DEBUG modal state =', JSON.stringify(dbg));
    await shootView(page, `${flowName}-04-modal-did-not-open`);
    fail('player-focus: player dialog/iframe did not appear after click', error);
  }

  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const active = document.activeElement;
    const dialogEl = document.querySelector('div.modal.player-modal[role="dialog"]');
    return {
      tag: active?.tagName ?? null,
      role: active?.getAttribute?.('role') ?? null,
      cls: active?.getAttribute?.('class') ?? null,
      isDialog: active === dialogEl,
      isPlayButton: active?.tagName === 'BUTTON' && /^(Play|Resume)$/.test((active?.textContent ?? '').trim()),
      overflow: document.body.style.overflow,
      iframeSrc: document.querySelector('iframe.player-frame')?.getAttribute('src') ?? null,
    };
  });
  console.log('[proof] player-focus: activeElement AFTER open =', JSON.stringify(after));
  await shootView(page, `${flowName}-04-modal-open`);

  if (!after.isDialog) {
    fail('player-focus: focus did not move to the player dialog after open');
  }
  if (after.isPlayButton) {
    fail('player-focus: focus is still on the Play/Resume button');
  }
  if (after.overflow !== 'hidden') {
    fail(`player-focus: body scroll was not locked while modal open (overflow=${JSON.stringify(after.overflow)})`);
  }
  if (!after.iframeSrc || !after.iframeSrc.includes('/player/')) {
    fail(`player-focus: iframe source is not the same-origin /player route (${JSON.stringify(after.iframeSrc)})`);
  }

  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  const afterSpace = await page.evaluate(() => ({
    dialogCount: document.querySelectorAll('div.modal.player-modal[role="dialog"]').length,
    activeIsDialog: document.activeElement === document.querySelector('div.modal.player-modal[role="dialog"]'),
    scrollY: window.scrollY,
  }));
  console.log('[proof] player-focus: AFTER Space =', JSON.stringify(afterSpace));
  await shootView(page, `${flowName}-05-after-space`);

  if (afterSpace.dialogCount !== 1) {
    fail(`player-focus: Space re-triggered or closed the player dialog (dialogCount=${afterSpace.dialogCount})`);
  }
  if (!afterSpace.activeIsDialog) {
    fail('player-focus: Space moved focus away from the player dialog');
  }
  if (afterSpace.scrollY !== scrollBefore) {
    fail(`player-focus: page scrolled on Space (${scrollBefore} -> ${afterSpace.scrollY})`);
  }

  await page.keyboard.press('Escape');
  try {
    await dialog.waitFor({ state: 'detached', timeout: 5_000 });
  } catch (error) {
    await shootView(page, `${flowName}-06-esc-did-not-close`);
    fail('player-focus: Escape did not close the player dialog', error);
  }

  const overflowAfterClose = await page.evaluate(() => document.body.style.overflow);
  console.log('[proof] player-focus: document.body.style.overflow after close =', JSON.stringify(overflowAfterClose));
  await shootView(page, `${flowName}-06-after-esc-closed`);
  if (overflowAfterClose === 'hidden') {
    fail('player-focus: body scroll remained locked after closing the player dialog');
  }

  console.log('[proof] player-focus: PASS - dialog focus, iframe mount, Space safety, and Escape close all work');
}
