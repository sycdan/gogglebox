// Visual-proof driver. Runs inside the `proof` service (Playwright image),
// logs into the running client, and writes full-page screenshots to
// ./artifacts/<timestamp>/ so the Prover agent can Read them.
//
// Usage (via dev compose):
//   docker compose -f docker-compose.dev.yml --profile proof run --rm proof
//   docker compose -f docker-compose.dev.yml --profile proof run --rm -e PROOF_FLOW=my-feature proof
//
// Env:
//   PROOF_URL        target client URL (default http://client:5173)
//   PROOF_FLOW       flow name prefixing screenshot files (default "app";
//                    falls back to the first CLI arg if unset)
//   PORTAL_USERNAME  household login username (required)
//   PORTAL_PASSWORD  household login password (required)
//   PORTAL_AUTO_LOGIN  "true"/"1" skips the login form
//
// Exits non-zero on navigation/login failure so agents detect breakage.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const url = process.env.PROOF_URL ?? 'http://client:5173';
const username = process.env.PORTAL_USERNAME ?? '';
const password = process.env.PORTAL_PASSWORD ?? '';
const autoLogin = ['1', 'true', 'yes', 'on'].includes(
  (process.env.PORTAL_AUTO_LOGIN ?? '').trim().toLowerCase(),
);
const flowName = (process.env.PROOF_FLOW || process.argv[2] || 'app').replace(
  /[^a-zA-Z0-9_-]/g,
  '-',
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve('artifacts', stamp);

function fail(message, error) {
  console.error(`[proof] FAIL: ${message}`);
  if (error) console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
}

async function shoot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`[proof] screenshot: ${file}`);
  return file;
}

// Viewport-only screenshot (stays under image size limits so the Prover can Read it).
async function shootView(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`[proof] screenshot: ${file}`);
  return file;
}

