"""
title: Relay Codex
version: 0.1.0
description: Send an Open WebUI chat turn to the approved Codex tool through Relay.
"""

import asyncio
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pydantic import BaseModel, Field


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Relay connection returned an unexpected redirect.")


class Pipe:
    class Valves(BaseModel):
        BRIDGE_URL: str = Field(default="http://host.lima.internal:8787")
        BRIDGE_ORIGIN: str = Field(default="http://127.0.0.1:8787")
        TIMEOUT_SECONDS: int = Field(default=195, ge=1, le=300)
        OWNER_USER_ID: str = Field(default="", description="Existing owner account permitted to use this connection")

    def __init__(self):
        self.valves = self.Valves()

    async def pipes(self):
        try:
            result = await asyncio.to_thread(self._request, "/owner-chat/api/tools")
            tool = next((item for item in result.get("data", []) if item.get("id") == "codex"), None)
            available = tool and tool.get("available") is True
        except Exception:
            available = False
        return [{"id": "codex", "name": "Codex (Mac)" if available else "Codex (Mac) · offline"}]

    def _request(self, route, payload=None):
        url = urllib.parse.urlsplit(self.valves.BRIDGE_URL)
        if (url.scheme != "http" or url.hostname not in
                {"host.lima.internal", "127.0.0.1", "localhost"} or
                url.port != 8787 or url.username or url.password or
                url.path not in {"", "/"} or url.query or url.fragment or
                self.valves.BRIDGE_ORIGIN != "http://127.0.0.1:8787"):
            raise RuntimeError("Configure the existing approved local Relay connection.")
        request = urllib.request.Request(
            self.valves.BRIDGE_URL.rstrip("/") + route,
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            headers={"Content-Type": "application/json", "Origin": self.valves.BRIDGE_ORIGIN},
            method="POST" if payload is not None else "GET",
        )
        # Do not route this local connection through inherited proxies or redirects.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            with opener.open(request, timeout=self.valves.TIMEOUT_SECONDS) as response:
                result = json.loads(response.read(2_000_001))
        except urllib.error.HTTPError as error:
            try:
                result = json.loads(error.read(4096))
                code = result.get("error", {}).get("code")
            except Exception:
                code = None
            messages = {
                "TOOL_OFFLINE": "Codex is offline. Start the approved request receiver before sending.",
                "TOOL_BUSY": "Codex is answering another message. Try again when it finishes.",
                "REPLY_PENDING": "Your prompt is saved in Relay. Retry this message when Codex has answered.",
                "REPLY_NOT_VERIFIED": "Relay has not verified a Codex reply for this message.",
                "REQUEST_CONFLICT": "This message id was already used for another prompt.",
                "INVALID_INPUT": "Choose Codex and send a text message of 1–8000 characters.",
            }
            raise RuntimeError(messages.get(code, "The approved Relay connection is unavailable.")) from None
        except Exception:
            raise RuntimeError("The approved Relay connection is unavailable. Your saved messages remain in Relay.") from None
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise RuntimeError("Relay did not confirm this request.")
        return result

    async def pipe(self, body: dict, __metadata__: dict = None, __chat_id__: str = None,
                   __event_emitter__=None, __task__: str = None, __user__: dict = None):
        # Open WebUI title/tag/follow-up tasks are auxiliary UI work, not chat turns.
        if __task__:
            return ""
        if not self.valves.OWNER_USER_ID or (__user__ or {}).get("id") != self.valves.OWNER_USER_ID:
            raise RuntimeError("This Relay connection is available to its existing owner account.")
        metadata = __metadata__ or {}
        model = body.get("model", "")
        if model.rsplit(".", 1)[-1] != "codex":
            raise RuntimeError("Choose Codex (Mac) for this Relay connection.")
        last_user = next((message for message in reversed(body.get("messages", []))
                          if message.get("role") == "user"), None)
        prompt = metadata.get("user_prompt")
        if not isinstance(prompt, str):
            prompt = last_user.get("content") if last_user else None
        chat_id = __chat_id__ or metadata.get("chat_id")
        request_id = metadata.get("user_message_id") or (last_user or {}).get("id")
        if (not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 8000 or
                not isinstance(chat_id, str) or not re.fullmatch(r"[a-zA-Z0-9_:-]{1,100}", chat_id) or
                not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9_:-]{1,100}", request_id)):
            raise RuntimeError("Use a saved Open WebUI conversation and send a text message of 1–8000 characters.")
        if __event_emitter__:
            await __event_emitter__({"type": "status", "data": {
                "description": "Waiting for Codex to answer through Relay…", "done": False}})
        result = await asyncio.to_thread(self._request, "/owner-chat/api/messages", {
            "toolId": "codex", "prompt": prompt.strip(),
            "externalConversationId": chat_id, "requestId": request_id,
        })
        data = result.get("data", {})
        if (not isinstance(data, dict) or not isinstance(data.get("answer"), str) or
                not data["answer"].strip() or not isinstance(data.get("replyId"), str) or
                not data["replyId"] or not isinstance(data.get("conversationId"), str) or
                not data["conversationId"]):
            raise RuntimeError("Relay did not confirm a saved Codex reply for this message.")
        if __event_emitter__:
            await __event_emitter__({"type": "status", "data": {
                "description": "Codex reply saved and read back from Relay.", "done": True}})
        return data["answer"]
