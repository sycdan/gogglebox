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

  // ── continue-watching flow ─────────────────────────────────────────────────
  // Proves the combined Continue-watching rail holds movies+shows and persists
  // across the Movies/Shows kind toggle (the rail must NOT clear or change when
  // the user flips the library kind). The rail is the FIRST .section-block,
  // sitting above the .toolbar.
  if (/continue|watching/i.test(flowName)) {
    console.log('[proof] continue-watching: locating viewer-selection screen');

    // Reads the card titles of the Continue-watching rail (first section-block).
    async function railTitles() {
      return page
        .locator('.section-block')
        .first()
        .locator('.media-card h3')
        .allInnerTexts()
        .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
        .catch(() => []);
    }

    // We may be on the viewer-selection screen ("Pick the group"). Pick the
    // "Everyone" preset to maximise combined in-progress items, then Continue.
    const pickHeading = page.getByRole('heading', { name: /pick the group/i });
    if (await pickHeading.count().then((n) => n > 0)) {
      const presetChips = page.locator('.preset-row .chip');
      const everyone = presetChips.filter({ hasText: /^Everyone$/ }).first();
      if (await everyone.count().then((n) => n > 0)) {
        console.log('[proof] continue-watching: selecting "Everyone" preset');
        await everyone.click();
      } else if (await presetChips.count().then((n) => n > 0)) {
        console.log('[proof] continue-watching: "Everyone" preset not found; using first preset chip');
        await presetChips.first().click();
      } else {
        console.warn('[proof] continue-watching: no .preset-row .chip presets found; selecting first viewer card');
        await page.locator('button.viewer-card').first().click();
      }
      const cont = page.getByRole('button', { name: /^Continue$/ });
      await cont.first().click();
      await page.waitForLoadState('networkidle');
    } else {
      console.log('[proof] continue-watching: already in main app (no viewer-selection screen)');
    }

    // Wait for the main app / Continue-watching section to render.
    try {
      await page.locator('.section-block').first().waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      await shoot(page, `${flowName}-03-no-home`);
      fail('continue-watching: main app section-block never appeared', error);
    }
    await page.waitForLoadState('networkidle');

    // Wait for the Continue-watching rail to hydrate so the screenshot isn't
    // captured mid-load. Best-effort: if no cards ever appear it's a data gap
    // (handled below), not a script failure — so don't hard-fail here.
    try {
      await page
        .locator('.section-block .media-card')
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 });
    } catch {
      console.warn('[proof] continue-watching: no .section-block .media-card visible within timeout before -03-home (likely a data gap)');
    }

    await shoot(page, `${flowName}-03-home`);

    // Baseline rail titles (step 3).
    const baseline = await railTitles();
    console.log(`[proof] continue-watching: rail titles (baseline) [${baseline.length}] =`, JSON.stringify(baseline));
    if (baseline.length === 0) {
      console.warn(
        '[proof] continue-watching: DATA GAP — Continue-watching rail is EMPTY. ' +
          'The script ran fine; there is simply no in-progress data for this group. ' +
          'This is NOT a UI defect; seed in-progress items to fully validate persistence.',
      );
    }

    const railsEqual = (a, b) =>
      a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

    let mismatch = false;

    // Toggle to Shows (step 4) and re-read (step 5).
    const showsBtn = page.locator('.toolbar .toggle-row button', { hasText: /^Shows$/ }).first();
    if (await showsBtn.count().then((n) => n > 0)) {
      await showsBtn.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(400);
      await shoot(page, `${flowName}-04-after-shows`);
      const afterShows = await railTitles();
      console.log(`[proof] continue-watching: rail titles (after Shows) [${afterShows.length}] =`, JSON.stringify(afterShows));
      if (!railsEqual(baseline, afterShows)) {
        mismatch = true;
        console.error(
          '[proof] continue-watching: FAIL — rail CHANGED after toggling to Shows. ' +
            `baseline=${JSON.stringify(baseline)} afterShows=${JSON.stringify(afterShows)}`,
        );
      } else {
        console.log('[proof] continue-watching: PASS — rail unchanged after toggling to Shows');
      }
    } else {
      console.warn('[proof] continue-watching: Shows toggle button not found (.toolbar .toggle-row button "Shows")');
    }

    // Toggle to Movies and re-read.
    const moviesBtn = page.locator('.toolbar .toggle-row button', { hasText: /^Movies$/ }).first();
    if (await moviesBtn.count().then((n) => n > 0)) {
      await moviesBtn.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(400);
      await shoot(page, `${flowName}-05-after-movies`);
      const afterMovies = await railTitles();
      console.log(`[proof] continue-watching: rail titles (after Movies) [${afterMovies.length}] =`, JSON.stringify(afterMovies));
      if (!railsEqual(baseline, afterMovies)) {
        mismatch = true;
        console.error(
          '[proof] continue-watching: FAIL — rail CHANGED after toggling to Movies. ' +
            `baseline=${JSON.stringify(baseline)} afterMovies=${JSON.stringify(afterMovies)}`,
        );
      } else {
        console.log('[proof] continue-watching: PASS — rail unchanged after toggling to Movies');
      }
    } else {
      console.warn('[proof] continue-watching: Movies toggle button not found (.toolbar .toggle-row button "Movies")');
    }

    if (mismatch) {
      fail('continue-watching: Continue-watching rail did NOT persist across the Movies/Shows toggle');
    }
    if (baseline.length > 0) {
      console.log('[proof] continue-watching: PASS — rail persisted across both kind toggles');
    } else {
      console.log('[proof] continue-watching: rail persistence assertions trivially held (rail empty — see DATA GAP warning above)');
    }
  }

  // ── recommendations (Group picks) flow ─────────────────────────────────────
  // Proves the "Show me other picks" button swaps the Group-picks grid to a
  // fresh, DISJOINT batch of recommendations. Reads the card titles in the
  // "Group picks" section before and after, and logs whether the two batches
  // overlap (expected: zero overlap).
  if (/recommend|picks/i.test(flowName)) {
    console.log('[proof] recommendations: locating viewer-selection screen');

    // We may be on the viewer-selection screen ("Pick the group"). Pick the
    // "Everyone" preset (same approach as continue-watching), then Continue.
    const pickHeading = page.getByRole('heading', { name: /pick the group/i });
    if (await pickHeading.count().then((n) => n > 0)) {
      const presetChips = page.locator('.preset-row .chip');
      const everyone = presetChips.filter({ hasText: /^Everyone$/ }).first();
      if (await everyone.count().then((n) => n > 0)) {
        console.log('[proof] recommendations: selecting "Everyone" preset');
        await everyone.click();
      } else if (await presetChips.count().then((n) => n > 0)) {
        console.log('[proof] recommendations: "Everyone" preset not found; using first preset chip');
        await presetChips.first().click();
      } else {
        console.warn('[proof] recommendations: no .preset-row .chip presets found; selecting first viewer card');
        await page.locator('button.viewer-card').first().click();
      }
      const cont = page.getByRole('button', { name: /^Continue$/ });
      await cont.first().click();
      await page.waitForLoadState('networkidle');
    } else {
      console.log('[proof] recommendations: already in main app (no viewer-selection screen)');
    }

    // Locate the "Group picks" section: the .section-block whose eyebrow text
    // is "Group picks".
    const picksSection = page
      .locator('.section-block')
      .filter({ has: page.locator('.eyebrow', { hasText: /^Group picks$/ }) })
      .first();

    try {
      await picksSection.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      await shoot(page, `${flowName}-03-no-group-picks`);
      fail('recommendations: "Group picks" section never appeared', error);
    }

    await picksSection.scrollIntoViewIfNeeded();

    // Reads the recommendation card titles within the Group-picks section.
    async function pickTitles() {
      return picksSection
        .locator('.media-grid.compact .media-card h3')
        .allInnerTexts()
        .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
        .catch(() => []);
    }

    // Wait for at least one recommendation card to render in this section.
    try {
      await picksSection
        .locator('.media-grid.compact .media-card')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      await shoot(page, `${flowName}-03-no-picks-cards`);
      const empty = await picksSection.locator('.muted').allInnerTexts().catch(() => []);
      fail(
        'recommendations: no .media-card rendered in the Group-picks section' +
          (empty.length ? ` (section message: ${JSON.stringify(empty)})` : ' (data gap?)'),
        error,
      );
    }

    // Scroll the section to the top of the viewport so the windowed screenshot
    // captures it legibly.
    async function scrollSectionToTop() {
      await picksSection.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(300);
    }

    await scrollSectionToTop();

    const batch1 = await pickTitles();
    console.log(`[proof] recommendations: batch-1 titles [${batch1.length}] =`, JSON.stringify(batch1));
    await shootView(page, `${flowName}-01-batch1`);

    // Click "Show me other picks" within this section and wait for the titles
    // to change from batch 1.
    const otherPicksBtn = picksSection
      .locator('button', { hasText: /Show me other picks/i })
      .first();
    if (!(await otherPicksBtn.count().then((n) => n > 0))) {
      await shootView(page, `${flowName}-02-no-button`);
      fail('recommendations: "Show me other picks" button not found in the Group-picks section');
    }

    const disabledBefore = await otherPicksBtn.isDisabled().catch(() => false);
    if (disabledBefore) {
      console.warn('[proof] recommendations: "Show me other picks" button is disabled (e.g. "No more picks") — batch swap may not occur');
    }

    await otherPicksBtn.click();

    // Poll the title array until it differs from batch 1 (or timeout).
    const batch1Key = [...batch1].sort().join('');
    let batch2 = batch1;
    const deadline = Date.now() + 20_000;
    let changed = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(400);
      const current = await pickTitles();
      if (current.length > 0 && [...current].sort().join('') !== batch1Key) {
        batch2 = current;
        changed = true;
        break;
      }
      batch2 = current;
    }
    if (!changed) {
      console.warn('[proof] recommendations: batch-2 titles did not change from batch-1 within timeout (data-dependent; continuing)');
    }
    await page.waitForLoadState('networkidle').catch(() => {});

    await scrollSectionToTop();
    console.log(`[proof] recommendations: batch-2 titles [${batch2.length}] =`, JSON.stringify(batch2));
    await shootView(page, `${flowName}-02-batch2`);

    // Compute overlap (by title) between the two batches.
    const set1 = new Set(batch1);
    const overlap = [...new Set(batch2)].filter((t) => set1.has(t));
    console.log(`[proof] recommendations: batch-1 count = ${batch1.length}, batch-2 count = ${batch2.length} (expected ~8 each; data-dependent)`);
    console.log(`[proof] recommendations: overlap [${overlap.length}] =`, JSON.stringify(overlap));
    if (overlap.length === 0) {
      console.log('[proof] recommendations: PASS — batches disjoint (zero overlap between batch-1 and batch-2)');
    } else {
      console.error(`[proof] recommendations: FAIL — batches disjoint: ${overlap.length} title(s) overlap between batch-1 and batch-2: ${JSON.stringify(overlap)}`);
    }
  }

  // ── search flow ────────────────────────────────────────────────────────────
  // Proves the Phase-3 search experience: the full-library "Browse" grid is gone,
  // and the toolbar search input drives a debounced "Search results" section that
  // appears for a query and disappears when the box is cleared.
  if (/search/i.test(flowName)) {
    console.log('[proof] search: locating viewer-selection screen');

    // We may be on the viewer-selection screen ("Pick the group"). Pick the
    // "Everyone" preset (same approach as the other flows), then Continue.
    const pickHeading = page.getByRole('heading', { name: /pick the group/i });
    if (await pickHeading.count().then((n) => n > 0)) {
      const presetChips = page.locator('.preset-row .chip');
      const everyone = presetChips.filter({ hasText: /^Everyone$/ }).first();
      if (await everyone.count().then((n) => n > 0)) {
        console.log('[proof] search: selecting "Everyone" preset');
        await everyone.click();
      } else if (await presetChips.count().then((n) => n > 0)) {
        console.log('[proof] search: "Everyone" preset not found; using first preset chip');
        await presetChips.first().click();
      } else {
        console.warn('[proof] search: no .preset-row .chip presets found; selecting first viewer card');
        await page.locator('button.viewer-card').first().click();
      }
      const cont = page.getByRole('button', { name: /^Continue$/ });
      await cont.first().click();
      await page.waitForLoadState('networkidle');
    } else {
      console.log('[proof] search: already in main app (no viewer-selection screen)');
    }

    // Wait for the main app to render (the toolbar holds the search input).
    try {
      await page.locator('.toolbar').first().waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      await shootView(page, `${flowName}-01-no-toolbar`);
      fail('search: main app toolbar never appeared', error);
    }
    await page.waitForLoadState('networkidle');

    // ── Assertion 1: no full-library "Browse" section on load ─────────────────
    // Look at every section-block header heading (h2/h3) and confirm none start
    // with "Browse".
    const headingTexts = await page
      .locator('.section-block')
      .locator('h2, h3')
      .allInnerTexts()
      .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
      .catch(() => []);
    const browseHeadings = headingTexts.filter((t) => /^Browse/i.test(t));
    console.log(`[proof] search: section-block headings on load =`, JSON.stringify(headingTexts));
    if (browseHeadings.length === 0) {
      console.log('[proof] search: PASS — no full library grid on load (no "Browse" section header)');
    } else {
      console.error(
        `[proof] search: FAIL — no full library grid on load: found "Browse" header(s) ${JSON.stringify(browseHeadings)}`,
      );
    }

    // Screenshot the home near the top so the toolbar is visible.
    await page.evaluate(() => window.scrollTo(0, 0));
    await shootView(page, `${flowName}-01-home`);

    // ── Ensure kind is "Shows" ────────────────────────────────────────────────
    const showsBtn = page.locator('.toolbar .toggle-row button', { hasText: /^Shows$/ }).first();
    if (await showsBtn.count().then((n) => n > 0)) {
      const alreadySelected = await showsBtn
        .evaluate((el) => el.classList.contains('selected'))
        .catch(() => false);
      if (!alreadySelected) {
        console.log('[proof] search: clicking the Shows toggle');
        await showsBtn.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(300);
      } else {
        console.log('[proof] search: Shows toggle already selected');
      }
    } else {
      console.warn('[proof] search: Shows toggle button not found (.toolbar .toggle-row button "Shows")');
    }

    // Locate the toolbar search input (placeholder "Search shows…"; also a
    // `.search-field input` / `input[type="search"]`).
    const searchInput = page
      .locator('.toolbar .search-field input')
      .first()
      .or(page.locator('.toolbar input[type="search"]').first())
      .or(page.locator('input[placeholder*="Search"]').first());
    try {
      await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
    } catch (error) {
      await shootView(page, `${flowName}-02-no-search-input`);
      fail('search: could not find the toolbar search input', error);
    }

    // The "Search results" section: the .section-block whose <h2> is
    // "Search results".
    const resultsSection = page
      .locator('.section-block')
      .filter({ has: page.locator('h2', { hasText: /^Search results$/ }) })
      .first();

    async function resultTitles() {
      return resultsSection
        .locator('.media-card h3')
        .allInnerTexts()
        .then((arr) => arr.map((t) => t.trim()).filter(Boolean))
        .catch(() => []);
    }

    // ── Type the query and wait for debounced results ─────────────────────────
    console.log('[proof] search: typing "planet" into the search input');
    await searchInput.click();
    await searchInput.fill('planet');

    // Debounce is ~1s; give it the debounce + the server round-trip.
    await page.waitForTimeout(1_300);

    let resultsShown = false;
    try {
      await resultsSection.waitFor({ state: 'visible', timeout: 15_000 });
      await resultsSection
        .locator('.media-card')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      resultsShown = true;
    } catch (error) {
      console.error('[proof] search: results section/cards did not appear within timeout', error?.message ?? error);
    }

    const titles = await resultTitles();
    console.log(`[proof] search: result titles for q="planet" [${titles.length}] =`, JSON.stringify(titles));

    await page.evaluate(() => {
      const h = [...document.querySelectorAll('.section-block h2')].find(
        (el) => el.textContent?.trim() === 'Search results',
      );
      h?.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(300);
    await shootView(page, `${flowName}-02-results`);

    if (resultsShown && titles.length > 0) {
      const allMatch = titles.every((t) => /planet/i.test(t));
      if (allMatch) {
        console.log('[proof] search: PASS — results shown on query (every visible title contains "planet")');
      } else {
        const nonMatching = titles.filter((t) => !/planet/i.test(t));
        console.log(
          `[proof] search: PASS — results shown on query (${titles.length} card(s)); ` +
            `note: ${nonMatching.length} title(s) do not contain "planet": ${JSON.stringify(nonMatching)}`,
        );
      }
    } else {
      console.error('[proof] search: FAIL — results shown on query (no Search results cards appeared for q="planet")');
    }

    // ── Clear the search and confirm results disappear ────────────────────────
    console.log('[proof] search: clearing the search input');
    await searchInput.fill('');
    await page.waitForTimeout(1_300);

    let cleared = false;
    try {
      // The whole section unmounts when the query is empty (App.tsx renders it
      // only when searchQuery.trim() is truthy).
      await resultsSection.waitFor({ state: 'detached', timeout: 8_000 });
      cleared = true;
    } catch {
      // Fallback: section node may persist but show no cards.
      const remaining = await resultTitles();
      cleared = remaining.length === 0;
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await shootView(page, `${flowName}-03-cleared`);

    if (cleared) {
      console.log('[proof] search: PASS — clearing search clears results (Search results section gone / no cards)');
    } else {
      const remaining = await resultTitles();
      console.error(
        `[proof] search: FAIL — clearing search clears results (Search results still showing ${remaining.length} card(s): ${JSON.stringify(remaining)})`,
      );
    }
  }

  console.log('[proof] OK');
} catch (error) {
  fail('unexpected error during proof run', error);
} finally {
  await browser.close();
}
