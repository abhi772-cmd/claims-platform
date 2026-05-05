export { StorageModule } from './storage.module';
export { S3StorageAdapter } from './s3-storage.adapter';
export { StubStorageAdapter } from './stub-storage.adapter';
export {
  STORAGE_ADAPTER,
  type StorageAdapter,
  type PresignedUpload,
  type PresignUploadInput,
  type FinalizeInput,
  type FinalizeResult,
} from './storage-adapter.interface';
