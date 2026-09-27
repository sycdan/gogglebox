// ── config-warnings flow ───────────────────────────────────────────────────
// Proves a config user missing from Jellyfin shows as a warning with its fix,
// and that creating the user and pressing Reboot clears it:
//   1. add "Erin" to the sandbox config.json (not in Jellyfin), Reboot
//      -> Administration lists her warning, account menu alerts  -> 01-warning
//   2. create Erin in the sandbox Jellyfin, Reboot
//      -> her warning is gone                                     -> 02-cleared
// The config file and Jellyfin are restored and the app rebooted afterwards.
// The proof container mounts the checkout, so /app/config.sbx.json is the
// file the app mounts as its config.json.
//
//   PROOF_FLOW=config-warnings ./scripts/e2e.sh run --rm proof
import { readFileSync, writeFileSync } from 'node:fs';
import { makeJellyfin } from '../lib/jellyfin.mjs';

export const match = /config-warn|reboot/i;

const CONFIG_PATH = '/app/config.sbx.json';
const MISSING = 'Erin';

async function openAdministration(page) {
  await page.getByRole('button', { name: 'Open account menu' }).click();
  await page.getByRole('menuitem', { name: /Administration/ }).click();
  await page.locator('#config-health-title').waitFor({ state: 'visible', timeout: 15_000 });
}

// A PIN of one of the household's primary users, which Reboot asks for.
function primaryPin(config) {
  const primaries = new Set(config.accounts.household.primary_users);
  const pin = config.users.find((user) => primaries.has(user.jellyfin_name) && user.pin)?.pin;
  if (!pin) throw new Error('the sandbox household has no primary user with a pin; re-provision the sandbox');
  return pin;
}

// Press Reboot and wait for the page's reload once Gogglebox answers again.
async function rebootFromUi(page, pin) {
  const reloaded = page.waitForEvent('load', { timeout: 90_000 });
  await page.getByLabel('PIN to reboot').fill(pin);
  await page.getByRole('button', { name: 'Reboot', exact: true }).click();
  await reloaded;
  await page.getByRole('button', { name: 'Open account menu' }).waitFor({ state: 'visible', timeout: 60_000 });
}

async function bootId(url) {
  const health = await fetch(`${url}/api/health`);
  return health.ok ? (await health.json()).bootId : undefined;
}

// Reboot through the API and wait for a new process to answer.
async function rebootAndWait(page, url, pin) {
  const before = await bootId(url);
  await page.request.post(`${url}/api/admin/reboot`, { data: { pin } });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const now = await bootId(url);
      if (now && now !== before) return;
    } catch { /* restarting */ }
  }
  throw new Error('Gogglebox did not come back after the reboot');
}

function missingUserWarning(page) {
  return page.locator('.config-warnings li', { hasText: `"${MISSING}"` });
}

export async function run(page, ctx) {
  const { fail, shootView, flowName } = ctx;
  const url = process.env.PROOF_URL ?? 'http://proxy:8080';
  const jf = makeJellyfin(process.env.JELLYFIN_URL, process.env.JELLYFIN_API_KEY);
  const original = readFileSync(CONFIG_PATH, 'utf8');
  const pin = primaryPin(JSON.parse(original));

  const removeFromJellyfin = async () => {
    for (const user of await jf.listUsers()) {
      if (user.name === MISSING) await jf.deleteUser(user.id);
    }
  };

  await removeFromJellyfin();
  const config = JSON.parse(original);
  config.users.push({ jellyfin_name: MISSING });
  // Write in place: the app's single-file mount keeps the same inode.
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  try {
    console.log(`[proof] config-warnings: ${MISSING} is in config.json but not Jellyfin; rebooting`);
    await openAdministration(page);
    await rebootFromUi(page, pin);

    const alert = page.locator('.account-menu-alert');
    if (!(await alert.isVisible().catch(() => false))) {
      await shootView(page, `${flowName}-01-no-alert`);
      fail('config-warnings: the account menu showed no alert for a config warning');
    }
    await openAdministration(page);
    const warning = missingUserWarning(page);
    try {
      await warning.waitFor({ state: 'visible', timeout: 10_000 });
    } catch (error) {
      await shootView(page, `${flowName}-01-no-warning`);
      fail(`config-warnings: Administration did not list the warning for ${MISSING}`, error);
    }
    if (!/Create them in Jellyfin/.test(await warning.innerText())) {
      await shootView(page, `${flowName}-01-no-fix`);
      fail('config-warnings: the warning does not say how to fix it');
    }
    await shootView(page, `${flowName}-01-warning`);

    console.log(`[proof] config-warnings: creating ${MISSING} in Jellyfin; rebooting`);
    await jf.createUser(MISSING);
    await rebootFromUi(page, pin);
    await openAdministration(page);
    if (await missingUserWarning(page).count()) {
      await shootView(page, `${flowName}-02-still-warning`);
      fail(`config-warnings: the warning for ${MISSING} survived creating her and rebooting`);
    }
    await shootView(page, `${flowName}-02-cleared`);
    console.log('[proof] config-warnings: PASS');
  } finally {
    writeFileSync(CONFIG_PATH, original);
    await removeFromJellyfin();
    await rebootAndWait(page, url, pin);
  }
}
