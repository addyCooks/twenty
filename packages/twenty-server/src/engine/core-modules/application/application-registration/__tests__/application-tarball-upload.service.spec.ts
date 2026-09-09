import { Readable } from 'stream';
import { FileFolder } from 'twenty-shared/types';

import { ApplicationTarballUploadService } from 'src/engine/core-modules/application/application-registration/application-tarball-upload.service';
import { FILE_STATUS } from 'src/engine/core-modules/file/types/file-status.types';

describe('ApplicationTarballUploadService', () => {
  const workspaceId = 'workspace';
  const fileId = 'file-id';
  const maxSize = 100 * 1024 * 1024;
  const application = {
    id: 'custom-app',
    universalIdentifier: 'custom-app-uid',
  };
  const location = {
    workspaceId,
    applicationUniversalIdentifier: application.universalIdentifier,
    fileFolder: FileFolder.AppTarball,
    resourcePath: `uploads/${fileId}/app.tar.gz`,
  };
  const applicationService = {
    findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest.fn(),
  };
  const tarballService = { uploadTarball: jest.fn() };
  const storage = {
    createPendingFile: jest.fn(),
    readFile: jest.fn(),
    deleteFile: jest.fn(),
  };
  const targets = { buildUploadTarget: jest.fn() };
  const completion = { completeUploadedFile: jest.fn() };
  const config = { get: jest.fn() };
  const repository = { findOne: jest.fn() };
  const service = new ApplicationTarballUploadService(
    applicationService as never,
    tarballService as never,
    storage as never,
    targets as never,
    completion as never,
    config as never,
    repository as never,
  );
  const pendingFile = {
    id: fileId,
    applicationId: application.id,
    path: `${FileFolder.AppTarball}/${location.resourcePath}`,
    size: 11 * 1024 * 1024,
    status: FILE_STATUS.PENDING,
    settings: { isTemporaryFile: true, toDelete: false },
  };

  beforeEach(() => {
    jest.resetAllMocks();
    applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow.mockResolvedValue(
      { workspaceCustomFlatApplication: application },
    );
    config.get.mockReturnValue(maxSize);
    repository.findOne.mockResolvedValue(pendingFile);
    storage.readFile.mockImplementation(() =>
      Readable.from(Buffer.from('tarball')),
    );
    storage.deleteFile.mockResolvedValue(undefined);
    tarballService.uploadTarball.mockResolvedValue({ id: 'registration' });
    targets.buildUploadTarget.mockResolvedValue({
      fileId,
      uploadUrl: 'https://storage.example',
    });
  });

  it('creates a workspace-scoped pending tarball with the exact declared size', async () => {
    await service.createUpload({ workspaceId, size: maxSize });

    const pending = storage.createPendingFile.mock.calls[0][0];

    expect(pending).toEqual({
      workspaceId,
      applicationId: application.id,
      applicationUniversalIdentifier: application.universalIdentifier,
      fileFolder: FileFolder.AppTarball,
      resourcePath: `uploads/${pending.fileId}/app.tar.gz`,
      fileId: expect.any(String),
      size: maxSize,
      mimeType: 'application/octet-stream',
      settings: { isTemporaryFile: true, toDelete: false },
    });
    expect(targets.buildUploadTarget).toHaveBeenCalledWith({
      ...location,
      fileId: pending.fileId,
      resourcePath: pending.resourcePath,
      size: maxSize,
      contentType: 'application/octet-stream',
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity, maxSize + 1])(
    'rejects invalid declared size %s before creating a target',
    async (size) => {
      await expect(service.createUpload({ workspaceId, size })).rejects.toThrow(
        'Invalid tarball size',
      );
      expect(storage.createPendingFile).not.toHaveBeenCalled();
      expect(targets.buildUploadTarget).not.toHaveBeenCalled();
    },
  );

  it('promotes the checked object before reading and registering it, then removes staging', async () => {
    const tarballBuffer = Buffer.alloc(11 * 1024 * 1024);
    storage.readFile.mockResolvedValue(Readable.from(tarballBuffer));

    await expect(
      service.completeUpload({
        workspaceId,
        fileId,
        universalIdentifier: 'app',
      }),
    ).resolves.toEqual({ id: 'registration' });

    expect(repository.findOne).toHaveBeenCalledWith(workspaceId, {
      where: {
        id: fileId,
        applicationId: application.id,
        path: pendingFile.path,
      },
    });
    expect(completion.completeUploadedFile).toHaveBeenCalledWith({
      workspaceId,
      file: pendingFile,
      storageLocation: location,
    });
    const uploaded = tarballService.uploadTarball.mock.calls[0][0];

    expect(uploaded.universalIdentifier).toBe('app');
    expect(uploaded.ownerWorkspaceId).toBe(workspaceId);
    expect(uploaded.tarballBuffer.equals(tarballBuffer)).toBe(true);
    expect(
      completion.completeUploadedFile.mock.invocationCallOrder[0],
    ).toBeLessThan(storage.readFile.mock.invocationCallOrder[0]);
    expect(
      tarballService.uploadTarball.mock.invocationCallOrder[0],
    ).toBeLessThan(storage.deleteFile.mock.invocationCallOrder[0]);
    expect(storage.deleteFile).toHaveBeenCalledWith(location);
  });

  it.each([
    null,
    { ...pendingFile, status: FILE_STATUS.UPLOADED },
    { ...pendingFile, settings: { isTemporaryFile: false } },
  ])('rejects missing, foreign, or finalized upload records', async (file) => {
    repository.findOne.mockResolvedValue(file);
    await expect(
      service.completeUpload({ workspaceId, fileId }),
    ).rejects.toThrow('No pending tarball upload');
    expect(completion.completeUploadedFile).not.toHaveBeenCalled();
    expect(storage.readFile).not.toHaveBeenCalled();
  });

  it('rechecks the configured limit before accessing storage', async () => {
    config.get.mockReturnValue(pendingFile.size - 1);
    await expect(
      service.completeUpload({ workspaceId, fileId }),
    ).rejects.toThrow('Invalid tarball size');
    expect(completion.completeUploadedFile).not.toHaveBeenCalled();
  });

  it('does not register an upload rejected by storage completion', async () => {
    completion.completeUploadedFile.mockRejectedValue(
      new Error('File size mismatch'),
    );
    await expect(
      service.completeUpload({ workspaceId, fileId }),
    ).rejects.toThrow('File size mismatch');
    expect(storage.readFile).not.toHaveBeenCalled();
    expect(tarballService.uploadTarball).not.toHaveBeenCalled();
  });

  it('bounds reads even if storage reports an understated size', async () => {
    config.get.mockReturnValue(3);
    repository.findOne.mockResolvedValue({ ...pendingFile, size: 3 });
    storage.readFile.mockResolvedValue(Readable.from(Buffer.alloc(4)));

    await expect(
      service.completeUpload({ workspaceId, fileId }),
    ).rejects.toThrow('Tarball exceeds maximum size');
    expect(tarballService.uploadTarball).not.toHaveBeenCalled();
    expect(storage.deleteFile).toHaveBeenCalledWith(location);
  });

  it('cleans up staging when existing package validation rejects the tarball', async () => {
    tarballService.uploadTarball.mockRejectedValue(
      new Error('Invalid manifest'),
    );
    await expect(
      service.completeUpload({ workspaceId, fileId }),
    ).rejects.toThrow('Invalid manifest');
    expect(storage.deleteFile).toHaveBeenCalledWith(location);
  });
});
