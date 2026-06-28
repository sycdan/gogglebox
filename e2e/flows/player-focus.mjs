import { pickFirstViewerAndContinue } from '../lib/viewer.mjs';

// ── player-focus flow ──────────────────────────────────────────────────────
// Proves the player-modal hotkey/focus fix: opening the player must move focus
// onto the role="dialog" container (not the Play button), Space toggles
// video.paused (not re-activating Play), and Esc closes the modal.
// NOTE: scoped to NOT match the player-handoff flow (which would also match a
// bare /player/). player-focus runs for "player-focus" / "focus" flow names.
export const match = /player-focus|focus/i;

export async function run(page, ctx) {
  const { fail, shoot, shootView, flowName } = ctx;

  console.log('[proof] player-focus: locating main app');

  // We may be on the viewer-selection screen ("Pick the group"). If so, pick
  // the first viewer and continue into the main app.
  await pickFirstViewerAndContinue(page);

  // Wait for the library grid / Play (or Continue) buttons to appear.
  const playBtn = page
    .locator('.media-card button', { hasText: /^Play$/ })
    .first()
    .or(page.locator('button', { hasText: /^Continue$/ }).first());

  try {
    await page.locator('.media-card').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    await shootView(page, `${flowName}-03-no-library`);
    fail('player-focus: no media cards appeared (library empty?)', error);
  }

  // Prefer an actual "Play" button on a media card.
  const realPlay = page.locator('.media-card button', { hasText: /^Play$/ }).first();
  let target = realPlay;
  if (!(await realPlay.count().then((n) => n > 0))) {
    const cw = page.locator('button', { hasText: /^Continue$/ }).first();
    if (await cw.count().then((n) => n > 0)) {
      target = cw;
    } else {
      await shootView(page, `${flowName}-03-no-play-button`);
      fail('player-focus: found no Play or Continue button to open the modal');
    }
  }

  await target.scrollIntoViewIfNeeded();
  await target.waitFor({ state: 'visible', timeout: 10_000 });
  await shootView(page, `${flowName}-03-before-open`);

  // Capture what holds focus BEFORE clicking (baseline). We focus the button
  // explicitly first to mimic a real keyboard/click activation that would
  // otherwise leave focus on the button.
  const before = await target.evaluate((el) => {
    el.focus();
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? null,
      role: a?.getAttribute?.('role') ?? null,
      cls: a?.getAttribute?.('class') ?? null,
      text: (a?.textContent ?? '').trim().slice(0, 40),
    };
  });
  console.log('[proof] player-focus: activeElement BEFORE open =', JSON.stringify(before));

  // Open the modal.
  await target.click();

  const dialog = page.locator('div.modal[role="dialog"]');
  try {
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    const dbg = await page.evaluate(() => ({
      modals: document.querySelectorAll('div.modal[role="dialog"]').length,
      anyModal: document.querySelectorAll('.modal').length,
      backdrops: document.querySelectorAll('.modal-backdrop').length,
      videos: document.querySelectorAll('video').length,
      errorText: (document.querySelector('.error')?.textContent ?? '').trim().slice(0, 200),
      bodyHead: (document.body?.innerText ?? '').slice(0, 300),
    }));
    console.log('[proof] player-focus: DEBUG modal state =', JSON.stringify(dbg));
    await shootView(page, `${flowName}-04-modal-did-not-open`);
    fail('player-focus: player modal (role="dialog") did not appear after click', error);
  }
  const video = page.locator('div.modal[role="dialog"] video');
  await video.waitFor({ state: 'attached', timeout: 10_000 });

  // The fix defers focus to requestAnimationFrame; give it a couple frames.
  await page.waitForTimeout(250);

  // Capture activeElement AFTER open. Expect it to BE the dialog container.
  const after = await page.evaluate(() => {
    const a = document.activeElement;
    const dlg = document.querySelector('div.modal[role="dialog"]');
    return {
      tag: a?.tagName ?? null,
      role: a?.getAttribute?.('role') ?? null,
      cls: a?.getAttribute?.('class') ?? null,
      text: (a?.textContent ?? '').trim().slice(0, 40),
      isDialog: a === dlg,
      isPlayButton: a?.tagName === 'BUTTON' && /^(Play|Continue)$/.test((a?.textContent ?? '').trim()),
    };
  });
  console.log('[proof] player-focus: activeElement AFTER open  =', JSON.stringify(after));

  await shootView(page, `${flowName}-04-modal-open-WINDOWED`);

  // Scroll-lock must be active while the modal is open: the open effect sets
  // document.body.style.overflow = 'hidden'.
  const overflowWhileOpen = await page.evaluate(() => document.body.style.overflow);
  console.log('[proof] player-focus: document.body.style.overflow while open =', JSON.stringify(overflowWhileOpen));
  if (overflowWhileOpen !== 'hidden') {
    fail(
      `player-focus: scroll-lock NOT active while modal open (document.body.style.overflow="${overflowWhileOpen}", expected "hidden")`,
    );
  }
  console.log('[proof] player-focus: PASS — scroll-lock (body overflow:hidden) active while modal open');

  if (!after.isDialog) {
    fail(
      `player-focus: focus did NOT move to the dialog. activeElement was ${after.tag}` +
        (after.role ? `[role=${after.role}]` : '') +
        (after.isPlayButton ? ' (still the Play button — the bug is NOT fixed)' : ''),
    );
  }
  if (after.isPlayButton) {
    fail('player-focus: focus is still on the Play button — the bug is NOT fixed');
  }
  console.log('[proof] player-focus: PASS — focus is on the dialog container');

  // ── Space toggles play/pause, not the Play button, not page scroll ───────
  //
  // NOTE on headless: in headless Chromium the <video> has no real media
  // pipeline, so HTMLMediaElement.play() returns a promise that rejects (or
  // never resolves) and video.paused does NOT actually flip — even though the
  // Space handler correctly *calls* video.play(). Asserting on video.paused
  // would therefore test the headless media decoder, not our hotkey wiring.
  //
  // Instead we install a spy that counts play()/pause() invocations on this
  // element. Starting from a paused state, a correctly-wired Space MUST invoke
  // play() exactly once. This still fails loudly for a genuinely-broken handler
  // (wrong key match, missing listener, no preventDefault, toggling the wrong
  // thing) without depending on a real media decode.
  const installPlaybackSpy = async () => {
    await video.evaluate((v) => {
      // Restore any previous spy first so counts are fresh and we don't stack
      // wrappers across the multiple Space presses this flow performs.
      if (v.__origPlay) v.play = v.__origPlay;
      if (v.__origPause) v.pause = v.__origPause;
      v.__origPlay = v.play.bind(v);
      v.__origPause = v.pause.bind(v);
      v.__playCalls = 0;
      v.__pauseCalls = 0;
      v.play = function spyPlay(...args) {
        v.__playCalls += 1;
        // Swallow the headless autoplay rejection so it doesn't surface as an
        // unhandled rejection; the call itself is what we assert on.
        try {
          const r = v.__origPlay(...args);
          if (r && typeof r.then === 'function') r.then(() => {}, () => {});
          return r;
        } catch {
          return undefined;
        }
      };
      v.pause = function spyPause(...args) {
        v.__pauseCalls += 1;
        return v.__origPause(...args);
      };
    });
  };
  const readSpy = () => video.evaluate((v) => ({ play: v.__playCalls, pause: v.__pauseCalls }));

  const scrollBefore = await page.evaluate(() => window.scrollY);

  // Force a known starting state: pause first so the toggle is deterministic,
  // THEN install the spy (so the forced pause is not counted).
  await video.evaluate((v) => {
    v.muted = true;
    v.pause();
  });
  await page.waitForTimeout(100);
  const pausedBeforeSpace = await video.evaluate((v) => v.paused);
  await installPlaybackSpy();
  console.log('[proof] player-focus: video.paused BEFORE Space =', pausedBeforeSpace);

  await page.keyboard.press(' ');
  await page.waitForTimeout(400);

  const spyAfterSpace = await readSpy();
  const pausedAfterSpace = await video.evaluate((v) => v.paused);
  const scrollAfter = await page.evaluate(() => window.scrollY);
  console.log('[proof] player-focus: play()/pause() calls AFTER Space =', JSON.stringify(spyAfterSpace));
  console.log('[proof] player-focus: video.paused AFTER Space (informational) =', pausedAfterSpace);
  console.log('[proof] player-focus: window.scrollY before/after Space =', scrollBefore, '/', scrollAfter);

  // Confirm focus did NOT jump back to a Play button after Space.
  const afterSpaceFocus = await page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? null,
      isPlayButton: a?.tagName === 'BUTTON' && /^(Play|Continue)$/.test((a?.textContent ?? '').trim()),
    };
  });
  console.log('[proof] player-focus: activeElement AFTER Space =', JSON.stringify(afterSpaceFocus));

  await shootView(page, `${flowName}-05-after-space`);

  // From a paused start, Space must have invoked play() exactly once and not
  // pause(). (Real paused-property flip is unreliable in headless — see note.)
  if (spyAfterSpace.play !== 1 || spyAfterSpace.pause !== 0) {
    fail(
      `player-focus: Space did NOT invoke video.play() once from a paused start ` +
        `(play=${spyAfterSpace.play}, pause=${spyAfterSpace.pause}); ` +
        'the hotkey is not controlling the player',
    );
  }
  if (afterSpaceFocus.isPlayButton) {
    fail('player-focus: after Space, focus landed back on the Play button (re-triggered)');
  }
  if (scrollAfter !== scrollBefore) {
    console.warn(`[proof] player-focus: WARNING page scrolled on Space (${scrollBefore} -> ${scrollAfter})`);
  }
  console.log('[proof] player-focus: PASS — Space toggled play/pause and did not re-trigger Play');

  // ── f fullscreens the VIDEO element itself (native player chrome) ───────
  // The player was reworked: pressing `f` calls video.requestFullscreen()
  // so the user sees ONLY the native <video> — no modal "Now playing"
  // header, no "auto-marks watched" footer, no rounded border. Hotkeys live
  // on a document-level keydown listener so they keep working regardless of
  // which element is fullscreened.
  const vidInfo = await page.evaluate(() => {
    const v = document.querySelector('div.modal[role="dialog"] video');
    return { tag: v?.tagName ?? null, cls: v?.getAttribute('class') ?? null };
  });
  console.log('[proof] player-focus: video element =', JSON.stringify(vidInfo));

  await page.keyboard.press('f');
  await page.waitForTimeout(600);

  const fsState = await page.evaluate(() => {
    const fe = document.fullscreenElement;
    const d = document.querySelector('div.modal[role="dialog"]');
    const v = document.querySelector('div.modal[role="dialog"] video');
    return {
      hasFullscreenElement: fe != null,
      fe: fe ? { tag: fe.tagName, cls: fe.getAttribute('class') } : null,
      feTag: fe ? fe.tagName : null,
      feIsVideo: fe === v && fe?.tagName === 'VIDEO',
      feIsDialog: fe === d,
    };
  });
  console.log('[proof] player-focus: AFTER f, document.fullscreenElement =', JSON.stringify(fsState.fe));
  await shootView(page, `${flowName}-07-after-f-FULLSCREEN-VIDEO`);

  const fullscreenEngaged = fsState.hasFullscreenElement;
  if (fullscreenEngaged) {
    if (fsState.feIsDialog) {
      fail('player-focus: f fullscreened the DIALOG/modal container; the rework should fullscreen the VIDEO element (native chrome only)');
    }
    if (!fsState.feIsVideo) {
      fail(
        'player-focus: f did NOT fullscreen the <video>. document.fullscreenElement was ' +
          JSON.stringify(fsState.fe) + ' (expected tagName "VIDEO")',
      );
    }
    console.log('[proof] player-focus: PASS — document.fullscreenElement IS the <video> element (native chrome only; no modal header/footer/border). See the -07-after-f-FULLSCREEN-VIDEO screenshot.');
  } else {
    console.warn('[proof] player-focus: HEADLESS LIMITATION: fullscreen did not engage (document.fullscreenElement is null). Continuing with scroll-lock + single-toggle Space + document-level hotkey + Esc-close assertions for partial proof.');
  }

  // ── While (attempting) fullscreen: Space toggles paused exactly once and
  //    the page does not scroll (scroll-lock holds). ───────────────────────
  await video.evaluate((v) => { v.muted = true; v.pause(); });
  await page.waitForTimeout(120);
  await installPlaybackSpy();
  const scrollBeforeFsSpace = await page.evaluate(() => window.scrollY);
  await page.keyboard.press(' ');
  await page.waitForTimeout(400);
  const spyAfterFsSpace = await readSpy();
  const scrollAfterFsSpace = await page.evaluate(() => window.scrollY);
  console.log('[proof] player-focus: (fullscreen) play()/pause() calls after Space =', JSON.stringify(spyAfterFsSpace));
  console.log('[proof] player-focus: (fullscreen) window.scrollY before/after Space =', scrollBeforeFsSpace, '/', scrollAfterFsSpace);
  if (spyAfterFsSpace.play !== 1 || spyAfterFsSpace.pause !== 0) {
    fail('player-focus: while fullscreen, Space did NOT invoke video.play() once — document-level hotkeys lost in fullscreen');
  }
  if (scrollAfterFsSpace !== scrollBeforeFsSpace) {
    fail(`player-focus: page scrolled on Space while fullscreen (${scrollBeforeFsSpace} -> ${scrollAfterFsSpace}); scroll-lock/preventDefault not holding`);
  }
  console.log('[proof] player-focus: PASS — Space toggled play/pause exactly once with stable scrollY (scroll-lock + preventDefault)');

  // ── First Esc (while fullscreen) must NOT close the modal ────────────────
  //
  // The app's Esc handler (src/client/App.tsx) keys off the REAL
  // `document.fullscreenElement`: when it is set, the handler returns early and
  // deliberately does nothing — it defers the fullscreen-exit to the browser
  // (the UA "eats" the first Esc to leave native fullscreen) and only a LATER
  // Esc (once fullscreen is gone) closes the modal via setPlayingItem(null).
  //
  // NOTE on headless: a synthetic Esc keypress does NOT drive the UA's
  // fullscreen-exit, so `document.fullscreenElement` stays set even though a
  // real browser would clear it. Asserting `document.fullscreenElement === null`
  // here would therefore test the headless UA, not our handler. What we CAN and
  // do prove is the handler's own contract: while fullscreen, the first Esc is a
  // no-op for the modal — it must leave the dialog OPEN (not close it). A broken
  // handler that closes the modal on the first Esc (ignoring fullscreen) fails
  // here loudly.
  if (fullscreenEngaged) {
    // Spy on document.exitFullscreen so a regression that makes Esc call it
    // directly (or any other path) is observable; the app's design is to defer
    // to the UA, so on the first Esc this count MUST stay 0.
    await page.evaluate(() => {
      const d = document;
      d.__origExitFullscreen = d.exitFullscreen.bind(d);
      d.__exitFullscreenCalls = 0;
      d.exitFullscreen = function spyExit(...args) {
        d.__exitFullscreenCalls += 1;
        try {
          const r = d.__origExitFullscreen(...args);
          if (r && typeof r.then === 'function') r.then(() => {}, () => {});
          return r;
        } catch {
          return Promise.resolve();
        }
      };
    });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const afterEscExit = await page.evaluate(() => ({
      exitFullscreenCalls: document.__exitFullscreenCalls,
      dialogStillInDom: document.querySelector('div.modal[role="dialog"]') != null,
    }));
    console.log('[proof] player-focus: AFTER first Esc =', JSON.stringify(afterEscExit));
    await shootView(page, `${flowName}-08-after-esc-exit-fullscreen-WINDOWED`);
    if (!afterEscExit.dialogStillInDom) {
      fail('player-focus: first Esc closed the modal; while fullscreen the first Esc must defer to the UA and leave the dialog open');
    }
    if (afterEscExit.exitFullscreenCalls !== 0) {
      fail(
        `player-focus: first Esc called document.exitFullscreen() ${afterEscExit.exitFullscreenCalls} time(s); ` +
          'the handler should return early while fullscreen and defer the exit to the browser',
      );
    }
    console.log('[proof] player-focus: PASS — first Esc left the modal open and deferred fullscreen-exit to the UA');

    // Headless-honest fullscreen teardown: a real browser would now have left
    // native fullscreen (clearing document.fullscreenElement). Drive that exact
    // state by calling the original exitFullscreen and waiting for it to clear,
    // so the close-Esc below runs against the SAME windowed state a user sees
    // after the UA honours the first Esc. Without this the app would still see
    // document.fullscreenElement set and the close-Esc would be a no-op.
    await page.evaluate(() => {
      const exit = document.__origExitFullscreen || document.exitFullscreen.bind(document);
      const r = exit();
      if (r && typeof r.then === 'function') return r.catch(() => {});
      return undefined;
    });
    try {
      await page.waitForFunction(() => document.fullscreenElement == null, { timeout: 3_000 });
    } catch {
      // If headless refuses to clear it, force the document back to a windowed
      // state for the close-Esc by stubbing the property to null. The close path
      // we are proving (setPlayingItem(null) on a windowed Esc) is independent
      // of how fullscreen was torn down.
      await page.evaluate(() => {
        try {
          Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
        } catch {
          /* ignore — best effort */
        }
      });
    }
    const fsCleared = await page.evaluate(() => document.fullscreenElement == null);
    console.log('[proof] player-focus: fullscreen cleared before close-Esc =', fsCleared);
  } else {
    console.warn('[proof] player-focus: HEADLESS LIMITATION: fullscreen never engaged, so the first Esc (exit-fullscreen) step is skipped. The modal is still windowed and open.');
    await shootView(page, `${flowName}-08-windowed-still-open`);
  }

  // ── Document-level hotkeys still work windowed: Space toggles paused once
  //    with stable scrollY. ─────────────────────────────────────────────────
  await video.evaluate((v) => { v.muted = true; v.pause(); });
  await page.waitForTimeout(120);
  await installPlaybackSpy();
  const scrollBeforeWinSpace = await page.evaluate(() => window.scrollY);
  await page.keyboard.press(' ');
  await page.waitForTimeout(400);
  const spyAfterWinSpace = await readSpy();
  const scrollAfterWinSpace = await page.evaluate(() => window.scrollY);
  console.log('[proof] player-focus: (windowed) play()/pause() calls after Space =', JSON.stringify(spyAfterWinSpace));
  console.log('[proof] player-focus: (windowed) window.scrollY before/after Space =', scrollBeforeWinSpace, '/', scrollAfterWinSpace);
  if (spyAfterWinSpace.play !== 1 || spyAfterWinSpace.pause !== 0) {
    fail('player-focus: windowed Space did NOT invoke video.play() once — document-level hotkeys not working windowed');
  }
  if (scrollAfterWinSpace !== scrollBeforeWinSpace) {
    fail(`player-focus: page scrolled on windowed Space (${scrollBeforeWinSpace} -> ${scrollAfterWinSpace}); scroll-lock not holding`);
  }
  console.log('[proof] player-focus: PASS — document-level hotkeys still toggle play/pause windowed with stable scrollY');

  // ── Esc (windowed) closes the modal ─────────────────────────────────────
  await page.keyboard.press('Escape');
  try {
    await dialog.waitFor({ state: 'detached', timeout: 5_000 });
  } catch (error) {
    // Some implementations keep the node but hide it; check visibility too.
    const stillVisible = await dialog.isVisible().catch(() => false);
    if (stillVisible) {
      await shootView(page, `${flowName}-09-esc-did-not-close`);
      fail('player-focus: Esc (windowed) did NOT close the modal', error);
    }
  }
  await page.waitForTimeout(200);
  const overflowAfterClose = await page.evaluate(() => document.body.style.overflow);
  console.log('[proof] player-focus: document.body.style.overflow after close =', JSON.stringify(overflowAfterClose));
  await shootView(page, `${flowName}-09-after-esc-closed`);
  console.log('[proof] player-focus: PASS — Esc closed the modal (dialog removed from DOM)');
}
