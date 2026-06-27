import fs from 'node:fs';
import path from 'node:path';

// Writable runtime state — distinct from the read-only config.json. Stores a map
// of groupKey -> ignored item ids (shows and movies). Lives at a host-mounted
// location so it survives redeploys.
interface AppStateFile {
  ignoredItems?: Record<string, string[]>;
  // Legacy key (pre-rename). Read as a fallback; never written.
  ignoredShows?: Record<string, string[]>;
}

const STATE_PATH = '/data/state.json';

function readState(filePath: string): AppStateFile {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as AppStateFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt state file should not take the server down; start fresh.
    return {};
  }
}

// Prefer the new key; fall back to the legacy `ignoredShows` key so a
// pre-rename state file keeps working with zero data loss until its first write.
function ignoredItemsFrom(state: AppStateFile): Record<string, string[]> {
  return state.ignoredItems ?? state.ignoredShows ?? {};
}

// Write-then-rename so a concurrent reader never observes a truncated file.
// Always persists the new `ignoredItems` key and drops the legacy
// `ignoredShows` key so existing files migrate transparently on first write.
function writeState(filePath: string, state: AppStateFile, ignoredItems: Record<string, string[]>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const { ignoredShows: _legacy, ...rest } = state;
  const next: AppStateFile = { ...rest, ignoredItems };
  const tempPath = path.join(dir, `.state-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2));
  fs.renameSync(tempPath, filePath);
}

export class AppState {
  constructor(private readonly filePath: string = STATE_PATH) {}

  getIgnoredItems(groupKey: string): string[] {
    const state = readState(this.filePath);
    return ignoredItemsFrom(state)[groupKey] ?? [];
  }

  ignoreItem(groupKey: string, itemId: string): string[] {
    const state = readState(this.filePath);
    const ignoredItems = ignoredItemsFrom(state);
    const current = new Set(ignoredItems[groupKey] ?? []);
    current.add(itemId);
    ignoredItems[groupKey] = [...current];
    writeState(this.filePath, state, ignoredItems);
    return ignoredItems[groupKey];
  }

  unignoreItem(groupKey: string, itemId: string): string[] {
    const state = readState(this.filePath);
    const ignoredItems = ignoredItemsFrom(state);
    const next = (ignoredItems[groupKey] ?? []).filter((id) => id !== itemId);
    if (next.length > 0) {
      ignoredItems[groupKey] = next;
    } else {
      delete ignoredItems[groupKey];
    }
    writeState(this.filePath, state, ignoredItems);
    return next;
  }
}
