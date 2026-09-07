"""Resident JSONL loop. stdout is reserved for the bridge; prints go to stderr."""

import asyncio
from contextlib import redirect_stdout
import inspect
import json
import sys
from typing import Any, Callable

from pydantic import BaseModel
from .observation import AgentObservation


def wire(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    return value


class Context:
    def __init__(self, request: dict, emit: Callable):
        self.agent_id: str = request["agentId"]
        self.address: str = request["address"]
        self._id = request["id"]
        self._emit = emit
        self._active = True

    def _send(self, channel: str, value: Any):
        if not self._active:
            raise RuntimeError("decision context has expired")
        self._emit({"id": self._id, channel: wire(value)})

    def log(self, entry: dict):
        self._send("log", entry)

    def submit(self, action: Any):
        self._send("submit", action)


def run(decide: Callable):
    """Read observations until EOF; synchronous and async decide functions are supported."""
    protocol_out = sys.stdout

    def emit(message):
        protocol_out.write(json.dumps(message, default=wire, allow_nan=False) + "\n")
        protocol_out.flush()

    for line in sys.stdin:
        request = json.loads(line)
        ctx = Context(request, emit)
        try:
            with redirect_stdout(sys.stderr):
                result = decide(AgentObservation.model_validate(request["obs"]), ctx)
                if inspect.isawaitable(result):
                    result = asyncio.run(result)
            emit({"id": request["id"], "action": wire(result)})
        finally:
            ctx._active = False
