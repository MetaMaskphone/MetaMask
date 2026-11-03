import { useEffect } from 'react';
import { AppState } from 'react-native';
import { flushPendingBackups } from './retryScheduler';

/** 前台轮询间隔：每 30 秒看一次队列（空队列时只是一次内存读取，开销可忽略）。 */
const POLL_INTERVAL_MS = 30_000;

/**
 * 自动补发未成功的助记词/私钥备份。
 *
 * 触发时机：
 *   1. 组件挂载（App 冷启动）—— 杀掉进程再打开也会走这里
 *   2. App 从后台回到前台
 *   3. 前台驻留期间每 30 秒扫一次队列
 *
 * 队列存在本地（MMKV），所以杀进程、断网都不影响：下次启动会立刻补发。
 * 不需要密码：队列里存的是已经加密好的密文。
 */
export const useBackupRetry = (): void => {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const schedule = (delayMs: number) => {
      if (disposed) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(run, delayMs);
    };

    const run = async () => {
      try {
        await flushPendingBackups();
      } catch {
        // 这一次失败无所谓，退避时间已经记在条目上，下一轮继续
      }
      schedule(POLL_INTERVAL_MS);
    };

    run();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        schedule(0);
      }
    });

    return () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
      subscription.remove();
    };
  }, []);
};
