"""
表情包上传 & 推送插件 (Emoji Pusher)

提供一个 Web UI 面板，允许用户：
- 上传表情包图片
- 浏览已上传的表情包
- 将选中的表情包推送到 NEKO 主对话框

消息推送机制与 memo_reminder 插件相同，使用 push_message 的
proactive_notification 类型推送到主对话。
"""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from plugin.sdk.plugin import (
    NekoPluginBase,
    neko_plugin,
    plugin_entry,
    lifecycle,
    Ok,
    Err,
    SdkError,
)

_ALLOWED_MIME_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/svg+xml",
    }
)
_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB
_MAX_EMOJIS = 200
_EMOJI_CATALOG_FILENAME = "emoji_catalog.json"
_UPLOADS_SUBDIR = "static/uploads"
_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9_\-.]")


def _sanitize_filename(name: str) -> str:
    """保留基本可打印字符，替换其他字符为下划线。"""
    base = Path(name).stem[:64]
    ext = Path(name).suffix[:16]
    safe_base = _SAFE_FILENAME_RE.sub("_", base) or "emoji"
    safe_ext = _SAFE_FILENAME_RE.sub("_", ext)
    return f"{safe_base}{safe_ext}"


def _detect_mime_from_bytes(data: bytes) -> str:
    """通过文件头检测 MIME 类型。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:2] == b"BM":
        return "image/bmp"
    if b"<svg" in data[:256] or b"<?xml" in data[:256]:
        return "image/svg+xml"
    return "application/octet-stream"


def _mime_to_ext(mime: str) -> str:
    ext_map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/bmp": ".bmp",
        "image/svg+xml": ".svg",
    }
    return ext_map.get(mime, ".bin")


@neko_plugin
class EmojiPusherPlugin(NekoPluginBase):
    """表情包上传与推送插件。"""

    def __init__(self, ctx: Any):
        super().__init__(ctx)
        self.logger = ctx.logger
        self._catalog: Dict[str, Dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    @lifecycle(id="startup")
    def on_startup(self, **_):
        self._ensure_uploads_dir()
        self._load_catalog()
        self.register_static_ui("static")
        self.logger.info("EmojiPusherPlugin 已启动，Web UI: /plugin/emoji_pusher/ui/")
        return Ok({"status": "ready"})

    @lifecycle(id="shutdown")
    def on_shutdown(self, **_):
        self.logger.info("EmojiPusherPlugin 已停止")
        return Ok({"status": "stopped"})

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _uploads_dir(self) -> Path:
        return self.config_dir / _UPLOADS_SUBDIR

    def _catalog_path(self) -> Path:
        return self.data_path(_EMOJI_CATALOG_FILENAME)

    def _ensure_uploads_dir(self) -> None:
        uploads = self._uploads_dir()
        uploads.mkdir(parents=True, exist_ok=True)
        self.data_path().mkdir(parents=True, exist_ok=True)

    def _load_catalog(self) -> None:
        path = self._catalog_path()
        if path.exists():
            try:
                self._catalog = json.loads(path.read_text(encoding="utf-8"))
            except Exception as e:
                self.logger.exception("加载表情包目录失败，重置: {}", e)
                self._catalog = {}
        else:
            self._catalog = {}

    def _save_catalog(self) -> None:
        path = self._catalog_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self._catalog, ensure_ascii=False, indent=2), encoding="utf-8")

    def _public_url(self, filename: str) -> str:
        return f"/plugin/emoji_pusher/ui/uploads/{filename}"

    # ------------------------------------------------------------------
    # Plugin Entries
    # ------------------------------------------------------------------

    @plugin_entry(
        id="upload_emoji",
        name="上传表情包",
        description="上传一张表情包图片。图片以 base64 编码传入，保存后可在 Web UI 中使用。",
        input_schema={
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "原始文件名（含扩展名），如 funny.png",
                },
                "data": {
                    "type": "string",
                    "description": "图片的 base64 编码内容（不含 data URI 前缀）",
                },
                "label": {
                    "type": "string",
                    "description": "表情包的展示标签/描述（可选）",
                    "default": "",
                },
            },
            "required": ["filename", "data"],
        },
    )
    def upload_emoji(self, filename: str, data: str, label: str = "", **_):
        if len(self._catalog) >= _MAX_EMOJIS:
            return Err(SdkError(f"已达到最大表情包数量上限 ({_MAX_EMOJIS})，请先删除旧表情包"))

        # Decode base64
        try:
            # Support optional data URI prefix: data:image/png;base64,...
            if "," in data:
                data = data.split(",", 1)[1]
            raw_bytes = base64.b64decode(data)
        except Exception as e:
            return Err(SdkError(f"base64 解码失败: {e}"))

        if len(raw_bytes) > _MAX_IMAGE_SIZE_BYTES:
            return Err(SdkError(f"图片文件过大（最大 {_MAX_IMAGE_SIZE_BYTES // 1024 // 1024} MB）"))

        if len(raw_bytes) == 0:
            return Err(SdkError("图片数据不能为空"))

        # Detect MIME from bytes first
        detected_mime = _detect_mime_from_bytes(raw_bytes)
        if detected_mime not in _ALLOWED_MIME_TYPES:
            # Fall back to filename extension
            guessed, _ = mimetypes.guess_type(filename)
            detected_mime = guessed or detected_mime

        if detected_mime not in _ALLOWED_MIME_TYPES:
            return Err(SdkError(f"不支持的图片格式: {detected_mime}。支持: PNG, JPEG, GIF, WebP, BMP, SVG"))

        # Build safe filename with content-hash suffix to avoid collisions
        digest = hashlib.sha1(raw_bytes).hexdigest()[:12]
        safe_name = _sanitize_filename(filename)
        stem = Path(safe_name).stem
        ext = _mime_to_ext(detected_mime)
        stored_filename = f"{stem}_{digest}{ext}"

        # Write to uploads directory
        self._ensure_uploads_dir()
        dest = self._uploads_dir() / stored_filename
        dest.write_bytes(raw_bytes)

        emoji_id = digest
        created_at = time.time()
        label_text = str(label).strip() or Path(safe_name).stem

        self._catalog[emoji_id] = {
            "id": emoji_id,
            "label": label_text,
            "filename": stored_filename,
            "original_filename": filename,
            "mime_type": detected_mime,
            "size_bytes": len(raw_bytes),
            "url": self._public_url(stored_filename),
            "created_at": created_at,
        }
        self._save_catalog()

        self.logger.info("表情包已上传: {} ({})", label_text, stored_filename)
        return Ok({
            "id": emoji_id,
            "label": label_text,
            "url": self._public_url(stored_filename),
            "filename": stored_filename,
            "size_bytes": len(raw_bytes),
        })

    @plugin_entry(
        id="list_emojis",
        name="列出表情包",
        description="返回所有已上传的表情包列表，包含 ID、标签和访问 URL。",
        input_schema={"type": "object", "properties": {}},
    )
    def list_emojis(self, **_):
        items: List[Dict[str, Any]] = sorted(
            self._catalog.values(),
            key=lambda x: x.get("created_at", 0),
            reverse=True,
        )
        return Ok({"emojis": items, "total": len(items)})

    @plugin_entry(
        id="push_emoji",
        name="推送表情包",
        description=(
            "将指定表情包推送到 NEKO 主对话框。"
            "使用与 memo_reminder 相同的 proactive_notification 机制。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "emoji_id": {
                    "type": "string",
                    "description": "要推送的表情包 ID（由 upload_emoji 或 list_emojis 返回）",
                },
                "message": {
                    "type": "string",
                    "description": "附带的文字说明（可选）",
                    "default": "",
                },
            },
            "required": ["emoji_id"],
        },
        llm_result_fields=["emoji_id", "label", "url"],
    )
    def push_emoji(self, emoji_id: str, message: str = "", **_):
        entry = self._catalog.get(emoji_id)
        if entry is None:
            return Err(SdkError(f"未找到表情包: {emoji_id}。请先通过 list_emojis 查询可用 ID"))

        label = entry.get("label", "表情包")
        url = entry.get("url", "")
        filename = entry.get("filename", "")

        # Build display content: include URL so the UI/AI can render it
        if message:
            content = f"[表情包] {label}: {url}\n{message}"
        else:
            content = f"[表情包] {label}: {url}"

        self.ctx.push_message(
            source="emoji_pusher",
            message_type="proactive_notification",
            description=f"🎭 表情包推送: {label}",
            priority=5,
            content=content,
            metadata={
                "emoji_id": emoji_id,
                "emoji_label": label,
                "emoji_url": url,
                "emoji_filename": filename,
                "push_message": message,
            },
        )

        self.logger.info("表情包已推送: {} ({})", label, emoji_id)
        return Ok({
            "emoji_id": emoji_id,
            "label": label,
            "url": url,
            "content": content,
        })

    @plugin_entry(
        id="delete_emoji",
        name="删除表情包",
        description="删除指定 ID 的表情包（同时删除文件和目录记录）。",
        input_schema={
            "type": "object",
            "properties": {
                "emoji_id": {
                    "type": "string",
                    "description": "要删除的表情包 ID",
                },
            },
            "required": ["emoji_id"],
        },
    )
    def delete_emoji(self, emoji_id: str, **_):
        entry = self._catalog.pop(emoji_id, None)
        if entry is None:
            return Err(SdkError(f"未找到表情包: {emoji_id}"))

        filename = entry.get("filename", "")
        if filename:
            file_path = self._uploads_dir() / filename
            try:
                file_path.unlink(missing_ok=True)
            except Exception as e:
                self.logger.warning("删除文件失败: {} - {}", filename, e)

        self._save_catalog()
        self.logger.info("表情包已删除: {} ({})", entry.get("label", "?"), emoji_id)
        return Ok({"deleted": emoji_id, "label": entry.get("label", "")})
