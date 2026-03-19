export type ParsedShelfPayload = {
  shelfId: string;
  row: string;
  position: number;
  height: number;
};


export function parseShelfPayload(data: string): ParsedShelfPayload | null {
  try {
    const url = new URL(data);
    if (url.protocol !== 'invscan:' || url.hostname !== 'shelf') {
      return null;
    }

    const shelfId = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const row = url.searchParams.get('row');
    const position = Number.parseInt(url.searchParams.get('position') ?? '', 10);
    const height = Number.parseInt(url.searchParams.get('height') ?? '', 10);
    if (!shelfId || !row || Number.isNaN(position) || Number.isNaN(height)) {
      return null;
    }

    return { shelfId, row, position, height };
  } catch {
    return null;
  }
}


export function normalizeScannedIsbn(data: string): string | null {
  const cleaned = data.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (cleaned.length === 10 || cleaned.length === 13) {
    return cleaned;
  }
  return null;
}