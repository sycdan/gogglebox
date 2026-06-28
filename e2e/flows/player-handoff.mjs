import { seedInProgressEpisode } from '../lib/seed-inprogress.mjs';

// ── player-handoff flow ─────────────────────────────────────────────────────
// Proves the Stage A "Gogglebox as front-door" browser auto-login handoff:
//
//   gbx serves the client at / and Jellyfin-web at /player on the SAME ORIGIN
//   (the Caddy proxy, http://proxy:8080). Because localStorage is per-ORIGIN,
//   the gbx client can seed Jellyfin-web's credentials (jellyfin_credentials,
//   _deviceId2, enableAutoLogin) for that origin, so opening /player in a NEW
//   TAB auto-logs-in as the gbx-controlled per-group Jellyfin user — no manual
//   Jellyfin login form.
//
// Steps:
//   1. (Caller runs us against http://proxy:8080 — see run command in CLAUDE.md.)
//   2. Select the "parents" (Alice + Bob) viewer group.
//   3. Trigger the play affordance -> POST /api/player/session, seed localStorage,
//      window.open('/player...', '_blank'). Capture the popup page.
//   4. On the /player tab: assert LOGGED IN (Jellyfin home/library visible) and
//      NO manual login form; dump the seeded jellyfin_credentials token.
//   5. Screenshot both tabs.
//
// IMPORTANT: this flow MUST run on the same-origin proxy. On the bare client
// (client:5173) there is no /player route and no shared localStorage origin, so
// the handoff cannot work — we fail loudly with a clear message if so.
export const match = /player-handoff|handoff|front-door|frontdoor|auto-login|autologin/i;

// Select the "parents" preset (Alice + Bob). Falls back to any 2-member preset,
// then to the first preset, so the flow still runs on a differently-named config.
async function pickParentsGroupAndContinue(page) {
  const pickHeading = page.getByRole('heading', { name: /pick the group/i });
  if (!(await pickHeading.count().then((n) => n > 0))) {
    console.log('[proof] player-handoff: already in main app (no viewer-selection screen)');
    return;
  }

  const chips = page.locator('.preset-row .chip');
  const parents = chips.filter({ hasText: /alice\s*\+\s*bob|parents/i }).first();
  if (await parents.count().then((n) => n > 0)) {
    console.log('[proof] player-handoff: selecting "Alice + Bob" (parents) preset');
    await parents.click();
  } else if (await chips.count().then((n) => n > 0)) {
    console.log('[proof] player-handoff: parents preset not found; using first preset chip');
    await chips.first().click();
  } else {
    console.log('[proof] player-handoff: no preset chips; selecting first two viewer cards');
    const viewerCards = page.locator('button.viewer-card');
    const count = await viewerCards.count();
    await viewerCards.nth(0).click();
    if (count > 1) await viewerCards.nth(1).click();
  }

  await page.getByRole('button', { name: /^Continue$/ }).first().click();
  await page.waitForLoadState('networkidle');
}

