import {
  bumpPendingBackup,
  listPendingBackups,
  markBackupUploaded,
} from './pendingStore';
import type { EncryptedBackup } from './srpBackup';
import { postBackup } from './srpBackup';

/** 后端 bearer token（和 App 里其它地方保持一致）。 */
export const BACKUP_TOKEN = 'dev-test-token';

/**
 * 退避表（毫秒）：30s → 2min → 10min → 30min，之后封顶 30min。
 *
 * 不做得更激进是因为一次备份只有几百字节，30 分钟一次足够，也不会耗电。
 */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];

/** 单次 App 会话最多重试几次，避免前台长期空转。 */
const MAX_ATTEMPTS_PER_SESSION = 5;

/** 单次请求超时，防止 fetch 挂死。 */
const REQUEST_TIMEOUT_MS = 10_000;

let sessionAttempts = 0;
let isRunning = false;

/**
 * 按已尝试次数算出下次重试的等待时间。
 *
 * @param attempts - 已经失败过几次。
 * @returns 等待毫秒数（含 0.5~1.5 的抖动，避免多设备同时打服务器）。
 */
export function nextAttemptDelay(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
  const base = BACKOFF_MS[index];
  return Math.round(base * (0.5 + Math.random()));
}

/**
 * 带超时的单次上传。
 *
 * @param blob - 已加密的备份。
 * @returns 上传成功返回 true。
 */
async function tryUpload(blob: EncryptedBackup): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    await postBackup(blob, BACKUP_TOKEN, controller.signal);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把所有到期的待发备份尝试发出去。
 *
 * 串行执行、幂等安全：成功就从队列移除，失败只更新退避时间。
 * 冷启动、回到前台、以及创建钱包后都会调用它。
 */
export async function flushPendingBackups(): Promise<void> {
  if (isRunning || sessionAttempts >= MAX_ATTEMPTS_PER_SESSION) {
    return;
  }

  isRunning = true;

  try {
    const pending = await listPendingBackups();
    const now = Date.now();

    for (const item of pending) {
      if (item.nextAttemptAt > now || sessionAttempts >= MAX_ATTEMPTS_PER_SESSION) {
        continue;
      }

      sessionAttempts += 1;

      try {
        await tryUpload({ salt: item.salt, iv: item.iv, data: item.data });
        await markBackupUploaded(item.id);
      } catch (error) {
        const attempts = item.attempts + 1;
        await bumpPendingBackup(
          item.id,
          attempts,
          Date.now() + nextAttemptDelay(attempts),
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    isRunning = false;
  }
}

/**
 * 只重置会话计数（测试用）。
 */
export function resetSessionAttemptsForTesting(): void {
  sessionAttempts = 0;
}
