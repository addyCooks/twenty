import { Injectable, Logger } from '@nestjs/common';

import { FileFolder } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { v4 } from 'uuid';

import { ApplicationTarballService } from 'src/engine/core-modules/application/application-registration/application-tarball.service';
import {
  ApplicationRegistrationException,
  ApplicationRegistrationExceptionCode,
} from 'src/engine/core-modules/application/application-registration/application-registration.exception';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { FileStorageService } from 'src/engine/core-modules/file-storage/services/file-storage.service';
import { FileEntity } from 'src/engine/core-modules/file/entities/file.entity';
import { FileUploadCompletionService } from 'src/engine/core-modules/file/file-upload/services/file-upload-completion.service';
import { FileUploadTargetService } from 'src/engine/core-modules/file/file-upload/services/file-upload-target.service';
import { FILE_STATUS } from 'src/engine/core-modules/file/types/file-status.types';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { StreamSizeExceededError } from 'src/utils/stream-size-exceeded-error';
import { streamToBuffer } from 'src/utils/stream-to-buffer';

@Injectable()
export class ApplicationTarballUploadService {
  private readonly logger = new Logger(ApplicationTarballUploadService.name);

  constructor(
    private readonly applicationService: ApplicationService,
    private readonly applicationTarballService: ApplicationTarballService,
    private readonly fileStorageService: FileStorageService,
    private readonly fileUploadTargetService: FileUploadTargetService,
    private readonly fileUploadCompletionService: FileUploadCompletionService,
    private readonly twentyConfigService: TwentyConfigService,
    @InjectWorkspaceScopedRepository(FileEntity)
    private readonly fileRepository: WorkspaceScopedRepository<FileEntity>,
  ) {}

  async createUpload({
    workspaceId,
    size,
  }: {
    workspaceId: string;
    size: number;
  }) {
    this.validateSize(size);

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const fileId = v4();
    const resourcePath = `uploads/${fileId}/app.tar.gz`;
    const location = {
      workspaceId,
      applicationUniversalIdentifier:
        workspaceCustomFlatApplication.universalIdentifier,
      fileFolder: FileFolder.AppTarball,
      resourcePath,
    };

    await this.fileStorageService.createPendingFile({
      ...location,
      applicationId: workspaceCustomFlatApplication.id,
      fileId,
      size,
      mimeType: 'application/octet-stream',
      settings: { isTemporaryFile: true, toDelete: false },
    });

    return this.fileUploadTargetService.buildUploadTarget({
      ...location,
      fileId,
      size,
      contentType: 'application/octet-stream',
    });
  }

  async completeUpload({
    workspaceId,
    fileId,
    universalIdentifier,
  }: {
    workspaceId: string;
    fileId: string;
    universalIdentifier?: string;
  }) {
    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const resourcePath = `uploads/${fileId}/app.tar.gz`;
    const file = await this.fileRepository.findOne(workspaceId, {
      where: {
        id: fileId,
        applicationId: workspaceCustomFlatApplication.id,
        path: `${FileFolder.AppTarball}/${resourcePath}`,
      },
    });

    if (
      !isDefined(file) ||
      file.status !== FILE_STATUS.PENDING ||
      file.settings?.isTemporaryFile !== true
    ) {
      throw new ApplicationRegistrationException(
        'No pending tarball upload found for this workspace.',
        ApplicationRegistrationExceptionCode.INVALID_INPUT,
      );
    }

    const maxSize = this.validateSize(Number(file.size));
    const location = {
      workspaceId,
      applicationUniversalIdentifier:
        workspaceCustomFlatApplication.universalIdentifier,
      fileFolder: FileFolder.AppTarball,
      resourcePath,
    };

    // Check the stored size and promote the inspected object out of the
    // writable upload location before parsing or registering the package.
    await this.fileUploadCompletionService.completeUploadedFile({
      workspaceId,
      file,
      storageLocation: location,
    });

    try {
      const stream = await this.fileStorageService.readFile(location);
      const tarballBuffer = await streamToBuffer(stream, maxSize);

      return await this.applicationTarballService.uploadTarball({
        tarballBuffer,
        universalIdentifier,
        ownerWorkspaceId: workspaceId,
      });
    } catch (error) {
      if (error instanceof StreamSizeExceededError) {
        throw new ApplicationRegistrationException(
          `Tarball exceeds maximum size of ${maxSize} bytes`,
          ApplicationRegistrationExceptionCode.INVALID_INPUT,
        );
      }

      throw error;
    } finally {
      // Registration stores its own durable copy; this staging file is also
      // disposable when package validation fails.
      await this.fileStorageService.deleteFile(location).catch(() => {
        this.logger.warn(`Could not delete temporary tarball upload ${fileId}`);
      });
    }
  }

  private validateSize(size: number): number {
    const maxSize = this.twentyConfigService.get(
      'MAX_TARBALL_UPLOAD_SIZE_BYTES',
    );

    if (!Number.isSafeInteger(size) || size <= 0 || size > maxSize) {
      throw new ApplicationRegistrationException(
        `Invalid tarball size ${size} (max ${maxSize} bytes)`,
        ApplicationRegistrationExceptionCode.INVALID_INPUT,
      );
    }

    return maxSize;
  }
}
