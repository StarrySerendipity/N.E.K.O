from __future__ import annotations

from datetime import datetime, timedelta, timezone


BJ_TZ = timezone(timedelta(hours=8))


def now_iso() -> str:
    """获取当前北京时间的ISO格式字符串
    
    Returns:
        ISO 8601格式的时间字符串,例如: "2024-01-24T20:00:00+08:00"
    """
    return datetime.now(BJ_TZ).isoformat()
