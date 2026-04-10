import { Platform } from 'react-native';

export type LoginResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

export type ShelfPayload = {
  shelf_id: string;
  row: string;
  position: number;
  height: number;
};

export type IsbnIngestPayload = {
  shelf: ShelfPayload;
  isbn: string;
  title?: string;
  author?: string;
  publicationYear?: number;
  documentType?: string;
  language?: string;
  notes?: string;
};

export type ImageIngestPayload = {
  shelf: ShelfPayload;
  imageUri: string;
  title?: string;
  author?: string;
  publicationYear?: number;
  documentType?: string;
  language?: string;
  notes?: string;
  mimeType?: string;
  fileName?: string;
};

export type IngestResponse = {
  status: string;
  book_id: number;
  copy_id: number;
  scan_id: string;
};

async function parseJson(response: Response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}


async function appendImageUpload(formData: FormData, payload: ImageIngestPayload) {
  const fileName = payload.fileName ?? 'cover.jpg';
  const mimeType = payload.mimeType ?? 'image/jpeg';

  if (Platform.OS === 'web') {
    const imageResponse = await fetch(payload.imageUri);
    if (!imageResponse.ok) {
      throw new Error('Could not read the captured image before upload.');
    }

    const imageBlob = await imageResponse.blob();
    const imageFile = new File([imageBlob], fileName, {
      type: imageBlob.type || mimeType,
    });
    formData.append('image', imageFile);
    return;
  }

  formData.append('image', {
    uri: payload.imageUri,
    name: fileName,
    type: mimeType,
  } as never);
}

export async function login(baseUrl: string, username: string, password: string): Promise<LoginResponse> {
  const body = new URLSearchParams();
  body.append('username', username);
  body.append('password', password);

  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = await parseJson(response);
  if (!response.ok) {
    throw new Error(data?.detail ?? 'Login failed');
  }
  return data as LoginResponse;
}

export async function submitIsbnIngest(baseUrl: string, token: string, payload: IsbnIngestPayload): Promise<IngestResponse> {
  const response = await fetch(`${baseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      shelf: payload.shelf,
      source_type: 'isbn',
      isbn: payload.isbn,
      title: payload.title,
      author: payload.author,
      publication_year: payload.publicationYear,
      document_type: payload.documentType,
      language: payload.language,
      notes: payload.notes,
    }),
  });

  const data = await parseJson(response);
  if (!response.ok) {
    throw new Error(data?.detail ?? 'Ingest failed');
  }
  return data as IngestResponse;
}

export async function submitImageIngest(baseUrl: string, token: string, payload: ImageIngestPayload): Promise<IngestResponse> {
  const formData = new FormData();
  formData.append('shelf_id', payload.shelf.shelf_id);
  formData.append('row', payload.shelf.row);
  formData.append('position', String(payload.shelf.position));
  formData.append('height', String(payload.shelf.height));
  if (payload.title) {
    formData.append('title', payload.title);
  }
  if (payload.author) {
    formData.append('author', payload.author);
  }
  if (payload.publicationYear !== undefined) {
    formData.append('publication_year', String(payload.publicationYear));
  }
  if (payload.documentType) {
    formData.append('document_type', payload.documentType);
  }
  if (payload.language) {
    formData.append('language', payload.language);
  }
  if (payload.notes) {
    formData.append('notes', payload.notes);
  }
  await appendImageUpload(formData, payload);

  const response = await fetch(`${baseUrl}/api/v1/ingest/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  const data = await parseJson(response);
  if (!response.ok) {
    throw new Error(data?.detail ?? 'Image ingest failed');
  }
  return data as IngestResponse;
}