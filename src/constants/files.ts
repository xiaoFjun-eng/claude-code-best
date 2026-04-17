/**
 * 文本类操作应跳过的二进制文件扩展名。
 * 这些文件不宜按文本比较，且体积往往较大。
 */
export const BINARY_EXTENSIONS = new Set([
  // 图片
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.tiff',
  '.tif',
  // 视频
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.m4v',
  '.mpeg',
  '.mpg',
  // 音频
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
  '.wma',
  '.aiff',
  '.opus',
  // 压缩包
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.xz',
  '.z',
  '.tgz',
  '.iso',
  // 可执行文件/二进制
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.obj',
  '.lib',
  '.app',
  '.msi',
  '.deb',
  '.rpm',
  // 文档（PDF 在此；FileReadTool 在调用处单独排除）
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  // 字体
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  // 字节码 / 虚拟机产物
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.node',
  '.wasm',
  '.rlib',
  // 数据库文件
  '.sqlite',
  '.sqlite3',
  '.db',
  '.mdb',
  '.idx',
  // 设计 / 三维
  '.psd',
  '.ai',
  '.eps',
  '.sketch',
  '.fig',
  '.xd',
  '.blend',
  '.3ds',
  '.max',
  // Flash
  '.swf',
  '.fla',
  // 锁文件/分析数据
  '.lockb',
  '.dat',
  '.data',
])

/**
 * 判断路径是否带有「视为二进制」的扩展名。
 */
export function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

/**
 * 二进制内容探测时读取的字节数。
 */
const BINARY_CHECK_SIZE = 8192

/**
 * 通过空字节或不可打印字符占比判断 Buffer 是否更像二进制内容。
 */
export function isBinaryContent(buffer: Buffer): boolean {
  // 检查前 BINARY_CHECK_SIZE 字节（不足则检查整个 buffer）
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE)

  let nonPrintable = 0
  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!
    // 空字节强烈暗示二进制
    if (byte === 0) {
      return true
    }
    // 统计不可打印、非空白字节
    // 可打印 ASCII 为 32–126，常见空白为 9、10、13
    if (
      byte < 32 &&
      byte !== 9 && // 制表
      byte !== 10 && // 换行
      byte !== 13 // 回车
    ) {
      nonPrintable++
    }
  }

  // 不可打印超过约 10% 则视为二进制
  return nonPrintable / checkSize > 0.1
}
