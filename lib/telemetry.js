/**
 * 插件运行时可观测性：环形日志 + 最近一次召回/捕获状态。
 *
 * 只保存在进程内（最多 500 条）；不写盘、不含凭据。Host 的只读路由把它
 * 交给 Client 半的「状态与日志」面板。
 */
const MAX_ENTRIES = 500;
const MAX_DETAIL_CHARS = 4000;
/** 截断文本，避免日志/状态里塞入整段对话。 */
export function truncateText(value, max = 240) {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** 进程内可观测性状态。 */
export class Telemetry {
    state;
    logger;
    entries = [];
    seq = 0;
    constructor(logger) {
        this.logger = logger;
        this.state = {
            startedAt: new Date().toISOString(),
            config: {},
            capabilities: {},
            daily: { day: '', count: 0, limit: 0 },
            lastRecall: null,
            lastCapture: null,
        };
    }
    /** 写一条日志：环形缓冲 + dsh 控制台。 */
    log(level, area, message, detail) {
        this.seq += 1;
        const entry = {
            seq: this.seq,
            time: new Date().toISOString(),
            level,
            area,
            message,
        };
        if (detail !== undefined)
            entry.detail = Telemetry.boundDetail(detail);
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) {
            this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
        }
        const line = `[smriti] [${area}] ${message}`;
        if (level === 'error')
            this.logger.error(line);
        else if (level === 'warn')
            this.logger.warn(line);
        else if (level === 'debug')
            this.logger.debug(line);
        else
            this.logger.info(line);
    }
    /** 更新每日捕获计数快照。 */
    setDaily(day, count, limit) {
        this.state.daily = { day, count, limit };
    }
    /** 记录一次召回结果。 */
    recordRecall(state) {
        this.state.lastRecall = state;
    }
    /** 记录一次捕获尝试（无论是否命中）。 */
    recordCapture(state) {
        this.state.lastCapture = state;
    }
    /** 取增量日志与当前状态。 */
    snapshot(sinceSeq = 0, limit = 200) {
        const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
        const logs = this.entries.filter((entry) => entry.seq > sinceSeq).slice(-bounded);
        return {
            state: this.state,
            logs,
            lastSeq: this.seq,
        };
    }
    /** 防止 detail 里的巨大对象撑爆 HTTP 响应。 */
    static boundDetail(detail) {
        if (detail === undefined)
            return undefined;
        try {
            const text = JSON.stringify(detail);
            if (text.length <= MAX_DETAIL_CHARS)
                return detail;
            return `${text.slice(0, MAX_DETAIL_CHARS)}…`;
        }
        catch {
            return String(detail);
        }
    }
}
