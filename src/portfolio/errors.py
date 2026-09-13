"""Typed errors for mirror node access."""

from __future__ import annotations


class MirrorNodeError(RuntimeError):
    """Base class for all mirror node failures."""


class ResourceNotFoundError(MirrorNodeError):
    """The mirror node returned 404 for some path.

    Callers translate this into a domain-specific error such as
    AccountNotFoundError once they know what was being fetched.
    """

    def __init__(self, path: str, network: str):
        self.path = path
        self.network = network
        super().__init__(f"Not found on {network}: {path}")


class AccountNotFoundError(MirrorNodeError):
    """The mirror node returned 404 for the requested account."""

    def __init__(self, address: str, network: str):
        self.address = address
        self.network = network
        super().__init__(f"Account {address!r} not found on {network}")


class MirrorNodeUnavailableError(MirrorNodeError):
    """The mirror node kept failing after the configured retries."""


class MirrorNodeRequestError(MirrorNodeError):
    """The mirror node rejected the request (a 4xx other than 404).

    Most often a malformed account id or address -- which an LLM supplying a
    natural-language value will produce routinely.
    """

    def __init__(self, path: str, network: str, status_code: int):
        self.path = path
        self.network = network
        self.status_code = status_code
        super().__init__(f"Mirror node returned {status_code} for {path} on {network}")