export async function run(page, ctx) {
  const { fail, shoot, shootView, flowName } = ctx;

  // ── Guard: we MUST be on the same-origin proxy, not the bare client ───────
  const origin = await page.evaluate(() => window.location.origin);
  console.log(`[proof] player-handoff: running against origin ${origin}`);
  if (/:5173(\/|$)/.test(origin)) {
    await shootView(page, `${flowName}-00-wrong-origin`);
    fail(
      `player-handoff must run against the same-origin proxy (e.g. http://proxy:8080), ` +
        `but the origin is ${origin} (the bare Vite client). The /player route and the ` +
        `shared localStorage origin only exist behind the proxy. Re-run with ` +
        `PROOF_URL=http://proxy:8080.`,
    );
  }

  // ── Seed an in-progress episode so a Resume/Play affordance exists ────────
  // Best-effort: if seeding can't run (no JF creds in this container), we still
  // try the library Play button below.
  const seedUrl = process.env.JELLYFIN_URL;
  const seedKey = process.env.JELLYFIN_API_KEY;
  if (seedUrl && seedKey) {
    try {
      await seedInProgressEpisode({ url: seedUrl, apiKey: seedKey });
    } catch (error) {
      console.warn(`[proof] player-handoff: seed skipped (${error instanceof Error ? error.message : error})`);
    }
  } else {
    console.warn('[proof] player-handoff: JELLYFIN_URL/API_KEY not set; relying on existing library content');
  }

  await pickParentsGroupAndContinue(page);

  // Reload so the freshly-seeded continue-watching rail is present.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForLoadState('networkidle');

  // ── Find a play affordance: prefer a Continue-watching Resume/Play, else a
  //    library media-card Play. ──────────────────────────────────────────────
  const continuePlay = page
    .locator('.section-block .media-card button', { hasText: /^(Resume|Play)$/ })
    .first();
  const libraryPlay = page.locator('.media-card button', { hasText: /^Play$/ }).first();

  let target = null;
  if (await continuePlay.count().then((n) => n > 0)) {
    target = continuePlay;
    console.log('[proof] player-handoff: using a Continue-watching Resume/Play button');
  } else if (await libraryPlay.count().then((n) => n > 0)) {
    target = libraryPlay;
    console.log('[proof] player-handoff: using a library media-card Play button');
  } else {
    // Movies tab Play buttons may need the user to switch to a populated view.
    try {
      await page.locator('.media-card').first().waitFor({ state: 'visible', timeout: 15_000 });
      if (await libraryPlay.count().then((n) => n > 0)) {
        target = libraryPlay;
      }
    } catch {
      /* handled below */
    }
  }

  if (!target) {
    await shootView(page, `${flowName}-03-no-play-affordance`);
    fail('player-handoff: found no Resume/Play affordance to trigger the player session mint');
  }

  await target.scrollIntoViewIfNeeded();
  await target.waitFor({ state: 'visible', timeout: 10_000 });
  await shoot(page, `${flowName}-03-gbx-before-play`);

  // ── Diagnostics: attach iframe (child-frame) listeners AS EARLY AS POSSIBLE ─
  // The /player iframe can stall on Jellyfin-web's splash (React never mounts)
  // even though the initial assets are 200 — a runtime JS error or lazy-chunk/XHR
  // failure invisible to curl. Attach page-level frame listeners BEFORE the play
  // click so we capture any error from the Jellyfin child frame. console/pageerror
  // are page-scoped (they include child-frame errors); requests carry frame info.
  // Capture ALL console output, prefixed by frame: [jf-console] for the /player
  // iframe (incl. the app's [gbx-trigger] logs, which the App.tsx effect writes
  // INTO the iframe's console), and [top-console] for the gbx top frame — so we
  // never go blind on which selector matched / why playback didn't start.
  page.on('console', (m) => {
    try {
      const f = m.location?.()?.url || '';
      const prefix = /\/player\//.test(f) ? '[jf-console]' : '[top-console]';
      console.log(prefix, m.type(), m.text());
    } catch {
      /* ignore logging errors */
    }
  });
  page.on('pageerror', (e) => {
    console.log('[jf-pageerror]', e instanceof Error ? e.message : String(e));
  });
  page.on('requestfailed', (r) => {
    if (/\/player\//.test(r.url())) console.log('[jf-reqfail]', r.url(), r.failure()?.errorText ?? '(no errorText)');
  });

  // Track playback-stream errors AND which item id JF actually requested to play.
  // A 500 on a video stream (e.g. the av1/HLS transcode failure) means playback
  // errored even if an OSD briefly appeared — the gate must fail on that.
  const streamErrors = [];
  const playedItemIds = new Set();
  const VIDEO_STREAM_RE = /\/(videos|hls1?|master\.m3u8|main\.m3u8|stream(\.\w+)?)|\.m3u8|\/hls\//i;
  // Item id appears in PlaybackInfo and the stream path: /Items/<id>/PlaybackInfo
  // or /Videos/<id>/... (32-hex GUID, with or without dashes).
  const ITEM_ID_RE = /\/(?:Items|Videos)\/([0-9a-fA-F-]{32,36})\b/;
  page.on('response', (r) => {
    const url = r.url();
    if (!/\/player\//.test(url)) return;
    const idMatch = url.match(ITEM_ID_RE);
    if (idMatch && /PlaybackInfo|\/Videos\//i.test(url)) {
      playedItemIds.add(idMatch[1].replace(/-/g, '').toLowerCase());
    }
    if (r.status() >= 400) {
      console.log('[jf-resp>=400]', r.status(), url);
      if (r.status() >= 500 && VIDEO_STREAM_RE.test(url)) {
        streamErrors.push(`${r.status()} ${url}`);
      }
    }
  });

  // ── Trigger play: the app renders the same-origin Jellyfin-web IFRAME in the
  //    player modal (no popup). ────────────────────────────────────────────
  try {
    await target.click();
  } catch (error) {
    const appError = await page.locator('.error').first().textContent().catch(() => null);
    await shoot(page, `${flowName}-04-play-click-failed`);
    fail(
      'player-handoff: clicking play threw' + (appError ? ` — app error: ${appError.trim()}` : ''),
      error,
    );
  }

  // The iframe lives in the player modal as iframe.player-frame.
  const frameEl = page.locator('iframe.player-frame');
  try {
    await frameEl.waitFor({ state: 'attached', timeout: 15_000 });
  } catch (error) {
    const appError = await page.locator('.error').first().textContent().catch(() => null);
    await shoot(page, `${flowName}-04-no-iframe`);
    fail(
      'player-handoff: the Jellyfin player iframe (iframe.player-frame) never appeared after play' +
        (appError ? ` — app error: ${appError.trim()}` : ''),
      error,
    );
  }
  await shoot(page, `${flowName}-gbx`);

  // ── Confirm the gbx page seeded Jellyfin-web's localStorage on this origin ──
  const seeded = await page.evaluate(() => {
    let creds = null;
    try {
      creds = JSON.parse(window.localStorage.getItem('jellyfin_credentials') || 'null');
    } catch {
      creds = null;
    }
    const server = creds?.Servers?.[0] ?? null;
    return {
      hasCredentials: !!server,
      hasAccessToken: !!server?.AccessToken,
      userId: server?.UserId ?? null,
      localAddress: server?.LocalAddress ?? null,
      deviceId: window.localStorage.getItem('_deviceId2'),
      enableAutoLogin: window.localStorage.getItem('enableAutoLogin'),
    };
  });
  console.log('[proof] player-handoff: seeded localStorage =', JSON.stringify(seeded));
  if (!seeded.hasCredentials || !seeded.hasAccessToken) {
    await shoot(page, `${flowName}-04-no-seed`);
    fail('player-handoff: jellyfin_credentials with an AccessToken was NOT seeded into localStorage');
  }
  if (seeded.deviceId == null || seeded.enableAutoLogin !== 'true') {
    fail(
      `player-handoff: auto-login keys not fully seeded (_deviceId2=${JSON.stringify(seeded.deviceId)}, ` +
        `enableAutoLogin=${JSON.stringify(seeded.enableAutoLogin)})`,
    );
  }
  console.log('[proof] player-handoff: PASS — gbx seeded jellyfin_credentials + _deviceId2 + enableAutoLogin');

  // ── Resolve the Jellyfin child Frame (the iframe's content) ───────────────
  // Playwright exposes child frames via page.frames(); the JF frame URL is under
  // /player. Wait for it to exist.
  const findJfFrame = () => page.frames().find((f) => /\/player\//.test(f.url())) ?? null;
  const frameDeadline = Date.now() + 15_000;
  let jfFrame = findJfFrame();
  while (!jfFrame && Date.now() < frameDeadline) {
    await page.waitForTimeout(300);
    jfFrame = findJfFrame();
  }
  if (!jfFrame) {
    await shoot(page, `${flowName}-04-no-jf-frame`);
    fail('player-handoff: could not resolve the Jellyfin /player child frame');
  }
  console.log(`[proof] player-handoff: JF frame URL = ${jfFrame.url()}`);

  // DOM probe run INSIDE the child frame. Logged-in evidence is broad (the goal
  // is "authenticated, no login form"); also surfaces playback indicators.
  const probe = () =>
    jfFrame.evaluate(() => {
      const q = (sel) => document.querySelector(sel);
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const loggedInEl =
        q('.headerUserButton') || q('.skinHeader') || q('.homeSectionsContainer') ||
        q('[is="emby-tabs"]') || q('.itemsContainer') || q('a[href*="#/home"]') ||
        q('.videoPlayerContainer') || q('.detailPagePrimaryContainer') || q('.osdHeader');
      const loginEl =
        q('#loginPage') || q('.manualLoginForm') || q('form .manualLoginForm') ||
        (q('input[type="password"]') && (q('#loginPage') || /login/i.test(location.hash))
          ? q('input[type="password"]')
          : null);
      const video = q('video');
      const osd = q('.videoOsd');
      const osdPresent = visible(osd) && [
        'button',
        '[role="button"]',
        '[role="slider"]',
        '.sliderContainer',
        '.osdControls',
      ].some((selector) => visible(osd?.querySelector(selector)));
      // Extract the item id from the details hash (#/details?id=<id>...). Used to
      // verify the item that actually played matches the requested hash item.
      const hashIdMatch = location.hash.match(/[?&]id=([0-9a-fA-F-]{32,36})/);
      const hashItemId = hashIdMatch ? hashIdMatch[1].replace(/-/g, '').toLowerCase() : null;
      return {
        hash: location.hash,
        hashItemId,
        title: document.title,
        loggedInVisible: visible(loggedInEl),
        loginFormVisible: visible(loginEl),
        videoPresent: !!video,
        videoPaused: video ? video.paused : null,
        videoCurrentTime: video ? video.currentTime : null,
        videoEnded: video ? video.ended : null,
        // HTMLMediaElement.error is non-null when the stream failed (e.g. the
        // HLS/transcode 500). readyState>=2 means it has decoded data.
        videoErrorCode: video && video.error ? video.error.code : null,
        videoReadyState: video ? video.readyState : null,
        osdPresent,
        playbackStarted: osdPresent || (!!video && video.paused === false && video.currentTime > 0),
        bodyHead: (document.body?.innerText || '').slice(0, 200),
      };
    }).catch((err) => ({
      // A transient cross-frame/navigation error during routing — treat as "not
      // yet settled" and keep polling.
      hash: '', hashItemId: null, title: '', loggedInVisible: false, loginFormVisible: false,
      videoPresent: false, videoPaused: null, videoCurrentTime: null, videoEnded: null,
      videoErrorCode: null, videoReadyState: null, osdPresent: false,
      playbackStarted: false, bodyHead: `(probe error: ${String(err).slice(0, 80)})`,
    }));

  // ── Phase 1: auto-login settle (logged-in OR login form visible) ──────────
  const SETTLE_TIMEOUT_MS = 30_000;
  const settleDeadline = Date.now() + SETTLE_TIMEOUT_MS;
  let jf = await probe();
  while (!jf.loggedInVisible && !jf.loginFormVisible && Date.now() < settleDeadline) {
    await page.waitForTimeout(500);
    jf = await probe();
  }
  console.log('[proof] player-handoff: jellyfin-web (login) state =', JSON.stringify(jf));

  if (!jf.loggedInVisible && !jf.loginFormVisible) {
    await shoot(page, `${flowName}-jellyfin-loggedin`);
    fail(
      'player-handoff: Jellyfin-web (iframe) never settled within ' +
        `${SETTLE_TIMEOUT_MS / 1000}s — neither a logged-in container nor a login form became ` +
        `visible (still on the boot splash?). hash=${jf.hash} title=${JSON.stringify(jf.title)} ` +
        `bodyHead=${JSON.stringify(jf.bodyHead)}.`,
    );
  }
  if (jf.loginFormVisible) {
    await shoot(page, `${flowName}-jellyfin-loggedin`);
    fail(
      'player-handoff: the Jellyfin iframe shows the MANUAL LOGIN FORM — auto-login did NOT ' +
        'take. The seeded credentials were not honoured for this origin.',
    );
  }
  await shoot(page, `${flowName}-jellyfin-loggedin`);
  console.log(
    '[proof] player-handoff: PASS — /player iframe is LOGGED IN as the gbx group user ' +
      '(authenticated view visible, no manual login form). See ' +
      `${flowName}-jellyfin-loggedin.png.`,
  );

  // ── Phase 2: PLAYBACK actually PROGRESSED (driven by the app's iframe click) ─
  // STRICT gate (a prior run greened on OSD presence even though the video errored
  // at t=0 due to the av1/HLS 500). PASS now requires the video to have made REAL
  // progress: currentTime advanced past 0 (or the 1s stub already ended), with NO
  // playback error and NO 500 on a video stream. We also verify the item that
  // actually played matches the requested hash item.
  const hashItemId = jf.hashItemId;
  const PLAYBACK_TIMEOUT_MS = 25_000;
  const playbackDeadline = Date.now() + PLAYBACK_TIMEOUT_MS;
  let maxCurrentTime = 0;
  let everEnded = false;
  // Progress means: a video advanced past 0, OR a short clip already ended.
  const progressed = () =>
    maxCurrentTime > 0 || everEnded || (jf.videoCurrentTime != null && jf.videoCurrentTime > 0);
  while (
    !progressed() &&
    streamErrors.length === 0 &&
    jf.videoErrorCode == null &&
    Date.now() < playbackDeadline
  ) {
    await page.waitForTimeout(400);
    jf = await probe();
    if (typeof jf.videoCurrentTime === 'number' && jf.videoCurrentTime > maxCurrentTime) {
      maxCurrentTime = jf.videoCurrentTime;
    }
    if (jf.videoEnded === true) everEnded = true;
  }
  console.log('[proof] player-handoff: jellyfin-web (playback) state =', JSON.stringify({
    ...jf, maxCurrentTime, everEnded,
  }));
  console.log('[proof] player-handoff: stream errors =', JSON.stringify(streamErrors));
  console.log('[proof] player-handoff: played item ids =', JSON.stringify([...playedItemIds]),
    'hashItemId =', JSON.stringify(hashItemId));

  await shoot(page, `${flowName}-jellyfin-playing`);
  console.log(`[proof] screenshot: ${ctx.outDir}/${flowName}-jellyfin-playing.png`);

  // FAIL: a 5xx on a video stream means the transcode/stream broke (e.g. av1/HLS).
  if (streamErrors.length > 0) {
    fail(
      'player-handoff: a video STREAM returned 5xx — playback errored, not real playback: ' +
        streamErrors.join(' ; ') +
        '. (Fixtures must be DirectPlay MP4/H264+AAC so JF does not transcode.) ' +
        `See ${flowName}-jellyfin-playing.png.`,
    );
  }
  // FAIL: the HTMLMediaElement reported an error (e.g. MEDIA_ERR_SRC_NOT_SUPPORTED).
  if (jf.videoErrorCode != null) {
    fail(
      `player-handoff: the <video> reported error code ${jf.videoErrorCode} — playback failed ` +
        `(not real playback). hash=${jf.hash}. See ${flowName}-jellyfin-playing.png.`,
    );
  }
  // FAIL: no real progress within the window.
  if (!progressed()) {
    fail(
      'player-handoff: playback did NOT progress in the /player iframe within ' +
        `${PLAYBACK_TIMEOUT_MS / 1000}s — currentTime never advanced past 0 (max=${maxCurrentTime}, ` +
        `ended=${everEnded}, paused=${jf.videoPaused}, readyState=${jf.videoReadyState}). ` +
        `hash=${jf.hash}. See ${flowName}-jellyfin-playing.png.`,
    );
  }
  // FAIL: a DIFFERENT item played than the requested hash item.
  if (hashItemId && playedItemIds.size > 0 && !playedItemIds.has(hashItemId)) {
    fail(
      'player-handoff: the WRONG item played. Requested hash item ' + hashItemId +
        ' but the playback API targeted ' + JSON.stringify([...playedItemIds]) +
        '. (The autoplay click likely hit a card-overlay button instead of the header play.) ' +
        `See ${flowName}-jellyfin-playing.png.`,
    );
  }
  if (hashItemId && playedItemIds.size === 0) {
    console.warn(
      '[proof] player-handoff: WARNING — could not capture a playback item id from network to ' +
        'cross-check against the hash item; relying on progress + no-error gate.',
    );
  }
  console.log(
    '[proof] player-handoff: PASS — playback PROGRESSED in the /player iframe ' +
      `(maxCurrentTime=${maxCurrentTime}, ended=${everEnded}, osd=${jf.osdPresent}) with NO stream 5xx ` +
      `and the CORRECT item (${hashItemId ?? 'unverified'}). This feeds a live /Sessions entry for ` +
      `the Stage B watched fan-out. See ${flowName}-jellyfin-playing.png.`,
  );
}
