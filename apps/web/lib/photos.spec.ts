import { defaultPhotoSelection, sanitizeSelection, selectionSummary, toggleSelection, VehicleWithPhotos } from './photos';

const photo = (assetId: string, isPrimary = false) => ({ id: `img-${assetId}`, assetId, isPrimary });
const urbania: VehicleWithPhotos = { id: 'v-urbania', images: [photo('u1'), photo('u2', true), photo('u3')] };
const crysta: VehicleWithPhotos = { id: 'v-crysta', images: [photo('c1', true), photo('c2')] };
const bare: VehicleWithPhotos = { id: 'v-bare', images: [] };

describe('defaultPhotoSelection', () => {
  it('selects the primary photo, even when it is not the first one', () => {
    expect(defaultPhotoSelection(urbania)).toEqual(['u2']);
  });
  it('selects nothing for a vehicle without photos or with no primary flag, and when no vehicle is chosen', () => {
    expect(defaultPhotoSelection(bare)).toEqual([]);
    expect(defaultPhotoSelection({ id: 'x', images: [photo('a'), photo('b')] })).toEqual([]);
    expect(defaultPhotoSelection(undefined)).toEqual([]);
    expect(defaultPhotoSelection(null)).toEqual([]);
  });
  it('changing vehicles yields the NEW vehicle\'s primary photo, never the previous vehicle\'s', () => {
    const afterUrbania = defaultPhotoSelection(urbania);
    const afterCrysta = defaultPhotoSelection(crysta);
    expect(afterCrysta).toEqual(['c1']);
    expect(afterCrysta).not.toContain(afterUrbania[0]);
  });
});

describe('sanitizeSelection', () => {
  it('drops photos that do not belong to the chosen vehicle and keeps the user\'s order', () => {
    expect(sanitizeSelection(['u3', 'c1', 'u1'], urbania)).toEqual(['u3', 'u1']);
  });
  it('can end up empty (all stale)', () => {
    expect(sanitizeSelection(['u1', 'u2'], crysta)).toEqual([]);
  });
  it('keeps the selection unchanged while the vehicle is still unknown (loading)', () => {
    expect(sanitizeSelection(['u1'], undefined)).toEqual(['u1']);
  });
});

describe('toggleSelection (users can deselect and choose different photos)', () => {
  it('adds and removes without disturbing other choices', () => {
    let s = defaultPhotoSelection(urbania);            // ['u2']
    s = toggleSelection(s, 'u1');                      // add another
    expect(s).toEqual(['u2', 'u1']);
    s = toggleSelection(s, 'u2');                      // deselect the default
    expect(s).toEqual(['u1']);
    s = toggleSelection(s, 'u1');                      // deselect everything
    expect(s).toEqual([]);
  });
  it('does not mutate its input', () => {
    const s = ['u1'];
    toggleSelection(s, 'u2');
    expect(s).toEqual(['u1']);
  });
});

describe('selectionSummary and the no-photo warning', () => {
  it('reports the count and does not warn when something is selected', () => {
    expect(selectionSummary(urbania, ['u2'])).toEqual({ total: 3, selected: 1, needsWarning: false, label: '1 of 3 selected' });
    expect(selectionSummary(urbania, ['u1', 'u2', 'u3']).label).toBe('3 of 3 selected');
  });
  it('warns when the vehicle has photos but none are selected', () => {
    expect(selectionSummary(urbania, [])).toMatchObject({ selected: 0, needsWarning: true, label: '0 of 3 selected' });
  });
  it('counts only photos of the chosen vehicle, so stale ids cannot hide the warning', () => {
    expect(selectionSummary(crysta, ['u1', 'u2'])).toMatchObject({ selected: 0, needsWarning: true });
  });
  it('does not warn when the vehicle has no photos or no vehicle is chosen', () => {
    expect(selectionSummary(bare, [])).toMatchObject({ needsWarning: false, label: 'No photos available' });
    expect(selectionSummary(undefined, [])).toMatchObject({ needsWarning: false });
  });
});
