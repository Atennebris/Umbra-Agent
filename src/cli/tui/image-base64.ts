import fs from 'node:fs/promises';
import path from 'node:path';

const mimeByExtension: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export async function imageFileToBase64(
  filePath: string,
): Promise<{ mimeType: string; data: string }> {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = mimeByExtension[extension];

  if (!mimeType) {
    throw new Error(`Unsupported image type for Base64 conversion: ${extension || 'unknown'}`);
  }

  const fileBuffer = await fs.readFile(filePath);
  return {
    mimeType,
    data: fileBuffer.toString('base64'),
  };
}
