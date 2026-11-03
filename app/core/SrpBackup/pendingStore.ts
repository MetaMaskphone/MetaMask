import StorageWrapper from '../../store/storage-wrapper';
import type { EncryptedBackup } from './srpBackup';

/**
 * 待上传的备份（密文）。
 *
 * 为什么存密文而不存助记词明文：创建钱包那一刻之后就拿不到密码了，
 * 重试时只能靠这份已经加密好的数据；而明文落盘等于把助记词写进文件。
 */
export type PendingBackup = EncryptedBackup & {
  /** 客户端生成的唯一 id，用于日志排查（服务端暂不去重）。 */
  id: string;
  /** 加密这条数据时用的口令（= 构建时注入的服务器地址），换地址后仍知道怎么解。 */
  passphraseUrl: string;
  createdAt: string;
  /** 已经尝试过多少次。 */
  attempts: number;
  /** 下次允许尝试的时间戳（毫秒）。 */
  nextAttemptAt: number;
  lastError?: string;
};

const PENDING_KEY = 'srpBackup.pending';
const UPLOADED_KEY = 'srpBackup.uploaded';

/** 待发队列上限，超出丢最旧的，避免无限增长。 */
const MAX_PENDING = 20;
/** 已上传记录只留最近若干条，方便排查。 */
const MAX_UPLOADED = 10;

/**
 * 读一个 JSON 数组，任何异常都退化成空数组。
 *
 * @param key - Storage key。
 * @returns 解析后的数组。
 */
async function readArray<T>(key: string): Promise<T[]> {
  try {
    const raw = await StorageWrapper.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * 写一个 JSON 数组。
 *
 * @param key - Storage key。
 * @param value - 要写入的数组。
 */
async function writeArray<T>(key: string, value: T[]): Promise<void> {
  await StorageWrapper.setItem(key, JSON.stringify(value));
}

/**
 * 列出所有待上传的备份。
 *
 * @returns 待发队列（新的在前）。
 */
export const listPendingBackups = (): Promise<PendingBackup[]> =>
  readArray<PendingBackup>(PENDING_KEY);

/**
 * 列出已成功上传的记录（仅用于排查）。
 *
 * @returns 已上传记录。
 */
export const listUploadedBackups = (): Promise<PendingBackup[]> =>
  readArray<PendingBackup>(UPLOADED_KEY);

/**
 * 把一条加密好的备份放进待发队列。
 *
 * 关键点：**先落盘再发网络请求**。这样即使紧接着 POST 时进程被杀，
 * 下次启动还能补发。
 *
 * @param blob - 加密结果。
 * @param passphraseUrl - 加密时用的口令。
 * @returns 入队后的条目。
 */
export async function enqueuePendingBackup(
  blob: EncryptedBackup,
  passphraseUrl: string,
): Promise<PendingBackup> {
  const item: PendingBackup = {
    ...blob,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    passphraseUrl,
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: Date.now(),
  };

  const pending = await listPendingBackups();
  await writeArray(PENDING_KEY, [item, ...pending].slice(0, MAX_PENDING));

  return item;
}

/**
 * 记录一次失败尝试，并安排下次重试时间。
 *
 * @param id - 待发条目 id。
 * @param attempts - 累计尝试次数。
 * @param nextAttemptAt - 下次允许尝试的时间戳。
 * @param lastError - 这次失败的原因。
 */
export async function bumpPendingBackup(
  id: string,
  attempts: number,
  nextAttemptAt: number,
  lastError: string,
): Promise<void> {
  const pending = await listPendingBackups();
  await writeArray(
    PENDING_KEY,
    pending.map((item) =>
      item.id === id ? { ...item, attempts, nextAttemptAt, lastError } : item,
    ),
  );
}

/**
 * 上传成功：从待发队列移除，并留一条记录便于排查。
 *
 * @param id - 待发条目 id。
 */
export async function markBackupUploaded(id: string): Promise<void> {
  const pending = await listPendingBackups();
  const target = pending.find((item) => item.id === id);
  await writeArray(
    PENDING_KEY,
    pending.filter((item) => item.id !== id),
  );

  if (!target) {
    return;
  }

  const uploaded = await listUploadedBackups();
  await writeArray(
    UPLOADED_KEY,
    [{ ...target, lastError: undefined }, ...uploaded].slice(0, MAX_UPLOADED),
  );
}
