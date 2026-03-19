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
};

export type ImageIngestPayload = {
  shelf: ShelfPayload;
  imageUri: string;
  title?: string;
  author?: string;
  mimeType?: string;
  fileName?: string;
};

async function parseJson(response: Response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function login(baseUrl: string, username: string, password: string): Promise<LoginResponse> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  });

  const data = await parseJson(response);
  if (!response.ok) {
    throw new Error(data?.detail ?? 'Login failed');
  }
  return data as LoginResponse;
}

export async function submitIsbnIngest(baseUrl: string, token: string, payload: IsbnIngestPayload) {
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
    }),
  });

  const data = await parseJson(response);
  if (!response.ok) {
    throw new Error(data?.detail ?? 'Ingest failed');
  }
  return data;
}

export async function submitImageIngest(baseUrl: string, token: string, payload: ImageIngestPayload) {
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
  formData.append('image', {
    uri: payload.imageUri,
    name: payload.fileName ?? 'cover.jpg',
    type: payload.mimeType ?? 'image/jpeg',
  } as never);

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
  return data;
}