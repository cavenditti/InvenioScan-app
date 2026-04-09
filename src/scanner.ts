export type ParsedShelfPayload = {
  shelfId: string;
  row: string;
  position: number;
  height: number;
};


function buildParsedShelfPayload(shelfIdValue: string, searchParams: URLSearchParams): ParsedShelfPayload | null {
  const shelfId = decodeURIComponent(shelfIdValue.replace(/^\/+/, ''));
  const row = searchParams.get('row');
  const position = Number.parseInt(searchParams.get('position') ?? '', 10);
  const height = Number.parseInt(searchParams.get('height') ?? '', 10);
  if (!shelfId || !row || Number.isNaN(position) || Number.isNaN(height)) {
    return null;
  }

  return { shelfId, row, position, height };
}


function parseShelfPayloadFromUrl(data: string): ParsedShelfPayload | null {
  try {
    const url = new URL(data);
    if (url.protocol !== 'invscan:' || url.hostname !== 'shelf') {
      return null;
    }

    return buildParsedShelfPayload(url.pathname, url.searchParams);
  } catch {
    return null;
  }
}


function parseShelfPayloadFromScheme(data: string): ParsedShelfPayload | null {
  const normalized = data.trim();
  if (!normalized.toLowerCase().startsWith('invscan:')) {
    return null;
  }

  try {
    const rawPayload = normalized.slice('invscan:'.length);
    let pathWithQuery = '';

    if (/^\/\/shelf\//i.test(rawPayload)) {
      pathWithQuery = rawPayload.slice('//shelf/'.length);
    } else if (/^\/shelf\//i.test(rawPayload)) {
      pathWithQuery = rawPayload.slice('/shelf/'.length);
    } else if (/^shelf\//i.test(rawPayload)) {
      pathWithQuery = rawPayload.slice('shelf/'.length);
    } else {
      return null;
    }

    const [rawShelfId, query = ''] = pathWithQuery.split('?');
    return buildParsedShelfPayload(rawShelfId, new URLSearchParams(query));
  } catch {
    return null;
  }
}


export function parseShelfPayload(data: string): ParsedShelfPayload | null {
  const normalized = data.trim();
  if (!normalized) {
    return null;
  }

  return parseShelfPayloadFromUrl(normalized) ?? parseShelfPayloadFromScheme(normalized);
}


export function normalizeScannedIsbn(data: string): string | null {
  const cleaned = data.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (cleaned.length === 10 || cleaned.length === 13) {
    return cleaned;
  }
  return null;
}