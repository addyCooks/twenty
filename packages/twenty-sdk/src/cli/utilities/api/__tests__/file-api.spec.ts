import { FileApi } from '@/cli/utilities/api/file-api';
import axios, { type AxiosInstance } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('FileApi.uploadAppTarball', () => {
  const post = vi.fn();
  const api = new FileApi({ post } as unknown as AxiosInstance);
  const target = {
    fileId: 'file-id',
    uploadUrl: 'https://storage.example/app.tar.gz?signature=test',
    contentType: 'application/octet-stream',
  };
  const registration = {
    id: 'registration',
    universalIdentifier: 'app',
    name: 'App',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    post.mockReset();
    post.mockResolvedValueOnce({
      data: { data: { createAppTarballUpload: target } },
    });
    post.mockResolvedValueOnce({
      data: { data: { completeAppTarballUpload: registration } },
    });
    vi.spyOn(axios, 'put').mockResolvedValue({ status: 200 });
  });

  it('uploads a tarball above the multipart cap with PUT and JSON metadata calls', async () => {
    const tarballBuffer = Buffer.alloc(11 * 1024 * 1024);

    await expect(
      api.uploadAppTarball({ tarballBuffer, universalIdentifier: 'app' }),
    ).resolves.toEqual({ success: true, data: registration });

    expect(post.mock.calls[0][1]).toEqual({
      query: expect.stringContaining('createAppTarballUpload(size: $size)'),
      variables: { size: tarballBuffer.length },
    });
    const [uploadUrl, uploadedBuffer, options] = vi.mocked(axios.put).mock
      .calls[0];

    expect(uploadUrl).toBe(target.uploadUrl);
    expect(uploadedBuffer).toBe(tarballBuffer);
    expect(options).toEqual({
      headers: {
        'Content-Type': target.contentType,
        'Content-Length': tarballBuffer.length,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    expect(post.mock.calls[1][1]).toEqual({
      query: expect.stringContaining(
        'completeAppTarballUpload(fileId: $fileId',
      ),
      variables: { fileId: target.fileId, universalIdentifier: 'app' },
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(axios.put).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(axios.put).mock.invocationCallOrder[0]).toBeLessThan(
      post.mock.invocationCallOrder[1],
    );
  });

  it('lets the server derive the application identifier from the manifest', async () => {
    await api.uploadAppTarball({ tarballBuffer: Buffer.from('tarball') });

    expect(post.mock.calls[1][1].variables).toEqual({
      fileId: target.fileId,
      universalIdentifier: null,
    });
  });

  it('does not transfer bytes when creating the upload fails', async () => {
    post.mockReset().mockResolvedValue({
      data: { errors: [{ message: 'Tarball exceeds the size limit' }] },
    });

    await expect(
      api.uploadAppTarball({ tarballBuffer: Buffer.from('tarball') }),
    ).resolves.toEqual({
      success: false,
      error: 'Tarball exceeds the size limit',
    });
    expect(axios.put).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('falls back to multipart only when an older server lacks the new mutation', async () => {
    post
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          errors: [
            {
              message:
                'Cannot query field "createAppTarballUpload" on type "Mutation".',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { data: { uploadAppTarball: registration } },
      });

    await expect(
      api.uploadAppTarball({ tarballBuffer: Buffer.from('tarball') }),
    ).resolves.toEqual({ success: true, data: registration });
    expect(post.mock.calls[1][1]).toBeInstanceOf(FormData);
    expect(axios.put).not.toHaveBeenCalled();
  });

  it('does not finalize a failed storage upload', async () => {
    vi.mocked(axios.put).mockRejectedValue(new Error('Storage unavailable'));

    await expect(
      api.uploadAppTarball({ tarballBuffer: Buffer.from('tarball') }),
    ).resolves.toEqual({
      success: false,
      error: new Error('Storage unavailable'),
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('returns package validation errors from completion', async () => {
    post
      .mockReset()
      .mockResolvedValueOnce({
        data: { data: { createAppTarballUpload: target } },
      })
      .mockResolvedValueOnce({
        data: { errors: [{ message: 'Invalid manifest' }] },
      });

    await expect(
      api.uploadAppTarball({ tarballBuffer: Buffer.from('tarball') }),
    ).resolves.toEqual({ success: false, error: 'Invalid manifest' });
  });

  it('preserves the metadata authentication failure signal', async () => {
    post.mockReset().mockRejectedValue({
      isAxiosError: true,
      message: 'Unauthorized',
      response: { status: 401, data: {} },
    });

    await expect(
      api.uploadAppTarball({ tarballBuffer: Buffer.from('tarball') }),
    ).resolves.toEqual({
      success: false,
      error: 'Unauthorized',
      isAuthError: true,
    });
    expect(axios.put).not.toHaveBeenCalled();
  });
});
