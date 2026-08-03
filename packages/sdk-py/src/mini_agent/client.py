from __future__ import annotations

import json
import struct
from collections.abc import AsyncIterator, Iterator, Mapping
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class Session:
    id: str
    created_at_ms: int
    updated_at_ms: int
    metadata: dict[str, str]
    system_prompt: str
    message_count: int


@dataclass
class ToolInfo:
    name: str
    description: str
    input_schema_json: str
    source: str
    side_effect: bool
    requires_approval: bool


@dataclass
class AgentEvent:
    run_id: str
    session_id: str
    timestamp_ms: int
    payload_case: str
    payload: dict[str, Any]


class MiniAgentClient:
    """Connect-JSON client for agent.v1.AgentService."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout: float = 120.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout

    def _headers(self, *, streaming: bool = False) -> dict[str, str]:
        headers = {
            "connect-protocol-version": "1",
            "content-type": "application/connect+json" if streaming else "application/json",
        }
        if self._api_key:
            headers["x-api-key"] = self._api_key
        return headers

    def _url(self, method: str) -> str:
        return f"{self._base_url}/agent.v1.AgentService/{method}"

    def _request(self, method: str, body: dict[str, Any]) -> dict[str, Any]:
        with httpx.Client(timeout=self._timeout) as client:
            response = client.post(
                self._url(method),
                headers=self._headers(),
                content=json.dumps(body),
            )
            response.raise_for_status()
            return response.json()

    async def _arequest(self, method: str, body: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(
                self._url(method),
                headers=self._headers(),
                content=json.dumps(body),
            )
            response.raise_for_status()
            return response.json()

    @staticmethod
    def _session_from(data: dict[str, Any]) -> Session:
        session = data.get("session") or {}
        return Session(
            id=session.get("id", ""),
            created_at_ms=int(session.get("createdAtMs", session.get("created_at_ms", 0))),
            updated_at_ms=int(session.get("updatedAtMs", session.get("updated_at_ms", 0))),
            metadata=dict(session.get("metadata") or {}),
            system_prompt=session.get("systemPrompt") or session.get("system_prompt") or "",
            message_count=int(session.get("messageCount", session.get("message_count", 0))),
        )

    def create_session(
        self,
        *,
        metadata: Mapping[str, str] | None = None,
        system_prompt: str = "",
    ) -> Session:
        data = self._request(
            "CreateSession",
            {"metadata": dict(metadata or {}), "systemPrompt": system_prompt},
        )
        return self._session_from(data)

    async def acreate_session(
        self,
        *,
        metadata: Mapping[str, str] | None = None,
        system_prompt: str = "",
    ) -> Session:
        data = await self._arequest(
            "CreateSession",
            {"metadata": dict(metadata or {}), "systemPrompt": system_prompt},
        )
        return self._session_from(data)

    def get_session(self, session_id: str) -> Session:
        return self._session_from(self._request("GetSession", {"sessionId": session_id}))

    def list_tools(self) -> list[ToolInfo]:
        data = self._request("ListTools", {})
        tools: list[ToolInfo] = []
        for tool in data.get("tools") or []:
            tools.append(
                ToolInfo(
                    name=tool.get("name", ""),
                    description=tool.get("description", ""),
                    input_schema_json=tool.get("inputSchemaJson")
                    or tool.get("input_schema_json")
                    or "{}",
                    source=tool.get("source", ""),
                    side_effect=bool(tool.get("sideEffect", tool.get("side_effect", False))),
                    requires_approval=bool(
                        tool.get("requiresApproval", tool.get("requires_approval", False))
                    ),
                )
            )
        return tools

    def cancel(self, run_id: str) -> bool:
        data = self._request("CancelRun", {"runId": run_id})
        return bool(data.get("cancelled"))

    def register_http_tool(
        self,
        *,
        name: str,
        description: str,
        url: str,
        input_schema: dict[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        side_effect: bool = True,
        requires_approval: bool = False,
    ) -> ToolInfo:
        data = self._request(
            "RegisterHttpTool",
            {
                "name": name,
                "description": description,
                "url": url,
                "inputSchemaJson": json.dumps(input_schema or {"type": "object", "properties": {}}),
                "headers": dict(headers or {}),
                "sideEffect": side_effect,
                "requiresApproval": requires_approval,
            },
        )
        tool = data.get("tool") or {}
        return ToolInfo(
            name=tool.get("name", name),
            description=tool.get("description", description),
            input_schema_json=tool.get("inputSchemaJson", "{}"),
            source=tool.get("source", "http"),
            side_effect=bool(tool.get("sideEffect", side_effect)),
            requires_approval=bool(tool.get("requiresApproval", requires_approval)),
        )

    def upsert_mcp_server(
        self,
        *,
        name: str,
        transport: str,
        endpoint: str,
        args: list[str] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "UpsertMcpServer",
            {
                "name": name,
                "transport": transport,
                "endpoint": endpoint,
                "args": args or [],
                "env": dict(env or {}),
            },
        )

    def run(
        self,
        *,
        session_id: str,
        message: str,
        model: str = "",
        max_steps: int = 0,
        timeout_ms: int = 0,
    ) -> Iterator[AgentEvent]:
        body = {
            "sessionId": session_id,
            "message": message,
            "model": model,
            "maxSteps": max_steps,
            "timeoutMs": timeout_ms,
        }
        with httpx.Client(timeout=self._timeout) as client:
            with client.stream(
                "POST",
                self._url("RunAgent"),
                headers=self._headers(streaming=True),
                content=_encode_envelope(body),
            ) as response:
                response.raise_for_status()
                yield from _iter_connect_json_events(response)

    async def arun(
        self,
        *,
        session_id: str,
        message: str,
        model: str = "",
        max_steps: int = 0,
        timeout_ms: int = 0,
    ) -> AsyncIterator[AgentEvent]:
        body = {
            "sessionId": session_id,
            "message": message,
            "model": model,
            "maxSteps": max_steps,
            "timeoutMs": timeout_ms,
        }
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            async with client.stream(
                "POST",
                self._url("RunAgent"),
                headers=self._headers(streaming=True),
                content=_encode_envelope(body),
            ) as response:
                response.raise_for_status()
                async for event in _aiter_connect_json_events(response):
                    yield event


def _encode_envelope(message: dict[str, Any]) -> bytes:
    payload = json.dumps(message).encode("utf-8")
    return bytes([0]) + struct.pack(">I", len(payload)) + payload


def _parse_event(message: dict[str, Any]) -> AgentEvent:
    payload_case = "unknown"
    payload: dict[str, Any] = {}
    for key in (
        "runStarted",
        "textDelta",
        "toolCall",
        "toolResult",
        "memoryHit",
        "runCompleted",
        "runError",
        "run_started",
        "text_delta",
        "tool_call",
        "tool_result",
        "memory_hit",
        "run_completed",
        "run_error",
    ):
        if key in message:
            payload_case = key
            payload = message.get(key) or {}
            break
    return AgentEvent(
        run_id=message.get("runId") or message.get("run_id") or "",
        session_id=message.get("sessionId") or message.get("session_id") or "",
        timestamp_ms=int(message.get("timestampMs") or message.get("timestamp_ms") or 0),
        payload_case=payload_case,
        payload=payload,
    )


def _iter_connect_json_events(response: httpx.Response) -> Iterator[AgentEvent]:
    buffer = bytearray()
    for chunk in response.iter_bytes():
        buffer.extend(chunk)
        while True:
            event, buffer = _try_pop_envelope(buffer)
            if event is None:
                break
            yield event


async def _aiter_connect_json_events(response: httpx.Response) -> AsyncIterator[AgentEvent]:
    buffer = bytearray()
    async for chunk in response.aiter_bytes():
        buffer.extend(chunk)
        while True:
            event, buffer = _try_pop_envelope(buffer)
            if event is None:
                break
            yield event


def _try_pop_envelope(buffer: bytearray) -> tuple[AgentEvent | None, bytearray]:
    if len(buffer) < 5:
        return None, buffer
    flags = buffer[0]
    length = struct.unpack(">I", buffer[1:5])[0]
    if len(buffer) < 5 + length:
        return None, buffer
    payload = bytes(buffer[5 : 5 + length])
    rest = buffer[5 + length :]
    # end stream / error envelope
    if flags & 0x02:
        return None, bytearray(rest)
    message = json.loads(payload.decode("utf-8"))
    return _parse_event(message), bytearray(rest)