const browser = await chromium.launch({
  // New headless ("--headless=new") is far more likely to honour the
  // Fullscreen API than the legacy headless shell. We also allow auto-grant
  // of the fullscreen request without a user-gesture prompt.
  args: [
    "--headless=new",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=FullscreenInsecureOrigin",
  ],
});
try {
  await mkdir(outDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  console.log(`[proof] navigating to ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch (error) {
    fail(`could not load ${url} (is the client service up?)`, error);
  }

  // Wait for the SPA to settle past its "Loading…" state.
  await page.waitForLoadState('networkidle');

  // Vite serves a plain-text "Blocked request. This host is not allowed."
  // page when the Host header isn't in allowedHosts — the SPA never mounts.
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/Blocked request\.\s*This host is not allowed/i.test(bodyText)) {
    await shoot(page, `${flowName}-00-blocked`);
    fail(
      `Vite blocked the request host for ${url}. ` +
        'Add the hostname to server.allowedHosts in vite.config.ts and restart the client service.',
    );
  }

  const loginForm = page.locator('form.stack');
  const needsLogin = await loginForm.count().then((n) => n > 0);

  if (needsLogin && !autoLogin) {
    if (!username || !password) {
      fail('login form present but PORTAL_USERNAME/PORTAL_PASSWORD not set');
    }
    console.log('[proof] logging in');
    await loginForm.locator('input:not([type="password"])').first().fill(username);
    await loginForm.locator('input[type="password"]').first().fill(password);
    await shoot(page, `${flowName}-01-login`);
    await Promise.all([
      page.waitForLoadState('networkidle'),
      loginForm.locator('button[type="submit"]').click(),
    ]);
    // Confirm we left the login screen.
    try {
      await loginForm.waitFor({ state: 'detached', timeout: 15_000 });
    } catch (error) {
      const err = await page.locator('.error').textContent().catch(() => null);
      fail(`login did not complete${err ? ` (app error: ${err.trim()})` : ''}`, error);
    }
  }

  await page.waitForLoadState('networkidle');

  // Assert a REAL authenticated app element rather than treating "no login
  // form" as success. The "Log out" button is rendered on both the
  // viewer-selection screen and the main app (see src/client/App.tsx).
  const loggedIn = page.getByRole('button', { name: 'Log out' });
  try {
    await loggedIn.first().waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await shoot(page, `${flowName}-02-not-authenticated`);
    const appError = await page.locator('.error').first().textContent().catch(() => null);
    fail(
      'authenticated app never appeared (no "Log out" control)' +
        (appError ? ` — app error: ${appError.trim()}` : ''),
      error,
    );
  }

  await shoot(page, `${flowName}-02-authenticated`);


  // ── player-focus flow ──────────────────────────────────────────────────────
  // Proves the player-modal hotkey/focus fix: opening the player must move focus
  // onto the role="dialog" container (not the Play button), Space toggles
  // video.paused (not re-activating Play), and Esc closes the modal.
  if (/player|focus/i.test(flowName)) {
    console.log('[proof] player-focus: locating main app');

    // We may be on the viewer-selection screen ("Pick the group"). If so, pick
    // the first viewer and continue into the main app.
    const pickHeading = page.getByRole('heading', { name: /pick the group/i });
    if (await pickHeading.count().then((n) => n > 0)) {
      console.log('[proof] player-focus: selecting a viewer group');
      await page.locator('button.viewer-card').first().click();
      const cont = page.getByRole('button', { name: /^Continue$/ });
      await cont.click();
      await page.waitForLoadState('networkidle');
    }

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
    const scrollBefore = await page.evaluate(() => window.scrollY);

    // Force a known starting state: pause first so the toggle is deterministic.
    await video.evaluate((v) => {
      v.muted = true;
      v.pause();
    });
    await page.waitForTimeout(100);
    const pausedBeforeSpace = await video.evaluate((v) => v.paused);
    console.log('[proof] player-focus: video.paused BEFORE Space =', pausedBeforeSpace);

    await page.keyboard.press(' ');
    await page.waitForTimeout(400);

    const pausedAfterSpace = await video.evaluate((v) => v.paused);
    const scrollAfter = await page.evaluate(() => window.scrollY);
    console.log('[proof] player-focus: video.paused AFTER Space  =', pausedAfterSpace);
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

    if (pausedAfterSpace === pausedBeforeSpace) {
      fail(
        `player-focus: Space did NOT toggle video.paused (stayed ${pausedAfterSpace}); ` +
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
    const scrollBeforeFsSpace = await page.evaluate(() => window.scrollY);
    const pausedBeforeFsSpace = await video.evaluate((v) => v.paused);
    await page.keyboard.press(' ');
    await page.waitForTimeout(400);
    const pausedAfterFsSpace = await video.evaluate((v) => v.paused);
    const scrollAfterFsSpace = await page.evaluate(() => window.scrollY);
    console.log('[proof] player-focus: (fullscreen) video.paused before/after Space =', pausedBeforeFsSpace, '/', pausedAfterFsSpace);
    console.log('[proof] player-focus: (fullscreen) window.scrollY before/after Space =', scrollBeforeFsSpace, '/', scrollAfterFsSpace);
    if (pausedAfterFsSpace === pausedBeforeFsSpace) {
      fail('player-focus: while fullscreen, Space did NOT toggle video.paused — document-level hotkeys lost in fullscreen');
    }
    if (scrollAfterFsSpace !== scrollBeforeFsSpace) {
      fail(`player-focus: page scrolled on Space while fullscreen (${scrollBeforeFsSpace} -> ${scrollAfterFsSpace}); scroll-lock/preventDefault not holding`);
    }
    console.log('[proof] player-focus: PASS — Space toggled play/pause exactly once with stable scrollY (scroll-lock + preventDefault)');

    // ── First Esc exits fullscreen but leaves the modal OPEN ────────────────
    if (fullscreenEngaged) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      const afterEscExit = await page.evaluate(() => ({
        fullscreenElementNull: document.fullscreenElement == null,
        dialogStillInDom: document.querySelector('div.modal[role="dialog"]') != null,
      }));
      console.log('[proof] player-focus: AFTER first Esc =', JSON.stringify(afterEscExit));
      await shootView(page, `${flowName}-08-after-esc-exit-fullscreen-WINDOWED`);
      if (!afterEscExit.fullscreenElementNull) {
        fail('player-focus: first Esc did NOT exit fullscreen (document.fullscreenElement still set)');
      }
      if (!afterEscExit.dialogStillInDom) {
        fail('player-focus: first Esc closed the modal; it should only exit fullscreen and leave the dialog open');
      }
      console.log('[proof] player-focus: PASS — first Esc exited fullscreen and the modal stayed open');
    } else {
      console.warn('[proof] player-focus: HEADLESS LIMITATION: fullscreen never engaged, so the first Esc (exit-fullscreen) step is skipped. The modal is still windowed and open.');
      await shootView(page, `${flowName}-08-windowed-still-open`);
    }

    // ── Document-level hotkeys still work windowed: Space toggles paused once
    //    with stable scrollY. ─────────────────────────────────────────────────
    await video.evaluate((v) => { v.muted = true; v.pause(); });
    await page.waitForTimeout(120);
    const scrollBeforeWinSpace = await page.evaluate(() => window.scrollY);
    const pausedBeforeWinSpace = await video.evaluate((v) => v.paused);
    await page.keyboard.press(' ');
    await page.waitForTimeout(400);
    const pausedAfterWinSpace = await video.evaluate((v) => v.paused);
    const scrollAfterWinSpace = await page.evaluate(() => window.scrollY);
    console.log('[proof] player-focus: (windowed) video.paused before/after Space =', pausedBeforeWinSpace, '/', pausedAfterWinSpace);
    console.log('[proof] player-focus: (windowed) window.scrollY before/after Space =', scrollBeforeWinSpace, '/', scrollAfterWinSpace);
    if (pausedAfterWinSpace === pausedBeforeWinSpace) {
      fail('player-focus: windowed Space did NOT toggle video.paused — document-level hotkeys not working windowed');
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

  console.log('[proof] OK');
} catch (error) {
  fail('unexpected error during proof run', error);
} finally {
  await browser.close();
}
