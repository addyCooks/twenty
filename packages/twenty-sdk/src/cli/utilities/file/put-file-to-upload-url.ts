import axios from 'axios';
import * as fs from 'fs';

export const putFileToUploadUrl = async ({
  file,
  uploadUrl,
  contentType,
}: {
  file: string | Buffer;
  uploadUrl: string;
  contentType: string;
}): Promise<void> => {
  const buffer =
    typeof file === 'string' ? await fs.promises.readFile(file) : file;

  await axios.put(uploadUrl, buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': buffer.length,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
};
