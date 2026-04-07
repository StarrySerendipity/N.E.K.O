"""
表情包推送插件 (Emoji Pusher)

通过 Web UI 上传表情包，并通过 push_message 推送到主对话窗口。
Web UI 访问地址：/plugin/emoji_pusher/ui/

通信流程：
  Web UI → POST /runs {plugin_id, entry_id, args}
         → EmojiPusherPlugin.push_emoji(image_base64, filename, ...)
         → self.ctx.push_message(message_type="binary", binary_data=...)
         → 主对话窗口显示表情包
"""

from __future__ import annotations

import base64
import uuid
from pathlib import Path
from typing import Any, List

from plugin.sdk.plugin import (
    NekoPluginBase,
    neko_plugin,
    plugin_entry,
    lifecycle,
    Ok,
    Err,
    SdkError,
)

# 允许的图片扩展名
_ALLOWED_EXTENSIONS = frozenset({
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
})

# 单张表情包最大文件尺寸（5 MB）
_MAX_SIZE_BYTES = 5 * 1024 * 1024

# 图库最大存储条目数
_MAX_GALLERY_ITEMS = 200

_GALLERY_STORE_KEY = "emoji_gallery"


def _ext_to_mime(ext: str) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
    }.get(ext.lower(), "application/octet-stream")


def _strip_data_uri(raw: str) -> str:
    """去除 data URI 前缀（如 data:image/gif;base64,…），返回纯 Base64 字符串。"""
    raw = raw.strip()
    if raw.startswith("data:") and "," in raw:
        return raw.split(",", 1)[1]
    return raw


def _validate_image(image_base64: str, filename: str) -> tuple[bytes, str] | tuple[None, str]:
    """校验并解码 Base64 图片数据。

    Returns:
        (image_bytes, ext) 成功时，或 (None, error_message) 失败时。
    """
    if not isinstance(image_base64, str) or not image_base64.strip():
        return None, "image_base64 不能为空"

    name = (filename or "emoji.png").strip()
    ext = Path(name).suffix.lower()
    if ext not in _ALLOWED_EXTENSIONS:
        return None, (
            f"不支持的图片格式 '{ext}'。"
            f"支持的格式: {', '.join(sorted(_ALLOWED_EXTENSIONS))}"
        )

    raw = _strip_data_uri(image_base64)
    try:
        image_bytes = base64.b64decode(raw, validate=True)
    except Exception as exc:
        return None, f"Base64 解码失败: {exc}"

    if len(image_bytes) > _MAX_SIZE_BYTES:
        size_mb = len(image_bytes) / (1024 * 1024)
        limit_mb = _MAX_SIZE_BYTES / (1024 * 1024)
        return None, f"图片大小 {size_mb:.1f} MB 超过限制 {limit_mb} MB"

    return image_bytes, ext


