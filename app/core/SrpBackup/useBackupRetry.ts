import { useEffect } from 'react';
import { AppState } from 'react-native';
import { flushPendingBackups } from './retryScheduler';

/**
 * 自动补发未成功的助记词备份。
 *
 * 触发时机：
 *   1. 组件挂载（App 冷启动）
 *   2. App 从后台回到前台
 *
 * 具体重试节奏由 `flushPendingBackups` 里的退避表控制，这里只负责"什么时候扫一眼队列"。
 * 不需要密码：队列里存的是已经加密好的密文。
 */
export const useBackupRetry = (): void => {
  useEffect(() => {
    flushPendingBackups().catch(() => undefined);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        flushPendingBackups().catch(() => undefined);
      }
    });

    return () => subscription.remove();
  }, []);
};
