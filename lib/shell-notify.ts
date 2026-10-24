// lib/shell-notify.ts
//
// 壳（FloatShell）原生系统通知的网页侧出口。
//
// 网页里的提醒原本有两套：站内横幅（CHAT_MESSAGE_NOTICE_EVENT）和浏览器系统通知
// （lib/browser-notification.ts）。Android WebView 里后者拿不到 Notification/Li
// PushManager，于是壳内过去只有站内横幅，通知栏/锁屏什么都没有。
//
// 这里把「发一条真正的系统通知」收敛成一个函数，转交给壳注入的原生桥：
//   window.AndroidShell.notify(title, body, avatarUrl) -> Boolean
// 壳侧用 NotificationManager 发到「角色消息」渠道，并尽量把角色头像作为大图标。
//
// 与 PushService 长连接的分工：
//   · PushService：App 被杀时的离线消息，由服务端生成后经 Supabase Realtime 广播；
//   · 本模块：网页活着时（前台/后台）的消息，直接让原生发一条本地通知。
// 两条路都落到同一个「角色消息」通知渠道，用户在通知栏看到的是统一的系统通知。

type ShellNotificationBridge = {
    /**
     * 第 4 个参数（会话 id）是后加的，用于让通知点击直达对应聊天：
     * 旧壳只认前三个参数，多传会被忽略，不会报错——新老壳都安全。
     */
    notify?: (title: string, body: string, avatarUrl: string, sessionId?: string) => boolean;
};

/**
 * 头像字符串的传递上限。角色头像是 data URL 时体积可能很大（几张图就是几百 KB），
 * 跨 JS 桥传大字符串既慢又占内存，超过这个长度就不带头像，宁可用默认图标。
 * 正常角色头像在几十 KB 量级，远低于此限。
 */
const MAX_AVATAR_URL_CHARS = 400_000;

function getBridge(): ShellNotificationBridge | null {
    if (typeof window === "undefined") return null;
    const bridge = (window as unknown as { AndroidShell?: ShellNotificationBridge }).AndroidShell;
    return bridge && typeof bridge.notify === "function" ? bridge : null;
}

/**
 * 当前环境能否发原生系统通知。
 * 旧版 APK 的 AndroidShell 没有 notify 方法（只有 getVersion 等），
 * 特性检测失败时返回 false，调用方自动退回浏览器通知路径，不会报错。
 */
export function canSendShellNotification(): boolean {
    return getBridge() !== null;
}

/** 头像只放行 data:image 内联和 http(s) 直链，其余（相对路径等）壳侧解不了。 */
function normalizeAvatar(avatar?: string | null): string {
    const value = typeof avatar === "string" ? avatar.trim() : "";
    if (!value || value.length > MAX_AVATAR_URL_CHARS) return "";
    if (value.startsWith("data:image/") || value.startsWith("http://") || value.startsWith("https://")) {
        return value;
    }
    return "";
}

/**
 * 同一条消息可能同时走两条链路请求通知：后台生成的 parseAndSaveResponse 会先派发
 * 站内横幅事件（desktop-shell 收到后转发），紧接着再调 sendBrowserNotification。
 * 两条都在同一个 tick 里发生，用极短窗口按「标题+正文」去重，保证一条消息
 * 只弹一条系统通知；窗口远小于消息分条的 800ms 间隔，不会误吞正常连发。
 */
let lastNoticeKey = "";
let lastNoticeAt = 0;
const NOTICE_DEDUPE_WINDOW_MS = 250;

/**
 * 同一会话在短时间内连续到达的消息（模型分条回复、追发）不再逐条响铃：
 * 等最后一条到达后再统一发一条，正文带上「N 条新消息」。
 * 只影响壳内系统通知；不同会话各自计时，互不覆盖。
 */
const NOTICE_MERGE_WINDOW_MS = 1200;
type PendingNotice = {
    title: string;
    body: string;
    avatar: string;
    sessionId: string;
    count: number;
    timer: number | null;
    lastBody: string;
    lastBodyAt: number;
};
const pendingNotices = new Map<string, PendingNotice>();

function flushShellNotification(key: string): void {
    const pending = pendingNotices.get(key);
    if (!pending) return;
    pendingNotices.delete(key);
    const bridge = getBridge();
    if (!bridge) return;
    const body = pending.count > 1
        ? `${pending.count} 条新消息 · ${pending.body}`
        : pending.body;
    try {
        bridge.notify?.(pending.title || "小手机", body, pending.avatar, pending.sessionId);
    } catch {
        // 桥调用异常（旧壳签名不匹配等）绝不能让业务逻辑崩掉
    }
}

/**
 * 发一条壳原生系统通知。非壳环境或旧版壳这是空操作（返回 false），
 * 调用方不需要自己也做环境判断。
 */
export function sendShellNotification(
    title: string,
    body: string,
    avatar?: string | null,
    sessionId?: string | null,
): boolean {
    const bridge = getBridge();
    if (!bridge) return false;
    const sid = sessionId?.trim() || "";
    const key = sid || `title:${title}`;
    const text = body || "";
    const now = Date.now();

    const pending = pendingNotices.get(key);
    if (pending) {
        // 同一条消息被两条链路重复请求：正文相同且在去重窗口内，不计入条数
        if (pending.lastBody === text && now - pending.lastBodyAt < NOTICE_DEDUPE_WINDOW_MS) return true;
        pending.count += 1;
        pending.title = title || pending.title;
        pending.body = text || pending.body;
        pending.avatar = normalizeAvatar(avatar) || pending.avatar;
        pending.lastBody = text;
        pending.lastBodyAt = now;
        if (pending.timer !== null) window.clearTimeout(pending.timer);
        pending.timer = window.setTimeout(() => flushShellNotification(key), NOTICE_MERGE_WINDOW_MS);
        return true;
    }

    const noticeKey = `${title}\u0000${text}`;
    if (noticeKey === lastNoticeKey && now - lastNoticeAt < NOTICE_DEDUPE_WINDOW_MS) return true;
    lastNoticeKey = noticeKey;
    lastNoticeAt = now;

    pendingNotices.set(key, {
        title: title || "小手机",
        body: text,
        avatar: normalizeAvatar(avatar),
        sessionId: sid,
        count: 1,
        timer: window.setTimeout(() => flushShellNotification(key), NOTICE_MERGE_WINDOW_MS),
        lastBody: text,
        lastBodyAt: now,
    });
    return true;
}
