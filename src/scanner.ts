export type ParsedShelfPayload = {
  shelfId: string;
  row: string;
  position: number;
  height: number;
};

const LIVE_ISBN_PREFIX_PATTERN = /^ISBN(?:-1[03])?:?\s*/i;


function isValidIsbn10(isbn: string) {
  if (!/^[0-9]{9}[0-9X]$/.test(isbn)) {
    return false;
  }

  const checksum = isbn.split('').reduce((total, character, index) => {
    const digit = character === 'X' ? 10 : Number.parseInt(character, 10);
    return total + digit * (10 - index);
  }, 0);

  return checksum % 11 === 0;
}


function isValidEan13(isbn: string) {
  if (!/^[0-9]{13}$/.test(isbn)) {
    return false;
  }

  const checksum = isbn
    .slice(0, 12)
    .split('')
    .reduce((total, character, index) => {
      const digit = Number.parseInt(character, 10);
      return total + digit * (index % 2 === 0 ? 1 : 3);
    }, 0);
  const expectedCheckDigit = (10 - (checksum % 10)) % 10;

  return expectedCheckDigit === Number.parseInt(isbn[12], 10);
}


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
  if (cleaned.length === 10 && isValidIsbn10(cleaned)) {
    return cleaned;
  }

  if (cleaned.length === 13 && /^97[89]/.test(cleaned) && isValidEan13(cleaned)) {
    return cleaned;
  }

  // Some live scanners concatenate the 5-digit EAN add-on to the ISBN.
  const isbn13Matches = cleaned.match(/97[89][0-9]{10}/g) ?? [];
  for (const match of isbn13Matches) {
    if (isValidEan13(match)) {
      return match;
    }
  }

  return null;
}


export function normalizeContinuousScannedIsbn(data: string): string | null {
  const trimmed = data.trim();
  if (!trimmed) {
    return null;
  }

  const withoutPrefix = trimmed.replace(LIVE_ISBN_PREFIX_PATTERN, '');
  if (!/^[0-9Xx\s-]+$/.test(withoutPrefix)) {
    return null;
  }

  const normalized = normalizeScannedIsbn(withoutPrefix);
  if (!normalized) {
    return null;
  }

  const compact = withoutPrefix.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (normalized.length === 10) {
    return compact === normalized ? normalized : null;
  }

  if (compact.startsWith(normalized) && (compact.length === 13 || compact.length === 15 || compact.length === 18)) {
    return normalized;
  }

  return null;
}