"""A small multi-handler event, similar to C# events."""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Any, Awaitable, Callable, Generic, ParamSpec

P = ParamSpec("P")

_log = logging.getLogger(__name__)


class Event(Generic[P]):
    """Handlers can be added with ``event += handler`` (or :meth:`subscribe`) and may be
    plain functions or coroutine functions. Handler exceptions are logged, not raised."""

    def __init__(self) -> None:
        self._handlers: list[Callable[P, Any]] = []
        self._pending: set[asyncio.Future[Any]] = set()

    def subscribe(self, handler: Callable[P, Any]) -> Callable[P, Any]:
        self._handlers.append(handler)
        return handler

    def unsubscribe(self, handler: Callable[P, Any]) -> None:
        if handler in self._handlers:
            self._handlers.remove(handler)

    def __iadd__(self, handler: Callable[P, Any]) -> Event[P]:
        self.subscribe(handler)
        return self

    def __isub__(self, handler: Callable[P, Any]) -> Event[P]:
        self.unsubscribe(handler)
        return self

    def clear(self) -> None:
        self._handlers.clear()

    def __len__(self) -> int:
        return len(self._handlers)

    def fire(self, *args: P.args, **kwargs: P.kwargs) -> None:
        """Calls all handlers; results of coroutine handlers are scheduled, not awaited."""
        for h in list(self._handlers):
            try:
                r = h(*args, **kwargs)
                if inspect.isawaitable(r):
                    fut = asyncio.ensure_future(r)
                    self._pending.add(fut)
                    fut.add_done_callback(self._done)
            except Exception:
                _log.exception("Event handler failed")

    async def fire_async(self, *args: P.args, **kwargs: P.kwargs) -> None:
        """Calls all handlers and awaits the coroutine ones."""
        awaitables: list[Awaitable[Any]] = []
        for h in list(self._handlers):
            try:
                r = h(*args, **kwargs)
                if inspect.isawaitable(r):
                    awaitables.append(r)
            except Exception:
                _log.exception("Event handler failed")
        for res in await asyncio.gather(*awaitables, return_exceptions=True):
            if isinstance(res, Exception):
                _log.error("Event handler failed", exc_info=res)

    def _done(self, fut: asyncio.Future[Any]) -> None:
        self._pending.discard(fut)
        if not fut.cancelled() and fut.exception() is not None:
            _log.error("Event handler failed", exc_info=fut.exception())
