/**
 * Photo selection rules for the quote builder. Pure functions so they can be unit-tested without a browser.
 * Staff always decide which photos a customer receives; these helpers only provide a sensible default and guard rails.
 */
export interface VehiclePhoto { id: string; assetId: string; isPrimary: boolean }
export interface VehicleWithPhotos { id: string; images: VehiclePhoto[] }

/** Default for a freshly chosen vehicle: its primary photo, if it has one. Never photos of another vehicle. */
export function defaultPhotoSelection(vehicle: VehicleWithPhotos | null | undefined): string[] {
  const primary = vehicle?.images.find((i) => i.isPrimary);
  return primary ? [primary.assetId] : [];
}

/**
 * Only photos that belong to the chosen vehicle may be attached. Anything else (for example left over from a
 * previously selected vehicle) is dropped. If the vehicle is not known yet (still loading) the selection is kept as is.
 */
export function sanitizeSelection(selected: string[], vehicle: VehicleWithPhotos | null | undefined): string[] {
  if (!vehicle) return selected;
  const own = new Set(vehicle.images.map((i) => i.assetId));
  return selected.filter((id) => own.has(id));
}

export function toggleSelection(selected: string[], assetId: string): string[] {
  return selected.includes(assetId) ? selected.filter((id) => id !== assetId) : [...selected, assetId];
}

export interface SelectionSummary {
  total: number;
  selected: number;
  /** The vehicle has photos but none will be sent: staff must be warned before sending. */
  needsWarning: boolean;
  label: string;
}

export function selectionSummary(vehicle: VehicleWithPhotos | null | undefined, selected: string[]): SelectionSummary {
  const total = vehicle?.images.length ?? 0;
  const count = sanitizeSelection(selected, vehicle).length;
  return {
    total, selected: count, needsWarning: !!vehicle && total > 0 && count === 0,
    label: total === 0 ? 'No photos available' : `${count} of ${total} selected`,
  };
}
