import type { PtApp } from '@ptengine/app-sdk';

/**
 * 取平台注入的 window.PtApp。
 *
 * 独立打开构建产物（未经平台加载）时它是 undefined —— 这里返回 null 而不是抛错，
 * 让 UI 能给出可读的提示，而不是白屏。
 */
export function getPtApp(): PtApp | null {
    return (window as unknown as { PtApp?: PtApp }).PtApp ?? null;
}
