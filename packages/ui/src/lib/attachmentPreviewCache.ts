/**
 * 附件/media 预览 Blob URL 的模块级 LRU 缓存。
 *
 * 为什么放模块级：切会话只是虚拟列表卸载行组件，Blob 生命周期若挂在组件上
 * （卸载即 revokeObjectURL），切回就必须重新走 512KB/块的分块读——这正是
 * 「切会话 4-5 秒 1-2MB/s 大流量」的前端一半根因。收口到模块级后：
 * 命中不重复拉；组件卸载不 revoke，切回零流量复用；淘汰时才统一 revoke。
 *
 * key 直接用附件/artifact 的 ref：ref 已全局唯一——用户上传件是
 * `zcode-artifact://<sessionId>/<tool-result-<UUID>>`（内嵌 sessionId + 随机
 * UUID），markdown 工件图与 share 变体（`zcode-artifact://share/<id>`）同理，
 * 无需再拼 sessionId（conversationRowView 与 markdown-image 的 ref 取法不同
 * 也不会互相命中：前者是 AttachmentRef.ref/previewRef，后者是 zcode-artifact://
 * 完整 URI，两个键空间互斥）。
 *
 * 双限（先触发者生效）：
 * - 48 项：防小图把 Map 撑成大对象数组；
 * - 96MiB 字节总量：防大图/视频把 Blob 堆超移动端可承受内存。
 * Desktop 本地媒体返回的自定义协议 URL（非 renderer 创建的 Blob）不进缓存，
 * 由调用方按原生命周期处理。
 */

const MAX_ENTRIES = 48;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;

/**
 * 服务端缩略图触发下限（CLI 侧 readPromptAttachmentWithThumbnail 同值同语义）：
 * 附件声明 bytes 超过它时，消息流拿到的 src 是服务端 640px 缩略图，
 * 预览对话框打开需要再拉一次原图。前端只做判断，不能改两端任一侧。
 */
export const ATTACHMENT_THUMBNAIL_MIN_BYTES = 256 * 1024;

interface PreviewCacheEntry {
  blobUrl: string;
  bytes: number;
}

const cache = new Map<string, PreviewCacheEntry>();
let totalBytes = 0;

function evictOverflow(): void {
  // Map 迭代序即插入序；每次 get/set 都把命中项移到尾部，最旧项在头部。
  while (cache.size > MAX_ENTRIES || (cache.size > 0 && totalBytes > MAX_TOTAL_BYTES)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    remove(oldestKey);
  }
}

function remove(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  totalBytes = Math.max(0, totalBytes - entry.bytes);
  URL.revokeObjectURL(entry.blobUrl);
}

export function getAttachmentPreviewUrl(ref: string): string | null {
  const entry = cache.get(ref);
  if (!entry) return null;
  // 触碰 LRU：删了重插，命中项移到尾部。
  cache.delete(ref);
  cache.set(ref, entry);
  return entry.blobUrl;
}

/** 命中返回复用 URL 并计一次 LRU 触碰；未命中用 bytes 创建 Blob URL 并入缓存。 */
export function putAttachmentPreviewUrl(
  ref: string,
  bytes: Uint8Array,
  mediaType: string,
): string {
  const existing = cache.get(ref);
  if (existing) {
    // 同 ref 的重复 put 只可能来自并发读取竞态；保留首个 URL，丢弃本次字节。
    cache.delete(ref);
    cache.set(ref, existing);
    return existing.blobUrl;
  }
  // 传输层返回的可能是共享缓冲的 view；Blob 构造需要独占 ArrayBuffer 拷贝。
  const blobUrl = URL.createObjectURL(
    new Blob([Uint8Array.from(bytes)], { type: mediaType }),
  );
  cache.set(ref, { blobUrl, bytes: bytes.byteLength });
  totalBytes += bytes.byteLength;
  evictOverflow();
  return blobUrl;
}

/** 仅测试/热重载使用：清空全部缓存并 revoke。 */
export function clearAttachmentPreviewCacheForTest(): void {
  // remove 会从 Map 中删除条目，直接迭代会跳项；先摘出 key 再逐个清。
  for (const key of Array.from(cache.keys())) remove(key);
}
