interface ImageUploadOptions {
  maxDimension: number;
  quality?: number;
  skipBelowBytes?: number;
}

const PASSTHROUGH_TYPES = new Set(['image/gif', 'image/svg+xml']);

function optimizedName(name: string) {
  const stem = name.replace(/\.[^.]+$/, '') || 'image';
  return `${stem}.webp`;
}

export async function prepareImageUpload(
  file: File,
  { maxDimension, quality = 0.82, skipBelowBytes = 350 * 1024 }: ImageUploadOptions
): Promise<File> {
  if (!file.type.startsWith('image/') || PASSTHROUGH_TYPES.has(file.type)) return file;
  if (file.size <= skipBelowBytes) return file;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/webp', quality);
    });
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], optimizedName(file.name), {
      type: blob.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