@neko_plugin
class EmojiPusherPlugin(NekoPluginBase):
    """表情包推送插件 — 允许通过 Web UI 上传并推送表情包到主对话窗口。"""

    def __init__(self, ctx: Any):
        super().__init__(ctx)
        self.logger = ctx.logger

    # ──────────────────────────── 生命周期 ────────────────────────────

    @lifecycle(id="startup")
    def on_startup(self, **_):
        registered = self.register_static_ui("static")
        plugin_id = self.plugin_id
        if registered:
            self.logger.info(
                "EmojiPusherPlugin 已启动，Web UI: /plugin/{}/ui/", plugin_id
            )
        else:
            self.logger.warning(
                "EmojiPusherPlugin 已启动，但未找到 static/ 目录，Web UI 不可用。"
            )
        return Ok({"status": "ready", "ui": f"/plugin/{plugin_id}/ui/"})

    @lifecycle(id="shutdown")
    def on_shutdown(self, **_):
        self.logger.info("EmojiPusherPlugin 已停止")
        return Ok({"status": "stopped"})

    # ──────────────────────────── 核心入口 ────────────────────────────

    @plugin_entry(
        id="push_emoji",
        name="推送表情包",
        description=(
            "将表情包图片推送到主对话窗口。"
            "图片以 Base64 编码传入（可含 data URI 前缀），"
            "插件解码后通过消息系统投递到主对话。\n"
            "Web UI 访问地址：/plugin/emoji_pusher/ui/"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "image_base64": {
                    "type": "string",
                    "description": (
                        "Base64 编码的图片数据。"
                        "可含 data URI 前缀（如 data:image/gif;base64,…），也可以是纯 Base64 字符串。"
                    ),
                },
                "filename": {
                    "type": "string",
                    "description": "文件名，用于标识文件类型，如 emoji.gif。默认 emoji.png。",
                    "default": "emoji.png",
                },
                "description": {
                    "type": "string",
                    "description": "可选描述，展示在消息旁边。",
                    "default": "",
                },
            },
            "required": ["image_base64"],
        },
        llm_result_fields=["pushed", "filename"],
    )
    def push_emoji(
        self,
        image_base64: str,
        filename: str = "emoji.png",
        description: str = "",
        **_,
    ):
        image_bytes, ext_or_error = _validate_image(image_base64, filename)
        if image_bytes is None:
            return Err(SdkError(ext_or_error))

        name = (filename or "emoji.png").strip()
        msg_description = description.strip() if description else f"🎭 表情包: {name}"

        self.ctx.push_message(
            source="emoji_pusher",
            message_type="binary",
            description=msg_description,
            priority=5,
            binary_data=image_bytes,
            metadata={
                "filename": name,
                "size_bytes": len(image_bytes),
                "content_type": _ext_to_mime(ext_or_error),
            },
        )

        self.logger.info(
            "Emoji pushed: filename={}, size={} bytes", name, len(image_bytes)
        )
        return Ok({
            "pushed": True,
            "filename": name,
            "size_bytes": len(image_bytes),
        })

    # ──────────────────────────── 图库管理 ────────────────────────────

    @plugin_entry(
        id="save_emoji",
        name="保存表情包到图库",
        description="将表情包保存到插件图库，方便以后重复使用。",
        input_schema={
            "type": "object",
            "properties": {
                "image_base64": {
                    "type": "string",
                    "description": "Base64 编码的图片数据（可含 data URI 前缀）。",
                },
                "filename": {
                    "type": "string",
                    "description": "文件名，如 happy.gif。",
                    "default": "emoji.png",
                },
                "label": {
                    "type": "string",
                    "description": "可选标签/备注，方便识别。",
                    "default": "",
                },
            },
            "required": ["image_base64"],
        },
        llm_result_fields=["saved", "emoji_id"],
    )
    def save_emoji(
        self,
        image_base64: str,
        filename: str = "emoji.png",
        label: str = "",
        **_,
    ):
        image_bytes, ext_or_error = _validate_image(image_base64, filename)
        if image_bytes is None:
            return Err(SdkError(ext_or_error))

        name = (filename or "emoji.png").strip()
        gallery = self._load_gallery()

        if len(gallery) >= _MAX_GALLERY_ITEMS:
            return Err(SdkError(
                f"图库已达上限 ({_MAX_GALLERY_ITEMS} 条)，请先删除部分表情包。"
            ))

        emoji_id = uuid.uuid4().hex[:12]
        entry = {
            "id": emoji_id,
            "filename": name,
            "label": label.strip(),
            "size_bytes": len(image_bytes),
            "content_type": _ext_to_mime(ext_or_error),
            "data_base64": base64.b64encode(image_bytes).decode("ascii"),
        }
        gallery.append(entry)
        self._save_gallery(gallery)

        self.logger.info("Emoji saved: id={}, filename={}", emoji_id, name)
        return Ok({"saved": True, "emoji_id": emoji_id, "filename": name})

    @plugin_entry(
        id="list_emojis",
        name="列出图库表情包",
        description="列出图库中已保存的所有表情包（不含图片数据，只含元信息）。",
        llm_result_fields=["count"],
    )
    def list_emojis(self, **_):
        gallery = self._load_gallery()
        items: List[dict] = [
            {
                "id": e.get("id", ""),
                "filename": e.get("filename", ""),
                "label": e.get("label", ""),
                "size_bytes": e.get("size_bytes", 0),
                "content_type": e.get("content_type", ""),
            }
            for e in gallery
        ]
        return Ok({"count": len(items), "emojis": items})

    @plugin_entry(
        id="delete_emoji",
        name="从图库删除表情包",
        description="根据 emoji_id 从图库中删除一个表情包。",
        input_schema={
            "type": "object",
            "properties": {
                "emoji_id": {
                    "type": "string",
                    "description": "要删除的表情包 ID（来自 save_emoji 或 list_emojis 返回值）。",
                },
            },
            "required": ["emoji_id"],
        },
        llm_result_fields=["deleted"],
    )
    def delete_emoji(self, emoji_id: str, **_):
        if not isinstance(emoji_id, str) or not emoji_id.strip():
            return Err(SdkError("emoji_id 不能为空"))

        gallery = self._load_gallery()
        eid = emoji_id.strip()
        new_gallery = [e for e in gallery if e.get("id") != eid]

        if len(new_gallery) == len(gallery):
            return Err(SdkError(f"未找到表情包: {eid}"))

        self._save_gallery(new_gallery)
        self.logger.info("Emoji deleted: id={}", eid)
        return Ok({"deleted": eid, "remaining": len(new_gallery)})

    @plugin_entry(
        id="push_saved_emoji",
        name="推送图库中的表情包",
        description="从图库中选取一个表情包并推送到主对话窗口。",
        input_schema={
            "type": "object",
            "properties": {
                "emoji_id": {
                    "type": "string",
                    "description": "要推送的表情包 ID（来自 list_emojis 返回值）。",
                },
                "description": {
                    "type": "string",
                    "description": "可选描述，展示在消息旁边。",
                    "default": "",
                },
            },
            "required": ["emoji_id"],
        },
        llm_result_fields=["pushed", "filename"],
    )
    def push_saved_emoji(self, emoji_id: str, description: str = "", **_):
        if not isinstance(emoji_id, str) or not emoji_id.strip():
            return Err(SdkError("emoji_id 不能为空"))

        gallery = self._load_gallery()
        eid = emoji_id.strip()
        entry = next((e for e in gallery if e.get("id") == eid), None)
        if entry is None:
            return Err(SdkError(f"未找到表情包: {eid}"))

        data_b64 = entry.get("data_base64", "")
        try:
            image_bytes = base64.b64decode(data_b64)
        except Exception as exc:
            return Err(SdkError(f"图库数据损坏，解码失败: {exc}"))

        name = entry.get("filename", "emoji.png")
        label = entry.get("label", "")
        msg_description = (
            description.strip()
            or (label if label else f"🎭 表情包: {name}")
        )

        self.ctx.push_message(
            source="emoji_pusher",
            message_type="binary",
            description=msg_description,
            priority=5,
            binary_data=image_bytes,
            metadata={
                "emoji_id": eid,
                "filename": name,
                "size_bytes": len(image_bytes),
                "content_type": entry.get("content_type", "application/octet-stream"),
            },
        )

        self.logger.info(
            "Saved emoji pushed: id={}, filename={}, size={} bytes",
            eid, name, len(image_bytes),
        )
        return Ok({"pushed": True, "emoji_id": eid, "filename": name})

    # ──────────────────────────── 存储辅助 ────────────────────────────

    def _load_gallery(self):
        if not self.store.enabled:
            return []
        try:
            data = self.store._read_value(_GALLERY_STORE_KEY, [])
            return data if isinstance(data, list) else []
        except Exception as exc:
            self.logger.warning("Failed to load emoji gallery: {}", exc)
            return []

    def _save_gallery(self, gallery: list) -> None:
        if not self.store.enabled:
            return
        try:
            self.store._write_value(_GALLERY_STORE_KEY, gallery)
        except Exception as exc:
            self.logger.warning("Failed to save emoji gallery: {}", exc)
