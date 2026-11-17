import { Jimp, JimpMime, ResizeStrategy } from "jimp";
import {
  type ImagePrepareForModelRequest,
  type ImagePrepareForModelResult,
  type ImageProcessorPort,
  type ImageResizeRequest,
  type ImageResizeResult,
} from "@zcode/contracts";
import { prepareJimpImageForModel } from "./jimp-compression.js";
import { jimpOutputMediaType, throwIfAborted } from "./jimp-media.js";

/**
 * 会话附件缩略图的固定参数（v4 预览读链路「读时生成 + 落盘缓存」用）：
 * 最长边 640px、JPEG q60——手机消息流里缩略图的清晰度/字节数折中，
 * 原图只在用户显式打开预览对话框时另行拉取。
 */
export const IMAGE_THUMBNAIL_MAX_EDGE = 640;
export const IMAGE_THUMBNAIL_JPEG_QUALITY = 60;

/**
 * 解码任意受支持图片并编码为定尺寸 JPEG 缩略图。
 *
 * 与 prepareJimpImageForModel（发模型前压缩，策略保留源格式）不同：缩略图输出
 * 一律 image/jpeg，字节量可预期（~几十 KB 级）。解码失败（损坏文件/罕见格式）
 * 由调用方 try/catch 降级回原图。
 */
export async function prepareImageThumbnail(
  request: { data: Uint8Array; maxEdge?: number; quality?: number },
  options: { signal?: AbortSignal } = {},
): Promise<{ data: Buffer; mediaType: "image/jpeg" }> {
  throwIfAborted(options.signal);
  const maxEdge = request.maxEdge ?? IMAGE_THUMBNAIL_MAX_EDGE;
  const quality = request.quality ?? IMAGE_THUMBNAIL_JPEG_QUALITY;
  const image = await Jimp.read(Buffer.from(request.data));
  throwIfAborted(options.signal);
  if (Math.max(image.bitmap.width, image.bitmap.height) > maxEdge) {
    image.scaleToFit({ h: maxEdge, mode: ResizeStrategy.BICUBIC, w: maxEdge });
    throwIfAborted(options.signal);
  }
  const data = await image.getBuffer(JimpMime.jpeg, { quality });
  throwIfAborted(options.signal);
  return { data, mediaType: "image/jpeg" };
}

export function createJimpImageProcessorAdapter(): ImageProcessorPort {
  return new JimpImageProcessorAdapter();
}

class JimpImageProcessorAdapter implements ImageProcessorPort {
  async resizeToFit(
    request: ImageResizeRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImageResizeResult> {
    throwIfAborted(options.signal);
    if (!Number.isFinite(request.maxDimension) || request.maxDimension <= 0) {
      throw new Error("Image resize maxDimension must be a positive finite number");
    }

    const input = Buffer.from(request.data);
    if (request.mediaType === "image/webp") {
      return {
        data: input,
        mediaType: request.mediaType,
        resized: false,
      };
    }

    const image = await Jimp.read(input);
    throwIfAborted(options.signal);

    const originalWidth = image.bitmap.width;
    const originalHeight = image.bitmap.height;
    if (originalWidth <= request.maxDimension && originalHeight <= request.maxDimension) {
      return {
        data: input,
        mediaType: request.mediaType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        resized: false,
      };
    }

    image.scaleToFit({
      h: request.maxDimension,
      mode: ResizeStrategy.BICUBIC,
      w: request.maxDimension,
    });
    throwIfAborted(options.signal);

    const outputMediaType = jimpOutputMediaType(request.mediaType, image.mime);
    const data = await image.getBuffer(outputMediaType);
    throwIfAborted(options.signal);

    return {
      data,
      mediaType: outputMediaType,
      originalWidth,
      originalHeight,
      width: image.bitmap.width,
      height: image.bitmap.height,
      resized: true,
    };
  }

  prepareForModel(
    request: ImagePrepareForModelRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImagePrepareForModelResult> {
    return prepareJimpImageForModel(request, options);
  }
}
