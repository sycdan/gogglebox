// Whether the guest modal's confirm button is disabled. The plain add flow is
// selection-only (at least one drafted guest, no pins — those are collected at
// Continue time); the continue-time flow requires a typed pin per drafted guest
// and blocks confirming away the entire submitted selection.
export function isGuestConfirmDisabled({
  forContinue,
  selectedViewerIds,
  candidateIds,
  draftIds,
  draftPins,
}: {
  forContinue: boolean;
  selectedViewerIds: string[];
  candidateIds: string[];
  draftIds: string[];
  draftPins: Record<string, string>;
}): boolean {
  if (!forContinue) {
    return draftIds.length === 0;
  }
  const candidates = new Set(candidateIds);
  const leavesSelection =
    draftIds.length > 0 || selectedViewerIds.some((id) => !candidates.has(id));
  return !leavesSelection || draftIds.some((id) => !draftPins[id]?.trim());
}

// After the server rejects a group POST for a wrong/missing pin (403), the
// continue-time pin modal reopens for exactly the submitted guest (tertiary)
// members so the user can retype. Pure so the reopen state is unit-testable.
export function guestIdsForPinRetry(
  memberIds: string[],
  viewers: { id: string; tier: string }[],
): string[] {
  const members = new Set(memberIds);
  return viewers
    .filter((viewer) => viewer.tier === 'tertiary' && members.has(viewer.id))
    .map((viewer) => viewer.id);
}

// Compute the prospective group submission when the continue-time pin modal is
// confirmed: the reconciled member ids plus the next pins map (keyed by
// jellyfinUserId, the group wire contract) — deselected modal guests lose
// their collected pin, drafted guests take their typed one. This is exactly
// what the confirm click verifies with the server (POST /api/group/verify-pins)
// before the modal may close. Pure so the submission is unit-testable.
export function buildContinueGuestSubmission({
  selectedViewerIds,
  pins,
  modalGuests,
  draftedGuests,
  draftPins,
}: {
  selectedViewerIds: string[];
  pins: Record<string, string>;
  modalGuests: { id: string; jellyfinUserId: string }[];
  draftedGuests: { id: string; jellyfinUserId: string }[];
  draftPins: Record<string, string>;
}): { memberIds: string[]; pins: Record<string, string> } {
  const draftedIds = draftedGuests.map((guest) => guest.id);
  const memberIds = reconcileContinueGuestSelection(
    selectedViewerIds,
    modalGuests.map((guest) => guest.id),
    draftedIds,
  );

  const nextPins = { ...pins };
  for (const guest of modalGuests) {
    if (!draftedIds.includes(guest.id)) {
      delete nextPins[guest.jellyfinUserId];
    }
  }
  for (const guest of draftedGuests) {
    nextPins[guest.jellyfinUserId] = draftPins[guest.id] ?? '';
  }

  return { memberIds, pins: nextPins };
}

export function reconcileContinueGuestSelection(
  selectedViewerIds: string[],
  modalGuestIds: string[],
  confirmedGuestIds: string[],
): string[] {
  const modalGuests = new Set(modalGuestIds);
  const confirmedGuests = new Set(confirmedGuestIds);
  const reconciled = selectedViewerIds.filter((id) => !modalGuests.has(id) || confirmedGuests.has(id));

  for (const id of confirmedGuestIds) {
    if (!reconciled.includes(id)) {
      reconciled.push(id);
    }
  }

  return reconciled;
}

