"""Unit tests for the emoji_pusher plugin."""

from __future__ import annotations

import base64
import struct
import tempfile
from pathlib import Path
from typing import Any

import pytest

from plugin.plugins.emoji_pusher import EmojiPusherPlugin
from plugin.sdk.plugin import Ok, Err


# ---------------------------------------------------------------------------
# Minimal fake context
# ---------------------------------------------------------------------------


class _Logger:
    def info(self, *args, **kwargs): pass
    def warning(self, *args, **kwargs): pass
    def error(self, *args, **kwargs): pass
    def debug(self, *args, **kwargs): pass
    def exception(self, *args, **kwargs): pass


class _Ctx:
    plugin_id = "emoji_pusher"
    metadata: dict[str, Any] = {}
    bus = None

    def __init__(self, tmp_dir: Path) -> None:
        self.logger = _Logger()
        self.config_path = tmp_dir / "plugin.toml"
        self.config_path.touch()
        self.pushed_messages: list[dict[str, Any]] = []

    def push_message(self, **kwargs: Any) -> None:
        self.pushed_messages.append(dict(kwargs))

    def update_status(self, status: dict[str, Any]) -> None:
        pass

    @property
    def message_queue(self):
        return None


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_dir(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture
def ctx(tmp_dir: Path) -> _Ctx:
    return _Ctx(tmp_dir)


@pytest.fixture
def plugin(ctx: _Ctx) -> EmojiPusherPlugin:
    p = EmojiPusherPlugin(ctx)
    # Manually trigger startup logic (without register_static_ui side-effects)
    p._ensure_uploads_dir()
    p._load_catalog()
    return p


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_png_bytes() -> bytes:
    """Return a minimal valid 1x1 PNG."""
    # 1×1 white PNG (hardcoded minimal structure)
    png = (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
        b"\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    return png


def _make_gif_bytes() -> bytes:
    """Return a minimal valid 1x1 GIF."""
    return (
        b"GIF89a"
        b"\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00"
        b"!\xf9\x04\x00\x00\x00\x00\x00"
        b",\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
    )


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


# ---------------------------------------------------------------------------
# Tests: upload_emoji
# ---------------------------------------------------------------------------


class TestUploadEmoji:
    def test_upload_valid_png(self, plugin: EmojiPusherPlugin):
        png = _make_png_bytes()
        result = plugin.upload_emoji(filename="test.png", data=_b64(png), label="test emoji")
        assert isinstance(result, Ok), f"Expected Ok, got {result}"
        val = result.value
        assert "id" in val
        assert "url" in val
        assert val["label"] == "test emoji"
        assert val["size_bytes"] == len(png)

    def test_upload_valid_gif(self, plugin: EmojiPusherPlugin):
        gif = _make_gif_bytes()
        result = plugin.upload_emoji(filename="anim.gif", data=_b64(gif))
        assert isinstance(result, Ok)
        assert result.value["label"] == "anim"  # defaults to stem

    def test_upload_with_data_uri_prefix(self, plugin: EmojiPusherPlugin):
        png = _make_png_bytes()
        data_uri = "data:image/png;base64," + _b64(png)
        result = plugin.upload_emoji(filename="test.png", data=data_uri)
        assert isinstance(result, Ok)

    def test_upload_invalid_base64(self, plugin: EmojiPusherPlugin):
        result = plugin.upload_emoji(filename="bad.png", data="!!!not-valid-base64!!!")
        assert isinstance(result, Err)

    def test_upload_invalid_mime(self, plugin: EmojiPusherPlugin):
        # PDF header
        pdf_bytes = b"%PDF-1.4 fake content"
        result = plugin.upload_emoji(filename="file.pdf", data=_b64(pdf_bytes))
        assert isinstance(result, Err)

    def test_upload_empty_data(self, plugin: EmojiPusherPlugin):
        result = plugin.upload_emoji(filename="empty.png", data=_b64(b""))
        assert isinstance(result, Err)

    def test_upload_too_large(self, plugin: EmojiPusherPlugin):
        big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (6 * 1024 * 1024)
        result = plugin.upload_emoji(filename="big.png", data=_b64(big))
        assert isinstance(result, Err)

    def test_upload_stores_file(self, plugin: EmojiPusherPlugin):
        png = _make_png_bytes()
        result = plugin.upload_emoji(filename="stored.png", data=_b64(png))
        assert isinstance(result, Ok)
        filename = result.value["filename"]
        dest = plugin._uploads_dir() / filename
        assert dest.exists()
        assert dest.read_bytes() == png

    def test_upload_catalog_persisted(self, plugin: EmojiPusherPlugin):
        png = _make_png_bytes()
        result = plugin.upload_emoji(filename="persist.png", data=_b64(png))
        assert isinstance(result, Ok)
        emoji_id = result.value["id"]
        assert emoji_id in plugin._catalog

    def test_upload_catalog_file_written(self, plugin: EmojiPusherPlugin):
        png = _make_png_bytes()
        plugin.upload_emoji(filename="cat.png", data=_b64(png))
        catalog_path = plugin._catalog_path()
        assert catalog_path.exists()

    def test_upload_max_limit(self, plugin: EmojiPusherPlugin):
        from plugin.plugins.emoji_pusher import _MAX_EMOJIS
        # Fill catalog with fake entries
        for i in range(_MAX_EMOJIS):
            plugin._catalog[f"fake_{i}"] = {"id": f"fake_{i}"}
        png = _make_png_bytes()
        result = plugin.upload_emoji(filename="over.png", data=_b64(png))
        assert isinstance(result, Err)
        assert "上限" in str(result.error)


# ---------------------------------------------------------------------------
# Tests: list_emojis
# ---------------------------------------------------------------------------


class TestListEmojis:
    def test_list_empty(self, plugin: EmojiPusherPlugin):
        result = plugin.list_emojis()
        assert isinstance(result, Ok)
        assert result.value["emojis"] == []
        assert result.value["total"] == 0

    def test_list_after_upload(self, plugin: EmojiPusherPlugin):
        png = _make_png_bytes()
        plugin.upload_emoji(filename="a.png", data=_b64(png), label="Alpha")
        plugin.upload_emoji(filename="b.gif", data=_b64(_make_gif_bytes()), label="Beta")
        result = plugin.list_emojis()
        assert isinstance(result, Ok)
        assert result.value["total"] == 2
        labels = {e["label"] for e in result.value["emojis"]}
        assert "Alpha" in labels
        assert "Beta" in labels


# ---------------------------------------------------------------------------
# Tests: push_emoji
# ---------------------------------------------------------------------------


class TestPushEmoji:
    def test_push_known_emoji(self, plugin: EmojiPusherPlugin, ctx: _Ctx):
        png = _make_png_bytes()
        up = plugin.upload_emoji(filename="push_me.png", data=_b64(png), label="Push Me")
        assert isinstance(up, Ok)
        emoji_id = up.value["id"]

        result = plugin.push_emoji(emoji_id=emoji_id)
        assert isinstance(result, Ok)
        assert result.value["emoji_id"] == emoji_id
        assert "[表情包]" in result.value["content"]

        # Verify push_message was called
        assert len(ctx.pushed_messages) == 1
        msg = ctx.pushed_messages[0]
        assert msg["source"] == "emoji_pusher"
        assert msg["message_type"] == "proactive_notification"
        assert "Push Me" in msg["content"]

    def test_push_with_message(self, plugin: EmojiPusherPlugin, ctx: _Ctx):
        png = _make_png_bytes()
        up = plugin.upload_emoji(filename="say.png", data=_b64(png), label="Say")
        assert isinstance(up, Ok)
        emoji_id = up.value["id"]

        result = plugin.push_emoji(emoji_id=emoji_id, message="hello world")
        assert isinstance(result, Ok)
        assert "hello world" in result.value["content"]

    def test_push_unknown_emoji(self, plugin: EmojiPusherPlugin):
        result = plugin.push_emoji(emoji_id="nonexistent-id")
        assert isinstance(result, Err)
        assert len(result.error.message if hasattr(result.error, "message") else str(result.error)) > 0

    def test_push_calls_ctx_push_message(self, plugin: EmojiPusherPlugin, ctx: _Ctx):
        png = _make_png_bytes()
        up = plugin.upload_emoji(filename="ctx_test.png", data=_b64(png))
        emoji_id = up.value["id"]
        plugin.push_emoji(emoji_id=emoji_id)
        assert ctx.pushed_messages, "ctx.push_message should have been called"


# ---------------------------------------------------------------------------
# Tests: delete_emoji
# ---------------------------------------------------------------------------


class TestDeleteEmoji:
    def test_delete_existing(self, plugin: EmojiPusherPlugin):
        png = _make_png_bytes()
        up = plugin.upload_emoji(filename="del_me.png", data=_b64(png), label="Delete Me")
        assert isinstance(up, Ok)
        emoji_id = up.value["id"]
        filename = up.value["filename"]

        result = plugin.delete_emoji(emoji_id=emoji_id)
        assert isinstance(result, Ok)
        assert result.value["deleted"] == emoji_id

        # Catalog should be updated
        assert emoji_id not in plugin._catalog

        # File should be removed
        file_path = plugin._uploads_dir() / filename
        assert not file_path.exists()

    def test_delete_nonexistent(self, plugin: EmojiPusherPlugin):
        result = plugin.delete_emoji(emoji_id="does-not-exist")
        assert isinstance(result, Err)

    def test_delete_persists_catalog(self, plugin: EmojiPusherPlugin):
        png = _make_png_bytes()
        up = plugin.upload_emoji(filename="persist_del.png", data=_b64(png))
        assert isinstance(up, Ok)
        emoji_id = up.value["id"]

        plugin.delete_emoji(emoji_id=emoji_id)

        # Reload catalog from disk
        plugin._load_catalog()
        assert emoji_id not in plugin._catalog
