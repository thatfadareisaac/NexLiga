const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const mediaBucket = process.env.SUPABASE_STORAGE_BUCKET || 'nexliga-media';

function storageRequest(path, options = {}) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for media storage.');
  }

  return fetch(`${supabaseUrl}/storage/v1${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...options.headers,
    },
  });
}

async function storageError(response, action) {
  let detail = '';
  try {
    const body = await response.json();
    detail =
      [body.message, body.error_description, body.error, body.msg].find(
        (value) => typeof value === 'string'
      ) || '';
  } catch {
    detail = '';
  }

  if (serviceRoleKey) detail = detail.replaceAll(serviceRoleKey, '[redacted]');
  if (supabaseUrl) detail = detail.replaceAll(supabaseUrl, '[redacted]');
  detail = detail.replace(/[\r\n\t]+/g, ' ').slice(0, 300);
  return new Error(
    `${action} (${response.status})${detail ? `: ${detail}` : `: ${response.statusText}`}`
  );
}

async function bucketIsMissing(response) {
  if (response.status === 404) return true;
  if (response.status !== 400) return false;

  try {
    const body = await response.clone().json();
    return [body.message, body.error, body.error_description, body.msg, body.code]
      .filter((value) => typeof value === 'string')
      .some((value) => /bucket[\s_-]+not[\s_-]+found/i.test(value));
  } catch {
    return false;
  }
}

export async function ensureMediaBucket() {
  const check = await storageRequest(`/bucket/${encodeURIComponent(mediaBucket)}`);
  if (check.ok) {
    const bucket = await check.json();
    if (!bucket.public) {
      throw new Error(`Supabase Storage bucket "${mediaBucket}" must be public for league images.`);
    }
    if (
      Array.isArray(bucket.allowed_mime_types) &&
      !['image/png', 'image/jpeg', 'image/webp'].every((type) =>
        bucket.allowed_mime_types.includes(type)
      )
    ) {
      throw new Error(
        `Supabase Storage bucket "${mediaBucket}" must allow PNG, JPEG, and WebP images.`
      );
    }
    return;
  }
  if (!(await bucketIsMissing(check))) {
    throw await storageError(check, 'Could not check the Supabase Storage bucket');
  }

  const create = await storageRequest('/bucket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: mediaBucket,
      name: mediaBucket,
      public: true,
      file_size_limit: 2_000_000,
      allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
    }),
  });
  if (!create.ok && create.status !== 409) {
    throw await storageError(create, 'Could not create the Supabase Storage bucket');
  }
}

export async function uploadMedia(fileName, bytes, contentType) {
  const response = await storageRequest(
    `/object/${encodeURIComponent(mediaBucket)}/${fileName.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: bytes,
    }
  );
  if (!response.ok) {
    throw await storageError(response, 'Supabase Storage upload failed');
  }

  return publicMediaUrl(fileName);
}

export function publicMediaUrl(fileName) {
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL is required to build public media URLs.');
  }
  const path = fileName.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(mediaBucket)}/${path}`;
}

export function mediaOrigin() {
  if (!supabaseUrl) return null;
  return new URL(supabaseUrl).origin;
}

export function storageConfigured() {
  return Boolean(supabaseUrl && serviceRoleKey);
}
