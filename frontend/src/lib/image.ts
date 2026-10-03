/* Client-side media downscaling for WeHelpTeachers.
   Re-exports from unified mediaCompressor engine for backward compatibility. */

export {
  UPLOAD_TARGET_BYTES,
  MAX_SAFE_IMAGE_DIM,
  compressImage,
  compressPdf,
  compressMedia,
  compressMediaIfNeeded,
  compressImageIfNeeded,
  isImageFile,
  isPdfFile,
  type MediaCompressResult,
  type MediaCompressResult as CompressResult,
  type CompressOptions,
} from './mediaCompressor';
