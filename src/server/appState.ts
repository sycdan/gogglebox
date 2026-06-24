import fs from 'node:fs';
import path from 'node:path';

// Writable runtime state — distinct from the read-only config.json. Stores a map
// of groupKey -> ignored show ids. Lives at a host-mounted location so it
// survives redeploys.
interface AppStateFile {
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

// Write-then-rename so a concurrent reader never observes a truncated file.
function writeState(filePath: string, state: AppStateFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.state-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
  fs.renameSync(tempPath, filePath);
}

export class AppState {
  constructor(private readonly filePath: string = STATE_PATH) {}

  getIgnoredShows(groupKey: string): string[] {
    const state = readState(this.filePath);
    return state.ignoredShows?.[groupKey] ?? [];
  }

  ignoreShow(groupKey: string, showId: string): string[] {
    const state = readState(this.filePath);
    const ignoredShows = state.ignoredShows ?? {};
    const current = new Set(ignoredShows[groupKey] ?? []);
    current.add(showId);
    ignoredShows[groupKey] = [...current];
    writeState(this.filePath, { ...state, ignoredShows });
    return ignoredShows[groupKey];
  }

  unignoreShow(groupKey: string, showId: string): string[] {
    const state = readState(this.filePath);
    const ignoredShows = state.ignoredShows ?? {};
    const next = (ignoredShows[groupKey] ?? []).filter((id) => id !== showId);
    if (next.length > 0) {
      ignoredShows[groupKey] = next;
    } else {
      delete ignoredShows[groupKey];
    }
    writeState(this.filePath, { ...state, ignoredShows });
    return next;
  }
}
